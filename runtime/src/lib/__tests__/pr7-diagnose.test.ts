/**
 * PR7 — `openconnectors diagnose` CLI tests.
 *
 * The diagnose command is offline-safe: it does not drive a browser. These
 * tests pin three contracts from v1-primitives.todo.test.ts:
 *
 *   - writes to the diagnostics directory, never next to the source YAML.
 *   - `--scaffold` emits a loadable skeleton YAML.
 *   - output is PII-scrubbed.
 */

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, test } from "vitest";
import yaml from "js-yaml";
import {
  buildDiagnosePayload,
  diagnoseCommand,
} from "../../commands/diagnose.js";
import { ConnectorSchema } from "../connector-schema.js";

// Point the loader at the real repo connectors dir.
const here = dirname(fileURLToPath(import.meta.url));
const repoConnectors = join(here, "..", "..", "..", "..", "connectors");

beforeEach(() => {
  process.env["OPENCONNECTORS_DIR"] = repoConnectors;
});

function freshOutDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-diag-"));
}

describe("PR7 — diagnose CLI", () => {
  test("`diagnose` writes to the diagnostics directory, never next to YAML", async () => {
    const outDir = freshOutDir();
    const result = await diagnoseCommand("mizrahi-bank", { outDir });
    expect(result.diagnose_path.startsWith(outDir)).toBe(true);
    expect(result.diagnose_path.endsWith("mizrahi-bank.diagnose.json")).toBe(true);
    // It must NOT have been written anywhere near the YAML source.
    expect(result.diagnose_path).not.toContain(repoConnectors);
    expect(existsSync(result.diagnose_path)).toBe(true);
  });

  test("`diagnose --scaffold` emits a loadable skeleton YAML with auth + one fetch action stub", async () => {
    const outDir = freshOutDir();
    const result = await diagnoseCommand("mizrahi-bank", {
      outDir,
      scaffold: true,
    });
    expect(result.scaffold_path).toBeDefined();
    const yamlText = readFileSync(result.scaffold_path!, "utf-8");
    const parsed = yaml.load(yamlText);
    const validated = ConnectorSchema.parse(parsed);
    // Auth present; exactly one fetch action.
    expect(validated.auth.type).toBe("credentials");
    expect(validated.actions).toHaveLength(1);
    expect(validated.actions[0].kind).toBe("fetch");
  });

  test("diagnose output is PII-scrubbed", async () => {
    // The diagnose payload for a real connector (mizrahi-bank) must survive
    // the PII guard. If any field under assertNoPii tripped, diagnoseCommand
    // would have thrown before writing the file. Additionally, we assert
    // the payload shape contains only known, benign fields.
    const outDir = freshOutDir();
    const result = await diagnoseCommand("mizrahi-bank", { outDir });
    const written = JSON.parse(readFileSync(result.diagnose_path, "utf-8"));
    expect(Object.keys(written).sort()).toEqual([
      "actions",
      "aria_snapshot",
      "candidate_selectors",
      "connector_id",
      "connector_version",
      "generated_at",
      "notes",
    ]);
    // Spot-check: no fields named like credentials / tokens / ids.
    const serialized = JSON.stringify(written);
    expect(serialized).not.toMatch(/password|token|bearer|access_token/i);
  });

  test("buildDiagnosePayload is deterministic in shape for the same inputs", () => {
    const p1 = buildDiagnosePayload("x", "0.1.0", ["a", "b"]);
    const p2 = buildDiagnosePayload("x", "0.1.0", ["a", "b"]);
    // Differ only on `generated_at`.
    delete (p1 as { generated_at?: unknown }).generated_at;
    delete (p2 as { generated_at?: unknown }).generated_at;
    expect(p1).toEqual(p2);
  });
});
