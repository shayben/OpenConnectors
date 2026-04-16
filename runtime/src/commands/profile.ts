/**
 * `openconnectors profile ...` subcommand (PR2).
 *
 * Minimal profile management CLI. The bulk of profile lifecycle lives in
 * ProfileManager; this file is just a thin adapter for humans.
 */

import { ProfileManager } from "../lib/profile-manager.js";

export function profileStatusCommand(profileId: string): void {
  const pm = new ProfileManager();
  const status = pm.probe(profileId);
  process.stdout.write(JSON.stringify(status, null, 2) + "\n");
}

export function profileListAllowCommand(profileId: string): void {
  const pm = new ProfileManager();
  const list = pm.getAllowlist(profileId);
  if (list.length === 0) {
    process.stdout.write(
      `(profile '${profileId}' has no allowlist yet — first-run bootstrapping)\n`
    );
    return;
  }
  for (const d of list) process.stdout.write(d + "\n");
}

export function profileRevokeCommand(profileId: string, domain: string): void {
  const pm = new ProfileManager();
  const before = pm.getAllowlist(profileId);
  const after = pm.revokeDomain(profileId, domain);
  if (before.length === after.length) {
    process.stderr.write(
      `No change: '${domain}' (eTLD+1) was not on profile '${profileId}' allowlist.\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Revoked '${domain}' from profile '${profileId}'. ${after.length} domain(s) remain.\n`
  );
}
