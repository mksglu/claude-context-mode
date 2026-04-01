/**
 * Re-exec with CONTEXT_MODE_NODE if set and different from current node (#203).
 *
 * Users with mise/volta/fnm/nvm may have project-specific Node versions
 * that conflict with the Node version context-mode was compiled against
 * (better-sqlite3 ABI mismatch). Setting CONTEXT_MODE_NODE lets them
 * pin a fixed Node binary for context-mode regardless of project config.
 *
 * This module MUST be imported before suppress-stderr.mjs and any other
 * imports — the re-exec replaces the current process entirely.
 *
 * Usage:
 *   export CONTEXT_MODE_NODE=/path/to/node22/bin/node
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const customNode = process.env.CONTEXT_MODE_NODE;
if (customNode && !process.env._CONTEXT_MODE_REEXEC) {
  try {
    const resolved = resolve(customNode);
    if (resolved !== resolve(process.execPath)) {
      const child = spawn(resolved, process.argv.slice(1), {
        stdio: "inherit",
        env: { ...process.env, _CONTEXT_MODE_REEXEC: "1" },
      });
      const exitCode = await new Promise((res) => {
        child.on("exit", (code) => res(code ?? 1));
        child.on("error", () => res(null)); // spawn failed — fall through
      });
      if (exitCode !== null) process.exit(exitCode);
    }
  } catch {
    // Invalid CONTEXT_MODE_NODE path — fall through to current node
  }
}
