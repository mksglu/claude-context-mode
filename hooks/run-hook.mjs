#!/usr/bin/env node
/**
 * run-hook.mjs — Universal crash-resilient wrapper for context-mode hook entries (#414).
 *
 * Why this exists:
 *   - hooks/hooks.json declares commands as `node "${CLAUDE_PLUGIN_ROOT}/hooks/X.mjs"`.
 *     On Windows shells (Git Bash, cmd.exe) the placeholder may mangle and resolution
 *     can fail with `cjs/loader:1479 MODULE_NOT_FOUND` — silent ghost hooks.
 *   - Top-level `import "./suppress-stderr.mjs"` style side-effects throw at
 *     parse time. A `try {}` inside the same file CANNOT catch a parse-time
 *     import failure, and `process.on('uncaughtException')` is also installed
 *     too late. The fix is to dynamic-import the side-effects from inside this
 *     wrapper, where the handler is guaranteed to be live.
 *
 * Contract:
 *   - logs every failure to ~/.claude/context-mode/hook-errors.log
 *   - never propagates a non-zero exit (Claude Code surfaces non-zero as a
 *     "non-blocking hook error" on every tool call, which spams the user)
 *   - one-liner adoption for new hooks:
 *       import { runHook } from "./run-hook.mjs";
 *       await runHook(async () => { ...body... });
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";

function logError(err) {
  try {
    const dir = resolve(homedir(), ".claude", "context-mode");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] pid=${process.pid} ${err?.stack || err?.message || String(err)}\n`;
    appendFileSync(resolve(dir, "hook-errors.log"), line);
  } catch {
    /* never fail logging */
  }
}

// Install process-level safety nets BEFORE any user code runs.
// Caveat: these only catch failures inside dynamically-loaded modules
// (which is precisely what runHook does). Static top-level imports in
// THIS file would still bypass these — keep this file's imports minimal
// and fail-safe (only node: built-ins above).
process.on("uncaughtException", (err) => {
  logError(err);
  process.exit(0);
});
process.on("unhandledRejection", (err) => {
  logError(err);
  process.exit(0);
});

/**
 * Run a hook handler with full crash-resilience.
 *
 * Order of operations:
 *   1. Dynamic-import suppress-stderr.mjs (best-effort — non-fatal)
 *   2. Dynamic-import ensure-deps.mjs (best-effort — non-fatal)
 *   3. Invoke handler — any throw is logged and we exit 0
 *
 * @param {() => Promise<void> | void} handler
 */
export async function runHook(handler) {
  try {
    await import("./suppress-stderr.mjs");
  } catch (e) {
    logError(e);
    /* continue — non-fatal */
  }
  try {
    await import("./ensure-deps.mjs");
  } catch (e) {
    logError(e);
    /* continue — handler may still work */
  }
  try {
    await handler();
  } catch (e) {
    logError(e);
    process.exit(0);
  }
}
