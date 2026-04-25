/**
 * Shared dependency bootstrap for hooks and start.mjs.
 *
 * Single source of truth — ensures native deps (better-sqlite3) are
 * installed in the plugin cache before any hook or server code runs.
 *
 * Pattern: same as suppress-stderr.mjs — imported at the top of every
 * hook that needs native modules. Fast path: existsSync check (~0.1ms).
 * Slow path: npm install (first run only, ~5-30s).
 *
 * Also handles ABI compatibility (#148, #203): when the current Node.js
 * version differs from the one better-sqlite3 was compiled against,
 * automatically swaps in a cached binary or rebuilds. This protects
 * both the MCP server AND hooks from ABI mismatch crashes when users
 * have multiple Node versions via mise/volta/fnm/nvm.
 *
 * @see https://github.com/mksglu/context-mode/issues/148
 * @see https://github.com/mksglu/context-mode/issues/172
 * @see https://github.com/mksglu/context-mode/issues/203
 */

import { existsSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const NATIVE_DEPS = ["better-sqlite3"];
const NATIVE_BINARIES = {
  "better-sqlite3": ["build", "Release", "better_sqlite3.node"],
};

/**
 * Check if the current runtime has built-in SQLite support, making
 * better-sqlite3 unnecessary. Bun has bun:sqlite, Node >= 22.5 has node:sqlite.
 * When true, skip the entire better-sqlite3 bootstrap to avoid SIGSEGV
 * coredumps on Node v24 (#331) and unnecessary install overhead.
 */
function hasModernSqlite() {
  if (typeof globalThis.Bun !== "undefined") return true;
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

export function ensureDeps() {
  if (hasModernSqlite()) return;
  for (const pkg of NATIVE_DEPS) {
    const pkgDir = resolve(root, "node_modules", pkg);
    if (!existsSync(pkgDir)) {
      // Package not installed at all
      try {
        execSync(`npm install ${pkg} --no-package-lock --no-save --silent`, {
          cwd: root,
          stdio: "pipe",
          timeout: 120000,
        });
      } catch { /* best effort — hook degrades gracefully without DB */ }
    } else if (!existsSync(resolve(pkgDir, ...NATIVE_BINARIES[pkg]))) {
      // Package installed but native binary missing (e.g., npm ignore-scripts=true)
      try {
        execSync(`npm rebuild ${pkg} --ignore-scripts=false`, {
          cwd: root,
          stdio: "pipe",
          timeout: 120000,
        });
      } catch { /* best effort — hook degrades gracefully without DB */ }
    }
  }
}

/**
 * Probe-load better-sqlite3 in a child process to verify the binary on disk
 * is compatible with the current Node ABI. In-process require() caches native
 * modules at the dlopen level, so it can't detect on-disk binary changes.
 * A child process gets a fresh dlopen cache.
 *
 * Note: require('better-sqlite3') only loads the JS wrapper — the native
 * binary is lazy-loaded when instantiating a Database. We must create an
 * in-memory DB to actually trigger dlopen.
 */
function probeNativeInChildProcess(pluginRoot) {
  try {
    execSync(`node -e "new (require('better-sqlite3'))(':memory:').close()"`, {
      cwd: pluginRoot,
      stdio: "pipe",
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

export function ensureNativeCompat(pluginRoot) {
  if (hasModernSqlite()) return;
  try {
    const abi = process.versions.modules;
    const nativeDir = resolve(pluginRoot, "node_modules", "better-sqlite3", "build", "Release");
    const binaryPath = resolve(nativeDir, "better_sqlite3.node");
    const abiCachePath = resolve(nativeDir, `better_sqlite3.abi${abi}.node`);

    if (!existsSync(nativeDir)) return;

    // Fast path: cached binary for this ABI already exists — swap in and verify
    if (existsSync(abiCachePath)) {
      copyFileSync(abiCachePath, binaryPath);
      codesignBinary(binaryPath);
      // Validate via child process — dlopen cache is per-process, so in-process
      // require() can't detect a swapped binary on disk (#148)
      if (probeNativeInChildProcess(pluginRoot)) {
        return; // Cache hit validated
      }
      // Cached binary is stale/corrupt — fall through to rebuild
    }

    // Probe: try loading better-sqlite3 with current Node
    if (existsSync(binaryPath) && probeNativeInChildProcess(pluginRoot)) {
      // Load succeeded — cache the working binary for this ABI
      copyFileSync(binaryPath, abiCachePath);
    } else {
      // ABI mismatch or missing native binary — rebuild for current Node version
      execSync("npm rebuild better-sqlite3 --ignore-scripts=false", {
        cwd: pluginRoot,
        stdio: "pipe",
        timeout: 60000,
      });
      codesignBinary(binaryPath);
      if (existsSync(binaryPath) && probeNativeInChildProcess(pluginRoot)) {
        copyFileSync(binaryPath, abiCachePath);
      }
    }
  } catch {
    /* best effort — caller will report the error on first DB access */
  }
}

/**
 * Ad-hoc codesign a native binary on macOS.
 *
 * When a cached .node binary is copied over the active one, macOS hardened
 * runtime (e.g. Zed, VS Code with runtime hardening) will SIGKILL the
 * process on the next dlopen because the code signature is invalidated.
 * SIGKILL is uncatchable — the only fix is to re-sign after the copy.
 *
 * No-op on non-macOS. Swallows errors (codesign may not be available in
 * all environments, e.g. Docker containers).
 */
export function codesignBinary(binaryPath) {
  if (process.platform === "darwin") {
    try {
      execSync(`codesign --sign - --force "${binaryPath}"`, {
        stdio: "pipe",
        timeout: 10000,
      });
    } catch { /* codesign unavailable — continue without signing */ }
  }
}

// Auto-run on import (like suppress-stderr.mjs)
ensureDeps();
ensureNativeCompat(root);
