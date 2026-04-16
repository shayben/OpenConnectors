/**
 * PR8 — reference connectors schema-validate under v1.
 *
 * These tests prove the abstraction is complete by loading the real
 * reference YAMLs (Planner + ADO + Mizrahi regression) and asserting a few
 * specific invariants from the v1 design doc. They also exercise the
 * preview-render path on the Planner connector end-to-end.
 */

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { ConnectorSchema } from "../connector-schema.js";
import { runPreview } from "../preview.js";

const here = dirname(fileURLToPath(import.meta.url));
const connectorsDir = join(here, "..", "..", "..", "..", "connectors");

function loadConnector(file: string) {
  const text = readFileSync(join(connectorsDir, file), "utf-8");
  const raw = yaml.load(text) as unknown;
  return ConnectorSchema.parse(raw);
}

describe("PR8 — reference connectors", () => {
  test("microsoft-planner.yaml schema-validates under v1", () => {
    const c = loadConnector("microsoft-planner.yaml");
    expect(c.id).toBe("microsoft-planner");
    expect(c.auth.type).toBe("persistent_profile");
    // Has both a fetch and ≥1 mutation action.
    const kinds = new Set(c.actions.map((a) => a.kind));
    expect(kinds.has("fetch")).toBe(true);
    expect(kinds.has("mutation")).toBe(true);
  });

  test("azure-devops.yaml schema-validates under v1", () => {
    const c = loadConnector("azure-devops.yaml");
    expect(c.id).toBe("azure-devops");
    expect(c.actions.length).toBeGreaterThan(0);
  });

  test("azure-devops.yaml references IssueDraftBatch in the bulk-create action", () => {
    const c = loadConnector("azure-devops.yaml");
    const createAction = c.actions.find(
      (a) => a.kind === "mutation" && a.name === "create_work_items_from_batch"
    );
    expect(createAction).toBeDefined();
    const input = createAction!.input_schema as unknown;
    const referencesIssueDraftBatch =
      input === "IssueDraftBatch" ||
      (typeof input === "object" &&
        input !== null &&
        "extends" in input &&
        (input as { extends?: unknown }).extends === "IssueDraftBatch");
    expect(referencesIssueDraftBatch).toBe(true);
  });

  test("azure-devops.yaml update_work_item has `org` in its input schema", () => {
    const c = loadConnector("azure-devops.yaml");
    const upd = c.actions.find((a) => a.name === "update_work_item");
    expect(upd).toBeDefined();
    // In the `extends` form, extra connector-specific fields live under
    // `fields`; in the v0.1 inline form they live under `properties`.
    const input = upd!.input_schema as Record<string, unknown>;
    const fields = (input.fields ?? input.properties) as
      | Record<string, unknown>
      | undefined;
    expect(fields).toBeDefined();
    expect(fields).toHaveProperty("org");
  });

  test("microsoft-planner.yaml preview renders expected text for a 2-item input", () => {
    const c = loadConnector("microsoft-planner.yaml");
    const action = c.actions.find((a) => a.name === "create_tasks_from_batch")!;
    const input = {
      tasks: [
        { title: "First task", bucket: "Development" },
        { title: "Second task", bucket: "QA" },
      ],
    };
    const preview = runPreview({ connector: c, action, input });
    expect(preview.item_count_estimate).toBe(2);
    // The plan must mention the iteration count and echo the YAML template
    // line so the agent can see what will be emitted per item.
    const joined = preview.plan.join("\n");
    expect(joined).toContain("2 item(s)");
    expect(joined).toContain("Would create task");
    expect(joined).toContain("{{task.title}}");
  });

  test("mizrahi-bank.yaml (v0.1 regression anchor) still loads unchanged", () => {
    const c = loadConnector("mizrahi-bank.yaml");
    expect(c.id).toBe("mizrahi-bank");
    // v0.1 shape defaulted to auth.type='credentials' and action.kind='fetch'.
    expect(c.auth.type).toBe("credentials");
    for (const a of c.actions) expect(a.kind).toBe("fetch");
  });
});

describe("Cross-cutting — loader / superRefine invariants", () => {
  test("LearnEntry with unknown `kind` is filtered with a warning", async () => {
    // Delegated to learning.ts::loadLearning path — we just re-prove the
    // predicate: invalid entries do NOT crash the loader (see pr1-schema
    // forward-compat tests for the warn path).
    const { LearnEntrySchema } = await import("../learning.js");
    const bogus = { kind: "future_kind_v2", whatever: true };
    const r = LearnEntrySchema.safeParse(bogus);
    expect(r.success).toBe(false);
  });

  test("ConnectorSchema.superRefine: every `read_via` references an existing fetch action", () => {
    // A mutation action with an unresolvable read_via must fail parse.
    const broken = {
      id: "x",
      name: "X",
      description: "X",
      version: "0.1.0",
      author: "t",
      license: "MIT",
      institution: {
        name: "X",
        url: "https://x.example.com",
        country: "IL",
        locale: "en-US",
        timezone: "UTC",
      },
      auth: { type: "credentials", credentials: [] },
      actions: [
        {
          name: "create_things",
          kind: "mutation",
          description: "x",
          input_schema: { type: "object", properties: {} },
          idempotency: {
            read_via: "list_things_that_does_not_exist",
            key: [{ literal: "x" }],
          },
          steps: [{ phase: "mutate", instructions: "do it" }],
        },
      ],
    };
    expect(() => ConnectorSchema.parse(broken)).toThrow();
  });

  test("ConnectorSchema.superRefine: every `sweep.targets_from` references an existing fetch action", () => {
    const broken = {
      id: "x",
      name: "X",
      description: "X",
      version: "0.1.0",
      author: "t",
      license: "MIT",
      institution: {
        name: "X",
        url: "https://x.example.com",
        country: "IL",
        locale: "en-US",
        timezone: "UTC",
      },
      auth: { type: "credentials", credentials: [] },
      actions: [
        {
          name: "delete_things",
          kind: "mutation",
          description: "x",
          input_schema: { type: "object", properties: {} },
          sweep: { targets_from: "no_such_action", max_passes: 3 },
          steps: [{ phase: "mutate", instructions: "do it" }],
        },
      ],
    };
    expect(() => ConnectorSchema.parse(broken)).toThrow();
  });
});
