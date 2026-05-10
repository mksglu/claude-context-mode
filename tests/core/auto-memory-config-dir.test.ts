import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchAutoMemory } from "../../src/search/auto-memory.js";

/**
 * Issue #460 round-3: when called WITHOUT an adapter or explicit configDir,
 * `searchAutoMemory` MUST honor `CLAUDE_CONFIG_DIR` for the legacy fallback.
 * Otherwise users who relocate their CC config see auto-memory return zero
 * results even though their notes are written under the override dir.
 */
describe("searchAutoMemory CLAUDE_CONFIG_DIR fallback (#460 round-3)", () => {
  let projectDir: string;
  let customCfg: string;
  let saved: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxam-r3-proj-"));
    customCfg = mkdtempSync(join(tmpdir(), "ctxam-r3-cfg-"));
    saved = process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(customCfg, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });

  it("legacy fallback reads <CLAUDE_CONFIG_DIR>/memory when env is set", () => {
    // Write a marker memory file under the relocated config dir.
    const memDir = join(customCfg, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, "decisions.md"),
      "# Decisions\n- ROUTE-460-MARKER: pinned by adapter sweep round-3.\n",
      "utf-8",
    );
    process.env.CLAUDE_CONFIG_DIR = customCfg;

    const results = searchAutoMemory(["ROUTE-460-MARKER"], 5, projectDir);

    const flat = results.map((r) => r.content).join("\n");
    expect(flat).toContain("ROUTE-460-MARKER");
  });

  it("legacy fallback ignores empty/whitespace env (uses ~/.claude floor)", () => {
    // Whitespace must not steer the read into <cwd>/<spaces>/memory; the
    // util's trim guard pushes us back to the homedir floor where the test
    // home (setup-home) lives. The marker file written under customCfg
    // must NOT be found because we never set the env to it.
    const memDir = join(customCfg, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, "decisions.md"),
      "# Decisions\n- WHITESPACE-MUST-NOT-MATCH-460: this should not surface.\n",
      "utf-8",
    );
    process.env.CLAUDE_CONFIG_DIR = "   ";

    const results = searchAutoMemory(["WHITESPACE-MUST-NOT-MATCH-460"], 5, projectDir);

    expect(results).toEqual([]);
  });
});
