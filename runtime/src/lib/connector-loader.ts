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
import { loadLearning } from "./learning.js";

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
        mergeLearnedSidecar(connector);
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

/**
 * Fold `<id>.learned.json` entries into the connector's topology /
 * api_shortcuts / known_quirks, deduped against the hand-authored baseline.
 */
function mergeLearnedSidecar(connector: Connector): void {
  const entries = loadLearning(connector.id);
  if (entries.length === 0) return;

  const topo = (connector.topology ?? []) as Array<Record<string, unknown>>;
  const apis = (connector.api_shortcuts ?? []) as Array<Record<string, unknown>>;
  const quirks = (connector.known_quirks ?? []).slice();

  const topoKeys = new Set(
    topo.map((n) => String(n.url ?? n.label ?? "").toLowerCase())
  );
  const apiKeys = new Set(apis.map((a) => `${a.method}:${a.path}`));
  const quirkKeys = new Set(
    quirks.map((q) => q.toLowerCase().trim().slice(0, 100))
  );

  for (const e of entries) {
    if (e.kind === "topology") {
      const key = String(e.url ?? e.label).toLowerCase();
      if (!topoKeys.has(key)) {
        topo.push({
          label: e.label,
          ...(e.url ? { url: e.url } : {}),
          ...(e.note ? { note: e.note } : {}),
          ...(e.children ? { children: e.children } : {}),
        });
        topoKeys.add(key);
      }
    } else if (e.kind === "api_shortcut") {
      const key = `${e.method}:${e.path}`;
      if (!apiKeys.has(key)) {
        apis.push({ ...e } as Record<string, unknown>);
        apiKeys.add(key);
      }
    } else if (e.kind === "quirk") {
      const key = e.text.toLowerCase().trim().slice(0, 100);
      if (!quirkKeys.has(key)) {
        quirks.push(e.text);
        quirkKeys.add(key);
      }
    }
  }

  // Fold nav_node entries (from lazy record_navigation calls) by walking
  // label_path into the tree. Hand-authored nodes always win on label match.
  for (const e of entries) {
    if (e.kind !== "nav_node") continue;
    let level = topo;
    let node: Record<string, unknown> | null = null;
    for (const label of e.label_path) {
      const lower = label.toLowerCase();
      let match = level.find(
        (n) => typeof n["label"] === "string" && (n["label"] as string).toLowerCase() === lower
      );
      if (!match) {
        match = { label };
        level.push(match);
      }
      node = match;
      const children = (match["children"] ?? []) as Array<Record<string, unknown>>;
      match["children"] = children;
      level = children;
    }
    if (!node) continue;
    if (e.path_template && !node["url"]) {
      node["url"] = e.path_template;
    }
    if (e.note && !node["note"]) {
      node["note"] = e.note;
    }
    if (e.last_seen_at) node["last_seen_at"] = e.last_seen_at;
    if (e.stale) node["stale"] = true;
    // Don't leave an empty children array dangling on a leaf.
    if (Array.isArray(node["children"]) && (node["children"] as unknown[]).length === 0) {
      delete node["children"];
    }
  }

  (connector as any).topology = topo;
  (connector as any).api_shortcuts = apis;
  (connector as any).known_quirks = quirks;
}
