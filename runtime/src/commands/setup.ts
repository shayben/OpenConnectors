/**
 * CLI: openconnectors setup [connector]
 *
 * First-run experience: interactively walk through connectors and prompt
 * for any missing credentials. Values are read with hidden input and
 * stored in the OS keychain.
 *
 * Usage:
 *   openconnectors setup                 # menu — pick a connector, or 'all'
 *   openconnectors setup pension-more    # set up one connector
 *   openconnectors setup --all           # set up all connectors with missing creds
 */

import { ConnectorLoader, type LoadedConnector } from "../lib/connector-loader.js";
import { CredentialVault } from "../lib/vault.js";
import { promptSecret, promptLine } from "../lib/prompt.js";
import type { Connector } from "../lib/connector-schema.js";

interface SetupOptions {
  all?: boolean;
  /** Overwrite existing credentials instead of skipping them. */
  force?: boolean;
}

/** Status of a connector's credentials in the vault. */
interface CredentialStatus {
  missing: string[];
  set: string[];
  total: number;
}

async function getStatus(
  vault: CredentialVault,
  connector: Connector
): Promise<CredentialStatus> {
  const status: CredentialStatus = {
    missing: [],
    set: [],
    total: connector.credentials.filter((c) => !c.optional).length,
  };
  for (const cred of connector.credentials) {
    const value = await vault.get(connector.id, cred.key);
    if (value) status.set.push(cred.key);
    else if (!cred.optional) status.missing.push(cred.key);
  }
  return status;
}

/**
 * Walk through a single connector's credentials, prompting for each.
 * Skips credentials that are already set unless `force` is true.
 */
async function setupOne(
  vault: CredentialVault,
  connector: Connector,
  force: boolean
): Promise<{ stored: number; skipped: number }> {
  console.log(`\n── ${connector.name} (${connector.id}) ──`);
  console.log(`   ${connector.institution.url}`);

  let stored = 0;
  let skipped = 0;

  for (const cred of connector.credentials) {
    const existing = await vault.get(connector.id, cred.key);
    if (existing && !force) {
      console.log(`   ${cred.key}: already set (skipping — use --force to overwrite)`);
      skipped++;
      continue;
    }

    const optionalTag = cred.optional ? " (optional, press Enter to skip)" : "";
    const value = await promptSecret(`   ${cred.label}${optionalTag}: `);

    if (!value) {
      if (cred.optional) {
        console.log(`   ${cred.key}: skipped`);
        skipped++;
        continue;
      }
      console.log(`   ${cred.key}: empty value — skipped`);
      skipped++;
      continue;
    }

    await vault.set(connector.id, cred.key, value);
    stored++;
  }

  return { stored, skipped };
}

/** Show a numbered menu of connectors and their credential status. */
function printMenu(
  all: LoadedConnector[],
  statuses: Map<string, CredentialStatus>
): void {
  console.log("\nConfigure credentials for which connector?\n");
  all.forEach(({ connector }, i) => {
    const status = statuses.get(connector.id)!;
    let tag: string;
    if (status.missing.length === 0 && status.set.length === 0) {
      tag = "no credentials needed";
    } else if (status.missing.length === 0) {
      tag = `configured (${status.set.length}/${status.total})`;
    } else {
      tag = `missing: ${status.missing.join(", ")}`;
    }
    console.log(`  ${String(i + 1).padStart(2)}. ${connector.id.padEnd(20)} [${tag}]`);
  });
  console.log(`   a. all  (configure every connector with missing credentials)`);
  console.log(`   q. quit`);
}

export async function setupCommand(
  connectorId: string | undefined,
  options: SetupOptions
): Promise<void> {
  try {
    const loader = new ConnectorLoader();
    const vault = new CredentialVault();
    const all = await loader.list();

    if (all.length === 0) {
      console.log(`No connectors found in ${loader.directory}`);
      return;
    }

    // --- Explicit connector id: set up just that one ---
    if (connectorId) {
      const { connector } = await loader.get(connectorId);
      const { stored, skipped } = await setupOne(
        vault,
        connector,
        options.force ?? false
      );
      console.log(`\nDone. Stored ${stored}, skipped ${skipped}.`);
      return;
    }

    // --- --all flag: set up every connector with missing credentials ---
    if (options.all) {
      let totalStored = 0;
      let totalSkipped = 0;
      for (const { connector } of all) {
        const status = await getStatus(vault, connector);
        if (status.missing.length === 0 && !options.force) continue;
        const { stored, skipped } = await setupOne(
          vault,
          connector,
          options.force ?? false
        );
        totalStored += stored;
        totalSkipped += skipped;
      }
      console.log(`\nDone. Stored ${totalStored}, skipped ${totalSkipped}.`);
      return;
    }

    // --- Interactive menu ---
    const statuses = new Map<string, CredentialStatus>();
    for (const { connector } of all) {
      statuses.set(connector.id, await getStatus(vault, connector));
    }

    printMenu(all, statuses);

    const choice = await promptLine("\n> ");
    const trimmed = choice.toLowerCase();

    if (!trimmed || trimmed === "q" || trimmed === "quit") {
      console.log("Cancelled.");
      return;
    }

    if (trimmed === "a" || trimmed === "all") {
      await setupCommand(undefined, { ...options, all: true });
      return;
    }

    const num = parseInt(trimmed, 10);
    let selected: LoadedConnector | undefined;
    if (!isNaN(num) && num >= 1 && num <= all.length) {
      selected = all[num - 1];
    } else {
      selected = all.find((c) => c.connector.id === trimmed);
    }

    if (!selected) {
      console.error(`Unknown choice: ${choice}`);
      process.exitCode = 1;
      return;
    }

    const { stored, skipped } = await setupOne(
      vault,
      selected.connector,
      options.force ?? false
    );
    console.log(`\nDone. Stored ${stored}, skipped ${skipped}.`);
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  }
}
