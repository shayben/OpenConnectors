/**
 * CLI: openconnectors vault set|clear
 *
 * Manage credentials stored in the system keychain.
 * Credentials are scoped per-connector and never leave the machine.
 */

import { createInterface } from "node:readline";
import { CredentialVault } from "../lib/vault.js";
import { ConnectorLoader } from "../lib/connector-loader.js";

/**
 * Prompt the user for a secret value (hidden input via terminal raw mode).
 * Falls back to visible input if raw mode is unavailable.
 */
async function promptSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    if (process.stdin.isTTY) {
      process.stderr.write(prompt);
      process.stdin.setRawMode?.(true);

      let value = "";
      const onData = (data: Buffer) => {
        const char = data.toString("utf-8");

        if (char === "\n" || char === "\r") {
          process.stdin.setRawMode?.(false);
          process.stdin.removeListener("data", onData);
          process.stderr.write("\n");
          rl.close();
          resolve(value);
        } else if (char === "\u0003") {
          process.stdin.setRawMode?.(false);
          rl.close();
          process.exit(130);
        } else if (char === "\u007F" || char === "\b") {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      };
      process.stdin.on("data", onData);
    } else {
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

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
      // Load the connector YAML to discover credential keys
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
