import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

/**
 * Walk up from import.meta.url until we find cli.bundle.mjs or start.mjs.
 * Works correctly in both:
 *  - Bundled mode: server.bundle.mjs is at the plugin root level
 *  - Dev mode (tsx): source files are nested in src/tools/, src/server/, etc.
 */
export function findPluginRoot(metaUrl: string): string {
  let dir = dirname(fileURLToPath(metaUrl));
  while (dir !== dirname(dir)) {
    if (
      existsSync(resolve(dir, "cli.bundle.mjs")) ||
      existsSync(resolve(dir, "start.mjs"))
    ) {
      return dir;
    }
    dir = dirname(dir);
  }
  // Fallback: return the starting directory
  return dirname(fileURLToPath(metaUrl));
}
