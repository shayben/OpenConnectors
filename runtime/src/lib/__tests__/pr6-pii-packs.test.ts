/**
 * PR6 — enterprise PII pattern packs.
 *
 * These tests pin the behaviour of the additive pack system:
 *   - Packs extend the baseline rejection set; they NEVER relax it.
 *   - Opt-in happens per-call (or per-connector via `pii_patterns` in YAML).
 *   - Unknown pack names throw (no silent pass-through).
 */

import { describe, expect, test } from "vitest";
import { assertNoPii } from "../learning.js";

const quirk = (text: string) => ({ kind: "quirk" as const, text });
const nav = (labelPath: string[]) => ({
  kind: "nav_node" as const,
  label_path: labelPath,
});

describe("PR6 — corporate_m365 positive matches (must reject)", () => {
  const m365 = { packs: ["corporate_m365"] };

  test("rejects UPN alice@contoso.onmicrosoft.com", () => {
    expect(() =>
      assertNoPii(quirk("Sign in as alice@contoso.onmicrosoft.com"), m365)
    ).toThrow(/PII-like/);
  });

  test("rejects AAD object GUID in structured field", () => {
    expect(() =>
      assertNoPii(
        quirk("user objectId is 12345678-1234-1234-1234-123456789abc today"),
        m365
      )
    ).toThrow(/AAD object id|PII-like/);
  });

  test("rejects Teams meeting join URL", () => {
    expect(() =>
      assertNoPii(
        quirk(
          "Join at https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0"
        ),
        m365
      )
    ).toThrow(/PII-like/);
  });

  test("rejects SharePoint /personal/alice_contoso_onmicrosoft_com path", () => {
    expect(() =>
      assertNoPii(
        nav([
          "OneDrive",
          "/personal/alice_contoso_onmicrosoft_com/Documents",
        ]),
        m365
      )
    ).toThrow(/PII-like/);
  });

  test("rejects Graph eTag / OData id string", () => {
    // Long mixed-case base64-ish id with uppercase prefix.
    const odata = "AAMkAGI2NGVhZTI4LTBmMjYtNDI2NS05NGEzLTEyMzQ1Njc4OTA=";
    expect(() => assertNoPii(quirk(`etag is ${odata}`), m365)).toThrow(
      /PII-like/
    );
  });
});

describe("PR6 — corporate_google positive matches", () => {
  const google = { packs: ["corporate_google"] };

  test("rejects user@domain.com (baseline Email also catches this)", () => {
    expect(() =>
      assertNoPii(quirk("sharing with bob@example.com"), google)
    ).toThrow(/PII-like/);
  });

  test("rejects Drive folder id", () => {
    const folderId = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
    expect(() =>
      assertNoPii(quirk(`drive folder ${folderId} is shared`), google)
    ).toThrow(/PII-like/);
  });
});

describe("PR6 — corporate_atlassian positive matches", () => {
  const atl = { packs: ["corporate_atlassian"] };

  test("rejects cloudId GUID", () => {
    expect(() =>
      assertNoPii(
        quirk("cloudId aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee exists"),
        atl
      )
    ).toThrow(/PII-like/);
  });

  test("rejects accountId (24-char hex)", () => {
    expect(() =>
      assertNoPii(
        quirk("accountId 5b10a2844c20165700ede21g".replace("g", "f")),
        atl
      )
    ).toThrow(/PII-like/);
  });
});

describe("PR6 — negative matches (benign strings must pass)", () => {
  const m365 = { packs: ["corporate_m365"] };

  test("corporate_m365 allows 'Sign in with Microsoft' button label", () => {
    expect(() => assertNoPii(quirk("Click Sign in with Microsoft"), m365)).not.toThrow();
  });

  test("corporate_m365 allows 'Task card in Development column'", () => {
    expect(() =>
      assertNoPii(quirk("Task card in Development column"), m365)
    ).not.toThrow();
  });

  test("nav_node with harmless breadcrumb passes under all packs", () => {
    const entry = nav(["Planner", "Plans", "Board view"]);
    expect(() => assertNoPii(entry)).not.toThrow();
    expect(() => assertNoPii(entry, { packs: ["corporate_m365"] })).not.toThrow();
    expect(() => assertNoPii(entry, { packs: ["corporate_google"] })).not.toThrow();
    expect(() => assertNoPii(entry, { packs: ["corporate_atlassian"] })).not.toThrow();
  });
});

describe("PR6 — pack composition", () => {
  test("packs are additive-only: opting in never relaxes default pattern rejections", () => {
    // A baseline-caught value (JWT) must still be rejected under every pack
    // combination — packs only add, never remove, triggers.
    const jwt = quirk("token=eyJabc.eyJdef.ghi_klm");
    expect(() => assertNoPii(jwt)).toThrow(/PII-like/);
    expect(() => assertNoPii(jwt, { packs: ["corporate_m365"] })).toThrow(
      /PII-like/
    );
    expect(() => assertNoPii(jwt, { packs: ["corporate_google"] })).toThrow(
      /PII-like/
    );
    expect(() =>
      assertNoPii(jwt, {
        packs: ["corporate_m365", "corporate_google", "corporate_atlassian"],
      })
    ).toThrow(/PII-like/);
  });

  test("pii_patterns on a connector applies to that connector's learning only", () => {
    // Scope is per-call: an m365-only string passes without packs, rejects
    // under m365 pack, and passes again when the next call omits the pack.
    const teamsUrl = quirk(
      "shortlink https://teams.microsoft.com/l/meetup-join/xyz"
    );
    expect(() => assertNoPii(teamsUrl)).not.toThrow();
    expect(() => assertNoPii(teamsUrl, { packs: ["corporate_m365"] })).toThrow(
      /PII-like/
    );
    expect(() => assertNoPii(teamsUrl, { packs: [] })).not.toThrow();
  });

  test("unknown pack name throws (no silent pass-through)", () => {
    expect(() =>
      assertNoPii(quirk("benign text"), { packs: ["corporate_nonexistent"] })
    ).toThrow(/Unknown pii_patterns pack/);
  });
});
