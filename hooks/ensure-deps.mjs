/**
 * Shared dependency bootstrap for hooks and start.mjs.
 *
 * Single source of truth — ensures native deps (better-sqlite3) are
 * installed in the plugin cache before any hook or server code runs.
 *
 * Pattern: same as suppress-stderr.mjs — imported at the top of every
 * hook that needs native modules. Fast path: existsSync check (~0.1ms).
 * Slow path: npm install (first run only, ~5-30s).
 *
 * @see https://github.com/mksglu/context-mode/issues/172
 */

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const NATIVE_DEPS = ["better-sqlite3"];

export function ensureDeps() {
  for (const pkg of NATIVE_DEPS) {
    if (!existsSync(resolve(root, "node_modules", pkg))) {
      try {
        execSync(`npm install ${pkg} --no-package-lock --no-save --silent`, {
          cwd: root,
          stdio: "pipe",
          timeout: 120000,
        });
      } catch { /* best effort — hook degrades gracefully without DB */ }
    }
  }
}

// Auto-run on import (like suppress-stderr.mjs)
ensureDeps();
