/**
 * Issue #523 — cli.ts upgrade() MUST guarantee .claude-plugin/plugin.json's
 * mcpServers["context-mode"].args[0] is the literal ${CLAUDE_PLUGIN_ROOT}
 * placeholder before declaring upgrade success.
 *
 * Sibling of cli-upgrade-verification.test.ts (v1.0.114 hotfix). Same
 * static-analysis pattern: read src/cli.ts, slice the upgrade() function
 * body, assert the post-bump block contains the right code shape.
 *
 * Why static analysis instead of integration spawn?
 *   The full upgrade() flow git-clones from GitHub, runs npm install,
 *   triggers native rebuild. None of that is testable in CI without an
 *   internet round-trip + tens of seconds. The assertions here lock in
 *   the *code shape* — a future regression that drops the heal call
 *   surfaces immediately at vitest time.
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

describe("cli.ts upgrade() — Issue #523 plugin.json placeholder assertion", () => {
  test("post-bump block invokes healPluginJsonMcpServers from the shared module", () => {
    // The post-write assertion block (registry consistency) is the right
    // anchor — Layer 5 heal must run AFTER updatePluginRegistry so the
    // newly-written plugin.json is in its final on-disk shape.
    const updateIdx = upgradeBody.indexOf("updatePluginRegistry");
    const healCallIdx = upgradeBody.indexOf("healPluginJsonMcpServers");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(healCallIdx).toBeGreaterThan(updateIdx);
  });

  test("imports healPluginJsonMcpServers from scripts/heal-installed-plugins.mjs", () => {
    expect(cliSrc).toMatch(
      /from\s+["']\.\.\/scripts\/heal-installed-plugins\.mjs["']/,
    );
    expect(cliSrc).toContain("healPluginJsonMcpServers");
  });

  test("upgrade() throws on drift — refuses to declare success when plugin.json args[0] is poisoned", () => {
    // The contract: if healPluginJsonMcpServers reports `healed: ["plugin-json-args"]`,
    // that means args[0] was tmpdir-poisoned and we just rewrote it. The bug we're
    // fixing means the upgrade() body raised v1.0.118 to a state that COULDN'T self-
    // recover until the next MCP boot. Now we want upgrade() to either:
    //   (a) always leave plugin.json clean (zero healed) → no throw, OR
    //   (b) assert post-heal that no further drift is detected → throw on second-pass heal
    // We pick (a)+(b) belt-and-braces: a second healPluginJsonMcpServers call MUST
    // return healed:[] or upgrade() throws "Plugin manifest drift".
    const healCallIdx = upgradeBody.indexOf("healPluginJsonMcpServers");
    expect(healCallIdx).toBeGreaterThan(-1);
    const block = upgradeBody.slice(healCallIdx, healCallIdx + 1500);
    expect(block).toMatch(/Plugin manifest drift|plugin\.json.*drift|drift.*plugin\.json/i);
    expect(block).toMatch(/throw new Error/);
  });

  test("Layer 5 heal call passes pluginRoot, pluginCacheRoot, pluginKey", () => {
    const healCallIdx = upgradeBody.indexOf("healPluginJsonMcpServers");
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
