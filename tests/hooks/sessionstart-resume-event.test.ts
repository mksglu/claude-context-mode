/**
 * D2 PRD Phase 6.2 — sessionstart.mjs emits snapshot-consumed with bytes_returned.
 *
 * Pre-seeds a session_resume row, runs sessionstart.mjs with source=compact,
 * then asserts the new event row landed with
 * `category='session-resume', type='snapshot-consumed', bytes_returned == snapshot.length`.
 */

import { describe, test, beforeAll, afterAll, expect } from "vitest";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { SessionDB } from "../../src/session/db.js";
import { loadDatabase } from "../../src/db-base.js";


const _hashCanonical = (p: string) => createHash("sha256").update(
  (process.platform === "darwin" || process.platform === "win32") ? p.toLowerCase() : p
).digest("hex").slice(0, 16);

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONSTART_PATH = join(__dirname, "..", "..", "hooks", "sessionstart.mjs");

interface RawEventRow {
  type: string;
  category: string;
  bytes_avoided: number;
  bytes_returned: number;
  data: string;
}

function readEvents(dbPath: string, sessionId: string, type: string): RawEventRow[] {
  const Database = loadDatabase();
  const raw = new Database(dbPath, { readonly: true });
  try {
    return raw
      .prepare(
        "SELECT type, category, bytes_avoided, bytes_returned, data FROM session_events " +
        "WHERE session_id = ? AND type = ?",
      )
      .all(sessionId, type) as RawEventRow[];
  } finally {
    raw.close();
  }
}

describe("sessionstart.mjs — snapshot-consumed event (D2 PRD Phase 6.2)", () => {
  let fakeHome: string;
  let fakeProject: string;
  let env: Record<string, string>;
  const sessionId = "sessionstart-resume-test-session";
  const SNAPSHOT_BODY = "<resume>example snapshot body for byte accounting</resume>";

  beforeAll(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "ctx-sessionstart-home-"));
    fakeProject = mkdtempSync(join(tmpdir(), "ctx-sessionstart-project-"));
    env = {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      CLAUDE_CONFIG_DIR: join(fakeHome, ".claude"),
      CLAUDE_PROJECT_DIR: fakeProject,
      CLAUDE_SESSION_ID: sessionId,
      CONTEXT_MODE_SESSION_SUFFIX: "",
    };
  });

  afterAll(() => {
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    try { rmSync(fakeProject, { recursive: true, force: true }); } catch {}
  });

  test("emits snapshot-consumed with bytes_returned == snapshot.length", () => {
    // Hooks hash the path AFTER normalizeWorktreePath() (\ → /), so the test
    // must apply the same normalization before SHA — otherwise on Windows the
    // expected hash uses backslashes while the hook uses slashes (#435 pattern).
    const projectHash = _hashCanonical(fakeProject.replace(/\\/g, "/"));
    const dbDir = join(fakeHome, ".claude", "context-mode", "sessions");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, `${projectHash}.db`);

    {
      const seedDb = new SessionDB({ dbPath });
      seedDb.ensureSession(sessionId, fakeProject);
      // sessionstart.mjs (source=compact) takes the resume snapshot path only
      // when getSessionEvents() returns a non-empty list. Seed at least one
      // event so the directive branch — and then the snapshot-consumed emit —
      // run.
      seedDb.insertEvent(
        sessionId,
        { type: "file", category: "file", data: "/project/src/seed.ts", priority: 2 },
        "PostToolUse",
      );
      seedDb.upsertResume(sessionId, SNAPSHOT_BODY, 1);
      seedDb.close();
    }

    const result = spawnSync("node", [SESSIONSTART_PATH], {
      input: JSON.stringify({ session_id: sessionId, source: "compact", cwd: fakeProject }),
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, ...env },
    });

    assert.equal(result.status, 0, `sessionstart exit non-zero. stderr: ${result.stderr}`);
    assert.ok(existsSync(dbPath), "session DB must exist after sessionstart");

    const rows = readEvents(dbPath, sessionId, "snapshot-consumed");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row.category).toBe("session-resume");
    expect(row.type).toBe("snapshot-consumed");
    expect(row.bytes_returned).toBe(SNAPSHOT_BODY.length);
    expect(row.bytes_avoided).toBe(0);
  });
});
