import "../setup-home";
/**
 * Hook Integration Tests — Kiro hooks
 *
 * Kiro uses exit-code-based responses (not JSON stdout):
 *   - Exit 0: allow (stdout → agent context injection)
 *   - Exit 2: block (stderr → agent error message)
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, existsSync, unlinkSync, writeFileSync, realpathSync } from "node:fs";
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

function normalizeProjectPathForSessionHash(projectDir: string): string {
  const normalized = projectDir.replace(/\\/g, "/");
  if (/^\/+$/.test(normalized)) return "/";
  if (/^[A-Za-z]:\/+$/.test(normalized)) return `${normalized.slice(0, 2)}/`;
  return normalized.replace(/\/+$/, "");
}

describe("Kiro hooks", () => {
  let tempDir: string;
  let dbPath: string;

  beforeAll(() => {
    // macOS symlinks /var -> /private/var: subprocess process.cwd() returns the
    // realpath, so hash the realpath here too or DB lookup hashes will diverge.
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "kiro-hook-test-")));
    const hash = createHash("sha256").update(normalizeProjectPathForSessionHash(tempDir)).digest("hex").slice(0, 16);
    const sessionsDir = join(homedir(), ".kiro", "context-mode", "sessions");
    dbPath = join(sessionsDir, `${hash}.db`);
  });

  afterAll(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { if (existsSync(dbPath)) unlinkSync(dbPath); } catch { /* best effort */ }
  });

  // MCP readiness sentinel — subprocess hooks check process.ppid (= this test's pid)
  const _sentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
  const mcpSentinel = resolve(_sentinelDir, `context-mode-mcp-ready-${process.pid}`);
  beforeEach(() => { writeFileSync(mcpSentinel, String(process.pid)); });
  afterEach(() => { try { unlinkSync(mcpSentinel); } catch {} });

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

  // ── Slice Kiro-1 (Z7): userpromptsubmit ────────────────
  describe("userpromptsubmit.mjs", () => {
    test("exits 0 and emits userPromptSubmit hookSpecificOutput", () => {
      const result = runHook("userpromptsubmit.mjs", {
        hook_event_name: "userPromptSubmit",
        cwd: tempDir,
        prompt: "How do I configure context-mode?",
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("userPromptSubmit");
    });

    test("persists user prompt to SessionDB", async () => {
      const prompt = "kiro-test-prompt-marker-" + Date.now();
      const result = runHook("userpromptsubmit.mjs", {
        hook_event_name: "userPromptSubmit",
        cwd: tempDir,
        prompt,
      }, tempDir);
      expect(result.exitCode).toBe(0);

      // Verify prompt landed in SessionDB. Hook uses the parsed cwd to derive
      // the DB path via the shared normalized project-dir hash.
      expect(existsSync(dbPath)).toBe(true);
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db.prepare(
          `SELECT data FROM session_events WHERE category = 'user-prompt'`,
        ).all() as Array<{ data: string }>;
        const matched = rows.some(r => r.data.includes(prompt));
        expect(matched, `expected prompt persisted; rows=${JSON.stringify(rows)}`).toBe(true);
      } finally {
        db.close();
      }
    });

    test("skips system messages without crashing", () => {
      const result = runHook("userpromptsubmit.mjs", {
        hook_event_name: "userPromptSubmit",
        cwd: tempDir,
        prompt: "<system-reminder>not a user prompt</system-reminder>",
      });
      expect(result.exitCode).toBe(0);
    });

    test("handles malformed input without crashing", () => {
      const result = runHook("userpromptsubmit.mjs", {
        hook_event_name: "userPromptSubmit",
      });
      expect(result.exitCode).toBe(0);
    });
  });

  // ── Slice Kiro-2 (Z8): agentspawn ──────────────────────
  describe("agentspawn.mjs", () => {
    test("exits 0 and injects routing block via additionalContext", () => {
      const result = runHook("agentspawn.mjs", {
        hook_event_name: "agentSpawn",
        cwd: tempDir,
        source: "startup",
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("agentSpawn");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("context_window_protection");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("@context-mode/ctx_");
    });

    test("startup source clears stale events file", () => {
      const result = runHook("agentspawn.mjs", {
        hook_event_name: "agentSpawn",
        cwd: tempDir,
        source: "startup",
      });
      expect(result.exitCode).toBe(0);
    });

    test("clear source emits routing block only (no DB work)", () => {
      const result = runHook("agentspawn.mjs", {
        hook_event_name: "agentSpawn",
        cwd: tempDir,
        source: "clear",
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toContain("context_window_protection");
    });

    test("handles malformed input without crashing", () => {
      const result = runHook("agentspawn.mjs", {});
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
