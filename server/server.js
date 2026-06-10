import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer"; // Import multer
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { chatStream, getVectorStore, getParseStatus } from "./chat.js";

dotenv.config();

// OpenAI SDK 走全局 fetch，默认不读 http_proxy 环境变量。
// 这里显式把全局 dispatcher 指向本地代理，让 embedding / LLM 请求都能出网。
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log("Using proxy:", proxyUrl);
}

const app = express();
app.use(cors());

// TODO:多用户处理
// 先把文件读进内存，按内容哈希命名存盘，避免同名文件覆盖导致缓存读到旧向量。
const upload = multer({ storage: multer.memoryStorage() });
const UPLOAD_DIR = "uploads";

const PORT = 5001;

let filePath;

app.post("/upload", upload.single("file"), (req, res) => {
    // 用内容 sha256 作为文件名（也是 vectorStore 缓存的 key）：
    // 相同内容 -> 同一文件、命中缓存不重建；不同内容 -> 不同 key、独立解析。
    const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex").slice(0, 16);
    const ext = path.extname(req.file.originalname) || ".pdf";
    const dest = path.join(UPLOAD_DIR, `${hash}${ext}`);

    // 内容相同的文件已存在就不重复写盘
    if (!fs.existsSync(dest)) {
        fs.writeFileSync(dest, req.file.buffer);
    }
    filePath = dest;

    // 上传成功后立刻在后台预热：解析 PDF + 构建 embedding 缓存。
    // 不 await，先把响应返回给用户；等用户打完字发问时，构建通常已完成。
    getVectorStore(filePath).catch((err) => {
        console.error("warmup failed:", err.message);
    });

    res.send(filePath + " uploaded successfully");
});

// 前端轮询解析状态：idle | parsing | ready | error
app.get("/status", (req, res) => {
    res.send({ status: filePath ? getParseStatus(filePath) : "idle" });
});

app.get("/chat", async (req, res) => {
    // 以 SSE 流式返回：逐 token 推送 { delta }，结束发 { done }，出错发 { error }。
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    try {
        for await (const delta of chatStream(req.query.question, filePath)) {
            res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (err) {
        console.error("chat error:", err);
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    } finally {
        res.end();
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});