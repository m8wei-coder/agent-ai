import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings } from "@langchain/openai";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { EventEmitter } from "events";

// 按文件路径缓存已构建好的 vector store，避免每次请求都重新 embedding 整个 PDF。
// 存的是 Promise，这样并发的首次请求也只会触发一次构建。
const vectorStoreCache = new Map();

// 记录每个文件的解析状态，供前端轮询：parsing | ready | error
const parseStatus = new Map();

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

const template = `Use the following pieces of context to answer the question at the end.
If you don't know the answer, just say that you don't know, don't try to make up an answer.
Use three sentences maximum and keep the answer as concise as possible.

{context}
Question: {question}
Helpful Answer:`;

const prompt = PromptTemplate.fromTemplate(template);

// 检索相关文档并组装最终 prompt（流式生成前的准备步骤）。
const buildPrompt = async (query, filePath) => {
    const vectorStore = await getVectorStore(filePath);

    const retriever = vectorStore.asRetriever();
    console.time("retrieve");
    const relevantDocs = await retriever.invoke(query);
    console.timeEnd("retrieve");

    const context = relevantDocs.map((doc) => doc.pageContent).join("\n");
    return prompt.format({ context, question: query });
};

// 在途去重 + 广播共享：相同 question+filePath 的并发请求共享同一次生成，
// 后到的订阅者先收到已缓存的 chunk，再跟随后续 token。生成结束后清除 key。
const inFlight = new Map();

const startGeneration = (key, query, filePath) => {
    const apiKey = process.env.OPENAI_API_KEY;
    const entry = { chunks: [], done: false, error: null, emitter: new EventEmitter() };
    entry.emitter.setMaxListeners(0); // 订阅者数量不限
    inFlight.set(key, entry);

    (async () => {
        try {
            const formattedPrompt = await buildPrompt(query, filePath);
            const model = new ChatOpenAI({ model: "gpt-5", ...(apiKey && { apiKey }) });

            console.time("llm-stream");
            const stream = await model.stream(formattedPrompt);
            for await (const part of stream) {
                const text = typeof part.content === "string" ? part.content : "";
                if (text) {
                    entry.chunks.push(text);
                    entry.emitter.emit("update");
                }
            }
            console.timeEnd("llm-stream");
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
