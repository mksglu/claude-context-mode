#!/usr/bin/env node
/**
 * Tier-2 smoke assertion.
 *
 * Reads a JSON `ctx-stats` payload from STDIN (or from $1) and asserts:
 *   - At least one ctx_* tool was actually invoked (calls > 0)
 *   - tokens_saved is a positive integer
 *   - No tool reported an error
 *
 * Designed to be host-agnostic: Pi, Claude Code, OpenCode all emit
 * `ctx-stats` JSON via the same MCP/extension surface, so the same
 * assertion runs unchanged across the matrix.
 *
 * Exit code 0 on pass, 1 on fail. Output is plain text + the parsed
 * payload, suitable for `tee` into the workflow log.
 */

import { readFileSync } from "node:fs";

const REQUIRED_TOOLS = ["ctx_search", "ctx_execute", "ctx_index"];

function loadPayload() {
  const path = process.argv[2];
  if (path && path !== "-") {
    return JSON.parse(readFileSync(path, "utf-8"));
  }
  const buf = readFileSync(0, "utf-8");
  if (!buf.trim()) {
    throw new Error("ctx-stats payload is empty (no stdin, no path)");
  }
  return JSON.parse(buf);
}

function assert(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    return 0;
  }
  console.error(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
  return 1;
}

function main() {
  let payload;
  try {
    payload = loadPayload();
  } catch (err) {
    console.error(`FATAL  could not parse ctx-stats payload: ${err.message}`);
    process.exit(2);
  }

  console.log("=== ctx-stats payload ===");
  console.log(JSON.stringify(payload, null, 2));
  console.log("=========================\n");

  let failed = 0;
  const tools = payload.tools ?? {};
  const totalCalls = Object.values(tools).reduce(
    (sum, t) => sum + (Number(t?.calls) || 0),
    0,
  );

  failed += assert(
    "at least one ctx_* tool invocation recorded",
    totalCalls > 0,
    `total calls = ${totalCalls}`,
  );

  for (const name of REQUIRED_TOOLS) {
    const calls = Number(tools[name]?.calls) || 0;
    failed += assert(
      `${name} invoked at least once`,
      calls > 0,
      `calls = ${calls}`,
    );
  }

  const tokensSaved = Number(payload.tokens_saved);
  failed += assert(
    "tokens_saved is a positive integer",
    Number.isFinite(tokensSaved) && tokensSaved > 0,
    `tokens_saved = ${payload.tokens_saved}`,
  );

  const errors = Number(payload.errors) || 0;
  failed += assert(
    "no tool reported an error",
    errors === 0,
    `errors = ${errors}`,
  );

  if (failed > 0) {
    console.error(`\nTier-2 smoke FAILED (${failed} assertion(s)).`);
    process.exit(1);
  }
  console.log("\nTier-2 smoke PASSED.");
}

main();
