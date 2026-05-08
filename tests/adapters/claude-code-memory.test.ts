import "../setup-home";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";

/**
 * Slice 2 — Claude Code adapter inherits BaseAdapter memory defaults.
 * No override needed; verify the inherited values match the
 * documented per-adapter convention.
 */
describe("ClaudeCodeAdapter memory conventions", () => {
  const adapter = new ClaudeCodeAdapter();
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  });

  it("getConfigDir returns ~/.claude when CLAUDE_CONFIG_DIR is unset", () => {
    expect(adapter.getConfigDir()).toBe(join(homedir(), ".claude"));
  });

  it("getConfigDir honors CLAUDE_CONFIG_DIR when set (issue #453)", () => {
    // Use resolve() in the expectation so the test passes on Windows, where
    // resolve("/tmp/...") drive-letter-prefixes to "<DRIVE>:\tmp\...".
    const customDir = resolve("/tmp/custom-claude-dir");
    process.env.CLAUDE_CONFIG_DIR = customDir;
    expect(adapter.getConfigDir()).toBe(customDir);
  });

  it("getConfigDir expands leading ~ in CLAUDE_CONFIG_DIR (matches resolveConfigDir contract)", () => {
    process.env.CLAUDE_CONFIG_DIR = "~/my-claude-cfg";
    expect(adapter.getConfigDir()).toBe(join(homedir(), "my-claude-cfg"));
  });

  it("getConfigDir falls back to ~/.claude when CLAUDE_CONFIG_DIR is empty string", () => {
    process.env.CLAUDE_CONFIG_DIR = "";
    expect(adapter.getConfigDir()).toBe(join(homedir(), ".claude"));
  });

  it("getInstructionFiles returns ['CLAUDE.md']", () => {
    expect(adapter.getInstructionFiles()).toEqual(["CLAUDE.md"]);
  });

  it("getMemoryDir returns ~/.claude/memory by default", () => {
    expect(adapter.getMemoryDir()).toBe(join(homedir(), ".claude", "memory"));
  });

  it("getMemoryDir derives from CLAUDE_CONFIG_DIR when set", () => {
    const customDir = resolve("/tmp/custom-claude-dir");
    process.env.CLAUDE_CONFIG_DIR = customDir;
    expect(adapter.getMemoryDir()).toBe(join(customDir, "memory"));
  });
});
