import "../setup-home";
/**
 * Hook Integration Tests — Gemini CLI hooks
 *
 * Tests aftertool.mjs, precompress.mjs, and sessionstart.mjs by piping
 * simulated JSON stdin and asserting correct output/behavior.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { resolve } from "node:path";


const _hashCanonical = (p: string) => createHash("sha256").update(
  (process.platform === "darwin" || process.platform === "win32") ? p.toLowerCase() : p
).digest("hex").slice(0, 16);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const HOOKS_DIR = join(__dirname, "..", "..", "hooks", "gemini-cli");

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

describe("Gemini CLI hooks", () => {
  let tempDir: string;
  let dbPath: string;
  let eventsPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "gemini-hook-test-"));
    const hash = _hashCanonical(tempDir);
    const sessionsDir = join(homedir(), ".gemini", "context-mode", "sessions");
    dbPath = join(sessionsDir, `${hash}.db`);
    eventsPath = join(sessionsDir, `${hash}-events.md`);
  });

  afterAll(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { if (existsSync(dbPath)) unlinkSync(dbPath); } catch { /* best effort */ }
    try { if (existsSync(eventsPath)) unlinkSync(eventsPath); } catch { /* best effort */ }
  });

  const geminiEnv = () => ({ GEMINI_PROJECT_DIR: tempDir });

  // ── AfterTool ────────────────────────────────────────────

  describe("aftertool.mjs", () => {
    test("captures Read event silently", () => {
      const result = runHook("aftertool.mjs", {
        tool_name: "Read",
        tool_input: { file_path: "/src/main.ts" },
        tool_output: "file contents",
        session_id: "test-gemini-session",
      }, geminiEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("captures Write event silently", () => {
      const result = runHook("aftertool.mjs", {
        tool_name: "Write",
        tool_input: { file_path: "/src/new.ts", content: "code" },
        session_id: "test-gemini-session",
      }, geminiEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("captures Bash git event silently", () => {
      const result = runHook("aftertool.mjs", {
        tool_name: "Bash",
        tool_input: { command: "git status" },
        tool_output: "On branch main",
        session_id: "test-gemini-session",
      }, geminiEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("handles empty input gracefully", () => {
      const result = runHook("aftertool.mjs", {}, geminiEnv());
      expect(result.exitCode).toBe(0);
    });
  });

  // ── PreCompress ──────────────────────────────────────────

  describe("precompress.mjs", () => {
    test("runs silently with no events", () => {
      const result = runHook("precompress.mjs", {
        session_id: "test-gemini-precompress",
      }, geminiEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("handles empty input gracefully", () => {
      const result = runHook("precompress.mjs", {}, geminiEnv());
      expect(result.exitCode).toBe(0);
    });
  });

  // ── SessionStart ─────────────────────────────────────────

  describe("sessionstart.mjs", () => {
    test("startup: outputs routing block", () => {
      const result = runHook("sessionstart.mjs", {
        source: "startup",
        session_id: "test-gemini-startup",
      }, geminiEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
      expect(result.stdout).toContain("context-mode");

      // GEMINI.md writing depends on GeminiCLIAdapter.writeRoutingInstructions()
      // which is a best-effort operation (silently caught if adapter not built).
      // Only assert if the file was actually created.
      const geminiMdPath = join(tempDir, "GEMINI.md");
      if (existsSync(geminiMdPath)) {
        expect(readFileSync(geminiMdPath, "utf-8")).toContain("context-mode");
      }
    });

    test("compact: outputs routing block", () => {
      const result = runHook("sessionstart.mjs", {
        source: "compact",
        session_id: "test-gemini-compact",
      }, geminiEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
    });

    test("clear: outputs routing block only", () => {
      const result = runHook("sessionstart.mjs", {
        source: "clear",
        session_id: "test-gemini-clear",
      }, geminiEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
    });

    test("default source is startup", () => {
      const result = runHook("sessionstart.mjs", {
        session_id: "test-gemini-default",
      }, geminiEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SessionStart");
    });

    // Regression for #299 — the earlier plain-text output was rendered
    // verbatim in Gemini CLI, spilling the full routing block (~10 KB) as
    // user-visible startup noise. Structured JSON is treated as hook metadata.
    test("sessionstart outputs structured JSON (hidden from user in Gemini CLI)", () => {
      const result = runHook("sessionstart.mjs", {
        source: "startup",
        session_id: "test-gemini-json-shape",
      }, geminiEnv());

      expect(result.exitCode).toBe(0);

      // stdout must parse as JSON — no leading plaintext banner
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput).toBeDefined();
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("context-mode");

      // The old plaintext markers must not leak through — they are exactly
      // what rendered as visible noise in Gemini CLI before the fix.
      expect(result.stdout).not.toContain("SessionStart:compact hook success");
      expect(result.stdout).not.toContain("SessionStart hook additional context:");
    });

    test("sessionstart source uses JSON.stringify, not plaintext output (#299)", () => {
      // Mirrors the vscode-copilot sessionstart source check — enforces the
      // plaintext path cannot be reintroduced without breaking this test.
      const hookSrc = readFileSync(resolve(ROOT, "hooks/gemini-cli/sessionstart.mjs"), "utf-8");
      expect(hookSrc).toContain("JSON.stringify");
      expect(hookSrc).toContain("hookSpecificOutput");
      expect(hookSrc).toContain("hookEventName");
      expect(hookSrc).toContain('"SessionStart"');
      expect(hookSrc).not.toContain("SessionStart:compact hook success");
    });
  });

  // ── End-to-end: AfterTool → PreCompress → SessionStart ──

  describe("end-to-end flow", () => {
    test("capture events, build snapshot, and restore on compact", () => {
      const sessionId = "test-gemini-e2e";
      const env = geminiEnv();

      // 1. Capture events via AfterTool
      runHook("aftertool.mjs", {
        tool_name: "Read",
        tool_input: { file_path: "/src/app.ts" },
        tool_output: "export default {}",
        session_id: sessionId,
      }, env);

      runHook("aftertool.mjs", {
        tool_name: "Edit",
        tool_input: { file_path: "/src/app.ts", old_string: "{}", new_string: "{ foo: 1 }" },
        session_id: sessionId,
      }, env);

      // 2. Build snapshot via PreCompress
      const precompressResult = runHook("precompress.mjs", {
        session_id: sessionId,
      }, env);
      expect(precompressResult.exitCode).toBe(0);

      // 3. SessionStart compact should include session knowledge
      const startResult = runHook("sessionstart.mjs", {
        source: "compact",
        session_id: sessionId,
      }, env);
      expect(startResult.exitCode).toBe(0);
      expect(startResult.stdout).toContain("SessionStart");
    });
  });
});

// ── #435 round-3 — MCP cwd != hook projectDir worktree-suffix ─────────────
describe("Gemini CLI hooks — MCP cwd != hook projectDir worktree-suffix (#435)", () => {
  let mcpDir: string;
  let worktreeDir: string;
  let mcpDbPath: string;
  let worktreeDbPath: string;

  beforeAll(async () => {
    mcpDir = mkdtempSync(join(tmpdir(), "gemini-mcp-A-"));
    worktreeDir = mkdtempSync(join(tmpdir(), "gemini-wt-B-"));
    // Hooks hash the path AFTER normalizeWorktreePath() (\ → /), so the test
    // must apply the same normalization before SHA — otherwise on Windows the
    // expected hash uses backslashes while the hook uses slashes and the
    // existsSync assertion is vacuously false.
    const mcpHash = _hashCanonical(mcpDir.replace(/\\/g, "/"));
    const wtHash = _hashCanonical(worktreeDir.replace(/\\/g, "/"));
    const configDir = join(homedir(), ".gemini", "context-mode");
    const sessionsDir = join(configDir, "sessions");
    // Ensure DEBUG_LOG parent dir exists — aftertool.mjs appends to
    // ~/.gemini/context-mode/aftertool-debug.log on entry before
    // getSessionDBPath() (which mkdir's its sessions/ subdir) runs.
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

  test("aftertool writes DB under hook projectDir hash, not env GEMINI_PROJECT_DIR hash", () => {
    const result = runHook("aftertool.mjs", {
      tool_name: "Read",
      tool_input: { file_path: `${worktreeDir}/src/main.ts` },
      tool_response: "file contents",
      session_id: "gemini-435-r3",
      cwd: worktreeDir,
    }, { GEMINI_PROJECT_DIR: mcpDir });

    expect(result.exitCode).toBe(0);
    expect(existsSync(worktreeDbPath)).toBe(true);
    expect(existsSync(mcpDbPath)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// Dead-code excision: writeRoutingInstructions never re-implemented (#558)
// ─────────────────────────────────────────────────────────
//
// Recon for #558 surfaced a second silent failure on marketplace installs:
// `hooks/gemini-cli/sessionstart.mjs:93` imports `GeminiCLIAdapter` from
// `build/adapters/gemini-cli/index.js` (also missing on marketplace via
// .gitignore — same root cause as the security regression) and calls
// `.writeRoutingInstructions(projectDir, pluginRoot)`. Two distinct bugs
// stacked behind the same try/catch:
//
//   1. The build/ artifact is missing on marketplace installs (file not
//      found at import time → caught silently by the surrounding try/catch).
//   2. The `writeRoutingInstructions` method itself was REMOVED from every
//      adapter in commit 6dae20c "refactor: remove writeRoutingInstructions
//      from all adapters". Even on dev installs where build/ is present,
//      the call site has been calling a deleted method for many releases —
//      another silent fail-open swallowed by the same try/catch.
//
// A bundle-first fix for the import would not address bug #2, so the
// staff-engineer-correct move is to delete the dead block entirely.
// Re-introducing routing-instruction writing is out of scope — it would
// need its own PRD, method spec, and GEMINI.md format tests.

describe("Gemini CLI sessionstart — dead writeRoutingInstructions block excised (#558)", () => {
  test("hooks/gemini-cli/sessionstart.mjs no longer references the removed writeRoutingInstructions method", () => {
    const src = readFileSync(resolve(ROOT, "hooks/gemini-cli/sessionstart.mjs"), "utf-8");
    // The method does not exist on GeminiCLIAdapter (verified against
    // src/adapters/gemini-cli/index.ts) — calling it has been a silent
    // no-op since 6dae20c. Delete the call site.
    expect(src).not.toContain("writeRoutingInstructions");
  });

  test("hooks/gemini-cli/sessionstart.mjs no longer imports GeminiCLIAdapter from build/", () => {
    const src = readFileSync(resolve(ROOT, "hooks/gemini-cli/sessionstart.mjs"), "utf-8");
    // The whole purpose of importing GeminiCLIAdapter at runtime was the
    // dead writeRoutingInstructions call. With that gone, the import is
    // also gone — no more marketplace-fragile build/adapters/... probe.
    expect(src).not.toContain("GeminiCLIAdapter");
    expect(src).not.toMatch(/build[\/]adapters[\/]gemini-cli/);
  });

  test("source-of-truth check: GeminiCLIAdapter has no writeRoutingInstructions method", async () => {
    // Anti-regression — if someone re-adds the method to the adapter,
    // the dead-block deletion still stands until the call site is
    // intentionally re-introduced with its own tests.
    const { GeminiCLIAdapter } = await import("../../src/adapters/gemini-cli/index.js");
    const inst: any = new GeminiCLIAdapter();
    expect(inst.writeRoutingInstructions).toBeUndefined();
  });
});
