import "../setup-home";
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseAdapter } from "../../src/adapters/base.js";

/**
 * BaseAdapter memory/config dispatch defaults.
 *
 * Slice 1 of the adapter-aware persistent memory rework.
 * Verifies the three new defaults BaseAdapter exposes for
 * auto-memory + ctx_search timeline + rule detection:
 *   - getConfigDir()       — derived from sessionDirSegments
 *   - getInstructionFiles()— defaults to ["CLAUDE.md"] (Claude convention)
 *   - getMemoryDir()       — defaults to <configDir>/memory
 */

class TestAdapter extends BaseAdapter {
  constructor(segments: string[]) {
    super(segments);
  }
  getSettingsPath(): string {
    return join(this.getConfigDir(), "settings.json");
  }
}

describe("BaseAdapter memory/config defaults", () => {
  it("getConfigDir returns $HOME joined with sessionDirSegments (single segment)", () => {
    const adapter = new TestAdapter([".claude"]);
    expect(adapter.getConfigDir()).toBe(join(homedir(), ".claude"));
  });

  it("getConfigDir handles multi-segment sessionDirSegments", () => {
    const adapter = new TestAdapter([".config", "zed"]);
    expect(adapter.getConfigDir()).toBe(join(homedir(), ".config", "zed"));
  });

  it("getInstructionFiles defaults to ['CLAUDE.md']", () => {
    const adapter = new TestAdapter([".claude"]);
    expect(adapter.getInstructionFiles()).toEqual(["CLAUDE.md"]);
  });

  it("getMemoryDir defaults to <configDir>/memory", () => {
    const adapter = new TestAdapter([".claude"]);
    expect(adapter.getMemoryDir()).toBe(join(homedir(), ".claude", "memory"));
  });
});
