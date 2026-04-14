/**
 * CLI: openconnectors vault set|clear
 *
 * Manage credentials stored in the system keychain.
 * Credentials are scoped per-plugin and never leave the machine.
 */

import { createInterface } from "node:readline";
import { CredentialVault } from "../lib/vault.js";
import { PluginManager } from "../lib/plugin-manager.js";

/**
 * Prompt the user for a secret value (hidden input via terminal raw mode).
 * Falls back to visible input if raw mode is unavailable (e.g. piped stdin).
 */
async function promptSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    // Attempt to hide input by disabling echo
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
          // Ctrl+C
          process.stdin.setRawMode?.(false);
          rl.close();
          process.exit(130);
        } else if (char === "\u007F" || char === "\b") {
          // Backspace
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      };
      process.stdin.on("data", onData);
    } else {
      // Non-interactive fallback
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

/**
 * `openconnectors vault set <plugin> <key>`
 *
 * Stores a credential securely in the system keychain.
 */
export async function vaultSetCommand(
  pluginId: string,
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
    await vault.set(pluginId, key, value);

    console.log(`Credential "${key}" stored for plugin "${pluginId}".`);
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  }
}

/**
 * `openconnectors vault clear <plugin> [--key <key>]`
 *
 * Removes credentials from the system keychain.
 */
export async function vaultClearCommand(
  pluginId: string,
  options: { key?: string }
): Promise<void> {
  try {
    const vault = new CredentialVault();

    if (options.key) {
      const deleted = await vault.delete(pluginId, options.key);
      if (deleted) {
        console.log(
          `Credential "${options.key}" removed for plugin "${pluginId}".`
        );
      } else {
        console.log(
          `No credential "${options.key}" found for plugin "${pluginId}".`
        );
      }
    } else {
      // Load the plugin manifest to discover all credential keys
      const manager = new PluginManager();
      const { manifest } = await manager.resolve(pluginId);
      const keys = manifest.credentials.map((c) => c.key);
      const count = await vault.clearAll(pluginId, keys);
      console.log(
        `Removed ${count} credential(s) for plugin "${pluginId}".`
      );
    }
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  }
}
