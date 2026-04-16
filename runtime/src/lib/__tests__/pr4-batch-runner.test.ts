/**
 * PR4 — BatchRunner + idempotency + template.
 */

import { describe, it, expect } from "vitest";
import { ConnectorSchema, type MutationAction } from "../connector-schema.js";
import { BatchRunner } from "../batch-runner.js";
import { computeKey, applyNormalizers, computeExistingKeySet } from "../idempotency.js";
import { renderTemplate, resolvePath } from "../template.js";

// ---------- Template ----------

describe("PR4 — template", () => {
  it("resolves nested paths", () => {
    expect(resolvePath("task.title", { task: { title: "x" } })).toBe("x");
    expect(resolvePath("task.checklist.length", { task: { checklist: ["a", "b", "c"] } })).toBe(3);
  });

  it("returns undefined for missing paths", () => {
    expect(resolvePath("task.nope", { task: {} })).toBeUndefined();
  });

  it("renders with undefined paths returning missing list", () => {
    const { rendered, missing } = renderTemplate(
      "hello {{who}} from {{whence}}",
      { who: "world" }
    );
    expect(rendered).toBe("hello world from ");
    expect(missing).toEqual(["whence"]);
  });

  it("renders nested template values", () => {
    const { rendered } = renderTemplate("Create {{task.title}} [{{task.priority}}]", {
      task: { title: "Launch", priority: "high" },
    });
    expect(rendered).toBe("Create Launch [high]");
  });
});

// ---------- Normalizers ----------

describe("PR4 — normalizers", () => {
  it("lower + trim", () => {
    expect(applyNormalizers("  HELLO  ", ["lower", "trim"])).toBe("hello");
  });

  it("nfc normalises composed characters", () => {
    const decomposed = "e\u0301"; // é as e + combining acute
    const composed = "é";
    expect(applyNormalizers(decomposed, ["nfc"])).toBe(composed);
  });

  it("collapse_whitespace", () => {
    expect(applyNormalizers("a\t\n  b   c", ["collapse_whitespace"])).toBe("a b c");
  });

  it("unknown normalizer throws", () => {
    expect(() => applyNormalizers("x", ["bogus"])).toThrow(/Unknown normalizer/);
  });
});

// ---------- Idempotency key ----------

describe("PR4 — idempotency key DSL", () => {
  const spec = {
    key: [
      { from: "task.title", normalize: ["lower", "trim"] },
      { literal: "|" },
      { from: "task.bucket", normalize: ["lower"] },
    ],
    read_via: "list_tasks",
    on_conflict: "skip" as const,
  };

  it("field + literal concatenation", () => {
    const { key } = computeKey(spec as never, { task: { title: " Deploy ", bucket: "DEV" } });
    expect(key).toBe("deploy|dev");
  });

  it("symmetric match across incoming and existing", () => {
    const existing = [
      { title: "Deploy", bucket: "Dev" },
      { title: "Ship", bucket: "Prod" },
    ];
    const set = computeExistingKeySet(spec as never, existing, "task");
    const { key } = computeKey(spec as never, { task: { title: " deploy ", bucket: "dev" } });
    expect(set.has(key)).toBe(true);
  });

  it("connector-level text_normalizers apply before per-part normalize", () => {
    const tightSpec = {
      key: [{ from: "task.title", normalize: ["lower"] }],
      read_via: "x",
      on_conflict: "skip" as const,
    };
    const { key } = computeKey(tightSpec as never, { task: { title: " MIX case " } }, [
      "trim",
      "collapse_whitespace",
    ]);
    expect(key).toBe("mix case");
  });

  it("missing `from` path is reported (not silently empty)", () => {
    const { key, missing } = computeKey(
      {
        key: [{ from: "task.title" }, { from: "task.bucket" }],
        read_via: "x",
        on_conflict: "skip",
      } as never,
      { task: { title: "only title" } }
    );
    expect(missing).toEqual(["task.bucket"]);
    expect(key).toBe("only title");
  });
});

// ---------- BatchRunner ----------

function makeConnector(
  actionOverride: Partial<Record<string, unknown>> = {},
  text_normalizers?: string[]
) {
  return ConnectorSchema.parse({
    id: "test-batch",
    name: "Test Batch",
    description: "x",
    version: "1.0.0",
    author: "x",
    institution: { name: "T", url: "https://example.com", country: "US" },
    auth: { type: "persistent_profile", profile_id: "p" },
    ...(text_normalizers ? { text_normalizers } : {}),
    actions: [
      {
        kind: "fetch",
        name: "list_tasks",
        description: "list",
        steps: [{ phase: "navigate", instructions: "go" }],
      },
      {
        kind: "mutation",
        name: "create_tasks",
        description: "create",
        input_schema: "TaskBatch",
        for_each: "{{input.tasks}}",
        as: "task",
        steps: [{ phase: "mutate", instructions: "Create {{task.title}}" }],
        ...actionOverride,
      },
    ],
  });
}

function mutationOf(c: ReturnType<typeof makeConnector>, name: string): MutationAction {
  const a = c.actions.find((x) => x.name === name);
  if (!a || a.kind !== "mutation") throw new Error("not a mutation");
  return a;
}

describe("PR4 — BatchRunner happy path", () => {
  it("start → next → complete → next → ... → done", () => {
    const c = makeConnector();
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();

    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "a" }, { title: "b" }] },
    });
    expect(summary.total_planned).toBe(2);

    // Item 0
    let step = runner.nextStep(summary.batch_id);
    expect(step.kind).toBe("step");
    if (step.kind !== "step") throw new Error("unreachable");
    expect(step.input_index).toBe(0);
    expect(step.phase).toBe("mutate");
    expect(step.rendered_steps[0].instructions).toBe("Create a");
    const t0 = step.item_token;
    runner.complete(summary.batch_id, { item_token: t0, status: "ok" });

    // Item 1
    step = runner.nextStep(summary.batch_id);
    if (step.kind !== "step") throw new Error("expected step");
    expect(step.input_index).toBe(1);
    expect(step.rendered_steps[0].instructions).toBe("Create b");
    runner.complete(summary.batch_id, { item_token: step.item_token, status: "ok" });

    // Done
    step = runner.nextStep(summary.batch_id);
    expect(step.kind).toBe("done");
    if (step.kind !== "done") throw new Error("unreachable");
    expect(step.report.succeeded).toBe(2);
    expect(step.report.failed).toBe(0);
    expect(step.report.aborted).toBe(false);
  });
});

describe("PR4 — item_token invariants", () => {
  it("replayed complete is a no-op, not a double-advance", () => {
    const c = makeConnector();
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "a" }] },
    });
    const step = runner.nextStep(summary.batch_id);
    if (step.kind !== "step") throw new Error("unreachable");
    const t = step.item_token;
    const r1 = runner.complete(summary.batch_id, { item_token: t, status: "ok" });
    expect(r1.replayed).toBe(false);
    const r2 = runner.complete(summary.batch_id, { item_token: t, status: "ok" });
    expect(r2.replayed).toBe(true);
    // And the batch still shows 1 succeeded, not 2.
    const done = runner.nextStep(summary.batch_id);
    if (done.kind !== "done") throw new Error("expected done");
    expect(done.report.succeeded).toBe(1);
  });

  it("next_step with a pending lease replays the same token", () => {
    const c = makeConnector();
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "a" }] },
    });
    const step1 = runner.nextStep(summary.batch_id);
    const step2 = runner.nextStep(summary.batch_id);
    if (step1.kind !== "step" || step2.kind !== "step") throw new Error("unreachable");
    expect(step2.item_token).toBe(step1.item_token);
  });

  it("unknown item_token throws", () => {
    const c = makeConnector();
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "a" }] },
    });
    expect(() =>
      runner.complete(summary.batch_id, { item_token: "bogus", status: "ok" })
    ).toThrow(/Unknown item_token/);
  });
});

describe("PR4 — idempotency prefilter", () => {
  it("items matching existing prior_state are skipped and counted", () => {
    const c = makeConnector({
      idempotency: {
        key: [{ from: "task.title", normalize: ["lower", "trim"] }],
        read_via: "list_tasks",
      },
    });
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "Existing" }, { title: "New" }] },
      prior_state: [{ title: "EXISTING" }, { title: "Other" }],
    });
    expect(summary.total_planned).toBe(1);
    expect(summary.total_skipped_idempotent).toBe(1);

    const step = runner.nextStep(summary.batch_id);
    if (step.kind !== "step") throw new Error("expected step");
    expect(step.input_index).toBe(1); // stable input_index; only item 1 survived

    runner.complete(summary.batch_id, { item_token: step.item_token, status: "ok" });
    const done = runner.nextStep(summary.batch_id);
    if (done.kind !== "done") throw new Error("expected done");
    expect(done.report.skipped_idempotent).toBe(1);
    expect(done.report.succeeded).toBe(1);
    // skipped items surface in items with stable input_index
    expect(done.report.items.map((i) => ({ i: i.input_index, s: i.state }))).toEqual([
      { i: 0, s: "skipped_idempotent" },
      { i: 1, s: "done" },
    ]);
  });

  it("missing prior_state with declared idempotency is a hard error", () => {
    const c = makeConnector({
      idempotency: {
        key: [{ from: "task.title" }],
        read_via: "list_tasks",
      },
    });
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();
    expect(() =>
      runner.start({
        connector: c,
        action: a,
        input: { tasks: [{ title: "a" }] },
      })
    ).toThrow(/prior_state/);
  });
});

describe("PR4 — failure_mode", () => {
  it("fail_fast aborts remaining items as not_run", () => {
    const c = makeConnector({
      failure_mode: "fail_fast",
    });
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "a" }, { title: "b" }, { title: "c" }] },
    });
    const step = runner.nextStep(summary.batch_id);
    if (step.kind !== "step") throw new Error("expected step");
    runner.complete(summary.batch_id, {
      item_token: step.item_token,
      status: "failed",
      error_code: "click_failed",
      error_summary: "Button not found",
    });
    const done = runner.nextStep(summary.batch_id);
    if (done.kind !== "done") throw new Error("expected done");
    expect(done.report.aborted).toBe(true);
    expect(done.report.failed).toBe(1);
    expect(done.report.not_run).toBe(2);
    expect(done.report.items[1].state).toBe("not_run");
    expect(done.report.items[2].state).toBe("not_run");
    expect(done.report.items[0].error_code).toBe("click_failed");
  });

  it("continue keeps advancing past failures", () => {
    const c = makeConnector({ failure_mode: "continue" });
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "a" }, { title: "b" }] },
    });
    const s0 = runner.nextStep(summary.batch_id);
    if (s0.kind !== "step") throw new Error("unreachable");
    runner.complete(summary.batch_id, { item_token: s0.item_token, status: "failed" });
    const s1 = runner.nextStep(summary.batch_id);
    if (s1.kind !== "step") throw new Error("unreachable");
    runner.complete(summary.batch_id, { item_token: s1.item_token, status: "ok" });
    const done = runner.nextStep(summary.batch_id);
    if (done.kind !== "done") throw new Error("unreachable");
    expect(done.report.aborted).toBe(false);
    expect(done.report.succeeded).toBe(1);
    expect(done.report.failed).toBe(1);
  });
});

describe("PR4 — verify interleaving", () => {
  it("per-item verify runs right after mutate", () => {
    const c = makeConnector({
      verify: [{ phase: "verify", instructions: "check {{task.title}} exists" }],
    });
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "a" }] },
    });
    // Phase 1: mutate
    const s1 = runner.nextStep(summary.batch_id);
    if (s1.kind !== "step") throw new Error("unreachable");
    expect(s1.phase).toBe("mutate");
    runner.complete(summary.batch_id, { item_token: s1.item_token, status: "ok" });
    // Phase 2: verify for the SAME item_index
    const s2 = runner.nextStep(summary.batch_id);
    if (s2.kind !== "step") throw new Error("unreachable");
    expect(s2.phase).toBe("verify");
    expect(s2.input_index).toBe(0);
    expect(s2.rendered_steps[0].instructions).toBe("check a exists");
    runner.complete(summary.batch_id, { item_token: s2.item_token, status: "ok" });
    const done = runner.nextStep(summary.batch_id);
    if (done.kind !== "done") throw new Error("unreachable");
    expect(done.report.succeeded).toBe(1);
  });

  it("verify_failed is tracked separately in the report", () => {
    const c = makeConnector({
      verify: [{ phase: "verify", instructions: "check" }],
      failure_mode: "continue",
    });
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "a" }] },
    });
    const s1 = runner.nextStep(summary.batch_id);
    if (s1.kind !== "step") throw new Error("unreachable");
    runner.complete(summary.batch_id, { item_token: s1.item_token, status: "ok" });
    const s2 = runner.nextStep(summary.batch_id);
    if (s2.kind !== "step") throw new Error("unreachable");
    runner.complete(summary.batch_id, {
      item_token: s2.item_token,
      status: "verify_failed",
      error_code: "not_on_board",
    });
    const done = runner.nextStep(summary.batch_id);
    if (done.kind !== "done") throw new Error("unreachable");
    expect(done.report.verify_failed).toBe(1);
    expect(done.report.succeeded).toBe(0);
  });

  it("captured values are merged into bindings for verify templates", () => {
    const c = makeConnector({
      verify: [{ phase: "verify", instructions: "verify {{task_id}}" }],
    });
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "a" }] },
    });
    const s1 = runner.nextStep(summary.batch_id);
    if (s1.kind !== "step") throw new Error("unreachable");
    runner.complete(summary.batch_id, {
      item_token: s1.item_token,
      status: "ok",
      captured: { task_id: "T-123" },
    });
    const s2 = runner.nextStep(summary.batch_id);
    if (s2.kind !== "step") throw new Error("unreachable");
    expect(s2.rendered_steps[0].instructions).toBe("verify T-123");
  });
});

describe("PR4 — destructive + requires_confirmation", () => {
  it("refuses to start without a confirmation_token", () => {
    const c = makeConnector({
      destructive: true,
      requires_confirmation: true,
    });
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();
    expect(() =>
      runner.start({
        connector: c,
        action: a,
        input: { tasks: [{ title: "a" }] },
      })
    ).toThrow(/confirmation_token/);
  });

  it("accepts a confirmation_token", () => {
    const c = makeConnector({
      destructive: true,
      requires_confirmation: true,
    });
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "a" }] },
      confirmation_token: "user-said-yes",
    });
    expect(summary.confirmation_accepted).toBe(true);
  });
});

describe("PR4 — concurrency downgrade", () => {
  it("loudly downgrades concurrency > 1 to 1 with a warning", () => {
    const c = makeConnector({
      batch: { concurrency: 4, safe_parallel: true },
    });
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "a" }] },
    });
    expect(summary.concurrency_honored).toBe(1);
    expect(summary.concurrency_downgraded).toBe(true);
    expect(summary.warnings.some((w) => /downgraded to 1/.test(w))).toBe(true);
  });
});

describe("PR4 — TTL + expiry", () => {
  it("expired batches reject further operations", () => {
    let now = 1000;
    const runner = new BatchRunner({ ttlMs: 100, now: () => now });
    const c = makeConnector();
    const a = mutationOf(c, "create_tasks");
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "a" }] },
    });
    now += 1000; // well past TTL
    expect(() => runner.nextStep(summary.batch_id)).toThrow(/expired/);
  });

  it("reapExpired GCs stale batches", () => {
    let now = 1000;
    const runner = new BatchRunner({ ttlMs: 100, now: () => now });
    const c = makeConnector();
    const a = mutationOf(c, "create_tasks");
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "a" }] },
    });
    now += 1000;
    const reaped = runner.reapExpired();
    expect(reaped).toContain(summary.batch_id);
  });
});

describe("PR4 — error sanitisation", () => {
  it("error_summary is trimmed + truncated", () => {
    const c = makeConnector({ failure_mode: "continue" });
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "a" }] },
    });
    const step = runner.nextStep(summary.batch_id);
    if (step.kind !== "step") throw new Error("unreachable");
    const long = "x".repeat(500);
    runner.complete(summary.batch_id, {
      item_token: step.item_token,
      status: "failed",
      error_summary: "  \n\nwhitespace   noise   " + long,
    });
    const done = runner.nextStep(summary.batch_id);
    if (done.kind !== "done") throw new Error("unreachable");
    const err = done.report.items[0].error_summary!;
    expect(err.length).toBeLessThanOrEqual(240);
    expect(err).toMatch(/^whitespace noise/);
    expect(err.endsWith("...")).toBe(true);
  });

  it("error_code is sanitised to [a-zA-Z0-9_.-]+", () => {
    const c = makeConnector({ failure_mode: "continue" });
    const a = mutationOf(c, "create_tasks");
    const runner = new BatchRunner();
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: { tasks: [{ title: "a" }] },
    });
    const step = runner.nextStep(summary.batch_id);
    if (step.kind !== "step") throw new Error("unreachable");
    runner.complete(summary.batch_id, {
      item_token: step.item_token,
      status: "failed",
      error_code: "click failed: #btn > span",
    });
    const done = runner.nextStep(summary.batch_id);
    if (done.kind !== "done") throw new Error("unreachable");
    expect(done.report.items[0].error_code).toBe("click_failed___btn___span");
  });
});

describe("PR4 — batch_id unknown", () => {
  it("throws batch_not_found", () => {
    const runner = new BatchRunner();
    expect(() => runner.nextStep("does-not-exist")).toThrow(/not found/);
  });
});
