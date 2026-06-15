import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Reusable MCP client instance
let client = null;
let transport = null;
let connectionPromise = null;
let connectionBroken = false;

export const webSearchTool = {
    type: "function",
    function: {
        name: "search_web",
        description:
            "Search the web for current or external information that is not available in the uploaded document.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The web search query.",
                },
                num: {
                    type: "number",
                    description: "Number of search results to return.",
                },
            },
            required: ["query"],
        },
    },
};

const ensureConnection = async () => {
    if (client && transport && !connectionBroken) {
        return client;
    }

    if (client && connectionBroken) {
        await closeConnection();
        if (connectionBroken) {
            throw new Error("Existing MCP client could not be closed. Refusing to open another connection.");
        }
    }

    if (connectionPromise) {
        return connectionPromise;
    }

    connectionPromise = (async () => {
        try {
            client = new Client({
                name: "chat-client",
                version: "1.0.0",
            });

            const serverPath = join(__dirname, "mcp-server.js");

            transport = new StdioClientTransport({
                command: "node",
                args: [serverPath],
                env: {
                    ...process.env,
                },
            });

            await client.connect(transport);
            connectionBroken = false;
            return client;
        } catch (error) {
            console.error("Error connecting to MCP server:", error);
            await closeConnection();
            throw error;
        } finally {
            connectionPromise = null;
        }
    })();

    return connectionPromise;
};

async function closeConnection() {
    if (!client) {
        transport = null;
        connectionBroken = false;
        return;
    }

    const closingClient = client;

    try {
        await closingClient.close();
        if (client === closingClient) {
            client = null;
            transport = null;
            connectionBroken = false;
        }
    } catch (closeError) {
        connectionBroken = true;
        console.error("Error closing client:", closeError);
    }
}

export const searchWeb = async (query, num = 5, options = {}) => {
    try {
        const connectedClient = await ensureConnection();
        const toolResult = await connectedClient.callTool(
            {
                name: "search_web",
                arguments: {
                    query,
                    num,
                },
            },
            undefined,
            {
                timeout: options.timeout ?? 20000,
            },
        );

        return toolResult.content?.map((item) => item.text || "").join("\n") || "";
    } catch (error) {
        connectionBroken = true;
        await closeConnection();

        throw error;
    }
};

export default searchWeb;
