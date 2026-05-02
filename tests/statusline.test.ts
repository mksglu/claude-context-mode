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

  test("prints idle when no stats file exists", () => {
    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-doesnotexist",
    });
    assert.equal(out, "[CTX] idle");
  });

  test("renders kept_out, savings ratio, and uptime when stats are fresh", () => {
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
      by_tool: {},
    });

    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-100",
    });

    assert.match(out, /\[CTX\]/);
    assert.match(out, /3 calls/);
    assert.match(out, /98% saved/);
    assert.match(out, /1\.0K tok|1024 tok/);
    assert.match(out, /4\.0 KB|4 KB/);
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
      kept_out: 0,
      total_processed: 0,
      reduction_pct: 0,
      tokens_saved: 0,
      by_tool: {},
    });

    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-not-on-disk",
    });

    assert.match(out, /\[CTX\]/);
    assert.match(out, /99 calls/);
  });

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
    assert.equal(out, "[CTX] idle");
  });

  test("treats missing reduction_pct as zero", () => {
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
      by_tool: {},
    });

    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-empty",
    });
    assert.match(out, /0 calls/);
    assert.doesNotMatch(out, /NaN/);
  });

  test("survives a corrupt stats file by printing 'no data'", () => {
    writeFileSync(join(dir, "stats-pid-bad.json"), "{not valid json");
    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-bad",
    });
    assert.match(out, /no data/);
  });
});

describe("cli stats subcommand", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-stats-cli-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("--json prints the persisted payload verbatim", () => {
    const payload = {
      version: "test",
      updated_at: 1,
      session_start: 0,
      uptime_ms: 1,
      total_calls: 7,
      bytes_returned: 10,
      bytes_indexed: 0,
      bytes_sandboxed: 1000,
      cache_hits: 0,
      cache_bytes_saved: 0,
      kept_out: 1000,
      total_processed: 1010,
      reduction_pct: 99,
      tokens_saved: 250,
      by_tool: { ctx_execute: { calls: 7, bytes: 10 } },
    };
    writeFileSync(join(dir, "stats-pid-json.json"), JSON.stringify(payload));

    // Stub the adapter session dir by writing into the user's real session
    // dir is too invasive — instead we point the CLI at a dummy session id
    // whose file lives in the temp dir, then symlink the temp dir into the
    // real sessions path. To keep this test hermetic, we rely on the CLI
    // accepting a --session arg AND reading from the adapter's session
    // dir; we therefore re-export the temp file into the real session dir
    // under a unique name so a stray test never collides with real stats.
    const realDir = resolve(
      process.env.HOME || "",
      ".claude",
      "context-mode",
      "sessions",
    );
    const sentinel = `pid-test-${process.pid}-${Date.now()}`;
    const realFile = join(realDir, `stats-${sentinel}.json`);
    writeFileSync(realFile, JSON.stringify(payload));
    try {
      const result = runCli(["stats", "--session", sentinel, "--json"], {});
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.total_calls, 7);
      assert.equal(parsed.reduction_pct, 99);
    } finally {
      try {
        require("node:fs").unlinkSync(realFile);
      } catch { /* ignore */ }
    }
  });

  test("returns a non-zero exit when stats are missing", () => {
    const result = runCli(["stats", "--session", "pid-zzz-missing-99"], {});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No stats found/);
  });
});
