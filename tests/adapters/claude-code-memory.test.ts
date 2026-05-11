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

/**
 * Issue #460 follow-up — `getSettingsPath()` MUST flow through `getConfigDir()`
 * so the documented `CLAUDE_CONFIG_DIR` override actually steers settings I/O.
 * Otherwise hooks/security read one path, adapters write another, and policies
 * silently diverge.
 */
describe("CLAUDE_CONFIG_DIR honors getSettingsPath", () => {
  const adapter = new ClaudeCodeAdapter();
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  });

  it("env unset → ~/.claude/settings.json", () => {
    expect(adapter.getSettingsPath()).toBe(
      join(homedir(), ".claude", "settings.json"),
    );
  });

  it("env=/tmp/custom-cc → /tmp/custom-cc/settings.json", () => {
    const customDir = resolve("/tmp/custom-cc");
    process.env.CLAUDE_CONFIG_DIR = customDir;
    expect(adapter.getSettingsPath()).toBe(join(customDir, "settings.json"));
  });

  it("env=~/myconf → expanded to homedir-relative", () => {
    process.env.CLAUDE_CONFIG_DIR = "~/myconf";
    expect(adapter.getSettingsPath()).toBe(
      join(homedir(), "myconf", "settings.json"),
    );
  });

  it("env='' empty → falls back to ~/.claude/settings.json", () => {
    process.env.CLAUDE_CONFIG_DIR = "";
    expect(adapter.getSettingsPath()).toBe(
      join(homedir(), ".claude", "settings.json"),
    );
  });

  /**
   * Issue #460 round-3: whitespace-only env values would otherwise resolve
   * to `<cwd>/<spaces>` because the truthy guard catches them. Trim guard
   * lives in `resolveClaudeConfigDir`; this test pins the adapter routing
   * through the util.
   */
  it("env=' ' whitespace → falls back to ~/.claude/settings.json", () => {
    process.env.CLAUDE_CONFIG_DIR = "   ";
    expect(adapter.getSettingsPath()).toBe(
      join(homedir(), ".claude", "settings.json"),
    );
  });
});
