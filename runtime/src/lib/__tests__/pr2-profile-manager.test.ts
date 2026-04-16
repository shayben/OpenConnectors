/**
 * PR2 — profile manager + persistent_profile auth.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProfileManager,
  resolveDefaultProfilesRoot,
  eTldPlusOne,
} from "../profile-manager.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "oc-pr2-"));
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// -------------------- Per-OS resolution --------------------

describe("PR2 — default profile root (per-OS)", () => {
  it("Windows -> %LOCALAPPDATA%/OpenConnectors/profiles", () => {
    const root = resolveDefaultProfilesRoot(
      "win32",
      { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" },
      "C:\\Users\\x"
    );
    expect(root).toMatch(/OpenConnectors[\\/]profiles$/);
    expect(root.toLowerCase()).toContain("appdata");
  });

  it("macOS -> ~/Library/Application Support/OpenConnectors/profiles", () => {
    const root = resolveDefaultProfilesRoot("darwin", {}, "/Users/x");
    expect(root).toBe("/Users/x/Library/Application Support/OpenConnectors/profiles");
  });

  it("linux (no XDG) -> ~/.config/openconnectors/profiles", () => {
    const root = resolveDefaultProfilesRoot("linux", {}, "/home/x");
    expect(root).toBe("/home/x/.config/openconnectors/profiles");
  });

  it("linux (XDG set) -> $XDG_CONFIG_HOME/openconnectors/profiles", () => {
    const root = resolveDefaultProfilesRoot("linux", { XDG_CONFIG_HOME: "/tmp/cfg" }, "/home/x");
    expect(root).toBe("/tmp/cfg/openconnectors/profiles");
  });

  it("OPENCONNECTORS_PROFILES_DIR takes precedence on every OS", () => {
    const forced = "/my/custom/profiles";
    expect(
      resolveDefaultProfilesRoot("win32", { OPENCONNECTORS_PROFILES_DIR: forced }, "C:\\x")
    ).toBe(forced);
    expect(
      resolveDefaultProfilesRoot("darwin", { OPENCONNECTORS_PROFILES_DIR: forced }, "/u/x")
    ).toBe(forced);
    expect(
      resolveDefaultProfilesRoot("linux", { OPENCONNECTORS_PROFILES_DIR: forced }, "/home/x")
    ).toBe(forced);
  });
});

// -------------------- eTLD+1 reduction --------------------

describe("PR2 — eTLD+1 reduction", () => {
  it("full URL -> hostname -> eTLD+1", () => {
    expect(eTldPlusOne("https://tasks.office.com/tenant/Home/Planner")).toBe("office.com");
    expect(eTldPlusOne("https://dev.azure.com/MyOrg/_apis/wit")).toBe("azure.com");
  });

  it("already a 2-label host is returned unchanged", () => {
    expect(eTldPlusOne("example.com")).toBe("example.com");
  });

  it("two-label public suffixes kept as 3-label", () => {
    expect(eTldPlusOne("https://www.example.co.uk/foo")).toBe("example.co.uk");
    expect(eTldPlusOne("subdomain.service.co.il")).toBe("service.co.il");
    expect(eTldPlusOne("bank.com.au")).toBe("bank.com.au");
  });

  it("is case-insensitive", () => {
    expect(eTldPlusOne("HTTPS://Tasks.OFFICE.com/")).toBe("office.com");
  });
});

// -------------------- profileDir + validation --------------------

describe("PR2 — profileDir", () => {
  it("rejects invalid profile_id", () => {
    const pm = new ProfileManager({ rootDir: tmp });
    expect(() => pm.profileDir("../escape")).toThrow();
    expect(() => pm.profileDir("with spaces")).toThrow();
    expect(() => pm.profileDir("")).toThrow();
  });

  it("accepts snake/kebab/alnum profile ids", () => {
    const pm = new ProfileManager({ rootDir: tmp });
    expect(() => pm.profileDir("m365")).not.toThrow();
    expect(() => pm.profileDir("aad_corp")).not.toThrow();
    expect(() => pm.profileDir("work-profile")).not.toThrow();
  });

  it("returns a path under rootDir", () => {
    const pm = new ProfileManager({ rootDir: tmp });
    expect(pm.profileDir("m365").startsWith(tmp)).toBe(true);
  });
});

// -------------------- SingletonLock detection --------------------

describe("PR2 — SingletonLock", () => {
  it("isLocked=false when profile dir absent", () => {
    const pm = new ProfileManager({ rootDir: tmp });
    expect(pm.isLocked("m365")).toBe(false);
  });

  it("isLocked=true when SingletonLock present (posix)", () => {
    const pm = new ProfileManager({ rootDir: tmp, platform: "linux" });
    mkdirSync(join(tmp, "m365"), { recursive: true });
    writeFileSync(join(tmp, "m365", "SingletonLock"), "");
    expect(pm.isLocked("m365")).toBe(true);
  });

  it("isLocked=true when lockfile present on Windows", () => {
    const pm = new ProfileManager({ rootDir: tmp, platform: "win32" });
    mkdirSync(join(tmp, "m365"), { recursive: true });
    writeFileSync(join(tmp, "m365", "lockfile"), "");
    expect(pm.isLocked("m365")).toBe(true);
  });

  it("probe surfaces `locked` state", () => {
    const pm = new ProfileManager({ rootDir: tmp, platform: "linux" });
    pm.ensureDir("m365");
    writeFileSync(join(tmp, "m365", "SingletonLock"), "");
    pm.markUsed("m365"); // recent
    expect(pm.probe("m365").probe_status).toBe("locked");
  });
});

// -------------------- Allowlist --------------------

describe("PR2 — allowlist", () => {
  it("empty allowlist means bootstrapping -> everything allowed", () => {
    const pm = new ProfileManager({ rootDir: tmp });
    expect(pm.isAllowed("m365", "https://tasks.office.com")).toBe(true);
  });

  it("after setAllowlist, only listed eTLD+1s pass", () => {
    const pm = new ProfileManager({ rootDir: tmp });
    pm.setAllowlist("m365", ["office.com"]);
    expect(pm.isAllowed("m365", "https://tasks.office.com/xyz")).toBe(true);
    expect(pm.isAllowed("m365", "https://attacker.net/steal")).toBe(false);
  });

  it("allowDomain is idempotent and normalises URLs -> eTLD+1", () => {
    const pm = new ProfileManager({ rootDir: tmp });
    pm.allowDomain("m365", "https://tasks.office.com/foo");
    pm.allowDomain("m365", "https://login.office.com/bar");
    expect(pm.getAllowlist("m365")).toEqual(["office.com"]);
  });

  it("revokeDomain removes an entry", () => {
    const pm = new ProfileManager({ rootDir: tmp });
    pm.allowDomain("m365", "office.com");
    pm.allowDomain("m365", "microsoft.com");
    const remaining = pm.revokeDomain("m365", "https://www.microsoft.com/anything");
    expect(remaining).toEqual(["office.com"]);
    expect(pm.getAllowlist("m365")).toEqual(["office.com"]);
  });

  it("revokeDomain is safe when domain is not on the list", () => {
    const pm = new ProfileManager({ rootDir: tmp });
    pm.allowDomain("m365", "office.com");
    const before = pm.getAllowlist("m365").slice();
    const after = pm.revokeDomain("m365", "unknown.example");
    expect(after).toEqual(before);
  });

  it("openconnectors profile revoke removes from allowlist (CLI function)", async () => {
    process.env.OPENCONNECTORS_PROFILES_DIR = tmp;
    const pm = new ProfileManager({ rootDir: tmp });
    pm.allowDomain("m365", "office.com");
    pm.allowDomain("m365", "microsoft.com");

    const { profileRevokeCommand } = await import("../../commands/profile.js");
    profileRevokeCommand("m365", "https://www.microsoft.com/anything");

    expect(pm.getAllowlist("m365")).toEqual(["office.com"]);
    delete process.env.OPENCONNECTORS_PROFILES_DIR;
  });
});

// -------------------- Probe / status --------------------

describe("PR2 — probe / auth_status", () => {
  it("never_run when profile absent", () => {
    const pm = new ProfileManager({ rootDir: tmp });
    const s = pm.probe("m365");
    expect(s.probe_status).toBe("never_run");
    expect(s.profile_exists).toBe(false);
    expect(s.last_used_ms).toBeNull();
    expect(s.allowed_domains).toEqual([]);
  });

  it("ok when profile exists and was used within expiry window", () => {
    const pm = new ProfileManager({ rootDir: tmp });
    pm.ensureDir("m365");
    pm.markUsed("m365", Date.now() - 1000);
    expect(pm.probe("m365").probe_status).toBe("ok");
  });

  it("expired when last_used is older than the window", () => {
    const pm = new ProfileManager({ rootDir: tmp });
    pm.ensureDir("m365");
    pm.markUsed("m365", Date.now() - 1000 * 60 * 60 * 24 * 365);
    // 1 day window
    const status = pm.probe("m365", 1000 * 60 * 60 * 24);
    expect(status.probe_status).toBe("expired");
  });

  it("returned shape has all documented fields", () => {
    const pm = new ProfileManager({ rootDir: tmp });
    pm.ensureDir("m365");
    pm.allowDomain("m365", "office.com");
    pm.markUsed("m365");
    const s = pm.probe("m365");
    expect(Object.keys(s).sort()).toEqual(
      [
        "allowed_domains",
        "last_used_ms",
        "locked",
        "probe_status",
        "profile_dir",
        "profile_exists",
        "profile_id",
      ].sort()
    );
    expect(s.allowed_domains).toEqual(["office.com"]);
  });
});

// -------------------- ensureDir --------------------

describe("PR2 — ensureDir", () => {
  it("creates the profile directory idempotently", () => {
    const pm = new ProfileManager({ rootDir: tmp });
    const d = pm.ensureDir("m365");
    expect(existsSync(d)).toBe(true);
    // second call doesn't throw
    expect(() => pm.ensureDir("m365")).not.toThrow();
  });
});
