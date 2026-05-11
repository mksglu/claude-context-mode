/**
 * D2 PRD Phase 3 — bash-redirected marker pattern (slices 3.1–3.5).
 *
 * Slice 3.1: PreToolUse writes the redirect marker file when a curl/wget
 *            command is intercepted.
 * Slice 3.2: PostToolUse reads the marker, emits a `category=redirect,
 *            type=bash-redirected, bytes_avoided=8192` event, and unlinks.
 * Slice 3.3: marker is unlinked after read (no double-emit on a follow-up
 *            PostToolUse for an unrelated tool call).
 * Slice 3.4: when no marker is present, no phantom event is emitted.
 * Slice 3.5: long curl/wget commands are truncated to 200 chars in the marker.
 */

import { describe, test, beforeAll, beforeEach, afterAll, afterEach, expect } from "vitest";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
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
const PRETOOL_PATH = join(__dirname, "..", "..", "hooks", "pretooluse.mjs");
const POSTTOOL_PATH = join(__dirname, "..", "..", "hooks", "posttooluse.mjs");

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

// MCP readiness sentinel — hooks check /tmp on Unix, tmpdir() on Windows.
// Without it, mcpRedirect() returns null (passthrough) and no marker is written.
const mcpSentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
const mcpSentinel = resolve(mcpSentinelDir, `context-mode-mcp-ready-${process.pid}`);

describe("D2 Phase 3 — bash-redirected marker pattern", () => {
  let fakeHome: string;
  let fakeProject: string;
  let env: Record<string, string>;
  const sessionId = "redirect-bash-test-session";
  let dbPath: string;

  beforeAll(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "ctx-redirect-bash-home-"));
    fakeProject = mkdtempSync(join(tmpdir(), "ctx-redirect-bash-project-"));
    env = {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      CLAUDE_CONFIG_DIR: join(fakeHome, ".claude"),
      CLAUDE_PROJECT_DIR: fakeProject,
      CLAUDE_SESSION_ID: sessionId,
      CONTEXT_MODE_SESSION_SUFFIX: "",
    };
    // Hooks hash the path AFTER normalizeWorktreePath() (\ → /), so the test
    // must apply the same normalization before SHA — otherwise on Windows the
    // expected hash uses backslashes while the hook uses slashes (#435 pattern).
    const projectHash = _hashCanonical(fakeProject.replace(/\\/g, "/"));
    const dbDir = join(fakeHome, ".claude", "context-mode", "sessions");
    mkdirSync(dbDir, { recursive: true });
    dbPath = join(dbDir, `${projectHash}.db`);
  });

  afterAll(() => {
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    try { rmSync(fakeProject, { recursive: true, force: true }); } catch {}
  });

  beforeEach(() => {
    writeFileSync(mcpSentinel, String(process.pid));
    // Clean any leftover marker so each slice starts clean.
    const m = resolve(tmpdir(), `context-mode-redirect-${sessionId}.txt`);
    try { unlinkSync(m); } catch {}
  });

  afterEach(() => {
    try { unlinkSync(mcpSentinel); } catch {}
  });

  function runPre(cmd: string) {
    return spawnSync("node", [PRETOOL_PATH], {
      input: JSON.stringify({
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: { command: cmd },
      }),
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, ...env },
    });
  }

  function runPost(toolName: string, toolInput: object, response: string) {
    return spawnSync("node", [POSTTOOL_PATH], {
      input: JSON.stringify({
        session_id: sessionId,
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: response,
      }),
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, ...env },
    });
  }

  // ─── Slice 3.1 ───────────────────────────────────────────
  test("3.1: PreToolUse writes redirect marker on curl", () => {
    const r = runPre("curl https://api.example.com/data.json");
    assert.equal(r.status, 0, `pretooluse non-zero. stderr: ${r.stderr}`);

    const markerPath = resolve(tmpdir(), `context-mode-redirect-${sessionId}.txt`);
    assert.ok(existsSync(markerPath), "marker file must be written");
    const content = readFileSync(markerPath, "utf-8");
    expect(content.startsWith("Bash:bash-redirected:8192:")).toBe(true);
    expect(content).toContain("curl https://api.example.com");
  });

  // ─── Slice 3.2 ───────────────────────────────────────────
  test("3.2: PostToolUse reads marker + emits redirect event with bytes_avoided=8192", () => {
    runPre("curl https://example.com/secret");
    const post = runPost("Bash", { command: "echo blocked" }, "ok");
    assert.equal(post.status, 0, `posttooluse non-zero. stderr: ${post.stderr}`);

    const rows = readEvents(dbPath, sessionId, "bash-redirected");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].category).toBe("redirect");
    expect(rows[0].bytes_avoided).toBe(8192);
    expect(rows[0].bytes_returned).toBe(0);
    expect(rows[0].data).toContain("Bash:");
  });

  // ─── Slice 3.3 ───────────────────────────────────────────
  test("3.3: marker is unlinked after PostToolUse reads it (no double-emit)", () => {
    runPre("curl https://example.com");
    const markerPath = resolve(tmpdir(), `context-mode-redirect-${sessionId}.txt`);
    assert.ok(existsSync(markerPath), "marker should exist before PostToolUse");

    runPost("Bash", { command: "echo blocked" }, "ok");
    assert.ok(!existsSync(markerPath), "marker must be deleted after PostToolUse");

    // Second PostToolUse for an unrelated tool — no new redirect event should land.
    const before = readEvents(dbPath, sessionId, "bash-redirected").length;
    runPost("Edit", { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" }, "ok");
    const after = readEvents(dbPath, sessionId, "bash-redirected").length;
    expect(after).toBe(before);
  });

  // ─── Slice 3.4 ───────────────────────────────────────────
  test("3.4: no marker → no phantom redirect event", () => {
    // No PreToolUse → no marker.
    const before = readEvents(dbPath, sessionId, "bash-redirected").length;
    runPost("Read", { file_path: "/tmp/whatever.ts" }, "ok");
    const after = readEvents(dbPath, sessionId, "bash-redirected").length;
    expect(after).toBe(before);
  });

  // ─── Slice 3.5 ───────────────────────────────────────────
  test("3.5: long command summary truncated to 200 chars in marker", () => {
    const longCmd = "curl " + "https://example.com/" + "a".repeat(500);
    runPre(longCmd);
    const markerPath = resolve(tmpdir(), `context-mode-redirect-${sessionId}.txt`);
    const content = readFileSync(markerPath, "utf-8");
    // Format: tool:type:bytes:summary — extract everything after the 3rd colon.
    const i1 = content.indexOf(":");
    const i2 = content.indexOf(":", i1 + 1);
    const i3 = content.indexOf(":", i2 + 1);
    const summary = content.slice(i3 + 1);
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary.length).toBeGreaterThan(0);
  });
});
