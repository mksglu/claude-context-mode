import "../setup-home";
/**
 * Hook Integration Tests — Kiro hooks
 *
 * Kiro uses exit-code-based responses (not JSON stdout):
 *   - Exit 0: allow (stdout → agent context injection)
 *   - Exit 2: block (stderr → agent error message)
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = join(__dirname, "..", "..", "hooks", "kiro");

interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runHook(hookFile: string, input: Record<string, unknown>, cwd?: string): HookResult {
  const result = spawnSync("node", [join(HOOKS_DIR, hookFile)], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env },
    // Set subprocess cwd so process.cwd() inside the hook resolves to an
    // isolated directory. Kiro has no projectDirEnv so getSessionDBPath()
    // falls back to process.cwd() — without this, all parallel test workers
    // would write to the same SQLite file, causing SIGSEGV on macOS ARM64.
    ...(cwd ? { cwd } : {}),
  });

  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

describe("Kiro hooks", () => {
  let tempDir: string;
  let dbPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kiro-hook-test-"));
    const hash = createHash("sha256").update(tempDir).digest("hex").slice(0, 16);
    const sessionsDir = join(homedir(), ".kiro", "context-mode", "sessions");
    dbPath = join(sessionsDir, `${hash}.db`);
  });

  afterAll(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { if (existsSync(dbPath)) unlinkSync(dbPath); } catch { /* best effort */ }
  });

  describe("pretooluse.mjs", () => {
    test("exits 0 for passthrough tools", () => {
      const result = runHook("pretooluse.mjs", {
        hook_event_name: "preToolUse",
        cwd: tempDir,
        tool_name: "fs_write",
        tool_input: { path: `${tempDir}/output.ts`, content: "export {}" },
      });

      expect(result.exitCode).toBe(0);
    });

    test("exits 2 for blocked curl commands", () => {
      const result = runHook("pretooluse.mjs", {
        hook_event_name: "preToolUse",
        cwd: tempDir,
        tool_name: "execute_bash",
        tool_input: { command: "curl https://example.com" },
      });

      // stderr is suppressed at OS fd level by suppress-stderr.mjs
      expect(result.exitCode).toBe(2);
    });

    test("exits 2 for blocked wget commands", () => {
      const result = runHook("pretooluse.mjs", {
        hook_event_name: "preToolUse",
        cwd: tempDir,
        tool_name: "execute_bash",
        tool_input: { command: "wget https://example.com -O out.html" },
      });

      // stderr is suppressed at OS fd level by suppress-stderr.mjs
      expect(result.exitCode).toBe(2);
    });

    test("exits 0 for git commands (allowed short-output shell)", () => {
      const result = runHook("pretooluse.mjs", {
        hook_event_name: "preToolUse",
        cwd: tempDir,
        tool_name: "execute_bash",
        tool_input: { command: "git status" },
      });

      expect(result.exitCode).toBe(0);
    });

    test("handles missing tool_name gracefully", () => {
      const result = runHook("pretooluse.mjs", {
        hook_event_name: "preToolUse",
        cwd: tempDir,
      });

      expect(result.exitCode).toBe(0);
    });
  });

  describe("posttooluse.mjs", () => {
    test("exits 0 and produces no stdout (non-blocking)", () => {
      const result = runHook("posttooluse.mjs", {
        hook_event_name: "postToolUse",
        tool_name: "fs_read",
        tool_input: { path: "/src/app.ts" },
        tool_response: "export default {}",
      }, tempDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("captures git events without error", () => {
      const result = runHook("posttooluse.mjs", {
        hook_event_name: "postToolUse",
        tool_name: "execute_bash",
        tool_input: { command: "git status" },
        tool_response: "On branch main\nnothing to commit",
      }, tempDir);

      expect(result.exitCode).toBe(0);
    });

    test("handles malformed input without crashing", () => {
      const result = runHook("posttooluse.mjs", {
        hook_event_name: "postToolUse",
      }, tempDir);

      expect(result.exitCode).toBe(0);
    });
  });
});
