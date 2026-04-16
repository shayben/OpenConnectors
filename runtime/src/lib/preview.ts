/**
 * PR3 — Mutation preview.
 *
 * `run_preview` is a describe-only operation: given a mutation action and
 * its inputs, it returns a human- and agent-readable plan of what WOULD
 * happen, without launching a browser. That lets the agent (and the user)
 * inspect a batch before a single click is made.
 *
 * Pure function — no filesystem, no network, no Playwright. Testable in
 * a vitest unit.
 *
 * PR4 layers real execution (batch-runner, idempotency skip decisions, verify)
 * on top of the same action spec.
 */

import type { ConnectorAction, Connector } from "./connector-schema.js";

export interface PreviewRequest {
  action: ConnectorAction;
  connector: Connector;
  /** Arbitrary input blob that will eventually be validated against
   *  `action.input_schema`. For PR3 we don't validate — we just describe.
   *  Validation happens in PR4 when the real runner is wired. */
  input?: Record<string, unknown>;
}

export interface PreviewReport {
  connector_id: string;
  action: string;
  kind: "mutation";
  destructive: boolean;
  requires_confirmation: boolean;
  /** If the action declares preview.describe_only text, we echo it. */
  describe_only: string | null;
  /** Estimated number of items the runner will process. Derived from
   *  for_each binding path against `input`; null if we can't determine
   *  (e.g. sweep-based, or path not present in input). */
  item_count_estimate: number | null;
  /** Human-readable lines summarizing the plan. Each line is safe to log
   *  and free of any user-provided values (no PII echo). */
  plan: string[];
  /** Warnings the agent should surface to the user before proceeding. */
  warnings: string[];
}

/** Resolve a simple `{{input.xs}}` binding expression against `input`.
 *  Returns `undefined` if anything in the path is missing. Does NOT
 *  support full Jinja — only `input.<dot.path>`. */
function resolveForEachBinding(
  expr: string,
  input: Record<string, unknown> | undefined
): unknown {
  if (!input) return undefined;
  const match = /^\s*\{\{\s*input\.([a-zA-Z0-9_.]+)\s*\}\}\s*$/.exec(expr);
  if (!match) return undefined;
  const parts = match[1].split(".");
  let cur: unknown = input;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function runPreview(req: PreviewRequest): PreviewReport {
  const { action, connector, input } = req;

  if (action.kind !== "mutation") {
    throw new Error(
      `run_preview is only valid for mutation actions (action '${action.name}' is '${action.kind}').`
    );
  }

  const plan: string[] = [];
  const warnings: string[] = [];

  // 1. Header.
  plan.push(
    `Action: ${connector.id}.${action.name} (${action.kind})`
  );
  if (action.destructive) {
    plan.push("⚠ DESTRUCTIVE — this action removes or overwrites data.");
    warnings.push("destructive");
  }
  if (action.requires_confirmation) {
    plan.push("⚠ Requires explicit user confirmation before execution.");
    warnings.push("requires_confirmation");
  }

  // 2. Iteration shape.
  let item_count_estimate: number | null = null;
  if (action.for_each) {
    const arr = resolveForEachBinding(action.for_each, input);
    if (Array.isArray(arr)) {
      item_count_estimate = arr.length;
      plan.push(
        `for_each ${action.for_each} → ${arr.length} item(s) bound as '${action.as ?? "item"}'.`
      );
    } else if (arr === undefined) {
      plan.push(
        `for_each ${action.for_each} → (cannot count: input not provided or path missing)`
      );
      warnings.push("for_each_input_missing");
    } else {
      plan.push(
        `for_each ${action.for_each} → (resolved value is not an array: ${typeof arr})`
      );
      warnings.push("for_each_not_array");
    }
  } else if (action.sweep) {
    plan.push(
      `sweep targets_from=${action.sweep.targets_from} as '${action.sweep.as}'.`
    );
    plan.push(
      "Item count will be determined at run time from the read_before_write fetch."
    );
  } else {
    plan.push("Single-item mutation.");
    item_count_estimate = 1;
  }

  // 3. Idempotency.
  if (action.idempotency) {
    const keyParts = action.idempotency.key
      .map((p) =>
        "from" in p ? `{${p.from}}` : `"${p.literal}"`
      )
      .join(" + ");
    plan.push(
      `Idempotency: read_via '${action.idempotency.read_via}', key = ${keyParts}, ` +
        `on_conflict = ${action.idempotency.on_conflict ?? "skip"}.`
    );
  } else if (action.for_each || action.sweep) {
    warnings.push("no_idempotency_on_batch");
    plan.push(
      "⚠ No idempotency declared; a re-run will produce duplicate work."
    );
  }

  // 4. Preview body text (if the YAML provided one).
  const describeEmit = action.preview?.emit ?? null;
  if (describeEmit && describeEmit.length > 0) {
    plan.push("");
    plan.push("Preview template (templates resolved at run time):");
    for (const line of describeEmit) {
      plan.push("  " + line);
    }
  }

  // 5. Verify steps.
  if (action.verify && action.verify.length > 0) {
    plan.push(
      `After execution, ${action.verify.length} verify step(s) will run.`
    );
  }

  return {
    connector_id: connector.id,
    action: action.name,
    kind: "mutation",
    destructive: action.destructive,
    requires_confirmation: action.requires_confirmation,
    describe_only: describeEmit ? describeEmit.join("\n") : null,
    item_count_estimate,
    plan,
    warnings,
  };
}
