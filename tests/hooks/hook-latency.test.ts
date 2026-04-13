/**
 * Hook latency regression guard.
 *
 * Ensures PreToolUse routing and PostToolUse event extraction stay under
 * the project's <10ms latency budget. These hooks fire on EVERY tool call,
 * so even small regressions compound across a session.
 *
 * Measures pure function execution time (no I/O, no stdin, no SQLite).
 * The budget is split:
 *   - PreToolUse routing:  < 3ms p95 per call
 *   - PostToolUse extract: < 3ms p95 per call
 *   - Overhead margin kept for stdin parse + SQLite write in production.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// ─── Dynamic imports for .mjs modules ───
let routePreToolUse: (
  toolName: string,
  toolInput: Record<string, unknown>,
  projectDir?: string,
) => unknown;
let resetGuidanceThrottle: () => void;
let extractEvents: (input: {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: string;
  tool_output?: unknown;
}) => unknown[];

beforeAll(async () => {
  const routing = await import("../../hooks/core/routing.mjs");
  routePreToolUse = routing.routePreToolUse;
  resetGuidanceThrottle = routing.resetGuidanceThrottle;

  const extract = await import("../../src/session/extract.js");
  extractEvents = extract.extractEvents;
});

// MCP readiness sentinel — routing depends on this
const mcpSentinel = resolve(tmpdir(), `context-mode-mcp-ready-${process.ppid}`);

beforeEach(() => {
  if (typeof resetGuidanceThrottle === "function") resetGuidanceThrottle();
  writeFileSync(mcpSentinel, String(process.pid));
});

afterEach(() => {
  try { unlinkSync(mcpSentinel); } catch {}
});

// ─── Helpers ───

/** Run a function N times and return p95 latency in ms. */
function measureP95(fn: () => void, iterations = 500): number {
  // Warm up — JIT + inline caches
  for (let i = 0; i < 50; i++) fn();

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length * 0.95)];
}

// ─── Representative tool call payloads ───

const PRETOOL_CASES = [
  { name: "Bash (short command)", tool: "Bash", input: { command: "git status" } },
  { name: "Bash (large output)", tool: "Bash", input: { command: "find . -type f | head -500" } },
  { name: "Read file", tool: "Read", input: { file_path: "/tmp/test.ts" } },
  { name: "Grep search", tool: "Grep", input: { pattern: "TODO", path: "/tmp" } },
  { name: "Write file", tool: "Write", input: { file_path: "/tmp/out.ts", content: "hello" } },
  { name: "Edit file", tool: "Edit", input: { file_path: "/tmp/out.ts", old_string: "a", new_string: "b" } },
  { name: "MCP tool (passthrough)", tool: "mcp__plugin_context-mode_context-mode__ctx_execute", input: { language: "javascript", code: "1+1" } },
  { name: "Glob search", tool: "Glob", input: { pattern: "**/*.ts" } },
];

const POSTTOOL_CASES = [
  {
    name: "Bash with git output",
    tool_name: "Bash",
    tool_input: { command: "git log --oneline -10" },
    tool_response: "abc1234 feat: something\ndef5678 fix: other thing",
  },
  {
    name: "Read file response",
    tool_name: "Read",
    tool_input: { file_path: "/tmp/test.ts" },
    tool_response: "const x = 1;\nconst y = 2;",
  },
  {
    name: "Edit file response",
    tool_name: "Edit",
    tool_input: { file_path: "/tmp/test.ts", old_string: "x", new_string: "y" },
    tool_response: "File edited successfully",
  },
  {
    name: "Write file response",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/new.ts", content: "export const a = 1;" },
    tool_response: "File written successfully",
  },
  {
    name: "Grep response",
    tool_name: "Grep",
    tool_input: { pattern: "TODO" },
    tool_response: "src/server.ts:42: // TODO: fix\nsrc/store.ts:10: // TODO: refactor",
  },
];

// ─── Latency tests ───

const BUDGET_MS = 3; // 3ms allows CI noise margin; real regressions push to 10ms+

describe("PreToolUse routing latency (<2ms p95)", () => {
  for (const tc of PRETOOL_CASES) {
    it(`${tc.name}: p95 < ${BUDGET_MS}ms`, () => {
      const p95 = measureP95(() => {
        routePreToolUse(tc.tool, tc.input, "/tmp/test-project");
      });
      expect(p95).toBeLessThan(BUDGET_MS);
    });
  }
});

describe("PostToolUse extractEvents latency (<2ms p95)", () => {
  for (const tc of POSTTOOL_CASES) {
    it(`${tc.name}: p95 < ${BUDGET_MS}ms`, () => {
      const p95 = measureP95(() => {
        extractEvents({
          tool_name: tc.tool_name,
          tool_input: tc.tool_input as Record<string, unknown>,
          tool_response: tc.tool_response,
        });
      });
      expect(p95).toBeLessThan(BUDGET_MS);
    });
  }
});

