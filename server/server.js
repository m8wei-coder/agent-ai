import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer"; // Import multer
import { ProxyAgent, setGlobalDispatcher } from "undici";
import chat from "./chat.js";

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
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, "uploads/"); // Set the destination folder for uploaded files
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname); // Use the original file name
    },
});

const upload = multer({ storage });

const PORT = 5001;

let filePath;

app.post("/upload", upload.single("file"), (req, res) => {
    filePath = req.file.path;
    res.send(filePath + " uploaded successfully");
});

app.get("/chat", async (req, res) => {
    try {
        const resp = await chat(req.query.question, filePath);

        res.send({
            ragAnswer: resp.text,
            mcpAnser: "N/A",
        });
    } catch (err) {
        console.error("chat error:", err);
        res.status(500).send({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});