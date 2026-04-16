/**
 * v1 placeholder suite — remaining aspirational contracts.
 *
 * Most v1 primitives now have real passing tests in dedicated files:
 *
 *   PR1 → pr1-schema.test.ts
 *   PR2 → pr2-profile-manager.test.ts
 *   PR3 → pr3-preview.test.ts
 *   PR4 → pr4-batch-runner.test.ts
 *   PR5 → pr5-label-resolver.test.ts
 *   PR6 → pr6-pii-packs.test.ts
 *   PR7 → pr7-diagnose.test.ts
 *   PR8 → pr8-reference-connectors.test.ts
 *
 * What remains below are contracts deferred to post-v1 or covered elsewhere
 * (runtime driver, not unit surface). Keeping them as `test.todo` so they
 * are printed on every run and cannot be silently forgotten.
 */

import { describe, test } from "vitest";

describe("PR4b — sweep (deferred follow-up to PR4)", () => {
  test.todo("sweep runs targets_from, iterates, rereads, terminates on empty");
  test.todo("sweep terminates at max_passes even if not empty");
  test.todo("sweep terminates on a zero-delete pass (fixed-point)");
});

describe("PR4c — idempotency on_conflict update/replace (deferred to v1.1)", () => {
  test.todo("idempotency: v1.1 supports on_conflict: update");
  test.todo("idempotency: v1.1 supports on_conflict: replace");
});

describe("Integration — covered by PW-MCP-driven smoke (post-v1)", () => {
  // These are intentionally NOT unit-testable; they need a real browser.
  // They are acceptance criteria for the PR8 integration smoke, not PR8
  // unit tests, which already pass.
  test.todo("label-resolver integrates with @playwright/mcp browser_snapshot output");
  test.todo("mutation end-to-end: create_tasks_from_batch against a fixture app");
  test.todo("persistent_profile end-to-end: sign-in state survives a second run");
});
