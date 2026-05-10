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

// C2 narrowing — BaseAdapter MUST NOT expose path helpers that are pure
// derivatives of `getSessionDir() + projectDir`. Those derivatives belong
// in `src/session/db.ts:resolveSessionDbPath` (single site of computation,
// case-fold migration, worktree-suffix handling). Exposing them on every
// adapter is a SHALLOW interface — its complexity equals its implementation
// — and tempts adapter authors to override for cargo-cult reasons (e.g. the
// pre-narrowing CodexAdapter override that just delegated to the same
// helper). Deletion test: collapses to ONE call site, complexity does NOT
// reappear in N callers.
describe("BaseAdapter — adapter-storage interface narrowing (C2)", () => {
  it("does NOT expose getSessionDBPath — callers go through resolveSessionDbPath", () => {
    const adapter = new TestAdapter([".claude"]);
    // Use Reflect to interrogate the runtime shape — the cast is intentional;
    // we are pinning that the public surface no longer carries this method.
    expect((adapter as unknown as Record<string, unknown>).getSessionDBPath).toBeUndefined();
  });

  it("does NOT expose getSessionEventsPath — events.md path lives in callers/server", () => {
    const adapter = new TestAdapter([".claude"]);
    expect((adapter as unknown as Record<string, unknown>).getSessionEventsPath).toBeUndefined();
  });
});
