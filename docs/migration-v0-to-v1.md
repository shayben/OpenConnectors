# Migration — OpenConnectors v0.1 → v1.0

**TL;DR:** Existing v0.1 YAMLs load unmodified. Every v1 feature is opt-in. There is no
`manifest_version` bump, no breaking field rename, no required migration step.

This document enumerates the precise wire-format delta and the exact loader transforms
that preserve compatibility.

## 1. What does not change

All of the following remain valid, unchanged:

- Top-level shape: `id`, `name`, `description`, `version`, `author`, `license`, `tags`,
  `institution`, `credentials`, `actions`, `topology`, `api_shortcuts`, `known_quirks`,
  `output_types`, `notes`.
- Action shape for fetch connectors: `name`, `description`, `input_schema`, `output_schema`,
  `steps`.
- Step phases: `login`, `navigate`, `extract`.
- Credential spec: `key`, `label`, `type`, `optional`.
- `.learned.json` on-disk shape. New entry kinds (`nav_failure`) extend the existing
  discriminated union. **The loader filters unknown kinds with a warning** rather
  than rejecting the sidecar — so an older runtime reading a newer sidecar
  (e.g. a v1.0.x reader that hasn't learned `nav_failure` yet) does not crash;
  and a newer runtime reading an older sidecar is trivially compatible.

## 1.1 Second-pass review — cuts and renames

A second review pass removed several fields from the v1 surface that shipped in the
first draft of this doc:

- `rollback_policy` — **removed**. Document rollback expectations in `description`
  instead. Every connector we can plausibly model uses `none`; it was documentation
  dressed as schema.
- `pii_strip_fields` — **removed**. Silent redaction is a footgun; PII-flagged entries
  should surface loudly, not be quietly scrubbed. The PII guard remains fail-closed.
- `preview.mode: read_only_simulation` — **removed**. UI navigation has side effects
  (mark-as-seen, expand-group); we cannot honestly promise a read-only simulation.
  `preview.mode: describe_only` is the only supported value in v1.
- `IdempotencySpec.match` enum — **removed**. Redundant with per-part `normalize: [lower]`.
- `navigate_by_labels.resolution_hint` (inline cache field) — **removed**. Label-path
  hints live in `.learned.json` (`nav_node`), not duplicated inline in the YAML.
- `on_conflict: update | replace` — **deferred to v1.1**. v1 accepts `skip` only,
  until the paired `update_steps` block is designed.

None of these cuts affect v0.1 connectors: they were never in v0.1.

## 2. What is added (opt-in)

| Area | v0.1 shape | v1.0 additions |
|---|---|---|
| Auth | top-level `credentials: […]` | `auth: { type: persistent_profile | credentials | any_of }` |
| Actions | implicit fetch | `kind: fetch | mutation` (default `fetch`) |
| Mutations | — | `preview`, `verify`, `idempotency`, `for_each`, `as`, `batch`, `sweep`, `destructive`, `rollback_policy`, `failure_mode` |
| Steps | `instructions` (freeform) | `navigate_by_labels`, `dismiss_if_present` (pre_step), new phases `mutate` and `verify` |
| Input schemas | inline JSON-Schema-like object | registry reference `input_schema: TaskBatch`, or `{ extends: "TaskDraft", fields, supports, unsupported_fields }` |
| PII guards | implicit default pack | opt-in `pii_patterns: [corporate_m365, ...]` |
| Normalizers | — | connector-level `text_normalizers: [strip_emoji, ascii_dashes, nfc, collapse_whitespace, ...]` |
| Batch reporting | — | `BatchReport { succeeded, failed, skipped_idempotent, items[] { status, captured? } }` with `status ∈ { ok, failed, partial, skipped_idempotent, not_run }` |
| Confirmation | — | `requires_confirmation: boolean` (independent of `destructive`) |

Every cell in the right column is new; every cell in the left column remains honored.

## 3. Loader transforms (in order)

The `ConnectorLoader` applies these transforms *before* Zod validation:

1. **Missing `kind`** on an action → inject `kind: "fetch"`.
2. **Top-level `credentials:` without `auth:`** → synthesize
   `auth: { type: "credentials", credentials: <copied> }`. The original `credentials`
   field is preserved on the in-memory `Connector` as a read-only alias so existing
   callers (`mcp-server.ts`, `credential-prompt.ts`, `commands/list.ts`) keep working
   unchanged.
3. **Both `credentials:` and `auth:` present** → **hard error**. Authors must pick one.
   This avoids silent precedence surprises.
4. **`input_schema` as an inline object** (v0.1 JSON-Schema-like) → accepted by the
   third arm of the `InputSchemaRef` union; no transform needed.
5. **`steps[].phase` of `mutate` or `verify`** on an action with `kind: "fetch"` →
   validation error. These phases only make sense for mutations.

## 4. Runtime behavior changes visible to v0.1 connectors

None, by design. The only place a v0.1 connector sees different output is:

- `auth_status` (new tool) reports the same content that `vault_status` reports today,
  plus an `auth_type: "credentials"` field. The existing `vault_status` tool is kept as
  an alias for one minor version (`1.0.x`) and deprecated in `1.1`.
- `get_connector` output includes an explicit `auth` block even for v0.1 YAMLs. Clients
  reading only `credentials` continue to work; clients that start reading `auth` see the
  synthesized shape.

## 5. Deprecation plan

| Field | v1.0 | v1.x | v2.0 |
|---|---|---|---|
| `credentials:` at top level | supported (alias) | supported (warning on load) | removed (authors must write `auth:`) |
| `vault_status` tool | supported | supported (warning) | removed |

v2.0 is at least 12 months away and will ship a `openconnectors migrate` command that
rewrites YAML in place.

## 6. Per-connector migration checklist (optional)

For an author who *wants* to adopt v1 features on a v0.1 connector:

1. Replace `credentials: […]` with:
   ```yaml
   auth:
     type: credentials
     credentials:
       - { key: national_id, label: "National ID", type: text }
       - { key: password,     label: "Password",   type: password }
   ```
2. For any action, explicitly annotate `kind: fetch` (documentation value only).
3. No other changes required unless adopting mutation / for_each / navigate_by_labels.

Mizrahi Bank stays on v0.1 shape — its diff to v1.0 is zero lines.
