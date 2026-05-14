/**
 * db-base platform gate — issue #551 follow-up.
 *
 * Node 26 removed `info.This()` from V8 PropertyCallbackInfo. better-sqlite3
 * 12.9.0 still calls it, so the native addon fails to compile on
 * darwin-arm64 + Node 26. Workaround: prefer the built-in `node:sqlite`
 * adapter (which ships its own SQLite, no native compile) on every platform
 * that has it — not just Linux.
 *
 * v1.0.124 gated `node:sqlite` adoption on `process.platform === "linux"`.
 * v1.0.125 widens the gate to `hasModernSqlite()` (Bun OR Node >= 22.5),
 * matching the helper that already exists in hooks/ensure-deps.mjs:61.
 *
 * Source-level guard: parses src/db-base.ts to assert the gate references
 * `hasModernSqlite` (not the legacy `process.platform === "linux"`).
 * Runtime guard: invokes the exported helper against synthetic Node
 * versions and asserts the expected boolean.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

describe("db-base platform gate (#551)", () => {
  const dbBasePath = resolve(__dirname, "..", "..", "src", "db-base.ts");
  const src = readFileSync(dbBasePath, "utf8");

  it("exports hasModernSqlite helper (Bun OR Node >= 22.5)", async () => {
    const mod = await import("../../src/db-base.js");
    expect(typeof (mod as Record<string, unknown>).hasModernSqlite).toBe("function");
    // The helper must return a boolean for the live runtime (true or false
    // depending on the test environment's Node version).
    const live = (mod as { hasModernSqlite: () => boolean }).hasModernSqlite();
    expect(typeof live).toBe("boolean");
  });

  it("loadDatabase ladder uses hasModernSqlite() — not the legacy linux gate", () => {
    // After the gate widening, the only Linux check that should survive is
    // inside the COMMENT explaining the SIGSEGV history; the runtime branch
    // must call hasModernSqlite().
    const loadDbRegion = src.split("export function loadDatabase")[1] ?? "";
    expect(loadDbRegion).toContain("hasModernSqlite()");
    // Defensive: ensure the legacy gate `process.platform === "linux"` no
    // longer appears as a runtime branch condition in loadDatabase.
    expect(loadDbRegion).not.toMatch(/process\.platform\s*===\s*"linux"/);
  });

  it("hasModernSqlite returns true for Bun and Node >= 22.5", async () => {
    // Sanity: when we mock process.versions.node to 26.0.0 the helper must
    // return true — this is the codepath that fixes the macOS+Node26 break.
    const { hasModernSqlite } = (await import("../../src/db-base.js")) as {
      hasModernSqlite: (versionsOverride?: NodeJS.ProcessVersions, bun?: unknown) => boolean;
    };
    expect(
      hasModernSqlite({ ...process.versions, node: "26.0.0" }, undefined),
    ).toBe(true);
    expect(
      hasModernSqlite({ ...process.versions, node: "22.5.0" }, undefined),
    ).toBe(true);
    // Bun runtime — always true.
    expect(
      hasModernSqlite({ ...process.versions, node: "18.0.0" }, /* fakeBun */ {}),
    ).toBe(true);
    // Old Node, no Bun — false.
    expect(
      hasModernSqlite({ ...process.versions, node: "22.4.0" }, undefined),
    ).toBe(false);
    expect(
      hasModernSqlite({ ...process.versions, node: "20.10.0" }, undefined),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// v1.0.130 INVARIANT — multi-writer SessionDB on the same on-disk path.
//
// CONTRACT: SessionDB is multi-writer-safe. Two SessionDB instances on
// the same dbPath MUST both open, write, and read successfully without
// either of them throwing. WAL + busy_timeout + withRetry handle the
// concurrency natively — that is the SQLite default contract for shared
// on-disk DBs.
//
// HISTORY: v1.0.128 introduced an `acquireDbLock` lockfile + `locking_mode
// = EXCLUSIVE` pragma in the SQLiteBase ctor as a defense against #560.
// That defense was an OVER-CORRECTION — the real root causes of #560
// were #559 (zombie MCP child accumulation) and #561 (Pi misdetection
// writing to the wrong DB path). With both root causes fixed in v1.0.128
// + v1.0.129, normal usage is one MCP process per Claude session per
// project; legitimate multi-window UX means two processes on the SAME
// dbPath, which the SQLite WAL handles natively.
//
// REGRESSION-PROOF: this test is the load-bearing anchor. If anyone in
// the future re-adds a lockfile or EXCLUSIVE pragma to SQLiteBase, this
// test will fail loudly in CI before merge. DO NOT delete or weaken it.
//
// See: docs/adr/0001-sessiondb-multi-writer.md
// ─────────────────────────────────────────────────────────
describe("v1.0.130 INVARIANT — SQLiteBase multi-writer default", () => {
  // Source-pin invariant. The behavioural test above proves the contract
  // holds today. This source-level invariant catches the FUTURE regression
  // shape: a contributor pulling acquireDbLock or locking_mode=EXCLUSIVE
  // back into the SQLiteBase ctor. Even if their behavioural tests pass
  // (e.g. they claim to skip-gate via tmpdir), the rollback contract says
  // these primitives MUST NOT exist in the SQLiteBase ctor at all.
  it("INVARIANT: SQLiteBase ctor must NOT contain acquireDbLock or locking_mode=EXCLUSIVE", () => {
    const dbBasePath = resolve(__dirname, "..", "..", "src", "db-base.ts");
    const src = readFileSync(dbBasePath, "utf8");
    const classIdx = src.indexOf("export abstract class SQLiteBase");
    expect(classIdx).toBeGreaterThan(-1);
    // Bound the class body at the next top-level export so we don't
    // accidentally match unrelated code below the class.
    const classBody = src.slice(classIdx).split(/\nexport (?:function|abstract|class|const|let|var) /)[0] ?? "";

    // Lockfile primitive — banned. Anchor on identifier names so a
    // future renamed variant (`acquireDBLock`, `acquireDbLockSync`, etc.)
    // still trips the check.
    expect(classBody).not.toMatch(/acquireDbLock/i);
    expect(classBody).not.toMatch(/releaseDbLock/i);
    // EXCLUSIVE locking_mode — banned. Whitespace-tolerant.
    expect(classBody).not.toMatch(/locking_mode\s*=\s*EXCLUSIVE/i);
  });

  it("INVARIANT: two SQLiteBase instances on the same tmpdir path can both open and write (multi-writer default)", async () => {
    // Use a real on-disk path OUTSIDE tmpdir. The v1.0.128 + v1.0.129
    // skip-gate excused tmpdir paths from the lockfile + EXCLUSIVE
    // pragma, so a tmpdir path would not exercise the regression. The
    // legitimate multi-window UX runs against project DBs (NOT tmpdir),
    // so the invariant must hold for real on-disk paths.
    const testDir = mkdtempSync(join(process.env.HOME || "/tmp", ".ctx-mode-multiwriter-invariant-"));
    const dbPath = join(testDir, "multi-writer.db");
    const { SessionDB } = await import("../../src/session/db.js");
    let a: InstanceType<typeof SessionDB> | null = null;
    let b: InstanceType<typeof SessionDB> | null = null;
    try {
      a = new SessionDB({ dbPath });
      // The whole point: this MUST NOT throw. v1.0.128 + v1.0.129
      // would throw DatabaseLockedError ("Another context-mode server
      // is already running") here. WAL handles two writers natively,
      // and the busy_timeout + withRetry in withRetry() is the right
      // defense for SQLITE_BUSY.
      b = new SessionDB({ dbPath });
      expect(a).toBeTruthy();
      expect(b).toBeTruthy();
      // Both instances must be functional — write through both. This
      // proves WAL multi-writer works end-to-end, not just that the
      // ctors silently coexist. insertEvent goes through withRetry +
      // busy_timeout (the documented BUSY-handling path).
      const eventA = {
        type: "PreToolUse",
        category: "tool",
        data: JSON.stringify({ from: "writer-a" }),
        priority: 0,
      };
      const eventB = {
        type: "PreToolUse",
        category: "tool",
        data: JSON.stringify({ from: "writer-b" }),
        priority: 0,
      };
      a.insertEvent("invariant-session-a", eventA);
      b.insertEvent("invariant-session-b", eventB);
    } finally {
      try { a?.cleanup(); } catch { /* best effort */ }
      try { b?.close(); } catch { /* best effort */ }
      try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});

// ─────────────────────────────────────────────────────────
// v1.0.130 — SQLiteBase lifecycle (multi-writer contract)
//
// The v1.0.128 single-writer guard tests (acquireDbLock helper, lockfile
// throw on second open, close+cleanup releaseDbLock plumbing, lifecycle
// release-then-reopen) tested a contract we have rolled out. They are
// gone. What replaces them, on top of the INVARIANT block above, is a
// focused lifecycle test that proves close() does not leak global state
// — `_liveDBs` must shrink so the process-exit hook doesn't double-close
// a closed handle. This is the lifecycle invariant the lockfile tests
// indirectly covered, made explicit.
// ─────────────────────────────────────────────────────────
describe("v1.0.130 — SQLiteBase lifecycle composition", () => {
  it("close() then re-open on the same on-disk path succeeds (no leaked state)", async () => {
    // Mirror the multi-window "kill A, start B" flow: process A opens,
    // does work, closes; process B opens the same path. With the
    // lockfile gone this is just the standard SQLite lifecycle, but a
    // regression in `_liveDBs` accounting (or a stray pragma) would
    // surface here as a SIGSEGV during teardown or a SQLITE_BUSY on the
    // second open.
    const testDir = mkdtempSync(join(process.env.HOME || "/tmp", ".ctx-mode-v130-lifecycle-"));
    const dbPath = join(testDir, "lifecycle.db");
    const { SessionDB } = await import("../../src/session/db.js");
    try {
      const a = new SessionDB({ dbPath });
      a.close();
      const b = new SessionDB({ dbPath });
      expect(b).toBeTruthy();
      b.cleanup();
    } finally {
      try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("cleanup() removes the on-disk DB files (main + WAL + SHM)", async () => {
    // Lockfile artefacts are gone (slice 4 deleted the helper), so the
    // only files that should ever exist alongside a SessionDB are the
    // standard SQLite trio. After cleanup() the dbPath, dbPath-wal, and
    // dbPath-shm must all be unlinked.
    const testDir = mkdtempSync(join(process.env.HOME || "/tmp", ".ctx-mode-v130-cleanup-"));
    const dbPath = join(testDir, "cleanup.db");
    const { SessionDB } = await import("../../src/session/db.js");
    try {
      const db = new SessionDB({ dbPath });
      expect(existsSync(dbPath)).toBe(true);
      db.cleanup();
      expect(existsSync(dbPath)).toBe(false);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
      // No lockfile artefact ever exists in v1.0.130.
      expect(existsSync(`${dbPath}.lock`)).toBe(false);
    } finally {
      try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});
