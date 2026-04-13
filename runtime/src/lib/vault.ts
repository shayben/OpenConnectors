/**
 * Credential Vault
 *
 * Wraps the system keychain (macOS Keychain, Windows Credential Manager,
 * Linux libsecret) via `keytar`. Credentials are stored per-plugin and
 * never leave the local machine.
 *
 * Service name format: "openconnectors/<plugin-id>"
 */

import keytar from "keytar";

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
    await keytar.setPassword(serviceName(pluginId), key, value);
  }

  /**
   * Retrieve a credential from the system keychain.
   *
   * @returns The secret value, or `null` if not found.
   */
  async get(pluginId: string, key: string): Promise<string | null> {
    return keytar.getPassword(serviceName(pluginId), key);
  }

  /**
   * List all credential keys stored for a plugin.
   *
   * @returns Array of `{ account, password }` entries.
   */
  async list(
    pluginId: string
  ): Promise<Array<{ account: string; password: string }>> {
    return keytar.findCredentials(serviceName(pluginId));
  }

  /**
   * Delete a single credential.
   *
   * @returns `true` if the credential existed and was deleted.
   */
  async delete(pluginId: string, key: string): Promise<boolean> {
    return keytar.deletePassword(serviceName(pluginId), key);
  }

  /**
   * Remove all credentials stored for a plugin.
   *
   * @returns The number of credentials deleted.
   */
  async clearAll(pluginId: string): Promise<number> {
    const credentials = await this.list(pluginId);
    let deleted = 0;
    for (const cred of credentials) {
      if (await this.delete(pluginId, cred.account)) {
        deleted++;
      }
    }
    return deleted;
  }
}
