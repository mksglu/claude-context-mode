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
