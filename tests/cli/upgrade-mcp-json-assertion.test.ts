/**
 * Issue #531 — cli.ts upgrade() MUST guarantee `.mcp.json`'s
 * mcpServers["context-mode"].args[0] is the literal ${CLAUDE_PLUGIN_ROOT}
 * placeholder before declaring upgrade success.
 *
 * Asymmetric-heal sibling of upgrade-plugin-json-assertion.test.ts (#523).
 * Same static-analysis pattern: read src/cli.ts, slice the upgrade()
 * function body, assert the post-bump block contains the right code shape.
 *
 * The bug being prevented:
 *   cli.ts upgrade() already writes `.mcp.json` with the placeholder (#411
 *   fix at line ~829-845). But upgrade() never asserted the on-disk shape
 *   afterwards. If a future regression dropped the placeholder write —
 *   or if a parallel hook normalized the file with an absolute tmpdir
 *   path — upgrade() would declare success on a poisoned tree. This
 *   slice locks in the post-bump assertion using the same belt-and-
 *   braces double-call pattern as #523's plugin.json assertion.
 */

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const cliSrc = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
const upgradeIdx = cliSrc.indexOf("async function upgrade");
const upgradeBody = cliSrc.slice(upgradeIdx, upgradeIdx + 16000);

describe("cli.ts upgrade() — Issue #531 .mcp.json placeholder assertion", () => {
  test("post-bump block invokes healMcpJsonArgs from the shared module", () => {
    // Must run AFTER updatePluginRegistry so the on-disk shape is final.
    const updateIdx = upgradeBody.indexOf("updatePluginRegistry");
    const healCallIdx = upgradeBody.indexOf("healMcpJsonArgs");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(healCallIdx).toBeGreaterThan(updateIdx);
  });

  test("imports healMcpJsonArgs from scripts/heal-installed-plugins.mjs", () => {
    expect(cliSrc).toMatch(
      /from\s+["']\.\.\/scripts\/heal-installed-plugins\.mjs["']/,
    );
    expect(cliSrc).toContain("healMcpJsonArgs");
  });

  test("upgrade() throws on drift — refuses to declare success when .mcp.json args[0] is poisoned", () => {
    // Belt-and-braces contract (mirrors #523's plugin.json assertion):
    //   1. First healMcpJsonArgs pass cleans any drift.
    //   2. Second healMcpJsonArgs pass MUST return healed:[] or upgrade()
    //      throws with a "drift" error.
    const healCallIdx = upgradeBody.indexOf("healMcpJsonArgs");
    expect(healCallIdx).toBeGreaterThan(-1);
    const block = upgradeBody.slice(healCallIdx, healCallIdx + 1500);
    expect(block).toMatch(/\.mcp\.json.*drift|drift.*\.mcp\.json|mcp\.json drift/i);
    expect(block).toMatch(/throw new Error/);
  });

  test("Layer 6 heal call passes pluginRoot, pluginCacheRoot, pluginKey", () => {
    const healCallIdx = upgradeBody.indexOf("healMcpJsonArgs");
    // Widen the window 400 chars BEFORE the call to capture the local
    // pluginCacheRoot binding, plus 800 after to cover both heal-pass calls.
    const block = upgradeBody.slice(
      Math.max(0, healCallIdx - 400),
      healCallIdx + 800,
    );
    expect(block).toContain("pluginRoot");
    expect(block).toContain("pluginCacheRoot");
    expect(block).toContain("pluginKey");
    // pluginCacheRoot must derive from resolveClaudeConfigDir() so we don't
    // hard-code ~/.claude/ — adapter-aware, sandbox-aware.
    expect(block).toMatch(/resolveClaudeConfigDir\(\)/);
    expect(block).toMatch(/plugins.*cache|"cache"/);
  });
});
