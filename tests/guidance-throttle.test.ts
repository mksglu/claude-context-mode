import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { routePreToolUse, resetGuidanceThrottle } from "../hooks/core/routing.mjs";

const PROJECT_DIR = "/tmp/test-project";

// MCP readiness sentinel — routing.mjs checks process.ppid in-process
const mcpSentinel = resolve(tmpdir(), `context-mode-mcp-ready-${process.ppid}`);

describe("guidance throttle", () => {
  beforeEach(() => {
    // Reset throttle state between tests so each test starts fresh
    if (typeof resetGuidanceThrottle === "function") resetGuidanceThrottle();
    writeFileSync(mcpSentinel, String(process.pid));
  });

  afterEach(() => {
    try { unlinkSync(mcpSentinel); } catch {}
  });

  it("Read: first call returns guidance, subsequent calls return null", () => {
    const r1 = routePreToolUse("Read", { file_path: "/tmp/a.ts" }, PROJECT_DIR);
    const r2 = routePreToolUse("Read", { file_path: "/tmp/b.ts" }, PROJECT_DIR);
    const r3 = routePreToolUse("Read", { file_path: "/tmp/c.ts" }, PROJECT_DIR);

    expect(r1?.action).toBe("context");
    expect(r2).toBeNull();
    expect(r3).toBeNull();
  });

  it("Bash: first call returns guidance, second returns null", () => {
    const r1 = routePreToolUse("Bash", { command: "ls" }, PROJECT_DIR);
    const r2 = routePreToolUse("Bash", { command: "pwd" }, PROJECT_DIR);

    expect(r1?.action).toBe("context");
    expect(r2).toBeNull();
  });

  it("Grep: first call returns guidance, second returns null", () => {
    const r1 = routePreToolUse("Grep", { pattern: "foo" }, PROJECT_DIR);
    const r2 = routePreToolUse("Grep", { pattern: "bar" }, PROJECT_DIR);

    expect(r1?.action).toBe("context");
    expect(r2).toBeNull();
  });

  it("throttle is per-type: Read throttle does not affect Bash or Grep", () => {
    const read1 = routePreToolUse("Read", { file_path: "/tmp/a.ts" }, PROJECT_DIR);
    const bash1 = routePreToolUse("Bash", { command: "ls" }, PROJECT_DIR);
    const grep1 = routePreToolUse("Grep", { pattern: "foo" }, PROJECT_DIR);

    // All first calls return guidance
    expect(read1?.action).toBe("context");
    expect(bash1?.action).toBe("context");
    expect(grep1?.action).toBe("context");

    // All second calls return null
    const read2 = routePreToolUse("Read", { file_path: "/tmp/b.ts" }, PROJECT_DIR);
    const bash2 = routePreToolUse("Bash", { command: "pwd" }, PROJECT_DIR);
    const grep2 = routePreToolUse("Grep", { pattern: "bar" }, PROJECT_DIR);

    expect(read2).toBeNull();
    expect(bash2).toBeNull();
    expect(grep2).toBeNull();
  });

  it("deny/modify actions are NEVER throttled", () => {
    // WebFetch deny should always fire
    const d1 = routePreToolUse("WebFetch", { url: "https://example.com" }, PROJECT_DIR);
    const d2 = routePreToolUse("WebFetch", { url: "https://other.com" }, PROJECT_DIR);

    expect(d1?.action).toBe("deny");
    expect(d2?.action).toBe("deny");
  });

  it("resetGuidanceThrottle clears state (simulates new session)", () => {
    const r1 = routePreToolUse("Read", { file_path: "/tmp/a.ts" }, PROJECT_DIR);
    expect(r1?.action).toBe("context");

    const r2 = routePreToolUse("Read", { file_path: "/tmp/b.ts" }, PROJECT_DIR);
    expect(r2).toBeNull();

    // Reset = new session
    resetGuidanceThrottle();

    const r3 = routePreToolUse("Read", { file_path: "/tmp/c.ts" }, PROJECT_DIR);
    expect(r3?.action).toBe("context");
  });

  it("file-based markers persist across in-memory resets (cross-process sim)", () => {
    // First call creates both in-memory + file marker
    const r1 = routePreToolUse("Read", { file_path: "/tmp/a.ts" }, PROJECT_DIR);
    expect(r1?.action).toBe("context");

    // Clear only in-memory state (simulates new process with same ppid)
    resetGuidanceThrottle();

    // Manually re-create the marker to simulate file persisting from another process
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const wid = process.env.VITEST_WORKER_ID;
    const suffix = wid ? `${process.ppid}-w${wid}` : String(process.ppid);
    const dir = path.resolve(os.tmpdir(), `context-mode-guidance-${suffix}`);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    try { fs.writeFileSync(path.resolve(dir, "read"), "", "utf-8"); } catch {}

    // Should detect file marker even though in-memory was cleared
    const r2 = routePreToolUse("Read", { file_path: "/tmp/b.ts" }, PROJECT_DIR);
    expect(r2).toBeNull();
  });

  it("Bash passthrough returns null after guidance throttled (not context)", () => {
    // First Bash fires guidance
    const r1 = routePreToolUse("Bash", { command: "ls" }, PROJECT_DIR);
    expect(r1?.action).toBe("context");

    // Second Bash should be null passthrough, not another context
    const r2 = routePreToolUse("Bash", { command: "pwd" }, PROJECT_DIR);
    expect(r2).toBeNull();
  });

  // Regression coverage for #298 — Windows/Git Bash spawns a new bash.exe per
  // hook invocation, so process.ppid differs every call. The legacy marker-dir
  // naming (scoped to ppid) created a fresh directory each time and the
  // throttle never fired. The sessionId parameter scopes the marker directory
  // to a stable per-session identifier passed in from the hook payload.
  describe("sessionId scoping (#298 — stable across shifting ppids)", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");

    const SESSION_A = "a1b2c3d4-session-alpha";
    const SESSION_B = "e5f6a7b8-session-beta";

    function sessionDir(sessionId: string) {
      return path.resolve(os.tmpdir(), `context-mode-guidance-s-${sessionId}`);
    }

    function clearSessionDir(sessionId: string) {
      try { fs.rmSync(sessionDir(sessionId), { recursive: true, force: true }); } catch {}
    }

    beforeEach(() => {
      clearSessionDir(SESSION_A);
      clearSessionDir(SESSION_B);
    });

    afterEach(() => {
      clearSessionDir(SESSION_A);
      clearSessionDir(SESSION_B);
    });

    it("second call with same sessionId is throttled even when in-memory Set is cleared", () => {
      const r1 = routePreToolUse("Read", { file_path: "/tmp/a.ts" }, PROJECT_DIR, "claude-code", SESSION_A);
      expect(r1?.action).toBe("context");

      // Simulate a fresh Node.js process (as happens on every Windows Git Bash
      // hook invocation): in-memory state is gone, but the on-disk marker must
      // still block the second call.
      resetGuidanceThrottle();

      const r2 = routePreToolUse("Read", { file_path: "/tmp/b.ts" }, PROJECT_DIR, "claude-code", SESSION_A);
      expect(r2).toBeNull();
      // The marker must live under the session-scoped directory, not the ppid one
      expect(fs.existsSync(path.resolve(sessionDir(SESSION_A), "read"))).toBe(true);
    });

    it("different sessionIds get independent throttles", () => {
      const rA = routePreToolUse("Read", { file_path: "/tmp/a.ts" }, PROJECT_DIR, "claude-code", SESSION_A);
      expect(rA?.action).toBe("context");

      // Clear in-memory to ensure we're reading the file-based marker
      resetGuidanceThrottle();

      // Different session → fresh throttle → guidance fires again
      const rB = routePreToolUse("Read", { file_path: "/tmp/b.ts" }, PROJECT_DIR, "claude-code", SESSION_B);
      expect(rB?.action).toBe("context");
    });

    it("sessionId routing is immune to process.ppid changes", () => {
      // Claim the ppid-based fallback marker so we can prove the sessionId path
      // is independent of it. This mirrors what happens when a prior invocation
      // ran with a different ppid and wrote a marker in the legacy dir.
      const ppidSuffix = process.env.VITEST_WORKER_ID
        ? `${process.ppid}-w${process.env.VITEST_WORKER_ID}`
        : String(process.ppid);
      const ppidDir = path.resolve(os.tmpdir(), `context-mode-guidance-${ppidSuffix}`);
      try { fs.mkdirSync(ppidDir, { recursive: true }); } catch {}
      try { fs.writeFileSync(path.resolve(ppidDir, "bash"), "", "utf-8"); } catch {}

      // A sessionId-scoped call should NOT see the ppid marker — different namespace.
      const r = routePreToolUse("Bash", { command: "ls" }, PROJECT_DIR, "claude-code", SESSION_A);
      expect(r?.action).toBe("context");
    });

    it("resetGuidanceThrottle(sessionId) clears the session-scoped dir", () => {
      const r1 = routePreToolUse("Grep", { pattern: "foo" }, PROJECT_DIR, "claude-code", SESSION_A);
      expect(r1?.action).toBe("context");
      expect(fs.existsSync(path.resolve(sessionDir(SESSION_A), "grep"))).toBe(true);

      resetGuidanceThrottle(SESSION_A);

      const r2 = routePreToolUse("Grep", { pattern: "bar" }, PROJECT_DIR, "claude-code", SESSION_A);
      expect(r2?.action).toBe("context");
    });

    it("no sessionId passed → falls back to ppid-based behavior (backward compat)", () => {
      // Legacy callers that haven't been updated yet must continue to work.
      const r1 = routePreToolUse("Read", { file_path: "/tmp/a.ts" }, PROJECT_DIR);
      expect(r1?.action).toBe("context");

      const r2 = routePreToolUse("Read", { file_path: "/tmp/b.ts" }, PROJECT_DIR);
      expect(r2).toBeNull();
    });
  });
});
