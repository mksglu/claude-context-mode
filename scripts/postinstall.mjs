#!/usr/bin/env node
/**
 * postinstall — cross-platform post-install tasks
 *
 * 1. OpenClaw detection (print helper message)
 * 2. Windows global install: fix broken bin→node_modules path
 *    when nvm4w places the shim and node_modules in different directories.
 *    Creates a directory junction so npm's %~dp0\node_modules\... resolves.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

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
    // Where npm puts bin shims (the directory the .cmd lives in)
    const binDir = execSync("npm bin -g", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    // Where our package actually lives
    const actualPkgDir = pkgRoot;
    // Where the .cmd shim expects us to be
    const expectedPkgDir = join(binDir, "node_modules", "context-mode");

    // If shim expects a different path than where we actually are, create a junction
    if (
      resolve(expectedPkgDir).toLowerCase() !== resolve(actualPkgDir).toLowerCase() &&
      !existsSync(expectedPkgDir)
    ) {
      // Ensure parent node_modules dir exists
      const expectedNodeModules = join(binDir, "node_modules");
      if (!existsSync(expectedNodeModules)) {
        mkdirSync(expectedNodeModules, { recursive: true });
      }

      // Create directory junction (no admin privileges needed on Windows 10+)
      execSync(`mklink /J "${expectedPkgDir}" "${actualPkgDir}"`, {
        shell: "cmd.exe",
        stdio: "pipe",
      });
      console.log(`\n  context-mode: created junction for nvm4w compatibility`);
      console.log(`    ${expectedPkgDir} → ${actualPkgDir}\n`);
    }
  } catch {
    // Best effort — don't block install. User can use npx as fallback.
  }
}
