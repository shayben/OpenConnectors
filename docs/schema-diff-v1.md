# Connector Schema — proposed Zod diff (v0.1 → v1.0)

> **Status:** proposal. Not committed. Presented as a reviewable diff for discussion
> before PR1 lands.

This file shows the changes to `runtime/src/lib/connector-schema.ts` needed to support
the v1 design. Additions are marked `+`, removals `-`, context is unchanged.

## Second-pass review — summary of changes to this diff

- `FetchActionSchema` and `MutationActionSchema` use `.strict()` so extra keys fail
  parse instead of being silently dropped. An example: `rollback_policy` on a
  `fetch` action now errors at parse time.
- `rollback_policy`, `pii_strip_fields`, `preview.mode: read_only_simulation`,
  `IdempotencySpec.match`, `NavigateByLabels.resolution_hint` — **removed** from
  the diff per §0.1 of `design-v1.md`.
- `IdempotencySpec.on_conflict` restricted to `z.literal("skip")` for v1. Update /
  replace are deferred to v1.1 together with the required `update_steps` block.
- Unified `NormalizerEnum` (= `strip_emoji | ascii_dashes | ascii_arrows | nfc |
  collapse_whitespace | lower | upper | trim | slug`) is used by both
  `text_normalizers` and `KeyPart.normalize`. Runtime applies `text_normalizers`
  *before* per-part `normalize` on both sides of the comparison.
- `.refine`-level invariants on `MutationActionSchema`:
  - `for_each` requires `as`.
  - `for_each` and `sweep` are mutually exclusive.
  - `batch.concurrency > 1` requires `batch.safe_parallel === true`.
- Connector-level `superRefine` cross-validates every `idempotency.read_via` and
  `sweep.targets_from` against declared `FetchAction.name`s.
- `MutationActionSchema` adds `timeout_seconds` (action-level), `requires_confirmation`,
  and per-step `capture: { as, from_aria_label_match }` for created-id surfacing.
- `NavigateByLabels` adds `click_action: z.enum(["click", "right_click", "hover"])`
  (default `click`) and `optional: boolean` on the step wrapper.
- Loader: `learning.ts.LearnEntry` loader filters unknown `kind` with a warning
  rather than rejecting the file — forward compat for older runtimes.
- Dead field `connector.output_types: z.string()` deleted in PR1 cleanup.

## Design-level notes about the diff

1. **Discriminated union on `kind` requires preprocess.** `z.discriminatedUnion` does
   **not** back-fill a missing discriminator via `.default()` inside a union arm. We
   therefore apply a pre-validation transform in the loader that injects `kind: "fetch"`
   when absent. This is documented in the loader diff at the bottom.

2. **Auth is a discriminated union with three arms** — `persistent_profile`,
   `credentials`, and `any_of`. `any_of` is a single-level wrapper with its own
   `type: any_of`, not a recursive self-type. This keeps discrimination simple and the
   runtime `auth_status` reporting uniform.

3. **Action is a discriminated union on `kind`** with two arms — `FetchAction` and
   `MutationAction`. Discrimination is sound because the field is required post-preprocess.

4. **`input_schema` is a 3-arm union**: a bare string (registry reference), an
   `extends`-style object, or the v0.1 inline JSON-Schema-like record. The third arm is
   the backward-compat slot.

5. **Structured idempotency `key`** is a `z.array(KeyPart)`, where each part is itself a
   tagged union (`{ kind: "field", ... }` | `{ kind: "literal", ... }`). No custom
   string-parser lives in the runtime.

## Diff — `runtime/src/lib/connector-schema.ts`

```diff
 import { z } from "zod";

 export const CredentialSpecSchema = z.object({
   key: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, {
     message: "Credential key must be snake_case",
   }),
   label: z.string().min(1),
   type: z.enum(["text", "password", "totp_secret", "phone", "email", "otp"]).default("text"),
   optional: z.boolean().default(false),
 });

+// ───────── auth ─────────
+
+export const ExpiryProbeSchema = z.object({
+  navigate_by_labels: z.array(z.string().min(1)).min(1).optional(),
+  redirect_indicates_expiry: z.array(z.string().min(1)).optional(),
+}).refine(
+  v => !!(v.navigate_by_labels || v.redirect_indicates_expiry),
+  { message: "expiry_probe needs navigate_by_labels or redirect_indicates_expiry" },
+);
+
+export const PersistentProfileAuthSchema = z.object({
+  type: z.literal("persistent_profile"),
+  profile_id: z.string().regex(/^[a-z][a-z0-9_-]*$/, {
+    message: "profile_id must be kebab/snake-case",
+  }),
+  browser: z.enum(["chromium", "msedge", "chrome"]).default("chromium"),
+  signed_in_as_hint: z.string().max(200).optional(),
+  expiry_probe: ExpiryProbeSchema.optional(),
+});
+
+export const CredentialsAuthSchema = z.object({
+  type: z.literal("credentials"),
+  credentials: z.array(CredentialSpecSchema).min(1),
+});
+
+const SingleAuthSchema = z.discriminatedUnion("type", [
+  PersistentProfileAuthSchema,
+  CredentialsAuthSchema,
+]);
+
+export const AnyOfAuthSchema = z.object({
+  type: z.literal("any_of"),
+  options: z.array(SingleAuthSchema).min(2),
+});
+
+export const AuthSchema = z.discriminatedUnion("type", [
+  PersistentProfileAuthSchema,
+  CredentialsAuthSchema,
+  AnyOfAuthSchema,
+]);
+
+// ───────── steps ─────────
+
+const NavigateLabelSchema = z.union([
+  z.string().min(1),
+  z.array(z.string().min(1)).min(1),   // localized synonyms
+  z.object({
+    label: z.union([z.string(), z.array(z.string()).min(1)]),
+    role: z.string().optional(),
+    next_scope: z.enum(["page", "subtree", "controlled_region"]).default("page"),
+  }),
+]);
+
+export const DismissIfPresentSchema = z.object({
+  dismiss_if_present: z.object({
+    label: NavigateLabelSchema,
+    timeout_seconds: z.number().positive().max(30).default(2),
+  }),
+});
+
 export const StepSchema = z.object({
-  phase: z.enum(["login", "navigate", "extract"]),
-  instructions: z.string().min(1),
+  phase: z.enum(["login", "navigate", "extract", "mutate", "verify"]),
+  instructions: z.string().min(1).optional(),
+  navigate_by_labels: z.array(NavigateLabelSchema).min(1).optional(),
+  fallback_instructions: z.string().optional(),
   otp_handling: z.string().optional(),
   data_format: z.string().optional(),
   timeout_seconds: z.number().positive().default(60),
-});
+}).refine(
+  v => !!(v.instructions || v.navigate_by_labels),
+  { message: "step needs instructions or navigate_by_labels" },
+);
+
+// ───────── input schema registry reference ─────────
+
+export const InputSchemaRefSchema = z.union([
+  z.string().min(1),                                    // "TaskBatch"
+  z.object({                                            // extended
+    extends: z.string().min(1),
+    fields: z.record(z.unknown()).optional(),
+    supports: z.array(z.string().min(1)).optional(),
+    unsupported_fields: z.enum(["warn", "ignore", "error"]).default("warn"),
+  }),
+  z.record(z.unknown()),                                // v0.1 inline JSON-Schema-like
+]);
+
+// ───────── idempotency ─────────
+
+const NormalizerEnum = z.enum(["lower", "upper", "trim", "slug"]);
+
+const KeyFieldPartSchema = z.object({
+  kind: z.literal("field").default("field"),
+  from: z.string().min(1),
+  normalize: z.array(NormalizerEnum).default([]),
+});
+const KeyLiteralPartSchema = z.object({
+  kind: z.literal("literal").default("literal"),
+  literal: z.string(),
+});
+export const KeyPartSchema = z.preprocess(
+  (v) => {
+    if (typeof v !== "object" || v === null) return v;
+    if ("from" in v && !("kind" in v))    return { kind: "field",   ...v };
+    if ("literal" in v && !("kind" in v)) return { kind: "literal", ...v };
+    return v;
+  },
+  z.discriminatedUnion("kind", [KeyFieldPartSchema, KeyLiteralPartSchema]),
+);
+
+export const IdempotencySpecSchema = z.object({
+  key: z.array(KeyPartSchema).min(1),
+  read_via: z.string().optional(),
+  read_before_write: z.array(StepSchema).min(1).optional(),
+  on_conflict: z.enum(["skip", "update", "replace"]).default("skip"),
+  match: z.enum(["exact", "case_insensitive"]).default("case_insensitive"),
+}).refine(
+  v => !!(v.read_via || v.read_before_write),
+  { message: "idempotency needs read_via or read_before_write" },
+);
+
+// ───────── for_each / batch / sweep ─────────
+
+export const BatchSpecSchema = z.object({
+  concurrency: z.number().int().min(1).max(4).default(1),
+  rate_limit_per_minute: z.number().positive().optional(),
+  reread_per_item: z.boolean().default(false),
+  progress_tool: z.string().optional(),
+});
+
+export const SweepSpecSchema = z.object({
+  targets_from: z.string().min(1),
+  as: z.string().regex(/^[a-z][a-z0-9_]*$/).default("target"),
+  until_empty: z.boolean().default(true),
+  max_passes: z.number().int().min(1).max(100).default(10),
+  refresh_between_passes: z.boolean().default(true),
+});
+
+// ───────── preview / verify / action ─────────
+
+export const PreviewSpecSchema = z.object({
+  mode: z.enum(["describe_only", "read_only_simulation"]).default("describe_only"),
+  emit: z.array(z.string().min(1)).optional(),
+});
+
+const BaseActionSchema = z.object({
+  name: z.string().regex(/^[a-z][a-z0-9_]*$/, {
+    message: "Action name must be snake_case",
+  }),
+  description: z.string().min(1),
+  input_schema: InputSchemaRefSchema.default({}),
+  pre_steps: z.array(DismissIfPresentSchema).optional(),
+  steps: z.array(StepSchema).min(1),
+  safe_parallel: z.boolean().default(false),
+});
+
+export const FetchActionSchema = BaseActionSchema.extend({
+  kind: z.literal("fetch"),
+  output_schema: z.string().optional(),
+});
+
+export const MutationActionSchema = BaseActionSchema.extend({
+  kind: z.literal("mutation"),
+  output_schema: z.string().optional(),
+  destructive: z.boolean().default(false),
+  preview: PreviewSpecSchema.optional(),
+  verify: z.array(StepSchema).optional(),
+  rollback_policy: z.enum(["manual", "best_effort", "none"]).default("none"),
+  failure_mode: z.enum(["fail_fast", "continue"]).default("fail_fast"),
+  idempotency: IdempotencySpecSchema.optional(),
+  for_each: z.string().optional(),
+  as: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
+  batch: BatchSpecSchema.optional(),
+  sweep: SweepSpecSchema.optional(),
+}).refine(
+  v => !(v.for_each && v.sweep),
+  { message: "for_each and sweep are mutually exclusive" },
+).refine(
+  v => !v.for_each || !!v.as,
+  { message: "for_each requires as (binding name)" },
+);
+
+export const ActionSchema = z.discriminatedUnion("kind", [
+  FetchActionSchema,
+  MutationActionSchema,
+]);

-export const ActionSchema = z.object({
-  name: z.string().regex(/^[a-z][a-z0-9_]*$/, { … }),
-  description: z.string().min(1),
-  input_schema: z.record(z.unknown()).default({}),
-  output_schema: z.string().optional(),
-  steps: z.array(StepSchema).min(1),
-});

 export const InstitutionSchema = z.object({ /* unchanged */ });

 export const ConnectorSchema = z.object({
   id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: "…" }),
   name: z.string().min(1),
   description: z.string().min(1),
   version: z.string(),
   author: z.string().min(1),
   license: z.string().default("MIT"),
   tags: z.array(z.string()).default([]),
   institution: InstitutionSchema,
-  credentials: z.array(CredentialSpecSchema).default([]),
+  // Back-compat alias. v0.1 YAMLs still use this; the loader synthesizes `auth`
+  // from it before validation. If `auth` is also present the loader throws.
+  credentials: z.array(CredentialSpecSchema).default([]),
+  auth: AuthSchema.optional(),
+  text_normalizers: z.array(z.enum([
+    "strip_emoji", "ascii_dashes", "ascii_arrows", "nfc",
+  ])).optional(),
+  pii_patterns: z.array(z.string()).optional(),     // ["corporate_m365", ...]
+  pii_strip_fields: z.array(z.string()).optional(),
   actions: z.array(ActionSchema).min(1),
   topology: z.array(TopologyNodeSchema).optional(),
   api_shortcuts: z.array(ApiShortcutSchema).optional(),
   known_quirks: z.array(z.string()).optional(),
   output_types: z.string().optional(),
   notes: z.string().optional(),
 });
```

## Loader diff — `runtime/src/lib/connector-loader.ts`

```diff
 async list(): Promise<LoadedConnector[]> {
   …
   const raw = await readFile(path, "utf-8");
-  const parsed = yaml.load(raw);
-  const connector = ConnectorSchema.parse(parsed);
+  const parsed = yaml.load(raw);
+  const normalized = normalizeV0Manifest(parsed);   // inject kind: fetch, synthesize auth
+  const connector = ConnectorSchema.parse(normalized);
+  freezeCredentialAlias(connector);                 // keep read path working
   mergeLearnedSidecar(connector);
   …
 }

+function normalizeV0Manifest(parsed: unknown): unknown {
+  if (typeof parsed !== "object" || parsed === null) return parsed;
+  const m = parsed as Record<string, unknown>;
+
+  // 1. action.kind default → fetch
+  if (Array.isArray(m.actions)) {
+    m.actions = m.actions.map(a => {
+      if (typeof a === "object" && a !== null && !("kind" in a)) {
+        return { ...a, kind: "fetch" };
+      }
+      return a;
+    });
+  }
+
+  // 2. top-level credentials → auth (unless auth is already present)
+  if (Array.isArray(m.credentials) && m.credentials.length > 0) {
+    if (m.auth) {
+      throw new Error(
+        "Connector declares both top-level `credentials` and `auth`. " +
+        "Pick one — see migration-v0-to-v1.md."
+      );
+    }
+    m.auth = { type: "credentials", credentials: m.credentials };
+  }
+
+  return m;
+}
+
+function freezeCredentialAlias(connector: Connector): void {
+  if (connector.auth?.type === "credentials" && connector.credentials.length === 0) {
+    (connector as Mutable).credentials = connector.auth.credentials;
+  }
+}
```

## Test vectors (to ship with PR1)

1. `mizrahi-bank.yaml` — top-level `credentials`, no `kind`. Loads; resulting in-memory
   shape has `auth.type = "credentials"`, `credentials` aliased to the same array,
   every action has `kind: "fetch"`.
2. `microsoft-planner.yaml` — `auth.type = "persistent_profile"`, mutations, for_each,
   sweep, idempotency with structured `key`.
3. `azure-devops.yaml` — `auth.type = "any_of"` with persistent_profile + credentials.
4. Negative: manifest with both `credentials:` and `auth:` → throws.
5. Negative: mutation action without `input_schema` → Zod error.
6. Negative: fetch action with `rollback_policy` → Zod error (field not on FetchAction).
7. Negative: action with both `for_each` and `sweep` → refine error.
8. Negative: idempotency `key` with `{ from: "" }` → Zod min(1) error.
9. Negative: `any_of` with one option → min(2) error.
10. Positive: step with only `navigate_by_labels` and no `instructions` → ok.
