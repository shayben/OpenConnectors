/**
 * PR1 — v1 schema smoke tests.
 *
 * These convert the `PR1 — schema extensions` todos from v1-primitives.todo.test.ts
 * into passing contracts.
 */

import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConnectorSchema,
  FetchActionSchema,
  MutationActionSchema,
  ActionSchema,
  InputSchemaRefSchema,
  IdempotencySpecSchema,
  BatchSpecSchema,
  AuthSchema,
} from "../connector-schema.js";
import { ConnectorLoader } from "../connector-loader.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoConnectors = resolve(here, "..", "..", "..", "..", "connectors");

// A minimal valid v1 mutation connector, built up piecewise in tests.
function baseV1Connector(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "test-connector",
    name: "Test",
    description: "A test connector",
    version: "1.0.0",
    author: "Tester",
    institution: {
      name: "Test",
      url: "https://example.com",
      country: "US",
    },
    auth: { type: "credentials", credentials: [] },
    actions: [
      {
        kind: "fetch",
        name: "list_items",
        description: "List items",
        steps: [{ phase: "navigate", instructions: "Go to list" }],
      },
    ],
    ...overrides,
  };
}

// -------------------- v0.1 backward-compat --------------------

describe("PR1 — v0.1 backward compat (preprocess)", () => {
  it("parses a v0.1 YAML without `kind` as `kind: fetch`", () => {
    const v01 = {
      id: "v01",
      name: "V01",
      description: "x",
      version: "0.1.0",
      author: "x",
      institution: { name: "V01", url: "https://a.com", country: "US" },
      credentials: [{ key: "user", label: "User" }],
      actions: [
        {
          name: "fetch_x",
          description: "x",
          steps: [{ phase: "navigate", instructions: "go" }],
        },
      ],
    };
    const parsed = ConnectorSchema.parse(v01);
    expect(parsed.actions[0].kind).toBe("fetch");
  });

  it("synthesizes `auth` from top-level `credentials`", () => {
    const v01 = {
      id: "v01",
      name: "V01",
      description: "x",
      version: "0.1.0",
      author: "x",
      institution: { name: "V01", url: "https://a.com", country: "US" },
      credentials: [{ key: "user", label: "User" }],
      actions: [
        { name: "a", description: "a", steps: [{ phase: "navigate", instructions: "go" }] },
      ],
    };
    const parsed = ConnectorSchema.parse(v01);
    expect(parsed.auth.type).toBe("credentials");
    if (parsed.auth.type === "credentials") {
      expect(parsed.auth.credentials).toHaveLength(1);
      expect(parsed.auth.credentials[0].key).toBe("user");
    }
    // Legacy mirror still readable.
    expect(parsed.credentials.map((c) => c.key)).toEqual(["user"]);
  });

  it("hard-errors when both top-level `credentials` and `auth` are declared", () => {
    const bad = {
      id: "bad",
      name: "Bad",
      description: "x",
      version: "1.0.0",
      author: "x",
      institution: { name: "Bad", url: "https://a.com", country: "US" },
      credentials: [{ key: "x", label: "X" }],
      auth: { type: "credentials", credentials: [] },
      actions: [
        { kind: "fetch", name: "a", description: "a", steps: [{ phase: "navigate", instructions: "go" }] },
      ],
    };
    expect(() => ConnectorSchema.parse(bad)).toThrow(/EITHER top-level `credentials` OR `auth`/);
  });

  it("strips dead `output_types` field if present", () => {
    const withDead = { ...baseV1Connector(), output_types: "Foo" };
    const parsed = ConnectorSchema.parse(withDead);
    expect("output_types" in parsed).toBe(false);
  });

  it("all 6 existing v0.1 connectors still load", async () => {
    const loader = new ConnectorLoader({ dir: repoConnectors });
    const all = await loader.list();
    const ids = all.map((l) => l.connector.id);
    for (const id of [
      "esop-excellence",
      "harel-pension",
      "menora-pension",
      "migdal-pension",
      "mizrahi-bank",
      "pension-more",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("v1 connectors (microsoft-planner, azure-devops) now load under the new schema", async () => {
    const loader = new ConnectorLoader({ dir: repoConnectors });
    const all = await loader.list();
    const ids = all.map((l) => l.connector.id);
    expect(ids).toContain("microsoft-planner");
    expect(ids).toContain("azure-devops");
  });
});

// -------------------- .strict() enforcement --------------------

describe("PR1 — .strict() on action schemas", () => {
  it("FetchActionSchema rejects extra keys (`rollback_policy`)", () => {
    const result = FetchActionSchema.safeParse({
      kind: "fetch",
      name: "fx",
      description: "x",
      rollback_policy: "none",
      steps: [{ phase: "navigate", instructions: "go" }],
    });
    expect(result.success).toBe(false);
  });

  it("MutationActionSchema rejects a misspelled `forEach`", () => {
    const result = MutationActionSchema.safeParse({
      kind: "mutation",
      name: "mx",
      description: "x",
      input_schema: "TaskBatch",
      forEach: "{{input.tasks}}",
      steps: [{ phase: "mutate", instructions: "create" }],
    });
    expect(result.success).toBe(false);
  });

  it("MutationActionSchema requires `input_schema` (no silent default)", () => {
    const result = MutationActionSchema.safeParse({
      kind: "mutation",
      name: "mx",
      description: "x",
      steps: [{ phase: "mutate", instructions: "create" }],
    });
    expect(result.success).toBe(false);
  });
});

// -------------------- Refines --------------------

describe("PR1 — refines", () => {
  it("mutation with `for_each` without `as` fails parse", () => {
    const bad = baseV1Connector({
      actions: [
        {
          kind: "fetch",
          name: "list_items",
          description: "x",
          steps: [{ phase: "navigate", instructions: "go" }],
        },
        {
          kind: "mutation",
          name: "create_items",
          description: "x",
          input_schema: "TaskBatch",
          for_each: "{{input.tasks}}",
          steps: [{ phase: "mutate", instructions: "create" }],
        },
      ],
    });
    const result = ConnectorSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/for_each.*requires.*as/i);
  });

  it("action with both `for_each` and `sweep` fails parse", () => {
    const bad = baseV1Connector({
      actions: [
        {
          kind: "fetch",
          name: "list_items",
          description: "x",
          steps: [{ phase: "navigate", instructions: "go" }],
        },
        {
          kind: "mutation",
          name: "mix",
          description: "x",
          input_schema: "TaskBatch",
          for_each: "{{input.tasks}}",
          as: "task",
          sweep: { targets_from: "list_items", as: "task" },
          steps: [{ phase: "mutate", instructions: "do" }],
        },
      ],
    });
    const result = ConnectorSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("batch.concurrency > 1 without safe_parallel fails", () => {
    const result = BatchSpecSchema.safeParse({ concurrency: 4, safe_parallel: false });
    expect(result.success).toBe(false);
  });

  it("batch.concurrency > 1 with safe_parallel: true parses", () => {
    const result = BatchSpecSchema.safeParse({ concurrency: 4, safe_parallel: true });
    expect(result.success).toBe(true);
  });
});

// -------------------- input_schema 3 arms --------------------

describe("PR1 — input_schema arms", () => {
  it("bare string (`TaskBatch`) parses", () => {
    expect(InputSchemaRefSchema.safeParse("TaskBatch").success).toBe(true);
  });

  it("`{ extends: 'TaskDraft', fields, supports }` parses", () => {
    const res = InputSchemaRefSchema.safeParse({
      extends: "TaskDraft",
      fields: { id: { type: "integer" } },
      supports: ["title", "bucket"],
      unsupported_fields: "warn",
    });
    expect(res.success).toBe(true);
  });

  it("`{ extends: 42 }` is rejected (not coerced to inline arm)", () => {
    const res = InputSchemaRefSchema.safeParse({ extends: 42 });
    expect(res.success).toBe(false);
  });

  it("v0.1 inline `{ type, properties, required }` still parses", () => {
    const res = InputSchemaRefSchema.safeParse({
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
    });
    expect(res.success).toBe(true);
  });
});

// -------------------- Cross-ref superRefine --------------------

describe("PR1 — connector-level cross-refs", () => {
  it("idempotency.read_via referencing an unknown action fails", () => {
    const bad = baseV1Connector({
      actions: [
        {
          kind: "fetch",
          name: "list_items",
          description: "x",
          steps: [{ phase: "navigate", instructions: "go" }],
        },
        {
          kind: "mutation",
          name: "create_items",
          description: "x",
          input_schema: "TaskBatch",
          for_each: "{{input.tasks}}",
          as: "task",
          idempotency: {
            key: [{ from: "task.title" }],
            read_via: "nonexistent_list",
          },
          steps: [{ phase: "mutate", instructions: "create" }],
        },
      ],
    });
    const result = ConnectorSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/read_via.*unknown fetch action/);
  });

  it("idempotency.read_via pointing at a mutation (not fetch) fails", () => {
    const bad = baseV1Connector({
      actions: [
        {
          kind: "mutation",
          name: "also_mutation",
          description: "x",
          input_schema: "X",
          steps: [{ phase: "mutate", instructions: "m" }],
        },
        {
          kind: "mutation",
          name: "create_items",
          description: "x",
          input_schema: "TaskBatch",
          for_each: "{{input.tasks}}",
          as: "task",
          idempotency: {
            key: [{ from: "task.title" }],
            read_via: "also_mutation",
          },
          steps: [{ phase: "mutate", instructions: "create" }],
        },
      ],
    });
    const result = ConnectorSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("sweep.targets_from pointing at an unknown action fails", () => {
    const bad = baseV1Connector({
      actions: [
        {
          kind: "fetch",
          name: "list_items",
          description: "x",
          steps: [{ phase: "navigate", instructions: "go" }],
        },
        {
          kind: "mutation",
          name: "delete_all",
          description: "x",
          input_schema: { type: "object" },
          destructive: true,
          sweep: { targets_from: "nope", as: "task" },
          steps: [{ phase: "mutate", instructions: "delete" }],
        },
      ],
    });
    const result = ConnectorSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/targets_from.*unknown fetch action/);
  });

  it("duplicate action names fail parse", () => {
    const bad = baseV1Connector({
      actions: [
        {
          kind: "fetch",
          name: "list_items",
          description: "x",
          steps: [{ phase: "navigate", instructions: "go" }],
        },
        {
          kind: "fetch",
          name: "list_items",
          description: "x",
          steps: [{ phase: "navigate", instructions: "go" }],
        },
      ],
    });
    const result = ConnectorSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/Duplicate action name/);
  });
});

// -------------------- Auth variants --------------------

describe("PR1 — auth discriminated union", () => {
  it("persistent_profile auth parses with required profile_id", () => {
    const res = AuthSchema.safeParse({ type: "persistent_profile", profile_id: "m365" });
    expect(res.success).toBe(true);
  });

  it("persistent_profile without profile_id fails", () => {
    const res = AuthSchema.safeParse({ type: "persistent_profile" });
    expect(res.success).toBe(false);
  });

  it("any_of wraps exactly the other two arms (not recursive)", () => {
    const res = AuthSchema.safeParse({
      type: "any_of",
      options: [
        { type: "persistent_profile", profile_id: "aad" },
        { type: "credentials", credentials: [{ key: "pat", label: "PAT", type: "password" }] },
      ],
    });
    expect(res.success).toBe(true);
  });

  it("any_of nested inside any_of is rejected (non-recursive)", () => {
    const res = AuthSchema.safeParse({
      type: "any_of",
      options: [
        { type: "any_of", options: [] },
        { type: "credentials", credentials: [] },
      ],
    });
    expect(res.success).toBe(false);
  });
});

// -------------------- Step refine --------------------

describe("PR1 — step shape", () => {
  it("step with neither instructions nor navigate_by_labels nor dismiss_if_present fails", () => {
    const bad = ActionSchema.safeParse({
      kind: "fetch",
      name: "f",
      description: "x",
      steps: [{ phase: "navigate" }],
    });
    expect(bad.success).toBe(false);
  });

  it("new phases `mutate` and `verify` are accepted", () => {
    const ok = ActionSchema.safeParse({
      kind: "mutation",
      name: "m",
      description: "x",
      input_schema: "X",
      steps: [{ phase: "mutate", instructions: "do" }],
      verify: [{ phase: "verify", instructions: "check" }],
    });
    expect(ok.success).toBe(true);
  });

  it("navigate_by_labels with click_action: right_click parses", () => {
    const ok = ActionSchema.safeParse({
      kind: "mutation",
      name: "m",
      description: "x",
      input_schema: "X",
      steps: [
        {
          phase: "mutate",
          navigate_by_labels: [{ label: "Delete", click_action: "right_click" }],
        },
      ],
    });
    expect(ok.success).toBe(true);
  });
});

// -------------------- Idempotency key parts --------------------

describe("PR1 — idempotency key parts", () => {
  it("field key part parses with normalizers", () => {
    const res = IdempotencySpecSchema.safeParse({
      key: [{ from: "task.title", normalize: ["lower", "trim", "nfc"] }],
      read_via: "list_tasks",
    });
    expect(res.success).toBe(true);
  });

  it("literal key part parses", () => {
    const res = IdempotencySpecSchema.safeParse({
      key: [{ from: "task.title" }, { literal: "|" }, { from: "task.bucket" }],
      read_via: "list_tasks",
    });
    expect(res.success).toBe(true);
  });

  it("on_conflict: update is rejected (deferred to v1.1)", () => {
    const res = IdempotencySpecSchema.safeParse({
      key: [{ from: "x" }],
      read_via: "y",
      on_conflict: "update",
    });
    expect(res.success).toBe(false);
  });

  it("unknown normalizer is rejected", () => {
    const res = IdempotencySpecSchema.safeParse({
      key: [{ from: "x", normalize: ["bogus"] }],
      read_via: "y",
    });
    expect(res.success).toBe(false);
  });
});
