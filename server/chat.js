import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings } from "@langchain/openai";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";

// 按文件路径缓存已构建好的 vector store，避免每次请求都重新 embedding 整个 PDF。
// 存的是 Promise，这样并发的首次请求也只会触发一次构建。
const vectorStoreCache = new Map();

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

const getVectorStore = (filePath) => {
    if (!vectorStoreCache.has(filePath)) {
        const promise = buildVectorStore(filePath).catch((err) => {
            // 构建失败时清掉缓存，下次请求可以重试
            vectorStoreCache.delete(filePath);
            throw err;
        });
        vectorStoreCache.set(filePath, promise);
    }
    return vectorStoreCache.get(filePath);
};

const chat = async (query, filePath = "./uploads/hbs-lean-startup.pdf") => {
    const apiKey = process.env.OPENAI_API_KEY;

    const vectorStore = await getVectorStore(filePath);

    const model = new ChatOpenAI(
        {
            model: "gpt-5",
            ...(apiKey && { apiKey }),
        }
    );

    const template = `Use the following pieces of context to answer the question at the end.
If you don't know the answer, just say that you don't know, don't try to make up an answer.
Use three sentences maximum and keep the answer as concise as possible.

{context}
Question: {question}
Helpful Answer:`;

    const prompt = PromptTemplate.fromTemplate(template);

    const retriever = vectorStore.asRetriever();
    console.time("retrieve");
    const relevantDocs = await retriever.invoke(query);
    console.timeEnd("retrieve");

    const context = relevantDocs.map((doc) => doc.pageContent).join("\n");

    const formattedPrompt = await prompt.format({
        context,
        question: query,
    });

    console.time("llm-invoke");
    const response = await model.invoke(formattedPrompt);
    console.timeEnd("llm-invoke");

    return { text: response.content };
};

export default chat;
