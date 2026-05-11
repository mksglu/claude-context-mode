/**
 * D2 PRD Phase 6.1 — precompact.mjs emits snapshot-built event with bytes_avoided.
 *
 * Spawns the real precompact.mjs hook (matching the integration.test.ts pattern),
 * pre-seeds the per-project SessionDB with a few events so a snapshot can build,
 * runs the hook, then opens the DB raw and asserts the new
 * `category='compaction', type='snapshot-built', bytes_avoided > 0` row landed.
 */

import { describe, test, beforeAll, afterAll, expect } from "vitest";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { SessionDB } from "../../src/session/db.js";
import { loadDatabase } from "../../src/db-base.js";


const _hashCanonical = (p: string) => createHash("sha256").update(
  (process.platform === "darwin" || process.platform === "win32") ? p.toLowerCase() : p
).digest("hex").slice(0, 16);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRECOMPACT_PATH = join(__dirname, "..", "..", "hooks", "precompact.mjs");

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

describe("precompact.mjs — snapshot-built event (D2 PRD Phase 6.1)", () => {
  let fakeHome: string;
  let fakeProject: string;
  let env: Record<string, string>;
  const sessionId = "precompact-snapshot-test-session";

  beforeAll(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "ctx-precompact-home-"));
    fakeProject = mkdtempSync(join(tmpdir(), "ctx-precompact-project-"));
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

  test("emits snapshot-built event with bytes_avoided > 0", () => {
    // Pre-seed the SessionDB at the path precompact.mjs would resolve.
    // Use the same hash scheme as session-helpers.mjs:getSessionDBPath.
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    // Hooks hash the path AFTER normalizeWorktreePath() (\ → /), so the test
    // must apply the same normalization before SHA — otherwise on Windows the
    // expected hash uses backslashes while the hook uses slashes (#435 pattern).
    const projectHash = _hashCanonical(fakeProject.replace(/\\/g, "/"));
    const dbDir = join(fakeHome, ".claude", "context-mode", "sessions");
    require("node:fs").mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, `${projectHash}.db`);

    {
      const seedDb = new SessionDB({ dbPath });
      seedDb.ensureSession(sessionId, fakeProject);
      // A few events so buildResumeSnapshot has content to produce non-empty output.
      for (let i = 0; i < 5; i++) {
        seedDb.insertEvent(
          sessionId,
          {
            type: "file",
            category: "file",
            data: `/project/src/file-${i}.ts`,
            priority: 2,
          },
          "PostToolUse",
        );
      }
      seedDb.close();
    }

    // Run precompact.mjs subprocess.
    const result = spawnSync("node", [PRECOMPACT_PATH], {
      input: JSON.stringify({ session_id: sessionId, cwd: fakeProject }),
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, ...env },
    });

    assert.equal(result.status, 0, `precompact exit non-zero. stderr: ${result.stderr}`);
    assert.ok(existsSync(dbPath), "session DB must exist after precompact");

    const rows = readEvents(dbPath, sessionId, "snapshot-built");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row.category).toBe("compaction");
    expect(row.type).toBe("snapshot-built");
    expect(row.bytes_avoided).toBeGreaterThan(0);
    expect(row.bytes_returned).toBe(0);
  });
});
