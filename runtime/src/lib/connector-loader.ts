/**
 * Connector Loader
 *
 * Reads YAML connector definitions from the connectors/ directory,
 * validates them against the ConnectorSchema, and exposes them as
 * structured data.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import yaml from "js-yaml";
import { ConnectorSchema, type Connector } from "./connector-schema.js";

export interface LoadedConnector {
  connector: Connector;
  /** Path to the source YAML file. */
  path: string;
  /** Raw YAML content (returned by get_connector MCP tool). */
  raw: string;
}

/** Default connectors directory — relative to the repo root. */
function defaultConnectorsDir(): string {
  // runtime/dist/lib/connector-loader.js → ../../../connectors
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "connectors");
}

export class ConnectorLoader {
  private readonly dir: string;

  constructor(options?: { dir?: string }) {
    this.dir =
      options?.dir ??
      process.env["OPENCONNECTORS_DIR"] ??
      defaultConnectorsDir();
  }

  /** Load all YAML connectors from the directory. */
  async list(): Promise<LoadedConnector[]> {
    if (!existsSync(this.dir)) {
      return [];
    }

    const entries = await readdir(this.dir, { withFileTypes: true });
    const loaded: LoadedConnector[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml")) continue;

      const path = join(this.dir, entry.name);
      try {
        const raw = await readFile(path, "utf-8");
        const parsed = yaml.load(raw);
        const connector = ConnectorSchema.parse(parsed);
        loaded.push({ connector, path, raw });
      } catch (err) {
        console.warn(
          `Warning: Failed to load connector ${entry.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return loaded;
  }

  /** Resolve a single connector by id. */
  async get(id: string): Promise<LoadedConnector> {
    const all = await this.list();
    const match = all.find((c) => c.connector.id === id);
    if (!match) {
      const available = all.map((c) => c.connector.id).join(", ");
      throw new Error(
        `Connector "${id}" not found. Available: ${available || "(none)"}`
      );
    }
    return match;
  }

  /** Directory being scanned (useful for diagnostics). */
  get directory(): string {
    return this.dir;
  }
}
