/**
 * Issue #609 — scripts/postinstall.mjs MUST invoke sweepStaleMcpJson
 * alongside healPluginJsonMcpServers so users broken by Claude Code's
 * auto-update carry-forward (or by an earlier /ctx-upgrade tmpdir leak)
 * self-recover when they run `npm install -g context-mode`.
 *
 * History:
 *   v1.0.122 (#531) — postinstall ran `healMcpJsonArgs` per-entry to
 *   patch poisoned `.mcp.json` args. cli.ts also wrote `.mcp.json` at
 *   upgrade time then, so the heal was the right shape.
 *
 *   Issue #609 superseded that approach. cli.ts no longer writes `.mcp.json`
 *   (Claude Code reads `.claude-plugin/plugin.json.mcpServers` as the
 *   canonical source — upstream: mcpPluginIntegration.ts:131-212). The
 *   residual `.mcp.json` files in the cache are stale carry-forwards.
 *   Sweep them so the auto-update cannot replay them into a fresh dir.
 *
 * Static-analysis sibling of start-mjs-self-heal.test.ts — fast, deterministic,
 * no integration spawn.
 */

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const postinstallSrc = readFileSync(resolve(ROOT, "scripts", "postinstall.mjs"), "utf-8");

describe("scripts/postinstall.mjs — Issue #609 sweep stale .mcp.json", () => {
  test("imports sweepStaleMcpJson from the shared module", () => {
    expect(postinstallSrc).toContain("sweepStaleMcpJson");
    expect(postinstallSrc).toMatch(/heal-installed-plugins\.mjs/);
  });

  test("invokes sweepStaleMcpJson alongside healPluginJsonMcpServers", () => {
    // Both must run in the same install-time heal block. Anchor on the
    // existing #523 heal call and assert the sweep also lives nearby.
    const heal523Idx = postinstallSrc.indexOf("healPluginJsonMcpServers");
    expect(heal523Idx).toBeGreaterThan(-1);
    const sweepIdx = postinstallSrc.indexOf("sweepStaleMcpJson");
    expect(sweepIdx).toBeGreaterThan(-1);
    // Distance between them should be modest — same block.
    expect(Math.abs(sweepIdx - heal523Idx)).toBeLessThan(2000);
  });

  test("sweep call passes pluginCacheRoot and pluginKey", () => {
    // Use lastIndexOf to anchor on the call site, not the import line.
    const idx = postinstallSrc.lastIndexOf("sweepStaleMcpJson");
    const block = postinstallSrc.slice(idx, idx + 500);
    expect(block).toContain("pluginCacheRoot");
    expect(block).toContain("pluginKey");
  });

  test("sweep is wrapped defensively (try/catch, never blocks install)", () => {
    // Best-effort posture — a failed sweep MUST NOT abort the install.
    const idx = postinstallSrc.lastIndexOf("sweepStaleMcpJson");
    const block = postinstallSrc.slice(Math.max(0, idx - 400), idx + 500);
    expect(block).toMatch(/try\s*\{/);
    expect(block).toMatch(/never block install|best effort/i);
  });
});
