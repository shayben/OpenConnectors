/**
 * CLI: openconnectors list
 *
 * List all installed plugins and the tools they expose.
 */

import { PluginManager } from "../lib/plugin-manager.js";

export async function listCommand(): Promise<void> {
  try {
    const manager = new PluginManager();
    const plugins = await manager.list();

    if (plugins.length === 0) {
      console.log("No plugins installed.");
      console.log("Install one with: openconnectors install <plugin>");
      return;
    }

    console.log(`Installed plugins (${plugins.length}):\n`);

    for (const { manifest } of plugins) {
      console.log(`  ${manifest.name} (${manifest.id}@${manifest.version})`);
      console.log(`    ${manifest.description}`);
      console.log(`    Tools: ${manifest.tools.map((t) => t.name).join(", ")}`);

      if (manifest.credentials.length > 0) {
        const keys = manifest.credentials.map((c) => c.key).join(", ");
        console.log(`    Credentials: ${keys}`);
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
