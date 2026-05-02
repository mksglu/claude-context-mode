import "../setup-home";
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";

/**
 * Slice 2 — Claude Code adapter inherits BaseAdapter memory defaults.
 * No override needed; verify the inherited values match the
 * documented per-adapter convention.
 */
describe("ClaudeCodeAdapter memory conventions", () => {
  const adapter = new ClaudeCodeAdapter();

  it("getConfigDir returns ~/.claude", () => {
    expect(adapter.getConfigDir()).toBe(join(homedir(), ".claude"));
  });

  it("getInstructionFiles returns ['CLAUDE.md']", () => {
    expect(adapter.getInstructionFiles()).toEqual(["CLAUDE.md"]);
  });

  it("getMemoryDir returns ~/.claude/memory", () => {
    expect(adapter.getMemoryDir()).toBe(join(homedir(), ".claude", "memory"));
  });
});
