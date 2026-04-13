/**
 * ESOP Excellence Plugin — MCP Server Entry Point
 *
 * Exposes two MCP tools for ESOP Excellence:
 *
 *   - fetch_esop_grants()
 *   - fetch_tax_documents(year)
 *
 * Credentials are received via environment variables:
 *   OPENCONNECTORS_CRED_USERNAME
 *   OPENCONNECTORS_CRED_PASSWORD
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchEsopGrants } from "./tools/fetch-esop-grants.js";
import { fetchTaxDocuments } from "./tools/fetch-tax-documents.js";

const server = new McpServer({
  name: "esop-excellence",
  version: "0.1.0",
});

// --- Tool: fetch_esop_grants ---

server.tool(
  "fetch_esop_grants",
  "Fetch all equity grants (stock options, RSUs, SARs) from ESOP Excellence including grant details, vesting schedules, and unrealized gain.",
  {},
  async () => {
    const username = process.env["OPENCONNECTORS_CRED_USERNAME"];
    const password = process.env["OPENCONNECTORS_CRED_PASSWORD"];

    if (!username || !password) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: Missing credentials. Run: openconnectors vault set esop-excellence username && openconnectors vault set esop-excellence password",
          },
        ],
        isError: true,
      };
    }

    const headless = process.env["OPENCONNECTORS_HEADLESS"] !== "false";

    const summary = await fetchEsopGrants({
      username,
      password,
      headless,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }
);

// --- Tool: fetch_tax_documents ---

server.tool(
  "fetch_tax_documents",
  "Fetch annual equity compensation tax documents (Section 102 confirmations, exercise reports) for a given tax year.",
  {
    year: z.number().describe("Tax year to fetch documents for (e.g. 2025)"),
  },
  async ({ year }) => {
    const username = process.env["OPENCONNECTORS_CRED_USERNAME"];
    const password = process.env["OPENCONNECTORS_CRED_PASSWORD"];

    if (!username || !password) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: Missing credentials. Run: openconnectors vault set esop-excellence username && openconnectors vault set esop-excellence password",
          },
        ],
        isError: true,
      };
    }

    const headless = process.env["OPENCONNECTORS_HEADLESS"] !== "false";

    const documents = await fetchTaxDocuments({
      username,
      password,
      year,
      headless,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(documents, null, 2),
        },
      ],
    };
  }
);

// --- Start the MCP server over stdio ---

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting esop-excellence MCP server:", err);
  process.exit(1);
});
