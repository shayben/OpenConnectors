/**
 * Zod schema for connector YAML validation.
 *
 * Connectors are declarative YAML files under connectors/ that describe
 * how to authenticate and extract data from an institution. Claude reads
 * the YAML and uses the Playwright MCP to execute the steps.
 */

import { z } from "zod";

export const CredentialSpecSchema = z.object({
  key: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, {
    message: "Credential key must be snake_case",
  }),
  label: z.string().min(1),
  type: z.enum(["text", "password", "totp_secret"]).default("text"),
  optional: z.boolean().default(false),
});

export const StepSchema = z.object({
  phase: z.enum(["login", "navigate", "extract"]),
  instructions: z.string().min(1),
  otp_handling: z.string().optional(),
  data_format: z.string().optional(),
  timeout_seconds: z.number().positive().default(60),
});

export const ActionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, {
    message: "Action name must be snake_case",
  }),
  description: z.string().min(1),
  input_schema: z.record(z.unknown()).default({}),
  output_schema: z.string().optional(),
  steps: z.array(StepSchema).min(1),
});

export const InstitutionSchema = z.object({
  name: z.string().min(1),
  name_he: z.string().optional(),
  url: z.string().url(),
  country: z.string().length(2),
  locale: z.string().default("en-US"),
  timezone: z.string().default("UTC"),
  requires_israeli_ip: z.boolean().default(false),
});

export const ConnectorSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: "Connector id must be kebab-case",
  }),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string(),
  author: z.string().min(1),
  license: z.string().default("MIT"),
  tags: z.array(z.string()).default([]),
  institution: InstitutionSchema,
  credentials: z.array(CredentialSpecSchema).default([]),
  actions: z.array(ActionSchema).min(1),
  output_types: z.string().optional(),
  notes: z.string().optional(),
});

export type Connector = z.infer<typeof ConnectorSchema>;
export type ConnectorAction = z.infer<typeof ActionSchema>;
export type ConnectorCredential = z.infer<typeof CredentialSpecSchema>;
export type ConnectorStep = z.infer<typeof StepSchema>;
