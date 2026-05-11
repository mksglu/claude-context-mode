/**
 * Self-heal `~/.claude/plugins/installed_plugins.json` (#46915 follow-up).
 *
 * v1.0.113's `/ctx-upgrade` poisoned this file in two ways:
 *   1. Per-entry `version` drifted from the actual cache directory's
 *      `plugin.json` version.
 *   2. The top-level `enabledPlugins[<key>]` was emptied (or never set)
 *      so Claude Code's plugin loader skipped context-mode → MCP died.
 *
 * Single source of truth shared by:
 *   - `start.mjs` HEAL 3+4 (every MCP boot)
 *   - `scripts/postinstall.mjs` (every `npm install -g context-mode`)
 *
 * Pure Node.js (built-ins only). Best-effort: never throws, always
 * returns a plain result object so callers can log a one-liner.
 *
 * @see https://github.com/anthropics/claude-code/issues/46915
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * @typedef {Object} HealResult
 * @property {string[]} healed - one of: "entry-version", "enabled-plugins"
 * @property {string} [skipped] - reason if no work performed
 * @property {string} [error] - error message if heal aborted
 */

/**
 * Heal a single plugin entry inside installed_plugins.json.
 *
 * @param {{
 *   registryPath: string,
 *   pluginCacheRoot: string,
 *   pluginKey: string,
 * }} opts
 * @returns {HealResult}
 */
export function healInstalledPlugins({ registryPath, pluginCacheRoot, pluginKey }) {
  if (!registryPath || !existsSync(registryPath)) {
    return { healed: [], skipped: "no-registry" };
  }

  let raw;
  try {
    raw = readFileSync(registryPath, "utf-8");
  } catch (err) {
    return { healed: [], error: `read-failed: ${(err && err.message) || err}` };
  }

  let ip;
  try {
    ip = JSON.parse(raw);
  } catch (err) {
    return { healed: [], error: `parse-failed: ${(err && err.message) || err}` };
  }
  if (!ip || typeof ip !== "object") {
    return { healed: [], error: "bad-shape" };
  }

  const entries = (ip.plugins && ip.plugins[pluginKey]) || [];
  if (!Array.isArray(entries) || entries.length === 0) {
    return { healed: [], skipped: "no-entry" };
  }

  /** @type {string[]} */
  const healed = [];
  let syncedVersion = null;

  // ── HEAL 3: per-entry version <- cache plugin.json version ──
  // We trust the cache directory because that's what start.mjs actually
  // boots from; the registry is just a stale label.
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const installPath = entry.installPath;
    if (!installPath || typeof installPath !== "string") continue;

    // Path-traversal guard: only consult plugin.json files inside the
    // declared plugin cache root.
    const resolvedInstall = resolve(installPath);
    const cacheRootWithSep = resolve(pluginCacheRoot) + sep;
    if (!resolvedInstall.startsWith(cacheRootWithSep)) continue;

    const cachePluginJson = resolve(installPath, ".claude-plugin", "plugin.json");
    if (!existsSync(cachePluginJson)) continue;
    let actualVersion = null;
    try {
      const pj = JSON.parse(readFileSync(cachePluginJson, "utf-8"));
      if (pj && typeof pj.version === "string" && pj.version) {
        actualVersion = pj.version;
      }
    } catch {
      continue;
    }
    if (!actualVersion) continue;

    syncedVersion = actualVersion;
    if (entry.version !== actualVersion) {
      entry.version = actualVersion;
      if (!healed.includes("entry-version")) healed.push("entry-version");
    }
  }

  // ── HEAL 4: top-level enabledPlugins[key] presence ──
  // Claude Code's plugin loader checks enabledPlugins. When /ctx-upgrade
  // emptied it, our plugin was silently disabled. Set it to `true` (the
  // simplest enabled-flag form) when missing or falsy.
  if (syncedVersion) {
    if (!ip.enabledPlugins || typeof ip.enabledPlugins !== "object" || Array.isArray(ip.enabledPlugins)) {
      ip.enabledPlugins = {};
    }
    const current = ip.enabledPlugins[pluginKey];
    if (current === undefined || current === null || current === false || current === "") {
      ip.enabledPlugins[pluginKey] = true;
      healed.push("enabled-plugins");
    }
  }

  if (healed.length > 0) {
    try {
      writeFileSync(registryPath, JSON.stringify(ip, null, 2) + "\n", "utf-8");
    } catch (err) {
      return { healed: [], error: `write-failed: ${(err && err.message) || err}` };
    }
  }

  return { healed };
}

/**
 * Heal `~/.claude/settings.json.enabledPlugins[pluginKey]`.
 *
 * v1.0.114's heal targeted `installed_plugins.json.enabledPlugins`, which is
 * what we control. But Claude Code's plugin loader actually reads the truth
 * from `settings.json.enabledPlugins`. After every `/ctx-upgrade`, Claude
 * Code's plugin manager seems to clear the settings.json key (likely on
 * version-mismatch detection), so the plugin appears disabled even though
 * `installed_plugins.json` is fully consistent. v1.0.116 closes that gap.
 *
 * Respects explicit user opt-out: if the key is `false`, leaves it alone.
 *
 * @param {{ settingsPath: string, pluginKey: string }} opts
 * @returns {HealResult}
 */
export function healSettingsEnabledPlugins({ settingsPath, pluginKey }) {
  if (!settingsPath || !existsSync(settingsPath)) {
    return { healed: [], skipped: "no-settings" };
  }

  let raw;
  try { raw = readFileSync(settingsPath, "utf-8"); }
  catch (err) { return { healed: [], error: `read-failed: ${(err && err.message) || err}` }; }

  let settings;
  try { settings = JSON.parse(raw); }
  catch (err) { return { healed: [], error: `parse-failed: ${(err && err.message) || err}` }; }

  const healed = [];
  if (!settings.enabledPlugins || typeof settings.enabledPlugins !== "object" || Array.isArray(settings.enabledPlugins)) {
    settings.enabledPlugins = {};
  }
  const current = settings.enabledPlugins[pluginKey];
  if (current === false) {
    return { healed: [], skipped: "explicit-opt-out" };
  }
  if (current !== true) {
    settings.enabledPlugins[pluginKey] = true;
    healed.push("enabled-plugins");
  }

  if (healed.length > 0) {
    try {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    } catch (err) {
      return { healed: [], error: `write-failed: ${(err && err.message) || err}` };
    }
  }

  return { healed };
}

// ─────────────────────────────────────────────────────────────────────────
// Issue #523 (v1.0.119) — Layer 5 heal: plugin.json mcpServers args
//
// /ctx-upgrade in v1.0.118 wrote `.mcp.json` with the literal
// `${CLAUDE_PLUGIN_ROOT}` placeholder (#411) but did NOT touch
// `.claude-plugin/plugin.json`. On Windows, start.mjs's `normalizeHooksOnStartup`
// (#378) rewrites that file's `mcpServers["context-mode"].args[0]` to an
// absolute path. If `pluginRoot` happens to be the upgrade tmpdir at the time
// of normalization (or an earlier upgrade left absolute paths in place), the
// resulting plugin.json carries a `<tmpdir>/context-mode-upgrade-<epoch>/start.mjs`
// path. After Node tmpdir cleanup, MCP fails to spawn with ENOENT and the user
// has no /ctx-upgrade escape hatch.
//
// This heal is the sibling of #411's `.mcp.json` fix:
//   - Detects tmpdir-prefixed args[0] (epoch-pattern, OS-agnostic)
//   - Rewrites to literal `${CLAUDE_PLUGIN_ROOT}/start.mjs` placeholder
//   - Never touches sibling mcpServers entries (only `pluginKey`'s server)
//   - Refuses to write outside `pluginCacheRoot` (path-traversal guard)
//
// Single source of truth shared by:
//   - `start.mjs` HEAL 5b (every MCP boot)
//   - `scripts/postinstall.mjs` (every `npm install -g context-mode`)
//   - `src/cli.ts` upgrade() (post-bump)
// ─────────────────────────────────────────────────────────────────────────

/** Matches `<sep>context-mode-upgrade-<digits><sep>`. OS-agnostic. */
const TMPDIR_UPGRADE_RE = /[/\\]context-mode-upgrade-\d+[/\\]/;
const PLACEHOLDER_ARG = "${CLAUDE_PLUGIN_ROOT}/start.mjs";

/**
 * Heal `<pluginRoot>/.claude-plugin/plugin.json` mcpServers args.
 *
 * @param {{
 *   pluginRoot: string,
 *   pluginCacheRoot: string,
 *   pluginKey: string,
 * }} opts
 * @returns {HealResult}
 */
export function healPluginJsonMcpServers({ pluginRoot, pluginCacheRoot, pluginKey }) {
  if (!pluginRoot || !pluginCacheRoot || !pluginKey) {
    return { healed: [], skipped: "missing-args" };
  }

  // Path-traversal guard: refuse to touch a plugin root that escapes the
  // declared cache root. Mirrors HEAL 3's guard.
  const resolvedRoot = resolve(pluginRoot);
  const cacheRootWithSep = resolve(pluginCacheRoot) + sep;
  if (!resolvedRoot.startsWith(cacheRootWithSep)) {
    return { healed: [], skipped: "outside-cache-root" };
  }

  const pluginJsonPath = resolve(pluginRoot, ".claude-plugin", "plugin.json");
  if (!existsSync(pluginJsonPath)) {
    return { healed: [], skipped: "no-plugin-json" };
  }

  let raw;
  try { raw = readFileSync(pluginJsonPath, "utf-8"); }
  catch (err) { return { healed: [], error: `read-failed: ${(err && err.message) || err}` }; }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { return { healed: [], error: `parse-failed: ${(err && err.message) || err}` }; }

  const servers = parsed && parsed.mcpServers;
  if (!servers || typeof servers !== "object") {
    return { healed: [], skipped: "no-mcp-servers" };
  }

  // Derive our server name from pluginKey ("context-mode@context-mode" → "context-mode").
  const ourServerName = pluginKey.split("@")[0];
  const ours = servers[ourServerName];
  if (!ours || typeof ours !== "object" || !Array.isArray(ours.args)) {
    return { healed: [], skipped: "no-our-server" };
  }

  /** @type {string[]} */
  const healed = [];
  const before = ours.args;
  const after = before.map((a) => {
    if (typeof a !== "string") return a;
    // Detect tmpdir-prefixed `context-mode-upgrade-<digits>` paths and
    // rewrite to the literal placeholder that survives upgrades. Only
    // rewrites when the trailing component is `start.mjs` (our entrypoint).
    if (TMPDIR_UPGRADE_RE.test(a) && /[/\\]start\.mjs$/.test(a)) {
      return PLACEHOLDER_ARG;
    }
    return a;
  });
  const changed = after.some((v, i) => v !== before[i]);
  if (changed) {
    ours.args = after;
    healed.push("plugin-json-args");
    try {
      writeFileSync(pluginJsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    } catch (err) {
      return { healed: [], error: `write-failed: ${(err && err.message) || err}` };
    }
  }

  return { healed };
}
