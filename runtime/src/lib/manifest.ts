/**
 * Plugin Manifest Schema
 *
 * Every plugin must include a `manifest.json` at its root that conforms
 * to this schema. The manifest declares the plugin's identity, required
 * credentials, and the MCP tools it exposes.
 */

import { z } from "zod";

/** Schema for a single MCP tool exposed by the plugin. */
const ToolDefinitionSchema = z.object({
  /** Tool name as exposed via MCP (e.g. "fetch_transactions"). */
  name: z.string().min(1),

  /** Human-readable description shown to AI agents. */
  description: z.string().min(1),

  /**
   * JSON Schema describing the tool's input parameters.
   * Stored as a plain object — validated at runtime by the MCP SDK.
   */
  inputSchema: z.record(z.unknown()),
});

/** Schema for a credential the plugin requires. */
const CredentialRequirementSchema = z.object({
  /** Key used to store/retrieve from the vault (e.g. "username"). */
  key: z.string().min(1),

  /** Human-readable label for CLI prompts. */
  label: z.string().min(1),

  /** If true, the credential is optional and the plugin can run without it. */
  optional: z.boolean().default(false),
});

/** The full plugin manifest schema. */
export const PluginManifestSchema = z.object({
  /** Unique plugin identifier (kebab-case, e.g. "mock-bank"). */
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: "Plugin ID must be kebab-case (e.g. 'mock-bank')",
  }),

  /** Human-readable display name. */
  name: z.string().min(1),

  /** Short description of what data the plugin extracts. */
  description: z.string().min(1),

  /** Plugin version — must follow semver. */
  version: z.string().regex(/^\d+\.\d+\.\d+/, {
    message: "Version must follow semver (e.g. '1.0.0')",
  }),

  /** Plugin author or maintainer. */
  author: z.string().min(1),

  /** SPDX license identifier. */
  license: z.string().default("MIT"),

  /** URL of the institution this plugin connects to. */
  institutionUrl: z.string().url().optional(),

  /** Credentials required to authenticate with the institution. */
  credentials: z.array(CredentialRequirementSchema).default([]),

  /** MCP tools this plugin exposes. */
  tools: z.array(ToolDefinitionSchema).min(1, {
    message: "Plugin must expose at least one MCP tool",
  }),

  /** Entry point relative to the plugin root (compiled JS). */
  entryPoint: z.string().default("dist/index.js"),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type CredentialRequirement = z.infer<typeof CredentialRequirementSchema>;
