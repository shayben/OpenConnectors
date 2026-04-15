/**
 * Connector learning store.
 *
 * During a successful run Claude can record what it discovered — URL tree,
 * private API endpoints, gotchas — so the next session doesn't have to
 * rediscover them. Entries are persisted to a JSON sidecar next to the
 * connector YAML (`<id>.learned.json`), merged with the hand-authored
 * baseline at load time, and deduped by a natural key.
 *
 * This runs at the FRAMEWORK level: any connector benefits without its
 * YAML author writing a single line.
 *
 * HARD RULE — no personal data. Every payload runs through `assertNoPii`
 * before persisting. If a caller tries to record an ID/phone/JWT/balance,
 * the whole batch is rejected.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// -------------------- Schemas --------------------

// Children are "bare" topology nodes (no `kind`) so the top-level union
// stays a valid Zod discriminated union.
interface TopologyChild {
  label: string;
  url?: string;
  note?: string;
  children?: TopologyChild[];
}
const TopologyChildSchema: z.ZodType<TopologyChild> = z.lazy(() =>
  z.object({
    label: z.string().min(1).max(200),
    url: z.string().url().optional(),
    note: z.string().max(500).optional(),
    children: z.array(TopologyChildSchema).optional(),
  })
);

export const TopologyEntrySchema = z.object({
  kind: z.literal("topology"),
  label: z.string().min(1).max(200),
  url: z.string().url().optional(),
  note: z.string().max(500).optional(),
  children: z.array(TopologyChildSchema).optional(),
});

export const ApiShortcutEntrySchema = z.object({
  kind: z.literal("api_shortcut"),
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("POST"),
  path: z.string().startsWith("/"),
  auth: z
    .enum(["bearer_from_storage", "cookie_session", "none"])
    .default("bearer_from_storage"),
  auth_storage_key: z.string().max(100).optional(),
  body: z.string().max(2000).optional(),
  returns: z.string().max(500).optional(),
  notes: z.string().max(500).optional(),
});

export const QuirkEntrySchema = z.object({
  kind: z.literal("quirk"),
  text: z.string().min(10).max(1000),
});

// Lazy navigation-tree capture. Label-primary: nodes are identified by their
// `label_path` (ordered breadcrumb), not by URL. `path_template` is an optional,
// server-normalized direct-jump hint — exact URLs with per-user data are never
// stored. `first_seen_at`/`last_seen_at`/`stale` are stamped by the runtime.
export const NavNodeEntrySchema = z.object({
  kind: z.literal("nav_node"),
  label_path: z.array(z.string().min(1).max(200)).min(1).max(10),
  path_template: z.string().max(500).optional(),
  note: z.string().max(500).optional(),
  via: z.enum(["link", "button", "menu", "redirect", "direct"]).optional(),
  first_seen_at: z.string().optional(),
  last_seen_at: z.string().optional(),
  stale: z.boolean().optional(),
});

export const LearnEntrySchema = z.discriminatedUnion("kind", [
  TopologyEntrySchema,
  ApiShortcutEntrySchema,
  QuirkEntrySchema,
  NavNodeEntrySchema,
]);

export type LearnEntry = z.infer<typeof LearnEntrySchema>;
export type NavNodeEntry = z.infer<typeof NavNodeEntrySchema>;

// -------------------- PII guards --------------------

const PII_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "Israeli ID (9 digits)", re: /(?<![A-Za-z0-9])\d{9}(?![A-Za-z0-9])/ },
  { name: "Israeli mobile (05X-XXXXXXX)", re: /05\d[-\s]?\d{7}/ },
  { name: "International phone", re: /\+\d{9,}/ },
  { name: "JWT", re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  { name: "Credit card-ish", re: /\b(?:\d[ -]?){13,19}\b/ },
  { name: "Currency amount", re: /\d[\d,]*\s*(?:₪|\$|€|£|ILS|USD|EUR)/ },
  { name: "URL with credentials", re: /\/\/[^/\s]+:[^/\s]+@/ },
  { name: "URL with query token", re: /[?&](token|access_token|bearer|sid|jwt|p)=[A-Za-z0-9._-]{8,}/i },
  { name: "Email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  {
    name: "UUID in path",
    re: /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:$|[/?#])/i,
  },
  // 4+ digit path segments — catches account numbers the 9-digit rule misses.
  // Path templates ("/account/:id") pass; raw paths with ids don't.
  { name: "Numeric id in URL path", re: /\/\d{4,}(?:$|[/?#])/ },
];

function scan(value: unknown, path: string, hits: string[]): void {
  if (value == null) return;
  if (typeof value === "string") {
    for (const { name, re } of PII_PATTERNS) {
      if (re.test(value)) {
        hits.push(`${path}: matches ${name} → ${truncate(value)}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scan(v, `${path}[${i}]`, hits));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      scan(v, path ? `${path}.${k}` : k, hits);
    }
  }
}

function truncate(s: string): string {
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
}

/** Throws if the entry contains anything that looks like personal data. */
export function assertNoPii(entry: LearnEntry): void {
  const hits: string[] = [];
  scan(entry, "", hits);
  if (hits.length > 0) {
    throw new Error(
      `Learning entry rejected: contains PII-like content:\n  ${hits.join("\n  ")}`
    );
  }
}

// -------------------- Sidecar I/O --------------------

export interface LearningFile {
  entries: LearnEntry[];
  updated_at: string;
}

function defaultConnectorsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "connectors");
}

function sidecarPath(connectorId: string): string {
  const dir = process.env["OPENCONNECTORS_DIR"] ?? defaultConnectorsDir();
  return join(dir, `${connectorId}.learned.json`);
}

export function loadLearning(connectorId: string): LearnEntry[] {
  const path = sidecarPath(connectorId);
  if (!existsSync(path)) return [];
  try {
    const parsed: LearningFile = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function keyOf(e: LearnEntry): string {
  switch (e.kind) {
    case "topology":
      return `topology:${e.url ?? e.label.toLowerCase()}`;
    case "api_shortcut":
      return `api_shortcut:${e.method}:${e.path}`;
    case "quirk":
      return `quirk:${e.text.toLowerCase().trim().slice(0, 100)}`;
    case "nav_node":
      return `nav_node:${e.label_path.map((s) => s.toLowerCase()).join(">")}`;
    default:
      return `unknown:${JSON.stringify(e)}`;
  }
}

/**
 * Normalize a raw URL to a host-less path template safe for storage.
 *
 * - Drops query string and fragment (the #1 source of per-user tokens).
 * - Replaces digit-runs (≥3), hex runs (≥6), and UUIDs in path segments with `:id`.
 *
 * Returns `null` for unparseable input. Callers can use a returned `null` as a
 * signal to skip storing a path_template rather than crash.
 */
export function normalizePath(rawUrl: string): string | null {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").map((seg) => {
    if (seg === "") return seg;
    if (/^\d{3,}$/.test(seg)) return ":id";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
    if (/^[0-9a-f]{6,}$/i.test(seg)) return ":id";
    return seg;
  });
  let path = segments.join("/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "") path = "/";
  return path;
}

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_TEMPLATE_FLIPS_PER_BATCH = 3;

export interface RecordResult {
  added: number;
  skipped_duplicates: number;
  path: string;
}

export function recordLearning(
  connectorId: string,
  incoming: LearnEntry[]
): RecordResult {
  for (const entry of incoming) {
    LearnEntrySchema.parse(entry);
    assertNoPii(entry);
  }

  const path = sidecarPath(connectorId);
  const existing = loadLearning(connectorId);
  const seen = new Map<string, LearnEntry>();
  for (const e of existing) seen.set(keyOf(e), e);

  const now = new Date().toISOString();
  const touched = new Set<string>();
  // Track path_template flips per nav_node key within this write, so a single
  // burst of contradictory templates drops the template rather than thrashing.
  const templateFlips = new Map<string, number>();

  let added = 0;
  let skipped = 0;
  for (const e of incoming) {
    const k = keyOf(e);
    touched.add(k);
    const prior = seen.get(k);

    if (!prior) {
      if (e.kind === "nav_node") {
        seen.set(k, {
          ...e,
          first_seen_at: e.first_seen_at ?? now,
          last_seen_at: now,
          stale: false,
        });
      } else {
        seen.set(k, e);
      }
      added++;
      continue;
    }

    if (e.kind === "nav_node" && prior.kind === "nav_node") {
      const flips = (templateFlips.get(k) ?? 0) +
        (e.path_template && prior.path_template && e.path_template !== prior.path_template ? 1 : 0);
      templateFlips.set(k, flips);
      const templateUnstable = flips >= MAX_TEMPLATE_FLIPS_PER_BATCH;
      const nextTemplate = templateUnstable
        ? undefined
        : prior.path_template ?? e.path_template;
      const merged: NavNodeEntry = {
        kind: "nav_node",
        label_path: prior.label_path,
        ...(nextTemplate ? { path_template: nextTemplate } : {}),
        ...(prior.note ?? e.note ? { note: prior.note ?? e.note } : {}),
        ...(prior.via ?? e.via ? { via: (prior.via ?? e.via) as NavNodeEntry["via"] } : {}),
        first_seen_at: prior.first_seen_at ?? now,
        last_seen_at: now,
        stale: false,
      };
      seen.set(k, merged);
    }
    skipped++;
  }

  // Staleness sweep: any nav_node not touched in this write whose last_seen_at
  // is older than the threshold gets flagged. Never deleted.
  const staleCutoff = Date.now() - STALE_AFTER_MS;
  for (const [k, entry] of seen) {
    if (entry.kind !== "nav_node") continue;
    if (touched.has(k)) continue;
    const lastSeen = entry.last_seen_at ? Date.parse(entry.last_seen_at) : NaN;
    if (Number.isFinite(lastSeen) && lastSeen < staleCutoff && !entry.stale) {
      seen.set(k, { ...entry, stale: true });
    }
  }

  const file: LearningFile = {
    entries: Array.from(seen.values()),
    updated_at: now,
  };
  writeFileSync(path, JSON.stringify(file, null, 2));
  return { added, skipped_duplicates: skipped, path };
}
