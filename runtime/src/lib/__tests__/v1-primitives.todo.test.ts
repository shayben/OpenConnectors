/**
 * v1 placeholder suite — every `test.todo(...)` below is a contract owed to
 * a future PR. The review flagged that "20 vectors" and "30 positive-match
 * vectors" promised in the phased plan would otherwise be aspirational.
 * Enumerating them as todos here means the PR that lands the primitive MUST
 * convert each todo to a passing test. `vitest run` lists every todo on
 * every run, so they cannot be silently forgotten.
 *
 * Rules:
 *   - One `test.todo` per concrete, named scenario.
 *   - Group by PR so reviewers can check coverage at a glance.
 *   - Title is the spec; no additional prose needed.
 */

import { describe, test } from "vitest";

// PR1 contracts moved to pr1-schema.test.ts as passing tests.

describe("PR2 — persistent_profile auth + profile manager", () => {
  test.todo("profile_dir resolves per-OS (Windows %LOCALAPPDATA%, macOS, Linux)");
  test.todo("OPENCONNECTORS_PROFILES_DIR env override takes precedence");
  test.todo("Chromium SingletonLock presence is detected and surfaced as a clean error");
  test.todo("eTLD+1 allowlist blocks launch when connector opens a new domain");
  test.todo("auth_status reports `never_run | ok | expired` for a persistent_profile connector");
  test.todo("auth_status remains v0.1-shape for a credentials-only connector");
  test.todo("`openconnectors profile revoke <profile_id> <domain>` removes from allowlist");
});

describe("PR3 — mutation kind + preview + verify", () => {
  test.todo("get_connector surfaces mutation actions with `preview` and `verify` as structured fields");
  test.todo("run_preview returns describe_only text without launching a browser");
  test.todo("`destructive: true` is surfaced prominently in the preview output");
  test.todo("`requires_confirmation: true` forces a confirm step independent of `destructive`");
  test.todo("pre-PR4 runtime rejects invoking a `kind: mutation` action with a clear error");
});

describe("PR4 — for_each + idempotency + BatchReport", () => {
  // Idempotency key DSL vectors
  test.todo("key part: { from: 'task.title', normalize: [lower, trim] } evaluates against binding");
  test.todo("key part: { literal: '|' } concatenates literally");
  test.todo("key part: trailing whitespace in title normalizes via trim");
  test.todo("key part: em-dash in title normalizes via nfc + collapse_whitespace");
  test.todo("key part: `from` path resolving to undefined aborts the batch with a clear error");
  test.todo("key part: text_normalizers (connector-level) apply BEFORE per-part normalize");
  test.todo("key part: match between existing and incoming is symmetric (same normalizers applied both sides)");
  // on_conflict
  test.todo("idempotency: on_conflict: skip marks item as skipped_idempotent and does not run steps");
  test.todo("idempotency: v1 rejects on_conflict: update (deferred to v1.1)");
  test.todo("idempotency: v1 rejects on_conflict: replace (deferred to v1.1)");
  // Cross-ref
  test.todo("idempotency: read_via names a non-existent action → ConnectorSchema superRefine error");
  test.todo("idempotency: read_via names a non-fetch action → ConnectorSchema superRefine error");
  // BatchReport
  test.todo("BatchReport includes succeeded, failed, skipped_idempotent, total");
  test.todo("BatchReport items[].status includes `partial` when mid-item steps fail after create");
  test.todo("BatchReport items[].captured carries created-id from `capture` step");
  test.todo("failure_mode: fail_fast stops on first failure; remaining items status=not_run");
  test.todo("failure_mode: continue processes all items");
  test.todo("batch.reread_per_item: true re-runs read_via before each create");
  // Sweep
  test.todo("sweep runs targets_from, iterates, rereads, terminates on empty");
  test.todo("sweep terminates at max_passes even if not empty");
  test.todo("sweep terminates on a zero-delete pass (fixed-point)");
});

describe("PR5 — navigate_by_labels", () => {
  test.todo("exact aria-label match is preferred over case-insensitive contains");
  test.todo("next_scope: controlled_region follows aria-controls to the tabpanel");
  test.todo("next_scope: subtree limits to descendants of the matched node");
  test.todo("next_scope: page (default) rescans the full ARIA tree");
  test.todo("tie-break: ≥2 candidates after all strategies → step fails with 'ambiguous' error");
  test.todo("tie-break: a role+name pairing disambiguates otherwise-identical labels");
  test.todo("localized label: ['Board', 'לוח'] resolves against the Hebrew aria-label");
  test.todo("element off-screen is auto-scrolled into view before click");
  test.todo("click_action: right_click opens context menu (required for Planner delete)");
  test.todo("click_action: hover reveals ellipsis menu (required for card overflow actions)");
  test.todo("optional: true on a label step yields success when label is absent");
  test.todo("fallback_instructions is emitted only when label resolution fails");
  test.todo("nav_failure entry is recorded on resolution failure, PII-scrubbed");
});

describe("PR6 — enterprise PII patterns", () => {
  // Positive matches (must reject)
  test.todo("corporate_m365 rejects UPN alice@contoso.onmicrosoft.com");
  test.todo("corporate_m365 rejects AAD object GUID in structured field");
  test.todo("corporate_m365 rejects Teams meeting join URL");
  test.todo("corporate_m365 rejects SharePoint /personal/alice_contoso_onmicrosoft_com path");
  test.todo("corporate_m365 rejects Graph eTag / OData id string");
  test.todo("corporate_google rejects user@domain.com and Drive folder id");
  test.todo("corporate_atlassian rejects cloudId GUID and accountId");
  // Negative matches (must pass)
  test.todo("corporate_m365 allows 'Sign in with Microsoft' button label");
  test.todo("corporate_m365 allows 'Task card in Development column'");
  // Pack composition
  test.todo("packs are additive-only: opting in never relaxes default pattern rejections");
  test.todo("pii_patterns on a connector applies to that connector's learning only");
});

describe("PR7 — diagnose CLI", () => {
  test.todo("`diagnose` writes to ~/.openconnectors/diagnostics/, never next to YAML");
  test.todo("`diagnose --scaffold` emits a loadable skeleton YAML with auth + one fetch action stub");
  test.todo("diagnose output is PII-scrubbed");
});

describe("PR8 — Planner + ADO reference connectors", () => {
  test.todo("microsoft-planner.yaml schema-validates under v1");
  test.todo("azure-devops.yaml schema-validates under v1");
  test.todo("azure-devops.yaml references `IssueDraftBatch` as bare input_schema string");
  test.todo("azure-devops.yaml update_work_item has `org` in its input schema");
  test.todo("microsoft-planner.yaml preview renders expected text for a 2-item input");
});

describe("Cross-cutting / loader robustness", () => {
  test.todo("LearnEntry with unknown `kind` is filtered with a warning (never crashes the loader)");
  test.todo("ConnectorSchema.superRefine: every `read_via` references an existing fetch action");
  test.todo("ConnectorSchema.superRefine: every `sweep.targets_from` references an existing fetch action");
});
