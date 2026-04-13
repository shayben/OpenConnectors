# Architecture Overview

## System Design

OpenConnectors is a local-first platform where data extraction runs entirely
on the user's machine. The architecture has three layers:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Consumer Apps                            │
│         (Tax Prep · Net-Worth Tracker · Document Vault)         │
└──────────────────────────┬──────────────────────────────────────┘
                           │ Normalized JSON (Transaction, Document, Form106)
                           │
┌──────────────────────────┴──────────────────────────────────────┐
│                     OpenConnectors Runtime                      │
│                                                                 │
│  ┌──────────┐  ┌──────────────┐  ┌───────────┐  ┌───────────┐  │
│  │   CLI    │  │Plugin Manager│  │ Credential│  │  Registry  │  │
│  │(commander│  │  (install,   │  │   Vault   │  │  (JSON)    │  │
│  │  cmds)   │  │  list, run)  │  │  (keytar) │  │            │  │
│  └────┬─────┘  └──────┬───────┘  └─────┬─────┘  └──────┬─────┘  │
│       │               │                │               │        │
│       └───────────────┴────────────────┴───────────────┘        │
│                           │ MCP (stdio)                         │
└───────────────────────────┼─────────────────────────────────────┘
                            │
┌───────────────────────────┴─────────────────────────────────────┐
│                      Plugin (MCP Server)                        │
│                                                                 │
│  ┌──────────────┐    ┌────────────┐    ┌─────────────────────┐  │
│  │  MCP Server  │───▶│ Playwright │───▶│ Institution Portal  │  │
│  │  (tool defs) │    │  (browser) │    │ (bank, govt, etc.)  │  │
│  └──────────────┘    └────────────┘    └─────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Normalized Output (Zod schemas)             │   │
│  │         Transaction[] · Document[] · Form106             │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

A typical `openconnectors run` invocation follows this path:

```
User runs CLI command
        │
        ▼
┌─ Runtime ──────────────────────────────────────────────────┐
│  1. Resolve plugin by ID (read manifest.json)              │
│  2. Verify requested tool exists in manifest               │
│  3. Load credentials from OS keychain (keytar)             │
│  4. Inject credentials as env vars                         │
│  5. Spawn plugin as child process (MCP over stdio)         │
└────────────────────────────┬───────────────────────────────┘
                             │ MCP callTool request
                             ▼
┌─ Plugin (child process) ───────────────────────────────────┐
│  6. Receive tool call via MCP                              │
│  7. Launch Playwright browser (headless by default)        │
│  8. Log into institution portal using credentials          │
│  9. Navigate to target page, scrape data                   │
│ 10. Normalize scraped data into standard schemas           │
│ 11. Return JSON via MCP response                           │
│ 12. Close browser                                          │
└────────────────────────────┬───────────────────────────────┘
                             │ MCP response (JSON)
                             ▼
┌─ Runtime ──────────────────────────────────────────────────┐
│ 13. Print results to stdout                                │
│ 14. Close MCP connection                                   │
└────────────────────────────────────────────────────────────┘
```

## Security Model

Security is a first-class concern. The design enforces these invariants:

### Credentials Never Leave the Machine

```
┌─────────────────────────────────────────────┐
│            User's Machine                   │
│                                             │
│  ┌─────────────────────┐                    │
│  │   OS Keychain        │                   │
│  │  ┌───────────────┐  │                    │
│  │  │ macOS Keychain│  │  keytar API        │
│  │  │ Win CredMgr   │◀─┼──────────────┐    │
│  │  │ libsecret     │  │              │    │
│  │  └───────────────┘  │              │    │
│  └─────────────────────┘              │    │
│                                       │    │
│  ┌────────────────────────────────────┤    │
│  │ OpenConnectors Runtime             │    │
│  │  vault.get(plugin, key) ───────────┘    │
│  │  → env var OPENCONNECTORS_CRED_*        │
│  │  → passed to child process only         │
│  └─────────────────────────────────────    │
│                                             │
│  Nothing leaves this box.                   │
└─────────────────────────────────────────────┘
```

- Credentials are encrypted at rest by the OS keychain.
- The runtime reads them and passes them to plugin child processes via
  environment variables — they are never written to disk, logs, or network.
- Plugins receive credentials as `OPENCONNECTORS_CRED_*` env vars and should
  never persist or transmit them.

### Plugin Isolation

- Each plugin runs as a **separate child process**, communicating only via
  MCP over stdio. A malicious plugin cannot access another plugin's memory.
- Plugins have no network access to OpenConnectors infrastructure — they
  only talk to the institution they're designed for.
- The manifest declares which credentials a plugin needs. The runtime
  only provides those specific values.

### No Cloud, No Telemetry

- There is no central server. The registry is a static JSON file.
- No usage data, credentials, or extracted data is ever sent anywhere.
- Users can fork the registry and host it themselves.

## Plugin Manifest

Every plugin includes a `manifest.json` that declares:

| Field | Purpose |
|-------|---------|
| `id` | Unique kebab-case identifier |
| `name` | Human-readable display name |
| `description` | What data the plugin extracts |
| `version` | Semver version |
| `credentials` | Required/optional credential keys |
| `tools` | MCP tools with names, descriptions, input schemas |
| `entryPoint` | Path to compiled JS entry point |

See [manifest.ts](../runtime/src/lib/manifest.ts) for the full Zod schema.

## Normalized Schemas

All plugins emit data conforming to shared schemas defined in the
`@openconnectors/schemas` package:

- **Transaction** — Universal financial transaction (amount, currency,
  category, merchant, balance)
- **Document** — Retrieved document with metadata (tax forms, statements,
  medical records)
- **Form106** — Israeli employer tax certificate with IRS field mappings
  for dual-filer tax prep

These schemas use Zod for runtime validation, ensuring consumer apps can
trust the shape of data from any plugin.

## Registry

The community plugin registry is a JSON array:

```json
[
  {
    "id": "mock-bank",
    "name": "Mock Bank",
    "repository": "https://github.com/shayben/opencpnnectors",
    "version": "0.1.0",
    "tags": ["banking", "reference"],
    "author": "OpenConnectors Contributors"
  }
]
```

- Hosted as a static file (no server required).
- `openconnectors install <id>` clones the repo and builds it locally.
- Users can point to custom registries with `--registry <url>`.
