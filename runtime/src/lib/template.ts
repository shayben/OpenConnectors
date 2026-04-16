/**
 * PR4 — tiny template engine.
 *
 * YAML connectors reference bound values with `{{var.path}}` substitution.
 * Exactly one syntax is supported — this is a config format, not a DSL:
 *
 *   {{name}}
 *   {{task.title}}
 *   {{task.checklist.length}}    // special: arr.length
 *   {{input.tasks[0]}}           // numeric index on arrays
 *
 * No filters, no conditionals, no partials. If you find yourself wanting
 * more, write a fetch action instead.
 *
 * All functions are pure; no I/O.
 */

export type TemplateBindings = Record<string, unknown>;

/** Resolve a single `path.like.this` against bindings. Returns undefined
 *  if any segment is missing. */
export function resolvePath(path: string, bindings: TemplateBindings): unknown {
  if (!path) return undefined;
  const segments: string[] = [];
  for (const part of path.split(".")) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*)(\[(\d+)\])?$/.exec(part);
    if (!m) {
      // pass-through; let lookup fail below
      segments.push(part);
      continue;
    }
    segments.push(m[1]);
    if (m[3] !== undefined) segments.push(m[3]);
  }

  let cur: unknown = bindings;
  for (const seg of segments) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) {
        if (seg === "length") return cur.length;
        return undefined;
      }
      cur = cur[idx];
      continue;
    }
    if (typeof cur === "object") {
      // Special-case .length on strings-as-values doesn't make sense;
      // only support it on arrays (above).
      cur = (cur as Record<string, unknown>)[seg];
      continue;
    }
    if (typeof cur === "string" && seg === "length") return cur.length;
    return undefined;
  }
  return cur;
}

/** Substitute `{{path}}` tokens in a string. Undefined paths render as
 *  the empty string AND return a list of missing paths so callers can
 *  decide whether to hard-fail.
 */
export function renderTemplate(
  template: string,
  bindings: TemplateBindings
): { rendered: string; missing: string[] } {
  const missing: string[] = [];
  const rendered = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, raw: string) => {
    const path = raw.trim();
    const value = resolvePath(path, bindings);
    if (value === undefined) {
      missing.push(path);
      return "";
    }
    if (value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
  return { rendered, missing };
}

/** Render every string field of a step, recursively. Arrays and objects
 *  are walked; non-string scalars are passed through untouched. Returns
 *  the rendered clone + any missing paths encountered anywhere in it. */
export function renderDeep<T>(
  value: T,
  bindings: TemplateBindings
): { rendered: T; missing: string[] } {
  const missing: string[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const { rendered, missing: m } = renderTemplate(v, bindings);
      for (const p of m) missing.push(p);
      return rendered;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(sub);
      }
      return out;
    }
    return v;
  };
  return { rendered: walk(value) as T, missing };
}
