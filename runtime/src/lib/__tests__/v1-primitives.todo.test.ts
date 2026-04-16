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

// PR2 contracts moved to pr2-profile-manager.test.ts as passing tests.


// PR3 contracts moved to pr3-preview.test.ts as passing tests.

// PR4 contracts moved to pr4-batch-runner.test.ts as passing tests.
// (A handful of sub-cases stay as todos for future PRs: on_conflict: update/replace
//  are deferred to v1.1; sweep support is tracked under the separate "PR4b — sweep"
//  group below.)
describe("PR4b — sweep (deferred follow-up to PR4)", () => {
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
