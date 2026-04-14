import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  fetchDetailedBalances,
  type ProxyConfig,
} from "./tools/fetch-detailed-balances.js";

const server = new McpServer({
  name: "pension-more",
  version: "0.1.0",
});

server.tool(
  "fetch_detailed_balances",
  "Fetch דוח יתרות מפורט (detailed balances report) from pension.more.co.il",
  {},
  async () => {
    const idNumber = process.env["OPENCONNECTORS_CRED_ID_NUMBER"];
    const password = process.env["OPENCONNECTORS_CRED_PASSWORD"];

    if (!idNumber || !password) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: Missing credentials. Run:\n  openconnectors vault set pension-more id_number\n  openconnectors vault set pension-more password",
          },
        ],
        isError: true,
      };
    }

    const headless = process.env["OPENCONNECTORS_HEADLESS"] !== "false";

    // Build proxy config from env vars
    let proxy: ProxyConfig | undefined;
    const proxyServer = process.env["OPENCONNECTORS_PROXY"];
    if (proxyServer) {
      proxy = {
        server: proxyServer,
        username: process.env["OPENCONNECTORS_PROXY_USERNAME"] || undefined,
        password: process.env["OPENCONNECTORS_PROXY_PASSWORD"] || undefined,
      };
    }

    const balances = await fetchDetailedBalances({
      idNumber,
      password,
      headless,
      proxy,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(balances, null, 2),
        },
      ],
    };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting pension-more MCP server:", err);
  process.exit(1);
});
