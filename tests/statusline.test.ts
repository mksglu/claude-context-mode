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
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
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

// Variant that also returns stderr — needed for warning + degrade tests.
function runStatuslineFull(env: Record<string, string>) {
  const result = spawnSync("node", [STATUSLINE], {
    input: "{}",
    env: { ...process.env, NO_COLOR: "1", ...env },
    encoding: "utf-8",
  });
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr ?? "",
    status: result.status,
  };
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

// ── Cross-OS session-id resolution (B4) ───────────────────────────────────
// The statusline must walk the parent process chain on macOS + Linux to
// avoid colliding fuzzy-mtime matches when multiple Claude sessions are
// open. Windows lacks /proc and a stable BSD `ps`, so it degrades cleanly
// with a one-shot stderr warning rather than picking the wrong session.
//
// Test approach: drive the resolver via test-only env seams baked into
// statusline.mjs (CTX_TEST_PLATFORM, CTX_TEST_PROC_DIR) plus PATH-shimmed
// fake binaries for `ps`. The resolver is exercised end-to-end through
// stats-file lookup — the assertion is "did the right pid-* file get
// loaded", which proves the walk produced the expected PID.
describe("statusline.mjs — cross-OS session resolver", () => {
  let dir: string;
  let scratch: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-statusline-resolver-"));
    scratch = mkdtempSync(join(tmpdir(), "ctx-statusline-scratch-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  // macOS: walk via `ps -o ppid=,comm= -p <pid>`. We shim ps on PATH so
  // that walking up from process.ppid → fakeParent → fakeClaude resolves
  // to a deterministic PID, which the statusline then uses as session id.
  test("darwin: walks parent chain via ps to find claude PID", () => {
    // Shim PATH with a fake ps that returns scripted ancestry.
    // ppid sequence: <ppid> → 90001 (claude) → 1
    const ppid = process.ppid;
    const fakePs = join(scratch, "ps");
    writeFileSync(
      fakePs,
      `#!/bin/sh
# fake ps for statusline resolver tests
# args: -o ppid=,comm= -p <pid>
pid="$5"
case "$pid" in
  ${ppid}) echo "  90001 /bin/zsh"; exit 0 ;;
  90001) echo "      1 /opt/claude-code/bin/claude"; exit 0 ;;
  *) exit 0 ;;
esac
`,
    );
    chmodSync(fakePs, 0o755);

    // Stats file the resolver should land on:
    writeStats(dir, "pid-90001", {
      schemaVersion: 1,
      version: "test",
      updated_at: Date.now(),
      uptime_ms: 60_000,
      reduction_pct: 99,
      dollars_saved_session: 7.77,
      dollars_saved_lifetime: 0,
      by_tool: {},
    });

    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CTX_TEST_PLATFORM: "darwin",
      // Ensure our shim wins:
      PATH: `${scratch}${delimiter}${process.env.PATH ?? ""}`,
      // Must NOT set CLAUDE_SESSION_ID — that bypasses the walk entirely.
      CLAUDE_SESSION_ID: "",
    });

    assert.match(out, /\$7\.77/, "resolved to pid-90001 stats via ps walk");
    assert.match(out, /99% efficient/);
  });

  // linux: walk via /proc/<pid>/status. CTX_TEST_PROC_DIR points at a
  // synthetic /proc populated with PPid + Name lines.
  test("linux: walks parent chain via /proc to find claude PID", () => {
    const ppid = process.ppid;
    const fakeProc = join(scratch, "proc");
    mkdirSync(fakeProc, { recursive: true });
    mkdirSync(join(fakeProc, String(ppid)), { recursive: true });
    mkdirSync(join(fakeProc, "70001"), { recursive: true });
    writeFileSync(
      join(fakeProc, String(ppid), "status"),
      `Name:\tzsh\nPPid:\t70001\n`,
    );
    writeFileSync(
      join(fakeProc, "70001", "status"),
      `Name:\tclaude\nPPid:\t1\n`,
    );

    writeStats(dir, "pid-70001", {
      schemaVersion: 1,
      version: "test",
      updated_at: Date.now(),
      uptime_ms: 60_000,
      reduction_pct: 50,
      dollars_saved_session: 1.11,
      dollars_saved_lifetime: 0,
      by_tool: {},
    });

    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CTX_TEST_PLATFORM: "linux",
      CTX_TEST_PROC_DIR: fakeProc,
      CLAUDE_SESSION_ID: "",
    });

    assert.match(out, /\$1\.11/, "resolved to pid-70001 stats via /proc walk");
  });

  // win32: degraded fallback to process.ppid + one-shot stderr warning so
  // power users notice that concurrent sessions may collide.
  test("win32: degrades to ppid with stderr warning", () => {
    const ppid = process.ppid;
    writeStats(dir, `pid-${ppid}`, {
      schemaVersion: 1,
      version: "test",
      updated_at: Date.now(),
      uptime_ms: 60_000,
      reduction_pct: 42,
      dollars_saved_session: 0.55,
      dollars_saved_lifetime: 0,
      by_tool: {},
    });

    const { stdout, stderr } = runStatuslineFull({
      CONTEXT_MODE_SESSION_DIR: dir,
      CTX_TEST_PLATFORM: "win32",
      CLAUDE_SESSION_ID: "",
    });

    assert.match(stdout, /\$0\.55/, "fell back to ppid-based stats");
    assert.match(
      stderr,
      /Windows process-tree walk unsupported/i,
      "warns power users that Windows resolution is degraded",
    );
  });
});

// ── schemaVersion handling (P1.3) ─────────────────────────────────────────
// MCP writer (src/server.ts) stamps `schemaVersion` on the persisted stats
// payload. Statusline must:
//   - render normally when schemaVersion matches what it knows
//   - silently fall back when schemaVersion is missing (legacy v1.0.103)
//   - warn (stderr) + still render known fields when schemaVersion exceeds
//     KNOWN_SCHEMA_VERSION — so a newer MCP server doesn't blank the bar.
describe("statusline.mjs — schemaVersion handling", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-statusline-schema-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("schemaVersion=1 renders cleanly with no warning", () => {
    writeStats(dir, "pid-schema-known", {
      schemaVersion: 1,
      version: "test",
      updated_at: Date.now(),
      uptime_ms: 60_000,
      reduction_pct: 88,
      dollars_saved_session: 2.22,
      dollars_saved_lifetime: 0,
      by_tool: {},
    });

    const { stdout, stderr } = runStatuslineFull({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-schema-known",
    });

    assert.match(stdout, /\$2\.22/);
    assert.match(stdout, /88% efficient/);
    assert.doesNotMatch(stderr, /schemaVersion/, "no warning for known schema");
  });

  test("missing schemaVersion: silent legacy fallback", () => {
    // No schemaVersion field at all — represents v1.0.103-era payloads.
    writeStats(dir, "pid-schema-legacy", {
      version: "legacy",
      updated_at: Date.now(),
      uptime_ms: 60_000,
      reduction_pct: 77,
      dollars_saved_session: 3.33,
      dollars_saved_lifetime: 0,
      by_tool: {},
    });

    const { stdout, stderr } = runStatuslineFull({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-schema-legacy",
    });

    assert.match(stdout, /\$3\.33/, "renders normally despite missing version");
    assert.doesNotMatch(stderr, /schemaVersion/, "no warning for legacy payloads");
  });

  test("schemaVersion=999 warns to stderr but still renders known fields", () => {
    writeStats(dir, "pid-schema-future", {
      schemaVersion: 999,
      version: "future",
      updated_at: Date.now(),
      uptime_ms: 60_000,
      reduction_pct: 66,
      dollars_saved_session: 4.44,
      dollars_saved_lifetime: 0,
      by_tool: {},
      // Pretend a future MCP added unknown fields — must not crash us.
      future_field_we_dont_understand: { nested: "stuff" },
    });

    const { stdout, stderr } = runStatuslineFull({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-schema-future",
    });

    assert.match(
      stderr,
      /schemaVersion=999 newer than known=1/,
      "warns about unknown future schema",
    );
    assert.match(stdout, /\$4\.44/, "still renders known $ field");
    assert.match(stdout, /66% efficient/, "still renders known % field");
    assert.doesNotMatch(stdout, /NaN/);
  });
});
