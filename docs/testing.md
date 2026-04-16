# Testing

OpenConnectors uses [Vitest](https://vitest.dev) for unit and schema tests.

## Layout

```
runtime/
  vitest.config.ts                  root config
  src/lib/__tests__/                colocated unit tests
    connector-loader.v01.test.ts    v0.1 regression — every committed YAML loads
    pii-guard.test.ts               PII pattern vectors (rejects + allows)
    v1-primitives.todo.test.ts      placeholder contracts; each PR flips todos to passing tests
  test/
    fixtures/                       hand-authored fixture connectors (added as PRs need them)
```

## Running

```bash
# whole workspace
npm run test

# watch mode inside runtime/
cd runtime && npm run test:watch

# a single file
cd runtime && npx vitest run src/lib/__tests__/pii-guard.test.ts
```

## Contract tests (`.todo`)

`v1-primitives.todo.test.ts` enumerates every test the v1 phased plan owes. Each PR that
introduces a primitive **must** convert its slice of todos into real tests. Todos are not
skipped — Vitest lists them in every run so they are visible review-surface.

## What is *not* in this harness

- No persistent_profile browser launches. Those live in a separate integration harness
  that will be added when PR2 lands. Unit tests for profile logic mock the filesystem.
- No network. No keychain writes. Tests that need credentials use fixture objects, not
  `CredentialVault`.
- No connector-specific tests for a live site (Planner, ADO). Those are author-time
  tools via `openconnectors diagnose`, not CI.

## CI

`.github/workflows/ci.yml` runs `typecheck`, `build`, and `test` across Ubuntu / Windows /
macOS on Node 20 and 22. The goal is to catch Windows path issues and Node version
regressions before merge. JUnit output is uploaded as an artifact for every matrix cell.
