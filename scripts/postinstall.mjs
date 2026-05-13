#!/usr/bin/env node
/**
 * postinstall — cross-platform post-install tasks
 *
 * 1. OpenClaw detection (print helper message)
 * 2. Windows global install: fix broken bin→node_modules path
 *    when nvm4w places the shim and node_modules in different directories.
 *    Creates a directory junction so npm's %~dp0\node_modules\... resolves.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { healBetterSqlite3Binding } from "./heal-better-sqlite3.mjs";
import { healInstalledPlugins, healSettingsEnabledPlugins, healPluginJsonMcpServers, healMcpJsonArgs } from "./heal-installed-plugins.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

/**
 * True when running as a real `npm install -g context-mode`. We use this
 * to keep contributors' local `npm install` runs from rewriting their HOME's
 * Claude Code registry (would be very surprising during dev).
 *
 * Heuristic: npm sets `npm_config_global=true` for global installs AND the
 * package directory has no nearby `.git` (a contributor's clone always
 * does). Both signals must agree.
 */
function isGlobalInstall() {
  if (process.env.npm_config_global !== "true") return false;
  // Walk up a few levels looking for .git — contributors always have one.
  let dir = pkgRoot;
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, ".git"))) return false;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return true;
}

/**
 * Validate that a path is safe to interpolate into a cmd.exe command.
 * Rejects characters that could enable command injection via cmd.exe.
 */
function isSafeWindowsPath(p) {
  return !/[&|<>"^%\r\n]/.test(p);
}

// ── -1. v1.0.114 hotfix — installed_plugins.json registry repair ─────
// /ctx-upgrade in v1.0.113 poisoned the registry (entry.version drifted
// + enabledPlugins emptied), making Claude Code's plugin loader skip
// context-mode entirely. start.mjs HEAL 3+4 fix this on every MCP boot,
// but already-broken users have no MCP to boot — they need the heal to
// run from npm postinstall. Shared module so both call sites stay in
// sync. Only runs in real `npm install -g` to avoid surprising
// contributors. Best effort, never blocks install. (#46915 follow-up.)
if (isGlobalInstall()) {
  try {
    const registryPath = resolve(homedir(), ".claude", "plugins", "installed_plugins.json");
    const pluginCacheRoot = resolve(homedir(), ".claude", "plugins", "cache");
    const result = healInstalledPlugins({
      registryPath,
      pluginCacheRoot,
      pluginKey: "context-mode@context-mode",
    });
    if (result.skipped === "no-registry") {
      // Standalone npm user (no Claude Code) — silent success.
      process.stderr.write("context-mode: install OK, no Claude Code registry found\n");
    } else if (result.error) {
      process.stderr.write(`context-mode: install OK, registry heal skipped (${result.error})\n`);
    } else if (result.healed && result.healed.length > 0) {
      process.stderr.write(`context-mode: healed installed_plugins.json (${result.healed.join(", ")})\n`);
    } else {
      process.stderr.write("context-mode: install OK, no heal needed\n");
    }
  } catch (err) {
    // Never block install on a heal failure.
    try {
      process.stderr.write(`context-mode: install OK, heal aborted (${(err && err.message) || err})\n`);
    } catch { /* truly best effort */ }
  }

  // v1.0.116: also heal settings.json.enabledPlugins (the file Claude Code's
  // plugin loader actually reads). v1.0.114 only touched installed_plugins.json.
  try {
    const settingsPath = resolve(homedir(), ".claude", "settings.json");
    const r = healSettingsEnabledPlugins({
      settingsPath,
      pluginKey: "context-mode@context-mode",
    });
    if (r.healed && r.healed.length > 0) {
      process.stderr.write(`context-mode: healed settings.json (${r.healed.join(", ")})\n`);
    }
    // skipped/error: silent — already covered by the prior heal's stderr line.
  } catch { /* never block install */ }

  // v1.0.119: Layer 5b (Issue #523). Heal .claude-plugin/plugin.json's
  // mcpServers["context-mode"].args[0] when /ctx-upgrade left a tmpdir-prefixed
  // path baked in. Iterates EVERY installed cache entry's installPath so
  // already-broken users self-recover the next time `npm install -g context-mode`
  // runs. Best effort, never blocks install.
  try {
    const ipPath = resolve(homedir(), ".claude", "plugins", "installed_plugins.json");
    const cacheRoot = resolve(homedir(), ".claude", "plugins", "cache");
    if (existsSync(ipPath)) {
      const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
      const entries = (ip && ip.plugins && ip.plugins["context-mode@context-mode"]) || [];
      let healedAny = false;
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const installPath = entry && entry.installPath;
          if (typeof installPath !== "string" || !installPath) continue;
          try {
            const r = healPluginJsonMcpServers({
              pluginRoot: installPath,
              pluginCacheRoot: cacheRoot,
              pluginKey: "context-mode@context-mode",
            });
            if (r && Array.isArray(r.healed) && r.healed.length > 0) {
              healedAny = true;
            }
          } catch { /* per-entry best effort */ }
          // v1.0.122 — Issue #531 — Layer 6: asymmetric-heal sibling for
          // .mcp.json. The #253/aea633c regression shipped a bare `./start.mjs`
          // arg that Claude Code resolves against session CWD (not pluginRoot)
          // → MODULE_NOT_FOUND on every ctx_* tool. When MCP is dead, the
          // only escape hatch is `npm install -g context-mode` whose
          // postinstall MUST run this heal too.
          try {
            const r = healMcpJsonArgs({
              pluginRoot: installPath,
              pluginCacheRoot: cacheRoot,
              pluginKey: "context-mode@context-mode",
            });
            if (r && Array.isArray(r.healed) && r.healed.length > 0) {
              healedAny = true;
            }
          } catch { /* per-entry best effort */ }
        }
      }
      if (healedAny) {
        process.stderr.write("context-mode: healed mcpServers args (Issues #523 + #531)\n");
      }
    }
  } catch { /* never block install */ }
}

// ── 0. Self-heal Layer 3: Backward symlink for stale registry (anthropics/claude-code#46915) ──
// When this install completes, installed_plugins.json may still point to an old
// non-existent path. Create a symlink from that old path → our new directory.
try {
  const ipPath = resolve(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (existsSync(ipPath)) {
    const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
    const cacheRoot = resolve(homedir(), ".claude", "plugins", "cache");
    for (const [key, entries] of Object.entries(ip.plugins || {})) {
      if (key !== "context-mode@context-mode") continue;
      for (const entry of entries) {
        const rp = entry.installPath;
        if (!rp || existsSync(rp)) continue;
        // Path traversal guard
        if (!resolve(rp).startsWith(cacheRoot + sep)) continue;
        // Remove dangling symlink
        try { if (lstatSync(rp).isSymbolicLink()) unlinkSync(rp); } catch {}
        const rpParent = dirname(rp);
        if (!existsSync(rpParent)) mkdirSync(rpParent, { recursive: true });
        try {
          symlinkSync(pkgRoot, rp, process.platform === "win32" ? "junction" : undefined);
        } catch { /* may fail if path is locked or permissions */ }
      }
    }
  }
} catch { /* best effort — don't block install */ }

// ── 1. OpenClaw detection ────────────────────────────────────────────
if (process.env.OPENCLAW_STATE_DIR) {
  console.log("\n  OpenClaw detected. Run: npm run install:openclaw\n");
}

// ── 2. Windows global install — nvm4w junction fix ───────────────────
// npm's .cmd shim resolves modules via %~dp0\node_modules\<pkg>\...
// On nvm4w the shim lives at C:\nvm4w\nodejs\ but node_modules is at
// C:\Users\<USER>\AppData\Roaming\npm\node_modules\. The relative path
// breaks because they're on different prefixes.
//
// Fix: detect the mismatch and create a directory junction so the shim
// can reach us through the expected relative path.

if (process.platform === "win32" && process.env.npm_config_global === "true") {
  try {
    // npm prefix is where both the .cmd shims and node_modules live
    // Use npm_config_prefix env (set during install) or fall back to `npm config get prefix`
    // Note: `npm bin -g` was removed in npm v9+, so we use prefix instead
    const prefix = (
      process.env.npm_config_prefix ||
      execSync("npm config get prefix", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
    );

    const actualPkgDir = pkgRoot;

    // npm's .cmd shim uses %~dp0\node_modules\<pkg>\... to find the entry point.
    // On nvm4w, stale shims at C:\nvm4w\nodejs\ may exist alongside correct ones
    // at the npm prefix. We create junctions at ALL known shim locations.
    const shimDirs = new Set([prefix]);

    // Detect stale shim locations via `where` command
    try {
      const whereOutput = execSync("where context-mode.cmd", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      for (const line of whereOutput.split(/\r?\n/)) {
        if (line.endsWith("context-mode.cmd")) {
          shimDirs.add(dirname(line));
        }
      }
    } catch { /* where may fail if not installed yet */ }

    for (const shimDir of shimDirs) {
      const expectedPkgDir = join(shimDir, "node_modules", "context-mode");

      if (
        resolve(expectedPkgDir).toLowerCase() !== resolve(actualPkgDir).toLowerCase() &&
        !existsSync(expectedPkgDir)
      ) {
        const expectedNodeModules = join(shimDir, "node_modules");
        if (!existsSync(expectedNodeModules)) {
          mkdirSync(expectedNodeModules, { recursive: true });
        }

        // Create directory junction (no admin privileges needed on Windows 10+)
        // Validate paths to prevent cmd.exe injection via shell metacharacters
        if (!isSafeWindowsPath(expectedPkgDir) || !isSafeWindowsPath(actualPkgDir)) {
          console.warn(`  context-mode: skipping junction — path contains unsafe characters`);
        } else {
          execSync(`mklink /J "${expectedPkgDir}" "${actualPkgDir}"`, {
            shell: "cmd.exe",
            stdio: "pipe",
          });
          console.log(`\n  context-mode: created junction for nvm4w compatibility`);
          console.log(`    ${expectedPkgDir} → ${actualPkgDir}\n`);
        }
      }
    }

    // Also fix stale shims that reference old bin entry (build/cli.js → cli.bundle.mjs)
    try {
      const whereOutput = execSync("where context-mode.cmd", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      for (const line of whereOutput.split(/\r?\n/)) {
        if (line.endsWith("context-mode.cmd")) {
          const content = readFileSync(line, "utf-8");
          if (content.includes("build\\cli.js") || content.includes("build/cli.js")) {
            // Rewrite stale shim to use cli.bundle.mjs
            const fixed = content
              .replace(/build[\\\/]cli\.js/g, "cli.bundle.mjs");
            writeFileSync(line, fixed);
            console.log(`  context-mode: fixed stale shim at ${line}`);
          }
        }
      }
    } catch { /* best effort */ }
  } catch {
    // Best effort — don't block install. User can use npx as fallback.
  }
}

// ── 3. Native binding self-heal — better-sqlite3 (#408) ──────────────
// On Windows, `npm rebuild` falls through to node-gyp without MSVC; bypass
// that by spawning prebuild-install directly. Cross-platform safety net —
// the binding can also go missing on macOS/Linux when prebuilds are stale
// or the install was interrupted.
//
// Logic lives in scripts/heal-better-sqlite3.mjs (shared with
// hooks/ensure-deps.mjs so there's one source of truth).
try { healBetterSqlite3Binding(pkgRoot); } catch { /* best effort — don't block install */ }

// ── 4. Hook normalization at install time (#414) ─────────────────────
// hooks/hooks.json + .claude-plugin/plugin.json ship with `${CLAUDE_PLUGIN_ROOT}`
// + bare `node` command. On Windows + Claude Code that combination triggers
// `cjs/loader:1479 MODULE_NOT_FOUND` (placeholder mangling, MSYS path issues,
// PATH lookup failure). start.mjs normalizes on every MCP boot, but normalizing
// here too closes the gap for the very first hook fire after a fresh install
// (before any MCP server has run).
//
// Guard 1: only run on REAL `npm install -g context-mode`. A contributor's
// `npm install` from a git clone (or CI checkout) must NOT mutate the
// source-tracked `.claude-plugin/plugin.json` — doing so substitutes the
// literal `${CLAUDE_PLUGIN_ROOT}` with an absolute path and trips
// `scripts/assert-asymmetric-drift.mjs` (Issue #531) in the build chain.
// Reuses `isGlobalInstall()` (section -1 already gates that way); the
// `.git` walk inside it is what keeps contributor / CI installs untouched.
//
// Guard 2: /ctx-upgrade clones the repo to `<tmpdir>/context-mode-upgrade-<epoch>/`
// and runs `npm install` there before `cpSync`-ing files into the real pluginRoot
// (src/cli.ts). The tmpdir has no `.git`, so `isGlobalInstall()` returns
// true there — we need this second check to skip the staging dir. Without
// it, pkgRoot is the tmpdir → hooks.json gets the tmpdir's absolute paths
// baked in → cpSync copies that poisoned hooks.json into the real plugin
// dir → tmpdir is later cleaned → every hook fires with MODULE_NOT_FOUND.
// start.mjs normalizes correctly on the next MCP boot from the real
// pluginRoot anyway.
const TMPDIR_UPGRADE_RE = /[/\\]context-mode-upgrade-\d+[/\\]?$/;
if (isGlobalInstall() && !TMPDIR_UPGRADE_RE.test(pkgRoot)) {
  try {
    const { normalizeHooksOnStartup } = await import("../hooks/normalize-hooks.mjs");
    normalizeHooksOnStartup({
      pluginRoot: pkgRoot,
      nodePath: process.execPath,
      platform: process.platform,
    });
  } catch { /* best effort — never block install */ }
}
