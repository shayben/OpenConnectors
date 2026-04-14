/**
 * CLI: openconnectors vault set|clear
 *
 * Manage credentials stored in the system keychain.
 * Credentials are scoped per-connector and never leave the machine.
 */

import { CredentialVault } from "../lib/vault.js";
import { ConnectorLoader } from "../lib/connector-loader.js";
import { promptSecret } from "../lib/prompt.js";

/** `openconnectors vault set <connector> <key>` */
export async function vaultSetCommand(
  connectorId: string,
  key: string
): Promise<void> {
  try {
    const value = await promptSecret(`Enter value for "${key}": `);

    if (!value) {
      console.error("Error: Empty value. Credential not stored.");
      process.exitCode = 1;
      return;
    }

    const vault = new CredentialVault();
    await vault.set(connectorId, key, value);

    console.log(`Credential "${key}" stored for connector "${connectorId}".`);
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  }
}

/** `openconnectors vault clear <connector> [--key <key>]` */
export async function vaultClearCommand(
  connectorId: string,
  options: { key?: string }
): Promise<void> {
  try {
    const vault = new CredentialVault();

    if (options.key) {
      const deleted = await vault.delete(connectorId, options.key);
      if (deleted) {
        console.log(
          `Credential "${options.key}" removed for connector "${connectorId}".`
        );
      } else {
        console.log(
          `No credential "${options.key}" found for connector "${connectorId}".`
        );
      }
    } else {
      const loader = new ConnectorLoader();
      const { connector } = await loader.get(connectorId);
      const keys = connector.credentials.map((c) => c.key);
      const count = await vault.clearAll(connectorId, keys);
      console.log(
        `Removed ${count} credential(s) for connector "${connectorId}".`
      );
    }
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  }
}
