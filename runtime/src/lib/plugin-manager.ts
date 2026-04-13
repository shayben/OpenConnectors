/**
 * Plugin Manager
 *
 * Handles plugin installation, discovery, and execution.
 * Plugins are installed into a local directory and loaded
 * dynamically at runtime.
 */

import { readFile, readdir, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { PluginManifestSchema, type PluginManifest } from "./manifest.js";
import { loadRegistry, type RegistryEntry } from "./registry.js";

/** Default directory where plugins are installed locally. */
const DEFAULT_PLUGINS_DIR = join(
  process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".",
  ".openconnectors",
  "plugins"
);

const DEFAULT_REGISTRY_URL =
  "https://raw.githubusercontent.com/shayben/opencpnnectors/main/registry.json";

export interface InstalledPlugin {
  manifest: PluginManifest;
  path: string;
}

export class PluginManager {
  private readonly pluginsDir: string;
  private readonly registryUrl: string;

  constructor(options?: { pluginsDir?: string; registryUrl?: string }) {
    this.pluginsDir = options?.pluginsDir ?? DEFAULT_PLUGINS_DIR;
    this.registryUrl = options?.registryUrl ?? DEFAULT_REGISTRY_URL;
  }

  /**
   * Install a plugin by ID (from registry) or from a local path.
   *
   * When installing from registry, the plugin repository is cloned
   * and its dependencies are installed.
   */
  async install(pluginIdOrPath: string): Promise<InstalledPlugin> {
    await mkdir(this.pluginsDir, { recursive: true });

    // Local path — copy into managed directory
    if (
      existsSync(pluginIdOrPath) &&
      existsSync(join(pluginIdOrPath, "manifest.json"))
    ) {
      return this.installFromLocal(pluginIdOrPath);
    }

    // Otherwise look up in registry
    return this.installFromRegistry(pluginIdOrPath);
  }

  /** List all installed plugins with their manifests. */
  async list(): Promise<InstalledPlugin[]> {
    if (!existsSync(this.pluginsDir)) {
      return [];
    }

    const entries = await readdir(this.pluginsDir, { withFileTypes: true });
    const plugins: InstalledPlugin[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const manifestPath = join(this.pluginsDir, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const raw = await readFile(manifestPath, "utf-8");
        const manifest = PluginManifestSchema.parse(JSON.parse(raw));
        plugins.push({
          manifest,
          path: join(this.pluginsDir, entry.name),
        });
      } catch {
        // Skip plugins with invalid manifests — warn but don't crash
        console.warn(`Warning: Invalid manifest in ${entry.name}, skipping`);
      }
    }

    return plugins;
  }

  /** Resolve a plugin by ID, returning its manifest and path. */
  async resolve(pluginId: string): Promise<InstalledPlugin> {
    const plugins = await this.list();
    const match = plugins.find((p) => p.manifest.id === pluginId);

    if (!match) {
      throw new Error(
        `Plugin "${pluginId}" is not installed. Run: openconnectors install ${pluginId}`
      );
    }

    return match;
  }

  // --- Private helpers ---

  private async installFromLocal(localPath: string): Promise<InstalledPlugin> {
    const absPath = resolve(localPath);
    const raw = await readFile(join(absPath, "manifest.json"), "utf-8");
    const manifest = PluginManifestSchema.parse(JSON.parse(raw));

    const targetDir = join(this.pluginsDir, manifest.id);
    await cp(absPath, targetDir, { recursive: true });

    console.log(`Installed ${manifest.name} (${manifest.id}@${manifest.version}) from local path`);
    return { manifest, path: targetDir };
  }

  private async installFromRegistry(
    pluginId: string
  ): Promise<InstalledPlugin> {
    let registry: RegistryEntry[];
    try {
      registry = await loadRegistry(this.registryUrl);
    } catch (err) {
      throw new Error(
        `Failed to load plugin registry: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const entry = registry.find((e) => e.id === pluginId);
    if (!entry) {
      throw new Error(
        `Plugin "${pluginId}" not found in registry. Run: openconnectors list --registry`
      );
    }

    const targetDir = join(this.pluginsDir, entry.id);

    // Clone the plugin repository
    console.log(`Cloning ${entry.name} from ${entry.repository}...`);
    execSync(`git clone --depth 1 ${entry.repository} ${targetDir}`, {
      stdio: "inherit",
    });

    // Install dependencies & build
    console.log("Installing dependencies...");
    execSync("npm install && npm run build", {
      cwd: targetDir,
      stdio: "inherit",
    });

    const raw = await readFile(join(targetDir, "manifest.json"), "utf-8");
    const manifest = PluginManifestSchema.parse(JSON.parse(raw));

    console.log(`Installed ${manifest.name} (${manifest.id}@${manifest.version})`);
    return { manifest, path: targetDir };
  }
}
