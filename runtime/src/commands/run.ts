/**
 * CLI: openconnectors run <plugin> <tool> [--args <json>]
 *
 * Resolves a plugin, injects credentials from the vault, and invokes
 * the requested MCP tool. The plugin runs as a child-process MCP server.
 */

import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PluginManager } from "../lib/plugin-manager.js";
import { CredentialVault } from "../lib/vault.js";

interface RunOptions {
  args: string;
  headless: boolean;
}

export async function runCommand(
  pluginId: string,
  toolName: string,
  options: RunOptions
): Promise<void> {
  const manager = new PluginManager();
  const vault = new CredentialVault();

  let client: Client | undefined;

  try {
    // 1. Resolve the installed plugin
    const { manifest, path: pluginPath } = await manager.resolve(pluginId);

    // 2. Verify the requested tool exists
    const tool = manifest.tools.find((t) => t.name === toolName);
    if (!tool) {
      const available = manifest.tools.map((t) => t.name).join(", ");
      throw new Error(
        `Tool "${toolName}" not found in plugin "${pluginId}". Available: ${available}`
      );
    }

    // 3. Collect credentials from the vault and pass as env vars
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      OPENCONNECTORS_HEADLESS: options.headless ? "true" : "false",
    };

    for (const cred of manifest.credentials) {
      const value = await vault.get(pluginId, cred.key);
      if (!value && !cred.optional) {
        throw new Error(
          `Missing required credential "${cred.key}" for plugin "${pluginId}". ` +
            `Run: openconnectors vault set ${pluginId} ${cred.key}`
        );
      }
      if (value) {
        // Convention: OPENCONNECTORS_CRED_<KEY> in uppercase
        env[`OPENCONNECTORS_CRED_${cred.key.toUpperCase()}`] = value;
      }
    }

    // 4. Parse tool arguments
    let toolArgs: Record<string, unknown>;
    try {
      toolArgs = JSON.parse(options.args) as Record<string, unknown>;
    } catch {
      throw new Error(
        `Invalid JSON in --args: ${options.args}`
      );
    }

    // 5. Launch the plugin as a child-process MCP server
    const entryPoint = join(pluginPath, manifest.entryPoint);

    console.log(`Running ${manifest.name} → ${toolName}...`);
    console.log();

    const transport = new StdioClientTransport({
      command: "node",
      args: [entryPoint],
      env,
    });

    client = new Client({
      name: "openconnectors-runtime",
      version: "0.1.0",
    });

    await client.connect(transport);

    // 6. Call the tool via MCP
    const result = await client.callTool({
      name: toolName,
      arguments: toolArgs,
    });

    // 7. Print results
    if (result.content && Array.isArray(result.content)) {
      for (const item of result.content) {
        if (item.type === "text") {
          console.log(item.text);
        } else {
          console.log(JSON.stringify(item, null, 2));
        }
      }
    }

    if (result.isError) {
      console.error("\nTool returned an error.");
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}
