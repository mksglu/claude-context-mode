/**
 * Issue #609 — cli.ts upgrade() MUST sweep stale `.mcp.json` files from
 * every per-version plugin-cache dir before declaring upgrade success.
 *
 * History:
 *   v1.0.122 (Issue #531) — this file previously locked in the assertion
 *   that `healMcpJsonArgs` runs post-bump to heal any per-version
 *   `.mcp.json` carrying a poisoned arg. cli.ts itself wrote `.mcp.json`
 *   at upgrade time (#411 fix), so the heal was the right shape then.
 *
 *   Issue #609 superseded that approach. The architectural fix is to
 *   STOP writing `.mcp.json` from cli.ts entirely — Claude Code reads
 *   `.claude-plugin/plugin.json.mcpServers` as the canonical source
 *   (refs/platforms/claude-code/src/utils/plugins/mcpPluginIntegration.ts:131-212).
 *   With the write gone, the residual `.mcp.json` files in the cache are
 *   stale carry-forwards from prior installs / Claude Code's auto-update.
 *   `sweepStaleMcpJson` removes them so the carry-forward vector cannot
 *   replay.
 *
 * Two contracts this file enforces:
 *   1. `sweepStaleMcpJson` is invoked AFTER `updatePluginRegistry` from the
 *      shared `scripts/heal-installed-plugins.mjs` module.
 *   2. Belt-and-braces: second sweep pass MUST report `removed:[]` or
 *      upgrade() throws — same shape as plugin.json drift check (#523).
 *
 * The legacy `healMcpJsonArgs` assertion is intentionally replaced (not
 * just appended) — that function still exists for backwards-compat / boot-
 * time recovery, but cli.ts no longer needs to invoke it because there is
 * no `.mcp.json` to heal.
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

describe("cli.ts upgrade() — Issue #609 .mcp.json sweep assertion", () => {
  test("post-bump block invokes sweepStaleMcpJson from the shared module", () => {
    // Must run AFTER updatePluginRegistry so the on-disk shape is final.
    const updateIdx = upgradeBody.indexOf("updatePluginRegistry");
    const sweepCallIdx = upgradeBody.indexOf("sweepStaleMcpJson");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(sweepCallIdx).toBeGreaterThan(updateIdx);
  });

  test("imports sweepStaleMcpJson from scripts/heal-installed-plugins.mjs", () => {
    expect(cliSrc).toMatch(
      /from\s+["']\.\.\/scripts\/heal-installed-plugins\.mjs["']/,
    );
    expect(cliSrc).toContain("sweepStaleMcpJson");
  });

  test("upgrade() throws on sweep drift — second pass MUST report removed:[]", () => {
    // Belt-and-braces contract (mirrors #523's plugin.json assertion):
    //   1. First sweep pass removes any pre-existing `.mcp.json`.
    //   2. Second sweep MUST report removed:[] or upgrade() throws.
    const sweepCallIdx = upgradeBody.indexOf("sweepStaleMcpJson");
    expect(sweepCallIdx).toBeGreaterThan(-1);
    const block = upgradeBody.slice(sweepCallIdx, sweepCallIdx + 1500);
    expect(block).toMatch(/sweep drift|sweep check failed|still present/i);
    expect(block).toMatch(/throw new Error/);
  });

  test("sweep call passes pluginCacheRoot, pluginKey (no per-version pluginRoot)", () => {
    const sweepCallIdx = upgradeBody.indexOf("sweepStaleMcpJson");
    // Widen the window 400 chars BEFORE the call to capture the local
    // pluginCacheRoot binding, plus 800 after to cover both sweep-pass calls.
    const block = upgradeBody.slice(
      Math.max(0, sweepCallIdx - 400),
      sweepCallIdx + 800,
    );
    expect(block).toContain("pluginCacheRoot");
    expect(block).toContain("pluginKey");
    // pluginCacheRoot must derive from resolveClaudeConfigDir() so we don't
    // hard-code ~/.claude/ — adapter-aware, sandbox-aware.
    expect(block).toMatch(/resolveClaudeConfigDir\(\)/);
    expect(block).toMatch(/plugins.*cache|"cache"/);
  });
});
