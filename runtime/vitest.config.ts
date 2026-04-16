/**
 * Vitest configuration for @openconnectors/runtime.
 *
 * Test layout:
 *   runtime/src/**\/__tests__/*.test.ts         unit tests colocated with sources
 *   runtime/test/fixtures/                      shared fixtures (sample YAMLs)
 *
 * Conventions:
 *   - No mocks of fs/yaml — tests should exercise the real loader against real files.
 *   - Tests that need a scratch connectors dir set process.env.OPENCONNECTORS_DIR
 *     to the fixture path. The runtime already honors this.
 *   - Keep tests hermetic: no network, no keychain writes, no persistent_profile
 *     launches. Anything that would shell out to a browser is out of scope for
 *     unit tests and belongs in a later integration harness.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
    // Surfaces `test.todo(...)` as skipped rather than failed; v1 primitives
    // are staked out as .todo placeholders until each PR lands its impl.
    passWithNoTests: false,
    reporters: process.env["CI"] ? ["default", "junit"] : ["default"],
    outputFile: process.env["CI"] ? { junit: "./test-results/junit.xml" } : undefined,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/cli.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
