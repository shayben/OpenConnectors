/**
 * OpenConnectors MCP Server
 *
 * Exposes connector definitions and credentials to Claude (or any MCP client)
 * via four tools:
 *   - list_connectors: enumerate available connectors
 *   - get_connector:   return the full YAML for one connector
 *   - get_credentials: return decrypted credentials from the OS keychain
 *   - vault_status:    report which credentials are set/missing for a connector
 *
 * Claude uses this alongside the @playwright/mcp server: load the connector
 * YAML, fetch the credentials, then follow the navigation steps using the
 * Playwright MCP tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ConnectorLoader } from "./connector-loader.js";
import { CredentialVault } from "./vault.js";
import { promptForCredentials } from "./credential-prompt.js";

export interface McpServerOptions {
  connectorsDir?: string;
}

export async function startMcpServer(options?: McpServerOptions): Promise<void> {
  const loader = new ConnectorLoader({ dir: options?.connectorsDir });
  const vault = new CredentialVault();

  const server = new McpServer({
    name: "openconnectors",
    version: "0.1.0",
  });

  // --- list_connectors ---
  server.tool(
    "list_connectors",
    "List all available OpenConnectors — returns id, name, description, institution, and action names for each.",
    {},
    async () => {
      const all = await loader.list();
      const summary = all.map(({ connector }) => ({
        id: connector.id,
        name: connector.name,
        description: connector.description,
        institution: connector.institution,
        tags: connector.tags,
        actions: connector.actions.map((a) => ({
          name: a.name,
          description: a.description,
        })),
      }));
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summary, null, 2) },
        ],
      };
    }
  );

  // --- get_connector ---
  server.tool(
    "get_connector",
    "Return the full YAML definition of a connector by id. Claude reads the navigation steps and follows them using the Playwright MCP tools.",
    {
      id: z.string().describe("Connector id (e.g. 'pension-more')"),
    },
    async ({ id }) => {
      try {
        const { raw, connector } = await loader.get(id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { id: connector.id, yaml: raw },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- get_credentials ---
  server.tool(
    "get_credentials",
    "Retrieve decrypted credentials for a connector from the OS keychain. Returns a map of credential key to value. Only credentials declared in the connector manifest are returned.",
    {
      connector_id: z
        .string()
        .describe("Connector id (e.g. 'pension-more')"),
    },
    async ({ connector_id }) => {
      try {
        const { connector } = await loader.get(connector_id);
        const result: Record<string, string> = {};
        const missing: string[] = [];

        for (const cred of connector.credentials) {
          const value = await vault.get(connector.id, cred.key);
          if (value) {
            result[cred.key] = value;
          } else if (!cred.optional) {
            missing.push(cred.key);
          }
        }

        if (missing.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Missing required credentials for ${connector.id}: ${missing.join(", ")}. ` +
                  `Run: openconnectors vault set ${connector.id} <key>`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- vault_status ---
  server.tool(
    "vault_status",
    "Check which credentials are set vs missing for a connector, without revealing the values.",
    {
      connector_id: z.string().describe("Connector id"),
    },
    async ({ connector_id }) => {
      try {
        const { connector } = await loader.get(connector_id);
        const status: Record<string, boolean> = {};
        for (const cred of connector.credentials) {
          const value = await vault.get(connector.id, cred.key);
          status[cred.key] = Boolean(value);
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(status, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- request_credentials ---
  // Opens a local browser-based form for the user to securely enter
  // credentials. Returns only status + stored key names — never the
  // credential VALUES, so secrets never flow through the MCP transport.
  server.tool(
    "request_credentials",
    "Securely collect missing credentials for a connector by opening a local browser form on 127.0.0.1. Values are stored directly in the OS keychain and are never returned by this tool — use get_credentials afterward to retrieve them. Use this when vault_status shows missing keys.",
    {
      connector_id: z.string().describe("Connector id (e.g. 'pension-more')"),
      force: z
        .boolean()
        .optional()
        .describe("Re-prompt for credentials that are already stored"),
      timeout_seconds: z
        .number()
        .optional()
        .describe("Max seconds to wait for the user. Defaults to 300 (5 min)."),
    },
    async ({ connector_id, force, timeout_seconds }) => {
      try {
        const { connector } = await loader.get(connector_id);

        const result = await promptForCredentials(connector, {
          force: force ?? false,
          timeoutMs: timeout_seconds
            ? timeout_seconds * 1000
            : undefined,
        });

        const payload = {
          status: result.status,
          connector_id: connector.id,
          stored_keys: result.storedKeys,
          ...(result.error ? { error: result.error } : {}),
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
          isError: result.status !== "completed",
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
