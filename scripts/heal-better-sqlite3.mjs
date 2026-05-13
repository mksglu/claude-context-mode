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
 *   On macOS / Linux, when conda's `python3` is first on PATH (very
 *   common data-science setup), node-gyp picks it up via its `python3`
 *   PATH fallback and fails to build on Node 26 (arm64). We defend by
 *   pinning PYTHON + npm_config_python to a "safe" interpreter and
 *   stripping CONDA_* keys before shelling out to npm / node-gyp (#533).
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
 * @see https://github.com/mksglu/context-mode/issues/533
 */

import { existsSync as fsExistsSync } from "node:fs";
import { execSync, execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";

/**
 * Conda installation path prefixes that must NEVER be selected as the
 * Python interpreter for node-gyp. Conda's Python ships environment
 * activation hooks and a custom site-packages layout that breaks
 * better-sqlite3's native build on Node 26 arm64 (#533).
 */
const CONDA_PATH_PATTERNS = [
  /^\/opt\/anaconda/i,
  /^\/opt\/miniconda/i,
  /\/miniforge\d*\//i,
  /\/anaconda\d*\//i,
  /\/miniconda\d*\//i,
  /\/\.conda\//i,
  /\/conda\//i,
];

/**
 * CONDA_* environment keys that must be stripped from the child env
 * before spawning npm / node-gyp. Even after pinning PYTHON, leaving
 * CONDA_PREFIX intact causes npm lifecycle scripts to re-activate
 * conda's shims via .npmrc / shell rc files.
 */
const CONDA_ENV_KEYS = [
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "CONDA_EXE",
  "CONDA_PROMPT_MODIFIER",
  "CONDA_SHLVL",
  "CONDA_PYTHON_EXE",
];

/**
 * Decide whether a candidate python path is "safe" — i.e. not under
 * any known conda installation prefix.
 *
 * @param {string} candidate - absolute path to a python interpreter
 * @returns {boolean}
 */
function isSafePythonPath(candidate) {
  if (!candidate) return false;
  return !CONDA_PATH_PATTERNS.some((rx) => rx.test(candidate));
}

/**
 * Resolve a "safe" python interpreter that node-gyp can drive without
 * conda activation noise. Pure / side-effect-free / dependency-injected
 * so the unit test can exercise it on any host.
 *
 * Strategy:
 *   - darwin: prefer /usr/bin/python3 (Apple's system Python, ships
 *     with every macOS 10.15+ install). If absent, return null.
 *   - linux:  scan PATH for the first python3 that is not under a
 *     conda prefix. If none, return null.
 *   - win32:  not affected — node-gyp uses the py launcher, not PATH.
 *
 * @param {object} [deps]
 * @param {string} [deps.platform] - process.platform override
 * @param {NodeJS.ProcessEnv} [deps.env] - environment to inspect
 * @param {(p: string) => boolean} [deps.existsSync] - fs probe override
 * @returns {string | null}
 */
export function resolveSafePython({
  platform = process.platform,
  env = process.env,
  existsSync = fsExistsSync,
} = {}) {
  if (platform === "darwin") {
    // Apple-shipped Python is the safe choice — it is outside any
    // conda prefix by definition and node-gyp builds against it
    // cleanly on arm64.
    return existsSync("/usr/bin/python3") ? "/usr/bin/python3" : null;
  }
  if (platform === "linux") {
    const pathEntries = (env.PATH || "").split(":").filter(Boolean);
    for (const dir of pathEntries) {
      const candidate = `${dir}/python3`;
      if (existsSync(candidate) && isSafePythonPath(candidate)) {
        return candidate;
      }
    }
    return null;
  }
  // Windows / other — no override needed.
  return null;
}

/**
 * Detect whether the current environment is conda-activated. Used to
 * decide whether to emit the override breadcrumb (we don't spam stderr
 * for users who never had conda interference).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isCondaActive(env = process.env) {
  if (env.CONDA_PREFIX || env.CONDA_DEFAULT_ENV) return true;
  const pathEntries = (env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  return pathEntries.some((dir) => !isSafePythonPath(dir + "/python3"));
}

/**
 * Build the child-process env for an npm/node-gyp invocation. Pins
 * PYTHON + npm_config_python to the resolved safe interpreter, strips
 * CONDA_* keys, and prepends /usr/bin to PATH on darwin so any
 * downstream PATH-based python3 lookup also resolves to system python.
 *
 * @param {string | null} safePython - output of resolveSafePython()
 * @param {NodeJS.ProcessEnv} [base] - starting env (defaults to process.env)
 * @returns {NodeJS.ProcessEnv}
 */
function buildSafeEnv(safePython, base = process.env) {
  const env = { ...base };
  if (safePython) {
    // node-gyp reads env.PYTHON (see lib/find-python.js — second slot in
    // its `checks` array, before any PATH-based fallback).
    env.PYTHON = safePython;
    // npm passes npm_config_python through to node-gyp as --python,
    // which sits in the FIRST slot of node-gyp's `checks` array — even
    // higher priority than env.PYTHON. Set both for belt-and-suspenders.
    env.npm_config_python = safePython;
  }
  // Wipe every CONDA_* key so npm lifecycle scripts can't re-shim
  // python3 via shell activation hooks.
  for (const key of CONDA_ENV_KEYS) {
    delete env[key];
  }
  // Prepend /usr/bin on darwin so any sub-script that does `python3`
  // unqualified still resolves to /usr/bin/python3.
  if (process.platform === "darwin" && env.PATH) {
    const parts = env.PATH.split(":");
    if (parts[0] !== "/usr/bin") {
      env.PATH = "/usr/bin:" + parts.filter((p) => p !== "/usr/bin").join(":");
    }
  }
  return env;
}

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

    // ── Conda defense (#533) ─────────────────────────────────────────
    // Resolve once up front; reuse across all child spawns. The probe
    // is cheap (one stat call on darwin, a PATH walk on linux).
    const safePython = resolveSafePython();
    const condaActive = isCondaActive();
    const childEnv = buildSafeEnv(safePython, process.env);

    if (condaActive && safePython) {
      // Emit a single breadcrumb so support requests are
      // self-diagnosing. Best-effort: stderr may be unavailable in
      // postinstall captured by npm logs.
      try {
        process.stderr.write(
          `[context-mode] conda python detected on PATH — overriding with ` +
          `PYTHON=${safePython} for better-sqlite3 build (#533).\n`,
        );
      } catch { /* stderr unavailable — proceed silently */ }
    }

    if (!fsExistsSync(bsqRoot)) {
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
      if (condaActive && !safePython) {
        // Conda is active AND we couldn't find a system fallback. The
        // install will almost certainly fail. Surface a distinct reason
        // code so /ctx-upgrade can print conda-specific remediation.
        return { healed: false, reason: "python-conda-blocked" };
      }
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
            env: childEnv,
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
      if (fsExistsSync(bindingPath)) {
        return { healed: true, reason: "package-installed" };
      }
      if (!fsExistsSync(bsqRoot)) {
        // npm reported success but the directory is still absent.
        // This indicates the engine-mismatch silent-skip is still in
        // effect (e.g. npm < 7 or pnpm without --shamefully-hoist).
        return { healed: false, reason: "package-missing" };
      }
      // Package present but binding still missing — recurse into
      // the existing 3-layer heal that owns prebuild-install / npm
      // install / actionable-stderr.
    }

    if (fsExistsSync(bindingPath)) {
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
          if (fsExistsSync(c)) { prebuildBin = c; break; }
        }
      }
      if (prebuildBin) {
        const r = spawnSync(
          process.execPath,
          [prebuildBin, "--target", process.versions.node, "--runtime", "node"],
          { cwd: bsqRoot, stdio: "pipe", timeout: 120000, env: childEnv },
        );
        if (r.status === 0 && fsExistsSync(bindingPath)) {
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
        { cwd: pkgRoot, stdio: "pipe", timeout: 120000, shell: true, env: childEnv },
      );
      if (fsExistsSync(bindingPath)) {
        return { healed: true, reason: "npm-install" };
      }
    } catch { /* best effort — fall through to Layer C */ }

    // ── Layer C: actionable stderr — give the user a real next step ──
    try {
      const condaHint = condaActive && !safePython
        ? "  Conda python detected on PATH and no system /usr/bin/python3 fallback found (#533).\n" +
          "  Deactivate conda (`conda deactivate`) or install system python3, then retry.\n"
        : "";
      process.stderr.write(
        "\n[context-mode] better-sqlite3 native binding could not be installed automatically.\n" +
        "  This is a known issue on Windows when prebuild-install is not on PATH (#408).\n" +
        condaHint +
        "  Workaround: run `npm install better-sqlite3` from the plugin directory.\n\n",
      );
    } catch { /* stderr unavailable — give up silently */ }
    if (condaActive && !safePython) {
      return { healed: false, reason: "python-conda-blocked" };
    }
    return { healed: false, reason: "manual-required" };
  } catch {
    // Outermost guard — never throw, never block the caller.
    return { healed: false, reason: "manual-required" };
  }
}
