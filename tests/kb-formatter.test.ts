/**
 * Regression tests for the v1.0.118 byte-formatter unification.
 *
 * v1.0.118 dropped the dual-currency display (statusline rendered "$X
 * saved" while ctx_stats showed bytes) and routed both surfaces through
 * a single exported `kb()` formatter in src/session/analytics.ts. These
 * tests pin the contract so a future change cannot reintroduce a $ in
 * the statusline or let the two surfaces drift apart again.
 *
 * Slices:
 *   1. kb() boundary values (0, sub-KB, KB, MB, GB)
 *   2. kb() is exported from analytics (so statusline can import it)
 *   3. Statusline output never contains "$"
 *   4. Statusline ACTIVE format uses "this chat" / "lifetime" / "kept out"
 *   5. Statusline FRESH (lifetime-only) format uses "kept out" / "KB/day"
 */

import { describe, test, expect } from "vitest";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

import { kb } from "../src/session/analytics.js";

const STATUSLINE = resolve(process.cwd(), "bin", "statusline.mjs");

function runStatusline(env: Record<string, string>): string {
  const result = spawnSync("node", [STATUSLINE], {
    input: "{}",
    env: { ...process.env, NO_COLOR: "1", ...env },
    encoding: "utf-8",
  });
  return result.stdout.trim();
}

function seedDb(opts: {
  dir: string;
  sessionId: string;
  bytesAvoided: number;
  worktreeHash?: string;
}): void {
  const hash = opts.worktreeHash ?? "f".repeat(16);
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
  db.prepare(
    `INSERT INTO session_events (session_id, type, category, data, bytes_avoided, source_hook)
     VALUES (?, 'tool_use', 'tool', ?, ?, '')`,
  ).run(opts.sessionId, "x".repeat(64), opts.bytesAvoided);
  db.prepare(
    `INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, '/tmp/test')`,
  ).run(opts.sessionId);
  db.close();
}

// ── Slice 1: kb() boundaries ──────────────────────────────────────

describe("kb() formatter", () => {
  test("returns 0 B for non-positive or non-finite values", () => {
    expect(kb(0)).toBe("0 B");
    expect(kb(-1)).toBe("0 B");
    expect(kb(NaN)).toBe("0 B");
    expect(kb(Infinity)).toBe("0 B");
  });

  test("returns rounded bytes below 1 KB", () => {
    expect(kb(1)).toBe("1 B");
    expect(kb(512)).toBe("512 B");
    expect(kb(1023)).toBe("1023 B");
  });

  test("returns KB with one decimal below 100 KB", () => {
    expect(kb(1024)).toBe("1.0 KB");
    expect(kb(1536)).toBe("1.5 KB");
    expect(kb(99 * 1024)).toBe("99.0 KB");
  });

  test("drops the decimal in KB at and above 100 KB", () => {
    expect(kb(100 * 1024)).toBe("100 KB");
    expect(kb(512 * 1024)).toBe("512 KB");
  });

  test("returns MB with one decimal below 100 MB", () => {
    expect(kb(1024 * 1024)).toBe("1.0 MB");
    expect(kb(Math.round(1.5 * 1024 * 1024))).toBe("1.5 MB");
  });

  test("drops the decimal in MB at and above 100 MB", () => {
    expect(kb(100 * 1024 * 1024)).toBe("100 MB");
    expect(kb(356 * 1024 * 1024)).toBe("356 MB");
  });

  test("returns GB with two decimals below 100 GB", () => {
    const oneGb = 1024 * 1024 * 1024;
    expect(kb(oneGb)).toBe("1.00 GB");
    expect(kb(2.55 * oneGb)).toBe("2.55 GB");
  });

  test("drops to one decimal in GB at and above 100 GB", () => {
    const oneGb = 1024 * 1024 * 1024;
    expect(kb(100 * oneGb)).toBe("100.0 GB");
    expect(kb(216.6 * oneGb)).toBe("216.6 GB");
  });
});

// ── Slice 2: kb is the shared export the statusline imports ───────

describe("kb() shared export contract", () => {
  test("kb is exported as a function from analytics", async () => {
    const mod = await import("../src/session/analytics.js");
    expect(typeof mod.kb).toBe("function");
  });

  test("statusline.mjs imports kb from analytics", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(STATUSLINE, "utf-8");
    // Whitespace-tolerant: kb may sit between siblings inside a destructure.
    assert.match(src, /\bkb\b\s*[,}]/);
  });
});

// ── Slice 3: statusline output never contains "$" ─────────────────

describe("statusline unit contract (v1.0.118)", () => {
  test("ACTIVE state output contains no '$' character", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-kb-fmt-active-"));
    try {
      seedDb({ dir, sessionId: "pid-kb-test", bytesAvoided: 1_048_576 });
      const out = runStatusline({
        CONTEXT_MODE_SESSION_DIR: dir,
        CLAUDE_SESSION_ID: "pid-kb-test",
      });
      assert.match(out, /context-mode/);
      assert.doesNotMatch(out, /\$/, "v1.0.118 dropped dollar math from statusline");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ACTIVE state output uses 'this chat' and 'kept out' phrases", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-kb-fmt-words-"));
    try {
      seedDb({ dir, sessionId: "pid-words", bytesAvoided: 1_048_576 });
      const out = runStatusline({
        CONTEXT_MODE_SESSION_DIR: dir,
        CLAUDE_SESSION_ID: "pid-words",
      });
      assert.match(out, /this chat/, "active block uses 'this chat'");
      assert.match(out, /kept out/, "percentage label is 'kept out'");
      assert.doesNotMatch(out, /saved this session/, "old phrase must not return");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ACTIVE state surfaces session bytes through kb() (KB/MB/GB)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-kb-fmt-units-"));
    try {
      // 1 MB bytes-avoided → statusline must render "1.0 MB this chat".
      seedDb({ dir, sessionId: "pid-mb", bytesAvoided: 1_048_576 });
      const out = runStatusline({
        CONTEXT_MODE_SESSION_DIR: dir,
        CLAUDE_SESSION_ID: "pid-mb",
      });
      assert.match(out, /\b\d+(\.\d+)?\s*(KB|MB|GB)\s+this chat\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // FRESH state: lifetime > 0 but the current session has no events. Statusline
  // falls into the "lead with lifetime" branch and renders the lifetime kb()
  // total + the "preserved across compact" tagline. We seed under a session_id
  // the resolver can't match so conversation bytes stay at zero while lifetime
  // totals are nonzero. The optional "/day" metric only appears when the
  // analytics layer can compute lifetime age — covered separately in
  // stats-output-format tests.
  test("FRESH state output uses kept out + lifetime kb() and contains no '$'", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-kb-fmt-fresh-"));
    try {
      seedDb({ dir, sessionId: "pid-other", bytesAvoided: 2_097_152 });
      const out = runStatusline({
        HOME: dir,
        CONTEXT_MODE_SESSION_DIR: dir,
        CLAUDE_SESSION_ID: "pid-mismatch",
      });
      assert.match(out, /context-mode/);
      assert.match(out, /\bkept out\b/, "FRESH state surfaces 'kept out' label");
      assert.match(out, /\b\d+(\.\d+)?\s*(KB|MB|GB)\b/, "lifetime rendered via kb()");
      assert.match(out, /preserved across compact/, "FRESH tagline visible");
      assert.doesNotMatch(out, /\$/, "v1.0.118 dropped dollar math everywhere");
      assert.doesNotMatch(out, /\bthis chat\b/, "no ACTIVE 'this chat' block in FRESH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
