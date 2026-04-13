/**
 * CLI: openconnectors install <plugin>
 *
 * Install a plugin from the community registry or a local path.
 */

import { PluginManager } from "../lib/plugin-manager.js";

interface InstallOptions {
  registry?: string;
}

export async function installCommand(
  plugin: string,
  options: InstallOptions
): Promise<void> {
  try {
    const manager = new PluginManager(
      options.registry ? { registryUrl: options.registry } : undefined
    );

    const installed = await manager.install(plugin);

    console.log();
    console.log(`Plugin installed successfully.`);
    console.log(`  ID:      ${installed.manifest.id}`);
    console.log(`  Name:    ${installed.manifest.name}`);
    console.log(`  Version: ${installed.manifest.version}`);
    console.log(`  Tools:   ${installed.manifest.tools.map((t) => t.name).join(", ")}`);
    console.log();

    // Remind user to configure credentials if needed
    if (installed.manifest.credentials.length > 0) {
      console.log("This plugin requires credentials. Set them with:");
      for (const cred of installed.manifest.credentials) {
        const optional = cred.optional ? " (optional)" : "";
        console.log(
          `  openconnectors vault set ${installed.manifest.id} ${cred.key}${optional}`
        );
      }
      console.log();
    }
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  }
}
