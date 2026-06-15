import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings } from "@langchain/openai";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { EventEmitter } from "events";
import { searchWeb, webSearchTool } from "./chat-mcp.js";

// 按文件路径缓存已构建好的 vector store，避免每次请求都重新 embedding 整个 PDF。
// 存的是 Promise，这样并发的首次请求也只会触发一次构建。
const vectorStoreCache = new Map();

// 记录每个文件的解析状态，供前端轮询：parsing | ready | error
const parseStatus = new Map();
let requestSeq = 0;

const LLM_TOOL_DECISION_TIMEOUT_MS = 15000;
const MCP_TOOL_TIMEOUT_MS = 20000;
const EXTERNAL_INFO_PATTERNS = [
    /\b(today|latest|recent|current|currently|now|news|weather|forecast|price|stock|exchange rate)\b/i,
    /\bthis (week|month|year)\b/i,
    /\bnear me\b/i,
    /今天|现在|当前|最近|最新|新闻|天气|气温|预报|价格|股价|汇率|附近/,
];

const nextRequestId = () => {
    requestSeq = (requestSeq + 1) % Number.MAX_SAFE_INTEGER;
    return requestSeq;
};

const withTimeout = async (promise, timeoutMs, label) => {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

export const getParseStatus = (filePath) => parseStatus.get(filePath) || "idle";

const buildVectorStore = async (filePath) => {
    const apiKey = process.env.OPENAI_API_KEY;

    console.time(`build-vectorstore:${filePath}`);
    const loader = new PDFLoader(filePath);
    const data = await loader.load();

    const textSplitter = new RecursiveCharacterTextSplitter({
        chunkSize: 500,
        chunkOverlap: 100,
    });
    const splitDocs = await textSplitter.splitDocuments(data);
    console.log("chunks:", splitDocs.length);

    const embeddings = new OpenAIEmbeddings(apiKey ? { apiKey } : {});
    const vectorStore = await MemoryVectorStore.fromDocuments(splitDocs, embeddings);
    console.timeEnd(`build-vectorstore:${filePath}`);

    return vectorStore;
};

// 导出供上传后预热使用：提前触发构建，后续 /chat 直接命中缓存。
export const getVectorStore = (filePath) => {
    if (!vectorStoreCache.has(filePath)) {
        parseStatus.set(filePath, "parsing");
        const promise = buildVectorStore(filePath)
            .then((vectorStore) => {
                parseStatus.set(filePath, "ready");
                return vectorStore;
            })
            .catch((err) => {
                // 构建失败时清掉缓存，下次请求可以重试
                parseStatus.set(filePath, "error");
                vectorStoreCache.delete(filePath);
                throw err;
            });
        vectorStoreCache.set(filePath, promise);
    }
    return vectorStoreCache.get(filePath);
};

const buildDocumentContext = async (query, filePath, requestId) => {
    const vectorStore = await getVectorStore(filePath);

    const retriever = vectorStore.asRetriever();
    const timerLabel = `retrieve:${requestId}`;
    console.time(timerLabel);
    let relevantDocs;
    try {
        relevantDocs = await retriever.invoke(query);
    } finally {
        console.timeEnd(timerLabel);
    }

    return relevantDocs.map((doc) => doc.pageContent).join("\n");
};

const buildMessages = async (query, filePath, requestId) => {
    const documentContext = await buildDocumentContext(query, filePath, requestId);

    // TODO: 当前版本还没有接入对话记忆；每次 /chat 只基于本次问题、PDF 上下文和按需工具结果回答。
    return [
        new SystemMessage(
            [
                "You answer questions using the uploaded document context first.",
                "If the document context is enough, answer directly without calling tools.",
                "Call search_web only when the question needs current, external, or missing information.",
                "You do not know the user's physical location unless they provide it; for local weather or nearby questions without a location, ask for the city or region instead of searching.",
                "If neither the document nor tools can answer, say that you don't know.",
                "Use three sentences maximum and keep the answer concise.",
            ].join(" "),
        ),
        new HumanMessage(
            [
                "Document Context:",
                documentContext || "No relevant document context found.",
                "",
                `Question: ${query}`,
            ].join("\n"),
        ),
    ];
};

const messageContentToText = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    return content
        .map((part) => {
            if (typeof part === "string") return part;
            if (part?.type === "text" && typeof part.text === "string") return part.text;
            return "";
        })
        .join("");
};

const mayNeedExternalInfo = (query) => EXTERNAL_INFO_PATTERNS.some((pattern) => pattern.test(query));

const asksLocalWeatherWithoutLocation = (query) => {
    const normalized = query.toLowerCase();
    const asksWeather = /weather|forecast|天气|气温|预报/.test(normalized);
    const asksCurrentLocation = /my current location|where i am|near me|当前位置|现在位置|我现在的位置|我现在位置|我这里|我这边/.test(normalized);

    return asksWeather && asksCurrentLocation;
};

async function* streamModelAnswer(model, messages, requestId, label = "llm-stream") {
    const streamTimerLabel = `${label}:${requestId}`;
    console.time(streamTimerLabel);
    try {
        const stream = await model.stream(messages);
        for await (const part of stream) {
            const text = messageContentToText(part.content);
            if (text) yield text;
        }
    } finally {
        console.timeEnd(streamTimerLabel);
    }
}

const runToolCall = async (toolCall, index, requestId) => {
    const toolCallId = toolCall.id || `tool_call_${index}`;

    if (toolCall.name !== "search_web") {
        return new ToolMessage({
            content: `Unsupported tool: ${toolCall.name}`,
            tool_call_id: toolCallId,
            name: toolCall.name,
            status: "error",
        });
    }

    const timerLabel = `mcp-search:${requestId}:${index}`;
    try {
        console.time(timerLabel);
        const result = await searchWeb(toolCall.args?.query || "", toolCall.args?.num || 5, {
            timeout: MCP_TOOL_TIMEOUT_MS,
        });

        return new ToolMessage({
            content: result,
            tool_call_id: toolCallId,
            name: toolCall.name,
            status: "success",
        });
    } catch (err) {
        console.error("mcp search error:", err.message);
        return new ToolMessage({
            content: `Web search unavailable: ${err.message}`,
            tool_call_id: toolCallId,
            name: toolCall.name,
            status: "error",
        });
    } finally {
        console.timeEnd(timerLabel);
    }
};

async function* streamChatAnswer(query, filePath, model, requestId) {
    const messages = await buildMessages(query, filePath, requestId);

    if (asksLocalWeatherWithoutLocation(query)) {
        yield "我现在无法知道你的物理位置。请告诉我城市或地区，我再帮你查询天气。";
        return;
    }

    if (!mayNeedExternalInfo(query)) {
        yield* streamModelAnswer(model, messages, requestId);
        return;
    }

    const modelWithTools = model.bindTools([webSearchTool]);

    const decisionTimerLabel = `llm-tool-decision:${requestId}`;
    console.time(decisionTimerLabel);
    let decision;
    try {
        decision = await withTimeout(
            modelWithTools.invoke(messages),
            LLM_TOOL_DECISION_TIMEOUT_MS,
            "LLM tool decision",
        );
    } finally {
        console.timeEnd(decisionTimerLabel);
    }

    const toolCalls = decision.tool_calls || [];
    if (toolCalls.length === 0) {
        const text = messageContentToText(decision.content);
        if (text) yield text;
        return;
    }

    const toolMessages = await Promise.all(toolCalls.map((toolCall, index) => runToolCall(toolCall, index, requestId)));
    const finalMessages = [...messages, decision, ...toolMessages];

    yield* streamModelAnswer(model, finalMessages, requestId);
};

// 在途去重 + 广播共享：相同 question+filePath 的并发请求共享同一次生成，
// 后到的订阅者先收到已缓存的 chunk，再跟随后续 token。生成结束后清除 key。
const inFlight = new Map();

const startGeneration = (key, query, filePath) => {
    const apiKey = process.env.OPENAI_API_KEY;
    const requestId = nextRequestId();
    const entry = { chunks: [], done: false, error: null, emitter: new EventEmitter() };
    entry.emitter.setMaxListeners(0); // 订阅者数量不限
    inFlight.set(key, entry);

    (async () => {
        try {
            const model = new ChatOpenAI({ model: "gpt-5", ...(apiKey && { apiKey }) });

            for await (const text of streamChatAnswer(query, filePath, model, requestId)) {
                entry.chunks.push(text);
                entry.emitter.emit("update");
            }
        } catch (err) {
            entry.error = err;
        } finally {
            entry.done = true;
            entry.emitter.emit("update");
            inFlight.delete(key);
        }
    })();

    return entry;
};

// 订阅一次生成：从头按序 yield 所有 chunk（含已缓存的），直到结束或出错。
async function* subscribe(entry) {
    let i = 0;
    while (true) {
        while (i < entry.chunks.length) {
            yield entry.chunks[i++];
        }
        if (entry.done) {
            if (entry.error) throw entry.error;
            return;
        }
        await new Promise((resolve) => entry.emitter.once("update", resolve));
    }
}

// 返回一个异步可迭代的 token 流。相同请求并发时复用同一次生成。
export const chatStream = (query, filePath = "./uploads/hbs-lean-startup.pdf") => {
    const key = `${filePath}::${query}`;
    let entry = inFlight.get(key);
    if (entry) {
        console.log("dedup hit:", key);
    } else {
        entry = startGeneration(key, query, filePath);
    }
    return subscribe(entry);
};
