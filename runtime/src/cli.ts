#!/usr/bin/env node
/**
 * OpenConnectors CLI
 *
 * Local-first data extraction from institutional web portals.
 * Credentials never leave your machine.
 */

import { Command } from "commander";
import { installCommand } from "./commands/install.js";
import { listCommand } from "./commands/list.js";
import { runCommand } from "./commands/run.js";
import { vaultSetCommand, vaultClearCommand } from "./commands/vault.js";

const program = new Command();

program
  .name("openconnectors")
  .description(
    "Local-first platform for extracting personal data from institutional web portals"
  )
  .version("0.1.0");

// --- Plugin management ---

program
  .command("install <plugin>")
  .description("Install a plugin from the community registry or a local path")
  .option("--registry <url>", "Custom registry URL")
  .action(installCommand);

program
  .command("list")
  .description("List installed plugins and their status")
  .action(listCommand);

program
  .command("run <plugin> <tool>")
  .description("Run a specific tool exposed by an installed plugin")
  .option("--args <json>", "JSON-encoded arguments for the tool", "{}")
  .option("--headless", "Run browser in headless mode", true)
  .option("--no-headless", "Show the browser window")
  .option("--proxy <url>", "Route browser traffic through a proxy server")
  .option("--proxy-username <user>", "Proxy authentication username")
  .option("--proxy-password <pass>", "Proxy authentication password")
  .action(runCommand);

// --- Credential vault ---

const vault = program
  .command("vault")
  .description("Manage credentials stored in your system keychain");

vault
  .command("set <plugin> <key>")
  .description("Store a credential for a plugin (prompts for value)")
  .action(vaultSetCommand);

vault
  .command("clear <plugin>")
  .description("Remove all stored credentials for a plugin")
  .option("--key <key>", "Remove only a specific key")
  .action(vaultClearCommand);

program.parse();
