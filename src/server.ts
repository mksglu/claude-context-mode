#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { existsSync, unlinkSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, cpSync, statSync, symlinkSync, lstatSync } from "node:fs";
import { execSync, spawnSync, type ChildProcess, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { join, dirname, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir, cpus } from "node:os";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import { PolyglotExecutor } from "./executor.js";
import { runPool, type PoolJob } from "./runPool.js";
import { ContentStore, cleanupStaleDBs, cleanupStaleContentDBs, type SearchResult, type IndexResult } from "./store.js";
import { composeFetchCacheKey } from "./fetch-cache.js";
import {
  readBashPolicies,
  evaluateCommandDenyOnly,
  extractShellCommands,
  readToolDenyPatterns,
  evaluateFilePath,
} from "./security.js";
import {
  detectRuntimes,
  getRuntimeSummary,
  getAvailableLanguages,
  hasBunRuntime,
} from "./runtime.js";
import { classifyNonZeroExit } from "./exit-classify.js";
import { startLifecycleGuard } from "./lifecycle.js";
import { hashProjectDirCanonical, hashProjectDirLegacy, resolveContentStorePath, resolveSessionDbPath, SessionDB } from "./session/db.js";
import { purgeSession } from "./session/purge.js";
import {
  emitCacheHitEvent,
  emitIndexWriteEvent,
  emitSandboxExecuteEvent,
} from "./session/event-emit.js";
import { persistToolCallCounter, restoreSessionStats } from "./session/persist-tool-calls.js";
import { searchAllSources } from "./search/unified.js";
import { buildNodeCommand, type HookAdapter, type PlatformId } from "./adapters/types.js";
import { detectPlatform, getSessionDirSegments } from "./adapters/detect.js";
import { resolveCodexConfigDir } from "./adapters/codex/paths.js";
import { getHookScriptPaths } from "./util/hook-config.js";
import { resolveClaudeConfigDir } from "./util/claude-config.js";
import { resolveProjectDir } from "./util/project-dir.js";
import { loadDatabase } from "./db-base.js";
import { AnalyticsEngine, formatReport, getConversationStats, getLifetimeStats, getMultiAdapterLifetimeStats, getRealBytesStats, OPUS_INPUT_PRICE_PER_TOKEN } from "./session/analytics.js";
const __pkg_dir = dirname(fileURLToPath(import.meta.url));
const VERSION: string = (() => {
  for (const rel of ["../package.json", "./package.json"]) {
    const p = resolve(__pkg_dir, rel);
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")).version; } catch {}
    }
  }
  return "unknown";
})();

// Prevent silent server death from unhandled async errors
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[context-mode] unhandledRejection: ${err}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`[context-mode] uncaughtException: ${err?.message ?? err}\n`);
});

const runtimes = detectRuntimes();
const available = getAvailableLanguages(runtimes);
const server = new McpServer({
  name: "context-mode",
  version: VERSION,
});

// Register empty prompts/resources handlers so MCP clients don't get -32601 (#168).
// OpenCode calls listPrompts()/listResources() unconditionally — the error can poison
// the SDK transport layer, causing subsequent listTools() calls to fail permanently.
import { ListPromptsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema } from "@modelcontextprotocol/sdk/types.js";
server.server.registerCapabilities({ prompts: { listChanged: false }, resources: { listChanged: false } });
server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

const executor = new PolyglotExecutor({
  runtimes,
  projectRoot: () => getProjectDir(),
});

// ─────────────────────────────────────────────────────────
// FS read tracking preload for ctx_batch_execute
// ─────────────────────────────────────────────────────────
// NODE_OPTIONS is denied by the executor's #buildSafeEnv (security).
// Instead, we inject it as an inline shell env prefix in each batch command.
// This temp file is loaded via --require when batch commands spawn Node processes.
const CM_FS_PRELOAD = join(tmpdir(), `cm-fs-preload-${process.pid}.js`);
writeFileSync(
  CM_FS_PRELOAD,
  `(function(){var __cm_fs=0;process.on('exit',function(){if(__cm_fs>0)try{process.stderr.write('__CM_FS__:'+__cm_fs+'\\n')}catch(e){}});try{var f=require('fs');var ors=f.readFileSync;f.readFileSync=function(){var r=ors.apply(this,arguments);if(Buffer.isBuffer(r))__cm_fs+=r.length;else if(typeof r==='string')__cm_fs+=Buffer.byteLength(r);return r;};}catch(e){}})();\n`,
);

// Lazy singleton — no DB overhead unless index/search is used
let _store: ContentStore | null = null;

/**
 * Auto-index session events files written by SessionStart hook.
 * Scans ~/.claude/context-mode/sessions/ for *-events.md files.
 * CLAUDE_PROJECT_DIR is NOT available to MCP servers — only to hooks —
 * so we glob-scan instead of computing a specific hash.
 * Files are consumed (deleted) after indexing to prevent double-indexing.
 * Called on every getStore() — readdirSync is sub-millisecond when no files match.
 */
function maybeIndexSessionEvents(store: ContentStore): void {
  try {
    const sessionsDir = getSessionDir();
    if (!existsSync(sessionsDir)) return;
    const files = readdirSync(sessionsDir).filter(f => f.endsWith("-events.md"));
    for (const file of files) {
      const filePath = join(sessionsDir, file);
      try {
        store.index({ path: filePath, source: "session-events" });
        unlinkSync(filePath);
      } catch { /* best-effort per file */ }
    }
  } catch { /* best-effort — session continuity never blocks tools */ }
}

// ── Platform-aware paths ──────────────────────────────────────────────────
// The adapter (stored after MCP handshake) is the canonical source for
// platform-specific paths. All session DB paths go through it — no
// hardcoded configDir detection in tool handlers.

let _detectedAdapter: HookAdapter | null = null;

// Tracks the ctx_insight dashboard child so shutdown can terminate it.
// See ctx_insight handler + shutdown() in main().
let _insightChild: ChildProcess | null = null;

/**
 * Resolve the Claude Code config root, honoring `CLAUDE_CONFIG_DIR` (incl.
 * leading `~`) before falling back to `~/.claude`. Mirrors
 * `hooks/session-helpers.mjs::resolveConfigDir` and
 * `ClaudeCodeAdapter.getConfigDir` so the pre-detection path agrees with
 * hooks/adapter on where Claude Code session data lives. See issue #453.
 *
 * Issue #460 round-3: delegates to the canonical util so empty/whitespace
 * env values fall back instead of poisoning downstream `join()` calls.
 */
function resolveClaudeConfigRoot(): string {
  return resolveClaudeConfigDir();
}

async function getDiagnosticAdapter(): Promise<HookAdapter | null> {
  if (_detectedAdapter) return _detectedAdapter;
  try {
    const { getAdapter } = await import("./adapters/detect.js");
    const signal = detectPlatform();
    return await getAdapter(signal.platform);
  } catch {
    return null;
  }
}

/**
 * Get the platform-specific sessions directory from the detected adapter.
 * Falls back to the detected platform config root before adapter detection.
 */
function getSessionDir(): string {
  if (_detectedAdapter) return _detectedAdapter.getSessionDir();
  // Pre-detection path (race window before MCP `initialize` completes):
  // call detectPlatform() (sync, env-var-based) and look up segments via
  // getSessionDirSegments() (sync map, no adapter instantiation). This keeps
  // non-Claude platforms from spilling sessions into ~/.claude/. For Claude
  // Code/Codex (single-segment roots), reroute through their config-dir
  // contracts so the pre-detection window does not split-state with hooks.
  try {
    const signal = detectPlatform();
    const segments = getSessionDirSegments(signal.platform);
    if (segments) {
      let root = join(homedir(), ...segments);
      if (segments.length === 1 && segments[0] === ".claude") {
        root = resolveClaudeConfigRoot();
      } else if (segments.length === 1 && segments[0] === ".codex") {
        root = resolveCodexConfigDir();
      }
      const dir = join(root, "context-mode", "sessions");
      mkdirSync(dir, { recursive: true });
      return dir;
    }
  } catch { /* fall through to claude fallback */ }
  const dir = join(resolveClaudeConfigRoot(), "context-mode", "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Project directory detection across supported platforms.
 *
 * Priority:
 *   1. Platform-specific env var (set by host IDE before MCP server spawn)
 *   2. CONTEXT_MODE_PROJECT_DIR (set by start.mjs for ALL platforms — universal)
 *   3. process.cwd() (last resort)
 *
 * CONTEXT_MODE_PROJECT_DIR guarantees correct projectDir even for platforms
 * that don't set their own env var (Cursor, OpenClaw, Codex, Kiro, Zed).
 */
function getProjectDir(): string {
  // Delegated to the shared resolver so the env-var chain rejects plugin
  // install paths (set by a prior MCP boot's start.mjs after `/ctx-upgrade`)
  // and prefers the shell-set PWD before the chdir'd cwd. v1.0.115 adds
  // the Claude Code transcript heuristic — read `cwd` from the most-recently-
  // modified `~/.claude/projects/<encoded>/<session>.jsonl` to recover the
  // real project dir when MCP was launched from a non-project cwd (desktop-
  // app launch, /ctx-upgrade respawn). See src/util/project-dir.ts.
  //
  // Issue #521 (v1.0.119): the transcript heuristic ONLY applies on Claude
  // Code. Other platforms (Cursor, OpenCode, Codex, ...) either have no
  // transcript at that path or use a different schema without `cwd`. Worse,
  // a Cursor user who also runs Claude Code would pick up the most-recently-
  // modified Claude Code session's cwd — wrong project entirely. Gate the
  // path on detected platform so non-Claude hosts skip the heuristic and
  // fall through to PWD/cwd cleanly.
  //
  // Issue #545 (v1.0.124): pass strictPlatform for ALL adapters so the
  // env-var cascade is built ALGORITHMICALLY from the platform's own
  // workspace vars + universal escape hatch — foreign workspace vars (e.g.
  // CLAUDE_PROJECT_DIR leaked into Pi's MCP child env from the user's shell)
  // cannot win, regardless of cascade order. start.mjs intentionally does
  // NOT pass strictPlatform — host detection is unreliable at the entrypoint
  // and the legacy literal cascade is preserved there for semver safety.
  let transcriptsRoot: string | undefined;
  let strictPlatform: PlatformId | undefined;
  try {
    const detected = detectPlatform().platform;
    strictPlatform = detected;
    if (detected === "claude-code") {
      transcriptsRoot = join(homedir(), ".claude", "projects");
    }
  } catch { /* detection failure — leave both undefined, resolver uses legacy cascade */ }
  return resolveProjectDir({
    env: process.env,
    cwd: process.cwd(),
    pwd: process.env.PWD,
    transcriptsRoot,
    strictPlatform,
  });
}

/**
 * Resolve a possibly-relative path against the project directory (full env cascade),
 * not the MCP server's process.cwd(). MCP server is spawned by the host and its cwd
 * is unrelated to where the user is working.
 */
function resolveProjectPath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(getProjectDir(), filePath);
}

/**
 * Resolve the per-project SessionDB path. Delegates to
 * {@link resolveSessionDbPath} so casing-only variants of the same
 * physical worktree on macOS / Windows hit ONE DB, not two — and any
 * pre-existing legacy raw-casing DB gets migrated in place on first
 * resolve. Linux is a no-op.
 */
function getSessionDbPath(): string {
  return resolveSessionDbPath({
    projectDir: getProjectDir(),
    sessionsDir: getSessionDir(),
  });
}

/**
 * Compute a per-project, per-platform persistent path for the ContentStore.
 * Derives content dir from the adapter's session dir so each platform
 * has its own isolated FTS5 DB — no cross-platform data sharing.
 *
 * Layout: ~/<configDir>/context-mode/content/<hash>.db
 *   e.g.  ~/.claude/context-mode/content/87c28c41ddb64d38.db
 *         ~/.cursor/context-mode/content/87c28c41ddb64d38.db
 */
function getStorePath(): string {
  // Derive content dir from session dir: .../sessions/ → .../content/
  const dir = join(dirname(getSessionDir()), "content");
  mkdirSync(dir, { recursive: true });
  // Delegate to resolveContentStorePath: same case-fold + one-shot legacy
  // rename behavior as resolveSessionDbPath. On macOS / Windows, an
  // existing legacy raw-casing FTS5 db (with -wal/-shm sidecars) is
  // migrated in place on first call. On Linux it's a no-op.
  return resolveContentStorePath({ projectDir: getProjectDir(), contentDir: dir });
}

function getStore(): ContentStore {
  if (!_store) {
    // Content DB cleanup on fresh start is handled by SessionStart hook.
    // Server just opens whatever DB exists (or creates new if hook deleted it).
    const dbPath = getStorePath();
    _store = new ContentStore(dbPath);

    // Wire deny-policy hook: store re-checks the Read deny list before
    // re-reading any file_path during auto-refresh. Catches policy edits
    // made after a file was originally indexed. See #442 round-3.
    _store.setDenyChecker((filePath: string) => {
      try {
        const projectDir = getProjectDir();
        const denyGlobs = readToolDenyPatterns("Read", projectDir);
        const r = evaluateFilePath(
          filePath,
          denyGlobs,
          process.platform === "win32",
          projectDir,
        );
        return r.denied;
      } catch {
        // Fail-closed for refresh: skip on error rather than re-read.
        return true;
      }
    });

    // One-time startup cleanup: remove stale content DBs (>14 days)
    try {
      const contentDir = dirname(getStorePath());
      cleanupStaleContentDBs(contentDir, 14);
      _store.cleanupStaleSources(14);
      // Also clean legacy shared dir from before platform isolation
      const legacyDir = join(homedir(), ".context-mode", "content");
      if (existsSync(legacyDir)) cleanupStaleContentDBs(legacyDir, 0);
    } catch { /* best-effort */ }

    // Also clean old PID-based DBs from migration
    cleanupStaleDBs();
  }
  maybeIndexSessionEvents(_store);
  return _store;
}

// ─────────────────────────────────────────────────────────
// Session stats — track context consumption per tool
// ─────────────────────────────────────────────────────────

const sessionStats = {
  calls: {} as Record<string, number>,
  bytesReturned: {} as Record<string, number>,
  bytesIndexed: 0,
  bytesSandboxed: 0, // network I/O consumed inside sandbox (never enters context)
  cacheHits: 0,
  cacheBytesSaved: 0, // bytes avoided by TTL cache hits
  sessionStart: Date.now(),
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

// ── Version outdated warning ──────────────────────────────────────────────
// Non-blocking npm check at startup. trackResponse prepends warning
// using a burst cadence: 3 warnings → 1h silent → 3 warnings → repeat.

let _latestVersion: string | null = null;
let _warningBurstCount = 0;
let _lastBurstStart = 0;
const VERSION_BURST_SIZE = 3;
const VERSION_SILENT_MS = 60 * 60 * 1000; // 1 hour

async function fetchLatestVersion(): Promise<string> {
  return new Promise((res) => {
    const req = httpsRequest(
      "https://registry.npmjs.org/context-mode/latest",
      { headers: { Connection: "close" } },
      (resp) => {
        let raw = "";
        resp.on("data", (chunk: Buffer) => { raw += chunk; });
        resp.on("end", () => {
          try {
            const data = JSON.parse(raw) as { version?: string };
            res(data.version ?? "unknown");
          } catch { res("unknown"); }
        });
      },
    );
    req.on("error", () => res("unknown"));
    req.setTimeout(5000, () => { req.destroy(); res("unknown"); });
    req.end();
  });
}

function getUpgradeHint(): string {
  const name = _detectedAdapter?.name;
  if (name === "Claude Code") return "/ctx-upgrade";
  if (name === "OpenClaw") return "npm run install:openclaw";
  if (name === "Pi") return "npm run build";
  return "npm update -g context-mode";
}

function semverNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

function isOutdated(): boolean {
  if (!_latestVersion || _latestVersion === "unknown") return false;
  return semverNewer(_latestVersion, VERSION);
}

function shouldShowVersionWarning(): boolean {
  if (!isOutdated()) return false;
  const now = Date.now();
  // Start of a new burst?
  if (_warningBurstCount >= VERSION_BURST_SIZE) {
    if (now - _lastBurstStart < VERSION_SILENT_MS) return false; // still silent
    _warningBurstCount = 0; // silence over, reset burst
  }
  if (_warningBurstCount === 0) _lastBurstStart = now;
  _warningBurstCount++;
  return true;
}

// ── Self-heal Layer 2: Mid-session registry heal (anthropics/claude-code#46915) ──
// Runs once on first tool call. If Claude Code auto-updated the registry mid-session,
// hooks break because CLAUDE_PLUGIN_ROOT points to a deleted directory. We create a
// symlink from the broken path to our actual directory so hooks recover.
let _cacheHealDone = false;
function healCacheMidSession(): void {
  if (_cacheHealDone) return;
  _cacheHealDone = true;
  try {
    // Issue #460 round-3: honor $CLAUDE_CONFIG_DIR so users who relocate
    // their CC config root don't have plugin cache healing operate against
    // the wrong tree (and silently miss dangling-symlink cleanup).
    const claudeRoot = resolveClaudeConfigDir();
    const ipPath = resolve(claudeRoot, "plugins", "installed_plugins.json");
    if (!existsSync(ipPath)) return;
    const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
    const cacheRoot = resolve(claudeRoot, "plugins", "cache");
    // Plugin root: build/ for tsc, plugin root for bundle
    const pluginRoot = existsSync(resolve(__pkg_dir, "package.json")) ? __pkg_dir : dirname(__pkg_dir);
    for (const [key, entries] of Object.entries((ip.plugins ?? {}) as Record<string, Array<{ installPath?: string }>>)) {
      if (key !== "context-mode@context-mode") continue;
      for (const entry of entries) {
        const rp = entry.installPath;
        if (!rp || existsSync(rp)) continue;
        // Path traversal guard
        if (!resolve(rp).startsWith(cacheRoot + sep)) continue;
        // Remove dangling symlink
        try { if (lstatSync(rp).isSymbolicLink()) unlinkSync(rp); } catch {}
        const parent = dirname(rp);
        if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
        if (existsSync(pluginRoot)) {
          symlinkSync(pluginRoot, rp, process.platform === "win32" ? "junction" : undefined);
        }
      }
    }
  } catch { /* best effort */ }
}

function trackResponse(toolName: string, response: ToolResult): ToolResult {
  // Mid-session cache heal — one-shot, first tool call
  healCacheMidSession();
  // Prepend version outdated warning if needed
  if (shouldShowVersionWarning() && response.content.length > 0) {
    const hint = getUpgradeHint();
    response.content[0].text =
      `⚠️ context-mode v${VERSION} outdated → v${_latestVersion} available. Upgrade: ${hint}\n\n` +
      response.content[0].text;
  }

  const bytes = response.content.reduce(
    (sum, c) => sum + Buffer.byteLength(c.text),
    0,
  );
  sessionStats.calls[toolName] = (sessionStats.calls[toolName] || 0) + 1;
  sessionStats.bytesReturned[toolName] =
    (sessionStats.bytesReturned[toolName] || 0) + bytes;

  // Persist a sidecar JSON snapshot for the statusline — read at ~3-5 Hz by
  // bin/statusline.mjs (and any external dashboard) so they don't have to
  // open the SQLite database. Throttled inside persistStats() (500ms) so
  // it's safe to call on every response.
  persistStats();

  // Persist to SessionDB so counters survive process restart, --continue,
  // upgrade. Re-introduces the write path 4742160 added and b392c2f dropped.
  // setImmediate keeps this off the response hot path; the helper itself
  // is best-effort (never throws).
  setImmediate(() => persistToolCallCounter(getSessionDbPath(), toolName, bytes));

  // D2 Phase 5/7 — sandbox-execute event emission. Tracks the bytes the
  // user actually saw from sandboxed runs so getRealBytesStats() can
  // replace the conservative `events × 256` estimate. Best-effort and
  // off the hot path, same shape as persistToolCallCounter above.
  if (
    toolName === "ctx_execute"
    || toolName === "ctx_execute_file"
    || toolName === "ctx_batch_execute"
  ) {
    setImmediate(() =>
      emitSandboxExecuteEvent({
        sessionDbPath: getSessionDbPath(),
        toolName,
        bytesReturned: bytes,
      })
    );
  }

  return response;
}

function trackIndexed(bytes: number, source: string = "unknown"): void {
  sessionStats.bytesIndexed += bytes;
  persistStats();
  // D2 Phase 5/7 — index-write event emission. `bytes_avoided` because
  // these are bytes that would have flooded context if the user had
  // Read'd the source instead of indexing.
  if (bytes > 0) {
    setImmediate(() =>
      emitIndexWriteEvent({
        sessionDbPath: getSessionDbPath(),
        source,
        bytesAvoided: bytes,
      })
    );
  }
}

// ─────────────────────────────────────────────────────────
// Stats persistence — written after every tool call so
// external readers (status line scripts, dashboards, hooks)
// can see real-time savings without spawning an MCP client.
// ─────────────────────────────────────────────────────────

const STATS_PERSIST_THROTTLE_MS = 500;
// Schema version for the persisted stats payload (~/.claude/context-mode/sessions/stats-*.json).
// Bump when a field is added/renamed/removed. Statusline reads `schemaVersion ?? 0` and warns when
// it sees a future schema, so legacy bundles degrade gracefully on upgrade rather than silently
// rendering missing fields (PR #401 architect review P1.3).
// v2: added tokens_saved_lifetime + dollars_saved_lifetime.
const STATS_SCHEMA_VERSION = 2;
// OPUS_INPUT_PRICE_PER_TOKEN intentionally NOT defined here — single source in
// src/session/analytics.ts re-exported above. (P1.1 — pricing constant dedup,
// PR #401 architect + ops 2-vote convergence.)
const LIFETIME_REFRESH_MS = 30_000;
// Matches the conversion factor in src/session/analytics.ts renderBottomLine:
// ~1KB per session event ÷ 4 bytes/token = 256 tokens/event.
const TOKENS_PER_EVENT = 256;
let _lastStatsPersist = 0;
let _lifetimeCache: { tokens: number; computedAt: number } | undefined;

/**
 * Resolve the per-session stats file path.
 *
 * The session id mirrors the Claude Code adapter contract
 * (`pid-<parent pid>`), so a status line script can derive
 * the same id from `$PPID` without coupling to MCP.
 */
function getStatsFilePath(): string {
  const sessionId = process.env.CLAUDE_SESSION_ID || `pid-${process.ppid}`;
  return join(getSessionDir(), `stats-${sessionId}.json`);
}

function persistStats(): void {
  const now = Date.now();
  if (now - _lastStatsPersist < STATS_PERSIST_THROTTLE_MS) return;
  _lastStatsPersist = now;

  try {
    const totalReturned = Object.values(sessionStats.bytesReturned).reduce(
      (a, b) => a + b,
      0,
    );
    const totalCalls = Object.values(sessionStats.calls).reduce(
      (a, b) => a + b,
      0,
    );
    const keptOut =
      sessionStats.bytesIndexed +
      sessionStats.bytesSandboxed +
      sessionStats.cacheBytesSaved;
    const totalProcessed = keptOut + totalReturned;
    const reductionPct =
      totalProcessed > 0
        ? Math.round((1 - totalReturned / totalProcessed) * 100)
        : 0;
    const tokensSaved = Math.round(keptOut / 4);

    // Lifetime savings — cached separately because getLifetimeStats() scans
    // disk (per-project SessionDBs + auto-memory dirs) and is too expensive
    // for the 500ms persist throttle. Refresh every 30s; the statusline
    // doesn't need second-by-second lifetime accuracy.
    let lifetimeTokens = _lifetimeCache?.tokens ?? 0;
    if (!_lifetimeCache || now - _lifetimeCache.computedAt > LIFETIME_REFRESH_MS) {
      try {
        const life = getLifetimeStats({ sessionsDir: getSessionDir() });
        lifetimeTokens = (life?.totalEvents ?? 0) * TOKENS_PER_EVENT;
        _lifetimeCache = { tokens: lifetimeTokens, computedAt: now };
      } catch {
        // best-effort — keep stale cache or 0
      }
    }

    const payload = {
      schemaVersion: STATS_SCHEMA_VERSION,
      version: VERSION,
      updated_at: now,
      session_start: sessionStats.sessionStart,
      uptime_ms: now - sessionStats.sessionStart,
      total_calls: totalCalls,
      bytes_returned: totalReturned,
      bytes_indexed: sessionStats.bytesIndexed,
      bytes_sandboxed: sessionStats.bytesSandboxed,
      cache_hits: sessionStats.cacheHits,
      cache_bytes_saved: sessionStats.cacheBytesSaved,
      kept_out: keptOut,
      total_processed: totalProcessed,
      reduction_pct: reductionPct,
      tokens_saved: tokensSaved,
      // statusline-facing $ values — pre-computed at Opus input rate so the
      // statusline doesn't have to know pricing. Lets us evolve pricing in
      // one place without touching consumers.
      dollars_saved_session: +(tokensSaved * OPUS_INPUT_PRICE_PER_TOKEN).toFixed(2),
      tokens_saved_lifetime: lifetimeTokens,
      dollars_saved_lifetime: +(lifetimeTokens * OPUS_INPUT_PRICE_PER_TOKEN).toFixed(2),
      by_tool: Object.fromEntries(
        Object.keys({ ...sessionStats.calls, ...sessionStats.bytesReturned }).map(
          (t) => [
            t,
            {
              calls: sessionStats.calls[t] || 0,
              bytes: sessionStats.bytesReturned[t] || 0,
            },
          ],
        ),
      ),
    };

    const filePath = getStatsFilePath();
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload));
    renameSync(tmpPath, filePath);
  } catch {
    // best-effort — never break tool calls because of stats persistence
  }
}

// ==============================================================================
// Security: server-side deny firewall
// ==============================================================================

/**
 * Check a shell command against Bash deny patterns.
 * Returns an error ToolResult if denied, or null if allowed.
 */
function checkDenyPolicy(
  command: string,
  toolName: string,
): ToolResult | null {
  try {
    const policies = readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    const result = evaluateCommandDenyOnly(command, policies);
    if (result.decision === "deny") {
      return trackResponse(toolName, {
        content: [{
          type: "text" as const,
          text: `Command blocked by security policy: matches deny pattern ${result.matchedPattern}`,
        }],
        isError: true,
      });
    }
  } catch {
    // Security check failed — allow through (fail-open for server,
    // hooks are the primary enforcement layer)
  }
  return null;
}

/**
 * Check non-shell code for shell-escape calls against deny patterns.
 */
function checkNonShellDenyPolicy(
  code: string,
  language: string,
  toolName: string,
): ToolResult | null {
  try {
    const commands = extractShellCommands(code, language);
    if (commands.length === 0) return null;
    const policies = readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    for (const cmd of commands) {
      const result = evaluateCommandDenyOnly(cmd, policies);
      if (result.decision === "deny") {
        return trackResponse(toolName, {
          content: [{
            type: "text" as const,
            text: `Command blocked by security policy: embedded shell command "${cmd}" matches deny pattern ${result.matchedPattern}`,
          }],
          isError: true,
        });
      }
    }
  } catch {
    // Fail-open
  }
  return null;
}

/**
 * Check a file path against Read deny patterns.
 * Returns an error ToolResult if denied, or null if allowed.
 */
function checkFilePathDenyPolicy(
  filePath: string,
  toolName: string,
): ToolResult | null {
  try {
    const projectDir = getProjectDir();
    const denyGlobs = readToolDenyPatterns("Read", projectDir);
    const result = evaluateFilePath(
      filePath,
      denyGlobs,
      process.platform === "win32",
      projectDir,
    );
    if (result.denied) {
      return trackResponse(toolName, {
        content: [{
          type: "text" as const,
          text: `File access blocked by security policy: path matches Read deny pattern ${result.matchedPattern}`,
        }],
        isError: true,
      });
    }
  } catch {
    // Fail-open
  }
  return null;
}

// Build description dynamically based on detected runtimes
const langList = available.join(", ");
const bunNote = hasBunRuntime()
  ? " (Bun detected — JS/TS runs 3-5x faster)"
  : "";

// ─────────────────────────────────────────────────────────
// Helper: smart snippet extraction — returns windows around
// matching query terms instead of dumb truncation
//
// When `highlighted` is provided (from FTS5 `highlight()` with
// STX/ETX markers), match positions are derived from the markers.
// This is the authoritative source — FTS5 uses the exact same
// tokenizer that produced the BM25 match, so stemmed variants
// like "configuration" matching query "configure" are found
// correctly. Falls back to indexOf on raw terms when highlighted
// is absent (non-FTS codepath).
// ─────────────────────────────────────────────────────────

const STX = "\x02";
const ETX = "\x03";

/**
 * Parse FTS5 highlight markers to find match positions in the
 * original (marker-free) text. Returns character offsets into the
 * stripped content where each matched token begins.
 */
export function positionsFromHighlight(highlighted: string): number[] {
  const positions: number[] = [];
  let cleanOffset = 0;

  let i = 0;
  while (i < highlighted.length) {
    if (highlighted[i] === STX) {
      // Record position of this match in the clean text
      positions.push(cleanOffset);
      i++; // skip STX
      // Advance through matched text until ETX
      while (i < highlighted.length && highlighted[i] !== ETX) {
        cleanOffset++;
        i++;
      }
      if (i < highlighted.length) i++; // skip ETX
    } else {
      cleanOffset++;
      i++;
    }
  }

  return positions;
}

/** Strip STX/ETX markers to recover original content. */
function stripMarkers(highlighted: string): string {
  return highlighted.replaceAll(STX, "").replaceAll(ETX, "");
}

export function extractSnippet(
  content: string,
  query: string,
  maxLen = 1500,
  highlighted?: string,
): string {
  if (content.length <= maxLen) return content;

  // Derive match positions from FTS5 highlight markers when available
  const positions: number[] = [];

  if (highlighted) {
    for (const pos of positionsFromHighlight(highlighted)) {
      positions.push(pos);
    }
  }

  // Fallback: indexOf on raw query terms (non-FTS codepath)
  if (positions.length === 0) {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    const lower = content.toLowerCase();

    for (const term of terms) {
      let idx = lower.indexOf(term);
      while (idx !== -1) {
        positions.push(idx);
        idx = lower.indexOf(term, idx + 1);
      }
    }
  }

  // No matches at all — return prefix
  if (positions.length === 0) {
    return content.slice(0, maxLen) + "\n…";
  }

  // Sort positions, merge overlapping windows
  positions.sort((a, b) => a - b);
  const WINDOW = 300;
  const windows: Array<[number, number]> = [];

  for (const pos of positions) {
    const start = Math.max(0, pos - WINDOW);
    const end = Math.min(content.length, pos + WINDOW);
    if (windows.length > 0 && start <= windows[windows.length - 1][1]) {
      windows[windows.length - 1][1] = end;
    } else {
      windows.push([start, end]);
    }
  }

  // Collect windows until maxLen
  const parts: string[] = [];
  let total = 0;
  for (const [start, end] of windows) {
    if (total >= maxLen) break;
    const part = content.slice(start, Math.min(end, start + (maxLen - total)));
    parts.push(
      (start > 0 ? "…" : "") + part + (end < content.length ? "…" : ""),
    );
    total += part.length;
  }

  return parts.join("\n\n");
}

export function formatBatchQueryResults(
  store: ContentStore,
  queries: string[],
  source: string,
  maxOutput = 80 * 1024,
): string[] {
  const sections: string[] = [];
  let outputSize = 0;

  for (const query of queries) {
    if (outputSize > maxOutput) {
      sections.push(`## ${query}\n(output cap reached — use ctx_search(queries: ["${query}"]) for details)\n`);
      continue;
    }

    const results = store.searchWithFallback(query, 3, source, undefined, "exact");
    sections.push(`## ${query}`);
    sections.push("");
    if (results.length > 0) {
      for (const result of results) {
        const snippet = extractSnippet(result.content, query, 3000, result.highlighted);
        sections.push(`### ${result.title}`);
        sections.push(snippet);
        sections.push("");
        outputSize += snippet.length + result.title.length;
      }
      continue;
    }

    sections.push("No matching sections found.");
    sections.push("");
  }

  sections.push(`\n> **Tip:** Results are scoped to this batch only. To search across all indexed sources, use \`ctx_search(queries: [...])\`.`);

  return sections;
}

// ─────────────────────────────────────────────────────────
// batch_execute runner — used by ctx_batch_execute handler
// ─────────────────────────────────────────────────────────

export interface BatchCommand { label: string; command: string; }

export interface BatchRunResult {
  outputs: string[];
  timedOut: boolean;
}

export interface BatchRunOptions {
  /**
   * Total budget (concurrency=1, shared) or per-command (concurrency>1).
   * When `undefined`, no server-side timer fires — the MCP host's RPC
   * timeout governs (Issue #406).
   */
  timeout: number | undefined;
  concurrency: number;
  nodeOptsPrefix: string;
  onFsBytes?: (bytes: number) => void;
}

interface BatchExecutor {
  execute(input: { language: "shell"; code: string; timeout: number | undefined }): Promise<{ stdout: string; timedOut?: boolean }>;
}

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildBatchNodeOptionsPrefix(shellPath: string, preloadPath: string): string {
  const option = `--require ${preloadPath}`;
  const shell = shellPath.toLowerCase();
  const base = shell.split(/[\\/]/).pop() ?? shell;

  if (shell.includes("powershell") || shell.includes("pwsh")) {
    return `$env:NODE_OPTIONS=${quotePowerShellSingle(option)}; `;
  }

  if (base === "cmd" || base === "cmd.exe") {
    return `set "NODE_OPTIONS=${option.replace(/"/g, '""')}" && `;
  }

  return `NODE_OPTIONS=${quotePosixSingle(option)} `;
}

function formatCommandOutput(label: string, raw: string, onFsBytes?: (bytes: number) => void): string {
  let output = raw || "(no output)";
  const fsMatches = output.matchAll(/__CM_FS__:(\d+)/g);
  let cmdFsBytes = 0;
  for (const m of fsMatches) cmdFsBytes += parseInt(m[1]);
  if (cmdFsBytes > 0) {
    onFsBytes?.(cmdFsBytes);
    output = output.replace(/__CM_FS__:\d+\n?/g, "");
  }
  return `# ${label}\n\n${output}\n`;
}

/**
 * Execute batch commands. concurrency=1 preserves the legacy serial path
 * (shared timeout budget + cascading skip-on-timeout). concurrency>1 runs
 * commands concurrently with at most N in flight; each command receives the
 * full timeout, output is collated by input index, and per-command timeouts
 * record `(timed out)` blocks without skipping siblings.
 */
export async function runBatchCommands(
  commands: BatchCommand[],
  opts: BatchRunOptions,
  executor: BatchExecutor,
): Promise<BatchRunResult> {
  const { timeout, concurrency, nodeOptsPrefix, onFsBytes } = opts;

  if (concurrency <= 1) {
    // Serial path — shared timeout budget, cascading skip on timeout.
    // When `timeout` is undefined, no shared budget is enforced; each
    // command runs to completion (Issue #406).
    const outputs: string[] = [];
    const startTime = Date.now();
    let timedOut = false;
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      let perCmdTimeout: number | undefined;
      if (timeout !== undefined) {
        const elapsed = Date.now() - startTime;
        const remaining = timeout - elapsed;
        if (remaining <= 0) {
          outputs.push(`# ${cmd.label}\n\n(skipped — batch timeout exceeded)\n`);
          timedOut = true;
          continue;
        }
        perCmdTimeout = remaining;
      }
      const result = await executor.execute({
        language: "shell",
        code: `${nodeOptsPrefix}${cmd.command} 2>&1`,
        timeout: perCmdTimeout,
      });
      outputs.push(formatCommandOutput(cmd.label, result.stdout, onFsBytes));
      if (result.timedOut) {
        timedOut = true;
        for (let j = i + 1; j < commands.length; j++) {
          outputs.push(`# ${commands[j].label}\n\n(skipped — batch timeout exceeded)\n`);
        }
        break;
      }
    }
    return { outputs, timedOut };
  }

  // Parallel path — delegated to the shared runPool primitive.
  // Each job returns { output, timedOut }; runPool handles in-flight cap,
  // throw isolation (Promise.allSettled semantics), and order preservation.
  const jobs: PoolJob<{ output: string; timedOut: boolean }>[] = commands.map((cmd) => ({
    run: async () => {
      const result = await executor.execute({
        language: "shell",
        code: `${nodeOptsPrefix}${cmd.command} 2>&1`,
        timeout,
      });
      // Always route partial stdout through formatCommandOutput so __CM_FS__
      // markers are stripped + counted, even when the command timed out.
      const formatted = formatCommandOutput(cmd.label, result.stdout, onFsBytes);
      const output = result.timedOut
        ? formatted.replace(/\n$/, "") + `\n(timed out after ${timeout ?? "?"}ms)\n`
        : formatted;
      return { output, timedOut: !!result.timedOut };
    },
  }));

  const { settled } = await runPool(jobs, { concurrency });
  const outputs: string[] = new Array(commands.length);
  let timedOut = false;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      outputs[i] = r.value.output;
      if (r.value.timedOut) timedOut = true;
    } else {
      // Isolated executor throw (spawn EAGAIN, ENOMEM, EMFILE, …) — siblings keep running.
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      outputs[i] = `# ${commands[i].label}\n\n(executor error: ${message})\n`;
    }
  }
  return { outputs, timedOut };
}

// ─────────────────────────────────────────────────────────
// Tool: execute
// ─────────────────────────────────────────────────────────

server.registerTool(
  "ctx_execute",
  {
    title: "Execute Code",
    description: `MANDATORY: Use for any command where output exceeds 20 lines. Execute code in a sandboxed subprocess. Only stdout enters context — raw data stays in the subprocess.${bunNote} Available: ${langList}.\n\nPREFER THIS OVER BASH for: API calls (gh, curl, aws), test runners (npm test, pytest), git queries (git log, git diff), data processing, and ANY CLI command that may produce large output. Bash should only be used for file mutations, git writes, and navigation.\n\nTHINK IN CODE: When you need to analyze, count, filter, compare, or process data — write code that does the work and console.log() only the answer. Do NOT read raw data into context to process mentally. Program the analysis, don't compute it in your reasoning. Write robust, pure JavaScript (no npm dependencies). Use only Node.js built-ins (fs, path, child_process). Always wrap in try/catch. Handle null/undefined. Works on both Node.js and Bun.`,
    inputSchema: z.object({
      language: z
        .enum([
          "javascript",
          "typescript",
          "python",
          "shell",
          "ruby",
          "go",
          "rust",
          "php",
          "perl",
          "r",
          "elixir",
          "csharp",
        ])
        .describe("Runtime language"),
      code: z
        .string()
        .describe(
          "Source code to execute. Use console.log (JS/TS), print (Python/Ruby/Perl/R), echo (Shell), echo (PHP), fmt.Println (Go), IO.puts (Elixir), or Console.WriteLine (C#) to output a summary to context.",
        ),
      timeout: z
        .coerce.number()
        .optional()
        .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs (which is the right layer for this policy). Pass an explicit value for long-running builds (Gradle/Maven/SBT)."),
      background: z
        .boolean()
        .optional()
        .default(false)
        .describe("Keep process running after timeout (for servers/daemons). Returns partial output without killing the process. IMPORTANT: Do NOT add setTimeout/self-close timers in background scripts — the process must stay alive until the timeout detaches it. For server+fetch patterns, prefer putting both server and fetch in ONE ctx_execute call instead of using background."),
      intent: z
        .string()
        .optional()
        .describe(
          "What you're looking for in the output. When provided and output is large (>5KB), " +
          "indexes output into knowledge base and returns section titles + previews — not full content. " +
          "Use ctx_search(queries: [...]) to retrieve specific sections. Example: 'failing tests', 'HTTP 500 errors'." +
          "\n\nTIP: Use specific technical terms, not just concepts. Check 'Searchable terms' in the response for available vocabulary.",
        ),
    }),
  },
  async ({ language, code, timeout, background, intent }) => {
    // Security: deny-only firewall
    if (language === "shell") {
      const denied = checkDenyPolicy(code, "execute");
      if (denied) return denied;
    } else {
      const denied = checkNonShellDenyPolicy(code, language, "execute");
      if (denied) return denied;
    }

    try {
      // For JS/TS: wrap in async IIFE with fetch + http/https interceptors to track network bytes
      let instrumentedCode = code;
      if (language === "javascript" || language === "typescript") {
        // Wrap user code in a closure that shadows CJS require with http/https interceptor.
        // globalThis.require does NOT work because CJS require is module-scoped, not global.
        // The closure approach (function(__cm_req){ var require=...; })(require) correctly
        // shadows the CJS require for all code inside, including __cm_main().
        instrumentedCode = `
// FS read instrumentation — count bytes read via fs.readFileSync/readFile
let __cm_fs=0;
process.on('exit',()=>{if(__cm_fs>0)try{process.stderr.write('__CM_FS__:'+__cm_fs+'\\n')}catch{}});
(function(){
  try{
    var f=typeof require!=='undefined'?require('fs'):null;
    if(!f)return;
    var ors=f.readFileSync;
    f.readFileSync=function(){var r=ors.apply(this,arguments);if(Buffer.isBuffer(r))__cm_fs+=r.length;else if(typeof r==='string')__cm_fs+=Buffer.byteLength(r);return r;};
    var orf=f.readFile;
    if(orf)f.readFile=function(){var a=Array.from(arguments),cb=a.pop();orf.apply(this,a.concat([function(e,d){if(!e&&d){if(Buffer.isBuffer(d))__cm_fs+=d.length;else if(typeof d==='string')__cm_fs+=Buffer.byteLength(d);}cb(e,d);}]));};
  }catch{}
})();
let __cm_net=0;
// Report network bytes on process exit — works with both promise and callback patterns.
// process.on('exit') fires after all I/O completes, unlike .finally() which fires
// when __cm_main() resolves (immediately for callback-based http.get without await).
process.on('exit',()=>{if(__cm_net>0)try{process.stderr.write('__CM_NET__:'+__cm_net+'\\n')}catch{}});
;(function(__cm_req){
// Intercept globalThis.fetch
const __cm_f=globalThis.fetch;
globalThis.fetch=async(...a)=>{const r=await __cm_f(...a);
try{const cl=r.clone();const b=await cl.arrayBuffer();__cm_net+=b.byteLength}catch{}
return r};
// Shadow CJS require with http/https network tracking.
const __cm_hc=new Map();
const __cm_hm=new Set(['http','https','node:http','node:https']);
function __cm_wf(m,origFn){return function(...a){
  const li=a.length-1;
  if(li>=0&&typeof a[li]==='function'){const oc=a[li];a[li]=function(res){
    res.on('data',function(c){__cm_net+=c.length});oc(res);};}
  const req=origFn.apply(m,a);
  const oOn=req.on.bind(req);
  req.on=function(ev,cb,...r){
    if(ev==='response'){return oOn(ev,function(res){
      res.on('data',function(c){__cm_net+=c.length});cb(res);
    },...r);}
    return oOn(ev,cb,...r);
  };
  return req;
}}
var require=__cm_req?function(id){
  const m=__cm_req(id);
  if(!__cm_hm.has(id))return m;
  const k=id.replace('node:','');
  if(__cm_hc.has(k))return __cm_hc.get(k);
  const w=Object.create(m);
  if(typeof m.get==='function')w.get=__cm_wf(m,m.get);
  if(typeof m.request==='function')w.request=__cm_wf(m,m.request);
  __cm_hc.set(k,w);return w;
}:__cm_req;
if(__cm_req){if(__cm_req.resolve)require.resolve=__cm_req.resolve;
if(__cm_req.cache)require.cache=__cm_req.cache;}
async function __cm_main(){
${code}
}
__cm_main().catch(e=>{console.error(e);process.exitCode=1});${background ? '\nsetInterval(()=>{},2147483647);' : ''}
})(typeof require!=='undefined'?require:null);`;
      }
      const result = await executor.execute({ language, code: instrumentedCode, timeout, background });

      // Parse sandbox network metrics from stderr
      const netMatch = result.stderr?.match(/__CM_NET__:(\d+)/);
      if (netMatch) {
        sessionStats.bytesSandboxed += parseInt(netMatch[1]);
        // Clean the metric line from stderr
        result.stderr = result.stderr.replace(/\n?__CM_NET__:\d+\n?/g, "");
      }

      // Parse sandbox FS read metrics from stderr
      const fsMatch = result.stderr?.match(/__CM_FS__:(\d+)/);
      if (fsMatch) {
        sessionStats.bytesSandboxed += parseInt(fsMatch[1]);
        result.stderr = result.stderr.replace(/\n?__CM_FS__:\d+\n?/g, "");
      }

      if (result.timedOut) {
        const partialOutput = result.stdout?.trim();
        if (result.backgrounded && partialOutput) {
          // Background mode: process is still running, return partial output as success
          return trackResponse("ctx_execute", {
            content: [
              {
                type: "text" as const,
                text: `${partialOutput}\n\n_(process backgrounded after ${timeout}ms — still running)_`,
              },
            ],
          });
        }
        if (partialOutput) {
          // Timeout with partial output — return as success with note
          return trackResponse("ctx_execute", {
            content: [
              {
                type: "text" as const,
                text: `${partialOutput}\n\n_(timed out after ${timeout}ms — partial output shown above)_`,
              },
            ],
          });
        }
        return trackResponse("ctx_execute", {
          content: [
            {
              type: "text" as const,
              text: `Execution timed out after ${timeout}ms\n\nstderr:\n${result.stderr}`,
            },
          ],
          isError: true,
        });
      }

      if (result.exitCode !== 0) {
        const { isError, output } = classifyNonZeroExit({
          language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
        });
        if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute", {
            content: [
              { type: "text" as const, text: intentSearch(output, intent, isError ? `execute:${language}:error` : `execute:${language}`) },
            ],
            isError,
          });
        }
        // Auto-index large error output into FTS5 — no data loss
        if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute", {
            content: [
              { type: "text" as const, text: intentSearch(output, "errors failures exceptions", isError ? `execute:${language}:error` : `execute:${language}`) },
            ],
            isError,
          });
        }
        return trackResponse("ctx_execute", {
          content: [
            { type: "text" as const, text: output },
          ],
          isError,
        });
      }

      const stdout = result.stdout || "(no output)";

      // Intent-driven search: if intent provided and output is large enough
      if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
        trackIndexed(Buffer.byteLength(stdout));
        return trackResponse("ctx_execute", {
          content: [
            { type: "text" as const, text: intentSearch(stdout, intent, `execute:${language}`) },
          ],
        });
      }

      // Auto-index large stdout into FTS5 — return pointer, not raw content
      if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
        return trackResponse("ctx_execute", indexStdout(stdout, `execute:${language}`));
      }

      return trackResponse("ctx_execute", {
        content: [
          { type: "text" as const, text: stdout },
        ],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_execute", {
        content: [
          { type: "text" as const, text: `Runtime error: ${message}` },
        ],
        isError: true,
      });
    }
  },
);

// ─────────────────────────────────────────────────────────
// Helper: index stdout into FTS5 knowledge base
// ─────────────────────────────────────────────────────────

function indexStdout(
  stdout: string,
  source: string,
): { content: Array<{ type: "text"; text: string }> } {
  const store = getStore();
  trackIndexed(Buffer.byteLength(stdout));
  const indexed = store.index({ content: stdout, source });
  return {
    content: [
      {
        type: "text" as const,
        text: `Indexed ${indexed.totalChunks} sections (${indexed.codeChunks} with code) from: ${indexed.label}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${indexed.label}" to scope results.`,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────
// Helper: intent-driven search on execution output
// ─────────────────────────────────────────────────────────

const INTENT_SEARCH_THRESHOLD = 5_000; // bytes — ~80-100 lines
const LARGE_OUTPUT_THRESHOLD = 102_400; // 100KB — auto-index into FTS5, return pointer

function intentSearch(
  stdout: string,
  intent: string,
  source: string,
  maxResults: number = 5,
): string {
  const totalLines = stdout.split("\n").length;
  const totalBytes = Buffer.byteLength(stdout);

  // Index into the PERSISTENT store so user can ctx_search() later
  const persistent = getStore();
  const indexed = persistent.indexPlainText(stdout, source);

  // Search the persistent store directly (porter → trigram → fuzzy)
  let results = persistent.searchWithFallback(intent, maxResults, source);

  // Extract distinctive terms as vocabulary hints for the LLM
  const distinctiveTerms = persistent.getDistinctiveTerms(indexed.sourceId);

  if (results.length === 0) {
    const lines = [
      `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
      `No sections matched intent "${intent}" in ${totalLines}-line output (${(totalBytes / 1024).toFixed(1)}KB).`,
    ];
    if (distinctiveTerms.length > 0) {
      lines.push("");
      lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
    }
    lines.push("");
    lines.push("Use ctx_search(queries: [...]) to explore the indexed content.");
    return lines.join("\n");
  }

  // Return ONLY titles + first-line previews — not full content
  const lines = [
    `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
    `${results.length} sections matched "${intent}" (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB):`,
    "",
  ];

  for (const r of results) {
    const preview = r.content.split("\n")[0].slice(0, 120);
    lines.push(`  - ${r.title}: ${preview}`);
  }

  if (distinctiveTerms.length > 0) {
    lines.push("");
    lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
  }

  lines.push("");
  lines.push("Use ctx_search(queries: [...]) to retrieve full content of any section.");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────
// Tool: execute_file
// ─────────────────────────────────────────────────────────

server.registerTool(
  "ctx_execute_file",
  {
    title: "Execute File Processing",
    description:
      "Read a file and process it without loading contents into context. The file is read into a FILE_CONTENT variable inside the sandbox. Only your printed summary enters context.\n\nPREFER THIS OVER Read/cat for: log files, data files (CSV, JSON, XML), large source files for analysis, and any file where you need to extract specific information rather than read the entire content.\n\nTHINK IN CODE: Write code that processes FILE_CONTENT and console.log() only the answer. Don't read files into context to analyze mentally. Write robust, pure JavaScript — no npm deps, try/catch, null-safe. Node.js + Bun compatible.",
    inputSchema: z.object({
      path: z
        .string()
        .describe("Absolute file path or relative to project root"),
      language: z
        .enum([
          "javascript",
          "typescript",
          "python",
          "shell",
          "ruby",
          "go",
          "rust",
          "php",
          "perl",
          "r",
          "elixir",
          "csharp",
        ])
        .describe("Runtime language"),
      code: z
        .string()
        .describe(
          "Code to process FILE_CONTENT (file_content in Elixir). Print summary via console.log/print/echo/IO.puts/Console.WriteLine.",
        ),
      timeout: z
        .coerce.number()
        .optional()
        .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs."),
      intent: z
        .string()
        .optional()
        .describe(
          "What you're looking for in the output. When provided and output is large (>5KB), " +
          "returns only matching sections via BM25 search instead of truncated output.",
        ),
    }),
  },
  async ({ path, language, code, timeout, intent }) => {
    // Security: check file path against Read deny patterns
    const pathDenied = checkFilePathDenyPolicy(path, "ctx_execute_file");
    if (pathDenied) return pathDenied;

    // Security: check code parameter against Bash deny patterns
    if (language === "shell") {
      const codeDenied = checkDenyPolicy(code, "execute_file");
      if (codeDenied) return codeDenied;
    } else {
      const codeDenied = checkNonShellDenyPolicy(code, language, "execute_file");
      if (codeDenied) return codeDenied;
    }

    try {
      const result = await executor.executeFile({
        path,
        language,
        code,
        timeout,
      });

      if (result.timedOut) {
        return trackResponse("ctx_execute_file", {
          content: [
            {
              type: "text" as const,
              text: `Timed out processing ${path} after ${timeout}ms`,
            },
          ],
          isError: true,
        });
      }

      if (result.exitCode !== 0) {
        const { isError, output } = classifyNonZeroExit({
          language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
        });
        if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute_file", {
            content: [
              { type: "text" as const, text: intentSearch(output, intent, isError ? `file:${path}:error` : `file:${path}`) },
            ],
            isError,
          });
        }
        // Auto-index large error output into FTS5 — no data loss
        if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute_file", {
            content: [
              { type: "text" as const, text: intentSearch(output, "errors failures exceptions", isError ? `file:${path}:error` : `file:${path}`) },
            ],
            isError,
          });
        }
        return trackResponse("ctx_execute_file", {
          content: [
            { type: "text" as const, text: output },
          ],
          isError,
        });
      }

      const stdout = result.stdout || "(no output)";

      if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
        trackIndexed(Buffer.byteLength(stdout));
        return trackResponse("ctx_execute_file", {
          content: [
            { type: "text" as const, text: intentSearch(stdout, intent, `file:${path}`) },
          ],
        });
      }

      // Auto-index large stdout into FTS5 — return pointer, not raw content
      if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
        return trackResponse("ctx_execute_file", indexStdout(stdout, `file:${path}`));
      }

      return trackResponse("ctx_execute_file", {
        content: [
          { type: "text" as const, text: stdout },
        ],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_execute_file", {
        content: [
          { type: "text" as const, text: `Runtime error: ${message}` },
        ],
        isError: true,
      });
    }
  },
);

// ─────────────────────────────────────────────────────────
// Tool: index
// ─────────────────────────────────────────────────────────

server.registerTool(
  "ctx_index",
  {
    title: "Index Content",
    description:
      "Index documentation or knowledge content into a searchable BM25 knowledge base. " +
      "Chunks markdown by headings (keeping code blocks intact) and stores in ephemeral FTS5 database. " +
      "The full content does NOT stay in context — only a brief summary is returned.\n\n" +
      "WHEN TO USE:\n" +
      "- Documentation from Context7, Skills, or MCP tools (API docs, framework guides, code examples)\n" +
      "- API references (endpoint details, parameter specs, response schemas)\n" +
      "- MCP tools/list output (exact tool signatures and descriptions)\n" +
      "- Skill prompts and instructions that are too large for context\n" +
      "- README files, migration guides, changelog entries\n" +
      "- Any content with code examples you may need to reference precisely\n\n" +
      "After indexing, use 'ctx_search' to retrieve specific sections on-demand.\n" +
      "When `path` is provided, a content hash is stored for automatic stale detection in search results.\n" +
      "Do NOT use for: log files, test output, CSV, build output — use 'ctx_execute_file' for those.",
    inputSchema: z.object({
      content: z
        .string()
        .optional()
        .describe(
          "Raw text/markdown to index. Provide this OR path, not both.",
        ),
      path: z
        .string()
        .optional()
        .describe(
          "File path to read and index (content never enters context). Provide this OR content.",
        ),
      source: z
        .string()
        .optional()
        .describe(
          "Label for the indexed content (e.g., 'Context7: React useEffect', 'Skill: frontend-design')",
        ),
    }),
  },
  async ({ content, path, source }) => {
    if (!content && !path) {
      return trackResponse("ctx_index", {
        content: [
          {
            type: "text" as const,
            text: "Error: Either content or path must be provided",
          },
        ],
        isError: true,
      });
    }

    // Apply Read deny-policy to prevent indexing sensitive files into the
    // FTS5 store, which would otherwise be queryable via ctx_search and
    // exfiltrate content into the model's context (issue #442). Mirrors the
    // check ctx_execute_file already performs.
    if (path) {
      const pathDenied = checkFilePathDenyPolicy(path, "ctx_index");
      if (pathDenied) return pathDenied;
    }

    try {
      const resolvedPath = path ? resolveProjectPath(path) : undefined;
      // Track the raw bytes being indexed (content or file)
      if (content) trackIndexed(Buffer.byteLength(content));
      else if (resolvedPath) {
        try {
          const fs = await import("fs");
          trackIndexed(fs.readFileSync(resolvedPath).byteLength);
        } catch { /* ignore — file read errors handled by store */ }
      }
      const store = getStore();
      const result = store.index({ content, path: resolvedPath, source: source ?? resolvedPath });

      return trackResponse("ctx_index", {
        content: [
          {
            type: "text" as const,
            text: `Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from: ${result.label}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${result.label}" to scope results.`,
          },
        ],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_index", {
        content: [
          { type: "text" as const, text: `Index error: ${message}` },
        ],
        isError: true,
      });
    }
  },
);

// ─────────────────────────────────────────────────────────
// Tool: search — progressive throttling
// ─────────────────────────────────────────────────────────

// Track search calls per 60-second window for progressive throttling
let searchCallCount = 0;
let searchWindowStart = Date.now();
const SEARCH_WINDOW_MS = 60_000;
const SEARCH_MAX_RESULTS_AFTER = 3; // after 3 calls: 1 result per query
const SEARCH_BLOCK_AFTER = 8; // after 8 calls: refuse, demand batching

/**
 * Defensive coercion: parse stringified JSON arrays.
 * Works around Claude Code double-serialization bug where array params
 * are sent as JSON strings (e.g. "[\"a\",\"b\"]" instead of ["a","b"]).
 * See: https://github.com/anthropics/claude-code/issues/34520
 */
function coerceJsonArray(val: unknown): unknown {
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not valid JSON, let zod handle the error */ }
  }
  return val;
}

/**
 * Coerce commands array: handles double-serialization AND the case where
 * the model passes plain command strings instead of {label, command} objects.
 */
function coerceCommandsArray(val: unknown): unknown {
  const arr = coerceJsonArray(val);
  if (Array.isArray(arr)) {
    return arr.map((item, i) =>
      typeof item === "string" ? { label: `cmd_${i + 1}`, command: item } : item
    );
  }
  return arr;
}

server.registerTool(
  "ctx_search",
  {
    title: "Search Indexed Content",
    description:
      "Search indexed content. Requires prior indexing via ctx_batch_execute, ctx_index, or ctx_fetch_and_index. " +
      "Pass ALL search questions as queries array in ONE call. " +
      "File-backed sources are auto-refreshed when the source file changes.\n\n" +
      "TIPS: 2-4 specific terms per query. Use 'source' to scope results.\n\n" +
      "SESSION STATE: If skills, roles, or decisions were set earlier in this conversation, they are still active. Do not discard or contradict them.",
    inputSchema: z.object({
      queries: z.preprocess(coerceJsonArray, z
        .array(z.string())
        .optional()
        .describe("Array of search queries. Batch ALL questions in one call.")),
      limit: z
        .number()
        .optional()
        .default(3)
        .describe("Results per query (default: 3)"),
      source: z
        .string()
        .optional()
        .describe("Filter to a specific indexed source (partial match)."),
      contentType: z
        .enum(["code", "prose"])
        .optional()
        .describe("Filter results by content type: 'code' or 'prose'."),
      sort: z
        .enum(["relevance", "timeline"])
        .optional()
        .default("relevance")
        .describe(
          "Sort mode. 'relevance' (default): BM25 ranked, current session only. " +
          "'timeline': chronological across current session, prior sessions, and auto-memory."
        ),
    }),
  },
  async (params) => {
    try {
      const store = getStore();
      const sort = (params as Record<string, unknown>).sort as string || "relevance";

      // Guard: redirect when the index is empty — ctx_search is a follow-up
      // tool that requires prior indexing. Skip for timeline mode (SessionDB/auto-memory may have data).
      if (sort !== "timeline" && store.getStats().chunks === 0) {
        return trackResponse("ctx_search", {
          content: [{
            type: "text" as const,
            text: "Knowledge base is empty — no content has been indexed yet.\n\n" +
              "ctx_search is a follow-up tool that queries previously indexed content. " +
              "To gather and index content first, use:\n" +
              "  • ctx_batch_execute(commands, queries) — run commands, auto-index output, and search in one call\n" +
              "  • ctx_fetch_and_index(url) — fetch a URL, index it, then search with ctx_search\n" +
              "  • ctx_index(content, source) — manually index text content\n\n" +
              "After indexing, ctx_search becomes available for follow-up queries.",
          }],
          isError: true,
        });
      }

      const raw = params as Record<string, unknown>;

      // Normalize: accept both query (string) and queries (array)
      const queryList: string[] = [];
      if (Array.isArray(raw.queries) && raw.queries.length > 0) {
        queryList.push(...(raw.queries as string[]));
      } else if (typeof raw.query === "string" && raw.query.length > 0) {
        queryList.push(raw.query as string);
      }

      if (queryList.length === 0) {
        return trackResponse("ctx_search", {
          content: [{ type: "text" as const, text: "Error: provide query or queries." }],
          isError: true,
        });
      }

      const { limit = 3, source, contentType } = params as { limit?: number; source?: string; contentType?: "code" | "prose" };

      // Progressive throttling: track calls in time window
      const now = Date.now();
      if (now - searchWindowStart > SEARCH_WINDOW_MS) {
        searchCallCount = 0;
        searchWindowStart = now;
      }
      searchCallCount++;

      // After SEARCH_BLOCK_AFTER calls: refuse
      if (searchCallCount > SEARCH_BLOCK_AFTER) {
        return trackResponse("ctx_search", {
          content: [{
            type: "text" as const,
            text: `BLOCKED: ${searchCallCount} search calls in ${Math.round((now - searchWindowStart) / 1000)}s. ` +
              "You're flooding context. STOP making individual search calls. " +
              "Use ctx_batch_execute(commands, queries) for your next research step.",
          }],
          isError: true,
        });
      }

      // Determine per-query result limit based on throttle level
      const effectiveLimit = searchCallCount > SEARCH_MAX_RESULTS_AFTER
        ? 1 // after 3 calls: only 1 result per query
        : Math.min(limit, 2); // normal: max 2

      const MAX_TOTAL = 40 * 1024; // 40KB total cap
      let totalSize = 0;
      const sections: string[] = [];

      // Open SessionDB once before the loop (Blocker 4: avoid open/close per query)
      let timelineDB: InstanceType<typeof SessionDB> | null = null;
      if (sort === "timeline") {
        try {
          const sessionsDir = getSessionDir();
          const projectDir = getProjectDir();
          const dbFile = resolveSessionDbPath({ projectDir, sessionsDir });
          if (existsSync(dbFile)) {
            timelineDB = new SessionDB({ dbPath: dbFile });
          }
        } catch { /* SessionDB unavailable — search ContentStore + auto-memory only */ }
      }

      const configDir = _detectedAdapter?.getConfigDir() ?? resolveClaudeConfigRoot();

      try {
      for (const q of queryList) {
        if (totalSize > MAX_TOTAL) {
          sections.push(`## ${q}\n(output cap reached)\n`);
          continue;
        }

        let results;
        if (sort === "timeline") {
          results = searchAllSources({
            query: q,
            limit: effectiveLimit,
            store,
            sort,
            source,
            contentType,
            sessionDB: timelineDB,
            projectDir: getProjectDir(),
            configDir,
            adapter: _detectedAdapter ?? undefined,
          });
        } else {
          results = store.searchWithFallback(q, effectiveLimit, source, contentType);
        }

        if (results.length === 0) {
          sections.push(`## ${q}\nNo results found.`);
          continue;
        }

        const formatted = results
          .map((r, i) => {
            const origin = (r as any).origin || "current-session";
            const ts = (r as any).timestamp ? (r as any).timestamp.slice(0, 16).replace("T", " ") : "";
            const header = `--- [${origin}${ts ? " | " + ts : ""} | ${r.source}] ---`;
            const heading = `### ${r.title}`;
            const snippet = extractSnippet(r.content, q, 1500, r.highlighted);
            return `${header}\n${heading}\n\n${snippet}`;
          })
          .join("\n\n");

        sections.push(`## ${q}\n\n${formatted}`);
        totalSize += formatted.length;
      }
      } finally {
        try { timelineDB?.close(); } catch {}
      }

      let output = sections.join("\n\n---\n\n");

      // Report auto-refreshed stale sources
      if (store.lastRefreshCount > 0) {
        output = `> Auto-refreshed ${store.lastRefreshCount} stale source${store.lastRefreshCount > 1 ? "s" : ""} (file changed since indexing).\n\n` + output;
      }

      // Add throttle warning after threshold
      if (searchCallCount >= SEARCH_MAX_RESULTS_AFTER) {
        output += `\n\n⚠ search call #${searchCallCount}/${SEARCH_BLOCK_AFTER} in this window. ` +
          `Results limited to ${effectiveLimit}/query. ` +
          `Batch queries: ctx_search(queries: ["q1","q2","q3"]) or use ctx_batch_execute.`;
      }

      if (output.trim().length === 0) {
        const sources = store.listSources();
        const sourceList = sources.length > 0
          ? `\nIndexed sources: ${sources.map((s) => `"${s.label}" (${s.chunkCount} sections)`).join(", ")}`
          : "";
        return trackResponse("ctx_search", {
          content: [{ type: "text" as const, text: `No results found.${sourceList}` }],
        });
      }

      return trackResponse("ctx_search", {
        content: [{ type: "text" as const, text: output }],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_search", {
        content: [{ type: "text" as const, text: `Search error: ${message}` }],
        isError: true,
      });
    }
  },
);

// ─────────────────────────────────────────────────────────
// Turndown path resolution (external dep, like better-sqlite3)
// ─────────────────────────────────────────────────────────

let _turndownPath: string | null = null;
let _gfmPluginPath: string | null = null;

function resolveTurndownPath(): string {
  if (!_turndownPath) {
    const require = createRequire(import.meta.url);
    _turndownPath = require.resolve("turndown");
  }
  return _turndownPath;
}

function resolveGfmPluginPath(): string {
  if (!_gfmPluginPath) {
    const require = createRequire(import.meta.url);
    _gfmPluginPath = require.resolve("turndown-plugin-gfm");
  }
  return _gfmPluginPath;
}

// ─────────────────────────────────────────────────────────
// Tool: fetch_and_index
// ─────────────────────────────────────────────────────────

// Subprocess code that fetches a URL, detects Content-Type, and outputs a
// __CM_CT__:<type> marker on the first line so the handler can route to the
// appropriate indexing strategy.  HTML is converted to markdown via Turndown.
export function buildFetchCode(url: string, outputPath: string): string {
  const turndownPath = JSON.stringify(resolveTurndownPath());
  const gfmPath = JSON.stringify(resolveGfmPluginPath());
  const escapedOutputPath = JSON.stringify(outputPath);
  // Embed classifyIp into the subprocess so the connect-time DNS lookup is
  // re-validated with the same policy as ssrfGuard. Without this, an attacker
  // can serve a public IP for the parent's pre-flight ssrfGuard lookup and
  // then a blocked IP (e.g. 169.254.169.254 IMDS) for the subprocess fetch's
  // own lookup — classic DNS rebinding across the parent/child boundary.
  const classifyIpSrc = classifyIp.toString();
  const strictMode = process.env.CTX_FETCH_STRICT === "1";
  return `
const TurndownService = require(${turndownPath});
const { gfm } = require(${gfmPath});
const fs = require('fs');
const dns = require('no' + 'de:dns');
const dnsPromises = require('no' + 'de:dns/promises');
const url = ${JSON.stringify(url)};
const outputPath = ${escapedOutputPath};

// Strip proxy env vars from this subprocess only. A configured outbound
// proxy (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY) would route fetch through
// an arbitrary target — DNS resolution happens at the proxy and the
// in-subprocess DNS rebinding guard never sees the rebound IP. The
// sandbox fetch path has no legitimate need for an upstream proxy.
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.ALL_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;
delete process.env.all_proxy;
delete process.env.npm_config_proxy;
delete process.env.npm_config_https_proxy;

${classifyIpSrc}

const STRICT = ${JSON.stringify(strictMode)};

// SSRF rebinding defense: every dns.lookup call inside this subprocess
// (including the one undici performs to connect the fetch socket) is
// re-validated against the same policy ssrfGuard runs in the parent.
// Even if a hostname rebinds between the parent's pre-flight check and
// the subprocess's actual connect, the connect-time lookup re-classifies
// every returned record and aborts before TCP if any verdict is "block".
const _origLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') { options = { family: options }; }
  const wantAll = options && options.all;
  const opts = Object.assign({}, options || {}, { all: true, verbatim: true });
  _origLookup(hostname, opts, function(err, records) {
    if (err) return callback(err);
    if (!Array.isArray(records)) {
      records = [{ address: records, family: (options && options.family) || 4 }];
    }
    for (var i = 0; i < records.length; i++) {
      var verdict = classifyIp(records[i].address);
      if (verdict === 'block' || (STRICT && verdict === 'private')) {
        return callback(new Error(
          'SSRF blocked at connect-time: ' + hostname +
          ' resolves to ' + records[i].address +
          ' (' + verdict + ')'
        ));
      }
    }
    if (wantAll) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  });
};

// dns/promises is a separate function reference. Patching dns.lookup does
// NOT affect dnsPromises.lookup. Today undici's connect path uses callback
// dns.lookup so default fetch is covered, but the invariant is fragile —
// any future undici switch (or user code calling dnsPromises.lookup
// directly) would bypass the guard. Patch both to keep the contract.
const _origPromisesLookup = dnsPromises.lookup;
dnsPromises.lookup = async function patchedPromisesLookup(hostname, options) {
  const opts = Object.assign({}, options || {}, { all: true, verbatim: true });
  const records = await _origPromisesLookup(hostname, opts);
  const list = Array.isArray(records) ? records : [records];
  for (var i = 0; i < list.length; i++) {
    var verdict = classifyIp(list[i].address);
    if (verdict === 'block' || (STRICT && verdict === 'private')) {
      throw new Error(
        'SSRF blocked at connect-time: ' + hostname +
        ' resolves to ' + list[i].address + ' (' + verdict + ')'
      );
    }
  }
  return options && options.all
    ? list
    : { address: list[0].address, family: list[0].family };
};

// dns.resolve4 / dns.resolve6 use a different code path (no getaddrinfo,
// no /etc/hosts) than dns.lookup — they must be patched separately or the
// guard is trivially bypassed by any caller using dns.resolve* directly.
['resolve4', 'resolve6'].forEach(function patchResolve(name) {
  const _origResolve = dns[name];
  dns[name] = function patchedResolve(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = undefined; }
    _origResolve.call(dns, hostname, options || {}, function(err, addrs) {
      if (err) return cb(err);
      var withTtl = options && options.ttl;
      for (var i = 0; i < addrs.length; i++) {
        var ip = withTtl ? addrs[i].address : addrs[i];
        var v = classifyIp(ip);
        if (v === 'block' || (STRICT && v === 'private')) {
          return cb(new Error(
            'SSRF blocked at connect-time: ' + hostname +
            ' resolves to ' + ip + ' (' + v + ')'
          ));
        }
      }
      cb(null, addrs);
    });
  };
});

// Generic dns.resolve is a polymorphic dispatcher (rrtype-driven). Internally
// Node delegates to dns.resolve4/dns.resolve6 for A/AAAA, but the patches
// above hook the *exported* references — Node's internal dispatcher holds
// captured originals and bypasses our patch. Patch the wrapper explicitly:
// classify A/AAAA records the same way; pass through CNAME/MX/TXT/SRV/etc.
const _origResolveGeneric = dns.resolve;
dns.resolve = function patchedResolveGeneric(hostname, rrtype, cb) {
  if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
  _origResolveGeneric.call(dns, hostname, rrtype, function(err, records) {
    if (err) return cb(err);
    if ((rrtype === 'A' || rrtype === 'AAAA') && Array.isArray(records)) {
      for (var i = 0; i < records.length; i++) {
        var ip = records[i];
        var v = classifyIp(ip);
        if (v === 'block' || (STRICT && v === 'private')) {
          return cb(new Error(
            'SSRF blocked at connect-time: ' + hostname +
            ' resolves to ' + ip + ' (' + v + ')'
          ));
        }
      }
    }
    cb(null, records);
  });
};

function emit(ct, content) {
  // Write content to file to bypass executor stdout truncation (100KB limit).
  // Only the content-type marker goes to stdout.
  fs.writeFileSync(outputPath, content);
  console.log('__CM_CT__:' + ct);
}

// Manual redirect handling: a 3xx Location header can rebind the subprocess
// fetch to an alternate host the parent's pre-flight ssrfGuard never saw.
// Even with the connect-time DNS patch, a redirect target that is a literal
// IP (e.g. http://169.254.169.254/) skips getaddrinfo entirely. Walk the
// chain manually so every hop runs through classifyIp before the next fetch.
const MAX_REDIRECTS = 5;
async function fetchWithManualRedirect(initialUrl) {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const resp = await fetch(currentUrl, { redirect: 'manual' });
    if (resp.status < 300 || resp.status >= 400) return resp;
    const location = resp.headers.get('location') || resp.headers.get('Location');
    if (!location) return resp;
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error('SSRF blocked: redirect chain exceeded ' + MAX_REDIRECTS + ' hops');
    }
    let nextParsed;
    try { nextParsed = new URL(location, currentUrl); } catch (e) {
      throw new Error('SSRF blocked: invalid redirect Location: ' + location);
    }
    if (nextParsed.protocol !== 'http:' && nextParsed.protocol !== 'https:') {
      throw new Error('SSRF blocked: redirect to non-http(s) scheme ' + nextParsed.protocol);
    }
    // If the redirect target is a literal IP, classify it directly — no DNS
    // lookup will fire and the connect-time guard would never see it.
    const hostname = nextParsed.hostname.replace(/^\[|\]$/g, '');
    const isIpLiteral = /^[0-9.]+$/.test(hostname) || hostname.includes(':');
    if (isIpLiteral) {
      const verdict = classifyIp(hostname);
      if (verdict === 'block' || (STRICT && verdict === 'private')) {
        throw new Error('SSRF blocked: redirect to ' + hostname + ' (' + verdict + ')');
      }
    } else {
      // Hostname target: resolve and classify every record. The patched
      // dns.lookup also fires on the next fetch's connect, but checking
      // here gives a clearer error and short-circuits before TCP setup.
      const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
      for (const rec of records) {
        const verdict = classifyIp(rec.address);
        if (verdict === 'block' || (STRICT && verdict === 'private')) {
          throw new Error(
            'SSRF blocked: redirect target ' + hostname +
            ' resolves to ' + rec.address + ' (' + verdict + ')'
          );
        }
      }
    }
    currentUrl = nextParsed.toString();
  }
  throw new Error('SSRF blocked: redirect chain exceeded ' + MAX_REDIRECTS + ' hops');
}

async function main() {
  const resp = await fetchWithManualRedirect(url);
  if (!resp.ok) { console.error("HTTP " + resp.status); process.exit(1); }
  const contentType = resp.headers.get('content-type') || '';

  // --- JSON responses ---
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    const text = await resp.text();
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      emit('json', pretty);
    } catch {
      emit('text', text);
    }
    return;
  }

  // --- HTML responses (default for text/html, application/xhtml+xml) ---
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    const html = await resp.text();
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    td.use(gfm);
    td.remove(['script', 'style', 'nav', 'header', 'footer', 'noscript']);
    emit('html', td.turndown(html));
    return;
  }

  // --- Everything else: plain text, CSV, XML, etc. ---
  const text = await resp.text();
  emit('text', text);
}
main();
`;
}

// ─────────────────────────────────────────────────────────
// fetch_and_index helpers — split into parallel-safe fetch and serial-only index
// ─────────────────────────────────────────────────────────

const FETCH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_PREVIEW_LIMIT = 3072;

type FetchOneResult =
  | { kind: "cached"; label: string; chunkCount: number; estimatedBytes: number; ageStr: string }
  | { kind: "fetched"; url: string; source?: string; markdown: string; header: string }
  | { kind: "fetch_error"; url: string; error: string; reason: "exit" | "read" | "empty" | "throw" };

/**
 * Pure fetch step — TTL cache check + subprocess fetch. SAFE TO RUN IN PARALLEL.
 * Performs zero SQLite writes (only reads source meta). Caller must funnel
 * fetched results through `indexFetched` serially to avoid FTS5 WAL contention.
 */
/**
 * SSRF guard for ctx_fetch_and_index: validate URL scheme + resolve target IP +
 * block link-local / IMDS / multicast / reserved IP ranges. Returns null if
 * safe; returns a FetchOneResult fetch_error if blocked.
 *
 * Policy (PR #401 ops review, developer-friendly default):
 *
 * **HARD BLOCK** (no legitimate dev workflow):
 *   - file://, gopher://, javascript:, data: schemes (only http: and https:)
 *   - 169.254.0.0/16 link-local (INCLUDES 169.254.169.254 = AWS/GCP/Azure IMDS
 *     cloud credential endpoint — high-value target for indirect prompt injection)
 *   - IPv6 link-local fe80::/10
 *   - Multicast (224+ IPv4, ff00::/8 IPv6) and reserved (0.0.0.0/8) ranges
 *
 * **ALLOW by default** (legitimate developer use cases dominate):
 *   - localhost, 127.x.x.x, ::1 (local dev servers — Next.js, Vite, Postgres, …)
 *   - 10.x, 172.16-31.x, 192.168.x RFC1918 private (developer's internal network)
 *
 * **STRICT MODE** opt-in via env var: `CTX_FETCH_STRICT=1`
 *   - Blocks loopback + RFC1918 too
 *   - For hosted/CI environments where the runtime isn't the user's own machine
 *
 * DNS resolution is performed against the resolved IP (not just URL parse) so a
 * hostname like `evil.com` pointing to 169.254.169.254 is rejected — defends
 * against attacker-controlled DNS records and DNS rebinding.
 */
async function ssrfGuard(rawUrl: string): Promise<FetchOneResult | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { kind: "fetch_error", url: rawUrl, error: "invalid URL", reason: "exit" };
  }

  // 1. Scheme allowlist — http and https only
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      kind: "fetch_error",
      url: rawUrl,
      error: `URL scheme "${parsed.protocol}" not allowed (only http: and https:)`,
      reason: "exit",
    };
  }

  const strict = process.env.CTX_FETCH_STRICT === "1";

  // 2. DNS resolve + check IP ranges (hard-block + optional strict-mode block)
  try {
    const { lookup } = await import("node:dns/promises");
    const records = await lookup(parsed.hostname, { all: true, verbatim: true });
    for (const rec of records) {
      const verdict = classifyIp(rec.address);
      if (verdict === "block") {
        return {
          kind: "fetch_error",
          url: rawUrl,
          error: `URL "${parsed.hostname}" resolves to ${rec.address} — blocked (link-local / IMDS / multicast / reserved)`,
          reason: "exit",
        };
      }
      if (verdict === "private" && strict) {
        return {
          kind: "fetch_error",
          url: rawUrl,
          error: `URL "${parsed.hostname}" resolves to private IP ${rec.address} — blocked under CTX_FETCH_STRICT=1`,
          reason: "exit",
        };
      }
    }
  } catch (err) {
    return {
      kind: "fetch_error",
      url: rawUrl,
      error: `DNS lookup failed for "${parsed.hostname}": ${err instanceof Error ? err.message : String(err)}`,
      reason: "exit",
    };
  }

  return null; // safe to fetch
}

/**
 * Classify an IP address.
 *   - "block":    always blocked (link-local/IMDS/multicast/reserved/malformed)
 *   - "private":  loopback or RFC1918 — allowed by default, blocked in strict mode
 *   - "public":   safe to fetch
 *
 * Exported (via the function name) so SSRF tests can exercise the matcher directly.
 */
export function classifyIp(rawIp: string): "block" | "private" | "public" {
  // RFC 6874 zone identifiers (`fe80::1%eth0`, URL-encoded `%25eth0`) must
  // be stripped BEFORE any prefix/equality classification. Without the strip,
  // a loopback `::1%eth0` no longer matches `lower === "::1"` and falls
  // through to "public" — silently bypassing the SSRF guard. Strip first,
  // classify second.
  const pctIdx = rawIp.indexOf("%");
  const ip = pctIdx === -1 ? rawIp : rawIp.slice(0, pctIdx);
  const lower = ip.toLowerCase();

  // IPv6 takes priority — check for `:` first so IPv4-mapped addresses
  // (`::ffff:127.0.0.1`) don't get incorrectly routed through the IPv4 parser.
  if (lower.includes(":")) {
    // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) — recurse through IPv4 classifier
    const v4MappedMatch = lower.match(/^::ffff:([\d.]+)$/);
    if (v4MappedMatch) return classifyIp(v4MappedMatch[1]);
    // Hard-block
    if (lower === "::") return "block"; // unspecified
    if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
        lower.startsWith("fea") || lower.startsWith("feb")) return "block"; // fe80::/10 link-local
    if (lower.startsWith("ff")) return "block"; // ff00::/8 multicast
    // Private (loopback + ULA)
    if (lower === "::1") return "private";
    if (lower.startsWith("fc") || lower.startsWith("fd")) return "private"; // fc00::/7 ULA
    return "public";
  }

  // IPv4 (or non-IP string — malformed = block)
  if (!ip.includes(".")) return "block"; // not an IP at all
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return "block";
  const [a, b] = parts;
  // Hard-block (no legitimate use)
  if (a === 169 && b === 254) return "block"; // link-local incl. 169.254.169.254 (IMDS)
  if (a === 0) return "block";                 // 0.0.0.0/8 (current network)
  if (a >= 224) return "block";                // 224.0.0.0+ multicast/reserved
  // Private (loopback + RFC1918) — allow by default
  if (a === 127) return "private";                          // 127.0.0.0/8 loopback
  if (a === 10) return "private";                           // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return "private";    // 172.16.0.0/12
  if (a === 192 && b === 168) return "private";             // 192.168.0.0/16
  return "public";
}

async function fetchOneUrl(url: string, source: string | undefined, force: boolean | undefined): Promise<FetchOneResult> {
  // SSRF guard — reject file://, javascript:, loopback, RFC1918, IMDS, link-local
  // BEFORE any cache lookup or subprocess spawn. Even cached entries shouldn't
  // serve a previously-poisoned source label.
  const ssrfBlock = await ssrfGuard(url);
  if (ssrfBlock) return ssrfBlock;

  if (!force) {
    const store = getStore();
    // Cache key composes (source, url) so two distinct URLs sharing the same
    // `source` label do not collide — they each get their own cache slot
    // (commit 1f1243e regression test enforced).
    const cacheKey = composeFetchCacheKey(source, url);
    const meta = store.getSourceMeta(cacheKey);
    if (meta) {
      const indexedAt = new Date(meta.indexedAt + "Z"); // SQLite datetime is UTC without Z
      const ageMs = Date.now() - indexedAt.getTime();
      if (ageMs < FETCH_TTL_MS) {
        const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
        const ageMin = Math.floor(ageMs / (60 * 1000));
        const ageStr = ageHours > 0 ? `${ageHours}h ago` : ageMin > 0 ? `${ageMin}m ago` : "just now";
        const estimatedBytes = meta.chunkCount * 1600; // ~1.6KB/chunk avg
        return { kind: "cached", label: meta.label, chunkCount: meta.chunkCount, estimatedBytes, ageStr };
      }
      // Stale — fall through to re-fetch silently
    }
  }

  const outputPath = join(tmpdir(), `ctx-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}.dat`);
  try {
    const fetchCode = buildFetchCode(url, outputPath);
    const result = await executor.execute({
      language: "javascript",
      code: fetchCode,
      timeout: 30_000,
    });
    if (result.exitCode !== 0) {
      return { kind: "fetch_error", url, error: result.stderr || result.stdout || "unknown error", reason: "exit" };
    }
    const header = (result.stdout || "").trim();
    let markdown: string;
    try {
      markdown = readFileSync(outputPath, "utf-8").trim();
    } catch {
      return { kind: "fetch_error", url, error: "could not read subprocess output", reason: "read" };
    }
    if (markdown.length === 0) {
      return { kind: "fetch_error", url, error: "empty content", reason: "empty" };
    }
    return { kind: "fetched", url, source, markdown, header };
  } catch (err: unknown) {
    return {
      kind: "fetch_error",
      url,
      error: err instanceof Error ? err.message : String(err),
      reason: "throw",
    };
  } finally {
    try { rmSync(outputPath); } catch { /* already gone */ }
  }
}

interface IndexedFetchResult {
  label: string;
  totalChunks: number;
  totalBytes: number;
  preview: string;
}

/**
 * Serial-only indexing step — single FTS5 write per call. Caller loops over
 * fetched results and calls this one-at-a-time to avoid SQLite WAL contention
 * (PRD finding E).
 */
function indexFetched(f: { url: string; source?: string; markdown: string; header: string }): IndexedFetchResult {
  const store = getStore();
  // Storage label composed via composeFetchCacheKey so two URLs sharing a
  // `source` label do not overwrite each other (commit 1f1243e). ctx_search()
  // still finds both via LIKE-mode source filter on the `source` substring.
  const storageLabel = composeFetchCacheKey(f.source, f.url);
  let indexed: IndexResult;
  if (f.header === "__CM_CT__:json") {
    indexed = store.indexJSON(f.markdown, storageLabel);
  } else if (f.header === "__CM_CT__:text") {
    indexed = store.indexPlainText(f.markdown, storageLabel);
  } else {
    indexed = store.index({ content: f.markdown, source: storageLabel });
  }
  // Track AFTER the FTS5 write succeeds — failed indexes shouldn't inflate the counter.
  trackIndexed(Buffer.byteLength(f.markdown));
  const preview = f.markdown.length > FETCH_PREVIEW_LIMIT
    ? f.markdown.slice(0, FETCH_PREVIEW_LIMIT) + "\n\n…[truncated — use ctx_search() for full content]"
    : f.markdown;
  return {
    label: indexed.label,
    totalChunks: indexed.totalChunks,
    totalBytes: Buffer.byteLength(f.markdown),
    preview,
  };
}

server.registerTool(
  "ctx_fetch_and_index",
  {
    title: "Fetch & Index URL(s)",
    description:
      "Fetches URL content, converts HTML to markdown, indexes into searchable knowledge base, " +
      "and returns a ~3KB preview. Full content stays in sandbox — use ctx_search() for deeper lookups.\n\n" +
      "Better than WebFetch: preview is immediate, full content is searchable, raw HTML never enters context.\n\n" +
      "Content-type aware: HTML is converted to markdown, JSON is chunked by key paths, plain text is indexed directly.\n\n" +
      "PARALLELIZE I/O: For multi-URL research (library evaluation, migration scans, doc comparisons), pass `requests: [{url, source}, ...]` with `concurrency: 4-8` — speeds up by 3-5x on real workloads.\n" +
      "  ✅ Use concurrency: 4-8 for: library docs sweep, multi-changelog scan, competitive pricing pages, multi-region docs, GitHub raw file pulls.\n" +
      "  ❌ Single URL → use the legacy {url, source} shape (concurrency irrelevant).\n" +
      "  Example: requests: [{url: 'https://react.dev/...', source: 'react'}, {url: 'https://vuejs.org/...', source: 'vue'}], concurrency: 5.\n" +
      "  Fetches parallelize up to your concurrency setting; FTS5 indexing serializes the writes after (SQLite single-writer rule).",
    inputSchema: z.object({
      url: z.string().optional().describe("Single URL to fetch and index (legacy single-shape)"),
      source: z
        .string()
        .optional()
        .describe(
          "Label for the indexed content when using single `url` (e.g., 'React useEffect docs', 'Supabase Auth API'). For batch, put source in each requests entry.",
        ),
      requests: z
        .array(
          z.object({
            url: z.string().describe("URL to fetch"),
            source: z.string().optional().describe("Label for this URL's indexed content"),
          }),
        )
        .min(1)
        .optional()
        .describe(
          "Batch shape: array of {url, source?} entries. Use with concurrency>1 for parallel fetch. " +
          "Each request indexed under its own source label. Output preserves input order.",
        ),
      concurrency: z
        .coerce.number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .default(1)
        .describe(
          "Max URLs to fetch in parallel (1-8, default: 1). " +
          "Use 4-8 for I/O-bound multi-URL batches (library docs, changelogs, pricing pages). " +
          "Capped by os.cpus().length on small machines (response notes when capped). " +
          "Indexing is always serial regardless — only fetches race.",
        ),
      force: z
        .boolean()
        .optional()
        .describe("Skip cache and re-fetch even if content was recently indexed"),
    }),
  },
  async ({ url, source, requests, concurrency, force }) => {
    // Normalize input: legacy {url} or new {requests: [...]}.
    // requests wins when both are provided (explicit batch intent).
    const batch: { url: string; source?: string }[] = requests
      ? requests
      : url
        ? [{ url, source }]
        : [];

    if (batch.length === 0) {
      return trackResponse("ctx_fetch_and_index", {
        content: [{
          type: "text" as const,
          text: "ctx_fetch_and_index requires either `url` (single) or `requests: [{url, source?}, ...]` (batch).",
        }],
        isError: true,
      });
    }

    const isLegacySingle = !requests && batch.length === 1;
    const requestedConcurrency = concurrency ?? 1;

    // Parallel fetch via shared runPool primitive. capByCpuCount only for batch
    // — single-URL doesn't need the cap (only one job, executor is one subprocess).
    const jobs: PoolJob<FetchOneResult>[] = batch.map((req) => ({
      run: () => fetchOneUrl(req.url, req.source, force),
    }));
    const { settled, effectiveConcurrency, capped } = await runPool(jobs, {
      concurrency: requestedConcurrency,
      capByCpuCount: !isLegacySingle && requestedConcurrency > 1,
    });

    // Serial index drain — workers race on fetch, but store.index* runs one at a time.
    type Finalized =
      | { kind: "cached"; label: string; chunkCount: number; ageStr: string }
      | { kind: "fetched"; indexed: IndexedFetchResult }
      | { kind: "fetch_error"; url: string; error: string; reason: "exit" | "read" | "empty" | "throw" }
      | { kind: "job_error"; url: string; error: string };

    const finalized: Finalized[] = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === "rejected") {
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
        finalized.push({ kind: "job_error", url: batch[i].url, error: message });
        continue;
      }
      const v = r.value;
      if (v.kind === "cached") {
        sessionStats.cacheHits++;
        sessionStats.cacheBytesSaved += v.estimatedBytes;
        // D2 Phase 5/7 — cache-hit event emission. `bytes_avoided` is the
        // size of the cached payload that would have re-entered context
        // had the TTL window missed. Best-effort, off the hot path.
        const cachedBytes = v.estimatedBytes;
        const cachedLabel = v.label;
        setImmediate(() =>
          emitCacheHitEvent({
            sessionDbPath: getSessionDbPath(),
            source: cachedLabel,
            bytesAvoided: cachedBytes,
          })
        );
        finalized.push({ kind: "cached", label: v.label, chunkCount: v.chunkCount, ageStr: v.ageStr });
      } else if (v.kind === "fetch_error") {
        finalized.push({ kind: "fetch_error", url: v.url, error: v.error, reason: v.reason });
      } else {
        // Serial FTS5 write here — no parallel store.index calls.
        finalized.push({ kind: "fetched", indexed: indexFetched(v) });
      }
    }

    // Backward-compat single-URL response shape — preserve the EXACT original wording.
    if (isLegacySingle) {
      const r = finalized[0];
      if (r.kind === "cached") {
        return trackResponse("ctx_fetch_and_index", {
          content: [{
            type: "text" as const,
            text: `Cached: **${r.label}** — ${r.chunkCount} sections, indexed ${r.ageStr} (fresh, TTL: 24h).\nTo refresh: call ctx_fetch_and_index again with \`force: true\`.\n\nYou MUST call ctx_search() to answer questions about this content — this cached response contains no content.\nUse: ctx_search(queries: [...], source: "${r.label}")`,
          }],
        });
      }
      if (r.kind === "fetched") {
        const totalKB = (r.indexed.totalBytes / 1024).toFixed(1);
        const text = [
          `Fetched and indexed **${r.indexed.totalChunks} sections** (${totalKB}KB) from: ${r.indexed.label}`,
          `Full content indexed in sandbox — use ctx_search(queries: [...], source: "${r.indexed.label}") for specific lookups.`,
          "",
          "---",
          "",
          r.indexed.preview,
        ].join("\n");
        return trackResponse("ctx_fetch_and_index", {
          content: [{ type: "text" as const, text }],
        });
      }
      // fetch_error — preserve original error wording per reason
      if (r.kind === "fetch_error") {
        const text =
          r.reason === "empty" ? `Fetched ${r.url} but got empty content`
          : r.reason === "read" ? `Fetched ${r.url} but could not read subprocess output`
          : r.reason === "exit" ? `Failed to fetch ${r.url}: ${r.error}`
          : /* throw */         `Fetch error: ${r.error}`;
        return trackResponse("ctx_fetch_and_index", {
          content: [{ type: "text" as const, text }],
          isError: true,
        });
      }
      // job_error
      return trackResponse("ctx_fetch_and_index", {
        content: [{ type: "text" as const, text: `Fetch error: ${r.error}` }],
        isError: true,
      });
    }

    // Batch response — aggregated summary; isError only when EVERY URL failed.
    // Per-URL preview capped tightly so a 8-URL batch doesn't undo the
    // context-savings the tool exists to deliver (PRD review finding G1).
    const FETCH_BATCH_PREVIEW_LIMIT = 384; // ~3KB total for 8-URL batches
    const lines: string[] = [];
    let totalSections = 0;
    let totalBytes = 0;
    let cachedCount = 0;
    let fetchedCount = 0;
    let errorCount = 0;
    const snippets: string[] = [];
    for (const r of finalized) {
      if (r.kind === "cached") {
        cachedCount++;
        lines.push(`- [cache] ${r.label} — ${r.chunkCount} sections (${r.ageStr})`);
      } else if (r.kind === "fetched") {
        fetchedCount++;
        totalSections += r.indexed.totalChunks;
        totalBytes += r.indexed.totalBytes;
        const kb = (r.indexed.totalBytes / 1024).toFixed(1);
        lines.push(`- [new]   ${r.indexed.label} — ${r.indexed.totalChunks} sections (${kb}KB)`);
        const snippet = r.indexed.preview.length > FETCH_BATCH_PREVIEW_LIMIT
          ? r.indexed.preview.slice(0, FETCH_BATCH_PREVIEW_LIMIT).trimEnd() + "…"
          : r.indexed.preview;
        snippets.push(`### ${r.indexed.label}\n\n${snippet}`);
      } else {
        errorCount++;
        lines.push(`- [err]   ${r.url}: ${r.error}`);
      }
    }

    const totalKB = (totalBytes / 1024).toFixed(1);
    const cappedNote = capped
      ? ` cap=${effectiveConcurrency}/${cpus().length}cpu`
      : "";
    // Status line: counts + sections + size, with singular/plural agreement
    // (count=1 → "1 error" not "1 errors") so the line stays grammatical.
    const fmt = (n: number, sing: string, plur: string) => `${n} ${n === 1 ? sing : plur}`;
    const headerLine =
      `fetched ${batch.length} c=${effectiveConcurrency}${cappedNote}. ` +
      `ok=${fetchedCount} cache=${cachedCount} err=${errorCount}. ` +
      `${fmt(totalSections, "section", "sections")} ${totalKB}KB.`;

    const text = [
      headerLine,
      "",
      ...lines,
      "",
      `ctx_search(queries: [...], source: "<label>") for full content.`,
      ...(snippets.length > 0 ? ["", "---", "", ...snippets] : []),
    ].join("\n");

    return trackResponse("ctx_fetch_and_index", {
      content: [{ type: "text" as const, text }],
      isError: errorCount === batch.length, // only mark error if every URL failed
    });
  },
);

// ─────────────────────────────────────────────────────────
// Tool: batch_execute
// ─────────────────────────────────────────────────────────

server.registerTool(
  "ctx_batch_execute",
  {
    title: "Batch Execute & Search",
    description:
      "Execute multiple commands in ONE call, auto-index all output, and search with multiple queries. " +
      "Returns search results directly — no follow-up calls needed.\n\n" +
      "THIS IS THE PRIMARY TOOL. Use this instead of multiple ctx_execute() calls.\n\n" +
      "One ctx_batch_execute call replaces 30+ ctx_execute calls + 10+ ctx_search calls.\n" +
      "Provide all commands to run and all queries to search — everything happens in one round trip.\n\n" +
      "PARALLELIZE I/O: For I/O-bound batches (network calls, slow API queries, multi-URL fetches), ALWAYS pass concurrency: 4-8 — speeds up by 3-5x on real workloads.\n" +
      "  ✅ Use concurrency: 4-8 for: gh API calls, curl/web fetches, multi-region cloud queries, multi-repo git reads, dig/DNS, docker inspect.\n" +
      "  ❌ Keep concurrency: 1 for: npm test, build, lint, image processing (CPU-bound), or commands sharing state (ports, lock files, same-repo writes).\n" +
      "  Example: [gh issue view 1, gh issue view 2, gh issue view 3] → concurrency: 3.\n" +
      "  Speedup depends on workload — applies to I/O wait, not CPU work.\n\n" +
      "THINK IN CODE — NON-NEGOTIABLE: When commands produce data you need to analyze, count, filter, compare, or transform — add a processing command that runs JavaScript and console.log() ONLY the answer. NEVER pull raw output into context to reason over. Concurrency parallelizes the FETCH; THINK IN CODE owns the PROCESSING. One programmed analysis replaces ten read-and-reason rounds. Pure JavaScript, Node.js built-ins (fs, path, child_process), try/catch, null-safe.",
    inputSchema: z.object({
      commands: z.preprocess(coerceCommandsArray, z
        .array(
          z.object({
            label: z
              .string()
              .describe(
                "Section header for this command's output (e.g., 'README', 'Package.json', 'Source Tree')",
              ),
            command: z
              .string()
              .describe("Shell command to execute"),
          }),
        )
        .min(1)
        .describe(
          "Commands to execute as a batch. Output is labeled with the section header. " +
          "Default order is sequential; pass concurrency>1 to run in parallel (output stays in input order).",
        )),
      queries: z.preprocess(coerceJsonArray, z
        .array(z.string())
        .min(1)
        .describe(
          "Search queries to extract information from indexed output. Use 5-8 comprehensive queries. " +
          "Each returns top 5 matching sections with full content. " +
          "This is your ONLY chance — put ALL your questions here. No follow-up calls needed.",
        )),
      timeout: z
        .coerce.number()
        .optional()
        .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs. With concurrency=1, the value (when set) is a shared budget across commands; with concurrency>1, it is applied per-command."),
      concurrency: z
        .coerce.number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .default(1)
        .describe(
          "Max commands to run in parallel (1-8, default: 1). " +
          "Use 4-8 for I/O-bound batches (network, gh, curl, multi-repo git reads). " +
          "Keep at 1 for CPU-bound (npm test, build, lint) or stateful commands (ports, locks). " +
          ">1 switches to per-command timeouts (no shared budget) and " +
          "individual `(timed out)` blocks instead of cascading skip.",
        ),
    }),
  },
  async ({ commands, queries, timeout, concurrency }) => {
    // Security: check each command against deny patterns
    for (const cmd of commands) {
      const denied = checkDenyPolicy(cmd.command, "batch_execute");
      if (denied) return denied;
    }

    try {
      // Inject NODE_OPTIONS for FS read tracking in spawned Node processes.
      // The executor denies NODE_OPTIONS in its env (security), so we set it
      // as an inline shell prefix. This only affects child `node` invocations.
      const nodeOptsPrefix = buildBatchNodeOptionsPrefix(runtimes.shell, CM_FS_PRELOAD);

      // Full stdout is preserved per-command and indexed into FTS5 (Issue #61, #197).
      // Concurrency>1 switches to a worker pool with per-command timeouts.
      const { outputs: perCommandOutputs, timedOut } = await runBatchCommands(
        commands,
        {
          timeout,
          concurrency,
          nodeOptsPrefix,
          onFsBytes: (bytes) => { sessionStats.bytesSandboxed += bytes; },
        },
        executor,
      );

      const stdout = perCommandOutputs.join("\n");
      const totalBytes = Buffer.byteLength(stdout);
      const totalLines = stdout.split("\n").length;

      if (timedOut && perCommandOutputs.length === 0) {
        return trackResponse("ctx_batch_execute", {
          content: [
            {
              type: "text" as const,
              text: `Batch timed out after ${timeout}ms. No output captured.`,
            },
          ],
          isError: true,
        });
      }

      // Track indexed bytes (raw data that stays in sandbox)
      trackIndexed(totalBytes);

      // Index into knowledge base — markdown heading chunking splits by # labels
      const store = getStore();
      const source = `batch:${commands
        .map((c) => c.label)
        .join(",")
        .slice(0, 80)}`;
      const indexed = store.index({ content: stdout, source });

      // Build section inventory — direct query by source_id (no FTS5 MATCH needed)
      const allSections = store.getChunksBySource(indexed.sourceId);
      const inventory: string[] = ["## Indexed Sections", ""];
      const sectionTitles: string[] = [];
      for (const s of allSections) {
        const bytes = Buffer.byteLength(s.content);
        inventory.push(`- ${s.title} (${(bytes / 1024).toFixed(1)}KB)`);
        sectionTitles.push(s.title);
      }

      // Run all search queries — source scoped only.
      // Cross-source search remains available via explicit ctx_search().
      const queryResults = formatBatchQueryResults(store, queries, source);

      // Get searchable terms for edge cases where follow-up is needed
      const distinctiveTerms = store.getDistinctiveTerms
        ? store.getDistinctiveTerms(indexed.sourceId)
        : [];

      const output = [
        `Executed ${commands.length} commands (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB). ` +
          `Indexed ${indexed.totalChunks} sections. Searched ${queries.length} queries.`,
        "",
        ...inventory,
        "",
        ...queryResults,
        distinctiveTerms.length > 0
          ? `\nSearchable terms for follow-up: ${distinctiveTerms.join(", ")}`
          : "",
      ].join("\n");

      return trackResponse("ctx_batch_execute", {
        content: [{ type: "text" as const, text: output }],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_batch_execute", {
        content: [
          {
            type: "text" as const,
            text: `Batch execution error: ${message}`,
          },
        ],
        isError: true,
      });
    }
  },
);

// ─────────────────────────────────────────────────────────
// Tool: stats
// ─────────────────────────────────────────────────────────

/**
 * Create a minimal in-memory DB adapter for when the session DB is unavailable.
 * All queries return empty results so AnalyticsEngine.queryAll() still works.
 */
function createMinimalDb(): import("./session/analytics.js").DatabaseAdapter {
  return {
    prepare: () => ({
      run: () => undefined,
      get: (..._args: unknown[]) => ({ cnt: 0, compact_count: 0, minutes: null, rate: 0, avg: 0, outcome: "exploratory" }),
      all: () => [],
    }),
  };
}

server.registerTool(
  "ctx_stats",
  {
    title: "Session Statistics",
    description:
      "Returns context consumption statistics for the current session. " +
      "Shows total bytes returned to context, breakdown by tool, call counts, " +
      "estimated token usage, and context savings ratio.",
    inputSchema: z.object({}),
  },
  async () => {
    // ONE call, ONE source — AnalyticsEngine.queryAll()
    let text: string;
    try {
      const projectDir = getProjectDir();
      // Canonical hash + migration-aware path. The downstream
      // getConversationStats / getRealBytesStats reconstruct the DB
      // filename from worktreeHash; pass the SAME canonical hash that
      // resolveSessionDbPath used so they hit the same file.
      const dbHash = hashProjectDirCanonical(projectDir);
      const sessionDbPath = resolveSessionDbPath({
        projectDir,
        sessionsDir: getSessionDir(),
      });

      if (existsSync(sessionDbPath)) {
        const Database = loadDatabase();
        const sdb = new Database(sessionDbPath, { readonly: true });
        try {
          const engine = new AnalyticsEngine(sdb);
          const report = engine.queryAll(sessionStats);
          // MCP usage is read-only and cheap; only available when DB exists.
          const mcpUsage = engine.getMcpToolUsage();
          // Lifetime stats span every project's SessionDB + auto-memory dir
          // (Bugs #3/#4); failures are absorbed inside getLifetimeStats so a
          // corrupt sidecar can never break ctx_stats.
          // B3b Slice 3.1: scope to active adapter via getSessionDir() so
          // non-Claude platforms (Cursor, OpenCode, JetBrains, ...) read
          // from THEIR sessions dir — not the hardcoded ~/.claude/ default.
          // Mirrors the statusline contract at src/server.ts:540.
          const lifetime = getLifetimeStats({ sessionsDir: getSessionDir() });
          // B3b Slices 3.2-3.6: cross-adapter aggregation so the renderer
          // can show "Where it came from" + the "across N AI tools"
          // headline. Best-effort — failures absorbed so a corrupt
          // sidecar in any adapter dir cannot break ctx_stats.
          let multiAdapter;
          try { multiAdapter = getMultiAdapterLifetimeStats(); } catch { /* never block ctx_stats */ }
          // F1: wire conversation + realBytes opts so formatReport renders the
          // narrative 5-section "kitap gibi" layout (timeline, ladder, receipt,
          // example cost, auto-memory). Without these, formatReport falls back
          // to the legacy active-session header. Best-effort — failures absorbed.
          // Resolve session_id: prefer env (CLAUDE_SESSION_ID), else most-recent
          // UUID session_id from session_events in this DB.
          let conversation;
          let realBytes;
          try {
            let sid = process.env.CLAUDE_SESSION_ID;
            if (!sid) {
              const row = sdb.prepare(
                "SELECT session_id FROM session_events WHERE session_id LIKE '________-____-____-____-____________' ORDER BY created_at DESC LIMIT 1"
              ).get() as { session_id: string } | undefined;
              sid = row?.session_id;
            }
            if (sid) {
              conversation = getConversationStats({ sessionId: sid, sessionsDir: getSessionDir(), worktreeHash: dbHash });
              const convReal = getRealBytesStats({ sessionId: sid, sessionsDir: getSessionDir(), worktreeHash: dbHash });
              const lifeReal = getRealBytesStats({ sessionsDir: getSessionDir() });
              realBytes = { conversation: convReal, lifetime: lifeReal };
            }
          } catch { /* never block ctx_stats */ }
          // v1.0.117: pass projectDir as cwd so the narrative renderer's
          // "started in <path>" line matches the user's actual project, not
          // the MCP server's chdir'd plugin install dir. getProjectDir()
          // includes v1.0.115's transcript heuristic which reads the literal
          // cwd from Claude Code's session jsonl.
          text = formatReport(report, VERSION, _latestVersion, { lifetime, mcpUsage, multiAdapter, conversation, realBytes, cwd: projectDir });
        } finally {
          sdb.close();
        }
      } else {
        // No session DB — build a minimal report from runtime stats only.
        // Lifetime still meaningful (other projects, auto-memory) so include it.
        const engine = new AnalyticsEngine(createMinimalDb());
        const report = engine.queryAll(sessionStats);
        const lifetime = getLifetimeStats({ sessionsDir: getSessionDir() });
        let multiAdapter;
        try { multiAdapter = getMultiAdapterLifetimeStats(); } catch { /* never block ctx_stats */ }
        text = formatReport(report, VERSION, _latestVersion, { lifetime, multiAdapter });
      }
    } catch {
      // Session DB not available or incompatible — build minimal report from runtime stats
      const engine = new AnalyticsEngine(createMinimalDb());
      const report = engine.queryAll(sessionStats);
      let lifetime;
      try { lifetime = getLifetimeStats({ sessionsDir: getSessionDir() }); } catch { /* never block ctx_stats */ }
      let multiAdapter;
      try { multiAdapter = getMultiAdapterLifetimeStats(); } catch { /* never block ctx_stats */ }
      text = formatReport(report, VERSION, _latestVersion, (lifetime || multiAdapter) ? { lifetime, multiAdapter } : undefined);
    }

    return trackResponse("ctx_stats", {
      content: [{ type: "text" as const, text }],
    });
  },
);

// ── ctx-doctor: diagnostics (server-side) ─────────────────────────────────
server.registerTool(
  "ctx_doctor",
  {
    title: "Run Diagnostics",
    description:
      "Diagnose context-mode installation. Runs all checks server-side and " +
      "returns a plain-text status report with [OK]/[FAIL]/[WARN] prefixes " +
      "(renderer-safe across MCP clients). No CLI execution needed.",
    inputSchema: z.object({}),
  },
  async () => {
    // Renderer-safe output (Mickey #3 — Z.ai GLM 4.7 ReferenceError):
    // Z.ai's MCP renderer mounts a custom React component for GitHub-flavored
    // markdown task-list syntax (`- [x]` / `- [ ]` / `- [-]`) that depends on
    // a missing `client` context, throwing `ReferenceError: client is not
    // defined`. We avoid both task-list syntax AND `## ` h2 headings to stay
    // safe across all MCP renderers — using plain-text status prefixes
    // (`[OK]` / `[FAIL]` / `[WARN]`) instead.
    const lines: string[] = ["context-mode doctor", ""];
    // __pkg_dir is build/ for tsc, plugin root for bundle — resolve to plugin root
    const pluginRoot = existsSync(resolve(__pkg_dir, "package.json")) ? __pkg_dir : dirname(__pkg_dir);

    // Runtimes
    const total = 11;
    const pct = ((available.length / total) * 100).toFixed(0);
    lines.push(`[OK] Runtimes: ${available.length}/${total} (${pct}%) — ${available.join(", ")}`);

    // Performance
    if (hasBunRuntime()) {
      lines.push("[OK] Performance: FAST (Bun)");
    } else {
      lines.push("[WARN] Performance: NORMAL — install Bun for 3-5x speed boost");
    }

    // Server test — cleanup executor to prevent resource leaks (#247)
    {
      const testExecutor = new PolyglotExecutor({ runtimes });
      try {
        const result = await testExecutor.execute({ language: "javascript", code: 'console.log("ok");', timeout: 5000 });
        if (result.exitCode === 0 && result.stdout.trim() === "ok") {
          lines.push("[OK] Server test: PASS");
        } else {
          const detail = result.stderr?.trim() ? ` (${result.stderr.trim().slice(0, 200)})` : "";
          lines.push(`[FAIL] Server test: FAIL — exit ${result.exitCode}${detail}`);
        }
      } catch (err: unknown) {
        lines.push(`[FAIL] Server test: FAIL — ${err instanceof Error ? err.message : err}`);
      } finally {
        testExecutor.cleanupBackgrounded();
      }
    }

    // FTS5 / SQLite — close in finally to prevent GC segfault (#247)
    {
      let testDb: ReturnType<typeof loadDatabase> extends (...args: any[]) => infer R ? R : never;
      try {
        const Database = loadDatabase();
        testDb = new Database(":memory:");
        testDb.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
        testDb.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
        const row = testDb.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content: string } | undefined;
        if (row && row.content === "hello world") {
          lines.push("[OK] FTS5 / SQLite: PASS — native module works");
        } else {
          lines.push("[FAIL] FTS5 / SQLite: FAIL — unexpected result");
        }
      } catch (err: unknown) {
        lines.push(`[FAIL] FTS5 / SQLite: FAIL — ${err instanceof Error ? err.message : err}`);
      } finally {
        try { testDb!?.close(); } catch { /* best effort */ }
      }
    }

    // Hooks
    const diagnosticAdapter = await getDiagnosticAdapter();
    if (diagnosticAdapter) {
      for (const result of diagnosticAdapter.validateHooks(pluginRoot)) {
        const prefix = result.status === "pass" ? "[OK]" : result.status === "warn" ? "[WARN]" : "[FAIL]";
        const fix = result.fix ? ` — fix: ${result.fix}` : "";
        lines.push(`${prefix} ${result.check}: ${result.message}${fix}`);
      }

      const hookScriptPaths = getHookScriptPaths(diagnosticAdapter, pluginRoot);
      if (hookScriptPaths.length === 0) {
        lines.push("[OK] Hook scripts: no direct .mjs script paths to verify");
      }
      for (const scriptPath of hookScriptPaths) {
        const hookPath = resolve(pluginRoot, scriptPath);
        if (existsSync(hookPath)) {
          lines.push(`[OK] Hook script: PASS — ${hookPath}`);
        } else {
          lines.push(`[FAIL] Hook script: FAIL — not found at ${hookPath}`);
        }
      }
    } else {
      lines.push("[WARN] Hooks: adapter detection unavailable");
    }

    // Version
    lines.push(`[OK] Version: v${VERSION}`);

    return trackResponse("ctx_doctor", {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    });
  },
);

// ── ctx-upgrade: upgrade meta-tool ─────────────────────────────────────────
server.registerTool(
  "ctx_upgrade",
  {
    title: "Upgrade Plugin",
    description:
      "Upgrade context-mode to the latest version. Returns a shell command to execute. " +
      "You MUST run the returned command using your shell tool (Bash, shell_execute, " +
      "run_in_terminal, etc.) and display the output as a checklist. " +
      "Tell the user to restart their session after upgrade.",
    inputSchema: z.object({}),
  },
  async () => {
    // __pkg_dir is build/ for tsc, plugin root for bundle — resolve to plugin root
    const pluginRoot = existsSync(resolve(__pkg_dir, "package.json")) ? __pkg_dir : dirname(__pkg_dir);
    const bundlePath = resolve(pluginRoot, "cli.bundle.mjs");
    const fallbackPath = resolve(pluginRoot, "build", "cli.js");

    // Clean up insight-cache on upgrade so next ctx_insight does fresh build
    try {
      const sessDir = getSessionDir();
      const insightCacheDir = join(dirname(sessDir), "insight-cache");
      if (existsSync(insightCacheDir)) {
        // Kill any running insight server first via the shared helper —
        // this is locale-independent on Windows (PR #469) and isolates per-pid
        // failures. We ignore the structured result: cache cleanup is
        // best-effort and must never block ctx_upgrade.
        killProcessOnPort(4747);
        rmSync(insightCacheDir, { recursive: true, force: true });
      }
    } catch { /* best effort — don't block upgrade */ }

    // Issue #542 — thread MCP clientInfo into the spawned upgrade
    // process. detectPlatform() runs IN-PROCESS here (no spawn boundary)
    // so clientInfo from the MCP handshake is the highest-confidence
    // signal available. We forward the resolved PlatformId as a
    // --platform flag (cross-shell safe on POSIX, Git Bash, PowerShell,
    // and cmd.exe — unlike env-var prefixes). If detection fails we
    // skip the flag and let upgrade()'s own detectPlatform() fall back.
    let platformFlag = "";
    try {
      const { detectPlatform } = await import("./adapters/detect.js");
      const clientInfo = server.server.getClientVersion();
      const signal = detectPlatform(clientInfo ?? undefined);
      platformFlag = ` --platform ${signal.platform}`;
    } catch { /* best effort — fall back to upgrade()'s own detect */ }

    let cmd: string;

    if (existsSync(bundlePath)) {
      cmd = `${buildNodeCommand(bundlePath)} upgrade${platformFlag}`;
    } else if (existsSync(fallbackPath)) {
      cmd = `${buildNodeCommand(fallbackPath)} upgrade${platformFlag}`;
    } else {
      // Inline fallback: neither CLI file exists (e.g. marketplace installs).
      // Generate a self-contained node -e script that performs the upgrade.
      const repoUrl = "https://github.com/mksglu/context-mode.git";
      // Write inline script to a temp .mjs file — avoids quote-escaping issues
      // across cmd.exe, PowerShell, and bash (node -e '...' breaks on Windows).
      const scriptLines = [
        `import{execFileSync}from"node:child_process";`,
        `import{cpSync,rmSync,existsSync,mkdtempSync,readFileSync,writeFileSync}from"node:fs";`,
        `import{join}from"node:path";`,
        `import{tmpdir}from"node:os";`,
        `const P=${JSON.stringify(pluginRoot)};`,
        `const T=mkdtempSync(join(tmpdir(),"ctx-upgrade-"));`,
        `try{`,
        `console.log("- [x] Starting inline upgrade (no CLI found)");`,
        `execFileSync("git",["clone","--depth","1","${repoUrl}",T],{stdio:"inherit"});`,
        `console.log("- [x] Cloned latest source");`,
        `execFileSync(process.platform==="win32"?"npm.cmd":"npm",["install"],{cwd:T,stdio:"inherit",shell:process.platform==="win32"});`,
        `execFileSync(process.platform==="win32"?"npm.cmd":"npm",["run","build"],{cwd:T,stdio:"inherit",shell:process.platform==="win32"});`,
        `console.log("- [x] Built from source");`,
        `const pkg=JSON.parse(readFileSync(join(T,"package.json"),"utf8"));`,
        `const items=[...(Array.isArray(pkg.files)?pkg.files:[]),"src","package.json"];`,
        `for(const item of items){const from=join(T,item);const to=join(P,item);if(existsSync(from)){rmSync(to,{recursive:true,force:true});cpSync(from,to,{recursive:true,force:true});}}`,
        `writeFileSync(join(P,".mcp.json"),JSON.stringify({mcpServers:{"context-mode":{command:"node",args:["\${CLAUDE_PLUGIN_ROOT}/start.mjs"]}}},null,2)+"\\n");`,
        `console.log("- [x] Copied package files");`,
        `execFileSync(process.platform==="win32"?"npm.cmd":"npm",["install","--production"],{cwd:P,stdio:"inherit",shell:process.platform==="win32"});`,
        `console.log("- [x] Installed production dependencies");`,
        `console.log("## context-mode upgrade complete");`,
        `}catch(e){`,
        `console.error("- [ ] Upgrade failed:",e.message);`,
        `process.exit(1);`,
        `}finally{`,
        `try{rmSync(T,{recursive:true,force:true})}catch{}`,
        `}`,
      ].join("\n");

      // Server writes the temp script file — avoids shell quoting issues entirely
      const tmpScript = resolve(pluginRoot, ".ctx-upgrade-inline.mjs");
      const { writeFileSync: writeTmp } = await import("node:fs");
      writeTmp(tmpScript, scriptLines);
      cmd = buildNodeCommand(tmpScript);
    }

    const text = [
      "## ctx-upgrade",
      "",
      "Run this command using your shell execution tool:",
      "",
      "```",
      cmd,
      "```",
      "",
      "After the command completes, display results as a markdown checklist:",
      "- `[x]` for success, `[ ]` for failure",
      "- Example format:",
      "  ```",
      "  ## context-mode upgrade",
      "  - [x] Pulled latest from GitHub",
      "  - [x] Built and installed v0.9.24",
      "  - [x] npm global updated",
      "  - [x] Hooks configured",
      "  - [x] Doctor: all checks PASS",
      "  ```",
      "- Tell the user to restart their session to pick up the new version.",
    ].join("\n");

    return trackResponse("ctx_upgrade", {
      content: [{ type: "text" as const, text }],
    });
  },
);

// ── ctx-purge: explicit knowledge base wipe ─────────────────────────────────
//
// Issue #520 — scoped purge.
// The schema is ADDITIVE: bare {confirm:true} preserves the legacy
// project-wide wipe verbatim (with a stderr deprecation warning so
// future callers migrate to explicit scope). When sessionId is given,
// only that session's rows + FTS5 chunks are removed; project-wide
// files (events.md, FTS5 store file, stats file) are preserved.
// Passing both sessionId AND scope:"project" is ambiguous (does the
// caller want a per-session wipe or a project-wide one?) and is
// rejected by the schema's refine().
server.registerTool(
  "ctx_purge",
  {
    title: "Purge Knowledge Base",
    description:
      "DESTRUCTIVE — permanently delete indexed content. CANNOT be undone.\n\n" +
      "You MUST specify exactly ONE scope:\n\n" +
      "  • { confirm: true, sessionId: \"<uuid>\" }\n" +
      "      Deletes ONLY that session's events + per-session FTS5 chunks.\n" +
      "      Preserves stats file and ALL other sessions.\n\n" +
      "  • { confirm: true, scope: \"project\" }\n" +
      "      Wipes the ENTIRE project: FTS5 knowledge base, every session DB row,\n" +
      "      events markdown, AND resets the stats file.\n\n" +
      "REFUSAL RULES (tool returns an error):\n" +
      "  • confirm: false                              → 'purge cancelled'\n" +
      "  • Both sessionId AND scope:'project' provided → 'ambiguous — pick one'\n" +
      "  • scope:'session' without sessionId           → throws (sessionId required)\n" +
      "  • Neither sessionId NOR scope provided        → DEPRECATED: maps to\n" +
      "    scope:'project' with a deprecation warning to stderr. Will be a hard\n" +
      "    error in a future major.\n\n" +
      "Use sessionId when the user asks to clear a specific conversation's data.\n" +
      "Use scope:'project' ONLY when the user explicitly asks to reset everything.\n" +
      "NEVER call with bare {confirm:true} — always specify the scope.",
    inputSchema: z.object({
      confirm: z.boolean().describe(
        "MUST be true. Destructive operation; false returns 'purge cancelled'."
      ),
      sessionId: z.string().optional().describe(
        "UUID of a single session. Pairs with confirm:true to wipe only that " +
        "session's events + per-session FTS5 chunks. Sibling sessions and the " +
        "stats file are preserved. MUST NOT be combined with scope:'project'."
      ),
      scope: z.enum(["session", "project"]).optional().describe(
        "Explicit scope selector. 'session' REQUIRES sessionId. 'project' wipes " +
        "the entire project (FTS5 + every session + stats). Omit only for the " +
        "deprecated bare-{confirm:true} back-compat path."
      ),
    }).refine(
      (v) => !(v.sessionId && v.scope === "project"),
      {
        message: "Ambiguous purge: sessionId implies scope:'session', cannot combine with scope:'project'. " +
          "Use scope:'project' WITHOUT sessionId for the legacy whole-project wipe.",
        path: ["scope"],
      },
    ),
  },
  async ({ confirm, sessionId, scope }) => {
    if (!confirm) {
      return trackResponse("ctx_purge", {
        content: [{
          type: "text" as const,
          text: "Purge cancelled. Pass confirm: true to proceed.",
        }],
      });
    }

    // Effective scope resolution:
    //   - explicit scope wins
    //   - else "session" iff sessionId is given
    //   - else "project" (back-compat — emit deprecation warning so
    //     callers migrate to the explicit form before a future major).
    const effectiveScope: "session" | "project" =
      scope ?? (sessionId ? "session" : "project");
    if (!scope && !sessionId) {
      console.warn(
        "[context-mode] ctx_purge: bare {confirm:true} is deprecated. " +
        "Pass scope:'project' for the whole-project wipe, or scope:'session' + sessionId " +
        "for a scoped wipe. See issue #520."
      );
    }

    // Close the persistent FTS5 content store handle BEFORE delegating to
    // purgeSession so the store's lock is released on Windows. The handle
    // is recreated lazily on the next getStore() call.
    let storePathForPurge: string | undefined;
    try {
      storePathForPurge = getStorePath();
    } catch { /* best effort — store path may be unresolvable on fresh install */ }
    if (_store) {
      try { _store.cleanup(); } catch { /* best effort */ }
      _store = null;
    }

    // FTS5 store: pass contentDir so purgeSession sweeps BOTH canonical
    // and legacy raw-casing variants (dual-hash, mirrors session events).
    // storePath is also passed for the rare case where the resolver picked
    // an absolute path that differs from the dual-hash pair (e.g. caller
    // pre-migrated). Both paths are de-duped during unlink.
    const contentDir = storePathForPurge ? dirname(storePathForPurge) : undefined;
    const { deleted } = purgeSession({
      projectDir: getProjectDir(),
      sessionsDir: getSessionDir(),
      storePath: storePathForPurge,
      contentDir,
      legacyContentDir: join(homedir(), ".context-mode", "content"),
      // hashProjectDirLegacy mirrors the deployed (≤ v1.0.111) raw-casing
      // hash that named files under ~/.context-mode/content/. Using the
      // legacy hash here is correct: that pre-pre-legacy directory was
      // never migrated and still uses raw casing.
      contentHash: hashProjectDirLegacy(getProjectDir()),
      scope: effectiveScope,
      sessionId,
    });

    // Stats are PROJECT-scoped (one stats file per project, summing all
    // sessions). A scoped per-session purge MUST leave stats alone — they
    // still belong to other sessions in the same project. Stats reset
    // happens ONLY when scope === "project".
    if (effectiveScope === "project") {
      // Reset in-memory session stats
      sessionStats.calls = {};
      sessionStats.bytesReturned = {};
      sessionStats.bytesIndexed = 0;
      sessionStats.bytesSandboxed = 0;
      sessionStats.cacheHits = 0;
      sessionStats.cacheBytesSaved = 0;
      sessionStats.sessionStart = Date.now();
      deleted.push("session stats");

      // Also drop the persisted stats file so external readers see a fresh state
      try {
        const statsFile = getStatsFilePath();
        if (existsSync(statsFile)) unlinkSync(statsFile);
      } catch { /* best effort */ }
    }

    const message = effectiveScope === "session"
      ? `Purged session ${sessionId}: ${deleted.length ? deleted.join(", ") : "no matching rows"}. ` +
        `Other sessions and project-wide stats preserved.`
      : `Purged: ${deleted.join(", ")}. All session data for this project has been permanently deleted.`;
    return trackResponse("ctx_purge", {
      content: [{
        type: "text" as const,
        text: message,
      }],
    });
  },
);

// ── ctx_insight process helpers ──────────────────────────────────────────────
// Cross-platform process helpers used by ctx_insight (below) and the dashboard
// launcher in cli.ts. All entry points use argv arrays — never `sh -c <string>`
// — so caller-derived values cannot escape into shell context. See issue #441.
//
// `browserOpenArgv` is duplicated as a private 16-LOC copy in cli.ts to avoid
// pulling server.ts top-level boot side effects into the cli bundle.

export type SpawnSyncFn = (
  cmd: string,
  args: readonly string[],
  opts?: SpawnSyncOptions,
) => SpawnSyncReturns<string | Buffer>;

export type BrowserOpenResult =
  | { ok: true; method: string }
  | { ok: false; method: "none"; reason: string };

export type KillResult = {
  killedPids: string[];
  attemptedPids: string[];
  errors: string[];
};

// Hard upper bound on every helper-internal spawnSync call. Caps tail-latency
// when an external binary hangs (xdg-open waiting for an X11 session, lsof
// stalling on /proc, taskkill blocking on an unresponsive process, etc.) so
// the MCP tool surfaces a diagnostic instead of blocking the agent loop.
// 5s is comfortably above the 99th-percentile completion of every command we
// invoke; anything past that is hung.
const HELPER_SPAWN_TIMEOUT_MS = 5000;

// Returns the argv attempts for opening `url` on `platform`, in fall-back order.
// Pure data — no I/O.
export function browserOpenArgv(
  url: string,
  platform: NodeJS.Platform,
): readonly { cmd: string; args: readonly string[] }[] {
  if (platform === "darwin") return [{ cmd: "open", args: [url] }];
  if (platform === "win32") {
    // `start` is a cmd.exe builtin; the empty title arg ("") prevents the URL
    // from being consumed as the window title.
    return [{ cmd: "cmd", args: ["/c", "start", "", url] }];
  }
  // linux/bsd: try xdg-open, then sensible-browser (Debian/Ubuntu).
  return [
    { cmd: "xdg-open", args: [url] },
    { cmd: "sensible-browser", args: [url] },
  ];
}

// Opens a browser synchronously, waiting for each attempt to complete.
// Returns a structured result so callers can surface auto-open failures
// to the user instead of falsely reporting success.
export function openBrowserSync(
  url: string,
  platform: NodeJS.Platform = process.platform,
  runner: SpawnSyncFn = spawnSync,
): BrowserOpenResult {
  const attempts = browserOpenArgv(url, platform);
  const errors: string[] = [];
  for (const { cmd, args } of attempts) {
    try {
      const r = runner(cmd, args, { stdio: "ignore", timeout: HELPER_SPAWN_TIMEOUT_MS });
      // Treat signal-kill (status === null) and any non-zero status as failure
      // so the next fallback fires.
      if (!r.error && r.status === 0) return { ok: true, method: cmd };
      const reason = r.error?.message ?? `status=${r.status === null ? "signaled" : r.status}`;
      errors.push(`${cmd}: ${reason}`);
    } catch (e) {
      errors.push(`${cmd}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: false, method: "none", reason: errors.join("; ") };
}

// Kills any process listening on `port`. Returns a structured result so
// the caller can distinguish between (a) port was free, (b) kill succeeded,
// (c) kill failed (perms, missing binary, or per-pid failure mid-loop).
//
// On Windows the netstat parser is locale-independent: the STATE column
// ("LISTENING" / "ESTABLISHED" / ...) is translated on non-English Windows
// (Windows-FR shows "À l'écoute", Windows-DE "ABHÖREN", etc.), but the REMOTE
// ADDRESS column is not. A listening TCP socket always has remote
// "0.0.0.0:0" (IPv4) or "[::]:0" (IPv6); a connected one has a real
// addr:port. We therefore key off the remote column instead of the state
// string. This also rules out the pre-fix bug where matching only the local
// port number cross-matched a remote :port from an outbound connection and
// taskkill'd an unrelated process.
export function killProcessOnPort(
  port: number,
  platform: NodeJS.Platform = process.platform,
  runner: SpawnSyncFn = spawnSync,
): KillResult {
  const result: KillResult = { killedPids: [], attemptedPids: [], errors: [] };
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    result.errors.push(`invalid port: ${port}`);
    return result;
  }

  try {
    if (platform === "win32") {
      const r = runner("netstat", ["-ano"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: HELPER_SPAWN_TIMEOUT_MS,
      });
      if (r.error) {
        result.errors.push(`netstat: ${r.error.message}`);
        return result;
      }
      if (r.status !== 0 || typeof r.stdout !== "string") return result;

      const portSuffix = `:${port}`;
      const pids = new Set<string>();
      for (const rawLine of r.stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const tokens = line.split(/\s+/);
        // netstat -ano LISTENING row (en-US): "TCP  0.0.0.0:4747  0.0.0.0:0  LISTENING  1234"
        // The STATE column is locale-translated and may itself contain spaces
        // (Windows-FR `À l'écoute` splits into two tokens), so we cannot index
        // STATE by position. PID is always the trailing column; PROTO/LOCAL/
        // REMOTE are the first three. We anchor on those + a remote-wildcard
        // check that's locale-independent.
        if (tokens.length < 5) continue;
        const proto = tokens[0];
        const local = tokens[1];
        const remote = tokens[2];
        const pid = tokens[tokens.length - 1];
        if (proto !== "TCP") continue;
        if (!local.endsWith(portSuffix)) continue;
        // Listening sockets carry a wildcard remote; anything else is a
        // connection (and matching it would kill an unrelated process).
        if (remote !== "0.0.0.0:0" && remote !== "[::]:0") continue;
        if (!/^\d+$/.test(pid)) continue;
        pids.add(pid);
      }
      for (const pid of pids) {
        result.attemptedPids.push(pid);
        try {
          const k = runner("taskkill", ["/F", "/PID", pid], {
            stdio: "ignore",
            timeout: HELPER_SPAWN_TIMEOUT_MS,
          });
          if (k.error || k.status !== 0) {
            result.errors.push(
              `taskkill ${pid}: ${k.error?.message ?? `status=${k.status}`}`,
            );
          } else {
            result.killedPids.push(pid);
          }
        } catch (e) {
          result.errors.push(`taskkill ${pid}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else {
      const r = runner("lsof", ["-ti", `:${port}`], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: HELPER_SPAWN_TIMEOUT_MS,
      });
      if (r.error) {
        // ENOENT (lsof not installed) is a real diagnostic; surface it.
        result.errors.push(`lsof: ${r.error.message}`);
        return result;
      }
      // lsof exits 1 with empty stdout when the port is free — not an error.
      if (r.status !== 0 || typeof r.stdout !== "string") return result;

      const pids = r.stdout.split(/\r?\n/).filter(p => /^\d+$/.test(p));
      for (const pid of pids) {
        result.attemptedPids.push(pid);
        try {
          const k = runner("kill", [pid], {
            stdio: "ignore",
            timeout: HELPER_SPAWN_TIMEOUT_MS,
          });
          if (k.error || k.status !== 0) {
            result.errors.push(
              `kill ${pid}: ${k.error?.message ?? `status=${k.status}`}`,
            );
          } else {
            result.killedPids.push(pid);
          }
        } catch (e) {
          result.errors.push(`kill ${pid}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
  }
  return result;
}

// ── ctx-insight: analytics dashboard ──────────────────────────────────────────
server.registerTool(
  "ctx_insight",
  {
    title: "Open Insight Dashboard",
    description:
      "Opens the context-mode Insight dashboard in the browser. " +
      "Shows personal analytics: session activity, tool usage, error rate, " +
      "parallel work patterns, project focus, and actionable insights. " +
      "First run installs dependencies (~30s). Subsequent runs open instantly.",
    inputSchema: z.object({
      port: z.coerce.number().int().min(1).max(65535).optional().describe("Port to serve on (default: 4747)"),
      sessionDir: z.string().optional().describe("Override INSIGHT_SESSION_DIR: directory containing context-mode session .db files"),
      contentDir: z.string().optional().describe("Override INSIGHT_CONTENT_DIR: directory containing context-mode content/index .db files"),
      insightSessionDir: z.string().optional().describe("Alias for sessionDir / INSIGHT_SESSION_DIR"),
      insightContentDir: z.string().optional().describe("Alias for contentDir / INSIGHT_CONTENT_DIR"),
    }),
  },
  async ({ port: userPort, sessionDir, contentDir, insightSessionDir, insightContentDir }) => {
    const port = userPort || 4747;
    const explicitSessionDir = sessionDir || insightSessionDir;
    const explicitContentDir = contentDir || insightContentDir;
    // __pkg_dir is build/ for tsc, plugin root for bundle — resolve to plugin root
    const pluginRoot = existsSync(resolve(__pkg_dir, "package.json")) ? __pkg_dir : dirname(__pkg_dir);
    const insightSource = resolve(pluginRoot, "insight");
    // Use adapter-aware path by default, but allow MCP callers to pass explicit
    // Insight data dirs for hosts whose adapter/default detection is unavailable.
    const sessDir = explicitSessionDir ? resolve(explicitSessionDir) : getSessionDir();
    const insightContentDirResolved = explicitContentDir ? resolve(explicitContentDir) : join(dirname(sessDir), "content");
    const cacheDir = join(dirname(sessDir), "insight-cache");

    // Verify source exists
    if (!existsSync(join(insightSource, "server.mjs"))) {
      return trackResponse("ctx_insight", {
        content: [{ type: "text" as const, text: "Error: Insight source not found in plugin. Try upgrading context-mode." }],
      });
    }

    try {
      const steps: string[] = [];
      let sourceUpdated = false;

      // Ensure cache dir
      mkdirSync(cacheDir, { recursive: true });

      // Copy source files if needed (check by comparing server.mjs mtime)
      const srcMtime = statSync(join(insightSource, "server.mjs")).mtimeMs;
      const cacheMtime = existsSync(join(cacheDir, "server.mjs"))
        ? statSync(join(cacheDir, "server.mjs")).mtimeMs : 0;

      if (srcMtime > cacheMtime) {
        steps.push("Copying source files...");
        cpSync(insightSource, cacheDir, { recursive: true, force: true });
        steps.push("Source files copied.");
        sourceUpdated = true;
      }

      // Install deps if needed (also reinstall when source updated and package.json may have changed)
      const hasNodeModules = existsSync(join(cacheDir, "node_modules"));
      if (!hasNodeModules || sourceUpdated) {
        steps.push("Installing dependencies (first run, ~30s)...");
        try {
          execSync(process.platform === "win32" ? "npm.cmd install --production=false" : "npm install --production=false", {
            cwd: cacheDir,
            stdio: "pipe",
            timeout: 300000,
          });
        } catch {
          // Clean up partial install so next run retries fresh
          try { rmSync(join(cacheDir, "node_modules"), { recursive: true, force: true }); } catch {}
          throw new Error("npm install failed — please retry");
        }
        // Sentinel check: verify install completed (cold cache can timeout leaving partial node_modules)
        if (!existsSync(join(cacheDir, "node_modules", "vite")) || !existsSync(join(cacheDir, "node_modules", "better-sqlite3"))) {
          rmSync(join(cacheDir, "node_modules"), { recursive: true, force: true });
          throw new Error("npm install incomplete — please retry");
        }
        steps.push("Dependencies installed.");
      }

      // Build
      steps.push("Building dashboard...");
      execSync("npx vite build", {
        cwd: cacheDir,
        stdio: "pipe",
        timeout: 60000,
      });
      steps.push("Build complete.");

      // Pre-check: is port already in use?
      let portOccupied = false;
      try {
        const { request } = await import("node:http");
        await new Promise<void>((resolve, reject) => {
          const req = request(`http://127.0.0.1:${port}/api/overview`, { timeout: 2000 }, (res) => {
            res.resume();
            resolve(); // port is responding = already running
          });
          req.on("error", () => reject()); // port free
          req.on("timeout", () => { req.destroy(); reject(); });
          req.end();
        });
        portOccupied = true;
      } catch {
        // Port is free, proceed with spawn
      }

      if (portOccupied && sourceUpdated) {
        // Source was updated but stale server is running on port — kill it so fresh code runs
        steps.push("Killing stale dashboard server (source updated)...");
        const kill = killProcessOnPort(port);
        if (kill.attemptedPids.length > 0 && kill.killedPids.length === 0) {
          // Tried to kill, every attempt failed (perms, race, missing binary).
          // Surface so the agent doesn't loop on the same port forever.
          return trackResponse("ctx_insight", {
            content: [{
              type: "text" as const,
              text: `Could not free port ${port} (kill failed for ${kill.attemptedPids.join(", ")}: ${kill.errors.join("; ")}). Try ctx_insight({ port: ${port + 1} }) or stop the process manually.`,
            }],
          });
        }
        if (kill.errors.length > 0 && kill.attemptedPids.length === 0) {
          // Couldn't even probe the port (e.g. lsof not installed).
          return trackResponse("ctx_insight", {
            content: [{
              type: "text" as const,
              text: `Cannot reclaim port ${port}: ${kill.errors.join("; ")}. Stop the process manually or pick another port.`,
            }],
          });
        }
        await new Promise(r => setTimeout(r, 500)); // Wait for port to free
        steps.push(`Stale server killed (${kill.killedPids.length} pid${kill.killedPids.length === 1 ? "" : "s"}).`);
      } else if (portOccupied) {
        // Source unchanged, server is running fine — just open browser
        steps.push("Dashboard already running.");
        const url = `http://localhost:${port}`;
        const open = openBrowserSync(url);
        const tail = open.ok
          ? ""
          : ` (auto-open failed: ${open.reason}; navigate manually)`;
        return trackResponse("ctx_insight", {
          content: [{ type: "text" as const, text: `Dashboard already running at ${url}${tail}` }],
        });
      }

      // Kill any previous insight child this MCP spawned (e.g. re-invocation).
      if (_insightChild && _insightChild.pid && !_insightChild.killed) {
        try { _insightChild.kill("SIGTERM"); } catch { /* best effort */ }
      }

      // Start server in background. `detached: true` keeps MCP stdio free, but
      // we track the handle and kill it in shutdown() so the dashboard does
      // not orphan when Claude closes. The child also watches INSIGHT_PARENT_PID
      // as a fallback for SIGKILL/crash paths.
      const { spawn } = await import("node:child_process");
      const child = spawn("node", [join(cacheDir, "server.mjs")], {
        cwd: cacheDir,
        env: {
          ...process.env,
          PORT: String(port),
          INSIGHT_SESSION_DIR: sessDir,
          INSIGHT_CONTENT_DIR: insightContentDirResolved,
          INSIGHT_PARENT_PID: String(process.pid),
        },
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {}); // prevent unhandled error crash
      child.unref();
      _insightChild = child;

      // Wait for server to be ready
      await new Promise(r => setTimeout(r, 1500));

      // Verify server is actually running
      try {
        const { request } = await import("node:http");
        await new Promise<void>((resolve, reject) => {
          const req = request(`http://127.0.0.1:${port}/api/overview`, { timeout: 3000 }, (res) => {
            resolve();
            res.resume();
          });
          req.on("error", reject);
          req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
          req.end();
        });
      } catch {
        // Server didn't start — likely port in use
        return trackResponse("ctx_insight", {
          content: [{
            type: "text" as const,
            text: `Port ${port} appears to be in use. Either a previous dashboard is still running, or another service is using this port.\n\nTo fix:\n- Kill the existing process: ${process.platform === "win32" ? `netstat -ano | findstr :${port}` : `lsof -ti:${port} | xargs kill`}\n- Or use a different port: ctx_insight({ port: ${port + 1} })`,
          }],
        });
      }

      // Open browser (cross-platform)
      const url = `http://localhost:${port}`;
      const open = openBrowserSync(url);
      const openTail = open.ok ? "" : ` (auto-open failed: ${open.reason}; navigate manually)`;

      steps.push(`Dashboard running at ${url}${openTail}`);

      return trackResponse("ctx_insight", {
        content: [{
          type: "text" as const,
          text: steps.map(s => `- ${s}`).join("\n") + `\n\nOpen: ${url}\nPID: ${child.pid} · Stop: ${process.platform === "win32" ? `taskkill /PID ${child.pid} /F` : `kill ${child.pid}`}`,
        }],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_insight", {
        content: [{ type: "text" as const, text: `Insight setup failed: ${msg}` }],
      });
    }
  },
);

// ─────────────────────────────────────────────────────────
// Server startup
// ─────────────────────────────────────────────────────────

async function main() {
  // Clean up stale DB files from previous sessions
  const cleaned = cleanupStaleDBs();
  if (cleaned > 0) {
    console.error(`Cleaned up ${cleaned} stale DB file(s) from previous sessions`);
  }

  // MCP readiness sentinel path (#230, #347)
  // Uses process.pid (not ppid) — hooks use directory-scan to find any live sentinel.
  // Hardcoded /tmp on Unix to avoid TMPDIR mismatch (#347).
  const mcpSentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
  const mcpSentinel = join(mcpSentinelDir, `context-mode-mcp-ready-${process.pid}`);

  // Clean up own DB + backgrounded processes + preload script on shutdown
  const shutdown = () => {
    executor.cleanupBackgrounded();
    if (_store) _store.close(); // persist DB for --continue sessions
    try { unlinkSync(CM_FS_PRELOAD); } catch { /* best effort */ }
    // Remove MCP readiness sentinel (#230)
    try { unlinkSync(mcpSentinel); } catch { /* best effort */ }
    // Stop ctx_insight dashboard so it does not outlive Claude.
    if (_insightChild && _insightChild.pid && !_insightChild.killed) {
      try { _insightChild.kill("SIGTERM"); } catch { /* best effort */ }
    }
  };
  const gracefulShutdown = async () => {
    // Final stats flush — bypass throttle so the last 0-500ms of
    // bytes_indexed / bytes_returned aren't silently lost on SIGTERM/SIGINT
    // (PR #401 grill-me review B1: persistStats early-returns inside throttle
    // window; gracefulShutdown previously did NOT bypass).
    try {
      _lastStatsPersist = 0;
      persistStats();
    } catch { /* best effort — never block shutdown */ }
    shutdown();
    process.exit(0);
  };
  process.on("exit", shutdown);
  process.on("SIGINT", () => { gracefulShutdown(); });
  process.on("SIGTERM", () => { gracefulShutdown(); });

  // Lifecycle guard: detect parent death + stdin close to prevent orphaned processes (#103)
  startLifecycleGuard({ onShutdown: () => gracefulShutdown() });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Write MCP readiness sentinel (#230)
  try { writeFileSync(mcpSentinel, String(process.pid)); } catch { /* best effort */ }

  // Detect platform adapter — stored for platform-aware session paths
  try {
    const { detectPlatform, getAdapter } = await import("./adapters/detect.js");
    const clientInfo = server.server.getClientVersion();
    const signal = detectPlatform(clientInfo ?? undefined);
    _detectedAdapter = await getAdapter(signal.platform);
    if (clientInfo) {
      console.error(`MCP client: ${clientInfo.name} v${clientInfo.version} → ${signal.platform}`);
    }
  } catch { /* best effort — _detectedAdapter stays null, falls back to .claude */ }

  // Restore tool-call counters from SessionDB BEFORE the heartbeat fires
  // so the very first persistStats() carries the prior PID's totals into
  // the sidecar JSON the statusline reads. Otherwise `/ctx-upgrade` flashes
  // `0 calls / $0.00` until the user makes another MCP tool call. Wrapped
  // in try/catch — a stats-restore failure must never block server startup.
  try {
    const restored = restoreSessionStats(getSessionDbPath());
    if (restored) {
      for (const [tool, count] of Object.entries(restored.calls)) {
        sessionStats.calls[tool] = count;
      }
      for (const [tool, bytes] of Object.entries(restored.bytesReturned)) {
        sessionStats.bytesReturned[tool] = bytes;
      }
      // Anchor uptime_ms to the original session start so `/ctx-upgrade`
      // doesn't reset the "session age" the statusline shows.
      if (restored.sessionStart > 0) {
        sessionStats.sessionStart = restored.sessionStart;
      }
    }
  } catch { /* best effort — never block startup on a stats restore failure */ }

  // Non-blocking version check — result stored for trackResponse warnings.
  // First fetch at startup, then refresh every hour so long-running sessions
  // (some users keep the MCP server alive 24h+) catch new releases without a
  // restart. `.unref()` lets the process exit normally on SIGTERM regardless
  // of pending intervals.
  fetchLatestVersion().then(v => { if (v !== "unknown") _latestVersion = v; });
  setInterval(() => {
    fetchLatestVersion().then(v => { if (v !== "unknown") _latestVersion = v; });
  }, 60 * 60 * 1000).unref();

  // Stats heartbeat — keep the statusline truthful while the user works in
  // tools other than MCP (Bash/Read/Edit during long sessions or post-/compact
  // pauses). Without this, stats.updated_at only advances on MCP tool calls,
  // so bin/statusline.mjs falsely flips to "stale — restart to resume saving"
  // even though the server is alive. Heartbeat refreshes updated_at every 60s;
  // statusline staleness threshold is 30min (cliff is 30 missed ticks away).
  setInterval(() => persistStats(), 60_000).unref();

  if (process.stdin.isTTY) {
    console.error(`Context Mode MCP server v${VERSION} running on stdio`);
    console.error(`Detected runtimes:\n${getRuntimeSummary(runtimes)}`);
    if (!hasBunRuntime()) {
      console.error(
        "\nPerformance tip: Install Bun for 3-5x faster JS/TS execution",
      );
      console.error("  curl -fsSL https://bun.sh/install | bash");
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
