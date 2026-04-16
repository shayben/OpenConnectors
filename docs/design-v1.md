# OpenConnectors v1 — Design

**Status:** Proposal. Not yet implemented.
**Target release:** OpenConnectors v1.0 (OSS launch).
**Supersedes:** nothing — v0.1 (fetch-only, personal data) remains wire-format compatible.

## 0.0 Design-review changes (after rubber-duck pass)

This document was reviewed and materially updated. The notable changes from the
first draft:

- **Backward-compat is a Zod *preprocess*, not a `.default()` inside a union arm.**
  Missing `kind` → `"fetch"` and top-level `credentials:` → `auth: { type: credentials }`
  both happen before the discriminated union parses, with an in-memory alias that keeps
  existing callers reading `connector.credentials` working unchanged (§2.2, §3, §4.1).
- **`navigate_by_labels` gains explicit scope semantics**
  (`page | controlled_region | subtree`, default `page`) — a tab click moves you to a
  *tabpanel* that is not in the tab’s DOM subtree, and the naive narrowing rule was wrong
  (§2.7).
- **`key_from` is now a structured list, not a string DSL.** No custom parser (§2.3).
- **`any_of` auth is flattened to a single level** (no recursion) and becomes an explicit
  wrapper type (§2.1).
- **Three small runtime primitives added** to cover real Planner-bridge behavior that the
  first draft swept into `known_quirks`: `dismiss_if_present`, `text_normalizers` (runtime
  input sanitizer), and an explicit `sweep` mutation mode that replaces the
  "synthetic for_each over list_tasks" hack for destructive inventory ops (§2.2, §2.4, §2.9).
- **`.diagnose.json` moves to `~/.openconnectors/diagnostics/<connector_id>.json`** — no
  more sibling file that relies on `.gitignore` as a privacy boundary (§2.8).
- **`persistent_profile` trust boundary:** when a connector requests an existing profile
  whose cookies include a new eTLD+1, the runtime prompts the user before launching (§2.1).
- **PSS-style authenticated-XHR execution is explicitly deferred to post-v1.** v1 covers
  UI-only create + delete + read for Planner. Dates/dependencies that today use the
  browser-context PSS REST API remain in the Python bridge until a dedicated design pass
  for authenticated API-shortcut execution (§5).

## 0.1 Second-pass review changes (applied)

A second, deeper review identified a set of blocker-class bugs and simplifications. All
are reflected below. Summary of changes since revision 1:

**Blockers fixed**

- **Unified `Normalizer` enum shared by `text_normalizers` and idempotency key parts**
  (§2.3, §2.9). Previously they drew from disjoint lists, so a title with an em-dash
  would normalize one way for display and another way for the dedupe key — guaranteeing
  duplicates on rerun (the exact failure mode v1 is supposed to prevent). Now:
  `text_normalizers` run first (at read time and at write time), then per-part
  `normalize` runs on both sides of the comparison. Applying the same pipeline to both
  existing rows and incoming items is enforced by the runtime, not trusted to authors.
- **Action schemas are `.strict()`** (§2.2). A `rollback_policy` key on a `fetch` action,
  or a typo like `forEach` instead of `for_each`, now fails at parse time rather than
  being silently dropped.
- **`on_conflict: update | replace` is deferred to v1.1** (§2.3). v1 accepts `skip` only.
  Supporting update requires a paired `update_steps` block and an explicit diff contract;
  shipping the enum without the steps would let authors declare upserts the runtime
  cannot execute. A Zod `.refine` enforces this; tests are listed as todos.

**Majors fixed**

- **`batch.concurrency > 1` requires explicit `safe_parallel: true`** on the action
  (§2.4, refine). Default `concurrency: 1` for UI automation; authors who want parallelism
  for pure-API mutations must opt in per-action.
- **Per-item `partial` status and `captured` slot on `BatchReport`** (§2.4). A Planner
  task created with only a title before priority/progress/notes fail now reports
  `status: partial` with the captured task-id, so the rerun idempotency check sees it
  and the author knows a cleanup is needed. Shipping a rerun that silently drops the
  missing fields was the worst failure mode in the first draft.
- **`requires_confirmation: boolean` on mutations, independent of `destructive`**
  (§2.2). Covers "transfer $X" / "send to all" / "post publicly" style actions that
  aren't destructive in the delete sense but still need a human beat.
- **`read_via` is cross-validated at connector level** via `ConnectorSchema.superRefine`
  (§2.3). A mutation that names a non-existent or non-fetch action for idempotency
  now fails at load, not at the first rerun.
- **Loader filters unknown `LearnEntry.kind` with a warning** (§4.1) — adding
  `nav_failure` in PR5 would otherwise crash any coexisting older runtime reading the
  same sidecar.
- **Planner delete redesigned around hover→ellipsis→Delete** (not right-click) and
  the delete-confirmation nav step marked `optional: true` with a short timeout
  (§3.A). "Open card details" replaced with the real aria-label pattern.
  Bucket horizontal-scroll called out as an explicit known-quirk; checklist
  idempotency limitation documented (the runtime dedupes on `title + bucket`, not on
  checklist deltas).
- **ADO `update_work_item` declares `org` in its input schema** (§3.B). Previous draft
  referenced `{{input.org}}` without defining it. `create_work_items_from_batch` now
  uses a bare `input_schema: IssueDraftBatch` reference. Idempotency for create keys
  on `title + project` (required fields), not the optional `area_path`.

**Minors / cuts**

- **Cut `rollback_policy`.** Every connector we can plausibly model uses `none`; it
  was documentation dressed as schema. Authors document rollback in `description`.
- **Cut `preview.mode: read_only_simulation`.** UI navigation has side effects
  ("mark as seen", "expand group"); we can't promise read-only simulation. `preview`
  is now `describe_only`.
- **Cut `pii_strip_fields`.** Silent-redaction is a footgun: a rejected entry should
  surface, not be quietly scrubbed. The PII guard remains fail-closed.
- **Cut `IdempotencySpec.match` enum.** Redundant with per-part `normalize: [lower]`.
- **Cut `navigate_by_labels.resolution_hint`.** The label-path → selector cache lives
  in `.learned.json` (`nav_node`), not inline in the YAML; one source of truth.
- **Added `collapse_whitespace` and `nfc` to the normalizer enum** so Unicode-equivalent
  titles dedupe correctly.
- **PR0 inserted ahead of PR1** in the phased plan (§4): Vitest + fixtures + CI must
  exist before any schema change lands.
- **Action-level `timeout_seconds` added** alongside the existing per-step field (§2.2).
- **Added `click_action` to `navigate_by_labels`** with `click | right_click | hover`
  (§2.7) — hover is required to reveal Planner's card-ellipsis menu.


## 0. Motivation

OpenConnectors v0.1 is a declarative registry for **reading** personal data out of
institutional web portals. A connector is a YAML file with `login` / `navigate` /
`extract` phases, executed by Claude via `@playwright/mcp`. Credentials live in the
OS keychain. A `.learned.json` sidecar accumulates navigation topology, API shortcuts,
and quirks, with a strict PII guard on every write.

That shape works beautifully for banks, pension funds, and equity platforms — read-only,
single-session, data-out. It does **not** model a strictly larger and more valuable class
of workflows: **write/mutation connectors on corporate SaaS** — Microsoft Planner, Jira,
Azure DevOps, Linear, Trello, Notion, Asana, ClickUp, Airtable, GitHub Issues, …

The concrete forcing function: a sibling repo (`ChildSafety-Science`) ships a
500-line Python Playwright bridge that deletes 78 template tasks from a Planner plan and
creates ~21 parent tasks with checklists across 10 buckets. It works, but it is brittle in
ways that a schema-driven, agent-native framework should abstract away:

- Hardcoded CSS selectors; no self-healing when Planner’s React app re-renders.
- No idempotency — reruns duplicate tasks.
- Grid-vs-Board view confusion hardcoded into every operation.
- DOM walking up from a bucket-name text node to find the bucket column’s "Add task" span.
- Delete-all catches 10 of 78 rows on the first pass because the grid virtualises rows.
- Checklist entry hits a different inline editor than notes, requires a different locator.
- PSS REST API fallback for dates is faster but tied to session headers captured from
  network traffic — not a thing a declarative YAML can express today.

This document proposes a set of additions to OpenConnectors that make the Planner flow
expressible in ~150 lines of YAML, reusable for Jira/ADO/Linear, and without regressing
any existing fetch connector. The theme throughout: **add the minimum abstraction that
elegantly covers Planner + ADO + Mizrahi Bank**. Resist plugins, middleware, event buses,
transaction managers.

## 1. Design principles (carried forward)

1. **Local-first.** No cloud runtime, no telemetry. Diagnostics stay on disk.
2. **Credentials never in chat.** `request_credentials` security invariants apply to any
   new auth mode. New modes must be at least as strict.
3. **Declarative YAML.** A connector is a config file, not a Turing-complete DSL. If we
   reach for loops/conditionals beyond `for_each`, stop and reconsider.
4. **Wire-format compatibility for v0.1 YAMLs.** Existing connectors load unchanged.
   Additions are opt-in. No `manifest_version: 2` flag — the schema stays additive.
5. **Zod-validated.** Every field has a Zod type and unit-testable vectors.
6. **PII guard is mandatory** for any `.learned.json` write. No bypass pathway.

---

## 2. The eight primitives

Each section covers: motivation, schema (Zod inline), YAML surface, runtime semantics,
interaction with other primitives, open questions + recommendation, worked Planner
example.

### 2.1 Auth type: `persistent_profile`

#### Motivation

Personal-finance portals force the user to log in every session — classic password+OTP.
Corporate SaaS is the opposite: the user is **already signed in** on their desktop, via
a browser profile that holds M365 / Google Workspace / Atlassian Cloud cookies, device
trust tokens, and Conditional Access state. Making the user re-supply credentials through
`request_credentials` is both wrong (their IT may require MFA + device-bound auth that
can’t be scripted) and redundant.

The Planner Python bridge already encodes this insight — it uses
`chromium.launch_persistent_context(PROFILE_DIR, channel="msedge", headless=False)` and
lets the user sign in interactively on first run.

#### YAML

```yaml
auth:
  type: persistent_profile
  profile_id: m365            # shared across M365 connectors (Planner, Teams, SharePoint…)
  browser: msedge             # or chromium | chrome; default chromium
  signed_in_as_hint: "Your M365 work/school account"
  expiry_probe:
    # Runtime runs this before the main flow. If it fails → prompt user
    # to sign in manually (browser stays open; no chat credential ask).
    navigate_by_labels: ["Account manager", "Signed in as"]
    # OR explicitly: a redirect to a login domain signals expiry.
    redirect_indicates_expiry:
      - "login.microsoftonline.com"
      - "login.live.com"
```

A connector can also offer **a choice** between persistent_profile and classic
credentials, so an ADO connector can say "use my AAD SSO via profile, OR use a PAT":

```yaml
auth:
  any_of:
    - type: persistent_profile
      profile_id: aad
    - type: credentials
      credentials:
        - { key: ado_pat, label: "Azure DevOps PAT", type: password }
```

User picks at first run; choice is remembered in `~/.openconnectors/state.json`
(`selected_auth[<connector_id>]: persistent_profile | credentials`).

#### Zod (sketch) — flattened, non-recursive

```ts
const PersistentProfileAuth = z.object({
  type: z.literal("persistent_profile"),
  profile_id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  browser: z.enum(["chromium", "msedge", "chrome"]).default("chromium"),
  signed_in_as_hint: z.string().max(200).optional(),
  expiry_probe: ExpiryProbeSchema.optional(),
});

const CredentialsAuth = z.object({
  type: z.literal("credentials"),
  credentials: z.array(CredentialSpecSchema).min(1),
});

const SingleAuth = z.discriminatedUnion("type", [
  PersistentProfileAuth,
  CredentialsAuth,
]);

const AnyOfAuth = z.object({
  type: z.literal("any_of"),
  options: z.array(SingleAuth).min(2),
});

export const AuthSchema = z.discriminatedUnion("type", [
  PersistentProfileAuth,
  CredentialsAuth,
  AnyOfAuth,
]);
```

`any_of` is a single-level wrapper with its own `type: any_of`; nested `any_of` is
rejected at parse time. This keeps discrimination simple and `auth_status` reporting
straightforward.

#### Trust boundary when reusing a shared profile

A connector that declares `profile_id: m365` inherits whatever cookies, SSO tokens, and
device trust the existing `m365` profile holds. That is precisely the feature — and a
precisely-sized security concern. The runtime maintains
`~/.openconnectors/profile-allowlist.json`:

```json
{ "m365": { "etlds": ["microsoft.com", "office.com", "sharepoint.com"] } }
```

Before a connector launches a profile, the runtime computes the eTLD+1 of
`institution.url` and checks it against the allowlist. A new eTLD+1 prompts (in the local
127.0.0.1 form, never in chat):

> Connector `acme-planner-lookalike` wants to open **Microsoft M365** profile on
> `acme-phish.example`. Allow this once? [yes/no]

On yes, the eTLD+1 is added. On no, launch aborts. This is the full mitigation — we do
not sandbox per-connector cookies (that would defeat sharing).

#### Runtime semantics

- Profile dir: `%LOCALAPPDATA%/OpenConnectors/profiles/<profile_id>/` on Windows,
  `~/.local/share/openconnectors/profiles/<profile_id>/` on Linux, `~/Library/Application
  Support/OpenConnectors/profiles/<profile_id>/` on macOS. Overridable via
  `OPENCONNECTORS_PROFILES_DIR`.
- Claude calls the Playwright MCP’s `browser_install` / `browser_launch_persistent` tool
  with that dir. (This requires the Playwright MCP to expose persistent-context launch —
  either natively, or via a small OC-side wrapper tool `openconnectors.launch_profile`
  that shells out `chromium --user-data-dir=…`).
- First run: Claude navigates to `institution.url`, detects sign-in redirect, tells the
  user in the chat: "A browser window opened. Please sign in to your M365 account there."
  Does **not** ask for the password in chat.
- Subsequent runs: cookies + device trust persist → straight to the app.
- **Expiry detection.** Before each run, Claude executes `expiry_probe`. If the probe
  lands on a login domain or the expected label isn’t found, Claude surfaces a clear
  "Profile expired — sign in again in the open browser" message. Does **not** close the
  browser; waits for user to complete sign-in, then continues.

#### `vault_status` → `auth_status`

The existing `vault_status` MCP tool generalizes. For a `credentials`-auth connector the
response is unchanged (which keys are set). For a `persistent_profile` connector:

```json
{
  "connector_id": "microsoft-planner",
  "auth_type": "persistent_profile",
  "profile_id": "m365",
  "profile_dir_exists": true,
  "profile_last_used_at": "2026-04-10T13:22:04Z",
  "probe_status": "ok" | "expired" | "never_run"
}
```

For `any_of` the status is an array of per-option statuses plus a `selected` pointer.

#### Interactions

- **With PII guard:** profile directories contain cookies, auth tokens, SSO state — **never
  surface a profile path or contents to Claude**. The MCP server only returns `auth_status`
  metadata, never file contents.
- **With `.learned.json`:** profile ids are not PII (`m365`, `aad`) but the UPN of whoever
  is signed in would be. Do not record UPN or tenant id in the sidecar — blocked by the
  enterprise PII pack (see §2.6).
- **With mutations (§2.2):** mutations will almost always use persistent_profile; a write
  connector that demands credentials is a smell (the user is trusting OC with their
  corp password to click buttons on their behalf).

#### Open questions & recommendations

- *Per-connector profile vs shared profile?* **Shared** by default (`profile_id`, not
  `profile_dir`). All M365 connectors use `m365`; all Atlassian Cloud connectors use
  `atlassian`. Sharing is the whole point — one sign-in per identity provider.
- *How to declare "I expect you to be signed in as X"?* A freeform `signed_in_as_hint`
  string displayed to the user; **not** a machine check. Machine checks on identity would
  force us to store UPN/tenant info, violating the PII guard.
- *Headless?* Never, for persistent_profile. Corporate MFA + device trust require a head.

### 2.2 Action kind: `mutation` (vs implicit `fetch`)

#### Motivation

v0.1 actions are implicitly fetch: they run `steps`, validate output against
`output_schema`, return data. Mutations are different enough that a property-bag
"has_side_effects: true" flag on a unified action would force every validator, doc
generator, and UI to special-case it. Model it explicitly.

#### Schema: discriminated union on `kind`

```ts
const BaseAction = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1),
  input_schema: InputSchemaRef,   // see §2.5
  steps: z.array(StepSchema).min(1),
});

const FetchAction = BaseAction.extend({
  kind: z.literal("fetch").default("fetch"),
  output_schema: z.string().optional(),
});

const MutationAction = BaseAction.extend({
  kind: z.literal("mutation"),
  output_schema: z.string().optional(),          // optional for mutations
  destructive: z.boolean().default(false),       // extra confirmation gate
  preview: PreviewSpec.optional(),               // §2.2.1
  verify: z.array(StepSchema).optional(),        // §2.2.2
  rollback_policy: z.enum(["manual", "best_effort", "none"]).default("none"),
  failure_mode: z.enum(["fail_fast", "continue"]).default("fail_fast"),
  idempotency: IdempotencySpec.optional(),       // §2.3
  for_each: z.string().optional(),               // §2.4
  as: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
  batch: BatchSpec.optional(),
});

const ActionSchema = z.discriminatedUnion("kind", [FetchAction, MutationAction]);
```

**Why discriminated union, not a property branch?** Three reasons:

1. Zod catches "mutation without input_schema" and "fetch with rollback_policy" at parse
   time with readable errors.
2. TypeScript narrowing in the runtime: `if (action.kind === "mutation") { action.verify }`
   is type-safe without casts.
3. Future divergence: if mutations grow a concept fetches never need (e.g., `concurrency`),
   we don’t pollute fetch’s shape.

**Backward compatibility via preprocess, not default.** `z.discriminatedUnion` does not
back-fill missing discriminators via `.default()` on an arm. The loader applies a
pre-validation transform:

```ts
function normalizeAction(raw: unknown): unknown {
  if (typeof raw === "object" && raw !== null && !("kind" in raw)) {
    return { ...raw, kind: "fetch" };
  }
  return raw;
}
```

Analogously for `auth`: top-level `credentials: […]` in a v0.1 YAML is lifted to
`auth: { type: "credentials", credentials: […] }`. The loader also **keeps
`connector.credentials` populated as a read-only alias** in the in-memory shape so
existing callers (`mcp-server.ts`, `credential-prompt.ts`, `commands/list.ts`) read it
unchanged. v0.1 YAMLs that specify both `credentials:` and `auth:` fail loading with an
explicit error — no silent precedence.

#### YAML — minimal mutation

```yaml
actions:
  - name: create_tasks_from_batch
    kind: mutation
    description: Create Planner tasks from a TaskBatch input
    input_schema: TaskBatch                 # registry reference, §2.5
    for_each: "{{input.tasks}}"
    as: task
    idempotency:
      key_from: "task.title|lower + '|' + task.bucket|lower"
      read_via: list_tasks
      on_conflict: skip
    failure_mode: continue
    rollback_policy: none
    steps:
      - phase: navigate
        navigate_by_labels: ["Board view tab"]
      - phase: mutate
        navigate_by_labels: ["Add task card in {{task.bucket}} column"]
      - phase: mutate
        instructions: |
          Type {{task.title}} into the inline textbox, click the form's Add task button.
    verify:
      - phase: verify
        navigate_by_labels: ["Task card {{task.title}}"]
```

#### 2.2.1 `preview` (dry-run)

```yaml
preview:
  # Describe what would happen without committing. Runtime calls this when
  # the caller passes { dry_run: true }.
  mode: describe_only      # | read_only_simulation
  emit:
    - "Would create task '{{task.title}}' in bucket '{{task.bucket}}'"
    - "Would set priority={{task.priority}} progress={{task.progress}}"
```

- `describe_only`: string-template emission, no browser interaction. Cheap, no verify.
- `read_only_simulation`: run the navigate steps but NOT mutate steps. Confirms the
  elements are reachable. Safer before a 100-task batch.

#### 2.2.2 `verify`

Zero or more steps executed *per item* after the mutation. Failure of a verify step marks
that item as `verify: "fail"` in the batch report, but does **not** attempt rollback (that
would require transaction semantics we explicitly don’t want). Authors can encode compensating
actions as a separate `rollback_*` connector action if they want, and invoke it manually.

#### Interactions

- **With `for_each` (§2.4):** `verify` runs inside the per-item context, binding `{{task}}`.
- **With `idempotency` (§2.3):** if an item is `skipped_idempotent`, `verify` is **not**
  run — the item already existed, verifying it again is noise.
- **With `navigate_by_labels` (§2.7):** verify steps typically use label-based navigation
  because they’re confirming human-visible outcomes ("the task appears on the board").

#### Open questions & recommendations

- *Discriminated union or property?* **Discriminated union** (justified above).
- *Model `upsert` separately or let idempotency handle it?* **Let idempotency handle it.**
  `on_conflict: update` already expresses upsert; a separate `kind: upsert` would be a
  synonym that doubles the surface. The distinction lives where it belongs — in how the
  runtime reacts to a pre-existing key.

### 2.3 Idempotency: natural-key deduplication

#### Motivation

Reruns are the rule, not the exception. The Python bridge gets this wrong today — running
populate twice makes 42 tasks instead of 21. Any mutation connector that doesn’t solve this
ships broken.

#### Schema

```ts
const IdempotencySpec = z.object({
  key_from: z.string().min(1),                // small DSL, see below
  read_via: z.string().optional(),            // name of a paired fetch action
  read_before_write: z.array(StepSchema).optional(), // OR inline steps
  on_conflict: z.enum(["skip", "update", "replace"]).default("skip"),
  match: z.enum(["exact", "case_insensitive"]).default("case_insensitive"),
}).refine(
  v => !!(v.read_via || v.read_before_write),
  { message: "Idempotency requires either read_via (paired fetch) or read_before_write" }
);
```

#### Key spec — structured, not a string DSL

Rubber-duck caught that a string DSL quickly grows into a mini-language. Use a
structured list instead, parseable with no custom parser:

```yaml
idempotency:
  key:
    - from: task.title
      normalize: [lower, trim]
    - literal: "|"
    - from: task.bucket
      normalize: [lower, trim]
  read_via: list_tasks
  on_conflict: skip
  match: case_insensitive
```

Zod:

```ts
const KeyPart = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("field"),
    from: z.string().min(1),                              // dotted path
    normalize: z.array(z.enum(["lower", "upper", "trim", "slug"])).default([]),
  }),
  z.object({ kind: z.literal("literal"), literal: z.string() }),
]);

// YAML uses shorthand: { from: "…", normalize: [...] } or { literal: "…" }; a Zod
// preprocess maps the shorthand to the tagged KeyPart.
```

Resolution: each `from` is evaluated against `{ input, <as binding>, existing_item }`,
normalizers apply in order, parts concatenate in order. If any `from` resolves to
`null` or `undefined`, the whole batch aborts with a clear error before any mutation.

No JS escape hatch. If a connector can’t express its key with fields + normalizers, the
connector’s design is wrong — either it needs a paired fetch that surfaces a normalized
id, or idempotency isn’t achievable and the connector must declare that honestly.

#### Runtime flow per batch

1. Parse all incoming items. Compute their keys via the DSL.
2. If `read_via`: call that action (must be `kind: fetch`). Receive list of existing items.
   Compute each existing item’s key the same way (DSL re-evaluated with `existing_item`
   binding).
3. Diff: for each incoming item, if key matches an existing item, apply `on_conflict`:
   - `skip`: mark `skipped_idempotent` in batch report; don’t run steps.
   - `update`: run steps in `update` mode — requires a separate `update` sub-action OR
     the connector’s `kind: mutation` action accepting a `{ existing_id }` parameter.
     Recommendation: **require authors to declare an explicit `update_steps` block** if
     they want update semantics. Otherwise `skip` is the only option.
   - `replace`: delete existing item first (requires `delete_steps`), then create.

#### Does idempotency force every mutation connector to ship a fetch?

Essentially yes, and that’s healthy. If a connector can’t enumerate what it creates, the
user can’t safely rerun it. Authors who genuinely can’t read state can set
`idempotency: { key_from: "task.id", read_via: <stub that returns [] >, on_conflict: skip }`
— but they’ll be broken on rerun and that’s on them.

#### Concurrency caveat (best-effort only)

The idempotency check is a snapshot: `read_via` runs once at batch start. A concurrent
user who creates a matching item between the snapshot and our mutation will produce a
duplicate. UI connectors are single-user workflows in practice, and a serialize-transaction
guarantee is both impossible over a browser and out of scope. Authors who need stronger
semantics can set `batch.reread_per_item: true` to re-query before each mutation — at a
proportional latency cost — but the runtime still guarantees no stronger than
best-effort.

#### Interactions

- **With for_each:** idempotency computes keys for the flattened item list before iterating.
- **With preview:** dry-run mode reports how many items **would** be created vs skipped.
- **With failure_mode:** skipped items never fail; they increment `skipped_idempotent`.

### 2.4 Bulk operations: `for_each`

#### Motivation

Creating 21 tasks, closing 50 issues, inviting 30 users — arrays are the norm. Looping in
the agent works but makes every connector author write the same retry/report/continue
boilerplate. Lift it.

#### YAML

```yaml
- name: create_issues_from_batch
  kind: mutation
  input_schema: IssueDraftBatch
  for_each: "{{input.issues}}"
  as: issue
  failure_mode: continue
  batch:
    concurrency: 1                     # default; UI automation is sequential-only
    rate_limit_per_minute: 60          # applied even at concurrency 1
    progress_tool: report_progress     # optional MCP tool called after each item
  steps: […]
  verify: […]
```

#### Concurrency

- **Default: 1** (sequential). UI automation has a global browser state; parallel clicks
  corrupt everything.
- Concurrency > 1 only allowed when the connector also sets
  `action.safe_parallel: true`, intended for API-oriented connectors that use
  `browser_evaluate(fetch(...))` against an XHR endpoint captured in `api_shortcuts`.
- Even then, cap at 4 — declared as a global runtime limit, not per-connector.

#### Batch report (returned by the action)

```ts
interface BatchReport {
  succeeded: number;
  failed: number;
  skipped_idempotent: number;
  total: number;
  items: Array<{
    index: number;
    key: string;                 // from idempotency.key_from
    status: "created" | "updated" | "replaced" | "skipped_idempotent" | "failed";
    error?: string;              // present when status = "failed"
    verify?: "pass" | "fail" | "not_run";
    duration_ms: number;
  }>;
}
```

`output_schema: BatchReport` is implicit for `kind: mutation + for_each`.

#### Progress reporting

`batch.progress_tool: <mcp-tool-name>` — after each item, the runtime calls that tool
with `{ index, total, status, key }`. If the tool isn’t available, silently skip. This
is the only place we introduce a "callback" and we keep it single-purpose.

#### Interactions

- **With failure_mode:** `fail_fast` halts on first `failed`, returns partial report with
  unprocessed items as `status: "not_run"`. `continue` processes all items.
- **With idempotency:** skipped items never touch the browser.
- **With verify:** runs inside the per-item context; adds `verify.pass_count` / `fail_count`
  to the report footer.

#### Open questions

- *Templating inside steps.* `for_each` binds `as: task`; step instructions reference
  `{{task.title}}`. Runtime must template before dispatching to Playwright MCP. We avoid
  introducing a real template engine — **Mustache-style `{{var}}`, no conditionals, no
  loops-in-strings**. If an author wants conditional behaviour per-item, they split into
  two actions and dispatch from the agent side.

### 2.5 Input schema registry

#### Motivation

Output schemas (`Transaction`, `Document`, `Form106`) are shared across connectors today.
Inputs deserve the same treatment — a `TaskDraft` input that Planner, Trello, Jira,
Linear, Notion, Asana, and ClickUp all understand is the whole point of a cross-ecosystem
framework.

#### Inventory (starter set)

| Schema | Fields (core) | Used by |
|---|---|---|
| `TaskDraft` | title, bucket?, assignees?, labels?, due_date?, start_date?, priority?, progress?, notes?, checklist[]? | Planner, Trello, Jira, Linear, Notion, Asana, ClickUp |
| `TaskBatch` | tasks: TaskDraft[] | wrapper for `for_each` |
| `IssueDraft` | title, type?, area_path?, description?, labels?, assignees?, priority?, custom_fields?: Record<string, unknown> | GitHub Issues, GitLab Issues, Jira, ADO |
| `IssueDraftBatch` | issues: IssueDraft[] | |
| `DocumentUpload` | path, filename?, mime_type?, folder?, tags? | SharePoint, OneDrive, Drive, Box, Dropbox |
| `MessageDraft` | channel_or_recipient, body, attachments?, reply_to? | Slack, Teams, Discord |

Shared inputs live in `schemas/src/inputs/` next to `transaction.ts` etc.

#### Reference + extend

```yaml
input_schema: TaskBatch                 # bare reference

# or extend:
input_schema:
  extends: TaskDraft
  fields:
    planner_progress:                   # connector-specific field
      type: integer
      enum: [0, 50, 100]
      description: "Planner only accepts 0/50/100"
  supports: [title, bucket, priority, progress, notes, checklist]
  unsupported_fields: warn              # | ignore | error
```

#### Handling fields one connector supports but another doesn’t

- `supports: [...]` declares the subset of the base schema this connector handles.
- Incoming fields outside that set trigger the `unsupported_fields` policy:
  - `ignore` — silently drop. Invisible failures, dangerous. Not default.
  - `warn` — **default**. Batch report adds `warnings: ["field X ignored on items 3, 7"]`.
  - `error` — reject the whole batch. Use when silently dropping a field would change
    semantics (e.g., dropping `assignees` on Trello would leave tasks unassigned).

#### Zod sketch

```ts
const InputSchemaRef = z.union([
  z.string(),                                   // bare registry name
  z.object({
    extends: z.string(),
    fields: z.record(JsonSchemaLike).optional(),
    supports: z.array(z.string()).optional(),
    unsupported_fields: z.enum(["warn", "ignore", "error"]).default("warn"),
  }),
  z.record(z.unknown()),                        // inline JSON-Schema-like object (v0.1 compat)
]);
```

v0.1 actions with inline `input_schema: { type: object, ...}` continue to parse — the
third union arm preserves backward compat.

### 2.6 Enterprise PII patterns

#### Motivation

Today’s PII regex pack targets personal finance: Israeli IDs, JWTs, currency amounts,
UUIDs in URLs. Enterprise SaaS drops different footguns into `.learned.json`:

- UPNs / emails: `firstname.lastname@tenant.onmicrosoft.com`
- AAD object IDs: GUIDs in specific positions (user/group ids)
- Tenant IDs: GUID in `?tid=` or path
- SharePoint site URLs with `?u=` user tokens
- Teams meeting URLs with embedded join tokens
- Graph OData IDs: base64 etag-like `"etag@odata.etag"` with PII embedded

#### Design: named pattern packs

```ts
type PiiPack = { name: string; patterns: Array<{ name: string; re: RegExp }> };

const BUILTIN_PACKS: Record<string, PiiPack> = {
  default: { name: "default", patterns: [/* existing v0.1 rules */] },
  corporate_m365: {
    name: "corporate_m365",
    patterns: [
      { name: "UPN/email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
      { name: "AAD object id / tenant id (GUID)",
        re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
      { name: "Teams meeting token",
        re: /meetup-join\/[0-9a-zA-Z%._-]{30,}/ },
      { name: "SharePoint user token",
        re: /\/personal\/[^/\s]+_[^/\s]+/ },
      { name: "Graph etag",
        re: /W\/"[A-Za-z0-9+/=]{20,}"/ },
    ]
  },
  corporate_google: { /* @domain.com, folder ids, shared drive tokens */ },
  corporate_atlassian: { /* cloudId, accountId */ },
};
```

#### YAML

```yaml
# Connector opts into additional packs. `default` is always on; cannot be disabled.
pii_patterns:
  - corporate_m365
```

Packs are additive-only — a pack can **add** forbidden patterns, never relax them. This
preserves the invariant "anything that matches any active pack is blocked."

#### False-positive tolerance

Recommendation: **always fatal by default**. Connector authors iterate until their
learning payloads are clean. This preserves the local-first, no-surprises principle: if
the guard could silently strip, a bug in authorship would slowly leak PII to disk.

**Escape hatch (opt-in):**

```yaml
pii_strip_fields: [note, notes]  # per-field blanking on match, instead of reject
```

Only applies to fields the connector explicitly lists. A field listed here that matches
PII gets overwritten with `"[REDACTED]"` and the entry is stored. All other fields retain
hard-reject behaviour.

#### Interactions

- **With `.learned.json`:** every record path funnels through `assertNoPii` with the
  union of active packs. Unchanged API; internal pattern set grows.
- **With `persistent_profile`:** enterprise UPNs routinely leak into nav labels (e.g.,
  "Signed in as lastname.firstname@tenant.onmicrosoft.com"). Having `corporate_m365`
  active means the user’s UPN can’t be recorded as a label.

### 2.7 `navigate_by_labels` — first-class label-path navigation

#### Motivation

The single most brittle thing in the Planner Python bridge is finding "the bucket column’s
Add task button." The bridge walks the DOM upward from the bucket text node, trying levels
1..15 of ancestors, to find a child `Add task` text. That’s 60 lines of defensive code per
mutation. Planner already labels the element with
`aria-label="Add task card in Development column"` — a breadcrumb a human would read.
`record_navigation` already uses `label_path` in `.learned.json`. Promote label_path to a
first-class step primitive.

#### YAML

```yaml
- phase: navigate
  navigate_by_labels:
    - "Board"                      # role=tab, name="Board"
    - "{{task.bucket}} bucket"     # matched against aria-label prefix
    - "Add task card"              # clickable
  fallback_instructions: |         # free-text fallback for the agent
    Switch to Board view (top-right tab), scroll to the {{task.bucket}} column,
    click its "Add task" button.
```

#### Matching algorithm

1. Call Playwright MCP `browser_snapshot` (ARIA tree).
2. For each label in the array, in order, applying the current **scope** (see below):
   a. Try **exact** match on aria-label.
   b. Try **case-insensitive contains** match.
   c. Try match on role+name pairing (e.g., `[role="tab"] [name="Board"]`).
   d. Try match against localized synonyms: a label can be an array
      `["Board", "לוח"]` — any match wins.
3. The matched element determines the scope for the *next* label (see Scope below).
4. Click the leaf.
5. If any label fails to resolve → emit `fallback_instructions` as natural language and
   let the agent improvise. Log the failure to `.learned.json` as a `nav_failure` entry
   (new `kind`) so authors can fix the label list offline.

#### Scope

Naive "narrow to the clicked element’s DOM subtree" is wrong for tabs, popovers, menus,
and React portals. A tab click moves focus to a **tabpanel** that is usually not a DOM
descendant of the tab element. The step declares scope per label:

```yaml
- phase: navigate
  navigate_by_labels:
    - label: "Board"
      role: tab
      next_scope: controlled_region    # follow aria-controls on the clicked tab
    - label: "{{task.bucket}} bucket"
      next_scope: subtree              # the next label lives inside this column
    - label: "Add task card"
      # (no next_scope; this is the leaf)
```

`next_scope` values:
- `page` (default) — re-scan the whole ARIA tree for the next label.
- `subtree` — limit to the matched node’s descendants.
- `controlled_region` — follow the matched node’s `aria-controls` / `aria-owns`
  reference to find the region it governs, and scope there. This is the correct
  semantics for tabs, disclosure buttons, popover triggers.

The verbose object form is the robust version; the bare-string shorthand
(`"Board"`, `"Add task card"`) means `{ label: "Board", next_scope: "page" }`. Authors
writing fresh connectors are encouraged to start bare and escalate to the object form
only when a step actually breaks.

#### Caching to `.learned.json`, with invalidation

On success, record a `nav_node` entry with a `resolution_hint`:

```json
{
  "kind": "nav_node",
  "label_path": ["Board", "Development bucket", "Add task card"],
  "resolution_hint": {
    "role": "button",
    "aria_label_starts_with": "Add task card in Development column",
    "ancestor_labels": ["Board"],
    "recorded_at": "..."
  },
  "miss_count": 0,
  "last_seen_at": "..."
}
```

A hint includes `ancestor_labels` (the labels up to but not including the leaf) so the
runtime can tell "same label path, different page state" from "genuine match." Next run:

- Runtime tries the hint first. If it resolves to a unique node, use it.
- If it resolves to zero or ≥2 candidates, fall through to the full algorithm and
  increment `miss_count` on the existing entry.
- After **3 consecutive misses**, the `resolution_hint` is dropped (but the `label_path`
  itself stays so the navigation is still cached as a breadcrumb).

Hints never contain URLs, user ids, or free text beyond role + aria-label — they flow
through the standard PII guard like any other entry.

#### Localization

`navigate_by_labels` accepts `string | string[]` per slot. Authors ship the primary
language plus any known translations; runtime tries each. Dynamic user-language detection
is explicitly out of scope — YAML declares what it supports.

#### Interactions

- **With for_each:** labels are Mustache-templated against the per-item binding
  (`"{{task.bucket}} bucket"`).
- **With verify:** verify steps almost always use label paths — a post-condition is
  naturally "I should see X on the board".
- **With `.learned.json`:** successful resolutions feed the sidecar; next session’s
  `get_connector` returns cached hints in the merged topology.

### 2.8 `diagnose` — dry-run probe for new connector authoring

#### Motivation

Today, writing a new connector is grep-log-print-repeat. The Python bridge has a `probe`
and `diag-dates` command specifically because authoring-time inspection is a different
tool than run-time execution. Ship this as a framework primitive.

#### CLI

```
openconnectors diagnose <connector-id-or-url> [--out <id>.diagnose.json] [--scaffold]
```

Behavior:

1. Resolves the connector (existing YAML) or, with `--scaffold`, starts from a new id.
2. Launches the configured auth (persistent_profile most likely). If the profile is cold,
   prompts the user to sign in exactly like a normal run.
3. Navigates to `institution.url`.
4. Captures:
   - Top-level `browser_snapshot` ARIA tree.
   - All role=tab / role=button / role=link labels in the first-screen viewport.
   - Inferred breadcrumb graph (parent→child by aria-owns / nesting).
   - Candidate selectors for each button: role+name plus aria-label.
   - Any observed network calls matching `*.microsoftonline.com`, `*.graph.microsoft.com`,
     etc. → candidate `api_shortcuts` (paths only, no query strings).
5. Writes `~/.openconnectors/diagnostics/<connector_id>.json`. Author-time only; **not**
   beside the YAML, **not** merged into `.learned.json` at runtime, **not** read by the
   loader. The path is outside the repo so `.gitignore` is not the privacy boundary —
   loader code is.
6. With `--scaffold`, emits a skeleton `<id>.yaml` with:
   - `institution` block filled from the landing URL + title.
   - `auth: { type: persistent_profile, profile_id: <guess> }`.
   - One `fetch` action stub per top-nav item with `navigate_by_labels` pre-populated.

#### Interaction with `.learned.json`

`diagnose.json` is **separate** from `.learned.json` by design:

- `.learned.json` is persistent, PII-scrubbed, merged into every `get_connector` call.
- `.diagnose.json` is author-time, PII-scrubbed **but** may include aria-labels that
  name real people (e.g., assignee avatars). Treat as sensitive: gitignored, not auto-
  loaded, not touched at runtime.

To promote a diagnose observation into `.learned.json`, the author edits the YAML to add
the nav path, and a regular run will record it through the normal guard.

### 2.9 Three small primitives (`dismiss_if_present`, `text_normalizers`, `sweep`)

Rubber-duck review flagged that the first draft buried real operational needs of the
Planner flow into `known_quirks` (freeform text). Three small, crisply-bounded primitives
cover those needs without opening a general "plugin" door.

#### 2.9.1 `dismiss_if_present`

A pre-step the runtime performs before `navigate`/`mutate` phases. Opt-in per action or
connector-wide.

```yaml
pre_steps:
  - dismiss_if_present:
      label: "Close welcome banner"
      timeout_seconds: 2
  - dismiss_if_present:
      label: "Not now"                    # cookie notice, upsell modal, …
      timeout_seconds: 2
```

Semantics: look up the label via the normal label-resolver. If present within timeout,
click. If not, silently continue. Never fails the run. Every connector that touches a
modal-heavy app ships one or two of these.

#### 2.9.2 `text_normalizers`

Planner garbles em-dash, en-dash, arrows, and most emoji when typed into its inputs. The
bridge sanitizes all strings before typing (`sanitize_text`). Ship this as a runtime
preprocessor applied to any value templated into a step:

```yaml
# Connector-level declaration:
text_normalizers:
  - strip_emoji
  - ascii_dashes          # — / – / − → -
  - ascii_arrows          # → / ⇒ / ➜ → ->
  - nfc                   # Unicode NFC normalization
```

Runtime applies these to every `{{task.title}}` / `{{task.notes}}` / `{{task.checklist[]}}`
expansion before dispatching the step. No connector author needs to remember, for every
input field, to wrap it in a sanitize call. The input schema itself is unchanged — we
normalize at the template boundary, not at validation.

Builtin normalizers only; no user-defined JS. The initial set covers 99% of observed
SaaS-input quirks; extend the enum in the runtime when a new one is warranted.

#### 2.9.3 `sweep` — destructive fixed-point mutation

The first draft modelled `delete_all_tasks` as a `for_each` over `list_tasks`. Review
flagged that as a hack: delete-all is actually a **sweep** — re-read the target set
until it is empty, because the UI virtualises rows (the bridge loops up to 300 times
and reloads between passes, `cmd_delete_all`).

```yaml
- name: delete_all_tasks
  kind: mutation
  destructive: true
  sweep:
    targets_from: list_tasks
    as: task
    until_empty: true
    max_passes: 10
    refresh_between_passes: true
  steps: […]                  # how to delete one task
  failure_mode: continue
```

Semantics: runtime calls `targets_from` to fetch the current set, runs `steps` once per
item (with the same for_each-style binding), then re-calls `targets_from`. If the set is
still non-empty and `max_passes` not exceeded, loop. Terminate on empty set, max
passes, or a pass that deleted zero items (fixed point).

`sweep` is distinct from `for_each` because the item list is **re-read** between passes;
it is also mutually exclusive with `for_each` on the same action. `destructive: true` is
strongly encouraged on any sweep action — callers get an explicit confirmation surface.



### 3.A Microsoft Planner (catalyst)

Auth: `persistent_profile` with `profile_id: m365`.

**v1 scope.** UI-only create / delete / read. Dates, dependencies, resource assignment
stay out of v1 (they depend on PSS REST API with browser-captured headers — see §5
deferred work). The Python bridge’s `cmd_populate`, `cmd_delete_all`, `cmd_read`, and
`cmd_probe` are covered; `cmd_update_dates` and `cmd_update_deps` are not.

Actions:
- `list_tasks` — kind: fetch. Used as `idempotency.read_via` for creates and as
  `sweep.targets_from` for delete-all.
- `create_tasks_from_batch` — kind: mutation. `for_each: tasks`. `TaskBatch` input.
  Structured idempotency key `title + bucket`. `failure_mode: continue`. `verify` checks
  the card is visible on the board. Uses `text_normalizers: [strip_emoji, ascii_dashes,
  ascii_arrows]` to sanitize titles/notes/checklist items on the way in.
- `delete_all_tasks` — kind: mutation, `destructive: true`, `sweep.until_empty: true,
  max_passes: 10, refresh_between_passes: true`.

`pre_steps` handle the welcome banner and occasional upsell modal via
`dismiss_if_present`.

Quirks encoded in `known_quirks` + hand-authored `.learned.json` baseline:
- "Board view is required for Add task; Grid view is required for delete-all." — encoded
  as the first `navigate_by_labels` step of each action (tab click with
  `next_scope: controlled_region`).
- "Planner garbles em-dash/en-dash/emoji when typed into fields." — handled by
  `text_normalizers` at the runtime level.
- "Clicking a task title enters edit mode, not detail view; click the card body below
  the title to open details." — encoded via `navigate_by_labels` targeting the card
  body’s aria-label, not the title text.

### 3.B Azure DevOps

Auth: `any_of: [persistent_profile(aad), credentials(PAT)]` — connector lets user choose.
Actions:
- `list_work_items` — kind: fetch. `IssueDraft[]`.
- `create_work_item` — kind: mutation. `input_schema: IssueDraft`. No for_each (single).
- `create_work_items_from_batch` — kind: mutation. `for_each`, input `IssueDraftBatch`.
  Idempotency `area_path + '/' + title`.
- `update_work_item` — kind: mutation. `input_schema: extends IssueDraft, fields:
  { id: integer, state?: string, fields: { … } }`. `on_conflict` not applicable (ID is
  natural).
- `add_comment` — kind: mutation. Simple, no idempotency (comments are intentionally
  duplicable; authors can dedupe on their side if desired).

Demonstrates:
- Auth `any_of` with profile + credentials coexistence.
- Shared `IssueDraft` used as-is and as `extends`.
- Natural-ID idempotency (ID) vs natural-key idempotency (area+title).

### 3.C Mizrahi Bank (regression)

Zero-line change. The existing `credentials`-style `credentials: […]` field coerces to the
new `auth: { type: credentials, credentials: […] }` via a Zod preprocess transform in the
loader. Existing `actions` default to `kind: fetch`. Existing `input_schema: { type: object,
...}` lands on the "inline JSON-Schema-like" union arm.

The schema is a strict superset.

---

## 4. Phased implementation plan

Each PR is scoped to be reviewable in under an hour. Each lists: goal, public-surface
changes, test strategy, acceptance criteria.

### PR0 — Test harness + CI (prerequisite)

- **Goal:** establish a unit-test baseline before any schema change lands. Every future
  PR adds real tests that convert `v1-primitives.todo.test.ts` todos into passing cases.
- **Changes:** `runtime/vitest.config.ts`, `runtime/src/lib/__tests__/*.test.ts` (v0.1
  loader regression, PII-guard vectors, v1-primitive todo placeholders),
  `.github/workflows/ci.yml` (Ubuntu × Windows × macOS on Node 20 & 22), `npm run test`
  wired through Turbo, `docs/testing.md`.
- **Tests:** 25+ passing tests over the v0.1 schema and PII guard; ~80 `test.todo`
  placeholders enumerating the contract each subsequent PR owes.
- **Acceptance:** `npm run test` green on all 3 OSes, all 6 committed v0.1 connectors
  loading via `ConnectorLoader`, Mizrahi shape asserted byte-identical.

### PR1 — Schema extensions (non-breaking)

- **Goal:** add all new Zod types behind a `v0 → v1` preprocess so existing YAML parses
  identically. No runtime behavior change. Action schemas use `.strict()` so unknown
  keys fail parse instead of silently dropping.
- **Changes:** `runtime/src/lib/connector-schema.ts` gains `AuthSchema`, `FetchAction`,
  `MutationAction`, `IdempotencySpec`, `BatchSpec`, `InputSchemaRef`, `NavigateByLabels`,
  `NormalizerEnum`. Connector-level `superRefine` cross-validates `read_via` /
  `sweep.targets_from` against fetch actions. Dead `output_types` field removed.
- **Tests:** convert the PR1 block of todos in `v1-primitives.todo.test.ts` to real
  tests (backward-compat, .strict() rejections, refines, connector-level cross-refs).
  All 6 v0.1 YAMLs load with in-memory shape equal to pre-PR1 load.
- **Acceptance:** `npm run test` green; a new `microsoft-planner.yaml` (stub) validates.

### PR2 — `persistent_profile` auth + profile management

- **Goal:** MCP server exposes `launch_profile`; `auth_status` generalizes. SingletonLock
  is detected and surfaced. `profile revoke` CLI removes eTLD+1 entries.
- **Changes:** new `runtime/src/lib/profile-manager.ts` (per-OS resolution, lock detect,
  allowlist). `mcp-server.ts` generalized `auth_status`. CLI command
  `openconnectors profile revoke <profile_id> <domain>`.
- **Tests:** convert the PR2 todos (OS resolution, env override, lock detection,
  allowlist enforcement, auth_status shape for both auth types).
- **Acceptance:** `vault_status` on Mizrahi unchanged; `auth_status` on a stub
  persistent_profile connector reports `never_run`; concurrent launch is blocked cleanly.

### PR3 — Mutation action kind + preview + verify + confirmation

- **Goal:** runtime recognises `kind: mutation`; surfaces `preview` / `verify` /
  `requires_confirmation` / `destructive` to agents.
- **Changes:** `mcp-server.ts` `get_connector` surfaces all four fields structurally.
  Add `run_preview` tool (no browser launch).
- **Tests:** PR3 todos — preview rendering, destructive flagging, confirmation gating,
  pre-PR4 runtime cleanly rejects invoking a mutation action.
- **Acceptance:** preview text matches expected template for a 2-item Planner input;
  `destructive: true` surfaces prominently.

### PR4 — `for_each` + idempotency + BatchReport + sweep + retry

- **Goal:** runtime drives per-item loop; produces `BatchReport`; supports `sweep` as a
  distinct primitive; transient-error retry/backoff per step.
- **Changes:** new `runtime/src/lib/batch-runner.ts`. `key_from` is a structured list
  (no DSL parser). `text_normalizers` and per-part `normalize` share the `Normalizer`
  enum; text_normalizers run first on both sides of the comparison. `on_conflict: skip`
  only (v1.1 adds `update` with `update_steps`). Per-step `retry: { attempts, backoff_ms,
  on: [transient_nav, element_not_found, timeout] }`.
- **Tests:** all PR4 todos (25+): key evaluation, unicode normalization symmetry, skip
  behavior, partial status, captured slot, fail_fast/continue, sweep termination,
  read_via cross-ref, retry classifications.
- **Acceptance:** re-running `create_tasks_from_batch` reports
  `skipped_idempotent == total`; a title with em-dash deduplicates correctly against
  an existing one with an ASCII hyphen after `ascii_dashes` normalization.

### PR5 — `navigate_by_labels` primitive

- **Goal:** label-path navigation via PW MCP `browser_snapshot`, with scope semantics,
  tie-break rules, auto-scroll, and `click_action` variants.
- **Changes:** `runtime/src/lib/label-resolver.ts`. Scope = `page | controlled_region |
  subtree`. Tie-break = prefer exact aria-label match, then role+name pairing, then
  deterministic first-in-DOM-order; ≥2 remaining candidates is an error. Records
  successful and failed resolutions to `.learned.json` (`nav_node`, `nav_failure`
  kinds).
- **Tests:** all PR5 todos — scope vectors, tie-break, localized labels, auto-scroll,
  click_action (click | right_click | hover), optional steps.
- **Acceptance:** Planner `["Board", "Development", "Add task"]` resolves uniquely
  against a recorded snapshot fixture.

### PR6 — Enterprise PII patterns + `pii_patterns` selector

- **Goal:** additive-only packs: `corporate_m365`, `corporate_google`, `corporate_atlassian`.
- **Changes:** `runtime/src/lib/learning.ts` — named packs, connectors opt in via
  `pii_patterns: [...]`. No `pii_strip_fields` (rejected entries surface, don't redact).
- **Tests:** PR6 todos — 10+ positive vectors per pack, 5+ negatives per pack,
  additive-only invariant, per-connector scoping.
- **Acceptance:** a nav label containing a UPN rejects on a `corporate_m365` connector
  but not on one without.

### PR7 — `diagnose` command

- **Goal:** CLI `openconnectors diagnose` writes to
  `~/.openconnectors/diagnostics/<connector_id>.json` (never next to YAML) and can
  scaffold a skeleton YAML.
- **Tests:** PR7 todos — output path, PII scrubbing, scaffold loads under v1 schema.
- **Acceptance:** `openconnectors diagnose --scaffold --url https://example.com new-connector`
  produces a loadable skeleton.

### PR8 — Planner + ADO reference connectors

- **Goal:** commit `connectors/microsoft-planner.yaml` and `connectors/azure-devops.yaml`
  plus hand-authored `.learned.json` baselines.
- **Tests:** PR8 todos — schema-validation, bare `input_schema: IssueDraftBatch`
  reference, ADO `update_work_item.input.org` present, Planner preview rendering.
- **Acceptance:** developer can run the Planner connector end-to-end replacing the
  Python bridge. Hover→ellipsis→Delete flow verified against a live plan.

### PR9 — v1.0 launch docs

- **Goal:** README refresh with fetch/mutation split, CHANGELOG, migration-guide link,
  `version: 1.0.0` bump.
- **Acceptance:** a first-time reader can author a `TaskBatch`-compatible write
  connector in under an hour using only the docs.

### Post-v1 (explicitly deferred)

- `on_conflict: update | replace` with `update_steps` / `delete_steps` blocks.
- Authenticated XHR execution (PSS-style) for API shortcuts.
- Webhooks / long-poll subscription primitives.
- Observability: run-log sidecar, schema-drift alert on failed label resolution.

---

## 5. What we explicitly are not doing (v1)

- No headless mode for any connector that uses persistent_profile. MFA requires a head.
- No cloud runtime, no SaaS OC, no registry-side execution.
- No attempt to model Jira workflow transitions, Confluence macros, Planner custom
  fields, etc. Each connector extends `IssueDraft` / `TaskDraft` with what it needs.
- **No authenticated-XHR execution as a first-class primitive.** The Python Planner
  bridge captures the PSS Bearer token + request headers from observed browser network
  traffic and issues `ctx.request.fetch(...)` calls to `project-df.microsoft.com/pss/...`
  for date/dependency operations. That is a real and valuable pattern — and large enough
  to deserve its own design pass (auth-token capture lifecycle, header allowlist, replay
  safety, how much the YAML declares vs the runtime infers). Deferred to post-v1. v1’s
  `api_shortcuts` remains a *discovery* record, not an execution model.
- No plugin/middleware/eventbus system. If a new connector needs something that doesn’t
  fit the 9 primitives (8 + `dismiss_if_present`/`text_normalizers`/`sweep`), we add a
  10th primitive with a design doc, not a plugin hook.

---

## 6. Success criteria

1. A new contributor can read this doc and explain `persistent_profile`, `mutation`, and
   `idempotency` without looking at code.
2. `connectors/microsoft-planner.yaml` is ≤ ~150 lines and captures every behavior the
   500-line Python bridge implements.
3. `connectors/azure-devops.yaml` reuses `IssueDraft` unchanged from the registry.
4. `connectors/mizrahi-bank.yaml` is diff-free (or ≤ 3-line opt-in diff).
5. The phased plan has 9 PRs, each reviewable in under an hour, each independently
   mergeable (behind defaults when necessary).
