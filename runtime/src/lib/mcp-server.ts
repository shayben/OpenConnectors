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
import { promptForCredentials, promptForRuntimeInput } from "./credential-prompt.js";
import type { ConnectorCredential } from "./connector-schema.js";
import { setEnvVar, defaultEnvPath } from "./env-file.js";
import { recordLearning, normalizePath, assertNoPii, type NavNodeEntry } from "./learning.js";
import { ProfileManager } from "./profile-manager.js";
import { runPreview } from "./preview.js";
import { BatchRunner, BatchStateError } from "./batch-runner.js";

export interface McpServerOptions {
  connectorsDir?: string;
}

export async function startMcpServer(options?: McpServerOptions): Promise<void> {
  const loader = new ConnectorLoader({ dir: options?.connectorsDir });
  const vault = new CredentialVault();
  const profiles = new ProfileManager();
  const batchRunner = new BatchRunner();
  // Out-of-band "prior state" snapshots the agent has fed in via
  // submit_read_snapshot, keyed by `${connector_id}:${action}`. Used by
  // start_batch to satisfy idempotency.read_via without the runtime
  // having to drive the fetch itself.
  const priorStates = new Map<
    string,
    { collected_at: number; items: Record<string, unknown>[] }
  >();
  const priorStateKey = (c: string, a: string) => `${c}:${a}`;

  const textError = (msg: string) => ({
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  });
  const batchErrorResponse = (err: unknown) => {
    const msg =
      err instanceof BatchStateError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return textError(msg);
  };

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
        // `connector` already has topology/api_shortcuts/known_quirks folded
        // from the .learned.json sidecar by ConnectorLoader. Surface it so
        // future sessions actually see what prior runs discovered.
        const actionsSummary = connector.actions.map((a) => {
          if (a.kind === "mutation") {
            return {
              name: a.name,
              kind: "mutation" as const,
              description: a.description,
              destructive: a.destructive,
              requires_confirmation: a.requires_confirmation,
              has_preview: Boolean(a.preview),
              has_verify: Boolean(a.verify && a.verify.length > 0),
              has_idempotency: Boolean(a.idempotency),
              iterates: a.for_each ? "for_each" : a.sweep ? "sweep" : null,
              input_schema: typeof a.input_schema === "string"
                ? { ref: a.input_schema }
                : ("extends" in (a.input_schema ?? {})
                    ? { extends: (a.input_schema as { extends: string }).extends }
                    : { inline: true }),
            };
          }
          return {
            name: a.name,
            kind: "fetch" as const,
            description: a.description,
          };
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  id: connector.id,
                  yaml: raw,
                  actions: actionsSummary,
                  merged: {
                    topology: connector.topology ?? [],
                    api_shortcuts: connector.api_shortcuts ?? [],
                    known_quirks: connector.known_quirks ?? [],
                  },
                },
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

  // --- auth_status (PR2) ---
  // Unified auth-readiness probe. Generalizes vault_status to also cover
  // `auth: persistent_profile` connectors — for those we report the
  // profile directory, whether it exists on disk, whether another browser
  // instance has it locked, and a coarse-grained probe_status
  // (never_run | ok | expired | locked). For credentials-based connectors
  // the payload mirrors vault_status (one boolean per key) so existing
  // callers keep working.
  server.tool(
    "auth_status",
    "Report auth readiness for a connector. Works for any auth type (credentials | persistent_profile | any_of) without leaking any secret or cookie value.",
    {
      connector_id: z.string().describe("Connector id"),
    },
    async ({ connector_id }) => {
      try {
        const { connector } = await loader.get(connector_id);
        const auth = connector.auth;

        const reportCredentials = async (creds: ConnectorCredential[]) => {
          const status: Record<string, boolean> = {};
          for (const cred of creds) {
            const value = await vault.get(connector.id, cred.key);
            status[cred.key] = Boolean(value);
          }
          return status;
        };

        let payload: Record<string, unknown>;
        if (auth.type === "credentials") {
          payload = {
            connector_id: connector.id,
            auth_type: "credentials",
            credentials: await reportCredentials(auth.credentials),
          };
        } else if (auth.type === "persistent_profile") {
          payload = {
            connector_id: connector.id,
            auth_type: "persistent_profile",
            ...profiles.probe(auth.profile_id),
          };
        } else {
          // any_of — surface the status of every option so the agent can
          // pick the one that's ready.
          const options = [];
          for (const opt of auth.options) {
            if (opt.type === "credentials") {
              options.push({
                auth_type: "credentials",
                credentials: await reportCredentials(opt.credentials),
              });
            } else {
              options.push({
                auth_type: "persistent_profile",
                ...profiles.probe(opt.profile_id),
              });
            }
          }
          payload = {
            connector_id: connector.id,
            auth_type: "any_of",
            options,
          };
        }

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
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

  // --- run_preview (PR3) ---
  // Describe-only. Given a mutation action + optional input, return a
  // structured plan — destructive flag, for_each count estimate,
  // idempotency summary, preview.emit lines — WITHOUT launching a
  // browser. Lets the agent (and human) sanity-check a batch before
  // any real mutation runs.
  server.tool(
    "run_preview",
    "Describe what a mutation action would do, without launching a browser. Returns the same plan shape regardless of input; empty input is valid but yields a less-precise item count estimate.",
    {
      connector_id: z.string().describe("Connector id"),
      action: z.string().describe("Mutation action name"),
      input: z
        .record(z.unknown())
        .optional()
        .describe("Action inputs (same shape as run_mutation input). Optional for PR3."),
    },
    async ({ connector_id, action, input }) => {
      try {
        const { connector } = await loader.get(connector_id);
        const found = connector.actions.find((a) => a.name === action);
        if (!found) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: action '${action}' not found on connector '${connector_id}'.`,
              },
            ],
            isError: true,
          };
        }
        if (found.kind !== "mutation") {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Error: run_preview only applies to mutation actions. ` +
                  `'${action}' is kind='${found.kind}'.`,
              },
            ],
            isError: true,
          };
        }
        const report = runPreview({ action: found, connector, input });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(report, null, 2) },
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

  // --- submit_read_snapshot (PR4) ---
  // The agent runs a fetch action out of band (Claude drives the browser
  // itself) and POSTs the results here. The runtime uses the stored
  // snapshot to compute idempotency skip-decisions inside start_batch.
  // We do NOT persist the snapshot to disk — lives in-memory, dropped
  // on process exit or on explicit drop_read_snapshot.
  server.tool(
    "submit_read_snapshot",
    "Post the output of a fetch action (as array of items) so subsequent start_batch can compute idempotency. Not persisted to disk.",
    {
      connector_id: z.string(),
      action: z.string().describe("The fetch action whose output this is"),
      items: z
        .array(z.record(z.unknown()))
        .describe("The rows/items produced by the fetch action"),
    },
    async ({ connector_id, action, items }) => {
      try {
        const { connector } = await loader.get(connector_id);
        const found = connector.actions.find((a) => a.name === action);
        if (!found || found.kind !== "fetch") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: '${action}' is not a fetch action on '${connector_id}'.`,
              },
            ],
            isError: true,
          };
        }
        priorStates.set(priorStateKey(connector_id, action), {
          collected_at: Date.now(),
          items,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { stored: true, count: items.length, connector_id, action },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return batchErrorResponse(err);
      }
    }
  );

  // --- start_batch (PR4) ---
  server.tool(
    "start_batch",
    "Begin executing a mutation action. Returns a batch_id + summary; the agent then drives the batch via next_step / complete_step / finish_batch.",
    {
      connector_id: z.string(),
      action: z.string(),
      input: z
        .record(z.unknown())
        .default({})
        .describe("The action input (e.g. { tasks: [...] } for a TaskBatch)"),
      confirmation_token: z
        .string()
        .optional()
        .describe("Required when the action is destructive + requires_confirmation"),
    },
    async ({ connector_id, action, input, confirmation_token }) => {
      try {
        const { connector } = await loader.get(connector_id);
        const found = connector.actions.find((a) => a.name === action);
        if (!found) {
          return textError(`action '${action}' not found on '${connector_id}'.`);
        }
        if (found.kind !== "mutation") {
          return textError(
            `start_batch requires a mutation action; '${action}' is kind='${found.kind}'.`
          );
        }
        let prior_state: Record<string, unknown>[] | undefined;
        if (found.idempotency) {
          const key = priorStateKey(connector_id, found.idempotency.read_via);
          const stored = priorStates.get(key);
          if (!stored) {
            return textError(
              `Action '${action}' declares idempotency.read_via='${found.idempotency.read_via}' ` +
                `but no snapshot has been submitted. Call submit_read_snapshot first.`
            );
          }
          prior_state = stored.items;
        }
        const { summary } = batchRunner.start({
          connector,
          action: found,
          input,
          prior_state,
          confirmation_token,
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(summary, null, 2) },
          ],
        };
      } catch (err) {
        return batchErrorResponse(err);
      }
    }
  );

  // --- next_step (PR4) ---
  server.tool(
    "next_step",
    "Lease the next mutate/verify step for a batch. Returns {kind: 'step', item_token, rendered_steps} or {kind: 'done', report}.",
    {
      batch_id: z.string(),
    },
    async ({ batch_id }) => {
      try {
        const resp = batchRunner.nextStep(batch_id);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(resp, null, 2) },
          ],
        };
      } catch (err) {
        return batchErrorResponse(err);
      }
    }
  );

  // --- complete_step (PR4) ---
  server.tool(
    "complete_step",
    "Report the outcome of a leased step. Replays with the same item_token are idempotent no-ops.",
    {
      batch_id: z.string(),
      item_token: z.string(),
      status: z.enum(["ok", "failed", "verify_failed"]),
      error_code: z.string().optional(),
      error_summary: z
        .string()
        .max(500)
        .optional()
        .describe("Will be truncated to 240 chars. Do NOT include PII; error summaries appear in batch reports."),
      captured: z
        .record(z.unknown())
        .optional()
        .describe("Values pulled from capture: slots during the step"),
    },
    async ({ batch_id, ...rest }) => {
      try {
        const resp = batchRunner.complete(batch_id, rest);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(resp, null, 2) },
          ],
        };
      } catch (err) {
        return batchErrorResponse(err);
      }
    }
  );

  // --- finish_batch (PR4) ---
  server.tool(
    "finish_batch",
    "Finalize a batch and return the BatchReport. Drops batch state.",
    {
      batch_id: z.string(),
    },
    async ({ batch_id }) => {
      try {
        const report = batchRunner.finish(batch_id);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(report, null, 2) },
          ],
        };
      } catch (err) {
        return batchErrorResponse(err);
      }
    }
  );

  // --- request_credentials ---
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

  // --- prompt_runtime_input ---
  // Collects per-session challenge inputs (SMS OTPs, security-question answers)
  // via the same local 127.0.0.1 form used by request_credentials — but the
  // values are NEVER written to the keychain and are returned directly to the
  // caller. Use this when a login flow presents an OTP/challenge screen that
  // wasn't anticipated in the stored credentials.
  server.tool(
    "prompt_runtime_input",
    "Collect a per-session runtime input (e.g. SMS OTP code) from the user via a local 127.0.0.1 form. Values are returned directly and are NEVER stored in the keychain. Use this for challenges that appear mid-flow — OTP codes, security question answers. Do NOT use for long-lived secrets (use request_credentials for those).",
    {
      connector_id: z.string().describe("Connector id (for display on the form)"),
      fields: z
        .array(
          z.object({
            key: z
              .string()
              .regex(/^[a-z][a-z0-9_]*$/, "field key must be snake_case")
              .describe("Field key (snake_case) — used as the form input name"),
            label: z.string().describe("Human-readable label shown on the form"),
            type: z
              .enum(["text", "password", "otp", "phone", "email"])
              .default("otp")
              .describe("Input type. Default 'otp' for one-time codes."),
            optional: z.boolean().optional(),
          })
        )
        .min(1)
        .describe("Ad-hoc fields to collect this session. E.g. [{key:'otp_code',label:'SMS code',type:'otp'}]"),
      heading: z.string().optional().describe("Override form heading (defaults to connector name)"),
      subtitle: z.string().optional().describe("Override form subtitle (defaults to institution URL)"),
      timeout_seconds: z.number().optional().describe("Max seconds to wait. Default 300."),
    },
    async ({ connector_id, fields, heading, subtitle, timeout_seconds }) => {
      try {
        const { connector } = await loader.get(connector_id);

        const specs: ConnectorCredential[] = fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type ?? "otp",
          optional: f.optional ?? false,
        }));

        const result = await promptForRuntimeInput(connector, specs, {
          timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined,
          heading,
          subtitle,
        });

        const payload = {
          status: result.status,
          connector_id: connector.id,
          values: result.values,
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

  // --- configure_il_proxy ---
  // FRE auto-recovery: when Claude encounters a geo-block on a connector
  // that declares requires_israeli_ip (e.g. "הגישה נחסמה" on More), call
  // this tool. It opens the local 127.0.0.1 form for the user to paste
  // their Israeli-exit proxy URL, writes IL_PROXY_URL into the project
  // .env file (preserving other keys), and returns a hint to reload the
  // Playwright MCP so the new proxy takes effect. Claude MUST NOT ask for
  // proxy credentials in chat.
  server.tool(
    "configure_il_proxy",
    "Collect the user's Israeli-exit proxy URL via a local 127.0.0.1 form and persist it to the project .env as IL_PROXY_URL. Call this when a connector with requires_israeli_ip hits a geo-block (e.g. an 'access blocked'/'הגישה נחסמה' page). The new proxy only takes effect after the Playwright MCP is reloaded — return that hint to the user. Never ask for proxy credentials in chat.",
    {
      timeout_seconds: z
        .number()
        .optional()
        .describe("Max seconds to wait for the user. Default 300."),
    },
    async ({ timeout_seconds }) => {
      try {
        // Use any connector with requires_israeli_ip for display context.
        const all = await loader.list();
        const ilConnector =
          all.find((c) => c.connector.institution.requires_israeli_ip)
            ?.connector ?? all[0]?.connector;
        if (!ilConnector) {
          return {
            content: [
              { type: "text" as const, text: "No connectors found." },
            ],
            isError: true,
          };
        }

        const field: ConnectorCredential = {
          key: "il_proxy_url",
          label:
            "Israeli proxy URL (http://user:pass@host:port — URL-encode special chars, e.g. ! → %21)",
          type: "password",
          optional: false,
        };

        const result = await promptForRuntimeInput(ilConnector, [field], {
          timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined,
          heading: "Configure Israeli proxy",
          subtitle:
            "One-time setup. Saved to .env (gitignored) as IL_PROXY_URL for the Playwright MCP server.",
        });

        if (result.status !== "completed") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { status: result.status, error: result.error },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        const value = result.values["il_proxy_url"]?.trim();
        if (!value) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No proxy URL provided.",
              },
            ],
            isError: true,
          };
        }

        const envPath = setEnvVar("IL_PROXY_URL", value);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "completed",
                  env_file: envPath,
                  variable: "IL_PROXY_URL",
                  next_step:
                    "Reload the Playwright MCP (restart Claude Code or run /mcp reconnect) so the proxy takes effect, then retry the connector flow.",
                },
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

  // --- record_learning ---
  // Framework-level: at the end of a successful run, Claude reports what it
  // discovered (URL tree, private API endpoints, gotchas) so the NEXT run
  // on this connector can skip rediscovery. Every payload is validated
  // against a PII denylist before being persisted to the sidecar
  // <id>.learned.json — entries containing IDs, phone numbers, JWTs,
  // balances, emails, UUIDs, or auth tokens are REJECTED wholesale.
  server.tool(
    "record_learning",
    "Persist sanitized, non-personal site-topology / API-shortcut / quirk notes for a connector so future sessions start informed. Call this once at the end of a successful flow. HARD RULE: no personal data — the server rejects entries containing IDs, phones, JWTs, balances, emails, tokens, or UUIDs.",
    {
      connector_id: z.string().describe("Connector id (e.g. 'pension-more')"),
      entries: z
        .array(
          z.discriminatedUnion("kind", [
            z.object({
              kind: z.literal("topology"),
              label: z.string().describe("Short human name for this page/section"),
              url: z.string().url().optional(),
              note: z.string().optional(),
              children: z
                .array(z.any())
                .optional()
                .describe("Optional nested topology children (same shape)"),
            }),
            z.object({
              kind: z.literal("api_shortcut"),
              name: z
                .string()
                .regex(/^[a-z][a-z0-9_]*$/, "snake_case name"),
              method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("POST"),
              path: z.string().startsWith("/"),
              auth: z
                .enum(["bearer_from_storage", "cookie_session", "none"])
                .default("bearer_from_storage"),
              auth_storage_key: z
                .string()
                .optional()
                .describe("localStorage key holding the token (e.g. 'AUTH-TOKEN')"),
              body: z.string().optional().describe("JSON request body as a string"),
              returns: z.string().optional(),
              notes: z.string().optional(),
            }),
            z.object({
              kind: z.literal("quirk"),
              text: z.string().min(10),
            }),
          ])
        )
        .min(1),
    },
    async ({ connector_id, entries }) => {
      try {
        await loader.get(connector_id);
        const result = recordLearning(connector_id, entries as any);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "completed",
                  connector_id,
                  ...result,
                },
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

  // --- record_navigation ---
  // Mid-flow, single-node capture. Unlike record_learning (curated end-of-run
  // batch), this is a firehose: call it after each successful page transition
  // so the connector's label tree grows incrementally. PII rejections return
  // { rejected: true, reason } without aborting, so a single bad edge doesn't
  // lose neighbors. URLs are normalized server-side into path templates; raw
  // URLs with per-user ids are never stored.
  server.tool(
    "record_navigation",
    "Lazily capture one navigation observation: a label path the agent clicked (e.g. [\"Dashboard\",\"Reports\"]) and optionally the URL it landed on. The server normalizes the URL into a path template (no query strings, numeric/hex/UUID segments templated to :id) and merges by label path — repeat calls refresh last_seen_at. HARD RULE: no personal data.",
    {
      connector_id: z.string().describe("Connector id (e.g. 'pension-more')"),
      label_path: z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(10)
        .describe("Ordered breadcrumb of labels the agent clicked to reach this node"),
      observed_url: z
        .string()
        .optional()
        .describe("Raw URL observed after navigation; runtime strips query/fragment and templates ids"),
      note: z.string().max(500).optional().describe("Optional short hint (e.g. 'opens modal')"),
      via: z
        .enum(["link", "button", "menu", "redirect", "direct"])
        .optional()
        .describe("How the agent arrived at this node"),
    },
    async ({ connector_id, label_path, observed_url, note, via }) => {
      try {
        await loader.get(connector_id);
        const path_template = observed_url ? normalizePath(observed_url) : null;
        const entry: NavNodeEntry = {
          kind: "nav_node",
          label_path,
          ...(path_template ? { path_template } : {}),
          ...(note ? { note } : {}),
          ...(via ? { via } : {}),
        };
        try {
          assertNoPii(entry);
        } catch (piiErr) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    rejected: true,
                    reason: piiErr instanceof Error ? piiErr.message : String(piiErr),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        const result = recordLearning(connector_id, [entry]);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "completed",
                  connector_id,
                  ...result,
                  ...(path_template ? { path_template } : {}),
                },
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { defaultEnvPath };
