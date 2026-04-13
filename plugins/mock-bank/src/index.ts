/**
 * Mock Bank Plugin — MCP Server Entry Point
 *
 * This is a reference plugin demonstrating how to build an
 * OpenConnectors data-extraction plugin. It exposes two MCP tools:
 *
 *   - fetch_transactions(from_date, to_date)
 *   - fetch_tax_documents(year)
 *
 * In a real plugin, these tools would use Playwright to log into
 * a bank portal and scrape data. This mock plugin generates
 * realistic sample data to demonstrate the architecture.
 *
 * Credentials are received via environment variables:
 *   OPENCONNECTORS_CRED_USERNAME
 *   OPENCONNECTORS_CRED_PASSWORD
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchTransactions } from "./tools/fetch-transactions.js";
import { fetchTaxDocuments } from "./tools/fetch-tax-documents.js";

const server = new McpServer({
  name: "mock-bank",
  version: "0.1.0",
});

// --- Tool: fetch_transactions ---

server.tool(
  "fetch_transactions",
  "Fetch bank transactions for a date range. Returns normalized transaction objects.",
  {
    from_date: z.string().describe("Start date in YYYY-MM-DD format"),
    to_date: z.string().describe("End date in YYYY-MM-DD format"),
  },
  async ({ from_date, to_date }) => {
    const username = process.env["OPENCONNECTORS_CRED_USERNAME"];
    const password = process.env["OPENCONNECTORS_CRED_PASSWORD"];

    if (!username || !password) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: Missing credentials. Run: openconnectors vault set mock-bank username && openconnectors vault set mock-bank password",
          },
        ],
        isError: true,
      };
    }

    const headless =
      process.env["OPENCONNECTORS_HEADLESS"] !== "false";

    const transactions = await fetchTransactions({
      username,
      password,
      fromDate: from_date,
      toDate: to_date,
      headless,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(transactions, null, 2),
        },
      ],
    };
  }
);

// --- Tool: fetch_tax_documents ---

server.tool(
  "fetch_tax_documents",
  "Fetch tax documents (Form 106 / annual statements) for a given year.",
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
            text: "Error: Missing credentials. Run: openconnectors vault set mock-bank username && openconnectors vault set mock-bank password",
          },
        ],
        isError: true,
      };
    }

    const headless =
      process.env["OPENCONNECTORS_HEADLESS"] !== "false";

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
  console.error("Fatal error starting mock-bank MCP server:", err);
  process.exit(1);
});
