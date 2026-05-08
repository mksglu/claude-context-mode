import { strict as assert } from "node:assert";
import { describe, test } from "vitest";
import { extractEvents } from "../../src/session/extract.js";

/**
 * Slice 6 — extract.ts rule detection covers all platform-native
 * instruction file names (not just CLAUDE.md / .claude/).
 *
 * Without this, reads of AGENTS.md, GEMINI.md, QWEN.md, KIRO.md,
 * copilot-instructions.md, context-mode.mdc, etc. silently dropped
 * to file_read only — never surfacing as `rule` events for snapshots.
 */

function readEvent(filePath: string, body = "rule body content") {
  return extractEvents({
    tool_name: "Read",
    tool_input: { file_path: filePath },
    tool_response: body,
  });
}

describe("rule detection — multi-platform instruction files", () => {
  test("CLAUDE.md still emits rule + rule_content (regression guard)", () => {
    const events = readEvent("/project/CLAUDE.md");
    assert.ok(events.some(e => e.type === "rule"), "rule event missing");
    assert.ok(events.some(e => e.type === "rule_content"), "rule_content missing");
    assert.ok(events.some(e => e.type === "file_read"), "file_read missing");
  });

  test("Codex AGENTS.md emits a rule event", () => {
    const events = readEvent("/project/AGENTS.md");
    assert.ok(
      events.some(e => e.type === "rule"),
      "AGENTS.md should be detected as a rule file",
    );
  });

  test("Codex AGENTS.override.md emits a rule event", () => {
    const events = readEvent("/project/AGENTS.override.md");
    assert.ok(events.some(e => e.type === "rule"));
  });

  test("Gemini GEMINI.md emits a rule event", () => {
    const events = readEvent("/project/GEMINI.md");
    assert.ok(events.some(e => e.type === "rule"));
  });

  test("Qwen QWEN.md emits a rule event", () => {
    const events = readEvent("/project/QWEN.md");
    assert.ok(events.some(e => e.type === "rule"));
  });

  test("Kiro KIRO.md emits a rule event", () => {
    const events = readEvent("/project/KIRO.md");
    assert.ok(events.some(e => e.type === "rule"));
  });

  test("VS Code copilot-instructions.md emits a rule event", () => {
    const events = readEvent("/project/.github/copilot-instructions.md");
    assert.ok(events.some(e => e.type === "rule"));
  });

  test("Cursor context-mode.mdc emits a rule event", () => {
    const events = readEvent("/project/.cursor/context-mode.mdc");
    assert.ok(events.some(e => e.type === "rule"));
  });

  test("reading inside a memory directory emits a rule event", () => {
    // Auto-memory files (under <configDir>/memory/) carry persisted
    // user decisions — they should be tracked as rules.
    const events = readEvent("/Users/me/.codex/memories/decisions.md");
    assert.ok(events.some(e => e.type === "rule"));
  });

  test("an unrelated source file does NOT emit a rule event", () => {
    const events = readEvent("/project/src/server.ts");
    assert.equal(events.filter(e => e.type === "rule").length, 0);
    assert.ok(events.some(e => e.type === "file_read"));
  });
});
