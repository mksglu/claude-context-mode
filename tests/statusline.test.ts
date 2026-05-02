/**
 * Behavioral tests for the statusLine pipeline.
 *
 * The status line is composed of three layers:
 *   1. server.ts persists `stats-<sessionId>.json` after every tool call.
 *   2. bin/statusline.mjs reads that file and renders the bar.
 *   3. cli.ts adds a `stats` subcommand that the status line shells to
 *      and that humans can run directly.
 *
 * These tests focus on the rendering surface and the file lookup
 * contract, since those are the parts that ship to users and break
 * silently. The MCP persistence layer is exercised end-to-end by the
 * smoke harness in tests/mcp-integration.ts.
 */

import { describe, test, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const STATUSLINE = resolve(
  process.cwd(),
  "bin",
  "statusline.mjs",
);

const CLI = resolve(process.cwd(), "cli.bundle.mjs");

function writeStats(dir: string, sessionId: string, payload: object) {
  writeFileSync(
    join(dir, `stats-${sessionId}.json`),
    JSON.stringify(payload),
  );
}

function runStatusline(env: Record<string, string>) {
  const result = spawnSync("node", [STATUSLINE], {
    input: "{}",
    env: { ...process.env, NO_COLOR: "1", ...env },
    encoding: "utf-8",
  });
  return result.stdout.trim();
}

function runCli(args: string[], env: Record<string, string>) {
  const result = spawnSync("node", [CLI, ...args], {
    env: { ...process.env, NO_COLOR: "1", ...env },
    encoding: "utf-8",
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

describe("statusline.mjs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-statusline-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // BRAND-NEW state: no stats file. Falls back to substantiated README
  // headline ("~98% of context window") — no fabricated $/dev/month copy.
  test("brand-new state: no stats file shows substantiated headline", () => {
    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-doesnotexist",
    });
    assert.match(out, /context-mode/);
    assert.match(out, /saves ~98% of context window/);
    assert.doesNotMatch(out, /\$\d+\/dev\/month/, "no fabricated $/dev/month claim");
  });

  // ACTIVE state: full triad (session $ · lifetime $ · % efficient · uptime).
  // Counts (calls / tokens / bytes) intentionally absent — they don't pass
  // the value-per-pixel test on a single-line statusline.
  test("active state: renders session $, lifetime $, % efficient, uptime", () => {
    writeStats(dir, "pid-100", {
      version: "test",
      updated_at: Date.now(),
      session_start: Date.now() - 60_000,
      uptime_ms: 60_000,
      total_calls: 3,
      bytes_returned: 100,
      bytes_indexed: 0,
      bytes_sandboxed: 4096,
      cache_hits: 0,
      cache_bytes_saved: 0,
      kept_out: 4096,
      total_processed: 4196,
      reduction_pct: 98,
      tokens_saved: 1024,
      dollars_saved_session: 0.42,
      tokens_saved_lifetime: 820000,
      dollars_saved_lifetime: 12.30,
      by_tool: {},
    });

    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-100",
    });

    assert.match(out, /context-mode/);
    assert.match(out, /\$0\.42/, "session $ visible");
    assert.match(out, /saved this session/);
    assert.match(out, /\$12\.30/, "lifetime $ visible");
    assert.match(out, /saved across sessions/, "echoes brand 'across' poetry");
    assert.match(out, /98% efficient/);
    assert.match(out, /1m\b/);
  });

  test("falls back to the most recent stats file when no exact match", () => {
    writeStats(dir, "pid-stale", {
      version: "old",
      updated_at: Date.now() - 5 * 60_000,
      session_start: Date.now() - 10 * 60_000,
      uptime_ms: 10 * 60_000,
      total_calls: 99,
      bytes_returned: 0,
      bytes_indexed: 0,
      bytes_sandboxed: 0,
      cache_hits: 0,
      cache_bytes_saved: 0,
      kept_out: 8000,
      total_processed: 8000,
      reduction_pct: 100,
      tokens_saved: 2000,
      dollars_saved_session: 0.03,
      tokens_saved_lifetime: 100000,
      dollars_saved_lifetime: 1.50,
      by_tool: {},
    });

    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-not-on-disk",
    });

    assert.match(out, /context-mode/);
    // Falls back to recent file → renders active triad from its data
    assert.match(out, /\$0\.03/);
    assert.match(out, /\$1\.50/);
  });

  // BRAND-NEW (no recent file fallback): >30min stats are rejected, falling
  // back to the substantiated headline rather than rendering stale data.
  test("ignores fallback files older than 30 minutes", () => {
    writeStats(dir, "pid-ancient", {
      version: "old",
      updated_at: Date.now() - 60 * 60_000,
      session_start: Date.now() - 60 * 60_000,
      uptime_ms: 60 * 60_000,
      total_calls: 1,
      bytes_returned: 0,
      bytes_indexed: 0,
      bytes_sandboxed: 0,
      cache_hits: 0,
      cache_bytes_saved: 0,
      kept_out: 0,
      total_processed: 0,
      reduction_pct: 0,
      tokens_saved: 0,
      by_tool: {},
    });
    // backdate the file mtime by writing then re-stamping via utimesSync
    const file = join(dir, `stats-pid-ancient.json`);
    const ancient = (Date.now() - 60 * 60_000) / 1000;
    const { utimesSync } = require("node:fs");
    utimesSync(file, ancient, ancient);

    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-not-on-disk",
    });
    assert.match(out, /context-mode/);
    assert.match(out, /saves ~98% of context window/);
  });

  // FRESH state: stats exist but no session $ yet. Lifetime $ leads with
  // brand-poem echo; no lifetime → headline fallback.
  test("fresh state with no session $: leads with lifetime $ + persistence echo", () => {
    writeStats(dir, "pid-fresh-lifetime", {
      version: "test",
      updated_at: Date.now(),
      session_start: Date.now(),
      uptime_ms: 0,
      total_calls: 0,
      bytes_returned: 0,
      bytes_indexed: 0,
      bytes_sandboxed: 0,
      cache_hits: 0,
      cache_bytes_saved: 0,
      kept_out: 0,
      total_processed: 0,
      reduction_pct: 0,
      tokens_saved: 0,
      dollars_saved_session: 0,
      tokens_saved_lifetime: 820000,
      dollars_saved_lifetime: 12.30,
      by_tool: {},
    });

    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-fresh-lifetime",
    });
    assert.match(out, /context-mode/);
    assert.match(out, /\$12\.30/);
    assert.match(out, /saved across sessions/);
    assert.match(out, /preserved across compact, restart & upgrade/, "brand poem echo");
    assert.doesNotMatch(out, /NaN/);
  });

  test("fresh state with no lifetime: substantiated 'ready' headline", () => {
    writeStats(dir, "pid-empty", {
      version: "test",
      updated_at: Date.now(),
      session_start: Date.now(),
      uptime_ms: 0,
      total_calls: 0,
      bytes_returned: 0,
      bytes_indexed: 0,
      bytes_sandboxed: 0,
      cache_hits: 0,
      cache_bytes_saved: 0,
      kept_out: 0,
      total_processed: 0,
      reduction_pct: 0,
      tokens_saved: 0,
      dollars_saved_session: 0,
      dollars_saved_lifetime: 0,
      by_tool: {},
    });

    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-empty",
    });
    assert.match(out, /context-mode/);
    assert.match(out, /ready/);
    assert.match(out, /~98% of context window/);
    assert.doesNotMatch(out, /NaN/);
  });

  // Corrupt stats file — degrades to substantiated headline rather than
  // exposing a parse error to the buyer's screen.
  test("corrupt stats file degrades to substantiated headline", () => {
    writeFileSync(join(dir, "stats-pid-bad.json"), "{not valid json");
    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-bad",
    });
    assert.match(out, /context-mode/);
    assert.match(out, /saves ~98% of context window/);
  });
});

// `cli stats` subcommand intentionally removed — the statusline reads the
// persisted JSON file directly; the CLI subcommand was redundant surface
// area that didn't serve the statusline's purpose.
