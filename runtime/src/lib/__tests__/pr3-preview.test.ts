/**
 * PR3 — mutation surface (run_preview, describe_only, run_mutation stub).
 */

import { describe, it, expect } from "vitest";
import { ConnectorSchema } from "../connector-schema.js";
import { runPreview } from "../preview.js";

function makeConnector(actionOverride: Record<string, unknown>) {
  return ConnectorSchema.parse({
    id: "test-mut",
    name: "Test Mutation",
    description: "x",
    version: "1.0.0",
    author: "x",
    institution: { name: "T", url: "https://example.com", country: "US" },
    auth: { type: "persistent_profile", profile_id: "p" },
    actions: [
      {
        kind: "fetch",
        name: "list_items",
        description: "list",
        steps: [{ phase: "navigate", instructions: "go" }],
      },
      {
        kind: "mutation",
        name: "create_items",
        description: "create items",
        input_schema: "TaskBatch",
        steps: [{ phase: "mutate", instructions: "do" }],
        ...actionOverride,
      },
    ],
  });
}

describe("PR3 — get_connector action summary", () => {
  it("mutation actions surface preview/verify/destructive/idempotency as structured fields", () => {
    const c = makeConnector({
      destructive: true,
      requires_confirmation: true,
      for_each: "{{input.tasks}}",
      as: "task",
      idempotency: {
        key: [{ from: "task.title" }, { literal: "|" }, { from: "task.bucket" }],
        read_via: "list_items",
      },
      preview: { mode: "describe_only", emit: ["Would create {{task.title}}"] },
      verify: [{ phase: "verify", instructions: "look for card" }],
      steps: [{ phase: "mutate", instructions: "create" }],
    });
    const a = c.actions.find((x) => x.name === "create_items")!;
    expect(a.kind).toBe("mutation");
    if (a.kind !== "mutation") throw new Error("unreachable");
    expect(a.destructive).toBe(true);
    expect(a.requires_confirmation).toBe(true);
    expect(a.preview?.emit).toHaveLength(1);
    expect(a.verify).toHaveLength(1);
    expect(a.idempotency?.key).toHaveLength(3);
  });
});

describe("PR3 — run_preview", () => {
  it("returns describe_only without touching any browser (pure function)", () => {
    const c = makeConnector({
      preview: { mode: "describe_only", emit: ["Would create item"] },
    });
    const a = c.actions.find((x) => x.name === "create_items")!;
    if (a.kind !== "mutation") throw new Error("unreachable");
    const report = runPreview({ action: a, connector: c });
    expect(report.connector_id).toBe("test-mut");
    expect(report.action).toBe("create_items");
    expect(report.describe_only).toBe("Would create item");
    expect(report.plan.join("\n")).toMatch(/Would create item/);
  });

  it("counts for_each items when input array is provided", () => {
    const c = makeConnector({
      for_each: "{{input.tasks}}",
      as: "task",
      steps: [{ phase: "mutate", instructions: "create" }],
    });
    const a = c.actions.find((x) => x.name === "create_items")!;
    if (a.kind !== "mutation") throw new Error("unreachable");
    const report = runPreview({
      action: a,
      connector: c,
      input: { tasks: [{ title: "a" }, { title: "b" }, { title: "c" }] },
    });
    expect(report.item_count_estimate).toBe(3);
    expect(report.plan.some((line) => /3 item/.test(line))).toBe(true);
  });

  it("surfaces destructive prominently (warning + plan line)", () => {
    const c = makeConnector({
      destructive: true,
      preview: { mode: "describe_only", emit: ["Would wipe"] },
    });
    const a = c.actions.find((x) => x.name === "create_items")!;
    if (a.kind !== "mutation") throw new Error("unreachable");
    const report = runPreview({ action: a, connector: c });
    expect(report.warnings).toContain("destructive");
    expect(report.plan.some((line) => /DESTRUCTIVE/.test(line))).toBe(true);
  });

  it("surfaces requires_confirmation independently of destructive", () => {
    const c = makeConnector({
      destructive: false,
      requires_confirmation: true,
      preview: { mode: "describe_only", emit: ["x"] },
    });
    const a = c.actions.find((x) => x.name === "create_items")!;
    if (a.kind !== "mutation") throw new Error("unreachable");
    const report = runPreview({ action: a, connector: c });
    expect(report.destructive).toBe(false);
    expect(report.requires_confirmation).toBe(true);
    expect(report.warnings).toContain("requires_confirmation");
  });

  it("warns when a batch has no idempotency declared", () => {
    const c = makeConnector({
      for_each: "{{input.tasks}}",
      as: "task",
      steps: [{ phase: "mutate", instructions: "create" }],
    });
    const a = c.actions.find((x) => x.name === "create_items")!;
    if (a.kind !== "mutation") throw new Error("unreachable");
    const report = runPreview({
      action: a,
      connector: c,
      input: { tasks: [{ title: "a" }] },
    });
    expect(report.warnings).toContain("no_idempotency_on_batch");
  });

  it("throws when passed a fetch action (guard)", () => {
    const c = makeConnector({});
    const fetchAction = c.actions.find((x) => x.name === "list_items")!;
    expect(() => runPreview({ action: fetchAction, connector: c })).toThrow(
      /only valid for mutation/
    );
  });

  it("item_count_estimate is null when for_each input is missing", () => {
    const c = makeConnector({
      for_each: "{{input.tasks}}",
      as: "task",
      steps: [{ phase: "mutate", instructions: "x" }],
    });
    const a = c.actions.find((x) => x.name === "create_items")!;
    if (a.kind !== "mutation") throw new Error("unreachable");
    const report = runPreview({ action: a, connector: c });
    expect(report.item_count_estimate).toBeNull();
    expect(report.warnings).toContain("for_each_input_missing");
  });

  it("includes idempotency summary in plan", () => {
    const c = makeConnector({
      for_each: "{{input.tasks}}",
      as: "task",
      idempotency: {
        key: [{ from: "task.title" }, { literal: "|" }, { from: "task.bucket" }],
        read_via: "list_items",
      },
      steps: [{ phase: "mutate", instructions: "x" }],
    });
    const a = c.actions.find((x) => x.name === "create_items")!;
    if (a.kind !== "mutation") throw new Error("unreachable");
    const report = runPreview({
      action: a,
      connector: c,
      input: { tasks: [{ title: "x", bucket: "y" }] },
    });
    const idemLine = report.plan.find((l) => /Idempotency:/.test(l));
    expect(idemLine).toBeDefined();
    expect(idemLine).toMatch(/read_via 'list_items'/);
    expect(idemLine).toMatch(/on_conflict = skip/);
    expect(report.warnings).not.toContain("no_idempotency_on_batch");
  });

  it("includes verify step count in plan", () => {
    const c = makeConnector({
      preview: { mode: "describe_only", emit: ["x"] },
      verify: [
        { phase: "verify", instructions: "v1" },
        { phase: "verify", instructions: "v2" },
      ],
    });
    const a = c.actions.find((x) => x.name === "create_items")!;
    if (a.kind !== "mutation") throw new Error("unreachable");
    const report = runPreview({ action: a, connector: c });
    expect(report.plan.some((l) => /2 verify step/.test(l))).toBe(true);
  });
});
