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
import { execSync, execFileSync, spawnSync } from "node:child_process";
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
    const bindingPath = resolve(bsqRoot, "build", "Release", "better_sqlite3.node");
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

    if (!existsSync(bsqRoot)) {
      // ── Package itself missing (#514) ───────────────────────────────
      // npm@7+ silently drops optionalDependencies whose engines field
      // does not match the running Node version (Node 26 vs
      // better-sqlite3@12.x → silent skip, package never written).
      // Even after promoting the package back to dependencies, an
      // existing install where the package directory was previously
      // skipped will still have an empty slot. Take ownership and
      // install the package by name with --no-optional, which forces
      // npm to install the named package even if it would otherwise
      // be filtered out as an optional dep.
      try {
        execFileSync(
          npmBin,
          [
            "install",
            "better-sqlite3",
            "--no-optional",
            "--no-save",
            "--no-audit",
            "--no-fund",
          ],
          {
            cwd: pkgRoot,
            stdio: "pipe",
            timeout: 180000,
            shell: process.platform === "win32",
          },
        );
      } catch {
        // Install failed — surface the cause via the manual-required
        // exit so the caller (cli.ts upgrade verifier) reports it.
        return { healed: false, reason: "package-missing" };
      }
      // Re-check after install. If npm wrote the package AND its
      // postinstall produced the binding, we're done. Otherwise fall
      // through into the binding-missing flow below.
      if (existsSync(bindingPath)) {
        return { healed: true, reason: "package-installed" };
      }
      if (!existsSync(bsqRoot)) {
        // npm reported success but the directory is still absent.
        // This indicates the engine-mismatch silent-skip is still in
        // effect (e.g. npm < 7 or pnpm without --shamefully-hoist).
        return { healed: false, reason: "package-missing" };
      }
      // Package present but binding still missing — recurse into
      // the existing 3-layer heal that owns prebuild-install / npm
      // install / actionable-stderr.
    }

    if (existsSync(bindingPath)) {
      return { healed: true, reason: "binding-present" };
    }

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
