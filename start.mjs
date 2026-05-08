#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, chmodSync, readFileSync, writeFileSync, readdirSync, symlinkSync, mkdirSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const originalCwd = process.cwd();
process.chdir(__dirname);

if (!process.env.CLAUDE_PROJECT_DIR) {
  process.env.CLAUDE_PROJECT_DIR = originalCwd;
}

// Platform-agnostic project dir — guaranteed to be set for ALL platforms.
// Adapters may set their own env var (GEMINI_PROJECT_DIR, etc.) but this
// is the universal fallback so server.ts getProjectDir() never relies on cwd().
if (!process.env.CONTEXT_MODE_PROJECT_DIR) {
  process.env.CONTEXT_MODE_PROJECT_DIR = originalCwd;
}

// Routing instructions file auto-write DISABLED for all platforms (#158, #164).
// Env vars like CLAUDE_SESSION_ID may not be set at MCP startup time, making
// the hook-capability guard unreliable. Writing to project dirs dirties git trees
// and causes double context injection on hook-capable platforms.
// Routing is handled by:
//   - Hook-capable platforms: SessionStart hook injects ROUTING_BLOCK
//   - Non-hook platforms: server.ts writeRoutingInstructions() on MCP connect
//   - Future: explicit `context-mode init` command

// ── Self-heal Layer 1: Fix registry → symlink mismatches (anthropics/claude-code#46915) ──
// Claude Code auto-update can leave installed_plugins.json pointing to a non-existent
// directory. We detect this and create symlinks so hooks find the right path.
const cacheMatch = __dirname.match(
  /^(.*[\/\\]plugins[\/\\]cache[\/\\][^\/\\]+[\/\\][^\/\\]+[\/\\])([^\/\\]+)$/,
);
if (cacheMatch) {
  try {
    const cacheParent = cacheMatch[1];
    const myVersion = cacheMatch[2];
    const ipPath = resolve(homedir(), ".claude", "plugins", "installed_plugins.json");

    // Forward heal: if a newer version dir exists, update registry
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
        const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
        for (const [key, entries] of Object.entries(ip.plugins || {})) {
          if (key !== "context-mode@context-mode") continue;
          for (const entry of entries) {
            entry.installPath = resolve(cacheParent, newest);
            entry.version = newest;
            entry.lastUpdated = new Date().toISOString();
          }
        }
        writeFileSync(ipPath, JSON.stringify(ip, null, 2) + "\n", "utf-8");
      }
    }

    // Reverse heal: if registry points to non-existent dir, create symlink to us
    const cacheRoot = resolve(homedir(), ".claude", "plugins", "cache");
    if (existsSync(ipPath)) {
      const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
      for (const [key, entries] of Object.entries(ip.plugins || {})) {
        if (key !== "context-mode@context-mode") continue;
        for (const entry of entries) {
          const rp = entry.installPath;
          if (!rp || existsSync(rp) || rp === __dirname) continue;
          // Path traversal guard: only allow paths inside plugin cache
          if (!resolve(rp).startsWith(cacheRoot + sep)) continue;
          try {
            // Remove dangling symlink before creating new one
            try { if (lstatSync(rp).isSymbolicLink()) unlinkSync(rp); } catch {}
            const rpParent = dirname(rp);
            if (!existsSync(rpParent)) mkdirSync(rpParent, { recursive: true });
            symlinkSync(__dirname, rp, process.platform === "win32" ? "junction" : undefined);
          } catch { /* best effort */ }
        }
      }
    }
  } catch {
    /* best effort — don't block server startup */
  }
}

// ── Self-heal Layer 4: Deploy global SessionStart hook + register in settings.json ──
// This hook lives outside the plugin directory (~/.claude/hooks/) so it works
// even when the plugin cache is completely broken. It creates symlinks for any
// missing plugin cache directories on every session start.
// Pure Node.js — no bash dependency. Works on Windows, macOS (SIP), Linux.
//
// Brew node upgrade resilience:
//   - On Unix we register the hook command as the bare script path. The script
//     itself carries `#!/usr/bin/env node`, so `env` resolves node from PATH at
//     runtime. This survives Brew/asdf/nvm upgrades that move node binaries.
//   - On Windows there is no shebang; we fall back to "<execPath>" "<scriptPath>".
//   - On every boot we self-heal stale "/opt/homebrew/Cellar/node/<ver>/..." paths
//     left behind by older versions of this code.
try {
  const { buildHookCommand, selfHealCacheHealHook, ensureShebangAndExecBit } =
    await import("./hooks/cache-heal-utils.mjs");

  const globalHooksDir = resolve(homedir(), ".claude", "hooks");
  const healHookPath = resolve(globalHooksDir, "context-mode-cache-heal.mjs");
  // Clean up old bash version if it exists
  const oldBashHook = resolve(globalHooksDir, "context-mode-cache-heal.sh");
  if (existsSync(oldBashHook)) {
    try { unlinkSync(oldBashHook); } catch {}
  }
  if (!existsSync(healHookPath)) {
    if (!existsSync(globalHooksDir)) mkdirSync(globalHooksDir, { recursive: true });
    const healScript = `#!/usr/bin/env node
// context-mode plugin cache self-heal (auto-deployed)
// Fixes anthropics/claude-code#46915: auto-update breaks CLAUDE_PLUGIN_ROOT
// Pure Node.js — no bash/shell dependency.
import{existsSync,readdirSync,statSync,symlinkSync,lstatSync,unlinkSync,readFileSync}from"node:fs";
import{dirname,join,resolve,sep}from"node:path";
import{homedir}from"node:os";
try{
  const f=resolve(homedir(),".claude","plugins","installed_plugins.json");
  if(!existsSync(f))process.exit(0);
  const cacheRoot=resolve(homedir(),".claude","plugins","cache");
  const ip=JSON.parse(readFileSync(f,"utf-8"));
  for(const[k,es]of Object.entries(ip.plugins||{})){
    if(k!=="context-mode@context-mode")continue;
    for(const e of es){
      const p=e.installPath;
      if(!p||existsSync(p))continue;
      if(!resolve(p).startsWith(cacheRoot+sep))continue;
      const parent=dirname(p);
      if(!existsSync(parent))continue;
      try{if(lstatSync(p).isSymbolicLink())unlinkSync(p)}catch{}
      const dirs=readdirSync(parent).filter(d=>/^\\d+\\.\\d+/.test(d)&&statSync(join(parent,d)).isDirectory());
      if(!dirs.length)continue;
      dirs.sort((a,b)=>{const pa=a.split(".").map(Number),pb=b.split(".").map(Number);for(let i=0;i<3;i++){if((pa[i]||0)!==(pb[i]||0))return(pa[i]||0)-(pb[i]||0)}return 0});
      try{symlinkSync(join(parent,dirs[dirs.length-1]),p,process.platform==="win32"?"junction":undefined)}catch{}
    }
  }
}catch{}
`;
    writeFileSync(healHookPath, healScript, { mode: 0o755 });
  }

  // Always re-assert shebang + chmod +x on Unix so the bare-script hook
  // command is spawnable even if the file was created without exec bit.
  if (process.platform !== "win32") {
    try { ensureShebangAndExecBit(healHookPath); } catch { /* best effort */ }
  }

  // Register the hook in ~/.claude/settings.json (Claude Code doesn't auto-discover hook files)
  const settingsPath = resolve(homedir(), ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const hooks = settings.hooks ?? {};
    const sessionStart = hooks.SessionStart ?? [];
    const alreadyRegistered = sessionStart.some((h) =>
      h.hooks?.some((hh) => hh.command?.includes("context-mode-cache-heal")),
    );
    if (!alreadyRegistered) {
      sessionStart.push({
        hooks: [
          {
            type: "command",
            command: buildHookCommand({
              scriptPath: healHookPath,
              platform: process.platform,
              nodePath: process.execPath,
            }),
          },
        ],
      });
      hooks.SessionStart = sessionStart;
      settings.hooks = hooks;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    }

    // Self-heal: rewrite an existing cache-heal hook command if it points at
    // a node binary that no longer exists (Brew node upgrade scenario).
    try {
      selfHealCacheHealHook({
        settingsPath,
        scriptPath: healHookPath,
        platform: process.platform,
        nodePath: process.execPath,
      });
    } catch { /* best effort */ }
  }
} catch { /* best effort */ }

// ── Self-heal Layer 5: Windows hooks.json + plugin.json normalization (#378) ──
// Static committed files use ${CLAUDE_PLUGIN_ROOT} placeholder + bare `node`.
// On Windows + Claude Code this hits cjs/loader:1479 because:
//   1. bare `node` may not resolve via PATH (Git Bash, see #369)
//   2. ${CLAUDE_PLUGIN_ROOT} can hit MSYS path mangling (#372)
//   3. backslash paths corrupt under shell quoting
// Rewrites placeholders to absolute paths using process.execPath (Datadog
// model). Idempotent — only writes when needed. Survives upgrades because
// it runs at every MCP boot.
//
// Skip under vitest: server.test.ts spawns this script from the repo root,
// and a mutated .claude-plugin/plugin.json poisons sibling tests that read
// the file (cli.test.ts). VITEST is inherited by spawned subprocesses.
if (!process.env.VITEST) {
  try {
    const { normalizeHooksOnStartup } = await import("./hooks/normalize-hooks.mjs");
    normalizeHooksOnStartup({
      pluginRoot: __dirname,
      nodePath: process.execPath,
      platform: process.platform,
    });
  } catch { /* best effort — never block server startup */ }
}

// Ensure native dependencies + ABI compatibility (shared with hooks via ensure-deps.mjs)
// ensure-deps handles better-sqlite3 install + ABI cache/rebuild automatically (#148, #203)
import "./hooks/ensure-deps.mjs";
// Also install pure-JS deps used by server
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
