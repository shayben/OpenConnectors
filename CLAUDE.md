# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

OpenConnectors is a local-first platform for extracting personal data from institutional web portals (banks, government, healthcare). Each connector is an MCP server wrapping Playwright browser automation. Credentials live in the OS keychain (keytar) and never leave the device.

## Build & Development Commands

```bash
# Monorepo-wide (from root)
npm run build        # Compile all packages via Turbo
npm run typecheck    # Type-check all packages (tsc --noEmit)
npm run lint         # Lint all packages
npm run clean        # Delete dist/ in all packages

# Single package
npx turbo run build --filter=@openconnectors/runtime
npx turbo run build --filter=plugins/mock-bank

# Run the CLI locally
node runtime/dist/cli.js <command>
```

No test framework is configured yet.

## Monorepo Layout

Three npm workspaces orchestrated by Turbo:

- **`schemas/`** (`@openconnectors/schemas`) — Zod schemas for normalized output types: `Transaction`, `Document`, `Form106`. Every plugin imports these. Build this first (Turbo handles ordering via `^build`).
- **`runtime/`** (`@openconnectors/runtime`) — CLI and plugin orchestration. Commands: `install`, `list`, `run`, `vault`. Spawns plugins as child processes, communicates via MCP, injects credentials as `OPENCONNECTORS_CRED_*` env vars.
- **`plugins/*`** — Each plugin is an independent MCP server. `plugins/mock-bank/` is the reference implementation and template for new connectors.

## Architecture: How a Plugin Runs

```
CLI (runtime/src/commands/run.ts)
  → PluginManager resolves manifest + path
  → CredentialVault loads secrets from OS keychain
  → Spawns plugin as child process (node plugin/dist/index.js)
    with OPENCONNECTORS_CRED_* env vars and OPENCONNECTORS_HEADLESS
  → MCP client sends tool call → plugin's MCP server handles it
  → Plugin launches Playwright, scrapes, returns normalized JSON
  → Runtime prints result to stdout
```

## Plugin Structure

Every plugin needs:
- **`manifest.json`** — validated against `PluginManifestSchema` (runtime/src/lib/manifest.ts). Declares id (kebab-case), credentials, tools with JSON Schema inputs, and entryPoint.
- **`src/index.ts`** — MCP server that registers tools via `@modelcontextprotocol/sdk`.
- **`src/tools/`** — Individual tool implementations using Playwright + schemas from `@openconnectors/schemas`.

See `docs/plugin-authoring.md` for the step-by-step guide and `plugins/mock-bank/` as the reference template.

## Key Conventions

- **TypeScript strict mode**, target ES2022, module Node16. All packages use `"type": "module"` with `.js` extensions in imports.
- **Zod** for all runtime validation (manifests, tool inputs, schema output).
- **No .env files** — credentials go in OS keychain via `vault set`, config via CLI flags.
- **2 spaces, LF line endings** (see .editorconfig).
- Installed plugins live at `~/.openconnectors/plugins/`.
- Registry is a static `registry.json` at repo root — no server component.
