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
                                request_credentials, get_credentials,
                                prompt_runtime_input, configure_il_proxy,
                                record_navigation, record_learning
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
7. If the flow hits a per-session challenge (SMS OTP, security question, CAPTCHA answer), call `prompt_runtime_input` with an ad-hoc field spec — the user fills it in the same local 127.0.0.1 form, and the value is returned directly (never vaulted). Never ask for an OTP in chat.
8. Validate extracted data against the declared `output_schema`
9. **During navigation, after each successful page transition**, call `record_navigation` with the `label_path` the user would read as a breadcrumb (e.g. `["Dashboard", "Reports", "Detailed Balances"]`) and the `observed_url`. This is a mid-flow firehose — one call per page transition, not batched. The runtime strips query strings / fragments and templates numeric/hex/UUID path segments to `:id` before storage, so per-user data never reaches disk. Repeat calls for the same `label_path` just refresh `last_seen_at`; nodes unseen for 30 days get flagged `stale` but are retained. On the next session `get_connector` surfaces the grown tree via its `merged.topology` field.
10. At the end of a successful flow, call `record_learning` for non-navigation discoveries: private XHR endpoints that short-circuit the UI (`api_shortcut`), gotchas like stuck loaders / misleading direct URLs / modal dismissals (`quirk`), or curated `topology` entries with hand-crafted notes. Don't replay navigation observations here — `record_navigation` already handled those. The runtime PII-scans every payload and merges into `<connector>.learned.json`. Never include IDs, phones, names, balances, tokens, emails, or UUIDs — the server will reject the whole batch if any entry contains PII-like strings.

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

Both MCP servers are declared in the committed `.mcp.json` at the repo root — Claude Code auto-loads it when the workspace is opened. The Playwright MCP is launched via `scripts/launch-playwright-mcp.cjs`, a tiny wrapper that reads the repo-root `.env` into `process.env` before spawning `@playwright/mcp`. This keeps `.env` the single source of truth — you do not need to export anything in your shell profile.

To enable proxied browsing:

1. Copy `.env.example` → `.env` and set `IL_PROXY_URL=https://user:pass@host:port` (URL-encode special chars; use `https://` for TLS-wrapped proxies like Azure `cloudapp.azure.com:8443`)
2. Reload the MCP servers (`/mcp` reconnect)

`.env` is gitignored. Proxy credentials never enter `~/.claude.json`, chat, or commits.

Proxy configuration (for connectors with `requires_israeli_ip: true`) lives at the Playwright MCP level — not per-connector. If `IL_PROXY_URL` is unset, Playwright launches without a proxy and connectors that require an IL IP will be blocked by the institution.

**FRE auto-recovery for geo-blocks:** when a connector page matches a geo-block fingerprint (e.g. "הגישה נחסמה", "access blocked", obvious IP-ban copy) on an institution whose YAML has `requires_israeli_ip: true`, call the `configure_il_proxy` MCP tool. It opens a local form, collects the user's proxy URL, writes it to `.env`, and returns a reload hint. Then tell the user to reload the Playwright MCP and retry. Never ask for the proxy URL in chat.
