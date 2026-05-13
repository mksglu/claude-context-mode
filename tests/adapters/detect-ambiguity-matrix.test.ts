/**
 * Issue #542 — all-pairs config-dir ambiguity regression matrix.
 *
 * Locks in the post-fix priority order across realistic co-existence
 * scenarios. Every row is a (~/.<dir>/, ~/.<dir>/) pair the user is
 * likely to have on disk simultaneously — e.g. someone who migrated
 * Cursor → Pi, or has Claude Code running inside a Cursor-launched
 * terminal.
 *
 * Each test mocks node:fs.existsSync to return true ONLY for the two
 * dirs in the row, then asserts the medium-confidence config-dir tier
 * picks the row's "winner". Companion env-var and clientInfo tiers are
 * exercised in detect.test.ts and detect-config-dir.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve } from "node:path";
import { homedir } from "node:os";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn() };
});

import * as fs from "node:fs";
import {
  detectPlatform,
  PLATFORM_ENV_VARS,
  __seedClaudeCodePluginCacheMissForTests,
} from "../../src/adapters/detect.js";

const existsSyncMock = vi.mocked(fs.existsSync);

const ALL_PLATFORM_ENV_VARS = [
  ...[...PLATFORM_ENV_VARS.values()].flatMap((vars) => vars.map((v) => v.name)),
  "CONTEXT_MODE_PLATFORM",
];

describe("detectPlatform — all-pairs ambiguity matrix (issue #542)", () => {
  const home = homedir();
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const v of ALL_PLATFORM_ENV_VARS) delete process.env[v];
    __seedClaudeCodePluginCacheMissForTests();
    existsSyncMock.mockReset();
  });

  afterEach(() => {
    process.env = savedEnv;
    existsSyncMock.mockReset();
  });

  const presentDirs = (...segs: string[][]) => {
    const targets = new Set(segs.map((s) => resolve(home, ...s)));
    existsSyncMock.mockImplementation(((p: unknown) =>
      typeof p === "string" && targets.has(p)) as typeof fs.existsSync);
  };

  // Row format: [scenario name, [dirA-segments], [dirB-segments], expected winner]
  const cases: Array<[string, string[], string[], string]> = [
    // ── CLI agents beat the most-installed host IDE (Cursor) ──
    ["cursor + pi    → pi",      [".cursor"], [".pi"],      "pi"],
    ["cursor + omp   → omp",     [".cursor"], [".omp"],     "omp"],
    ["cursor + kiro  → kiro",    [".cursor"], [".kiro"],    "kiro"],
    ["cursor + qwen  → qwen",    [".cursor"], [".qwen"],    "qwen-code"],
    ["cursor + gemini→ gemini",  [".cursor"], [".gemini"],  "gemini-cli"],
    ["cursor + claude→ claude",  [".cursor"], [".claude"],  "claude-code"],
    ["cursor + codex → codex",   [".cursor"], [".codex"],   "codex"],

    // ── VSCode coexistence: agent always wins ──
    ["vscode + claude→ claude",  [".vscode"], [".claude"],  "claude-code"],
    ["vscode + pi    → pi",      [".vscode"], [".pi"],      "pi"],

    // ── Pi → OMP rebrand collision: OMP wins (more specific) ──
    ["pi + omp       → omp",     [".pi"],     [".omp"],     "omp"],

    // ── Two-agent collision: priority is documented in detect.ts ──
    // claude > gemini > codex > kiro > omp > pi > qwen > openclaw > cursor
    // (issue #542 reorder — agents-first, then editors).
    ["kiro + gemini  → gemini",  [".kiro"],   [".gemini"],  "gemini-cli"],
    ["kiro + claude  → claude",  [".kiro"],   [".claude"],  "claude-code"],
    ["pi + claude    → claude",  [".pi"],     [".claude"],  "claude-code"],
    ["omp + claude   → claude",  [".omp"],    [".claude"],  "claude-code"],

    // ── Regressions: bare single-dir resolutions still work ──
    ["cursor only    → cursor",  [".cursor"], [".cursor"],  "cursor"],
    ["pi only        → pi",      [".pi"],     [".pi"],      "pi"],
    ["omp only       → omp",     [".omp"],    [".omp"],     "omp"],
    ["claude only    → claude",  [".claude"], [".claude"],  "claude-code"],
  ];

  it.each(cases)("%s", (_name, a, b, expected) => {
    presentDirs(a, b);
    const signal = detectPlatform();
    expect(signal.platform).toBe(expected);
    expect(signal.confidence).toBe("medium");
  });
});
