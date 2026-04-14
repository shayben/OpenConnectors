/**
 * CLI: openconnectors list
 *
 * Lists all available connectors from the connectors/ directory.
 */

import { ConnectorLoader } from "../lib/connector-loader.js";
import { CredentialVault } from "../lib/vault.js";

export async function listCommand(): Promise<void> {
  try {
    const loader = new ConnectorLoader();
    const vault = new CredentialVault();
    const all = await loader.list();

    if (all.length === 0) {
      console.log(`No connectors found in ${loader.directory}`);
      return;
    }

    console.log(`Available connectors (${all.length}):\n`);

    for (const { connector } of all) {
      const required = connector.credentials.filter((c) => !c.optional);
      let credsReady = true;
      for (const cred of required) {
        const v = await vault.get(connector.id, cred.key);
        if (!v) {
          credsReady = false;
          break;
        }
      }
      const credStatus = required.length === 0
        ? ""
        : credsReady
          ? " [credentials set]"
          : " [missing credentials]";

      console.log(`  ${connector.id}${credStatus}`);
      console.log(`    ${connector.name} — ${connector.institution.url}`);
      console.log(`    ${connector.description}`);
      console.log(
        `    Actions: ${connector.actions.map((a) => a.name).join(", ")}`
      );
      console.log();
    }
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  }
}
