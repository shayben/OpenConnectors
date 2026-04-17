/**
 * PR4b — Sweep state machine.
 *
 * Validates the sweep contract: targets snapshot → drain → refresh
 * → next pass, with termination on empty refresh, max_passes, or
 * zero-progress fixed-point.
 */

import { describe, it, expect } from "vitest";
import { ConnectorSchema, type MutationAction } from "../connector-schema.js";
import { BatchRunner } from "../batch-runner.js";

function makeSweepConnector(opts: {
  until_empty?: boolean;
  max_passes?: number;
  refresh_between_passes?: boolean;
} = {}) {
  return ConnectorSchema.parse({
    id: "test-sweep",
    name: "Test Sweep",
    description: "x",
    version: "1.0.0",
    author: "x",
    institution: { name: "T", url: "https://example.com", country: "US" },
    auth: { type: "persistent_profile", profile_id: "p" },
    actions: [
      {
        kind: "fetch",
        name: "list_targets",
        description: "list",
        steps: [{ phase: "navigate", instructions: "go" }],
      },
      {
        kind: "mutation",
        name: "delete_all",
        description: "wipe",
        destructive: true,
        input_schema: "EmptyInput",
        sweep: {
          targets_from: "list_targets",
          as: "target",
          ...(opts.until_empty !== undefined && { until_empty: opts.until_empty }),
          ...(opts.max_passes !== undefined && { max_passes: opts.max_passes }),
          ...(opts.refresh_between_passes !== undefined && {
            refresh_between_passes: opts.refresh_between_passes,
          }),
        },
        steps: [{ phase: "mutate", instructions: "Delete {{target.id}}" }],
      },
    ],
  });
}

function mutationOf(c: ReturnType<typeof makeSweepConnector>, name: string): MutationAction {
  const a = c.actions.find((x) => x.name === name);
  if (!a || a.kind !== "mutation") throw new Error("not a mutation");
  return a;
}

function drainPass(runner: BatchRunner, batchId: string): {
  consumed: number;
  terminal: ReturnType<BatchRunner["nextStep"]>;
} {
  let consumed = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = runner.nextStep(batchId);
    if (step.kind !== "step") return { consumed, terminal: step };
    runner.complete(batchId, { item_token: step.item_token, status: "ok" });
    consumed++;
  }
}

describe("PR4b — sweep happy path", () => {
  it("targets → drain → empty refresh → done with passes_completed=1", () => {
    const c = makeSweepConnector();
    const a = mutationOf(c, "delete_all");
    const runner = new BatchRunner();

    const t0 = 1000;
    const { summary } = runner.start({
      connector: c,
      action: a,
      input: {},
      sweep_targets: [{ id: "a" }, { id: "b" }, { id: "c" }],
      sweep_targets_collected_at: t0,
    });
    expect(summary.total_planned).toBe(3);
    expect(summary.sweep_pass).toBe(1);
    expect(summary.sweep_max_passes).toBe(5);

    const { consumed, terminal } = drainPass(runner, summary.batch_id);
    expect(consumed).toBe(3);
    expect(terminal.kind).toBe("refresh_required");
    if (terminal.kind !== "refresh_required") throw new Error("unreachable");
    expect(terminal.pass).toBe(1);
    expect(terminal.reason).toBe("sweep_pass_complete");

    const advance = runner.advanceSweepPass(summary.batch_id, [], t0 + 1);
    expect(advance.advanced).toBe(true);
    expect(advance.complete).toBe(true);
    expect(advance.planned).toBe(0);

    const done = runner.nextStep(summary.batch_id);
    expect(done.kind).toBe("done");
    if (done.kind !== "done") throw new Error("unreachable");
    expect(done.report.succeeded).toBe(3);
    expect(done.report.failed).toBe(0);
    expect(done.report.aborted).toBe(false);
    expect(done.report.passes_completed).toBe(1);
    expect(done.report.final_pass_remaining).toBe(0);
  });

  it("two passes drain progressively to empty", () => {
    const c = makeSweepConnector();
    const a = mutationOf(c, "delete_all");
    const runner = new BatchRunner();

    const { summary } = runner.start({
      connector: c,
      action: a,
      input: {},
      sweep_targets: [{ id: "a" }, { id: "b" }],
      sweep_targets_collected_at: 1000,
    });

    // Pass 1
    expect(drainPass(runner, summary.batch_id).consumed).toBe(2);

    // Refresh still has 1 (e.g. UI lazy-loaded a new item we couldn't see initially).
    const adv1 = runner.advanceSweepPass(summary.batch_id, [{ id: "c" }], 2000);
    expect(adv1.advanced).toBe(true);
    expect(adv1.pass).toBe(2);
    expect(adv1.planned).toBe(1);

    // Pass 2
    const drain2 = drainPass(runner, summary.batch_id);
    expect(drain2.consumed).toBe(1);
    expect(drain2.terminal.kind).toBe("refresh_required");

    // Empty refresh → done
    runner.advanceSweepPass(summary.batch_id, [], 3000);
    const done = runner.nextStep(summary.batch_id);
    if (done.kind !== "done") throw new Error("expected done");
    expect(done.report.succeeded).toBe(3);
    expect(done.report.passes_completed).toBe(2);
    expect(done.report.final_pass_remaining).toBe(0);
    expect(done.report.aborted).toBe(false);
  });
});

describe("PR4b — sweep termination", () => {
  it("halts at max_passes (handleSweepPassEnd branch) with refresh still non-empty", () => {
    const c = makeSweepConnector({ max_passes: 2 });
    const a = mutationOf(c, "delete_all");
    const runner = new BatchRunner();

    const { summary } = runner.start({
      connector: c,
      action: a,
      input: {},
      sweep_targets: [{ id: "a" }],
      sweep_targets_collected_at: 1000,
    });

    // Pass 1
    drainPass(runner, summary.batch_id);
    runner.advanceSweepPass(summary.batch_id, [{ id: "b" }], 2000);
    // Pass 2 — final pass: handleSweepPassEnd sees sweepPass==max_passes
    // and halts without requesting another refresh.
    const drain2 = drainPass(runner, summary.batch_id);
    expect(drain2.terminal.kind).toBe("done");
    if (drain2.terminal.kind !== "done") throw new Error("unreachable");
    expect(drain2.terminal.report.aborted).toBe(true);
    expect(drain2.terminal.report.abort_reason).toMatch(/max_passes_reached/);
    expect(drain2.terminal.report.passes_completed).toBe(2);
    expect(drain2.terminal.report.succeeded).toBe(2);
  });

  it("halts on zero-progress fixed point (continue-on-failure + targets remain)", () => {
    const c = ConnectorSchema.parse({
      id: "test-sweep-zero",
      name: "Test Sweep Zero",
      description: "x",
      version: "1.0.0",
      author: "x",
      institution: { name: "T", url: "https://example.com", country: "US" },
      auth: { type: "persistent_profile", profile_id: "p" },
      actions: [
        {
          kind: "fetch",
          name: "list_targets",
          description: "list",
          steps: [{ phase: "navigate", instructions: "go" }],
        },
        {
          kind: "mutation",
          name: "delete_all",
          description: "wipe",
          destructive: true,
          input_schema: "EmptyInput",
          failure_mode: "continue",
          sweep: { targets_from: "list_targets", as: "target" },
          steps: [{ phase: "mutate", instructions: "Delete {{target.id}}" }],
        },
      ],
    });
    const a = mutationOf(c, "delete_all");
    const runner = new BatchRunner();

    const { summary } = runner.start({
      connector: c,
      action: a,
      input: {},
      sweep_targets: [{ id: "stuck" }],
      sweep_targets_collected_at: 1000,
    });

    // Fail the only item (continue-on-failure keeps the batch alive).
    const step = runner.nextStep(summary.batch_id);
    if (step.kind !== "step") throw new Error("expected step");
    runner.complete(summary.batch_id, {
      item_token: step.item_token,
      status: "failed",
      error_code: "click_blocked",
      error_summary: "modal stole focus",
    });

    const refresh = runner.nextStep(summary.batch_id);
    expect(refresh.kind).toBe("refresh_required");

    // World still shows the target — zero-progress halt fires.
    const adv = runner.advanceSweepPass(summary.batch_id, [{ id: "stuck" }], 2000);
    expect(adv.complete).toBe(true);
    expect(adv.planned).toBe(0);

    const done = runner.nextStep(summary.batch_id);
    if (done.kind !== "done") throw new Error("expected done");
    expect(done.report.aborted).toBe(true);
    expect(done.report.abort_reason).toBe("no_progress");
    expect(done.report.failed).toBe(1);
    expect(done.report.final_pass_remaining).toBe(1);
  });

  it("halts after one pass when until_empty=false", () => {
    const c = makeSweepConnector({ until_empty: false });
    const a = mutationOf(c, "delete_all");
    const runner = new BatchRunner();

    const { summary } = runner.start({
      connector: c,
      action: a,
      input: {},
      sweep_targets: [{ id: "a" }, { id: "b" }],
      sweep_targets_collected_at: 1000,
    });

    drainPass(runner, summary.batch_id);
    const done = runner.nextStep(summary.batch_id);
    expect(done.kind).toBe("done");
    if (done.kind !== "done") throw new Error("unreachable");
    expect(done.report.succeeded).toBe(2);
    expect(done.report.passes_completed).toBe(1);
    expect(done.report.aborted).toBe(false);
  });

  it("starts and immediately completes on an empty initial snapshot", () => {
    const c = makeSweepConnector();
    const a = mutationOf(c, "delete_all");
    const runner = new BatchRunner();

    const { summary } = runner.start({
      connector: c,
      action: a,
      input: {},
      sweep_targets: [],
      sweep_targets_collected_at: 1000,
    });
    expect(summary.total_planned).toBe(0);

    const done = runner.nextStep(summary.batch_id);
    expect(done.kind).toBe("done");
    if (done.kind !== "done") throw new Error("unreachable");
    expect(done.report.succeeded).toBe(0);
    expect(done.report.aborted).toBe(false);
    expect(done.report.final_pass_remaining).toBe(0);
  });
});

describe("PR4b — sweep input validation", () => {
  it("start() rejects a sweep action with no sweep_targets snapshot", () => {
    const c = makeSweepConnector();
    const a = mutationOf(c, "delete_all");
    const runner = new BatchRunner();

    expect(() =>
      runner.start({ connector: c, action: a, input: {} })
    ).toThrow(/sweep_targets/);
  });

  it("advance_sweep_pass rejects a stale snapshot", () => {
    const c = makeSweepConnector();
    const a = mutationOf(c, "delete_all");
    const runner = new BatchRunner();

    const { summary } = runner.start({
      connector: c,
      action: a,
      input: {},
      sweep_targets: [{ id: "a" }],
      sweep_targets_collected_at: 5000,
    });
    drainPass(runner, summary.batch_id);

    const stale = runner.advanceSweepPass(summary.batch_id, [], 4000);
    expect(stale.advanced).toBe(false);
    expect(stale.reason).toBe("snapshot_not_fresh");
  });

  it("advance_sweep_pass rejects calls before the current pass drains", () => {
    const c = makeSweepConnector();
    const a = mutationOf(c, "delete_all");
    const runner = new BatchRunner();

    const { summary } = runner.start({
      connector: c,
      action: a,
      input: {},
      sweep_targets: [{ id: "a" }, { id: "b" }],
      sweep_targets_collected_at: 1000,
    });
    // Lease but don't complete — pass is mid-flight.
    runner.nextStep(summary.batch_id);
    expect(() =>
      runner.advanceSweepPass(summary.batch_id, [], 2000)
    ).toThrow(/awaiting/);
  });
});
