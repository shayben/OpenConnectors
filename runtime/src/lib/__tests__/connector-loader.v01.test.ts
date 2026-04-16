/**
 * Regression suite — everything under connectors/ must load against the current
 * (v0.1) schema. This is the "don't break Mizrahi" gate. When PR1 lands the v1
 * schema this file becomes a compat test: every v0.1 YAML must still load with
 * identical in-memory shape via the v0→v1 preprocess.
 */

import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ConnectorLoader } from "../connector-loader.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoConnectors = resolve(here, "..", "..", "..", "..", "connectors");

describe("connector loader — v0.1 regression", () => {
  it("discovers at least the baseline v0.1 connectors", async () => {
    const loader = new ConnectorLoader({ dir: repoConnectors });
    const all = await loader.list();
    const v01Ids = [
      "esop-excellence",
      "harel-pension",
      "menora-pension",
      "migdal-pension",
      "mizrahi-bank",
      "pension-more",
    ];
    const loadedIds = all.map((l) => l.connector.id);
    for (const id of v01Ids) {
      expect(loadedIds).toContain(id);
    }
  });

  it("mizrahi-bank keeps its zero-change shape", async () => {
    const loader = new ConnectorLoader({ dir: repoConnectors });
    const { connector } = await loader.get("mizrahi-bank");
    expect(connector.id).toBe("mizrahi-bank");
    expect(connector.credentials.length).toBeGreaterThan(0);
    expect(connector.credentials.map((c) => c.key)).toEqual(
      expect.arrayContaining(["national_id", "password"])
    );
    expect(connector.actions.length).toBeGreaterThanOrEqual(2);
    // v0.1 actions are implicitly fetch — no `kind` field required.
    for (const action of connector.actions) {
      expect((action as { kind?: string }).kind ?? "fetch").toBe("fetch");
    }
  });
});
