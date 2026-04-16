/**
 * PII guard — unit vectors for the current pattern set.
 *
 * When PR6 adds enterprise packs (corporate_m365 / corporate_google /
 * corporate_atlassian) this file grows to cover those. For now the vectors
 * document the v0.1 surface so no PR silently relaxes the defaults.
 */

import { describe, it, expect } from "vitest";
import {
  assertNoPii,
  normalizePath,
  type LearnEntry,
} from "../learning.js";

function quirk(text: string): LearnEntry {
  return { kind: "quirk", text } as LearnEntry;
}

describe("PII guard — v0.1 baseline vectors (must reject)", () => {
  const reject: Array<[string, string]> = [
    ["Israeli ID", "Customer 123456789 was blocked at login screen"],
    ["Israeli mobile", "Contact 054-1234567 for account activation"],
    ["International phone", "Dial +14155551234 for agent support"],
    ["JWT", "header eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.abcdef"],
    ["URL with credentials", "deep link https://user:pass@example.com/login worked"],
    ["URL with token param", "hit /api?access_token=supersecrettoken1234 please"],
    ["Email", "escalate to user@example.com for help"],
    ["UUID in path", "visit /account/550e8400-e29b-41d4-a716-446655440000/details"],
    ["Numeric id in path", "routed via /account/1234567/details path earlier"],
    ["Currency with symbol", "Balance was 1,234.56 ₪ when pending"],
  ];

  it.each(reject)("rejects %s", (_name, text) => {
    expect(() => assertNoPii(quirk(text))).toThrow(/PII-like/);
  });
});

describe("PII guard — benign strings (must pass)", () => {
  const allow: string[] = [
    "Click the Add task button in the Development bucket",
    "Navigate to /transactions and wait for the table to render",
    "Board view is required for Add task to appear",
    "Switch to Grid view before deleting rows from the list",
    "aria-label starts with Task card prefix consistently",
    "Version one point zero of the API endpoint shape",
    "HTTP two hundred on /api/v1/tasks endpoint response",
  ];

  it.each(allow.map((s) => [s] as const))("accepts: %s", (text) => {
    expect(() => assertNoPii(quirk(text))).not.toThrow();
  });
});

describe("normalizePath — templates numeric/uuid/hex segments", () => {
  const vectors: Array<[string, string]> = [
    ["https://bank.example.com/account/1234567/txns", "/account/:id/txns"],
    ["https://bank.example.com/u/550e8400-e29b-41d4-a716-446655440000", "/u/:id"],
    ["https://a.b.com/path/abcdef0123456789/end", "/path/:id/end"],
    ["https://a.b.com/plain/text", "/plain/text"],
    ["https://a.b.com/short/ab", "/short/ab"],
    ["https://a.b.com/", "/"],
  ];

  it.each(vectors)("%s → %s", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it("returns null for garbage input", () => {
    expect(normalizePath("not a url at all")).toBeNull();
    expect(normalizePath("")).toBeNull();
  });
});
