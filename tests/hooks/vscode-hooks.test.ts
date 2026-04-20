import "../setup-home";
/**
 * Hook Integration Tests — VS Code Copilot hooks
 *
 * Tests posttooluse.mjs, precompact.mjs, and sessionstart.mjs by piping
 * simulated JSON stdin and asserting correct output/behavior.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, existsSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const HOOKS_DIR = join(__dirname, "..", "..", "hooks", "vscode-copilot");

interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runHook(hookFile: string, input: Record<string, unknown>, env?: Record<string, string>): HookResult {
  const result = spawnSync("node", [join(HOOKS_DIR, hookFile)], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

// ── session-loaders.mjs bundle resolution ────────────────

describe("createSessionLoaders — bundle directory resolution", () => {
  const hooksDir = join(__dirname, "..", "..", "hooks");

  test("resolves bundles when hookDir has trailing slash (vscode-copilot/)", async () => {
    // This is how sessionstart.mjs derives HOOK_DIR:
    //   fileURLToPath(new URL(".", import.meta.url)) → always has trailing /
    const hookDirWithSlash = join(hooksDir, "vscode-copilot") + "/";

    const { createSessionLoaders } = await import(
      join(hooksDir, "session-loaders.mjs")
    );
    const loaders = createSessionLoaders(hookDirWithSlash);

    // Must not throw ERR_MODULE_NOT_FOUND — bundles live in hooks/, not hooks/vscode-copilot/
    const mod = await loaders.loadSessionDB();
    expect(mod.SessionDB).toBeDefined();
  });

  test.skipIf(process.platform !== "win32")("resolves bundles when hookDir has trailing backslash (Windows)", async () => {
    const hookDirWithBackslash = join(hooksDir, "vscode-copilot") + "\\";

    const { createSessionLoaders } = await import(
      join(hooksDir, "session-loaders.mjs")
    );
    const loaders = createSessionLoaders(hookDirWithBackslash);

    const mod = await loaders.loadSessionDB();
    expect(mod.SessionDB).toBeDefined();
  });

  test("resolves bundles when hookDir has no trailing separator", async () => {
    const hookDirClean = join(hooksDir, "vscode-copilot");

    const { createSessionLoaders } = await import(
      join(hooksDir, "session-loaders.mjs")
    );
    const loaders = createSessionLoaders(hookDirClean);

    const mod = await loaders.loadSessionDB();
    expect(mod.SessionDB).toBeDefined();
  });

  test("resolves bundles from root hooks dir (non-vscode path)", async () => {
    const { createSessionLoaders } = await import(
      join(hooksDir, "session-loaders.mjs")
    );
    const loaders = createSessionLoaders(hooksDir);

    const mod = await loaders.loadSessionDB();
    expect(mod.SessionDB).toBeDefined();
  });
});

describe("VS Code Copilot hooks", () => {
  let tempDir: string;
  let dbPath: string;
  let eventsPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vscode-hook-test-"));
    const hash = createHash("sha256").update(tempDir).digest("hex").slice(0, 16);
    const sessionsDir = join(homedir(), ".vscode", "context-mode", "sessions");
    dbPath = join(sessionsDir, `${hash}.db`);
    eventsPath = join(sessionsDir, `${hash}-events.md`);
  });

  afterAll(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { if (existsSync(dbPath)) unlinkSync(dbPath); } catch { /* best effort */ }
    try { if (existsSync(eventsPath)) unlinkSync(eventsPath); } catch { /* best effort */ }
  });

  // MCP readiness sentinel — subprocess hooks check process.ppid (= this test's pid)
  const mcpSentinel = resolve(tmpdir(), `context-mode-mcp-ready-${process.pid}`);

  // Clean file-based guidance throttle markers between tests.
  // Subprocess hooks use process.ppid (= this test's pid) for the legacy marker dir;
  // the sessionId-scoped dir (#298) is derived from getSessionId() which falls back
  // to `pid-${process.ppid}` when the hook input has no session_id.
  // VITEST_WORKER_ID is inherited by subprocesses, matching routing.mjs logic.
  beforeEach(() => {
    const wid = process.env.VITEST_WORKER_ID;
    const suffix = wid ? `${process.pid}-w${wid}` : String(process.pid);
    const legacyDir = resolve(tmpdir(), `context-mode-guidance-${suffix}`);
    const sessionDir = resolve(tmpdir(), `context-mode-guidance-s-pid-${process.pid}`);
    try { rmSync(legacyDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* best effort */ }
    writeFileSync(mcpSentinel, String(process.pid));
  });

  afterEach(() => {
    try { unlinkSync(mcpSentinel); } catch {}
  });

  const vscodeEnv = () => ({ VSCODE_CWD: tempDir });

  // ── PreToolUse ───────────────────────────────────────────

  describe("pretooluse.mjs", () => {
    test("run_in_terminal: injects BASH_GUIDANCE additionalContext", () => {
      const result = runHook("pretooluse.mjs", {
        tool_name: "run_in_terminal",
        tool_input: { command: "npm test" },
      }, vscodeEnv());

      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.hookSpecificOutput.additionalContext).toContain("ctx_batch_execute");
    });

    test("run_in_terminal: curl is redirected to echo", () => {
      const result = runHook("pretooluse.mjs", {
        tool_name: "run_in_terminal",
        tool_input: { command: "curl https://example.com" },
      }, vscodeEnv());

      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.hookSpecificOutput.updatedInput.command).toContain("context-mode");
      expect(out.hookSpecificOutput.updatedInput.command).toContain("ctx_fetch_and_index");
    });

    test("run_in_terminal: safe short command passes through with guidance", () => {
      const result = runHook("pretooluse.mjs", {
        tool_name: "run_in_terminal",
        tool_input: { command: "git status" },
      }, vscodeEnv());

      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.hookSpecificOutput.additionalContext).toContain("ctx_batch_execute");
    });
  });

  // ── PostToolUse ──────────────────────────────────────────

  describe("posttooluse.mjs", () => {
    test("captures Read event silently", () => {
      const result = runHook("posttooluse.mjs", {
        tool_name: "Read",
        tool_input: { file_path: "/src/main.ts" },
        tool_response: "file contents",
        sessionId: "test-vscode-session",
      }, vscodeEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("captures Write event silently", () => {
      const result = runHook("posttooluse.mjs", {
        tool_name: "Write",
        tool_input: { file_path: "/src/new.ts", content: "code" },
        sessionId: "test-vscode-session",
      }, vscodeEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("supports sessionId camelCase field", () => {
      const result = runHook("posttooluse.mjs", {
        tool_name: "Bash",
        tool_input: { command: "git log --oneline -5" },
        tool_response: "abc1234 feat: add feature",
        sessionId: "test-vscode-camelcase",
      }, vscodeEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("handles empty input gracefully", () => {
      const result = runHook("posttooluse.mjs", {}, vscodeEnv());
      expect(result.exitCode).toBe(0);
    });
  });

  // ── PreCompact ───────────────────────────────────────────

  describe("precompact.mjs", () => {
    test("runs silently with no events", () => {
      const result = runHook("precompact.mjs", {
        sessionId: "test-vscode-precompact",
      }, vscodeEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("handles empty input gracefully", () => {
      const result = runHook("precompact.mjs", {}, vscodeEnv());
      expect(result.exitCode).toBe(0);
    });
  });

  // ── SessionStart ─────────────────────────────────────────

  describe("sessionstart.mjs", () => {
    test("startup: outputs routing block", () => {
      const result = runHook("sessionstart.mjs", {
        source: "startup",
        sessionId: "test-vscode-startup",
      }, vscodeEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
      expect(result.stdout).toContain("context-mode");
    });

    test("compact: outputs routing block", () => {
      const result = runHook("sessionstart.mjs", {
        source: "compact",
        sessionId: "test-vscode-compact",
      }, vscodeEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
    });

    test("clear: outputs routing block only", () => {
      const result = runHook("sessionstart.mjs", {
        source: "clear",
        sessionId: "test-vscode-clear",
      }, vscodeEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
    });

    test("supports sessionId camelCase in session start", () => {
      const result = runHook("sessionstart.mjs", {
        source: "startup",
        sessionId: "test-vscode-camelcase-start",
      }, vscodeEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
    });

    test("sessionstart outputs valid JSON with hookSpecificOutput", () => {
      // Read the hook source and verify it outputs JSON format
      const hookSrc = readFileSync(resolve(ROOT, "hooks/vscode-copilot/sessionstart.mjs"), "utf-8");
      expect(hookSrc).toContain("JSON.stringify");
      expect(hookSrc).toContain("hookSpecificOutput");
      expect(hookSrc).toContain("hookEventName");
      expect(hookSrc).toContain('"SessionStart"');
      // Must NOT have plain text output
      expect(hookSrc).not.toContain("SessionStart:compact hook success");
    });
  });

  // ── End-to-end: PostToolUse → PreCompact → SessionStart ─

  describe("end-to-end flow", () => {
    test("capture events, build snapshot, and restore on compact", () => {
      const sessionId = "test-vscode-e2e";
      const env = vscodeEnv();

      // 1. Capture events via PostToolUse
      runHook("posttooluse.mjs", {
        tool_name: "Read",
        tool_input: { file_path: "/src/app.ts" },
        tool_response: "export default {}",
        sessionId,
      }, env);

      runHook("posttooluse.mjs", {
        tool_name: "Edit",
        tool_input: { file_path: "/src/app.ts", old_string: "{}", new_string: "{ foo: 1 }" },
        sessionId,
      }, env);

      // 2. Build snapshot via PreCompact
      const precompactResult = runHook("precompact.mjs", {
        sessionId,
      }, env);
      expect(precompactResult.exitCode).toBe(0);

      // 3. SessionStart compact should include session knowledge
      const startResult = runHook("sessionstart.mjs", {
        source: "compact",
        sessionId,
      }, env);
      expect(startResult.exitCode).toBe(0);
      expect(startResult.stdout).toContain("SessionStart");
    });
  });
});
