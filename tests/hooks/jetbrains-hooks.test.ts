import "../setup-home";
/**
 * Hook Integration Tests — JetBrains Copilot hooks
 *
 * Tests pretooluse.mjs, posttooluse.mjs, precompact.mjs, and sessionstart.mjs
 * by piping simulated JSON stdin and asserting correct output/behavior.
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
const HOOKS_DIR = join(__dirname, "..", "..", "hooks", "jetbrains-copilot");

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

describe("createSessionLoaders — JetBrains bundle directory resolution", () => {
  const hooksDir = join(__dirname, "..", "..", "hooks");

  test("resolves bundles when hookDir has trailing slash (jetbrains-copilot/)", async () => {
    const hookDirWithSlash = join(hooksDir, "jetbrains-copilot") + "/";

    const { createSessionLoaders } = await import(
      join(hooksDir, "session-loaders.mjs")
    );
    const loaders = createSessionLoaders(hookDirWithSlash);

    const mod = await loaders.loadSessionDB();
    expect(mod.SessionDB).toBeDefined();
  });

  test("resolves bundles when hookDir has no trailing separator", async () => {
    const hookDirClean = join(hooksDir, "jetbrains-copilot");

    const { createSessionLoaders } = await import(
      join(hooksDir, "session-loaders.mjs")
    );
    const loaders = createSessionLoaders(hookDirClean);

    const mod = await loaders.loadSessionDB();
    expect(mod.SessionDB).toBeDefined();
  });
});

describe("JetBrains Copilot hooks", () => {
  let tempDir: string;
  let dbPath: string;
  let eventsPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "jetbrains-hook-test-"));
    const hash = createHash("sha256").update(tempDir).digest("hex").slice(0, 16);
    const sessionsDir = join(homedir(), ".config", "JetBrains", "context-mode", "sessions");
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

  beforeEach(() => {
    const wid = process.env.VITEST_WORKER_ID;
    const suffix = wid ? `${process.pid}-w${wid}` : String(process.pid);
    const guidanceDir = resolve(tmpdir(), `context-mode-guidance-${suffix}`);
    try { rmSync(guidanceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    writeFileSync(mcpSentinel, String(process.pid));
  });

  afterEach(() => {
    try { unlinkSync(mcpSentinel); } catch {}
  });

  const jetbrainsEnv = () => ({ IDEA_INITIAL_DIRECTORY: tempDir });

  // ── PreToolUse ───────────────────────────────────────────

  describe("pretooluse.mjs", () => {
    test("run_in_terminal: injects context-mode guidance additionalContext", () => {
      const result = runHook("pretooluse.mjs", {
        tool_name: "run_in_terminal",
        tool_input: { command: "npm test" },
      }, jetbrainsEnv());

      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.hookSpecificOutput.additionalContext).toContain("ctx_batch_execute");
    });

    test("run_in_terminal: curl is redirected via context-mode fetch_and_index", () => {
      const result = runHook("pretooluse.mjs", {
        tool_name: "run_in_terminal",
        tool_input: { command: "curl https://example.com" },
      }, jetbrainsEnv());

      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.hookSpecificOutput.updatedInput.command).toContain("context-mode");
      expect(out.hookSpecificOutput.updatedInput.command).toContain("ctx_fetch_and_index");
    });

    test("run_in_terminal: safe short command passes through with guidance", () => {
      const result = runHook("pretooluse.mjs", {
        tool_name: "run_in_terminal",
        tool_input: { command: "git status" },
      }, jetbrainsEnv());

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
        sessionId: "test-jb-session",
      }, jetbrainsEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("captures Write event silently", () => {
      const result = runHook("posttooluse.mjs", {
        tool_name: "Write",
        tool_input: { file_path: "/src/new.ts", content: "code" },
        sessionId: "test-jb-session",
      }, jetbrainsEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("supports sessionId camelCase field", () => {
      const result = runHook("posttooluse.mjs", {
        tool_name: "Bash",
        tool_input: { command: "git log --oneline -5" },
        tool_response: "abc1234 feat: add feature",
        sessionId: "test-jb-camelcase",
      }, jetbrainsEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("handles empty input gracefully", () => {
      const result = runHook("posttooluse.mjs", {}, jetbrainsEnv());
      expect(result.exitCode).toBe(0);
    });
  });

  // ── PreCompact ───────────────────────────────────────────

  describe("precompact.mjs", () => {
    test("runs silently with no events", () => {
      const result = runHook("precompact.mjs", {
        sessionId: "test-jb-precompact",
      }, jetbrainsEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("handles empty input gracefully", () => {
      const result = runHook("precompact.mjs", {}, jetbrainsEnv());
      expect(result.exitCode).toBe(0);
    });
  });

  // ── SessionStart ─────────────────────────────────────────

  describe("sessionstart.mjs", () => {
    test("startup: outputs routing block", () => {
      const result = runHook("sessionstart.mjs", {
        source: "startup",
        sessionId: "test-jb-startup",
      }, jetbrainsEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
      expect(result.stdout).toContain("context-mode");
    });

    test("compact: outputs routing block", () => {
      const result = runHook("sessionstart.mjs", {
        source: "compact",
        sessionId: "test-jb-compact",
      }, jetbrainsEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
    });

    test("resume: outputs routing block", () => {
      const result = runHook("sessionstart.mjs", {
        source: "resume",
        sessionId: "test-jb-resume",
      }, jetbrainsEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
    });

    test("clear: outputs routing block only", () => {
      const result = runHook("sessionstart.mjs", {
        source: "clear",
        sessionId: "test-jb-clear",
      }, jetbrainsEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
    });

    test("supports sessionId camelCase in session start", () => {
      const result = runHook("sessionstart.mjs", {
        source: "startup",
        sessionId: "test-jb-camelcase-start",
      }, jetbrainsEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
    });

    test("sessionstart outputs valid JSON with hookSpecificOutput", () => {
      const hookSrc = readFileSync(resolve(ROOT, "hooks/jetbrains-copilot/sessionstart.mjs"), "utf-8");
      expect(hookSrc).toContain("JSON.stringify");
      expect(hookSrc).toContain("hookSpecificOutput");
      expect(hookSrc).toContain("hookEventName");
      expect(hookSrc).toContain('"SessionStart"');
      // Must NOT have plain text output
      expect(hookSrc).not.toContain("SessionStart:compact hook success");
    });

    test("sessionstart picks up .idea/copilot-instructions.md on startup", () => {
      // Create the rule file in the temp project and run startup
      const ideaDir = join(tempDir, ".idea");
      writeFileSync(join(tempDir, ".idea-mkdir-marker"), "");
      try {
        const { mkdirSync } = require("node:fs") as typeof import("node:fs");
        mkdirSync(ideaDir, { recursive: true });
      } catch {}
      writeFileSync(join(ideaDir, "copilot-instructions.md"), "# Rule\nUse ctx tools.");

      const result = runHook("sessionstart.mjs", {
        source: "startup",
        sessionId: "test-jb-idea-rules",
      }, jetbrainsEnv());

      expect(result.exitCode).toBe(0);
      // The rule should have been captured in the session DB (no direct assertion
      // on stdout content since routing block is separate from rule capture).
    });
  });

  // ── End-to-end: PostToolUse → PreCompact → SessionStart ─

  describe("end-to-end flow", () => {
    test("capture events, build snapshot, and restore on compact", () => {
      const sessionId = "test-jb-e2e";
      const env = jetbrainsEnv();

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
