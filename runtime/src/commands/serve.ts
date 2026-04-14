/**
 * CLI: openconnectors serve
 *
 * Starts the OpenConnectors MCP server on stdio. Configure this in your
 * MCP client (e.g. Claude Desktop, Claude Code) to make connectors and
 * credentials available to Claude.
 */

import { startMcpServer } from "../lib/mcp-server.js";

export async function serveCommand(): Promise<void> {
  try {
    await startMcpServer();
  } catch (err) {
    console.error(
      `Fatal: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
}
