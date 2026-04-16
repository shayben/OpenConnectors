/**
 * Profile Manager — PR2.
 *
 * Handles per-connector persistent browser profiles for
 * `auth: { type: persistent_profile }` connectors. The profile directory
 * persists cookies + localStorage so that a user who manually signs into
 * (e.g.) Microsoft 365 once stays signed in on subsequent runs — the
 * framework never sees credentials for these connectors.
 *
 * Responsibilities:
 *   - Resolve a stable per-OS profile directory (overridable for tests /
 *     power users).
 *   - Detect Chromium's SingletonLock so we fail cleanly if another
 *     instance is already attached to the profile.
 *   - Enforce an eTLD+1 allowlist so a compromised or misbehaving
 *     connector can't silently navigate a signed-in session to an
 *     arbitrary domain.
 *   - Report a coarse-grained probe state (never_run | ok | expired |
 *     locked) for `auth_status`.
 *
 * Everything here is pure filesystem / string manipulation — no browser
 * launch. PR4+ consume the resolved directory and allowlist when
 * actually spawning Playwright.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, posix, win32 } from "node:path";

export type ProbeStatus = "never_run" | "ok" | "expired" | "locked";

export interface ProfileStatus {
  profile_id: string;
  profile_dir: string;
  profile_exists: boolean;
  locked: boolean;
  last_used_ms: number | null;
  allowed_domains: string[];
  probe_status: ProbeStatus;
}

export interface ProfileManagerOptions {
  /** Base directory under which individual profiles are stored. If omitted,
   *  resolves per-OS (see resolveDefaultProfilesRoot). */
  rootDir?: string;
  /** Override the env var lookup (useful for tests). */
  env?: NodeJS.ProcessEnv;
  /** Override the OS (useful for tests). Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Override home dir (useful for tests). */
  homeDir?: string;
}

const ALLOWLIST_FILE = ".oc-allowlist.json";
const LAST_USED_FILE = ".oc-last-used";
/** Chromium writes this when a browser instance is attached. */
const SINGLETON_LOCK = "SingletonLock";
/** Windows doesn't use SingletonLock; it leaves a lockfile on the user data dir. */
const SINGLETON_LOCK_WIN = "lockfile";

interface AllowlistFile {
  domains: string[];
}

/** Strip credentials + path, lowercase, return eTLD+1-ish host (last 2 labels,
 *  or last 3 for well-known public suffixes like .co.uk, .com.au).
 *
 *  Keep this simple — we're not shipping the PSL. The intent is "block a
 *  connector spec that hardcodes example.com from ever navigating to
 *  attacker.net", not to be bulletproof against domain-hack attacks.
 */
export function eTldPlusOne(urlOrHost: string): string {
  let host: string;
  try {
    host = new URL(urlOrHost).hostname;
  } catch {
    host = urlOrHost;
  }
  host = host.toLowerCase().replace(/^\.+|\.+$/g, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;

  // Two-label public suffixes we care about in practice.
  const twoLabelTlds = new Set([
    "co.uk", "co.il", "co.jp", "co.kr", "co.in", "co.za", "co.nz",
    "com.au", "com.br", "com.mx", "com.sg", "com.tr", "com.hk",
    "ac.uk", "ac.il", "org.uk", "gov.uk", "net.au", "edu.au",
  ]);
  const tail2 = labels.slice(-2).join(".");
  if (twoLabelTlds.has(tail2) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return tail2;
}

export function resolveDefaultProfilesRoot(
  plat: NodeJS.Platform = platform(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const override = env.OPENCONNECTORS_PROFILES_DIR;
  if (override && override.trim()) return override.trim();

  const p = plat === "win32" ? win32 : posix;
  switch (plat) {
    case "win32": {
      const localAppData = env.LOCALAPPDATA || p.join(home, "AppData", "Local");
      return p.join(localAppData, "OpenConnectors", "profiles");
    }
    case "darwin":
      return p.join(home, "Library", "Application Support", "OpenConnectors", "profiles");
    default:
      // linux, freebsd, etc.
      return p.join(env.XDG_CONFIG_HOME || p.join(home, ".config"), "openconnectors", "profiles");
  }
}

export class ProfileManager {
  private readonly rootDir: string;
  private readonly plat: NodeJS.Platform;

  constructor(opts: ProfileManagerOptions = {}) {
    this.plat = opts.platform ?? platform();
    this.rootDir =
      opts.rootDir ??
      resolveDefaultProfilesRoot(this.plat, opts.env ?? process.env, opts.homeDir ?? homedir());
  }

  get root(): string {
    return this.rootDir;
  }

  profileDir(profileId: string): string {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(profileId)) {
      throw new Error(
        `Invalid profile_id: ${JSON.stringify(profileId)} — must match /^[a-z0-9][a-z0-9_-]*$/i`
      );
    }
    return join(this.rootDir, profileId);
  }

  /** True if the profile directory already exists on disk. */
  exists(profileId: string): boolean {
    return existsSync(this.profileDir(profileId));
  }

  /** Chromium (and Edge, Chrome) writes SingletonLock / lockfile when a
   *  browser instance has the user-data-dir open. Detect it so we can
   *  surface a clean error instead of a Playwright launch crash. */
  isLocked(profileId: string): boolean {
    const dir = this.profileDir(profileId);
    if (!existsSync(dir)) return false;
    if (existsSync(join(dir, SINGLETON_LOCK))) return true;
    if (this.plat === "win32" && existsSync(join(dir, SINGLETON_LOCK_WIN))) return true;
    return false;
  }

  /** Ensure the directory tree exists. Does NOT create any browser state. */
  ensureDir(profileId: string): string {
    const dir = this.profileDir(profileId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ---------- allowlist ----------

  private allowlistPath(profileId: string): string {
    return join(this.profileDir(profileId), ALLOWLIST_FILE);
  }

  /** Read the eTLD+1 allowlist for this profile. Empty array if none yet. */
  getAllowlist(profileId: string): string[] {
    const path = this.allowlistPath(profileId);
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AllowlistFile>;
      if (!parsed.domains || !Array.isArray(parsed.domains)) return [];
      return parsed.domains.map(String);
    } catch {
      return [];
    }
  }

  setAllowlist(profileId: string, domains: string[]): void {
    const dir = this.ensureDir(profileId);
    const payload: AllowlistFile = {
      domains: Array.from(new Set(domains.map((d) => eTldPlusOne(d)))).sort(),
    };
    writeFileSync(join(dir, ALLOWLIST_FILE), JSON.stringify(payload, null, 2) + "\n", "utf-8");
  }

  /** Add a domain (or full URL — we reduce to eTLD+1). Returns the new list. */
  allowDomain(profileId: string, urlOrDomain: string): string[] {
    const next = new Set(this.getAllowlist(profileId));
    next.add(eTldPlusOne(urlOrDomain));
    const list = Array.from(next).sort();
    this.setAllowlist(profileId, list);
    return list;
  }

  /** Remove a domain from the allowlist. Returns the new list. */
  revokeDomain(profileId: string, urlOrDomain: string): string[] {
    const target = eTldPlusOne(urlOrDomain);
    const next = this.getAllowlist(profileId).filter((d) => d !== target);
    this.setAllowlist(profileId, next);
    return next;
  }

  /** True iff `urlOrDomain`'s eTLD+1 is on the profile's allowlist.
   *  An empty allowlist is "bootstrapping" — caller decides whether to
   *  treat that as allow-everything-on-first-run or deny. Our convention:
   *  empty === bootstrapping, so return true. Once setAllowlist has been
   *  called explicitly, the list is authoritative. */
  isAllowed(profileId: string, urlOrDomain: string): boolean {
    const list = this.getAllowlist(profileId);
    if (list.length === 0) return true;
    return list.includes(eTldPlusOne(urlOrDomain));
  }

  // ---------- last_used / probe ----------

  private lastUsedPath(profileId: string): string {
    return join(this.profileDir(profileId), LAST_USED_FILE);
  }

  markUsed(profileId: string, when: number = Date.now()): void {
    const dir = this.ensureDir(profileId);
    writeFileSync(join(dir, LAST_USED_FILE), String(when), "utf-8");
  }

  lastUsedMs(profileId: string): number | null {
    const path = this.lastUsedPath(profileId);
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, "utf-8").trim();
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    } catch {
      /* fall through */
    }
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  }

  /** Coarse-grained heuristic probe for `auth_status`. The real
   *  `expiry_probe` runs in-browser during a session — this is a *disk*
   *  probe that the runtime can answer before launching anything. */
  probe(profileId: string, expiryMs: number = 1000 * 60 * 60 * 24 * 30): ProfileStatus {
    const profile_dir = this.profileDir(profileId);
    const profile_exists = existsSync(profile_dir);
    const locked = this.isLocked(profileId);
    const last_used_ms = this.lastUsedMs(profileId);
    const allowed_domains = this.getAllowlist(profileId);

    let probe_status: ProbeStatus;
    if (locked) {
      probe_status = "locked";
    } else if (!profile_exists || last_used_ms === null) {
      probe_status = "never_run";
    } else if (Date.now() - last_used_ms > expiryMs) {
      probe_status = "expired";
    } else {
      probe_status = "ok";
    }

    return {
      profile_id: profileId,
      profile_dir,
      profile_exists,
      locked,
      last_used_ms,
      allowed_domains,
      probe_status,
    };
  }
}
