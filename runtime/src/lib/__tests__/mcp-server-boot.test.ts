/**
 * Post-PR8 — mcp-server boot integration test.
 *
 * This is the regression test that would have caught the dangling
 * `promptForRuntimeInput` / `env-file.js` imports. It simply imports the
 * module (which triggers static import resolution and tool registration)
 * and asserts the exported surface is present.
 *
 * Full end-to-end tool invocation against stdio transport is out of
 * scope — the MCP SDK ships its own harness. What matters here is that
 * the whole `mcp-server.ts` module loads cleanly; that's the class of
 * regression that slipped through PR1-PR8 because no unit touched it.
 */

import { describe, expect, test } from "vitest";

describe("mcp-server boot integration", () => {
  test("mcp-server.ts imports all its transitive deps without error", async () => {
    // Dynamic import so the failure mode is a clear, catchable rejection
    // rather than a static parse-time crash that would abort the whole
    // test file. This ALSO covers every dep chain: credential-prompt,
    // env-file, profile-manager, batch-runner, preview, learning, etc.
    const mod = await import("../mcp-server.js");
    expect(typeof mod.startMcpServer).toBe("function");
  });

  test("env-file setEnvVar upserts preserving other keys", async () => {
    const { setEnvVar, getEnvVar } = await import("../env-file.js");
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { writeFileSync, readFileSync } = await import("node:fs");

    const dir = mkdtempSync(join(tmpdir(), "oc-env-"));
    const envPath = join(dir, ".env");
    writeFileSync(
      envPath,
      "# comment line\nEXISTING=keep_me\nOTHER=also_keep\n",
      "utf-8"
    );

    setEnvVar("IL_PROXY_URL", "https://user:p%21ss@host.example.com:8443", envPath);
    expect(getEnvVar("IL_PROXY_URL", envPath)).toBe(
      "https://user:p%21ss@host.example.com:8443"
    );
    const text = readFileSync(envPath, "utf-8");
    expect(text).toContain("# comment line");
    expect(text).toContain("EXISTING=keep_me");
    expect(text).toContain("OTHER=also_keep");
    expect(text).toContain("IL_PROXY_URL=");

    // Idempotent update.
    setEnvVar("IL_PROXY_URL", "https://new.example.com:443", envPath);
    expect(getEnvVar("IL_PROXY_URL", envPath)).toBe("https://new.example.com:443");
    // Only one line per key.
    const afterUpdate = readFileSync(envPath, "utf-8");
    const matches = afterUpdate.match(/^IL_PROXY_URL=/gm) ?? [];
    expect(matches.length).toBe(1);
  });

  test("env-file setEnvVar quotes values containing spaces or special chars", async () => {
    const { setEnvVar, getEnvVar } = await import("../env-file.js");
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "oc-env-"));
    const envPath = join(dir, ".env");
    setEnvVar("WITH_SPACES", "hello world", envPath);
    const text = readFileSync(envPath, "utf-8");
    expect(text).toContain('WITH_SPACES="hello world"');
    expect(getEnvVar("WITH_SPACES", envPath)).toBe("hello world");
  });

  test("env-file setEnvVar rejects invalid keys", async () => {
    const { setEnvVar } = await import("../env-file.js");
    expect(() => setEnvVar("bad-key", "x", "/tmp/ignored")).toThrow();
    expect(() => setEnvVar("1starts", "x", "/tmp/ignored")).toThrow();
  });
});
