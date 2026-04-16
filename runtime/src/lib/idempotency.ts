/**
 * PR4 — idempotency key computation.
 *
 * Given a KeyPart[] spec + a binding map + optional connector-level
 * text_normalizers, produce a stable string key. Normalization is applied
 * symmetrically to both sides ("existing" and "incoming") so matches are
 * deterministic.
 *
 * Normalizers:
 *   lower                - toLowerCase
 *   upper                - toUpperCase
 *   trim                 - String.trim
 *   collapse_whitespace  - multi-space/tab/newline -> single space
 *   nfc                  - Unicode NFC
 *   nfkc                 - Unicode NFKC
 *   strip_punct          - remove common ascii punctuation
 *
 * Unknown normalizers throw — schema already rejects them at parse time,
 * so this is belt-and-suspenders.
 */

import type { KeyPart, IdempotencySpec } from "./connector-schema.js";
import { resolvePath } from "./template.js";

const NORMALIZERS: Record<string, (s: string) => string> = {
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
  trim: (s) => s.trim(),
  collapse_whitespace: (s) => s.replace(/\s+/g, " "),
  nfc: (s) => s.normalize("NFC"),
  // Strip common emoji + pictographic ranges. Not exhaustive — intended
  // for "title" deduplication where a trailing 🚀 shouldn't change
  // identity. Uses \p{Extended_Pictographic} which Node supports.
  strip_emoji: (s) => s.replace(/\p{Extended_Pictographic}/gu, ""),
  // Replace unicode dashes with an ascii hyphen. Catches em dash,
  // en dash, figure dash, minus, etc.
  ascii_dashes: (s) => s.replace(/[\u2010-\u2015\u2212]/g, "-"),
  // Replace unicode arrows with ascii "->".
  ascii_arrows: (s) => s.replace(/[\u2190-\u21FF]/g, "->"),
  // Slug: lowercase, non-[a-z0-9]+ → "-", strip leading/trailing "-".
  slug: (s) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
};

export function applyNormalizers(value: string, normalizers: readonly string[] = []): string {
  let out = value;
  for (const n of normalizers) {
    const fn = NORMALIZERS[n];
    if (!fn) throw new Error(`Unknown normalizer: ${n}`);
    out = fn(out);
  }
  return out;
}

export function computeKey(
  spec: IdempotencySpec,
  bindings: Record<string, unknown>,
  connectorNormalizers: readonly string[] = []
): { key: string; missing: string[] } {
  const missing: string[] = [];
  const parts: string[] = [];
  for (const part of spec.key as KeyPart[]) {
    if ("literal" in part) {
      parts.push(part.literal);
      continue;
    }
    const raw = resolvePath(part.from, bindings);
    if (raw === undefined || raw === null) {
      missing.push(part.from);
      parts.push("");
      continue;
    }
    let s = typeof raw === "string" ? raw : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    // connector-level text_normalizers first, then per-part normalize
    // (matches design-v1.md: connector-level applies BEFORE per-part).
    s = applyNormalizers(s, connectorNormalizers);
    if (part.normalize) {
      s = applyNormalizers(s, part.normalize);
    }
    parts.push(s);
  }
  return { key: parts.join(""), missing };
}

/** Given a list of existing items (as Record<string, unknown> — usually
 *  the output of read_via), return the Set of keys we already have.
 *  Caller is responsible for telling us what binding name the existing
 *  items use (usually the same `as` used by the mutation's for_each). */
export function computeExistingKeySet(
  spec: IdempotencySpec,
  existing: ReadonlyArray<Record<string, unknown>>,
  bindingName: string,
  connectorNormalizers: readonly string[] = []
): Set<string> {
  const out = new Set<string>();
  for (const item of existing) {
    const { key, missing } = computeKey(
      spec,
      { [bindingName]: item },
      connectorNormalizers
    );
    if (missing.length > 0) {
      // Skip existing items we can't key — they won't participate in
      // idempotency, which means we may create a duplicate. That's
      // preferable to silently dropping items.
      continue;
    }
    out.add(key);
  }
  return out;
}
