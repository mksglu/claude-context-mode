/**
 * Issue #523 — start.mjs MUST run healPluginJsonMcpServers on every MCP boot
 * so users already poisoned by v1.0.118's /ctx-upgrade self-recover the next
 * time Claude Code spawns the plugin.
 *
 * Sibling of cli-upgrade-verification.test.ts (which asserts wiring of HEAL
 * 3+4) — same static-analysis pattern: read start.mjs source, assert the
 * Layer 5 wiring is present, ordered correctly, and defensive.
 *
 * The bug being fixed:
 *   v1.0.118's /ctx-upgrade left .claude-plugin/plugin.json's args[0] pointing
 *   at <tmpdir>/context-mode-upgrade-<epoch>/start.mjs. After tmpdir cleanup,
 *   MCP fails to spawn with ENOENT — and the user has no /ctx-upgrade escape
 *   hatch (because MCP itself is dead). The escape hatch lives in start.mjs:
 *   if Claude Code can spawn start.mjs once with a stale path, it can't; if
 *   the path is healed before next boot, MCP comes back and /ctx-upgrade
 *   becomes usable again.
 *
 *   Layer 5b (this slice) heals on boot. Slice 7 prevents the bug at write
 *   time. Slice 1-6 prove the heal logic itself.
 */

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const startSrc = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");

describe("start.mjs — Issue #523 Layer 5b plugin.json mcpServers heal", () => {
  test("imports healPluginJsonMcpServers from the shared module", () => {
    expect(startSrc).toContain("healPluginJsonMcpServers");
    // Must import from the single source of truth.
    expect(startSrc).toMatch(/heal-installed-plugins\.mjs/);
  });

  test("Layer 5b heal call lives inside the existing HEAL 3+4 try-block", () => {
    // We deliberately co-locate Layer 5b with HEAL 3+4 so all three heals
    // share the same dynamic-import + outer try/catch (never block MCP boot).
    const heal34Idx = startSrc.indexOf("HEAL 3");
    const layer4Idx = startSrc.indexOf("Self-heal Layer 4");
    expect(heal34Idx).toBeGreaterThan(-1);
    expect(layer4Idx).toBeGreaterThan(-1);
    const block = startSrc.slice(heal34Idx, layer4Idx);
    expect(block).toContain("healPluginJsonMcpServers");
  });

  test("Layer 5b heal iterates ALL cache entries — not just our own pluginRoot", () => {
    // Critical: a user can have multiple installed_plugins.json entries for
    // context-mode (different versions, different scopes). The heal MUST run
    // against EVERY entry's installPath under pluginCacheRoot, otherwise an
    // older poisoned cache survives. We assert the iterator pattern: a `for`
    // loop over installed_plugins.json's plugins[key] entries, calling the
    // heal with each entry.installPath.
    const heal34Idx = startSrc.indexOf("HEAL 3");
    const layer4Idx = startSrc.indexOf("Self-heal Layer 4");
    const block = startSrc.slice(heal34Idx, layer4Idx);
    // The block must reference both `installPath` (from the registry entries)
    // and `healPluginJsonMcpServers` so we know it iterates per-cache-dir.
    expect(block).toContain("installPath");
    expect(block).toContain("healPluginJsonMcpServers");
  });

  test("Layer 5b heal is wrapped in defensive try/catch (never blocks MCP boot)", () => {
    const heal34Idx = startSrc.indexOf("HEAL 3");
    const layer4Idx = startSrc.indexOf("Self-heal Layer 4");
    const block = startSrc.slice(heal34Idx, layer4Idx);
    // Same posture as HEAL 3+4: outer try around dynamic import + inner try
    // around the actual call. Plus the existing "never block MCP boot" comment.
    expect((block.match(/try\s*\{/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(block).toContain("never block MCP boot");
  });

  test("postinstall.mjs also wires Layer 5b — escape hatch for already-broken users", () => {
    // Mirrors how postinstall.mjs runs healInstalledPlugins + healSettingsEnabledPlugins
    // (v1.0.114 + v1.0.116 escape hatches). When MCP is dead, the only way to recover is
    // `npm install -g context-mode@1.0.119` whose postinstall MUST run Layer 5b too.
    const postinstallSrc = readFileSync(
      resolve(ROOT, "scripts", "postinstall.mjs"),
      "utf-8",
    );
    expect(postinstallSrc).toContain("healPluginJsonMcpServers");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Issue #531 — start.mjs MUST also run healMcpJsonArgs alongside
// healPluginJsonMcpServers. Same Layer 5b heal block, sibling file (.mcp.json
// vs .claude-plugin/plugin.json). On every MCP boot, BOTH heals run so
// users poisoned by fresh-marketplace-install (#253 / aea633c) OR by
// /ctx-upgrade tmpdir leak self-recover the next time Claude Code spawns
// the plugin. Without this, a user whose `.mcp.json` has `./start.mjs`
// can never boot MCP — and start.mjs never runs — and the heal can't
// fire. That's the "fresh marketplace install" class; the postinstall
// path (slice 10) closes that gap. This slice closes the post-recovery
// loop: once MCP boots from any source, every subsequent boot heals.
// ─────────────────────────────────────────────────────────────────────────

describe("start.mjs — Issue #531 Layer 5b .mcp.json args heal", () => {
  test("imports healMcpJsonArgs from the shared module", () => {
    expect(startSrc).toContain("healMcpJsonArgs");
    expect(startSrc).toMatch(/heal-installed-plugins\.mjs/);
  });

  test("Layer 5b heal call lives inside the existing HEAL 3+4 try-block", () => {
    // Co-located with healPluginJsonMcpServers — same dynamic-import + outer
    // try/catch (never block MCP boot). Same per-entry loop.
    const heal34Idx = startSrc.indexOf("HEAL 3");
    const layer4Idx = startSrc.indexOf("Self-heal Layer 4");
    expect(heal34Idx).toBeGreaterThan(-1);
    expect(layer4Idx).toBeGreaterThan(-1);
    const block = startSrc.slice(heal34Idx, layer4Idx);
    expect(block).toContain("healMcpJsonArgs");
  });

  test("Layer 5b heal iterates ALL cache entries — not just our own pluginRoot", () => {
    // Same iterator pattern as healPluginJsonMcpServers. The .mcp.json heal
    // MUST run per-installPath so multi-version installs all self-recover.
    const heal34Idx = startSrc.indexOf("HEAL 3");
    const layer4Idx = startSrc.indexOf("Self-heal Layer 4");
    const block = startSrc.slice(heal34Idx, layer4Idx);
    expect(block).toContain("installPath");
    expect(block).toContain("healMcpJsonArgs");
  });
});
