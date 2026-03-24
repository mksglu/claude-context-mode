#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, copyFileSync, chmodSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createRequire } from "node:module";

/**
 * ABI-aware native binary caching for better-sqlite3 (#148).
 * Users with mise/asdf may run concurrent sessions with different Node versions.
 * Each ABI needs its own compiled binary — cache them side-by-side.
 */
function ensureNativeCompat(pluginRoot) {
  try {
    const abi = process.versions.modules;
    const nativeDir = resolve(pluginRoot, "node_modules", "better-sqlite3", "build", "Release");
    const binaryPath = resolve(nativeDir, "better_sqlite3.node");
    const abiCachePath = resolve(nativeDir, `better_sqlite3.abi${abi}.node`);

    if (!existsSync(nativeDir)) return;

    if (existsSync(abiCachePath)) {
      copyFileSync(abiCachePath, binaryPath);
      return;
    }

    if (!existsSync(binaryPath)) return;

    try {
      const req = createRequire(resolve(pluginRoot, "package.json"));
      req("better-sqlite3");
      copyFileSync(binaryPath, abiCachePath);
    } catch (probeErr) {
      if (probeErr?.message?.includes("NODE_MODULE_VERSION")) {
        execSync("npm rebuild better-sqlite3", {
          cwd: pluginRoot,
          stdio: "pipe",
          timeout: 60000,
        });
        if (existsSync(binaryPath)) {
          copyFileSync(binaryPath, abiCachePath);
        }
      }
    }
  } catch {
    /* best effort — server will report the error on first DB access */
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const originalCwd = process.cwd();
process.chdir(__dirname);

if (!process.env.CLAUDE_PROJECT_DIR) {
  process.env.CLAUDE_PROJECT_DIR = originalCwd;
}

// Routing instructions file auto-write DISABLED for all platforms (#158, #164).
// Env vars like CLAUDE_SESSION_ID may not be set at MCP startup time, making
// the hook-capability guard unreliable. Writing to project dirs dirties git trees
// and causes double context injection on hook-capable platforms.
// Routing is handled by:
//   - Hook-capable platforms: SessionStart hook injects ROUTING_BLOCK
//   - Non-hook platforms: server.ts writeRoutingInstructions() on MCP connect
//   - Future: explicit `context-mode init` command

// Self-heal: if a newer version dir exists, update registry so next session uses it
const cacheMatch = __dirname.match(
  /^(.*[\/\\]plugins[\/\\]cache[\/\\][^\/\\]+[\/\\][^\/\\]+[\/\\])([^\/\\]+)$/,
);
if (cacheMatch) {
  try {
    const cacheParent = cacheMatch[1];
    const myVersion = cacheMatch[2];
    const dirs = readdirSync(cacheParent).filter((d) =>
      /^\d+\.\d+\.\d+/.test(d),
    );
    if (dirs.length > 1) {
      dirs.sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if ((pa[i] ?? 0) !== (pb[i] ?? 0))
            return (pa[i] ?? 0) - (pb[i] ?? 0);
        }
        return 0;
      });
      const newest = dirs[dirs.length - 1];
      if (newest && newest !== myVersion) {
        const ipPath = resolve(
          homedir(),
          ".claude",
          "plugins",
          "installed_plugins.json",
        );
        const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
        for (const [key, entries] of Object.entries(ip.plugins || {})) {
          if (!key.toLowerCase().includes("context-mode")) continue;
          for (const entry of entries) {
            entry.installPath = resolve(cacheParent, newest);
            entry.version = newest;
            entry.lastUpdated = new Date().toISOString();
          }
        }
        writeFileSync(
          ipPath,
          JSON.stringify(ip, null, 2) + "\n",
          "utf-8",
        );
      }
    }
  } catch {
    /* best effort — don't block server startup */
  }
}

// Ensure native dependencies are available (shared with hooks via ensure-deps.mjs)
import { ensureDeps } from "./hooks/ensure-deps.mjs";
// ensure-deps handles better-sqlite3; also install pure-JS deps used by server
for (const pkg of ["turndown", "turndown-plugin-gfm", "@mixmark-io/domino"]) {
  if (!existsSync(resolve(__dirname, "node_modules", pkg))) {
    try {
      execSync(`npm install ${pkg} --no-package-lock --no-save --silent`, {
        cwd: __dirname,
        stdio: "pipe",
        timeout: 120000,
      });
    } catch { /* best effort */ }
  }
}

// Ensure better-sqlite3 native binary matches current Node.js ABI (#148)
// Users with mise/asdf may run concurrent sessions with different Node versions.
// Each ABI needs its own compiled binary — cache them side-by-side.
ensureNativeCompat(__dirname);

// Self-heal: create CLI shim if cli.bundle.mjs is missing (marketplace installs)
if (!existsSync(resolve(__dirname, "cli.bundle.mjs")) && existsSync(resolve(__dirname, "build", "cli.js"))) {
  const shimPath = resolve(__dirname, "cli.bundle.mjs");
  writeFileSync(shimPath, '#!/usr/bin/env node\nawait import("./build/cli.js");\n');
  if (process.platform !== "win32") chmodSync(shimPath, 0o755);
}

// Bundle exists (CI-built) — start instantly
if (existsSync(resolve(__dirname, "server.bundle.mjs"))) {
  await import("./server.bundle.mjs");
} else {
  // Dev or npm install — full build
  if (!existsSync(resolve(__dirname, "node_modules"))) {
    try {
      execSync("npm install --silent", { cwd: __dirname, stdio: "pipe", timeout: 60000 });
    } catch { /* best effort */ }
  }
  if (!existsSync(resolve(__dirname, "build", "server.js"))) {
    try {
      execSync("npx tsc --silent", { cwd: __dirname, stdio: "pipe", timeout: 30000 });
    } catch { /* best effort */ }
  }
  await import("./build/server.js");
}
