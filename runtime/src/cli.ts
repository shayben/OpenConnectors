#!/usr/bin/env node
/**
 * OpenConnectors CLI
 *
 * Local-first data extraction from institutional web portals.
 * Credentials stay in the OS keychain. Browser automation is delegated
 * to the Playwright MCP — this CLI just manages connectors and credentials.
 */

import { Command } from "commander";
import { listCommand } from "./commands/list.js";
import { serveCommand } from "./commands/serve.js";
import { setupCommand } from "./commands/setup.js";
import { vaultSetCommand, vaultClearCommand } from "./commands/vault.js";
import {
  profileStatusCommand,
  profileListAllowCommand,
  profileRevokeCommand,
} from "./commands/profile.js";

const program = new Command();

program
  .name("openconnectors")
  .description(
    "Local-first platform for extracting personal data from institutional web portals"
  )
  .version("0.1.0");

program
  .command("list")
  .description("List all available connectors")
  .action(listCommand);

program
  .command("setup [connector]")
  .description(
    "Interactively configure credentials for one or all connectors"
  )
  .option("--all", "Set up every connector with missing credentials")
  .option("--force", "Overwrite credentials that are already stored")
  .action(setupCommand);

program
  .command("serve")
  .description("Start the MCP server (configure this in your MCP client)")
  .action(serveCommand);

const vault = program
  .command("vault")
  .description("Manage credentials stored in your system keychain");

vault
  .command("set <connector> <key>")
  .description("Store a credential for a connector (prompts for value)")
  .action(vaultSetCommand);

vault
  .command("clear <connector>")
  .description("Remove credentials for a connector")
  .option("--key <key>", "Remove only a specific key")
  .action(vaultClearCommand);

const profile = program
  .command("profile")
  .description("Manage persistent browser profiles used by persistent_profile connectors");

profile
  .command("status <profile_id>")
  .description("Show disk state, lock state, and domain allowlist for a profile")
  .action(profileStatusCommand);

profile
  .command("list-allow <profile_id>")
  .description("Print the eTLD+1 allowlist for a profile")
  .action(profileListAllowCommand);

profile
  .command("revoke <profile_id> <domain>")
  .description(
    "Remove a domain (or URL — reduced to eTLD+1) from the profile's allowlist"
  )
  .action(profileRevokeCommand);

program.parse();
