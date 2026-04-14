/**
 * Credential Vault
 *
 * Wraps the system keychain (macOS Keychain, Windows Credential Manager,
 * Linux libsecret) via `@napi-rs/keyring`. Credentials are stored
 * per-plugin and never leave the local machine.
 *
 * Service name format: "openconnectors/<plugin-id>"
 */

import { Entry } from "@napi-rs/keyring";

const SERVICE_PREFIX = "openconnectors";

/** Build the keychain service name for a given plugin. */
function serviceName(pluginId: string): string {
  return `${SERVICE_PREFIX}/${pluginId}`;
}

export class CredentialVault {
  /**
   * Store a credential in the system keychain.
   *
   * @param pluginId - Plugin identifier (e.g. "mock-bank")
   * @param key      - Credential key (e.g. "username", "password")
   * @param value    - Secret value — stored encrypted by the OS keychain
   */
  async set(pluginId: string, key: string, value: string): Promise<void> {
    const entry = new Entry(serviceName(pluginId), key);
    entry.setPassword(value);
  }

  /**
   * Retrieve a credential from the system keychain.
   *
   * @returns The secret value, or `null` if not found.
   */
  async get(pluginId: string, key: string): Promise<string | null> {
    try {
      const entry = new Entry(serviceName(pluginId), key);
      return entry.getPassword();
    } catch {
      return null;
    }
  }

  /**
   * Delete a single credential.
   *
   * @returns `true` if the credential existed and was deleted.
   */
  async delete(pluginId: string, key: string): Promise<boolean> {
    try {
      const entry = new Entry(serviceName(pluginId), key);
      entry.deletePassword();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove all credentials stored for a plugin.
   * Requires knowing the credential keys from the manifest.
   *
   * @param keys - Credential keys to clear (from manifest.credentials[].key)
   * @returns The number of credentials deleted.
   */
  async clearAll(pluginId: string, keys?: string[]): Promise<number> {
    if (!keys || keys.length === 0) return 0;
    let deleted = 0;
    for (const key of keys) {
      if (await this.delete(pluginId, key)) {
        deleted++;
      }
    }
    return deleted;
  }
}
