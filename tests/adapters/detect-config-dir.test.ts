/**
 * Behavioral tests for the medium-confidence config-directory branch of
 * detectPlatform() and the env-var priority chain.
 *
 * The adjacent detect.test.ts covers env vars, clientInfo, and the
 * CONTEXT_MODE_PLATFORM override — but the ~80 lines of `~/.<platform>`
 * and `~/.config/<platform>` existsSync checks (detect.ts:128-210) are
 * not exercised. These tests mock `node:fs` to force each branch
 * deterministically and lock the priority ordering.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve } from "node:path";
import { homedir } from "node:os";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn() };
});

// Imports after vi.mock so the mock is in place before detect.ts resolves fs.
import * as fs from "node:fs";
import { detectPlatform, PLATFORM_ENV_VARS } from "../../src/adapters/detect.js";

const existsSyncMock = vi.mocked(fs.existsSync);

// Derived from detect.ts's source-of-truth list so renames can't drift.
const ALL_PLATFORM_ENV_VARS = [
  ...PLATFORM_ENV_VARS.flatMap(([, vars]) => [...vars]),
  "CONTEXT_MODE_PLATFORM",
];

describe("detectPlatform — config directory branches", () => {
  const home = homedir();
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const v of ALL_PLATFORM_ENV_VARS) delete process.env[v];
    existsSyncMock.mockReset();
  });

  afterEach(() => {
    process.env = savedEnv;
    existsSyncMock.mockReset();
  });

  const forceDir = (target: string) => {
    existsSyncMock.mockImplementation(((p: unknown) => p === target) as typeof fs.existsSync);
  };

  it.each<[string, string]>([
    [".claude", "claude-code"],
    [".gemini", "gemini-cli"],
    [".codex", "codex"],
    [".cursor", "cursor"],
    [".kiro", "kiro"],
    [".pi", "pi"],
    [".openclaw", "openclaw"],
  ])("detects %s → %s at medium confidence", (dir, expected) => {
    forceDir(resolve(home, dir));
    const signal = detectPlatform();
    expect(signal.platform).toBe(expected);
    expect(signal.confidence).toBe("medium");
    expect(signal.reason).toContain(dir);
  });

  it.each<[string[], string]>([
    [[".config", "kilo"], "kilo"],
    [[".config", "opencode"], "opencode"],
    [[".config", "zed"], "zed"],
    [[".config", "JetBrains"], "jetbrains-copilot"],
  ])("detects XDG ~/%s/%s → %s at medium confidence", (segs, expected) => {
    forceDir(resolve(home, ...segs));
    const signal = detectPlatform();
    expect(signal.platform).toBe(expected);
    expect(signal.confidence).toBe("medium");
    expect(signal.reason).toContain(segs.join("/"));
  });

  it("falls back to claude-code low-confidence when no dirs exist", () => {
    existsSyncMock.mockReturnValue(false);
    const signal = detectPlatform();
    expect(signal.platform).toBe("claude-code");
    expect(signal.confidence).toBe("low");
    expect(signal.reason).toContain("No platform detected");
  });

  it("prefers ~/.claude over ~/.gemini when both dirs exist", () => {
    existsSyncMock.mockImplementation((
      ((p: unknown) =>
        p === resolve(home, ".claude") || p === resolve(home, ".gemini")) as typeof fs.existsSync
    ));
    expect(detectPlatform().platform).toBe("claude-code");
  });

  it("env var wins over a matching config dir", () => {
    forceDir(resolve(home, ".claude"));
    process.env.CODEX_CI = "1";
    const signal = detectPlatform();
    expect(signal.platform).toBe("codex");
    expect(signal.confidence).toBe("high");
  });

  it("CONTEXT_MODE_PLATFORM override wins over a matching config dir", () => {
    forceDir(resolve(home, ".claude"));
    process.env.CONTEXT_MODE_PLATFORM = "antigravity";
    expect(detectPlatform().platform).toBe("antigravity");
  });
});

describe("detectPlatform — env var priority chain", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const v of ALL_PLATFORM_ENV_VARS) delete process.env[v];
    existsSyncMock.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = savedEnv;
    existsSyncMock.mockReset();
  });

  it("CLAUDE beats GEMINI when both envs are set", () => {
    process.env.CLAUDE_PROJECT_DIR = "/p";
    process.env.GEMINI_CLI = "1";
    expect(detectPlatform().platform).toBe("claude-code");
  });

  it("GEMINI beats OPENCLAW when both envs are set", () => {
    process.env.GEMINI_CLI = "1";
    process.env.OPENCLAW_HOME = "/h";
    expect(detectPlatform().platform).toBe("gemini-cli");
  });

  // KILO + OPENCODE: Kilo is an OpenCode fork and sets BOTH KILO_PID and
  // OPENCODE=1. PLATFORM_ENV_VARS lists `kilo` BEFORE `opencode` so the more
  // specific signal wins.
  it("KILO beats OPENCODE when both envs are set (fork-collision)", () => {
    process.env.KILO_PID = "12345";
    process.env.OPENCODE = "1";
    expect(detectPlatform().platform).toBe("kilo");
  });

  // CURSOR + VSCODE: Cursor is a VSCode fork — listed before vscode-copilot.
  it("CURSOR beats VSCODE when both envs are set (fork-collision)", () => {
    process.env.CURSOR_TRACE_ID = "trace-abc";
    process.env.VSCODE_PID = "99";
    expect(detectPlatform().platform).toBe("cursor");
  });

  // ANTIGRAVITY + VSCODE: Antigravity is an Electron/VSCode fork — same pattern.
  it("ANTIGRAVITY beats VSCODE when both envs are set (fork-collision)", () => {
    process.env.ANTIGRAVITY_CLI_ALIAS = "agtg";
    process.env.VSCODE_PID = "99";
    expect(detectPlatform().platform).toBe("antigravity");
  });

  // CURSOR + CODEX: cursor listed before codex — IDE-fork signal wins over
  // CLI tooling signal.
  it("CURSOR beats CODEX when both envs are set", () => {
    process.env.CURSOR_TRACE_ID = "trace-abc";
    process.env.CODEX_THREAD_ID = "t";
    expect(detectPlatform().platform).toBe("cursor");
  });
});
