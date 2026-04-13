/**
 * Menora Mivtachim Pension Plugin — MCP Server Entry Point
 *
 * Exposes two MCP tools for Menora Mivtachim (מנורה מבטחים):
 *
 *   - fetch_pension_statement(year?)
 *   - fetch_tax_documents(year)
 *
 * Credentials are received via environment variables:
 *   OPENCONNECTORS_CRED_NATIONAL_ID
 *   OPENCONNECTORS_CRED_PASSWORD
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchPensionStatement } from "./tools/fetch-pension-statement.js";
import { fetchTaxDocuments } from "./tools/fetch-tax-documents.js";

const server = new McpServer({
  name: "menora-pension",
  version: "0.1.0",
});

// --- Tool: fetch_pension_statement ---

server.tool(
  "fetch_pension_statement",
  "Fetch Menora Mivtachim pension fund balance, contributions, and investment returns.",
  {
    year: z
      .number()
      .optional()
      .describe("Year for the pension statement (defaults to current year)"),
  },
  async ({ year }) => {
    const nationalId = process.env["OPENCONNECTORS_CRED_NATIONAL_ID"];
    const password = process.env["OPENCONNECTORS_CRED_PASSWORD"];

    if (!nationalId || !password) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: Missing credentials. Run: openconnectors vault set menora-pension national_id && openconnectors vault set menora-pension password",
          },
        ],
        isError: true,
      };
    }

    const headless = process.env["OPENCONNECTORS_HEADLESS"] !== "false";

    const statement = await fetchPensionStatement({
      nationalId,
      password,
      year,
      headless,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(statement, null, 2),
        },
      ],
    };
  }
);

// --- Tool: fetch_tax_documents ---

server.tool(
  "fetch_tax_documents",
  "Fetch Menora Mivtachim annual pension fund statement for a given tax year.",
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
            text: "Error: Missing credentials. Run: openconnectors vault set menora-pension national_id && openconnectors vault set menora-pension password",
          },
        ],
        isError: true,
      };
    }

    const headless = process.env["OPENCONNECTORS_HEADLESS"] !== "false";

    const document = await fetchTaxDocuments({
      nationalId,
      password,
      year,
      headless,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(document, null, 2),
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
  console.error("Fatal error starting menora-pension MCP server:", err);
  process.exit(1);
});
