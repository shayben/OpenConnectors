# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

OpenConnectors is a declarative connector registry for extracting personal data from institutional web portals (banks, pension funds, equity platforms). Each connector is a YAML file describing login flow, navigation steps, and output schema. Claude executes the navigation using the **`@playwright/mcp`** server — this repo does not contain any Playwright code.

## Architecture

Two MCP servers work together:

```
Claude
  ├── @playwright/mcp         → browser tools (browser_navigate, browser_click,
  │                             browser_fill_form, browser_snapshot, browser_evaluate,
  │                             browser_take_screenshot, browser_wait_for, ...)
  └── @openconnectors/runtime → list_connectors, get_connector, vault_status,
                                request_credentials, get_credentials
```

**Execution flow when Claude is asked to fetch data from an institution:**

1. `list_connectors` — find the right connector
2. `get_connector(id)` — load the full YAML definition
3. `vault_status(connector_id)` — confirm required credentials are set
4. If any are missing: `request_credentials(connector_id)` — opens a local browser
   form at 127.0.0.1, user fills and submits, values go straight to OS keychain.
   **Never ask the user for credentials in chat** — the chat transcript is not
   a secure channel.
5. `get_credentials(connector_id)` — retrieve decrypted secrets from OS keychain
6. Follow the `steps` in the YAML using Playwright MCP tools, substituting `{{credential_key}}` placeholders
7. Validate extracted data against the declared `output_schema`

**Security rules for credential handling (strict):**

- Never type credentials into chat. Never ask the user to paste them into chat.
- Never include credential values in your own messages, even in "I'll use password=XYZ" form.
- Call `request_credentials` for the JIT flow whenever creds are missing. It returns
  only status + key names — the values stay in the keychain.
- `get_credentials` returns values over MCP; immediately pass them to Playwright MCP
  `browser_fill_form` calls. Do not echo them back or store them.

## Build & Development Commands

```bash
# Monorepo-wide (from root)
npm run build      # Compile runtime + schemas via Turbo
npm run typecheck  # Type-check without emit
npm run clean      # Delete dist/

# Run the CLI
node runtime/dist/cli.js list                                 # list connectors
node runtime/dist/cli.js vault set <connector> <key>          # store a credential
node runtime/dist/cli.js vault clear <connector> [--key k]    # remove credentials
node runtime/dist/cli.js serve                                # start MCP server
```

No test framework configured yet.

## Repository Layout

- **`connectors/`** — YAML connector definitions. One file per institution. See `connectors/README.md` for the schema.
- **`runtime/`** (`@openconnectors/runtime`) — CLI + MCP server. Three libs: `connector-loader.ts` (reads/validates YAML), `vault.ts` (OS keychain via `@napi-rs/keyring`), `mcp-server.ts` (exposes the four tools listed above).
- **`schemas/`** (`@openconnectors/schemas`) — Zod schemas for normalized output types: `Transaction`, `Document`, `Form106`. Shared across connectors.

## Connector YAML Schema

Each `connectors/<id>.yaml` has:
- `id`, `name`, `description`, `version`, `author`, `license`, `tags`
- `institution`: name, url, country, locale, timezone, `requires_israeli_ip` hint
- `credentials`: array of `{ key, label, type: text|password|totp_secret }`
- `actions`: array of actions, each with:
  - `name` (snake_case), `description`, `input_schema` (JSON Schema), `output_schema` (type name)
  - `steps`: ordered phases (`login`, `navigate`, `extract`) with natural-language `instructions` that reference Playwright MCP tool names
  - Optional `otp_handling`, `data_format`, `timeout_seconds` per step

See `runtime/src/lib/connector-schema.ts` for the full Zod validation schema.

## Key Conventions

- **TypeScript strict mode**, target ES2022, module Node16. All packages use `"type": "module"` with `.js` extensions in imports.
- **Zod** for manifest validation. **js-yaml** for parsing.
- **Credentials** always go through `@napi-rs/keyring` (OS-native keystore). Never written to disk.
- **2 spaces, LF line endings** (see `.editorconfig`).
- Connector ids are kebab-case. Credential keys and action names are snake_case.

## MCP Client Configuration

Users configure both MCP servers in their Claude client:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--proxy-server", "http://user:pass@proxy:port"]
    },
    "openconnectors": {
      "command": "node",
      "args": ["<path-to-repo>/runtime/dist/cli.js", "serve"]
    }
  }
}
```

Proxy configuration (for connectors with `requires_israeli_ip: true`) lives at the Playwright MCP level — not per-connector.
