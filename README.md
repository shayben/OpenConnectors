# OpenConnectors

**Local-first, community-driven data extraction from institutional web portals.**

OpenConnectors uses MCP servers wrapping Playwright to log into your banks, government portals, and healthcare providers — extracting your personal data and normalizing it into standard schemas that consumer apps (tax prep, net-worth tracking, document vaults) can consume.

## Core Principles

- **Local-first** — Credentials are stored in your OS keychain (macOS Keychain / Windows Credential Manager / libsecret). They never leave your machine. All browser automation runs locally.
- **Community-driven** — Plugins are authored by the community and published to a shared registry. Anyone can contribute a connector for their bank or institution.
- **AI-agent-native** — Every plugin is an MCP server. AI agents (Claude, GPT, etc.) can discover and call tools directly — no glue code needed.
- **Schema-driven** — All extracted data conforms to normalized schemas (transactions, documents, tax forms) so consumer apps work across any institution.

## Quickstart

```bash
# 1. Clone and install
git clone https://github.com/shayben/opencpnnectors.git
cd opencpnnectors
npm install
npm run build

# 2. Store your credentials securely
openconnectors vault set mock-bank username
openconnectors vault set mock-bank password

# 3. Install a plugin
openconnectors install ./plugins/mock-bank

# 4. Run a tool
openconnectors run mock-bank fetch_transactions --args '{"from_date":"2025-01-01","to_date":"2025-03-31"}'
openconnectors run mock-bank fetch_tax_documents --args '{"year":2025}'
```

## Using with AI Agents

Because every plugin is an MCP server, you can point any MCP-compatible AI agent at it:

```json
{
  "mcpServers": {
    "mock-bank": {
      "command": "node",
      "args": ["./plugins/mock-bank/dist/index.js"],
      "env": {
        "OPENCONNECTORS_CRED_USERNAME": "your-username",
        "OPENCONNECTORS_CRED_PASSWORD": "your-password"
      }
    }
  }
}
```

The agent can then call `fetch_transactions` and `fetch_tax_documents` directly.

## CLI Commands

| Command | Description |
|---------|-------------|
| `openconnectors install <plugin>` | Install a plugin from the registry or a local path |
| `openconnectors list` | List installed plugins and their tools |
| `openconnectors run <plugin> <tool>` | Execute a plugin tool |
| `openconnectors vault set <plugin> <key>` | Store a credential in the system keychain |
| `openconnectors vault clear <plugin>` | Remove stored credentials |

## Project Structure

```
openconnectors/
├── runtime/              # CLI + plugin runtime
│   └── src/
│       ├── cli.ts        # CLI entry point (commander)
│       ├── commands/     # install, list, run, vault
│       └── lib/          # vault, plugin-manager, registry, manifest
├── schemas/              # Normalized data schemas (zod)
│   └── src/
│       ├── transaction.ts
│       ├── document.ts
│       └── form106.ts    # Israeli Form 106 + IRS mapping
├── plugins/
│   └── mock-bank/        # Reference plugin
│       ├── manifest.json
│       └── src/
│           ├── index.ts  # MCP server
│           └── tools/    # fetch_transactions, fetch_tax_documents
├── docs/
│   ├── architecture.md
│   └── plugin-authoring.md
├── registry.json         # Community plugin registry
└── package.json          # Monorepo root (npm workspaces + turbo)
```

## Documentation

- [Architecture Overview](docs/architecture.md) — System design, data flow, and security model
- [Plugin Authoring Guide](docs/plugin-authoring.md) — How to build a plugin for your institution

## Tech Stack

- **TypeScript** — End-to-end type safety
- **@modelcontextprotocol/sdk** — MCP server/client for AI-native tool exposure
- **Playwright** — Browser automation for institutional portals
- **keytar** — OS-native credential storage
- **Zod** — Runtime schema validation
- **Commander** — CLI framework

## Contributing

We welcome contributions! Whether it's a plugin for your bank, an improvement to the runtime, or a new normalized schema — open an issue or PR.

See the [Plugin Authoring Guide](docs/plugin-authoring.md) to get started building a connector.

## License

MIT — see [LICENSE](LICENSE).
