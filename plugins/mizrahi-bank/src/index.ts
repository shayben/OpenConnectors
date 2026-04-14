/**
 * Mizrahi-Tefahot Bank Plugin — MCP Server Entry Point
 *
 * Exposes two MCP tools for Mizrahi-Tefahot Bank (מזרחי-טפחות):
 *
 *   - fetch_transactions(from_date, to_date, account_number?)
 *   - fetch_tax_documents(year)
 *
 * Credentials are received via environment variables:
 *   OPENCONNECTORS_CRED_NATIONAL_ID
 *   OPENCONNECTORS_CRED_PASSWORD
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchTransactions } from "./tools/fetch-transactions.js";
import { fetchTaxDocuments } from "./tools/fetch-tax-documents.js";

const server = new McpServer({
  name: "mizrahi-bank",
  version: "0.1.0",
});

// --- Tool: fetch_transactions ---

server.tool(
  "fetch_transactions",
  "Fetch Mizrahi-Tefahot bank transactions for a date range. Returns normalized transaction objects.",
  {
    from_date: z.string().describe("Start date in YYYY-MM-DD format"),
    to_date: z.string().describe("End date in YYYY-MM-DD format"),
    account_number: z
      .string()
      .optional()
      .describe("Specific account number to fetch (defaults to primary account)"),
  },
  async ({ from_date, to_date, account_number }) => {
    const nationalId = process.env["OPENCONNECTORS_CRED_NATIONAL_ID"];
    const password = process.env["OPENCONNECTORS_CRED_PASSWORD"];

    if (!nationalId || !password) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: Missing credentials. Run: openconnectors vault set mizrahi-bank national_id && openconnectors vault set mizrahi-bank password",
          },
        ],
        isError: true,
      };
    }

    const headless = process.env["OPENCONNECTORS_HEADLESS"] !== "false";

    const transactions = await fetchTransactions({
      nationalId,
      password,
      fromDate: from_date,
      toDate: to_date,
      accountNumber: account_number,
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
  "Fetch Mizrahi-Tefahot annual bank statement and Form 106 for a given tax year.",
  {
    year: z.number().describe("Tax year to fetch documents for (e.g. 2025)"),
  },
  async ({ year }) => {
    const nationalId = process.env["OPENCONNECTORS_CRED_NATIONAL_ID"];
    const password = process.env["OPENCONNECTORS_CRED_PASSWORD"];

    if (!nationalId || !password) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: Missing credentials. Run: openconnectors vault set mizrahi-bank national_id && openconnectors vault set mizrahi-bank password",
          },
        ],
        isError: true,
      };
    }

    const headless = process.env["OPENCONNECTORS_HEADLESS"] !== "false";

    const result = await fetchTaxDocuments({
      nationalId,
      password,
      year,
      headless,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
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
  console.error("Fatal error starting mizrahi-bank MCP server:", err);
  process.exit(1);
});
