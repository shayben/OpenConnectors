/**
 * @openconnectors/runtime
 *
 * Public API for programmatic usage of the OpenConnectors runtime.
 */

export { CredentialVault } from "./lib/vault.js";
export { PluginManager } from "./lib/plugin-manager.js";
export { loadRegistry, type RegistryEntry } from "./lib/registry.js";
export {
  PluginManifestSchema,
  type PluginManifest,
} from "./lib/manifest.js";
