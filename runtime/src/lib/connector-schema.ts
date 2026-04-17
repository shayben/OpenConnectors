/**
 * Zod schema for connector YAML validation — v1.0.
 *
 * This is the v1 schema. It is a strict superset of the v0.1 shape:
 *   - Every v0.1 YAML parses unchanged via a pre-validation transform
 *     (`v0ToV1Preprocess`) that back-fills the v1 additions.
 *   - All new primitives (auth variants, mutation actions, for_each,
 *     idempotency, sweep, navigate_by_labels, text_normalizers,
 *     pii_patterns, capture) are opt-in.
 *
 * Design notes:
 *   - Action schemas use `.strict()` so unknown keys fail parse rather than
 *     being silently dropped.
 *   - Fetch vs Mutation is a discriminated union on `kind`, which is
 *     preprocess-defaulted to `"fetch"` for v0.1 YAMLs that predate it.
 *   - Auth is a discriminated union over `type`; the `any_of` arm is
 *     non-recursive (options may only be `persistent_profile` | `credentials`).
 *   - Idempotency `key` is a structured list, not a DSL string.
 *   - Normalizer enum is shared between connector-level `text_normalizers`
 *     and per-part `normalize` so dedupe is symmetric across the read/write
 *     sides of a comparison.
 *
 * See docs/design-v1.md and docs/schema-diff-v1.md.
 */

import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════
// Shared enums
// ═══════════════════════════════════════════════════════════════════════

export const NormalizerEnum = z.enum([
  "strip_emoji",
  "ascii_dashes",
  "ascii_arrows",
  "nfc",
  "collapse_whitespace",
  "lower",
  "upper",
  "trim",
  "slug",
]);
export type Normalizer = z.infer<typeof NormalizerEnum>;

// ═══════════════════════════════════════════════════════════════════════
// Credentials (v0.1 shape, unchanged)
// ═══════════════════════════════════════════════════════════════════════

export const CredentialSpecSchema = z
  .object({
    key: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, {
      message: "Credential key must be snake_case",
    }),
    label: z.string().min(1),
    type: z.enum(["text", "password", "totp_secret", "phone", "email", "otp"]).default("text"),
    optional: z.boolean().default(false),
  })
  .strict();

// ═══════════════════════════════════════════════════════════════════════
// Auth (discriminated union)
// ═══════════════════════════════════════════════════════════════════════

const PersistentProfileAuthSchema = z
  .object({
    type: z.literal("persistent_profile"),
    profile_id: z.string().min(1),
    browser: z.enum(["chromium", "msedge", "chrome", "firefox"]).default("chromium"),
    signed_in_as_hint: z.string().optional(),
    expiry_probe: z
      .object({
        redirect_indicates_expiry: z.array(z.string().min(1)).optional(),
        selector_indicates_ok: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const CredentialsAuthSchema = z
  .object({
    type: z.literal("credentials"),
    credentials: z.array(CredentialSpecSchema).default([]),
  })
  .strict();

const AnyOfAuthSchema = z
  .object({
    type: z.literal("any_of"),
    options: z
      .array(z.discriminatedUnion("type", [PersistentProfileAuthSchema, CredentialsAuthSchema]))
      .min(2),
  })
  .strict();

export const AuthSchema = z.discriminatedUnion("type", [
  PersistentProfileAuthSchema,
  CredentialsAuthSchema,
  AnyOfAuthSchema,
]);
export type Auth = z.infer<typeof AuthSchema>;

// ═══════════════════════════════════════════════════════════════════════
// Labels, steps, captures
// ═══════════════════════════════════════════════════════════════════════

export const LabelMatchSchema = z
  .object({
    label: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    role: z.string().optional(),
    click_action: z.enum(["click", "right_click", "hover"]).default("click"),
    next_scope: z.enum(["page", "controlled_region", "subtree"]).default("page"),
    /**
     * Matching mode applied to both the computed accessible name and any
     * aria-label values. Default `exact` preserves v1.0.0 semantics.
     *   - `exact`    : full-string equality
     *   - `prefix`   : node label starts with `label`
     *   - `suffix`   : node label ends with `label`
     *   - `contains` : node label contains `label` as a substring
     * `case_insensitive_contains` (the legacy fallback strategy on `name`)
     * still runs as a last resort regardless of `match_mode`.
     */
    match_mode: z.enum(["exact", "prefix", "suffix", "contains"]).default("exact"),
    /** When false, all comparisons (name + aria-label) are case-insensitive. */
    match_case: z.boolean().default(true),
  })
  .strict();
export type LabelMatch = z.infer<typeof LabelMatchSchema>;

export const CaptureSchema = z
  .object({
    as: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/, { message: "capture.as must be snake_case" }),
    /** Regex applied to the resolved node's aria-label; group 1 is the value. */
    from_aria_label_match: z.string().optional(),
    /**
     * Alias of `from_aria_label_match` — extracts the value as the first
     * capture group of the regex applied to the node's aria-label. Provided so
     * connector authors can spell their intent ("regex on the aria-label")
     * without having to remember the v1.0.0 short name.
     */
    from_aria_label_regex: z.string().optional(),
    /**
     * Splits the resolved node's aria-label on this substring and uses the
     * prefix as the captured value. Convenient for sites that suffix
     * accessibility hints to every label (e.g. Planner's
     * "{title}, Use arrow keys to access...").
     */
    from_aria_label_split: z.string().optional(),
  })
  .strict()
  .refine(
    (c) => {
      const sources = [
        c.from_aria_label_match,
        c.from_aria_label_regex,
        c.from_aria_label_split,
      ].filter((v) => v !== undefined).length;
      return sources <= 1;
    },
    {
      message:
        "capture must specify at most one of from_aria_label_match / from_aria_label_regex / from_aria_label_split",
    }
  );

/**
 * A phase-scoped step. At least one of `instructions`, `navigate_by_labels`,
 * or `dismiss_if_present` must be provided. The v0.1 shape (phase + instructions)
 * always satisfies this refine unchanged.
 */
export const StepSchema = z
  .object({
    phase: z.enum(["login", "navigate", "extract", "mutate", "verify"]),
    instructions: z.string().min(1).optional(),
    navigate_by_labels: z.array(LabelMatchSchema).min(1).optional(),
    dismiss_if_present: z
      .object({
        label: z.string().min(1),
        timeout_seconds: z.number().positive().default(3),
      })
      .strict()
      .optional(),
    fallback_instructions: z.string().optional(),
    capture: CaptureSchema.optional(),
    optional: z.boolean().default(false),
    otp_handling: z.string().optional(),
    data_format: z.string().optional(),
    timeout_seconds: z.number().positive().default(60),
  })
  .strict()
  .refine(
    (s) =>
      Boolean(s.instructions) ||
      (s.navigate_by_labels && s.navigate_by_labels.length > 0) ||
      Boolean(s.dismiss_if_present),
    {
      message:
        "Step requires at least one of `instructions`, `navigate_by_labels`, or `dismiss_if_present`",
    }
  );
export type ConnectorStep = z.infer<typeof StepSchema>;

/**
 * `pre_steps` run before the main `steps`. They are commonly dismiss-if-present
 * shortcuts (welcome banners, cookie walls) and do not need a phase.
 */
export const PreStepSchema = z
  .object({
    dismiss_if_present: z
      .object({
        label: z.string().min(1),
        timeout_seconds: z.number().positive().default(3),
      })
      .strict()
      .optional(),
    instructions: z.string().min(1).optional(),
  })
  .strict()
  .refine((s) => Boolean(s.dismiss_if_present) || Boolean(s.instructions), {
    message: "pre_step requires `dismiss_if_present` or `instructions`",
  });

// ═══════════════════════════════════════════════════════════════════════
// input_schema reference (3 arms)
// ═══════════════════════════════════════════════════════════════════════

const InputSchemaExtendsSchema = z
  .object({
    extends: z.string().min(1),
    fields: z.record(z.unknown()).optional(),
    supports: z.array(z.string()).optional(),
    unsupported_fields: z.enum(["warn", "fail", "ignore"]).optional(),
  })
  .strict();

/**
 * Three accepted shapes:
 *   1. `input_schema: TaskBatch`                 bare registry reference (string)
 *   2. `input_schema: { extends: "...", ... }`   registry extension (strict)
 *   3. `input_schema: { type: object, ... }`     v0.1 inline JSON-Schema-like
 *
 * A `superRefine` rejects `{ extends: 42 }` falling through to arm 3.
 */
export const InputSchemaRefSchema = z
  .union([z.string().min(1), InputSchemaExtendsSchema, z.record(z.unknown())])
  .superRefine((val, ctx) => {
    if (
      typeof val === "object" &&
      val !== null &&
      !Array.isArray(val) &&
      "extends" in (val as Record<string, unknown>)
    ) {
      const extendsVal = (val as { extends: unknown }).extends;
      if (typeof extendsVal !== "string" || extendsVal.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "input_schema.extends must be a non-empty string",
          path: ["extends"],
        });
      }
    }
  });

// ═══════════════════════════════════════════════════════════════════════
// Idempotency, sweep, batch, preview
// ═══════════════════════════════════════════════════════════════════════

const FieldKeyPart = z
  .object({
    from: z.string().min(1),
    normalize: z.array(NormalizerEnum).default([]),
  })
  .strict();

const LiteralKeyPart = z
  .object({
    literal: z.string(),
  })
  .strict();

export const KeyPartSchema = z.union([FieldKeyPart, LiteralKeyPart]);
export type KeyPart = z.infer<typeof KeyPartSchema>;

export const IdempotencySpecSchema = z
  .object({
    key: z.array(KeyPartSchema).min(1),
    read_via: z.string().min(1),
    // v1 ships `skip` only. `update`/`replace` require paired update_steps
    // (deferred to v1.1). Enforced as a Zod literal so authors who try to
    // declare upsert semantics the runtime can't execute fail at parse time.
    on_conflict: z.literal("skip").default("skip"),
  })
  .strict();
export type IdempotencySpec = z.infer<typeof IdempotencySpecSchema>;

export const SweepSpecSchema = z
  .object({
    targets_from: z.string().min(1),
    as: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/, { message: "sweep.as must be snake_case" }),
    until_empty: z.boolean().default(true),
    max_passes: z.number().int().positive().default(5),
    refresh_between_passes: z.boolean().default(true),
  })
  .strict();

export const BatchSpecSchema = z
  .object({
    concurrency: z.number().int().positive().default(1),
    safe_parallel: z.boolean().default(false),
    reread_per_item: z.boolean().default(false),
  })
  .strict()
  .refine((b) => b.concurrency <= 1 || b.safe_parallel === true, {
    message:
      "batch.concurrency > 1 requires batch.safe_parallel: true (UI automation is sequential by default)",
  });

export const PreviewSpecSchema = z
  .object({
    mode: z.literal("describe_only").default("describe_only"),
    emit: z.array(z.string()).min(1),
  })
  .strict();

// ═══════════════════════════════════════════════════════════════════════
// Institution, topology, api shortcuts (unchanged from v0.1)
// ═══════════════════════════════════════════════════════════════════════

export const InstitutionSchema = z.object({
  name: z.string().min(1),
  name_he: z.string().optional(),
  url: z.string().url(),
  country: z.string().length(2),
  locale: z.string().default("en-US"),
  timezone: z.string().default("UTC"),
  requires_israeli_ip: z.boolean().default(false),
});

export const TopologyNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    label: z.string(),
    url: z.string().optional(),
    note: z.string().optional(),
    children: z.array(TopologyNodeSchema).optional(),
    stale: z.boolean().optional(),
    last_seen_at: z.string().optional(),
  })
);

export const ApiShortcutSchema = z.object({
  name: z.string(),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("POST"),
  path: z.string(),
  auth: z
    .enum(["bearer_from_storage", "cookie_session", "none"])
    .default("bearer_from_storage"),
  auth_storage_key: z.string().optional(),
  body: z.string().optional(),
  returns: z.string().optional(),
  notes: z.string().optional(),
});

// ═══════════════════════════════════════════════════════════════════════
// Actions — discriminated union on `kind`
// ═══════════════════════════════════════════════════════════════════════

const ActionNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, {
  message: "Action name must be snake_case",
});

export const FetchActionSchema = z
  .object({
    kind: z.literal("fetch"),
    name: ActionNameSchema,
    description: z.string().min(1),
    // `{}` default preserves v0.1 behavior where input_schema could be omitted.
    input_schema: InputSchemaRefSchema.default({}),
    output_schema: z.string().optional(),
    pre_steps: z.array(PreStepSchema).optional(),
    steps: z.array(StepSchema).min(1),
  })
  .strict();
export type FetchAction = z.infer<typeof FetchActionSchema>;

export const MutationActionSchema = z
  .object({
    kind: z.literal("mutation"),
    name: ActionNameSchema,
    description: z.string().min(1),
    // Required for mutations — no silent `{}` default.
    input_schema: InputSchemaRefSchema,
    destructive: z.boolean().default(false),
    requires_confirmation: z.boolean().default(false),
    timeout_seconds: z.number().positive().optional(),
    for_each: z.string().min(1).optional(),
    as: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/, { message: "action.as must be snake_case" })
      .optional(),
    failure_mode: z.enum(["fail_fast", "continue"]).default("fail_fast"),
    batch: BatchSpecSchema.optional(),
    sweep: SweepSpecSchema.optional(),
    idempotency: IdempotencySpecSchema.optional(),
    preview: PreviewSpecSchema.optional(),
    pre_steps: z.array(PreStepSchema).optional(),
    steps: z.array(StepSchema).min(1),
    verify: z.array(StepSchema).optional(),
  })
  .strict();
export type MutationAction = z.infer<typeof MutationActionSchema>;

export const ActionSchema = z
  .discriminatedUnion("kind", [FetchActionSchema, MutationActionSchema])
  .superRefine((action, ctx) => {
    if (action.kind !== "mutation") return;
    if (action.for_each && !action.as) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`for_each` requires an `as` binding",
        path: ["as"],
      });
    }
    if (action.for_each && action.sweep) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An action may declare either `for_each` or `sweep`, not both",
        path: ["sweep"],
      });
    }
  });
export type ConnectorAction = z.infer<typeof ActionSchema>;

// ═══════════════════════════════════════════════════════════════════════
// Connector — top-level
// ═══════════════════════════════════════════════════════════════════════

const ConnectorObjectSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: "Connector id must be kebab-case",
  }),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string(),
  author: z.string().min(1),
  license: z.string().default("MIT"),
  tags: z.array(z.string()).default([]),
  institution: InstitutionSchema,

  // v0.1 top-level credentials mirror — synthesized by preprocess when only
  // `auth: { type: credentials }` is declared. Callers that read
  // `connector.credentials` continue to work unchanged.
  credentials: z.array(CredentialSpecSchema).default([]),

  auth: AuthSchema,

  actions: z.array(ActionSchema).min(1),

  text_normalizers: z.array(NormalizerEnum).default([]),
  pii_patterns: z.array(z.string()).default([]),

  topology: z.array(TopologyNodeSchema).optional(),
  api_shortcuts: z.array(ApiShortcutSchema).optional(),
  known_quirks: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

/**
 * v0 → v1 preprocess.
 *
 * Transforms:
 *   1. If the YAML declares both top-level `credentials` and `auth`, hard-error.
 *   2. If the YAML declares only top-level `credentials`, synthesize
 *      `auth: { type: credentials, credentials: [...] }`.
 *   3. If neither is declared, synthesize `auth: { type: credentials, credentials: [] }`.
 *   4. Back-fill a top-level `credentials` mirror from `auth.credentials` when
 *      the auth is the `credentials` arm, so callers that read
 *      `connector.credentials` keep working.
 *   5. Default every action's missing `kind` to `"fetch"`.
 *   6. Strip the dead v0.1 `output_types` field if present.
 */
function v0ToV1Preprocess(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const clone: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  const hasTopCreds = "credentials" in clone;
  const hasAuth = "auth" in clone;

  if (hasTopCreds && hasAuth) {
    throw new Error(
      "A connector may declare EITHER top-level `credentials` OR `auth`, not both. " +
        "Remove the `credentials` mirror; keep `auth: { type: credentials, credentials: [...] }` instead."
    );
  }

  if (hasTopCreds && !hasAuth) {
    clone.auth = { type: "credentials", credentials: clone.credentials };
  } else if (!hasAuth) {
    clone.auth = { type: "credentials", credentials: [] };
  }

  // Back-fill legacy top-level `credentials` mirror.
  const authObj = clone.auth as { type?: string; credentials?: unknown } | undefined;
  if (!("credentials" in clone)) {
    clone.credentials = authObj?.type === "credentials" ? authObj.credentials ?? [] : [];
  }

  // Default action.kind → "fetch" for v0.1 actions.
  if (Array.isArray(clone.actions)) {
    clone.actions = clone.actions.map((a) => {
      if (!a || typeof a !== "object" || Array.isArray(a)) return a;
      const action: Record<string, unknown> = { ...(a as Record<string, unknown>) };
      if (!("kind" in action)) action.kind = "fetch";
      return action;
    });
  }

  // Strip dead field.
  if ("output_types" in clone) delete clone.output_types;

  return clone;
}

/**
 * Connector schema with v0→v1 preprocess and cross-reference validation.
 *
 * Cross-ref invariants (connector-level superRefine):
 *   - Action names are unique.
 *   - Every `idempotency.read_via` names an existing *fetch* action.
 *   - Every `sweep.targets_from` names an existing *fetch* action.
 */
export const ConnectorSchema = z.preprocess(
  v0ToV1Preprocess,
  ConnectorObjectSchema.superRefine((conn, ctx) => {
    const fetchNames = new Set<string>();
    const seen = new Set<string>();
    for (const action of conn.actions) {
      if (seen.has(action.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate action name: ${action.name}`,
          path: ["actions"],
        });
      }
      seen.add(action.name);
      if (action.kind === "fetch") fetchNames.add(action.name);
    }
    for (const [i, action] of conn.actions.entries()) {
      if (action.kind !== "mutation") continue;
      if (action.idempotency && !fetchNames.has(action.idempotency.read_via)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `idempotency.read_via references unknown fetch action: ${action.idempotency.read_via}`,
          path: ["actions", i, "idempotency", "read_via"],
        });
      }
      if (action.sweep && !fetchNames.has(action.sweep.targets_from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `sweep.targets_from references unknown fetch action: ${action.sweep.targets_from}`,
          path: ["actions", i, "sweep", "targets_from"],
        });
      }
    }
  })
);

export type Connector = z.infer<typeof ConnectorSchema>;
export type ConnectorCredential = z.infer<typeof CredentialSpecSchema>;
