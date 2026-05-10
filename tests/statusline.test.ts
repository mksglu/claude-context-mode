/**
 * Behavioral tests for the statusLine pipeline.
 *
 * The status line is composed of three layers:
 *   1. server.ts persists session data to SessionDB (`session_events` +
 *      `session_resume`) on every tool call. (Sidecar JSON
 *      `stats-pid-*.json` is legacy — see persistStats() in server.ts.)
 *   2. bin/statusline.mjs reads SessionDB directly via getRealBytesStats()
 *      / getMultiAdapterLifetimeStats() — same source as `ctx_stats`.
 *   3. cli.ts adds a `stats` subcommand humans can run directly.
 *
 * These tests focus on the rendering surface and the PID-resolution
 * contract, since those are the parts that ship to users and break
 * silently. The MCP persistence layer is exercised end-to-end by the
 * smoke harness in tests/mcp-integration.ts.
 *
 * Detailed SessionDB-backed render coverage lives in
 * tests/statusline-sqlite.test.ts; this file pins (a) headline fallback
 * paths and (b) cross-OS PID resolver behavior.
 */

import { describe, test, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

const STATUSLINE = resolve(
  process.cwd(),
  "bin",
  "statusline.mjs",
);

/**
 * Seed a SessionDB so the statusline has something to render. The session_id
 * is what the statusline resolver computes (`pid-<claude pid>` or the env
 * override) — when we want to assert "the resolver landed on PID X", we seed
 * an event tagged with `session_id = pid-X` and check that its $ surfaces.
 */
function seedDb(opts: {
  dir: string;
  sessionId: string;
  /** Defaults to one event with bytes_avoided = 1MB → ~$3.84 lifetime $. */
  bytesAvoided?: number;
  events?: number;
  worktreeHash?: string;
}): string {
  const hash = opts.worktreeHash ?? "b".repeat(16);
  const dbPath = join(opts.dir, `${hash}.db`);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 2,
      data TEXT NOT NULL,
      project_dir TEXT NOT NULL DEFAULT '',
      attribution_source TEXT NOT NULL DEFAULT 'unknown',
      attribution_confidence REAL NOT NULL DEFAULT 0,
      bytes_avoided INTEGER NOT NULL DEFAULT 0,
      bytes_returned INTEGER NOT NULL DEFAULT 0,
      source_hook TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      data_hash TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_event_at TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      compact_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS session_resume (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      snapshot TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      consumed INTEGER NOT NULL DEFAULT 0
    );
  `);
  const events = opts.events ?? 1;
  const perEvent = Math.floor((opts.bytesAvoided ?? 1_048_576) / events);
  const ins = db.prepare(
    `INSERT INTO session_events (session_id, type, category, data, bytes_avoided, source_hook)
     VALUES (?, 'tool_use', 'tool', ?, ?, '')`
  );
  for (let i = 0; i < events; i++) {
    ins.run(opts.sessionId, "x".repeat(64), perEvent);
  }
  db.prepare(
    `INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, '/tmp/test')`
  ).run(opts.sessionId);
  db.close();
  return dbPath;
}

function runStatusline(env: Record<string, string>) {
  const result = spawnSync("node", [STATUSLINE], {
    input: "{}",
    env: { ...process.env, NO_COLOR: "1", ...env },
    encoding: "utf-8",
  });
  return result.stdout.trim();
}

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

describe("statusline.mjs — render fallbacks", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-statusline-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // BRAND-NEW state: no SessionDB. Falls back to substantiated README
  // headline ("~98% of context window") — no fabricated $/dev/month copy.
  test("brand-new state: no SessionDB shows substantiated headline", () => {
    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-doesnotexist",
    });
    assert.match(out, /context-mode/);
    assert.match(out, /saves ~98% of context window/);
    assert.doesNotMatch(out, /\$\d+\/dev\/month/, "no fabricated $/dev/month claim");
  });

  // Empty sessions dir (exists but no .db) — same headline fallback.
  test("empty sessions dir shows substantiated headline", () => {
    // dir is freshly mkdtemp'd — empty, no .db files.
    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-empty",
    });
    assert.match(out, /context-mode/);
    assert.match(out, /saves ~98% of context window/);
    assert.doesNotMatch(out, /NaN/);
  });

  // Corrupt SessionDB — must degrade to headline rather than expose a parse
  // error to the buyer's screen. The analytics layer absorbs SQLite errors;
  // we verify the renderer never crashes.
  test("corrupt .db file degrades to headline", () => {
    writeFileSync(join(dir, "deadbeefdeadbeef.db"), "not a sqlite file");
    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "pid-bad",
    });
    assert.match(out, /context-mode/);
    assert.match(out, /saves ~98% of context window/);
    assert.doesNotMatch(out, /NaN/);
  });
});

// ── Cross-OS session-id resolution ────────────────────────────────────────
// The statusline must walk the parent process chain on macOS + Linux to
// avoid colliding session-id lookups when multiple Claude sessions are
// open. Windows lacks /proc and a stable BSD `ps`, so it degrades cleanly
// with a one-shot stderr warning rather than picking the wrong session.
//
// Test approach: drive the resolver via test-only env seams baked into
// statusline.mjs (CTX_TEST_PLATFORM, CTX_TEST_PROC_DIR) plus PATH-shimmed
// fake binaries for `ps`. The resolver is exercised end-to-end through the
// session-id → render path — assertion is "did the right pid-* event get
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
  // walking up from process.ppid → fakeParent → fakeClaude resolves to a
  // deterministic PID, which the statusline then uses as the session_id.
  //
  // The statusline subprocess's process.ppid is the vitest worker pid
  // (which is THIS file's `process.pid`). The fake ps must start its
  // ancestry chain at THAT pid so the walk has something to follow.
  //
  // Skipped on win32: the fake `ps` shim is a bash script with `#!/bin/sh`,
  // which Windows' CreateProcess cannot execute via execFileSync (no
  // shell-script binfmt). Production statusline on Windows takes the
  // explicit win32 branch (line 119-125 of bin/statusline.mjs) and never
  // reaches findClaudePidDarwin anyway, so coverage is irrelevant there.
  test.skipIf(process.platform === "win32")("darwin: walks parent chain via ps to find claude PID", () => {
    const statuslineParentPid = process.pid;
    const fakePs = join(scratch, "ps");
    writeFileSync(
      fakePs,
      `#!/bin/sh
# fake ps for statusline resolver tests
# args: -o ppid=,comm= -p <pid>  →  $1=-o $2=ppid=,comm= $3=-p $4=<pid>
pid="$4"
case "$pid" in
  ${statuslineParentPid}) echo "  90001 /bin/zsh"; exit 0 ;;
  90001) echo "      1 /opt/claude-code/bin/claude"; exit 0 ;;
  *) exit 0 ;;
esac
`,
    );
    chmodSync(fakePs, 0o755);

    // Seed event under session_id "pid-90001" — that's what the resolver
    // should produce when walking up to the fake claude PID 90001.
    seedDb({ dir, sessionId: "pid-90001", bytesAvoided: 1_048_576 });

    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CTX_TEST_PLATFORM: "darwin",
      // Ensure our shim wins:
      PATH: `${scratch}${delimiter}${process.env.PATH ?? ""}`,
      // Must NOT set CLAUDE_SESSION_ID — that bypasses the walk entirely.
      CLAUDE_SESSION_ID: "",
    });

    // The session $ block surfaces only when conversation matches the
    // resolved session_id. "saved this session" proves the walk landed
    // on pid-90001 and getRealBytesStats found those events.
    assert.match(
      out,
      /\$[0-9]/,
      "resolver landed on pid-90001 → SessionDB had matching events",
    );
    assert.match(out, /saved this session/);
  });

  // linux: walk via /proc/<pid>/status. CTX_TEST_PROC_DIR points at a
  // synthetic /proc populated with PPid + Name lines. The walk starts at
  // the statusline subprocess's process.ppid — which is THIS file's
  // process.pid (vitest worker).
  test("linux: walks parent chain via /proc to find claude PID", () => {
    const statuslineParentPid = process.pid;
    const fakeProc = join(scratch, "proc");
    mkdirSync(fakeProc, { recursive: true });
    mkdirSync(join(fakeProc, String(statuslineParentPid)), { recursive: true });
    mkdirSync(join(fakeProc, "70001"), { recursive: true });
    writeFileSync(
      join(fakeProc, String(statuslineParentPid), "status"),
      `Name:\tzsh\nPPid:\t70001\n`,
    );
    writeFileSync(
      join(fakeProc, "70001", "status"),
      `Name:\tclaude\nPPid:\t1\n`,
    );

    seedDb({ dir, sessionId: "pid-70001", bytesAvoided: 524_288 });

    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CTX_TEST_PLATFORM: "linux",
      CTX_TEST_PROC_DIR: fakeProc,
      CLAUDE_SESSION_ID: "",
    });

    assert.match(out, /\$[0-9]/, "resolver landed on pid-70001 via /proc walk");
    assert.match(out, /saved this session/);
  });

  // win32: degraded fallback to process.ppid + one-shot stderr warning so
  // power users notice that concurrent sessions may collide. The statusline
  // subprocess's process.ppid is THIS file's process.pid.
  test("win32: degrades to ppid with stderr warning", () => {
    const statuslineParentPid = process.pid;
    seedDb({ dir, sessionId: `pid-${statuslineParentPid}`, bytesAvoided: 524_288 });

    const { stdout, stderr } = runStatuslineFull({
      CONTEXT_MODE_SESSION_DIR: dir,
      CTX_TEST_PLATFORM: "win32",
      CLAUDE_SESSION_ID: "",
    });

    assert.match(stdout, /\$[0-9]/, "fell back to ppid-based session_id");
    assert.match(
      stderr,
      /Windows process-tree walk unsupported/i,
      "warns power users that Windows resolution is degraded",
    );
  });
});

// ── CONTEXT_MODE_SESSION_DIR override (backward-compat) ───────────────────
// Power users / tests rely on this env var to redirect the data source
// without patching getSessionDir(). Must keep working post-refactor.
describe("statusline.mjs — CONTEXT_MODE_SESSION_DIR override", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-statusline-override-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("CONTEXT_MODE_SESSION_DIR routes the SessionDB read to the override path", () => {
    seedDb({ dir, sessionId: "any-id", bytesAvoided: 2_097_152 }); // 2MB
    const out = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "any-id",
    });
    assert.match(out, /context-mode/);
    assert.match(out, /\$[0-9]/, "render reflects override-dir SessionDB");
    assert.match(out, /saved this session/);
  });
});
