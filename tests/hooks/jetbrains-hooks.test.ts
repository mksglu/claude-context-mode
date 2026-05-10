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


const _hashCanonical = (p: string) => createHash("sha256").update(
  (process.platform === "darwin" || process.platform === "win32") ? p.toLowerCase() : p
).digest("hex").slice(0, 16);

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

// ── Hook scripts exist ────────────────────────────────────

describe("JetBrains Copilot hook scripts", () => {
  test("pretooluse.mjs exists in hooks/jetbrains-copilot/", () => {
    expect(existsSync(join(HOOKS_DIR, "pretooluse.mjs"))).toBe(true);
  });

  test("posttooluse.mjs exists in hooks/jetbrains-copilot/", () => {
    expect(existsSync(join(HOOKS_DIR, "posttooluse.mjs"))).toBe(true);
  });

  test("precompact.mjs exists in hooks/jetbrains-copilot/", () => {
    expect(existsSync(join(HOOKS_DIR, "precompact.mjs"))).toBe(true);
  });

  test("sessionstart.mjs exists in hooks/jetbrains-copilot/", () => {
    expect(existsSync(join(HOOKS_DIR, "sessionstart.mjs"))).toBe(true);
  });
});

// ── Hooks use parseStdin (not JSON.parse) ─────────────────

describe("JetBrains Copilot hooks use parseStdin", () => {
  test("pretooluse.mjs imports parseStdin from session-helpers", () => {
    const src = readFileSync(join(HOOKS_DIR, "pretooluse.mjs"), "utf-8");
    expect(src).toContain("parseStdin");
    expect(src).not.toMatch(/JSON\.parse\s*\(\s*raw/);
  });

  test("posttooluse.mjs imports parseStdin from session-helpers", () => {
    const src = readFileSync(join(HOOKS_DIR, "posttooluse.mjs"), "utf-8");
    expect(src).toContain("parseStdin");
    expect(src).not.toMatch(/JSON\.parse\s*\(\s*raw/);
  });

  test("precompact.mjs imports parseStdin from session-helpers", () => {
    const src = readFileSync(join(HOOKS_DIR, "precompact.mjs"), "utf-8");
    expect(src).toContain("parseStdin");
    expect(src).not.toMatch(/JSON\.parse\s*\(\s*raw/);
  });

  test("sessionstart.mjs imports parseStdin from session-helpers", () => {
    const src = readFileSync(join(HOOKS_DIR, "sessionstart.mjs"), "utf-8");
    expect(src).toContain("parseStdin");
    expect(src).not.toMatch(/JSON\.parse\s*\(\s*raw/);
  });
});

// ── session-loaders.mjs bundle resolution ────────────────

describe("createSessionLoaders — bundle directory resolution (jetbrains-copilot)", () => {
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

// ── Hook integration tests ────────────────────────────────

describe("JetBrains Copilot hooks", () => {
  let tempDir: string;
  let dbPath: string;
  let eventsPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "jetbrains-hook-test-"));
    const hash = _hashCanonical(tempDir);
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
  const _sentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
  const mcpSentinel = resolve(_sentinelDir, `context-mode-mcp-ready-${process.pid}`);

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

  const jetbrainsEnv = () => ({ IDEA_INITIAL_DIRECTORY: tempDir });

  // ── PreToolUse ───────────────────────────────────────────

  describe("pretooluse.mjs", () => {
    test("run_in_terminal: injects guidance additionalContext", () => {
      const result = runHook("pretooluse.mjs", {
        tool_name: "run_in_terminal",
        tool_input: { command: "npm test" },
      }, jetbrainsEnv());

      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.hookSpecificOutput.additionalContext).toContain("ctx_batch_execute");
    });

    test("handles empty input gracefully (no crash)", () => {
      const result = runHook("pretooluse.mjs", {}, jetbrainsEnv());
      expect(result.exitCode).toBe(0);
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

    test("produces valid JSON with hookSpecificOutput", () => {
      const hookSrc = readFileSync(resolve(ROOT, "hooks/jetbrains-copilot/sessionstart.mjs"), "utf-8");
      expect(hookSrc).toContain("JSON.stringify");
      expect(hookSrc).toContain("hookSpecificOutput");
      expect(hookSrc).toContain("hookEventName");
      expect(hookSrc).toContain('"SessionStart"');
    });

    test("handles empty stdin without crashing", () => {
      const result = runHook("sessionstart.mjs", {}, jetbrainsEnv());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
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

// ── #435 round-3 — MCP cwd != hook projectDir worktree-suffix ─────────────
describe("JetBrains Copilot hooks — MCP cwd != hook projectDir worktree-suffix (#435)", () => {
  let mcpDir: string;
  let worktreeDir: string;
  let mcpDbPath: string;
  let worktreeDbPath: string;

  beforeAll(async () => {
    mcpDir = mkdtempSync(join(tmpdir(), "jb-mcp-A-"));
    worktreeDir = mkdtempSync(join(tmpdir(), "jb-wt-B-"));
    // Hooks hash the path AFTER normalizeWorktreePath() (\ → /), so the test
    // must apply the same normalization before SHA — otherwise on Windows the
    // expected hash uses backslashes while the hook uses slashes and the
    // existsSync assertion is vacuously false.
    const mcpHash = _hashCanonical(mcpDir.replace(/\\/g, "/"));
    const wtHash = _hashCanonical(worktreeDir.replace(/\\/g, "/"));
    const configDir = join(homedir(), ".config", "JetBrains", "context-mode");
    const sessionsDir = join(configDir, "sessions");
    // Ensure DEBUG_LOG parent dir exists — posttooluse.mjs appends to
    // ~/.config/JetBrains/context-mode/posttooluse-debug.log on entry, before
    // getSessionDBPath() (which mkdir's its sessions/ subdir) runs. Without
    // this, the appendFileSync throws and the hook bails before any DB write.
    const { mkdirSync: mk } = await import("node:fs");
    mk(configDir, { recursive: true });
    mcpDbPath = join(sessionsDir, `${mcpHash}.db`);
    worktreeDbPath = join(sessionsDir, `${wtHash}.db`);
  });

  afterAll(() => {
    try { rmSync(mcpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { if (existsSync(mcpDbPath)) unlinkSync(mcpDbPath); } catch { /* best effort */ }
    try { if (existsSync(worktreeDbPath)) unlinkSync(worktreeDbPath); } catch { /* best effort */ }
  });

  const _sentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
  const mcpSentinel = resolve(_sentinelDir, `context-mode-mcp-ready-${process.pid}`);
  beforeEach(() => { writeFileSync(mcpSentinel, String(process.pid)); });
  afterEach(() => { try { unlinkSync(mcpSentinel); } catch {} });

  test("posttooluse writes DB under hook projectDir hash, not env IDEA_INITIAL_DIRECTORY hash", () => {
    const result = runHook("posttooluse.mjs", {
      tool_name: "Read",
      tool_input: { file_path: `${worktreeDir}/src/main.ts` },
      tool_response: "file contents",
      sessionId: "jb-435-r3",
      cwd: worktreeDir,
    }, { IDEA_INITIAL_DIRECTORY: mcpDir });

    expect(result.exitCode).toBe(0);
    expect(existsSync(worktreeDbPath)).toBe(true);
    expect(existsSync(mcpDbPath)).toBe(false);
  });
});
