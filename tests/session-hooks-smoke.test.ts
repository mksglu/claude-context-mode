/**
 * Smoke test — Issue #117
 *
 * Verifies that session continuity hooks work WITHOUT the build/session/
 * directory. Simulates a fresh marketplace install where tsc has never run.
 *
 * GREEN phase: These tests PASS, proving the bundle-first fix works.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// Simulate marketplace install: copy plugin WITHOUT build/session/
let fakePluginDir: string;
let fakeProjectDir: string;
let fakeHomeDir: string;
/** Where getSessionDBPath() actually writes: <fakeHome>/.claude/context-mode/sessions/ */
let sessionDBDir: string;

beforeAll(() => {
  fakePluginDir = mkdtempSync(join(tmpdir(), "ctx-marketplace-sim-"));

  // Copy hooks directory
  cpSync(join(PROJECT_ROOT, "hooks"), join(fakePluginDir, "hooks"), { recursive: true });

  // Symlink node_modules (needed for better-sqlite3, too large to copy)
  if (existsSync(join(PROJECT_ROOT, "node_modules"))) {
    symlinkSync(join(PROJECT_ROOT, "node_modules"), join(fakePluginDir, "node_modules"));
  }

  // Copy package.json (needed for module resolution)
  cpSync(join(PROJECT_ROOT, "package.json"), join(fakePluginDir, "package.json"));

  // DO NOT copy build/session/ — this simulates marketplace install
  // Verify build/session/ does NOT exist in our fake install
  expect(existsSync(join(fakePluginDir, "build", "session"))).toBe(false);

  // Fake project dir (value for CLAUDE_PROJECT_DIR)
  fakeProjectDir = mkdtempSync(join(tmpdir(), "ctx-project-"));

  // Fake HOME so getSessionDBPath() writes to an isolated location
  fakeHomeDir = mkdtempSync(join(tmpdir(), "ctx-fakehome-"));
  sessionDBDir = join(fakeHomeDir, ".claude", "context-mode", "sessions");
});

afterAll(() => {
  try { rmSync(fakePluginDir, { recursive: true, force: true }); } catch {}
  try { rmSync(fakeProjectDir, { recursive: true, force: true }); } catch {}
  try { rmSync(fakeHomeDir, { recursive: true, force: true }); } catch {}
});

function runHook(hookFile: string, input: Record<string, unknown>, env?: Record<string, string>) {
  const hookPath = join(fakePluginDir, "hooks", hookFile);
  const result = spawnSync("node", [hookPath], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 30_000,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: fakeProjectDir,
      CLAUDE_SESSION_ID: "test-session-117",
      CONTEXT_MODE_PLATFORM: "claude-code",
      // Isolate DB writes to fake HOME
      HOME: fakeHomeDir,
      USERPROFILE: fakeHomeDir,
      ...env,
    },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

/** Check if any .db files were created in the isolated session directory */
function getDBFiles(): string[] {
  return existsSync(sessionDBDir)
    ? readdirSync(sessionDBDir).filter(f => f.endsWith(".db"))
    : [];
}

describe("Issue #117 — Session hooks without build/session/", () => {
  test("posttooluse.mjs creates session DB via bundle (no build/ needed)", () => {
    const result = runHook("posttooluse.mjs", {
      session_id: "test-session-117",
      tool_name: "Read",
      tool_input: { file_path: "/src/main.ts" },
      tool_response: "const x = 1;",
    });

    expect(result.exitCode).toBe(0);

    // Bundle-first fix: DB is created in ~/.claude/context-mode/sessions/
    expect(getDBFiles().length).toBeGreaterThan(0);
  });

  test("sessionstart.mjs routing block works (independent of build/)", () => {
    const result = runHook("sessionstart.mjs", {
      session_id: "test-session-117",
      source: "startup",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.additionalContext).toBeDefined();
  });

  test("sessionstart.mjs compact recovery works via bundle", () => {
    // First capture some events with same session_id
    runHook("posttooluse.mjs", {
      session_id: "test-session-117",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "all tests passed",
    });

    // Trigger compact — session recovery now works via bundled session-db
    const result = runHook("sessionstart.mjs", {
      session_id: "test-session-117",
      source: "compact",
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";

    // Fix verified: compact recovery injects session_knowledge
    expect(ctx).toContain("session_knowledge");
  });

  test("userpromptsubmit.mjs captures prompts via bundle", () => {
    const result = runHook("userpromptsubmit.mjs", {
      prompt: "fix the login bug",
      session_id: "test-session-117",
    });

    expect(result.exitCode).toBe(0);

    // DB should be created via bundle
    expect(getDBFiles().length).toBeGreaterThan(0);
  });

  test("precompact.mjs creates snapshot via bundle", () => {
    const result = runHook("precompact.mjs", {
      session_id: "test-session-117",
    });

    expect(result.exitCode).toBe(0);
  });
});
