/**
 * Minimal dotenv-style .env writer.
 *
 * Used by the `configure_il_proxy` MCP tool to persist the Israeli-exit
 * proxy URL that the Playwright MCP launcher reads at startup. This is
 * the single source of truth for per-machine configuration — never
 * committed, never synced.
 *
 * Format:
 *   - KEY=value (simple form)
 *   - KEY="value with spaces or special chars"
 *   - Lines starting with `#` are preserved as comments
 *   - Blank lines are preserved
 *
 * Values containing `\n`, `"`, or leading/trailing whitespace are
 * double-quoted with embedded `"` and `\` escaped. Other values are
 * written bare.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Default .env path — repo root, next to package.json. Mirrors
 * connector-loader's repo-root resolution so the file matches what the
 * launcher script (`scripts/launch-playwright-mcp.cjs`) reads.
 */
export function defaultEnvPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // runtime/dist/lib/env-file.js → ../../../.env
  // runtime/src/lib/env-file.ts → ../../../.env (vitest source-based)
  return resolve(here, "..", "..", "..", ".env");
}

/**
 * Serialise a value safely. If it needs quoting, double-quote and escape.
 */
function serialise(value: string): string {
  const needsQuotes =
    /\s|^\s|\s$|["'`$\\#]/.test(value) || value.includes("\n") || value === "";
  if (!needsQuotes) return value;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Parse a `.env` file into an ordered list of lines. Each entry either
 * preserves a comment/blank line verbatim or carries a parsed KEY.
 */
interface ParsedLine {
  key?: string;
  raw: string;
}

function parseLines(text: string): ParsedLine[] {
  const lines = text.split(/\r?\n/);
  const out: ParsedLine[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      out.push({ raw: line });
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      out.push({ raw: line });
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      out.push({ raw: line });
      continue;
    }
    out.push({ key, raw: line });
  }
  return out;
}

/**
 * Read the current value of a key, or `undefined` if unset.
 */
export function getEnvVar(key: string, envPath?: string): string | undefined {
  const path = envPath ?? defaultEnvPath();
  if (!existsSync(path)) return undefined;
  const parsed = parseLines(readFileSync(path, "utf-8"));
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i].key === key) {
      const line = parsed[i].raw;
      const eq = line.indexOf("=");
      const raw = line.slice(eq + 1).trim();
      if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
        return raw
          .slice(1, -1)
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
      return raw;
    }
  }
  return undefined;
}

/**
 * Upsert `KEY=value` in the .env file, preserving every other line
 * (comments, blanks, other keys) byte-for-byte where possible.
 *
 * Returns the absolute path of the file that was written.
 */
export function setEnvVar(key: string, value: string, envPath?: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid .env key: ${key}`);
  }
  const path = envPath ?? defaultEnvPath();
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const parsed = parseLines(existing);
  const serialised = `${key}=${serialise(value)}`;

  let replaced = false;
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].key === key) {
      parsed[i] = { key, raw: serialised };
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    // Append, ensuring a newline separator.
    if (parsed.length > 0 && parsed[parsed.length - 1].raw !== "") {
      parsed.push({ raw: "" });
    }
    parsed.push({ key, raw: serialised });
  }

  const out = parsed.map((p) => p.raw).join("\n");
  // Ensure a trailing newline.
  const withTrailing = out.endsWith("\n") ? out : out + "\n";
  writeFileSync(path, withTrailing, "utf-8");
  return path;
}
