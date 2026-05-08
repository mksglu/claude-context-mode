/**
 * Self-heal a missing better-sqlite3 native binding (#408).
 *
 * Single source of truth for the 3-layer heal used by both
 * `scripts/postinstall.mjs` (install-time) and `hooks/ensure-deps.mjs`
 * (runtime). Keeping one implementation avoids the duplicated logic the
 * maintainer flagged on PR #410.
 *
 * Background:
 *   On Windows, `npm rebuild better-sqlite3` falls through to `node-gyp`
 *   when prebuild-install is not on cmd.exe PATH, then dies for users
 *   without Visual Studio C++ tooling. We bypass that by spawning
 *   prebuild-install JS directly with `process.execPath`.
 *
 * Layered heal:
 *   A. Spawn prebuild-install via process.execPath — bypasses PATH/MSVC.
 *   B. `npm install better-sqlite3` (re-resolves tree, NOT `npm rebuild`).
 *   C. Write actionable stderr message naming `npm install better-sqlite3`
 *      and the Windows / #408 context.
 *
 * Best-effort posture: every layer is wrapped in try/catch and the
 * function never throws. Caller will fail naturally on first DB open if
 * heal could not produce a working binding.
 *
 * @see https://github.com/mksglu/context-mode/issues/408
 */

import { existsSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";

/**
 * Self-heal a missing better_sqlite3.node binding.
 *
 * @param {string} pkgRoot - the directory containing node_modules/better-sqlite3
 * @returns {{ healed: boolean, reason?: string }}
 */
export function healBetterSqlite3Binding(pkgRoot) {
  try {
    const bsqRoot = resolve(pkgRoot, "node_modules", "better-sqlite3");
    if (!existsSync(bsqRoot)) {
      // No package at all — caller (ensure-deps install branch) handles this.
      return { healed: false, reason: "package-missing" };
    }
    const bindingPath = resolve(bsqRoot, "build", "Release", "better_sqlite3.node");
    if (existsSync(bindingPath)) {
      return { healed: true, reason: "binding-present" };
    }

    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

    // ── Layer A: spawn prebuild-install directly via process.execPath ──
    // Bypasses cmd.exe PATH and MSVC requirement.
    try {
      let prebuildBin = null;
      try {
        const req = createRequire(resolve(bsqRoot, "package.json"));
        prebuildBin = req.resolve("prebuild-install/bin");
      } catch { /* fall through to manual walk */ }
      if (!prebuildBin) {
        const candidates = [
          resolve(bsqRoot, "node_modules", "prebuild-install", "bin.js"),
          resolve(pkgRoot, "node_modules", "prebuild-install", "bin.js"),
        ];
        for (const c of candidates) {
          if (existsSync(c)) { prebuildBin = c; break; }
        }
      }
      if (prebuildBin) {
        const r = spawnSync(
          process.execPath,
          [prebuildBin, "--target", process.versions.node, "--runtime", "node"],
          { cwd: bsqRoot, stdio: "pipe", timeout: 120000, env: { ...process.env } },
        );
        if (r.status === 0 && existsSync(bindingPath)) {
          return { healed: true, reason: "prebuild-install" };
        }
      }
    } catch { /* best effort — try Layer B */ }

    // ── Layer B: `npm install better-sqlite3` — NOT `npm rebuild` ──
    // Re-resolves tree and re-runs prebuild-install via the package's
    // own install script. Avoids the rebuild → node-gyp fall-through.
    try {
      execSync(
        `${npmBin} install better-sqlite3 --no-package-lock --no-save --silent`,
        { cwd: pkgRoot, stdio: "pipe", timeout: 120000, shell: true },
      );
      if (existsSync(bindingPath)) {
        return { healed: true, reason: "npm-install" };
      }
    } catch { /* best effort — fall through to Layer C */ }

    // ── Layer C: actionable stderr — give the user a real next step ──
    try {
      process.stderr.write(
        "\n[context-mode] better-sqlite3 native binding could not be installed automatically.\n" +
        "  This is a known issue on Windows when prebuild-install is not on PATH (#408).\n" +
        "  Workaround: run `npm install better-sqlite3` from the plugin directory.\n\n",
      );
    } catch { /* stderr unavailable — give up silently */ }
    return { healed: false, reason: "manual-required" };
  } catch {
    // Outermost guard — never throw, never block the caller.
    return { healed: false, reason: "manual-required" };
  }
}
