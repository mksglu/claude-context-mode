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

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

/**
 * Validate that a path is safe to interpolate into a cmd.exe command.
 * Rejects characters that could enable command injection via cmd.exe.
 */
function isSafeWindowsPath(p) {
  return !/[&|<>"^%\r\n]/.test(p);
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
