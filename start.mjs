#!/usr/bin/env node
import { execSync, spawn } from "node:child_process";
import { existsSync, chmodSync, readFileSync, writeFileSync, readdirSync, symlinkSync, mkdirSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const originalCwd = process.cwd();
process.chdir(__dirname);

// Resolve the Claude Code config dir, honoring $CLAUDE_CONFIG_DIR (incl. leading ~).
// Mirrors hooks/session-helpers.mjs::resolveConfigDir and hooks/run-hook.mjs (#453).
// Inlined here because start.mjs runs before any other module loads — we cannot
// dynamic-import session-helpers without circularity through the bundle path.
// Fix for #577: cache-heal layer below was hardcoding ~/.claude regardless of
// the env var, silently no-op'ing for users with a non-default config dir AND
// creating an unwanted ~/.claude/ directory on disk.
function resolveClaudeConfigDir() {
  const envVal = process.env.CLAUDE_CONFIG_DIR;
  if (envVal && envVal.trim() !== "") {
    if (envVal.startsWith("~")) {
      return resolve(homedir(), envVal.replace(/^~[/\\]?/, ""));
    }
    return resolve(envVal);
  }
  return resolve(homedir(), ".claude");
}

// Plugin-install-path guard (mirror of src/util/project-dir.ts isPluginInstallPath
// — duplicated here because start.mjs ships as raw JS and cannot import TS).
// When Claude Code runs `/ctx-upgrade` it kills + respawns the MCP server with
// `cwd` pointing at the plugin install dir. Setting CLAUDE_PROJECT_DIR from
// that path then poisons every downstream ctx_stats / SessionDB / hash
// computation — sessions silently re-root under the plugin install dir. Skip
// the env auto-set in that case; getProjectDir() defends a second time inside
// server.ts via resolveProjectDir(). See src/util/project-dir.ts.
const isPluginInstallPath = (p) =>
  /[/\\]\.claude[/\\]plugins[/\\](cache|marketplaces)[/\\]/.test(p);
const safeOriginalCwd = isPluginInstallPath(originalCwd) ? null : originalCwd;

if (!process.env.CLAUDE_PROJECT_DIR && safeOriginalCwd) {
  process.env.CLAUDE_PROJECT_DIR = safeOriginalCwd;
}

// Platform-agnostic project dir — guaranteed to be set for ALL platforms.
// Adapters may set their own env var (GEMINI_PROJECT_DIR, etc.) but this
// is the universal fallback so server.ts getProjectDir() never relies on cwd().
if (!process.env.CONTEXT_MODE_PROJECT_DIR && safeOriginalCwd) {
  process.env.CONTEXT_MODE_PROJECT_DIR = safeOriginalCwd;
}

// Routing instructions file auto-write DISABLED for all platforms (#158, #164).
// Env vars like CLAUDE_SESSION_ID may not be set at MCP startup time, making
// the hook-capability guard unreliable. Writing to project dirs dirties git trees
// and causes double context injection on hook-capable platforms.
// Routing is handled by:
//   - Hook-capable platforms: SessionStart hook injects ROUTING_BLOCK
//   - Non-hook platforms: server.ts writeRoutingInstructions() on MCP connect
//   - Future: explicit `context-mode init` command

// ── Linux: re-exec with Bun to avoid better-sqlite3 SIGSEGV (#564) ──
// server.bundle.mjs has two SQLite paths: bun:sqlite (safe) or better-sqlite3
// (SIGSEGV on Linux under Node's V8). When invoked via node on Linux, detect
// a Bun installation and re-exec this file under Bun so the bundle takes the
// safe path. No-op when already running under Bun or on non-Linux platforms.
if (typeof globalThis.Bun === "undefined" && process.platform === "linux") {
  const bunCandidates = [
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bin", "bun") : null,
    join(homedir(), ".bun", "bin", "bun"),
    "/usr/local/bin/bun",
    "/usr/bin/bun",
  ].filter(Boolean);
  const bunBin = bunCandidates.find((p) => existsSync(p));
  if (bunBin) {
    const child = spawn(bunBin, [fileURLToPath(import.meta.url)], {
      stdio: ["pipe", "inherit", "inherit"],
      env: process.env,
    });
    process.stdin.on("data", (chunk) => {
      if (!child.stdin.destroyed) child.stdin.write(chunk);
    });
    process.stdin.on("end", () => {});
    const _keepAlive = setInterval(() => {}, 2147483647);
    child.on("exit", (code) => {
      clearInterval(_keepAlive);
      process.exit(code ?? 0);
    });
    // Prevent rest of start.mjs from running — child owns the MCP session.
    process.stdin.resume();
    await new Promise(() => {}); // park this process forever
  }
}

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
    const claudeConfigDir = resolveClaudeConfigDir();
    const ipPath = resolve(claudeConfigDir, "plugins", "installed_plugins.json");

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
    const cacheRoot = resolve(claudeConfigDir, "plugins", "cache");
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

// ── Self-heal Layer 3 + 4: installed_plugins.json registry repair ──
// v1.0.113 hotfix follow-up. /ctx-upgrade can leave installed_plugins.json
// with two distinct kinds of poison:
//   HEAL 3: per-entry `version` drifts away from the actual cache dir's
//           plugin.json `version` field. Claude Code's plugin loader then
//           rejects the entry as a manifest mismatch and silently
//           disconnects context-mode.
//   HEAL 4: top-level `enabledPlugins[<key>]` is missing or emptied.
//           Claude Code skips disabled plugins, so MCP never starts and
//           the user has no /ctx-upgrade escape hatch.
// Logic is shared verbatim with scripts/postinstall.mjs (single source of
// truth) so users who fix themselves via `npm install -g context-mode`
// follow the exact same code path. Best-effort, never blocks MCP boot.
try {
  const { healInstalledPlugins, healSettingsEnabledPlugins, healPluginJsonMcpServers, sweepStaleMcpJson } =
    await import("./scripts/heal-installed-plugins.mjs");
  const pluginKey = "context-mode@context-mode";
  const claudeConfigDir = resolveClaudeConfigDir();
  const registryPath = resolve(claudeConfigDir, "plugins", "installed_plugins.json");
  const pluginCacheRoot = resolve(claudeConfigDir, "plugins", "cache");
  const settingsPath = resolve(claudeConfigDir, "settings.json");
  try { healInstalledPlugins({ registryPath, pluginCacheRoot, pluginKey }); }
  catch { /* best effort */ }
  // v1.0.116: Claude Code's plugin loader reads settings.json.enabledPlugins
  // (NOT installed_plugins.json) — heal that one too so /ctx-upgrade-induced
  // disable state is repaired before next /reload-plugins.
  try { healSettingsEnabledPlugins({ settingsPath, pluginKey }); }
  catch { /* best effort */ }
  // v1.0.119 — Layer 5b (Issue #523): heal .claude-plugin/plugin.json's
  // mcpServers["context-mode"].args[0] when /ctx-upgrade left a tmpdir-prefixed
  // path baked in. Iterates EVERY installed cache entry's installPath so
  // multi-version installs all self-recover. Each call is independently wrapped
  // because one poisoned entry must not block heals on the others. Best effort.
  try {
    if (existsSync(registryPath)) {
      const ip = JSON.parse(readFileSync(registryPath, "utf-8"));
      const entries = (ip && ip.plugins && ip.plugins[pluginKey]) || [];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const installPath = entry && entry.installPath;
          if (typeof installPath !== "string" || !installPath) continue;
          try {
            healPluginJsonMcpServers({
              pluginRoot: installPath,
              pluginCacheRoot,
              pluginKey,
            });
          } catch { /* best effort — per-entry */ }
        }
      }
    }
  } catch { /* best effort */ }
  // Issue #609 — Layer 5c (replaces v1.0.122 healMcpJsonArgs per-entry loop):
  // sweep stale `.mcp.json` files from every per-version cache dir. cli.ts
  // no longer writes `.mcp.json` (PR fix for #609), so the only `.mcp.json`
  // files in the cache are stale carry-forwards from earlier installs or
  // Claude Code's plugin manager copying them between version dirs. Removing
  // them blocks the previous-version-carry replay vector at MCP boot.
  // One sweep per boot — bounded, idempotent, best-effort.
  try {
    sweepStaleMcpJson({ pluginCacheRoot, pluginKey });
  } catch { /* best effort */ }
} catch { /* best effort — never block MCP boot */ }

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

  // #577: honor $CLAUDE_CONFIG_DIR — without this, Claude Code spawns hooks
  // from $CLAUDE_CONFIG_DIR/settings.json but we deploy them to ~/.claude/hooks/
  // and register them in ~/.claude/settings.json. The mismatch silently
  // disables the heal AND creates an unwanted ~/.claude directory.
  const claudeConfigDir = resolveClaudeConfigDir();
  const globalHooksDir = resolve(claudeConfigDir, "hooks");
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
// Honors CLAUDE_CONFIG_DIR (#577) — checked at this script's runtime so users
// who set CLAUDE_CONFIG_DIR after install still get healed correctly.
// Pure Node.js — no bash/shell dependency.
import{existsSync,readdirSync,statSync,symlinkSync,lstatSync,unlinkSync,readFileSync}from"node:fs";
import{dirname,join,resolve,sep}from"node:path";
import{homedir}from"node:os";
function cfgDir(){const e=process.env.CLAUDE_CONFIG_DIR;if(e&&e.trim()!==""){return e.startsWith("~")?resolve(homedir(),e.replace(/^~[/\\\\]?/,"")):resolve(e)}return resolve(homedir(),".claude")}
try{
  const f=resolve(cfgDir(),"plugins","installed_plugins.json");
  if(!existsSync(f))process.exit(0);
  const cacheRoot=resolve(cfgDir(),"plugins","cache");
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

  // Register the hook in $CLAUDE_CONFIG_DIR/settings.json (Claude Code doesn't auto-discover hook files).
  // #577: must follow the same dir resolution as globalHooksDir above.
  const settingsPath = resolve(claudeConfigDir, "settings.json");
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
// Pure-JS runtime deps used only by `ctx_fetch_and_index` (HTML → Markdown
// pipeline runs in a sandboxed subprocess that `require.resolve()`s these at
// call time). Plugin distributions that bypass `npm install` — most notably
// codex's marketplace, which git-clones into `~/.codex/plugins/cache/<pkg>/`
// without installing dependencies — land here with no `node_modules/`.
//
// Before #634: synchronous `execSync("npm install …")` per package
// (turndown + turndown-plugin-gfm + @mixmark-io/domino) blocked MCP boot
// for ~15–25s cold. Codex's per-MCP `startup_timeout_sec` is 30s, so on
// any host where its prewarm + DNS already eats a few seconds the timer
// fires before context-mode replies to `initialize` and the MCP child is
// dropped with "MCP client for `context-mode` timed out after 30 seconds".
//
// Fix: spawn each `npm install` detached + unref'd so it runs in the
// background while the MCP server proceeds with its handshake. The deps
// land asynchronously, well before any LLM-driven `ctx_fetch_and_index`
// call can plausibly fire. If a user invokes that tool faster than the
// install completes, the subprocess's own `require.resolve("turndown")`
// failure surfaces a typed error to the caller — same posture as any
// other missing-runtime-dep situation in that code path.
{
  const NPM_INSTALL_BG_PKGS = ["turndown", "turndown-plugin-gfm", "@mixmark-io/domino"];
  const IS_WIN32 = process.platform === "win32";
  const NPM_BIN = IS_WIN32 ? "npm.cmd" : "npm";
  for (const pkg of NPM_INSTALL_BG_PKGS) {
    if (existsSync(resolve(__dirname, "node_modules", pkg))) continue;
    try {
      const child = spawn(
        NPM_BIN,
        ["install", pkg, "--no-package-lock", "--no-save", "--silent", "--no-audit", "--no-fund"],
        {
          cwd: __dirname,
          stdio: "ignore",
          detached: true,
          // npm on Windows ships as a `.cmd` shim — must go through cmd.exe.
          shell: IS_WIN32,
        },
      );
      child.on("error", () => { /* best effort — npm missing, broken cache, etc. */ });
      child.unref();
    } catch { /* best effort — never block MCP boot */ }
  }
}

// Self-heal: create CLI shim if cli.bundle.mjs is missing (marketplace installs)
if (!existsSync(resolve(__dirname, "cli.bundle.mjs")) && existsSync(resolve(__dirname, "build", "cli.js"))) {
  const shimPath = resolve(__dirname, "cli.bundle.mjs");
  writeFileSync(shimPath, '#!/usr/bin/env node\nawait import("./build/cli.js");\n');
  if (process.platform !== "win32") chmodSync(shimPath, 0o755);
}

// ── Algo-D4: plugin cache integrity check ──
// Verify boot-critical siblings exist BEFORE importing server.bundle.mjs.
// Without this, a partial install (#550) gives an opaque downstream
// stack trace from `import("./server.bundle.mjs")`. With it, we emit a
// structured CONTEXT_MODE_PARTIAL_INSTALL stderr block + exit 2 so
// external monitoring grep + the user both see the actionable signal.
//
// Runs AFTER the heal layers above so missing files they can fix
// (cli.bundle.mjs shim, dangling symlinks) get a chance first. Helper
// is shared with `ctx doctor` (Algo-D5) — single source of truth so
// boot + diagnostic agree byte-for-byte. Skipped under VITEST so the
// repo's own test invocations against in-tree start.mjs don't fail
// when running before `npm run build` produces the bundles.
if (!process.env.VITEST) {
  try {
    const { assertPluginCacheIntegrity, formatPartialInstallReport } =
      await import("./scripts/plugin-cache-integrity.mjs");
    const integrity = assertPluginCacheIntegrity({ pluginRoot: __dirname });
    if (!integrity.ok) {
      process.stderr.write(
        formatPartialInstallReport({
          pluginRoot: __dirname,
          missing: integrity.missing,
        }),
      );
      process.exit(2);
    }
  } catch (err) {
    // The helper itself failing is unexpected — keep boot moving rather
    // than blocking on a check infrastructure bug. The downstream
    // import will still surface the actual missing-bundle error.
    if (process.env.CONTEXT_MODE_DEBUG) {
      process.stderr.write(`[start.mjs] integrity check skipped: ${err}\n`);
    }
  }
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
