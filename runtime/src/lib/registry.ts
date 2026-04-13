/**
 * Plugin Registry
 *
 * The registry is a JSON file listing available community plugins.
 * It can be hosted anywhere — the default points to the repo's own
 * `registry.json` for bootstrapping.
 *
 * Format: Array of RegistryEntry objects.
 */

import { z } from "zod";
import { readFile } from "node:fs/promises";

/** Schema for a single registry entry. */
const RegistryEntrySchema = z.object({
  /** Plugin ID — must match the plugin's manifest.id. */
  id: z.string().min(1),

  /** Human-readable name. */
  name: z.string().min(1),

  /** Short description. */
  description: z.string().min(1),

  /** Git repository URL for cloning. */
  repository: z.string().url(),

  /** Latest published version. */
  version: z.string(),

  /** Tags for discoverability (e.g. ["banking", "israel"]). */
  tags: z.array(z.string()).default([]),

  /** Plugin author. */
  author: z.string().min(1),
});

const RegistrySchema = z.array(RegistryEntrySchema);

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

/**
 * Load and validate a plugin registry from a local file path or URL.
 *
 * @param source - File path or URL to registry.json
 * @returns Validated array of registry entries
 */
export async function loadRegistry(source: string): Promise<RegistryEntry[]> {
  let raw: string;

  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch registry from ${source}: ${response.status} ${response.statusText}`
      );
    }
    raw = await response.text();
  } else {
    raw = await readFile(source, "utf-8");
  }

  const data: unknown = JSON.parse(raw);
  return RegistrySchema.parse(data);
}
