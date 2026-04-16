/**
 * PR5 — navigate_by_labels resolver.
 *
 * Pure function: given a normalized ARIA snapshot (`AriaNode` tree) and a
 * chain of `LabelMatch` steps, resolve each to a concrete node, applying
 * scope transitions between steps.
 *
 * The resolver itself does NOT drive a browser; the runtime / agent is
 * responsible for taking the resolved node (role + accessible name + id
 * path) and performing the requested `click_action`. Off-screen scrolling,
 * visibility waits, and the actual click are the browser driver's job.
 *
 * Matching strategies, applied in order (higher precedence wins outright;
 * ties within the top strategy → ambiguity error):
 *   1. exact accessible-name match (case-sensitive)
 *   2. exact aria-label match against any element of `label_any_of`
 *   3. role+name exact pair match (only when `role` is set on the step)
 *   4. case-insensitive substring on accessible-name
 *
 * When `label` is an array, each string is tried under strategy 1 and 2
 * (any-of semantics — useful for localized labels).
 *
 * Scope transitions:
 *   - `page`             (default): next step scans the full tree.
 *   - `subtree`:         next step scans descendants of the resolved node.
 *   - `controlled_region`: follows `aria-controls` on the resolved node to
 *                        its controlled element; next step scans that subtree.
 */

import type { LabelMatch } from "./connector-schema.js";

// ────────────────────────────────────────────────────────────────────────
// Snapshot shape
// ────────────────────────────────────────────────────────────────────────

export interface AriaNode {
  role: string;
  /** Computed accessible name (text of the node to a screen reader). */
  name?: string;
  /** Raw aria-label attribute(s). Array form supports localization variants. */
  ariaLabel?: string | string[];
  /** DOM id — used as the target of `aria-controls`. */
  id?: string;
  /** Value of `aria-controls` on this node, if any. */
  controls?: string;
  disabled?: boolean;
  /** Default `true`. Hidden nodes are skipped during resolution. */
  visible?: boolean;
  children?: AriaNode[];
}

// ────────────────────────────────────────────────────────────────────────
// Result shape
// ────────────────────────────────────────────────────────────────────────

export type ResolveStrategy =
  | "exact_name"
  | "aria_label_any_of"
  | "role_name_pair"
  | "case_insensitive_contains";

export interface ResolvedNode {
  node: AriaNode;
  /** Path of indices from scope root to this node. */
  path: number[];
  strategy: ResolveStrategy;
}

export type LabelResolveFailure =
  | { ok: false; reason: "not_found"; label: string | string[] }
  | {
      ok: false;
      reason: "ambiguous";
      label: string | string[];
      candidateCount: number;
    }
  | { ok: false; reason: "controls_unresolved"; label: string | string[] };

export type LabelResolveSuccess = { ok: true; resolved: ResolvedNode };

export type LabelResolveResult = LabelResolveSuccess | LabelResolveFailure;

export interface ChainResolveResult {
  /** Per-step results in order. Stops at first non-optional failure. */
  steps: Array<LabelResolveResult & { optional?: boolean }>;
  /** True iff every required step resolved (optional misses don't fail). */
  ok: boolean;
  /** Index of the first hard failure, or -1 if chain succeeded. */
  failedAt: number;
}

// ────────────────────────────────────────────────────────────────────────
// Resolution
// ────────────────────────────────────────────────────────────────────────

function isVisible(n: AriaNode): boolean {
  return n.visible !== false;
}

function ariaLabels(n: AriaNode): string[] {
  if (!n.ariaLabel) return [];
  return Array.isArray(n.ariaLabel) ? n.ariaLabel : [n.ariaLabel];
}

function labelCandidates(label: LabelMatch["label"]): string[] {
  return Array.isArray(label) ? label : [label];
}

/** Walk a subtree (scope root included) and emit every node with its path. */
function* walk(
  root: AriaNode,
  basePath: number[] = []
): Generator<{ node: AriaNode; path: number[] }> {
  yield { node: root, path: basePath };
  const kids = root.children ?? [];
  for (let i = 0; i < kids.length; i++) {
    yield* walk(kids[i], [...basePath, i]);
  }
}

/** Run a single matching strategy across the scope. */
function collectMatches(
  scope: AriaNode,
  step: LabelMatch,
  strategy: ResolveStrategy
): Array<{ node: AriaNode; path: number[] }> {
  const needles = labelCandidates(step.label);
  const hits: Array<{ node: AriaNode; path: number[] }> = [];
  for (const { node, path } of walk(scope)) {
    if (!isVisible(node)) continue;
    let match = false;
    switch (strategy) {
      case "exact_name":
        if (node.name && needles.some((n) => n === node.name)) match = true;
        break;
      case "aria_label_any_of": {
        const labels = ariaLabels(node);
        if (labels.length > 0 && needles.some((n) => labels.includes(n))) {
          match = true;
        }
        break;
      }
      case "role_name_pair":
        if (
          step.role &&
          node.role === step.role &&
          node.name &&
          needles.some((n) => n === node.name)
        ) {
          match = true;
        }
        break;
      case "case_insensitive_contains":
        if (node.name) {
          const hay = node.name.toLowerCase();
          if (needles.some((n) => hay.includes(n.toLowerCase()))) match = true;
        }
        break;
    }
    if (match) hits.push({ node, path });
  }
  return hits;
}

/**
 * Resolve a single step against a scope root. Returns the first strategy
 * that yields ≥1 match; if that strategy yields >1 match, returns ambiguous.
 * If `role` is provided on the step we prefer role+name pairing earlier
 * (after exact name, before aria-label any-of) because a role constraint
 * is a strong disambiguator.
 */
export function resolveLabelStep(
  scope: AriaNode,
  step: LabelMatch
): LabelResolveResult {
  const order: ResolveStrategy[] = step.role
    ? [
        "exact_name",
        "role_name_pair",
        "aria_label_any_of",
        "case_insensitive_contains",
      ]
    : ["exact_name", "aria_label_any_of", "case_insensitive_contains"];

  for (const strategy of order) {
    const hits = collectMatches(scope, step, strategy);
    // If role is set, gate every strategy by the role.
    const filtered = step.role ? hits.filter((h) => h.node.role === step.role) : hits;
    if (filtered.length === 0) continue;
    if (filtered.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        label: step.label,
        candidateCount: filtered.length,
      };
    }
    return {
      ok: true,
      resolved: { node: filtered[0].node, path: filtered[0].path, strategy },
    };
  }
  return { ok: false, reason: "not_found", label: step.label };
}

/** Find a node by DOM id anywhere in the tree. */
function findById(tree: AriaNode, id: string): AriaNode | undefined {
  for (const { node } of walk(tree)) {
    if (node.id === id) return node;
  }
  return undefined;
}

/** Apply a step's `next_scope` to produce the scope for the next step. */
function advanceScope(
  tree: AriaNode,
  current: AriaNode,
  resolved: AriaNode,
  nextScope: LabelMatch["next_scope"]
): { ok: true; scope: AriaNode } | { ok: false; reason: "controls_unresolved" } {
  switch (nextScope) {
    case "page":
      return { ok: true, scope: tree };
    case "subtree":
      return { ok: true, scope: resolved };
    case "controlled_region": {
      if (!resolved.controls) return { ok: false, reason: "controls_unresolved" };
      const target = findById(tree, resolved.controls);
      if (!target) return { ok: false, reason: "controls_unresolved" };
      return { ok: true, scope: target };
    }
    default:
      return { ok: true, scope: tree };
  }
}

/**
 * Resolve a chain of label steps against an ARIA tree.
 *
 * `optional` per-step comes from the owning `StepSchema.optional` (label
 * resolution reuses the step-level flag since the current schema attaches
 * optionality at the step, not per-label). Callers pass the flag in an
 * aligned `optionalFlags` array.
 */
export function resolveLabelChain(
  tree: AriaNode,
  chain: LabelMatch[],
  optionalFlags: boolean[] = []
): ChainResolveResult {
  let scope: AriaNode = tree;
  const results: Array<LabelResolveResult & { optional?: boolean }> = [];
  let failedAt = -1;

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    const optional = Boolean(optionalFlags[i]);
    const result = resolveLabelStep(scope, step);
    results.push({ ...result, optional });

    if (!result.ok) {
      if (optional) continue; // treat as success; keep current scope
      failedAt = i;
      break;
    }

    const advanced = advanceScope(tree, scope, result.resolved.node, step.next_scope);
    if (!advanced.ok) {
      results[results.length - 1] = {
        ok: false,
        reason: "controls_unresolved",
        label: step.label,
        optional,
      };
      if (!optional) {
        failedAt = i;
        break;
      }
      continue;
    }
    scope = advanced.scope;
  }

  return { steps: results, ok: failedAt === -1, failedAt };
}
