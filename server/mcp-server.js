import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getJson } from "serpapi";

const SERPAPI_KEY = process.env.SERPAPI_KEY;

// Create MCP server instance
const server = new McpServer({
  name: "serpapi-search",
  version: "1.0.0",
});

const pickAnswerBoxText = (answerBox) => {
  if (!answerBox) return "";

  return [
    answerBox.answer,
    answerBox.snippet,
    answerBox.title,
    answerBox.link,
  ]
    .filter(Boolean)
    .join("\n");
};

const formatSearchResults = (results, limit) => {
  const parts = [];
  const answerBoxText = pickAnswerBoxText(results.answer_box);

  if (answerBoxText) {
    parts.push(`Answer Box:\n${answerBoxText}`);
  }

  const organicResults = (results.organic_results || []).slice(0, limit);
  organicResults.forEach((result, index) => {
    parts.push(
      [
        `Result ${index + 1}: ${result.title || "Untitled"}`,
        result.link ? `URL: ${result.link}` : "",
        result.snippet ? `Snippet: ${result.snippet}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  });

  return parts.join("\n\n") || "No web search results found.";
};

// Register the search tool
server.registerTool(
  "search_web",
  {
    description:
      "Search the web using SerpAPI. Returns search results including organic results, snippets, and related information.",
    inputSchema: {
      query: z.string().describe("The search query to execute"),
      num: z
        .number()
        .optional()
        .describe("Number of results to return (default: 10)"),
    },
  },
  async ({ query, num = 10 }) => {
    try {
      if (!SERPAPI_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "Web search unavailable: SERPAPI_KEY is not configured.",
            },
          ],
        };
      }

      const results = await getJson({
        engine: "google",
        q: query,
        num: num,
        api_key: SERPAPI_KEY,
      });

      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(results, num),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error performing web search: ${error.message}`,
          },
        ],
      };
    }
  },
);

// Main function to run the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SerpAPI MCP Server running on stdio");
}

// Always run the server when this file is executed
// This is needed when spawned as a child process
main().catch((error) => {
  console.error("Fatal error in MCP server:", error);
  process.exit(1);
});

export default server;
