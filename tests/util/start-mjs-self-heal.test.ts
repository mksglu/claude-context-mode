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
// Issue #609 — start.mjs MUST run sweepStaleMcpJson alongside
// healPluginJsonMcpServers so users broken by Claude Code's auto-update
// carry-forward of a previous version's `.mcp.json` self-recover on the
// next MCP boot.
//
// History:
//   v1.0.122 (#531) — start.mjs ran `healMcpJsonArgs` per-installPath to
//   heal poisoned `.mcp.json` args. cli.ts wrote `.mcp.json` at upgrade
//   time then, so per-entry healing was the right shape.
//
//   Issue #609 superseded that. cli.ts no longer writes `.mcp.json`
//   (canonical MCP source is `.claude-plugin/plugin.json.mcpServers` —
//   upstream: mcpPluginIntegration.ts:131-212). Residual `.mcp.json`
//   files in the cache are stale carry-forwards from prior installs.
//   `sweepStaleMcpJson` removes them so the auto-update cannot replay
//   them into a fresh version dir on the next /ctx-upgrade cycle.
// ─────────────────────────────────────────────────────────────────────────

describe("start.mjs — Issue #609 sweep stale .mcp.json", () => {
  test("imports sweepStaleMcpJson from the shared module", () => {
    expect(startSrc).toContain("sweepStaleMcpJson");
    expect(startSrc).toMatch(/heal-installed-plugins\.mjs/);
  });

  test("sweep call lives inside the existing HEAL 3+4 try-block", () => {
    // Co-located with healPluginJsonMcpServers — same dynamic-import + outer
    // try/catch (never block MCP boot).
    const heal34Idx = startSrc.indexOf("HEAL 3");
    const layer4Idx = startSrc.indexOf("Self-heal Layer 4");
    expect(heal34Idx).toBeGreaterThan(-1);
    expect(layer4Idx).toBeGreaterThan(-1);
    const block = startSrc.slice(heal34Idx, layer4Idx);
    expect(block).toContain("sweepStaleMcpJson");
  });

  test("sweep is invoked once per boot with pluginCacheRoot + pluginKey", () => {
    // The sweep operates against the cache root as a whole — not per-
    // installPath. One call walks every version dir under <cacheRoot>/
    // <owner>/<plugin>/ and removes any `.mcp.json`. This is cheaper than
    // the previous per-entry healMcpJsonArgs loop and structurally cannot
    // miss a version dir that's missing from the registry.
    const heal34Idx = startSrc.indexOf("HEAL 3");
    const layer4Idx = startSrc.indexOf("Self-heal Layer 4");
    const block = startSrc.slice(heal34Idx, layer4Idx);
    expect(block).toContain("sweepStaleMcpJson");
    expect(block).toContain("pluginCacheRoot");
    expect(block).toContain("pluginKey");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Issue #577 — start.mjs cache-heal layer MUST honor CLAUDE_CONFIG_DIR.
//
// Bug claim (justdoGIT, 2026-05-15):
//   The auto-deployed cache-heal hook system in start.mjs hardcodes
//   `~/.claude/...` paths instead of respecting the CLAUDE_CONFIG_DIR env var.
//   When CLAUDE_CONFIG_DIR redirects config elsewhere:
//     1. Looks for installed_plugins.json at the wrong path (silent no-op)
//     2. Creates an unwanted ~/.claude/ directory
//
// Two surfaces are affected:
//   A) start.mjs ITSELF — globalHooksDir, settingsPath, and the Layer 1 / 3+4
//      registry/cache paths (lines that resolve(homedir(), ".claude", ...)).
//   B) The auto-deployed cache-heal hook SCRIPT TEMPLATE that start.mjs writes
//      to disk — once written to ~/.claude/hooks/, that script also needs to
//      honor CLAUDE_CONFIG_DIR at its OWN runtime (not at start.mjs render
//      time), because users may set the env var AFTER install.
//
// Fix pattern: mirror session-helpers.mjs::resolveConfigDir — read
// CLAUDE_CONFIG_DIR (with leading-~ expansion), fall back to ~/.claude when
// unset/empty. Same shape already lives in hooks/run-hook.mjs:33 ("Mirrors
// session-helpers.mjs::resolveConfigDir for #453").
// ─────────────────────────────────────────────────────────────────────────

describe("start.mjs — Issue #577 CLAUDE_CONFIG_DIR honoring", () => {
  test("cache-heal layer reads CLAUDE_CONFIG_DIR env var", () => {
    // The fix introduces (or mirrors) a resolveClaudeConfigDir helper that
    // checks process.env.CLAUDE_CONFIG_DIR. Either the literal env-var name
    // or a clearly-named helper must appear in start.mjs.
    const hasEnvRead = /process\.env\.CLAUDE_CONFIG_DIR/.test(startSrc);
    const hasHelper = /resolveClaudeConfigDir|getClaudeConfigDir/.test(
      startSrc,
    );
    expect(hasEnvRead || hasHelper).toBe(true);
  });

  test("no remaining hardcoded resolve(homedir(), '.claude', ...) for plugin paths", () => {
    // After the fix, plugin-cache and settings paths must be derived from
    // the resolved config dir — not from a hardcoded ~/.claude segment.
    // We allow the bare-fallback inside the resolver itself; everything
    // else with a trailing path segment must go through the helper.
    const offenders: string[] = [];
    const lines = startSrc.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const stripped = line.replace(/\/\/.*$/, "").trim();
      if (!stripped) continue;
      // The isPluginInstallPath regex literally matches ".claude/plugins/" —
      // that's a path-shape detector, not a path constructor, so it's fine.
      if (stripped.includes("isPluginInstallPath")) continue;
      if (stripped.includes("/[/\\\\]\\.claude")) continue;
      // The fallback inside the resolver itself
      // (`return resolve(homedir(), ".claude")` with no additional segments)
      // is the documented default — keep it allowed.
      const fallbackOnly = /return\s+resolve\s*\(\s*homedir\s*\(\s*\)\s*,\s*["']\.claude["']\s*\)/;
      if (fallbackOnly.test(line)) continue;
      // The pattern we're hunting: resolve(homedir(), ".claude", <segment>, ...)
      if (/resolve\s*\(\s*homedir\s*\(\s*\)\s*,\s*["']\.claude["']\s*,/.test(line)) {
        offenders.push(`L${i + 1}: ${line.trim()}`);
      }
    }
    expect(
      offenders,
      `start.mjs still hardcodes ~/.claude in ${offenders.length} place(s):\n${offenders.join(
        "\n",
      )}`,
    ).toEqual([]);
  });

  test("globalHooksDir is derived from the resolved config dir, not hardcoded", () => {
    const ghdLine = startSrc
      .split("\n")
      .find((l) => /globalHooksDir\s*=/.test(l));
    expect(ghdLine, "globalHooksDir assignment must exist in start.mjs").toBeDefined();
    expect(ghdLine!).not.toMatch(
      /resolve\s*\(\s*homedir\s*\(\s*\)\s*,\s*["']\.claude["']\s*,\s*["']hooks["']\s*\)/,
    );
  });

  test("settings.json registration path is derived from the resolved config dir", () => {
    // The "Register the hook" block must compute settingsPath via the
    // resolved config dir, not via a hardcoded literal.
    const idx = startSrc.indexOf("Register the hook");
    expect(idx).toBeGreaterThan(-1);
    const block = startSrc.slice(idx, idx + 500);
    expect(block).not.toMatch(
      /resolve\s*\(\s*homedir\s*\(\s*\)\s*,\s*["']\.claude["']\s*,\s*["']settings\.json["']\s*\)/,
    );
  });

  test("auto-deployed heal script template honors CLAUDE_CONFIG_DIR at its own runtime", () => {
    // The embedded `healScript` template literal becomes
    // $CLAUDE_CONFIG_DIR/hooks/context-mode-cache-heal.mjs. Its OWN runtime
    // — i.e. when Claude Code spawns it on SessionStart — must also honor
    // CLAUDE_CONFIG_DIR. So the template literal itself has to embed the
    // env-var read; baking the value at start.mjs render time would freeze
    // the heal script to whatever CLAUDE_CONFIG_DIR was set to at install.
    const startOfTpl = startSrc.indexOf("const healScript = `");
    expect(startOfTpl).toBeGreaterThan(-1);
    const endMarker = "writeFileSync(healHookPath, healScript";
    const endIdx = startSrc.indexOf(endMarker, startOfTpl);
    expect(endIdx).toBeGreaterThan(startOfTpl);
    const tpl = startSrc.slice(startOfTpl, endIdx);

    expect(tpl).toContain("CLAUDE_CONFIG_DIR");

    // Embedded resolve() calls inside the template must NOT be the
    // hardcoded ~/.claude form.
    const tplBadForm =
      /resolve\(\s*homedir\(\)\s*,\s*["']\.claude["']\s*,\s*["']plugins["']/;
    expect(tpl).not.toMatch(tplBadForm);
  });
});
