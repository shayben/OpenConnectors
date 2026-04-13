# Plugin Authoring Guide

This guide walks you through building an OpenConnectors plugin — a MCP server
that uses Playwright to extract data from an institutional web portal.

## Prerequisites

- Node.js 20+
- Familiarity with TypeScript, Playwright, and the MCP protocol
- Access to the institution you're building a connector for

## Step 1: Scaffold Your Plugin

Create a new directory under `plugins/`:

```
plugins/
└── my-bank/
    ├── package.json
    ├── manifest.json
    ├── tsconfig.json
    └── src/
        ├── index.ts          # MCP server entry point
        └── tools/
            └── fetch-data.ts # Your extraction logic
```

### package.json

```json
{
  "name": "@openconnectors/plugin-my-bank",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "playwright": "^1.44.0",
    "zod": "^3.23.0",
    "@openconnectors/schemas": "*"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^20.12.0"
  }
}
```

### tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../../schemas" }]
}
```

## Step 2: Write the Manifest

The manifest declares your plugin's identity, required credentials, and
exposed tools. It must validate against the
[PluginManifestSchema](../runtime/src/lib/manifest.ts).

```json
{
  "id": "my-bank",
  "name": "My Bank",
  "description": "Extract transactions and statements from My Bank",
  "version": "0.1.0",
  "author": "Your Name",
  "license": "MIT",
  "institutionUrl": "https://www.mybank.com",
  "credentials": [
    { "key": "username", "label": "Bank Username", "optional": false },
    { "key": "password", "label": "Bank Password", "optional": false },
    { "key": "otp_secret", "label": "TOTP Secret (for 2FA)", "optional": true }
  ],
  "tools": [
    {
      "name": "fetch_transactions",
      "description": "Fetch transactions for a date range",
      "inputSchema": {
        "type": "object",
        "properties": {
          "from_date": { "type": "string", "description": "YYYY-MM-DD" },
          "to_date": { "type": "string", "description": "YYYY-MM-DD" }
        },
        "required": ["from_date", "to_date"]
      }
    }
  ],
  "entryPoint": "dist/index.js"
}
```

### Plugin ID Rules

- Must be kebab-case: `my-bank`, `leumi-il`, `irs-gov`
- Must be globally unique within the registry

### Credential Keys

- Declare every secret your plugin needs
- The runtime reads these from the OS keychain and injects them as
  `OPENCONNECTORS_CRED_<KEY>` environment variables (uppercased)
- Mark optional credentials with `"optional": true`

## Step 3: Build the MCP Server

Your `src/index.ts` is a standard MCP server using `@modelcontextprotocol/sdk`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "my-bank",
  version: "0.1.0",
});

server.tool(
  "fetch_transactions",
  "Fetch transactions for a date range",
  {
    from_date: z.string().describe("Start date (YYYY-MM-DD)"),
    to_date: z.string().describe("End date (YYYY-MM-DD)"),
  },
  async ({ from_date, to_date }) => {
    const username = process.env["OPENCONNECTORS_CRED_USERNAME"];
    const password = process.env["OPENCONNECTORS_CRED_PASSWORD"];

    if (!username || !password) {
      return {
        content: [{ type: "text", text: "Missing credentials" }],
        isError: true,
      };
    }

    // Your Playwright extraction logic here
    const transactions = await scrapeTransactions(username, password, from_date, to_date);

    return {
      content: [{ type: "text", text: JSON.stringify(transactions, null, 2) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

## Step 4: Implement Playwright Extraction

This is where the real work happens. A typical flow:

```typescript
import { chromium } from "playwright";
import type { Transaction } from "@openconnectors/schemas";

async function scrapeTransactions(
  username: string,
  password: string,
  fromDate: string,
  toDate: string,
): Promise<Transaction[]> {
  const browser = await chromium.launch({
    headless: process.env["OPENCONNECTORS_HEADLESS"] !== "false",
  });

  try {
    const page = await browser.newPage();

    // 1. Navigate to login page
    await page.goto("https://www.mybank.com/login");

    // 2. Fill credentials
    await page.fill("#username", username);
    await page.fill("#password", password);
    await page.click("#login-btn");

    // 3. Wait for dashboard
    await page.waitForSelector(".dashboard");

    // 4. Navigate to transactions
    await page.goto("https://www.mybank.com/transactions");

    // 5. Set date range
    await page.fill("#from-date", fromDate);
    await page.fill("#to-date", toDate);
    await page.click("#search");

    // 6. Scrape the table
    const rows = await page.$$eval("table.transactions tbody tr", (trs) =>
      trs.map((tr) => {
        const cells = tr.querySelectorAll("td");
        return {
          date: cells[0]?.textContent?.trim() ?? "",
          description: cells[1]?.textContent?.trim() ?? "",
          amount: cells[2]?.textContent?.trim() ?? "",
        };
      })
    );

    // 7. Normalize into Transaction schema
    return rows.map((row, i) => ({
      id: `MYBANK-${i}`,
      date: row.date,
      amount: parseFloat(row.amount.replace(/[^0-9.-]/g, "")),
      currency: "ILS",
      originalDescription: row.description,
      description: row.description,
      accountId: username,
      pending: false,
    }));
  } finally {
    await browser.close();
  }
}
```

### Tips for Robust Scraping

- **Wait for elements**: Always use `waitForSelector` or `waitForLoadState`
  rather than fixed delays.
- **Handle 2FA**: If the bank uses SMS/TOTP, pause and prompt (or use the
  TOTP secret from credentials to auto-generate codes).
- **Error screenshots**: On failure, take a screenshot for debugging:
  `await page.screenshot({ path: 'error.png' })`.
- **Session reuse**: For multi-tool plugins, consider keeping the browser
  context alive across tool calls.

## Step 5: Test Your Plugin

```bash
# Build
cd plugins/my-bank
npm install
npm run build

# Set credentials
openconnectors vault set my-bank username
openconnectors vault set my-bank password

# Run with visible browser for debugging
openconnectors run my-bank fetch_transactions \
  --args '{"from_date":"2025-01-01","to_date":"2025-03-31"}' \
  --no-headless
```

## Step 6: Publish to the Registry

1. Push your plugin to a public Git repository.
2. Open a PR to add an entry to `registry.json`:

```json
{
  "id": "my-bank",
  "name": "My Bank",
  "description": "Extract transactions and statements from My Bank",
  "repository": "https://github.com/you/openconnectors-my-bank",
  "version": "0.1.0",
  "tags": ["banking", "israel"],
  "author": "Your Name"
}
```

## Schema Reference

Your plugin should emit data conforming to these normalized schemas:

### Transaction

Key fields: `id`, `date`, `amount`, `currency`, `description`, `category`

See: [schemas/src/transaction.ts](../schemas/src/transaction.ts)

### Document

Key fields: `id`, `title`, `type`, `mimeType`, `content` (base64)

See: [schemas/src/document.ts](../schemas/src/document.ts)

### Form106 (Israeli tax)

Key fields: `taxYear`, `grossSalary`, `incomeTaxWithheld`, plus IRS mappings

See: [schemas/src/form106.ts](../schemas/src/form106.ts)

## Security Guidelines

- **Never log credentials**. Not to console, not to files, not anywhere.
- **Never transmit credentials** to any server other than the target institution.
- **Close browsers** in `finally` blocks to prevent credential leakage.
- **Don't persist session cookies** across runs.
- **Validate all output** against the normalized schemas before returning.
