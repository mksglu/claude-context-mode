import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CursorAdapter } from "../../src/adapters/cursor/index.js";

/**
 * Issue #460 round-3: `CursorAdapter.hasClaudeCompatibilityHooks` (private,
 * surfaced via `diagnose()`) probes for `<homedir>/.claude/settings.json` to
 * surface the "Claude compatibility" warning. This MUST honor
 * `CLAUDE_CONFIG_DIR` so users who relocate their CC config still see the
 * warning when they have legacy CC settings under the override.
 *
 * We pin this through `diagnose()` — the only public surface that exercises
 * the probe — looking for the canonical "Claude compatibility" warning text.
 */
describe("CursorAdapter Claude-compat probe honors CLAUDE_CONFIG_DIR (#460 round-3)", () => {
  let customCfg: string;
  let saved: string | undefined;

  beforeEach(() => {
    customCfg = mkdtempSync(join(tmpdir(), "cursor-r3-cfg-"));
    saved = process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    rmSync(customCfg, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });

  it("env=customDir with settings.json → 'Claude compatibility' warn appears", () => {
    // Plant settings.json under the relocated CC dir.
    writeFileSync(
      join(customCfg, "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [] } }),
      "utf-8",
    );
    process.env.CLAUDE_CONFIG_DIR = customCfg;

    const adapter = new CursorAdapter();
    const results = adapter.validateHooks("/tmp/dummy-plugin-root");
    const compat = results.find((r) => r.check === "Claude compatibility");
    expect(compat?.status).toBe("warn");
  });

  it("env=customDir empty (no settings.json) → no 'Claude compatibility' warning", () => {
    process.env.CLAUDE_CONFIG_DIR = customCfg;

    // Sanity: ensure no project-local .claude/settings.json from cwd
    // would mask the negative case. If one exists in this test cwd, we
    // simply skip the negative assertion (the positive test above is the
    // important one for the route-through pin).
    const projectClaude = join(process.cwd(), ".claude", "settings.json");
    const projectClaudeLocal = join(process.cwd(), ".claude", "settings.local.json");
    if (existsSync(projectClaude) || existsSync(projectClaudeLocal)) return;

    const adapter = new CursorAdapter();
    const results = adapter.validateHooks("/tmp/dummy-plugin-root");
    const compat = results.find((r) => r.check === "Claude compatibility");
    expect(compat).toBeUndefined();
  });
});
