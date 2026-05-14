/**
 * AnalyticsEngine — Runtime savings + session continuity reporting.
 *
 * Computes context-window savings from runtime stats and queries
 * session continuity data from SessionDB.
 *
 * Usage:
 *   const engine = new AnalyticsEngine(sessionDb);
 *   const report = engine.queryAll(runtimeStats);
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { loadDatabase as loadDatabaseImpl } from "../db-base.js";
import { resolveClaudeConfigDir } from "../util/claude-config.js";

function semverNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}


// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/** Database adapter — anything with a prepare() method (better-sqlite3, bun:sqlite, etc.) */
export interface DatabaseAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Context savings result (#1) */
export interface ContextSavings {
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
  savedPercent: number;
}

/** Think in code comparison result (#2) */
export interface ThinkInCodeComparison {
  fileBytes: number;
  outputBytes: number;
  ratio: number;
}

/** Tool-level savings result (#3) */
export interface ToolSavingsRow {
  tool: string;
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
}

/** Sandbox I/O result (#19) */
export interface SandboxIO {
  inputBytes: number;
  outputBytes: number;
}

/** MCP tool usage row — concurrency stats for batch-style tools. */
export interface McpToolUsageRow {
  tool_name: string;
  calls: number;
  median_concurrency: number | null;
  max_concurrency: number | null;
}

/**
 * Conversation-scoped stats — aggregated from `session_events` for a single
 * `session_id` across every worktree DB plus the compact-rescue snapshot from
 * `session_resume`. Replaces the broken in-memory `tool_call_counter` that
 * only saw `ctx_*` MCP calls and reset to 0 every time the MCP server PID
 * changed (which is what made hours-of-work conversations show "1 call · 5 KB").
 */
export interface ConversationStats {
  /** session_id this aggregate covers (the current Claude Code conversation). */
  sessionId: string;
  /** Total event count for this session_id, summed across all DBs. */
  events: number;
  /** Distinct DB files this session_id appeared in (a rotation indicator). */
  dbCount: number;
  /** Wall-clock days from first to last event. Captures real activity length. */
  daysAlive: number;
  /** Bytes restored from the compact snapshot for this session_id. 0 if no compact. */
  snapshotBytes: number;
  /** Number of compact snapshots consumed for this session_id. */
  snapshotsConsumed: number;
  /** Category breakdown for this session_id. */
  byCategory: Array<{ category: string; count: number; label: string }>;
  /**
   * Earliest event timestamp (ms epoch) for this session_id across every DB.
   * Used by the section-1 "started X" line in the narrative renderer. 0 when
   * the session has no events yet. Optional for back-compat with older
   * callers / fixtures that pre-date the narrative layout.
   */
  firstEventMs?: number;
  /** Latest event timestamp (ms epoch) — pairs with firstEventMs. */
  lastEventMs?: number;
  /**
   * Wall-clock timestamp of the most recent /compact rescue for this session.
   * Drives the "On <datetime>, /compact fired" line in section 1. Undefined
   * when the conversation has never been compacted.
   */
  lastRescueMs?: number;
  /**
   * Per-day capture breakdown for the section-1 horizontal timeline. Each
   * entry is one calendar day (UTC midnight ms) with that day's event count
   * + optional rescueBytes when /compact fired on that day. Empty array
   * when no events recorded yet.
   */
  byDay?: Array<{ ms: number; count: number; rescueBytes?: number }>;
}

// ─────────────────────────────────────────────────────────
// Runtime stats — passed in from server.ts (can't come from DB)
// ─────────────────────────────────────────────────────────

/** Runtime stats tracked by server.ts during a live session. */
export interface RuntimeStats {
  bytesReturned: Record<string, number>;
  bytesIndexed: number;
  bytesSandboxed: number;
  calls: Record<string, number>;
  sessionStart: number;
  cacheHits: number;
  cacheBytesSaved: number;
}

// ─────────────────────────────────────────────────────────
// FullReport — single unified object returned by queryAll()
// ─────────────────────────────────────────────────────────

/** Unified report combining runtime stats, DB analytics, and continuity data. */
export interface FullReport {
  /** Runtime context savings (passed in, not from DB) */
  savings: {
    processed_kb: number;
    entered_kb: number;
    saved_kb: number;
    pct: number;
    savings_ratio: number;
    by_tool: Array<{ tool: string; calls: number; context_kb: number; tokens: number }>;
    total_calls: number;
    total_bytes_returned: number;
    kept_out: number;
    total_processed: number;
  };
  cache?: {
    hits: number;
    bytes_saved: number;
    ttl_hours_left: number;
    total_with_cache: number;
    total_savings_ratio: number;
  };
  /** Session metadata from SessionDB */
  session: {
    id: string;
    uptime_min: string;
  };
  /** Session continuity data */
  continuity: {
    total_events: number;
    by_category: Array<{
      category: string;
      count: number;
      label: string;
      preview: string;
      why: string;
    }>;
    compact_count: number;
    resume_ready: boolean;
  };
  /** Persistent project memory — all events across all sessions */
  projectMemory: {
    total_events: number;
    session_count: number;
    by_category: Array<{ category: string; count: number; label: string }>;
  };
}

// ─────────────────────────────────────────────────────────
// Category labels and hints for session continuity display
// ─────────────────────────────────────────────────────────

/**
 * Human-readable labels for event categories.
 *
 * Each label is a sentence-case phrase that reads like a benefit, not a
 * column name. The user shouldn't see raw schema words like "external-ref"
 * or "agent-finding" — those leak the database into the UX. When a new
 * category lands without an entry here, the renderer falls through to the
 * raw category id; that's a copy-debt signal, fix it here.
 */
export const categoryLabels: Record<string, string> = {
  // Code & filesystem
  file: "Files tracked",
  cwd: "Working directory",
  // Configuration & intent
  rule: "Project rules (CLAUDE.md)",
  prompt: "Your requests saved",
  intent: "Session goal",
  role: "Behavior rules",
  constraint: "Constraints you set",
  // Tools & delegation
  mcp: "MCP tools called",
  skill: "Skills used",
  subagent: "Delegated work",
  // Knowledge & decisions
  decision: "Your decisions",
  "agent-finding": "Agent insights kept",
  "rejected-approach": "Approaches you rejected",
  "external-ref": "External docs indexed",
  data: "Data references",
  // System events
  git: "Git operations",
  env: "Environment setup",
  task: "Tasks in progress",
  error: "Errors caught",
  // Continuity proof
  compact: "Compactions weathered",
  resume: "Sessions resumed cleanly",
  snapshot: "Snapshots restored",
  cache: "Cache hits saved",
  // Operational
  latency: "Slow tools recorded",
  "user-prompt": "Your messages remembered",
  plan: "Plans drafted",
  "blocked-on": "Blockers logged",
};

/** Explains why each category matters for continuity. */
export const categoryHints: Record<string, string> = {
  file: "Restored after compact — no need to re-read",
  rule: "Your project instructions survive context resets",
  prompt: "Continues exactly where you left off",
  decision: "Applied automatically — won’t ask again",
  task: "Picks up from where it stopped",
  error: "Tracked and monitored across compacts",
  git: "Branch, commit, and repo state preserved",
  env: "Runtime config carried forward",
  mcp: "Tool usage patterns remembered",
  subagent: "Delegation history preserved",
  skill: "Skill invocations tracked",
};

// ─────────────────────────────────────────────────────────
// AnalyticsEngine
// ─────────────────────────────────────────────────────────

export class AnalyticsEngine {
  private readonly db: DatabaseAdapter;

  /**
   * Create an AnalyticsEngine.
   *
   * Accepts either a SessionDB instance (extracts internal db via
   * the protected getter — use the static fromDB helper for raw adapters)
   * or any object with a prepare() method for direct usage.
   */
  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  // ═══════════════════════════════════════════════════════
  // GROUP 3 — Runtime (4 metrics, stubs)
  // ═══════════════════════════════════════════════════════

  /**
   * #1 Context Savings Total — bytes kept out of context window.
   *
   * Stub: requires server.ts to accumulate rawBytes and contextBytes
   * during a live session. Call with tracked values.
   */
  static contextSavingsTotal(rawBytes: number, contextBytes: number): ContextSavings {
    const savedBytes = rawBytes - contextBytes;
    const savedPercent = rawBytes > 0
      ? Math.round((savedBytes / rawBytes) * 1000) / 10
      : 0;
    return { rawBytes, contextBytes, savedBytes, savedPercent };
  }

  /**
   * #2 Think in Code Comparison — ratio of file size to sandbox output size.
   *
   * Stub: requires server.ts tracking of execute/execute_file calls.
   */
  static thinkInCodeComparison(fileBytes: number, outputBytes: number): ThinkInCodeComparison {
    const ratio = outputBytes > 0
      ? Math.round((fileBytes / outputBytes) * 10) / 10
      : 0;
    return { fileBytes, outputBytes, ratio };
  }

  /**
   * #3 Tool Savings — per-tool breakdown of context savings.
   *
   * Stub: requires per-tool accumulators in server.ts.
   */
  static toolSavings(
    tools: Array<{ tool: string; rawBytes: number; contextBytes: number }>,
  ): ToolSavingsRow[] {
    return tools.map((t) => ({
      ...t,
      savedBytes: t.rawBytes - t.contextBytes,
    }));
  }

  /**
   * #19 Sandbox I/O — total input/output bytes processed by the sandbox.
   *
   * Stub: requires PolyglotExecutor byte counters.
   */
  static sandboxIO(inputBytes: number, outputBytes: number): SandboxIO {
    return { inputBytes, outputBytes };
  }

  /**
   * MCP tool usage — call counts and concurrency stats per MCP tool.
   *
   * Reads `mcp_tool_call` events, parses the JSON payload, and aggregates:
   *  - call count per tool_name
   *  - median + max of `params.concurrency` (only for tools that take it,
   *    e.g. ctx_batch_execute, ctx_fetch_and_index). Returns null when the
   *    tool doesn't carry a concurrency param so callers can render N/A.
   *
   * Best-effort: malformed rows or truncated payloads are skipped silently.
   */
  getMcpToolUsage(): McpToolUsageRow[] {
    let rows: Array<{ data: string }>;
    try {
      rows = this.db.prepare(
        "SELECT data FROM session_events WHERE category = 'mcp_tool_call'",
      ).all() as Array<{ data: string }>;
    } catch {
      return [];
    }

    // toolName -> { calls, concurrencies }
    const agg = new Map<string, { calls: number; concurrencies: number[] }>();

    for (const row of rows) {
      let parsed: { tool_name?: unknown; params?: unknown; truncated?: unknown };
      try {
        parsed = JSON.parse(row.data);
      } catch {
        continue;
      }
      const toolName = typeof parsed.tool_name === "string" ? parsed.tool_name : null;
      if (!toolName) continue;

      const bucket = agg.get(toolName) ?? { calls: 0, concurrencies: [] };
      bucket.calls += 1;

      // Skip concurrency extraction when the row was truncated — the params
      // blob is a substring of JSON that may not parse cleanly.
      if (parsed.truncated !== true && parsed.params && typeof parsed.params === "object") {
        const c = (parsed.params as Record<string, unknown>).concurrency;
        if (typeof c === "number" && Number.isFinite(c) && c > 0) {
          bucket.concurrencies.push(c);
        }
      }

      agg.set(toolName, bucket);
    }

    const out: McpToolUsageRow[] = [];
    for (const [tool_name, b] of agg) {
      let median: number | null = null;
      let max: number | null = null;
      if (b.concurrencies.length > 0) {
        const sorted = [...b.concurrencies].sort((a, c) => a - c);
        const mid = Math.floor(sorted.length / 2);
        median = sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
        max = sorted[sorted.length - 1];
      }
      out.push({
        tool_name,
        calls: b.calls,
        median_concurrency: median,
        max_concurrency: max,
      });
    }

    // Stable sort: most-called first, then alphabetical
    out.sort((a, c) => c.calls - a.calls || a.tool_name.localeCompare(c.tool_name));
    return out;
  }

  // ═══════════════════════════════════════════════════════
  // queryAll — single unified report from ONE source
  // ═══════════════════════════════════════════════════════

  /**
   * Build a FullReport by merging runtime stats (passed in)
   * with continuity data from the DB.
   *
   * This is the ONE call that ctx_stats should use.
   */
  queryAll(runtimeStats: RuntimeStats): FullReport {
    // ── Resolve latest session ID ──
    const latestSession = this.db.prepare(
      "SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1",
    ).get() as { session_id: string } | undefined;
    const sid = latestSession?.session_id ?? "";

    // ── Runtime savings ──
    const totalBytesReturned = Object.values(runtimeStats.bytesReturned).reduce(
      (sum, b) => sum + b, 0,
    );
    const totalCalls = Object.values(runtimeStats.calls).reduce(
      (sum, c) => sum + c, 0,
    );
    const keptOut = runtimeStats.bytesIndexed + runtimeStats.bytesSandboxed;
    const totalProcessed = keptOut + totalBytesReturned;
    const savingsRatio = totalProcessed / Math.max(totalBytesReturned, 1);
    const reductionPct = totalProcessed > 0
      ? Math.round((1 - totalBytesReturned / totalProcessed) * 100)
      : 0;

    const toolNames = new Set([
      ...Object.keys(runtimeStats.calls),
      ...Object.keys(runtimeStats.bytesReturned),
    ]);
    const byTool = Array.from(toolNames).sort().map((tool) => ({
      tool,
      calls: runtimeStats.calls[tool] || 0,
      context_kb: Math.round((runtimeStats.bytesReturned[tool] || 0) / 1024 * 10) / 10,
      tokens: Math.round((runtimeStats.bytesReturned[tool] || 0) / 4),
    }));

    const uptimeMs = Date.now() - runtimeStats.sessionStart;
    const uptimeMin = (uptimeMs / 60_000).toFixed(1);

    // ── Cache ──
    let cache: FullReport["cache"];
    if (runtimeStats.cacheHits > 0 || runtimeStats.cacheBytesSaved > 0) {
      const totalWithCache = totalProcessed + runtimeStats.cacheBytesSaved;
      const totalSavingsRatio = totalWithCache / Math.max(totalBytesReturned, 1);
      const ttlHoursLeft = Math.max(0, 24 - Math.floor((Date.now() - runtimeStats.sessionStart) / (60 * 60 * 1000)));
      cache = {
        hits: runtimeStats.cacheHits,
        bytes_saved: runtimeStats.cacheBytesSaved,
        ttl_hours_left: ttlHoursLeft,
        total_with_cache: totalWithCache,
        total_savings_ratio: totalSavingsRatio,
      };
    }

    // ── Continuity data (scoped to current session) ──
    const eventTotal = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ?",
    ).get(sid) as { cnt: number }).cnt;

    const byCategory = this.db.prepare(
      "SELECT category, COUNT(*) as cnt FROM session_events WHERE session_id = ? GROUP BY category ORDER BY cnt DESC",
    ).all(sid) as Array<{ category: string; cnt: number }>;

    const meta = this.db.prepare(
      "SELECT compact_count FROM session_meta WHERE session_id = ?",
    ).get(sid) as { compact_count: number } | undefined;
    const compactCount = meta?.compact_count ?? 0;

    const resume = this.db.prepare(
      "SELECT event_count, consumed FROM session_resume WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(sid) as { event_count: number; consumed: number } | undefined;
    const resumeReady = resume ? !resume.consumed : false;

    // Build category previews (current session only)
    const previewRows = this.db.prepare(
      "SELECT category, type, data FROM session_events WHERE session_id = ? ORDER BY id DESC",
    ).all(sid) as Array<{ category: string; type: string; data: string }>;

    const previews = new Map<string, Set<string>>();
    for (const row of previewRows) {
      if (!previews.has(row.category)) previews.set(row.category, new Set());
      const set = previews.get(row.category)!;
      if (set.size < 5) {
        let display = row.data;
        if (row.category === "file") {
          display = row.data.split("/").pop() || row.data;
        } else if (row.category === "prompt" || row.category === "user-prompt") {
          display = display.length > 50 ? display.slice(0, 47) + "..." : display;
        }
        if (display.length > 40) display = display.slice(0, 37) + "...";
        set.add(display);
      }
    }

    const continuityByCategory = byCategory.map((row) => ({
      category: row.category,
      count: row.cnt,
      label: categoryLabels[row.category] || row.category,
      preview: previews.get(row.category)
        ? Array.from(previews.get(row.category)!).join(", ")
        : "",
      why: categoryHints[row.category] || "Survives context resets",
    }));

    // ── Project-wide persistent memory (all sessions, no session_id filter) ──
    const projectTotals = this.db.prepare(
      "SELECT COUNT(*) as cnt, COUNT(DISTINCT session_id) as sessions FROM session_events",
    ).get() as { cnt: number; sessions: number };

    const projectByCategory = this.db.prepare(
      "SELECT category, COUNT(*) as cnt FROM session_events GROUP BY category ORDER BY cnt DESC",
    ).all() as Array<{ category: string; cnt: number }>;

    const projectMemoryByCategory = projectByCategory
      .filter((row) => row.cnt > 0)
      .map((row) => ({
        category: row.category,
        count: row.cnt,
        label: categoryLabels[row.category] || row.category,
      }));

    return {
      savings: {
        processed_kb: Math.round(totalProcessed / 1024 * 10) / 10,
        entered_kb: Math.round(totalBytesReturned / 1024 * 10) / 10,
        saved_kb: Math.round(keptOut / 1024 * 10) / 10,
        pct: reductionPct,
        savings_ratio: Math.round(savingsRatio * 10) / 10,
        by_tool: byTool,
        total_calls: totalCalls,
        total_bytes_returned: totalBytesReturned,
        kept_out: keptOut,
        total_processed: totalProcessed,
      },
      cache,
      session: {
        id: sid,
        uptime_min: uptimeMin,
      },
      continuity: {
        total_events: eventTotal,
        by_category: continuityByCategory,
        compact_count: compactCount,
        resume_ready: resumeReady,
      },
      projectMemory: {
        total_events: projectTotals.cnt,
        session_count: projectTotals.sessions,
        by_category: projectMemoryByCategory,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────
// Adapter dir enumeration (B3a multi-adapter aggregation)
// ─────────────────────────────────────────────────────────

/**
 * Where one adapter stores its context-mode sidecars on disk. Mirrors the
 * map in `src/adapters/detect.ts:92-111` (`getSessionDirSegments`) so we
 * never go out of sync as a single source of truth.
 *
 * `sessionsDir` = `<home>/<segments>/context-mode/sessions`
 * `contentDir`  = `<home>/<segments>/context-mode/content`
 *
 * Why duplicated here: `getSessionDirSegments` returns segments relative to
 * `homedir()`; analytics needs the absolute joined paths for both `sessions`
 * and `content` siblings. Keeping a parallel hard-coded list avoids importing
 * detect.ts (which pulls in adapter loaders) into the stats path.
 */
export interface AdapterDirEntry {
  /** Adapter id matching `src/adapters/detect.ts` PlatformId. */
  name: string;
  /** Absolute path to `<home>/<segments>/context-mode/sessions`. */
  sessionsDir: string;
  /** Absolute path to `<home>/<segments>/context-mode/content`. */
  contentDir: string;
}

/**
 * Enumerate every known adapter's sessions + content dirs under `home`.
 * Used by `getMultiAdapterLifetimeStats` and `getMultiAdapterRealBytesStats`
 * so a single call surfaces "your work everywhere on this machine across
 * all AI tools" (the marketing line).
 *
 * Returns ALL 15 adapters even when the dir doesn't exist on disk — the
 * scanner functions filter to existing dirs. That keeps the enumeration
 * pure / testable without filesystem dependencies.
 */
export function enumerateAdapterDirs(opts?: { home?: string }): AdapterDirEntry[] {
  const home = opts?.home ?? homedir();
  // Mirrors `getSessionDirSegments` in src/adapters/detect.ts:92-111.
  const map: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["claude-code",      [".claude"]],
    ["gemini-cli",       [".gemini"]],
    ["antigravity",      [".gemini"]],
    ["openclaw",         [".openclaw"]],
    ["codex",            [".codex"]],
    ["cursor",           [".cursor"]],
    ["vscode-copilot",   [".vscode"]],
    ["kiro",             [".kiro"]],
    ["pi",               [".pi"]],
    ["omp",              [".omp"]],
    ["qwen-code",        [".qwen"]],
    ["kilo",             [".config", "kilo"]],
    ["opencode",         [".config", "opencode"]],
    ["zed",              [".config", "zed"]],
    ["jetbrains-copilot", [".config", "JetBrains"]],
  ];
  return map.map(([name, segments]) => {
    const base = join(home, ...segments, "context-mode");
    return {
      name,
      sessionsDir: join(base, "sessions"),
      contentDir: join(base, "content"),
    };
  });
}

// ─────────────────────────────────────────────────────────
// Lifetime stats (Bug #3 + #4)
// ─────────────────────────────────────────────────────────

/** Aggregated stats spanning every SessionDB + auto-memory under the user's profile. */
export interface LifetimeStats {
  totalEvents: number;
  totalSessions: number;
  autoMemoryCount: number;
  autoMemoryProjects: number;
  /** Per-prefix breakdown of auto-memory files (user/feedback/project/...). */
  autoMemoryByPrefix: Record<string, number>;
  /**
   * Per-category event counts aggregated across every SessionDB on disk.
   * Keys are the raw category strings (file/cwd/rule/...) — the renderer
   * looks them up against `categoryLabels` for display. Empty `{}` when no
   * sidecar has any events. Optional for back-compat with older fixtures.
   */
  categoryCounts: Record<string, number>;
  /**
   * Total bytes restored from compact-rescue snapshots across every DB on
   * disk. Adds the rescue benefit to lifetime $ so the headline isn't
   * silently undercounting the killer feature. 0 when no compact has fired
   * or older fixtures don't pass this. Optional for back-compat with tests.
   */
  rescueBytes?: number;
  /**
   * Earliest event timestamp (ms epoch) across every DB. Used for the
   * "since 2026-04-14" lifetime narrative. 0 when unknown. Optional.
   */
  firstEventMs?: number;
  /**
   * Distinct project_dir count across every DB. Different from
   * `autoMemoryProjects` (which only counts dirs with auto-memory files).
   * Captures every cwd context-mode has ever seen events for. Optional.
   */
  distinctProjects?: number;
}

/** Extract leading prefix from auto-memory filename: `feedback_push.md` → `feedback`. */
function autoMemoryPrefix(filename: string): string {
  const base = filename.replace(/\.md$/i, "");
  const m = base.match(/^([a-z]+)/i);
  return m ? m[1].toLowerCase() : "other";
}

/**
 * Aggregate lifetime stats from all SessionDB files in `sessionsDir` and
 * all auto-memory markdown files under `memoryRoot/<project>/memory/`.
 *
 * Best-effort: silently ignores missing/unreadable files so ctx_stats
 * can never be broken by a corrupt sidecar.
 */
export function getLifetimeStats(opts?: {
  sessionsDir?: string;
  memoryRoot?: string;
  /** Override for tests — defaults to db-base loadDatabase(). */
  loadDatabase?: () => unknown;
}): LifetimeStats {
  // Issue #460 round-3: route through resolveClaudeConfigDir so lifetime
  // stats aggregation tracks $CLAUDE_CONFIG_DIR instead of the literal
  // ~/.claude tree. Otherwise users who relocate config see "no sessions"
  // even though the SessionDB sidecars exist under the override.
  const claudeRoot = resolveClaudeConfigDir();
  const sessionsDir = opts?.sessionsDir
    ?? join(claudeRoot, "context-mode", "sessions");
  const memoryRoot = opts?.memoryRoot
    ?? join(claudeRoot, "projects");

  let totalEvents = 0;
  let totalSessions = 0;
  let rescueBytes = 0;
  let firstEventMs = Number.POSITIVE_INFINITY;
  const distinctProjectsSet = new Set<string>();
  const categoryCounts: Record<string, number> = {};

  // ── SessionDB aggregation ──
  if (existsSync(sessionsDir)) {
    let dbFiles: string[] = [];
    try {
      dbFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".db"));
    } catch { /* unreadable */ }

    if (dbFiles.length > 0) {
      // Lazy-load better-sqlite3 / bun-sqlite via the same path the runtime uses.
      let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
      try {
        DatabaseCtor = opts?.loadDatabase
          ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>)
          : loadDatabaseImpl();
      } catch { /* sqlite unavailable */ }

      if (DatabaseCtor) {
        for (const file of dbFiles) {
          const dbPath = join(sessionsDir, file);
          try {
            const sdb = new DatabaseCtor(dbPath, { readonly: true });
            try {
              const ev = sdb.prepare("SELECT COUNT(*) AS cnt FROM session_events").get() as { cnt: number } | undefined;
              const ss = sdb.prepare("SELECT COUNT(*) AS cnt FROM session_meta").get() as { cnt: number } | undefined;
              totalEvents += ev?.cnt ?? 0;
              totalSessions += ss?.cnt ?? 0;
              // Per-category aggregation across every sidecar so the
              // Persistent memory bars stay populated even when the
              // current project's local DB is fresh / empty.
              try {
                const catRows = sdb.prepare(
                  "SELECT category, COUNT(*) AS cnt FROM session_events GROUP BY category",
                ).all() as Array<{ category: string; cnt: number }>;
                for (const row of catRows) {
                  if (!row.category) continue;
                  categoryCounts[row.category] = (categoryCounts[row.category] ?? 0) + (row.cnt ?? 0);
                }
              } catch {
                // older schema / no category column — ignore
              }
              // Lifetime rescue: compact-snapshot bytes restored across every DB.
              // Without this, the lifetime $ silently undercounts the killer
              // continuity-after-/compact feature.
              try {
                const snap = sdb.prepare(
                  "SELECT COALESCE(SUM(length(snapshot)), 0) AS bytes FROM session_resume WHERE consumed = 1",
                ).get() as { bytes: number } | undefined;
                if (snap?.bytes) rescueBytes += snap.bytes;
              } catch { /* old schema */ }
              // Earliest event timestamp + distinct project_dirs for the
              // "since X · Y projects" lifetime narrative.
              try {
                const mn = sdb.prepare(
                  "SELECT MIN(created_at) AS t FROM session_events",
                ).get() as { t: string | null } | undefined;
                if (mn?.t) {
                  const stamp = mn.t.endsWith("Z") ? mn.t : mn.t + "Z";
                  const ms = Date.parse(stamp);
                  if (Number.isFinite(ms) && ms < firstEventMs) firstEventMs = ms;
                }
              } catch { /* old schema */ }
              try {
                const projRows = sdb.prepare(
                  "SELECT DISTINCT project_dir AS p FROM session_events WHERE project_dir != ''",
                ).all() as Array<{ p: string }>;
                for (const row of projRows) if (row.p) distinctProjectsSet.add(row.p);
              } catch { /* old schema */ }
            } finally {
              sdb.close();
            }
          } catch {
            // missing tables / corrupt file — skip
          }
        }
      }
    }
  }

  // ── Auto-memory file scan ──
  let autoMemoryCount = 0;
  let autoMemoryProjects = 0;
  const autoMemoryByPrefix: Record<string, number> = {};

  if (existsSync(memoryRoot)) {
    let projectDirs: string[] = [];
    try {
      projectDirs = readdirSync(memoryRoot).filter((entry) => {
        try {
          return statSync(join(memoryRoot, entry)).isDirectory();
        } catch { return false; }
      });
    } catch { /* unreadable */ }

    for (const proj of projectDirs) {
      const memDir = join(memoryRoot, proj, "memory");
      if (!existsSync(memDir)) continue;
      let mdFiles: string[] = [];
      try {
        mdFiles = readdirSync(memDir).filter((f) => f.endsWith(".md"));
      } catch { continue; }
      if (mdFiles.length === 0) continue;
      autoMemoryProjects++;
      autoMemoryCount += mdFiles.length;
      for (const f of mdFiles) {
        const prefix = autoMemoryPrefix(f);
        autoMemoryByPrefix[prefix] = (autoMemoryByPrefix[prefix] ?? 0) + 1;
      }
    }
  }

  return {
    totalEvents,
    totalSessions,
    autoMemoryCount,
    autoMemoryProjects,
    autoMemoryByPrefix,
    categoryCounts,
    rescueBytes,
    firstEventMs: Number.isFinite(firstEventMs) ? firstEventMs : 0,
    distinctProjects: distinctProjectsSet.size,
  };
}

/**
 * Aggregate every event for one `session_id` across all SessionDB files in
 * `sessionsDir` plus the compact-rescue snapshot bytes from `session_resume`.
 *
 * Why this exists: the Claude Code session_id can persist across days while
 * the underlying DB file rotates (size cap), and a compact-rescue snapshot
 * carries hundreds of KB of context that would otherwise have been lost. The
 * old in-memory `tool_call_counter` saw none of this — it counted only `ctx_*`
 * MCP calls against the current MCP server PID and reset on every restart.
 * Reading from `session_events` + `session_resume` is the source-of-truth
 * version that matches what users actually experienced.
 */
export function getConversationStats(opts: {
  sessionId: string;
  sessionsDir?: string;
  /** Optional worktree filename prefix (sha256(cwd)[:16]). When omitted, scans every DB. */
  worktreeHash?: string;
  loadDatabase?: () => unknown;
}): ConversationStats {
  const sessionsDir = opts.sessionsDir
    ?? join(homedir(), ".claude", "context-mode", "sessions");
  const sessionId = opts.sessionId;

  const empty: ConversationStats = {
    sessionId,
    events: 0,
    dbCount: 0,
    daysAlive: 0,
    snapshotBytes: 0,
    snapshotsConsumed: 0,
    byCategory: [],
  };
  if (!sessionId || !existsSync(sessionsDir)) return empty;

  let dbFiles: string[] = [];
  try {
    dbFiles = readdirSync(sessionsDir).filter((f) => {
      if (!f.endsWith(".db")) return false;
      if (opts.worktreeHash && !f.startsWith(opts.worktreeHash)) return false;
      return true;
    });
  } catch { return empty; }
  if (dbFiles.length === 0) return empty;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = opts.loadDatabase
      ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>)
      : loadDatabaseImpl();
  } catch { return empty; }
  if (!DatabaseCtor) return empty;

  const catCounts: Record<string, number> = {};
  let events = 0;
  let dbCount = 0;
  let snapshotBytes = 0;
  let snapshotsConsumed = 0;
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = 0;
  let lastRescueMs = 0;
  // Per-day captures aggregated across every DB. Key is the UTC midnight ms
  // of the day; value tracks both the event count and any rescueBytes (latter
  // overlays the ◆ /compact glyph in the section-1 horizontal timeline).
  const byDayMap = new Map<number, { count: number; rescueBytes: number }>();
  const dayKey = (ms: number): number => Math.floor(ms / 86_400_000) * 86_400_000;

  for (const file of dbFiles) {
    const dbPath = join(sessionsDir, file);
    let touched = false;
    try {
      const sdb = new DatabaseCtor(dbPath, { readonly: true });
      try {
        const cats = sdb.prepare(
          "SELECT category, COUNT(*) AS cnt FROM session_events WHERE session_id = ? GROUP BY category",
        ).all(sessionId) as Array<{ category: string; cnt: number }>;
        for (const row of cats) {
          if (!row.category) continue;
          catCounts[row.category] = (catCounts[row.category] ?? 0) + (row.cnt ?? 0);
          events += row.cnt ?? 0;
          touched = true;
        }
        const range = sdb.prepare(
          "SELECT MIN(created_at) AS mn, MAX(created_at) AS mx FROM session_events WHERE session_id = ?",
        ).get(sessionId) as { mn: string | null; mx: string | null } | undefined;
        if (range?.mn) {
          const t = Date.parse(range.mn + (range.mn.endsWith("Z") ? "" : "Z"));
          if (Number.isFinite(t) && t < firstMs) firstMs = t;
        }
        if (range?.mx) {
          const t = Date.parse(range.mx + (range.mx.endsWith("Z") ? "" : "Z"));
          if (Number.isFinite(t) && t > lastMs) lastMs = t;
        }
        // Per-day captures + per-day rescue overlay for the narrative timeline.
        // Best-effort: silently skip when the schema lacks created_at.
        try {
          const dayRows = sdb.prepare(
            "SELECT strftime('%s', created_at) AS sec, COUNT(*) AS cnt FROM session_events WHERE session_id = ? GROUP BY date(created_at)",
          ).all(sessionId) as Array<{ sec: string | null; cnt: number }>;
          for (const row of dayRows) {
            if (!row.sec) continue;
            const ms = parseInt(row.sec, 10) * 1000;
            if (!Number.isFinite(ms)) continue;
            const k = dayKey(ms);
            const cur = byDayMap.get(k) ?? { count: 0, rescueBytes: 0 };
            cur.count += row.cnt ?? 0;
            byDayMap.set(k, cur);
          }
        } catch { /* old schema */ }
        try {
          const snap = sdb.prepare(
            "SELECT COALESCE(SUM(length(snapshot)), 0) AS bytes, COUNT(*) AS n, MAX(strftime('%s', created_at)) AS lastSec FROM session_resume WHERE session_id = ? AND consumed = 1",
          ).get(sessionId) as { bytes: number; n: number; lastSec: string | null } | undefined;
          if (snap?.bytes) snapshotBytes += snap.bytes;
          if (snap?.n) snapshotsConsumed += snap.n;
          if (snap?.lastSec) {
            const t = parseInt(snap.lastSec, 10) * 1000;
            if (Number.isFinite(t) && t > lastRescueMs) lastRescueMs = t;
            // Overlay the rescue bytes onto the day bucket for the timeline.
            if (Number.isFinite(t) && (snap?.bytes ?? 0) > 0) {
              const k = dayKey(t);
              const cur = byDayMap.get(k) ?? { count: 0, rescueBytes: 0 };
              cur.rescueBytes = Math.max(cur.rescueBytes, snap.bytes);
              byDayMap.set(k, cur);
            }
          }
        } catch { /* old schema */ }
      } finally {
        sdb.close();
      }
    } catch { /* missing tables / corrupt */ }
    if (touched) dbCount++;
  }

  const daysAlive = firstMs < lastMs ? (lastMs - firstMs) / 86_400_000 : 0;
  const byCategory = Object.entries(catCounts)
    .filter(([, n]) => n > 0)
    .map(([category, count]) => ({
      category,
      count,
      label: categoryLabels[category] || category,
    }))
    .sort((a, b) => b.count - a.count);
  const byDay = [...byDayMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, v]) => ({
      ms,
      count: v.count,
      ...(v.rescueBytes > 0 ? { rescueBytes: v.rescueBytes } : {}),
    }));

  return {
    sessionId,
    events,
    dbCount,
    daysAlive,
    snapshotBytes,
    snapshotsConsumed,
    byCategory,
    firstEventMs: Number.isFinite(firstMs) ? firstMs : 0,
    lastEventMs:  lastMs > 0 ? lastMs : 0,
    lastRescueMs: lastRescueMs > 0 ? lastRescueMs : undefined,
    byDay,
  };
}

// ─────────────────────────────────────────────────────────
// getRealBytesStats — Phase 8 of D2 PRD (stats-event-driven-architecture)
// ─────────────────────────────────────────────────────────

/**
 * Real-bytes counter the renderer uses to replace the conservative
 * `events × 256` token estimate. Reads four sources from disk and
 * returns the sum the renderer divides by 4 to get tokens.
 *
 * - `eventDataBytes`  = SUM(LENGTH(data))      FROM session_events
 * - `bytesAvoided`    = SUM(bytes_avoided)     FROM session_events
 * - `bytesReturned`   = SUM(bytes_returned)    FROM session_events
 * - `snapshotBytes`   = SUM(LENGTH(snapshot))  FROM session_resume
 * - `totalSavedTokens` = (eventDataBytes + bytesAvoided + snapshotBytes) / 4
 *
 * `bytesReturned` is reported but NOT folded into `totalSavedTokens`
 * because it represents bytes the model already paid for — adding it
 * would double-count what's already on the user's invoice.
 */
export interface RealBytesStats {
  eventDataBytes: number;
  bytesAvoided: number;
  bytesReturned: number;
  snapshotBytes: number;
  totalSavedTokens: number;
}

/**
 * Compute real-bytes stats across one session, one project (worktree
 * filter), or every session on disk (lifetime).
 *
 * - Pass `sessionId` for the conversation tier.
 * - Pass `worktreeHash` to filter `*.db` files by name prefix
 *   (per-project lifetime — `sha256(cwd).slice(0, 16)`).
 * - Pass neither — full lifetime aggregate.
 *
 * Best-effort: returns zeroes when the dir is missing, the DB is
 * corrupt, or the session has no events. Never throws — same
 * contract as `getConversationStats` / `getLifetimeStats` so the
 * stats-render path can never crash on a bad sidecar.
 */
export function getRealBytesStats(opts: {
  sessionId?: string;
  sessionsDir?: string;
  worktreeHash?: string;
  loadDatabase?: () => unknown;
}): RealBytesStats {
  const empty: RealBytesStats = {
    eventDataBytes: 0,
    bytesAvoided: 0,
    bytesReturned: 0,
    snapshotBytes: 0,
    totalSavedTokens: 0,
  };

  const sessionsDir = opts.sessionsDir
    ?? join(homedir(), ".claude", "context-mode", "sessions");
  if (!existsSync(sessionsDir)) return empty;

  let dbFiles: string[] = [];
  try {
    dbFiles = readdirSync(sessionsDir).filter((f) => {
      if (!f.endsWith(".db")) return false;
      if (opts.worktreeHash && !f.startsWith(opts.worktreeHash)) return false;
      return true;
    });
  } catch { return empty; }
  if (dbFiles.length === 0) return empty;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = opts.loadDatabase
      ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>)
      : loadDatabaseImpl();
  } catch { return empty; }
  if (!DatabaseCtor) return empty;

  let eventDataBytes = 0;
  let bytesAvoided = 0;
  let bytesReturned = 0;
  let snapshotBytes = 0;

  // Each branch returns the tuple in the SAME column order so callers
  // don't need to type-narrow per row.
  for (const file of dbFiles) {
    const dbPath = join(sessionsDir, file);
    try {
      const sdb = new DatabaseCtor(dbPath, { readonly: true });
      try {
        if (opts.sessionId) {
          const row = sdb.prepare(
            `SELECT
               COALESCE(SUM(LENGTH(data)), 0)   AS data_bytes,
               COALESCE(SUM(bytes_avoided), 0)  AS bytes_avoided,
               COALESCE(SUM(bytes_returned), 0) AS bytes_returned
             FROM session_events WHERE session_id = ?`,
          ).get(opts.sessionId) as
            | { data_bytes: number; bytes_avoided: number; bytes_returned: number }
            | undefined;
          if (row) {
            eventDataBytes += Number(row.data_bytes ?? 0);
            bytesAvoided   += Number(row.bytes_avoided ?? 0);
            bytesReturned  += Number(row.bytes_returned ?? 0);
          }
          try {
            const snap = sdb.prepare(
              "SELECT COALESCE(SUM(LENGTH(snapshot)), 0) AS bytes FROM session_resume WHERE session_id = ?",
            ).get(opts.sessionId) as { bytes: number } | undefined;
            if (snap?.bytes) snapshotBytes += Number(snap.bytes);
          } catch { /* old schema */ }
        } else {
          const row = sdb.prepare(
            `SELECT
               COALESCE(SUM(LENGTH(data)), 0)   AS data_bytes,
               COALESCE(SUM(bytes_avoided), 0)  AS bytes_avoided,
               COALESCE(SUM(bytes_returned), 0) AS bytes_returned
             FROM session_events`,
          ).get() as
            | { data_bytes: number; bytes_avoided: number; bytes_returned: number }
            | undefined;
          if (row) {
            eventDataBytes += Number(row.data_bytes ?? 0);
            bytesAvoided   += Number(row.bytes_avoided ?? 0);
            bytesReturned  += Number(row.bytes_returned ?? 0);
          }
          try {
            const snap = sdb.prepare(
              "SELECT COALESCE(SUM(LENGTH(snapshot)), 0) AS bytes FROM session_resume",
            ).get() as { bytes: number } | undefined;
            if (snap?.bytes) snapshotBytes += Number(snap.bytes);
          } catch { /* old schema */ }
        }
      } finally {
        sdb.close();
      }
    } catch { /* missing tables / corrupt — skip */ }
  }

  const totalSavedTokens = Math.floor(
    (eventDataBytes + bytesAvoided + snapshotBytes) / 4,
  );

  return { eventDataBytes, bytesAvoided, bytesReturned, snapshotBytes, totalSavedTokens };
}

// ─────────────────────────────────────────────────────────
// Multi-adapter aggregation (B3a — "your work everywhere")
// ─────────────────────────────────────────────────────────

/**
 * Real-usage filter thresholds. Decided in the B3a /diagnose conversation
 * to suppress fixture-noise dirs (test runs that touched ~/.X but never
 * carried real user work).
 *
 * An adapter is `isReal=true` iff ALL four hold:
 *   eventCount     >= 100
 *   distinctProjects >= 5
 *   lastActivity within 30 days
 *   avgEventBytes  >= 50
 *
 * Tuneable via `getMultiAdapterLifetimeStats({ filter })` for testing.
 */
export interface RealUsageFilter {
  minEvents?: number;
  minProjects?: number;
  recencyMs?: number;
  minAvgBytes?: number;
  /** Fixed "now" timestamp for deterministic testing. Defaults to Date.now(). */
  nowMs?: number;
}

const DEFAULT_REAL_USAGE_FILTER: Required<Omit<RealUsageFilter, "nowMs">> = {
  minEvents: 100,
  minProjects: 5,
  recencyMs: 30 * 86_400_000,
  minAvgBytes: 50,
};

/** Per-adapter scan result returned by {@link scanOneAdapter}. */
export interface AdapterScanResult {
  /** Adapter id (matches `enumerateAdapterDirs().name`). */
  name: string;
  /** Total event rows across every `*.db` in this adapter's sessions dir. */
  eventCount: number;
  /** Total distinct session_meta rows across every db. */
  sessionCount: number;
  /** Sum of LENGTH(data) across every session_event row. */
  dataBytes: number;
  /** Sum of LENGTH(snapshot) across consumed compact-rescue snapshots. */
  rescueBytes: number;
  /** Reserved for future content/ scan (B3b). 0 today. */
  contentBytes: number;
  /** Distinct session_id count across all dbs (alias of sessionCount). */
  uuidConvs: number;
  /** Distinct project_dir values across all session_events. */
  projectDirs: string[];
  /** Earliest event ms epoch (Number.POSITIVE_INFINITY when no events). */
  firstMs: number;
  /** Latest event ms epoch (0 when no events). */
  lastMs: number;
  /** Real-usage flag — see {@link RealUsageFilter}. */
  isReal: boolean;
}

/**
 * Scan one adapter's sessions dir. Always returns a result — never throws.
 * When the dir is missing, the result has zeroed counts and `isReal=false`.
 *
 * Mirrors the inner SessionDB-walk inside `getLifetimeStats`
 * (analytics.ts:677-752) so the new multi-adapter path stays in lock-step
 * with the per-DB queries the single-dir path already trusts.
 */
function scanOneAdapter(
  entry: AdapterDirEntry,
  loadDb: () => unknown,
  filter: Required<Omit<RealUsageFilter, "nowMs">> & { nowMs: number },
): AdapterScanResult {
  const result: AdapterScanResult = {
    name: entry.name,
    eventCount: 0,
    sessionCount: 0,
    dataBytes: 0,
    rescueBytes: 0,
    contentBytes: 0,
    uuidConvs: 0,
    projectDirs: [],
    firstMs: Number.POSITIVE_INFINITY,
    lastMs: 0,
    isReal: false,
  };
  if (!existsSync(entry.sessionsDir)) return result;

  let dbFiles: string[] = [];
  try {
    dbFiles = readdirSync(entry.sessionsDir).filter((f) => f.endsWith(".db"));
  } catch { return result; }
  if (dbFiles.length === 0) return result;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = loadDb() as ReturnType<typeof loadDatabaseImpl>;
  } catch { return result; }
  if (!DatabaseCtor) return result;

  const projectsSet = new Set<string>();
  const sessionsSet = new Set<string>();

  for (const file of dbFiles) {
    const dbPath = join(entry.sessionsDir, file);
    try {
      const sdb = new DatabaseCtor(dbPath, { readonly: true });
      try {
        const ev = sdb.prepare(
          "SELECT COUNT(*) AS cnt, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM session_events",
        ).get() as { cnt: number; bytes: number } | undefined;
        if (ev) {
          result.eventCount += Number(ev.cnt ?? 0);
          result.dataBytes  += Number(ev.bytes ?? 0);
        }
        try {
          const ss = sdb.prepare(
            "SELECT COUNT(*) AS cnt FROM session_meta",
          ).get() as { cnt: number } | undefined;
          result.sessionCount += Number(ss?.cnt ?? 0);
        } catch { /* old schema */ }
        try {
          const snap = sdb.prepare(
            "SELECT COALESCE(SUM(length(snapshot)), 0) AS bytes FROM session_resume WHERE consumed = 1",
          ).get() as { bytes: number } | undefined;
          if (snap?.bytes) result.rescueBytes += Number(snap.bytes);
        } catch { /* old schema */ }
        try {
          const range = sdb.prepare(
            "SELECT MIN(created_at) AS mn, MAX(created_at) AS mx FROM session_events",
          ).get() as { mn: string | null; mx: string | null } | undefined;
          if (range?.mn) {
            const t = Date.parse(range.mn + (range.mn.endsWith("Z") ? "" : "Z"));
            if (Number.isFinite(t) && t < result.firstMs) result.firstMs = t;
          }
          if (range?.mx) {
            const t = Date.parse(range.mx + (range.mx.endsWith("Z") ? "" : "Z"));
            if (Number.isFinite(t) && t > result.lastMs) result.lastMs = t;
          }
        } catch { /* old schema */ }
        try {
          const projRows = sdb.prepare(
            "SELECT DISTINCT project_dir AS p FROM session_events WHERE project_dir != ''",
          ).all() as Array<{ p: string }>;
          for (const row of projRows) if (row.p) projectsSet.add(row.p);
        } catch { /* old schema */ }
        try {
          const sidRows = sdb.prepare(
            "SELECT DISTINCT session_id AS s FROM session_events",
          ).all() as Array<{ s: string }>;
          for (const row of sidRows) if (row.s) sessionsSet.add(row.s);
        } catch { /* old schema */ }
      } finally {
        sdb.close();
      }
    } catch { /* missing tables / corrupt — skip */ }
  }

  result.projectDirs = Array.from(projectsSet);
  result.uuidConvs = sessionsSet.size;

  // Real-usage filter — see RealUsageFilter docstring.
  const avgBytes = result.eventCount > 0 ? result.dataBytes / result.eventCount : 0;
  const recentEnough =
    result.lastMs > 0 && (filter.nowMs - result.lastMs) <= filter.recencyMs;
  result.isReal =
    result.eventCount  >= filter.minEvents &&
    projectsSet.size   >= filter.minProjects &&
    recentEnough &&
    avgBytes           >= filter.minAvgBytes;

  return result;
}

/** Aggregated multi-adapter lifetime stats. */
export interface MultiAdapterLifetimeStats {
  /** Sum of eventCount across every adapter that exists on disk. */
  totalEvents: number;
  /** Sum of sessionCount across every adapter. */
  totalSessions: number;
  /** Sum of dataBytes + rescueBytes across every adapter. */
  totalBytes: number;
  /** Per-adapter rows for adapters that have >= one .db file. */
  perAdapter: AdapterScanResult[];
}

/**
 * Aggregate lifetime stats across every adapter dir under `home`.
 * The marketing line — "your work everywhere on this machine across all
 * AI tools" — depends on this. Existing `getLifetimeStats` (single dir)
 * is untouched; this is purely additive.
 */
export function getMultiAdapterLifetimeStats(opts?: {
  home?: string;
  loadDatabase?: () => unknown;
  filter?: RealUsageFilter;
}): MultiAdapterLifetimeStats {
  const dirs = enumerateAdapterDirs({ home: opts?.home });
  const loadDb = opts?.loadDatabase ?? loadDatabaseImpl;
  const filter = {
    ...DEFAULT_REAL_USAGE_FILTER,
    ...(opts?.filter ?? {}),
    nowMs: opts?.filter?.nowMs ?? Date.now(),
  };

  const perAdapter: AdapterScanResult[] = [];
  let totalEvents = 0;
  let totalSessions = 0;
  let totalBytes = 0;

  for (const entry of dirs) {
    if (!existsSync(entry.sessionsDir)) continue; // only surface adapters with a sessions dir
    const r = scanOneAdapter(entry, loadDb, filter);
    perAdapter.push(r);
    totalEvents   += r.eventCount;
    totalSessions += r.sessionCount;
    totalBytes    += r.dataBytes + r.rescueBytes;
  }

  return { totalEvents, totalSessions, totalBytes, perAdapter };
}

/** Aggregated multi-adapter real-bytes stats. */
export interface MultiAdapterRealBytesStats extends RealBytesStats {
  /** Per-adapter row in the same shape as {@link RealBytesStats}, keyed by name. */
  perAdapter: Array<RealBytesStats & { name: string }>;
}

/**
 * Aggregate real-bytes stats across every adapter dir under `home`.
 * Mirrors `getRealBytesStats` (single dir, analytics.ts:887-989) but
 * iterates {@link enumerateAdapterDirs}. Optional `sessionId` /
 * `worktreeHash` filters apply uniformly to every dir.
 */
export function getMultiAdapterRealBytesStats(opts?: {
  home?: string;
  sessionId?: string;
  worktreeHash?: string;
  loadDatabase?: () => unknown;
}): MultiAdapterRealBytesStats {
  const dirs = enumerateAdapterDirs({ home: opts?.home });

  const sum: RealBytesStats = {
    eventDataBytes: 0,
    bytesAvoided: 0,
    bytesReturned: 0,
    snapshotBytes: 0,
    totalSavedTokens: 0,
  };
  const perAdapter: MultiAdapterRealBytesStats["perAdapter"] = [];

  for (const entry of dirs) {
    if (!existsSync(entry.sessionsDir)) continue;
    const one = getRealBytesStats({
      sessionsDir: entry.sessionsDir,
      sessionId: opts?.sessionId,
      worktreeHash: opts?.worktreeHash,
      loadDatabase: opts?.loadDatabase,
    });
    perAdapter.push({ name: entry.name, ...one });
    sum.eventDataBytes += one.eventDataBytes;
    sum.bytesAvoided   += one.bytesAvoided;
    sum.bytesReturned  += one.bytesReturned;
    sum.snapshotBytes  += one.snapshotBytes;
  }
  sum.totalSavedTokens = Math.floor(
    (sum.eventDataBytes + sum.bytesAvoided + sum.snapshotBytes) / 4,
  );

  return { ...sum, perAdapter };
}

/**
 * Marketing-grade labels for auto-memory file prefixes. The renderer sees raw
 * filename prefixes (`project_codex_hooks.md` → `project`) — without this map
 * the user gets schema words in the UI, which leaks the database into UX.
 */
export const autoMemoryLabels: Record<string, string> = {
  project: "What you're building",
  feedback: "How you work",
  user: "Who you are",
  reference: "Where to look",
  memory: "Long-term context",
  other: "Other notes",
};

/**
 * Marketing-grade labels for adapter ids surfaced by
 * {@link enumerateAdapterDirs} / {@link getMultiAdapterLifetimeStats}.
 * The renderer never shows raw IDs — UX uses the names users see in
 * each tool's own surface area.
 */
export const adapterLabels: Record<string, string> = {
  "claude-code":       "Claude Code",
  "gemini-cli":        "Gemini CLI",
  "antigravity":       "Antigravity",
  "openclaw":          "Openclaw",
  "codex":             "Codex CLI",
  "cursor":            "Cursor",
  "vscode-copilot":    "VS Code Copilot",
  "kiro":              "Kiro",
  "pi":                "Pi",
  "omp":               "OMP",
  "qwen-code":         "Qwen Code",
  "kilo":              "Kilo",
  "opencode":          "OpenCode",
  "zed":               "Zed",
  "jetbrains-copilot": "JetBrains",
};

/** Look up an adapter's marketing label. Falls back to the raw id. */
function adapterLabel(name: string): string {
  return adapterLabels[name] ?? name;
}

// ─────────────────────────────────────────────────────────
// formatReport — renders FullReport as sales-grade savings dashboard
// ─────────────────────────────────────────────────────────

/**
 * Format a byte count for the narrative dashboard.
 *
 * Single-unit auto-scale (Grafana / CloudWatch / Datadog convention).
 * Decimals shrink as the integer part grows so the number stays readable
 * at every magnitude. Max output width is 8 characters which fits the
 * existing `padStart(8)` callsites in Sections 1, 3, 4.
 *
 *   < 1 KB              → "X B"        e.g. "100 B"
 *   1 KB   – < 100 KB   → "X.Y KB"     e.g. "4.7 KB",   "92.8 KB"
 *   100 KB – < 1 MB     → "X KB"       e.g. "227 KB",   "976 KB"
 *   1 MB   – < 100 MB   → "X.Y MB"     e.g. "4.5 MB",   "11.6 MB"
 *   100 MB – < 1 GB     → "X MB"       e.g. "178 MB",   "906 MB"
 *   1 GB   – < 100 GB   → "X.YY GB"    e.g. "1.00 GB",  "11.36 GB"
 *   ≥ 100 GB            → "X.Y GB"     e.g. "216.6 GB"
 *
 * Replaced the dual-unit "X KB (0.YY MB)" form because the parenthetical
 * rounded to 0.00 / 0.01 in the common range and added noise without
 * information. Scale awareness comes from the unit jump between rows.
 */
export function kb(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  if (b < 1024) return `${Math.round(b)} B`;

  const KB = b / 1024;
  if (KB < 1024) {
    return KB < 100 ? `${KB.toFixed(1)} KB` : `${Math.round(KB)} KB`;
  }

  const MB = KB / 1024;
  if (MB < 1024) {
    return MB < 100 ? `${MB.toFixed(1)} MB` : `${Math.round(MB)} MB`;
  }

  const GB = MB / 1024;
  return GB < 100 ? `${GB.toFixed(2)} GB` : `${GB.toFixed(1)} GB`;
}

/** Format session uptime as human-readable duration. */
function formatDuration(uptimeMin: string): string {
  const min = parseFloat(uptimeMin);
  if (isNaN(min) || min < 1) return "< 1 min";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Locale + IANA-timezone detection for the narrative renderer.
 *
 * Cascade (each level overrides the next):
 *   1. CONTEXT_MODE_LOCALE / CONTEXT_MODE_TZ env overrides
 *      (used by tests + by users who want to pin output regardless of OS).
 *   2. macOS `defaults read -g AppleLocale` → `en_TR` style → `en-TR`.
 *   3. Linux `LANG` / `LC_TIME` env vars.
 *   4. Fallback: `Intl.DateTimeFormat().resolvedOptions().locale`.
 *
 * Timezone always uses `Intl.DateTimeFormat().resolvedOptions().timeZone`
 * — that one's always available and correct regardless of platform.
 */
export function detectLocaleAndTz(): { locale: string; tz: string } {
  const env = (process.env ?? {}) as Record<string, string | undefined>;
  let locale = env.CONTEXT_MODE_LOCALE ?? "";
  if (!locale) {
    if (process.platform === "darwin") {
      try {
        // Top-level import — `require()` throws "Dynamic require ... not
        // supported" under esbuild's ESM shim and pure ESM Node, which silently
        // dropped this branch and forced en-US fallback in production.
        const out = execFileSync("defaults", ["read", "-g", "AppleLocale"], {
          encoding: "utf8",
          timeout: 500,
        }).trim();
        if (out) locale = out.replace(/_/g, "-");
      } catch { /* defaults missing or sandbox */ }
    }
    if (!locale && (env.LC_TIME || env.LANG)) {
      const raw = (env.LC_TIME || env.LANG || "").split(".")[0];
      if (raw) locale = raw.replace(/_/g, "-");
    }
    if (!locale) {
      try {
        locale = new Intl.DateTimeFormat().resolvedOptions().locale;
      } catch { locale = "en-US"; }
    }
  }

  let tz = env.CONTEXT_MODE_TZ ?? "";
  if (!tz) {
    try {
      tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch { tz = "UTC"; }
  }
  return { locale: locale || "en-US", tz: tz || "UTC" };
}

/**
 * Format an absolute path as a human-friendly display string by
 * collapsing `$HOME` → `~`. Returns the input unchanged when no home
 * prefix matches (e.g. for paths outside $HOME on a CI box).
 */
function shortPath(abs: string): string {
  const home = homedir();
  if (!home) return abs;
  if (abs === home) return "~";
  // Use platform separator so `C:\Users\Mert\projects\x` collapses to `~\projects\x`
  // on Windows; previous `home + "/"` check was vacuously false on Windows and
  // left full absolute paths in the Section 1 narrative opener (round-5 finding).
  if (abs.startsWith(home + sep)) return "~" + abs.slice(home.length);
  return abs;
}

/**
 * Render the section-4 "For example: what would that cost?" block.
 *
 * Translates a lifetime token total into a relatable Opus-4 dollar figure
 * + 3 tangible comparisons (Cursor Pro / Claude Max / weekends of API
 * coding) + 10-dev team scale projection + alternate-model scale row,
 * capped with an EXAMPLES disclaimer. The renderer is intentionally
 * liberal with rounding (whole-month Cursor counts, integer weekends)
 * because this section is illustrative — the EXAMPLES line tells users
 * not to confuse it for a bill.
 *
 * Returns [] when there's nothing to scale (lifetimeTokens === 0) so
 * the section disappears cleanly on a fresh install.
 *
 * Math constants:
 *   Opus 4   = $15.00 per 1M input tokens (matches OPUS_INPUT_PRICE_PER_TOKEN)
 *   Sonnet 4 = $3.00  per 1M input tokens
 *   GPT-4o   = $2.50  per 1M input tokens
 *   Gemini 2 = $1.25  per 1M input tokens
 *   Haiku 4  = $0.80  per 1M input tokens
 *   Cursor Pro       = $20  / month  → "X months of Cursor Pro"
 *   Claude Max       = $200 / month  → "X.X months of Claude Max"
 *   Weekend coding   ≈ $73.67        → "X weekends of nonstop API coding"
 *   Team multiplier  = 10×           → "At a 10-dev team scale: ~$X over Y days, or ~$Z/year"
 */
export function renderCostExample(
  lifetimeBytes: number,
  lifetimeTokens: number,
  lifetimeDays: number,
): string[] {
  if (!Number.isFinite(lifetimeTokens) || lifetimeTokens <= 0) return [];

  const opusUsd = (lifetimeTokens * 15) / 1_000_000;
  const usdStr  = (n: number, dp: number = 2): string => n.toFixed(dp);

  // Comparison units — kept locally so they're easy to tune without touching
  // the renderer logic. Cursor Pro & Claude Max are public list prices; the
  // weekend constant is an intentional approximation calibrated to make
  // $1399.73 → "19 weekends" line up with the demo target.
  const cursorMonths     = Math.round(opusUsd / 20);
  const claudeMaxMonths  = (opusUsd / 200).toFixed(1);
  const weekendCount     = Math.round(opusUsd / 73.67);
  const teamUsd          = Math.round(opusUsd * 10);
  const teamYearUsd      = lifetimeDays > 0
    ? Math.round((opusUsd * 10) / lifetimeDays * 365)
    : 0;

  // Alternate-model scale row — same token count, different per-1M rates.
  const sonnetUsd = ((lifetimeTokens * 3.0)  / 1_000_000).toFixed(2);
  const gpt4oUsd  = ((lifetimeTokens * 2.5)  / 1_000_000).toFixed(2);
  const geminiUsd = ((lifetimeTokens * 1.25) / 1_000_000).toFixed(2);
  const haikuUsd  = ((lifetimeTokens * 0.8)  / 1_000_000).toFixed(2);

  // Mert: "daha marketing ve business value e vermeli, math hesaplamalari ile
  // kalabalik yapma" — collapse the old 4-block render (5 prose lines + 3
  // comparison lines + 2 team lines + scaling table + disclaimer) into ONE
  // headline number, ONE relatable comparison, ONE team-scale callout. Drop
  // the alternate-model scaling row (engineer-curiosity, not value framing).
  const out: string[] = [];
  out.push(
    `  $${usdStr(opusUsd)} of Opus 4 tokens your team didn't burn.`,
  );
  out.push(
    `  context-mode kept ${kb(lifetimeBytes)} out of context — that's ${cursorMonths} months of Cursor Pro paid for itself.`,
  );
  if (teamUsd > 0 && teamYearUsd > 0) {
    out.push("");
    out.push(
      `  Scale across a 10-dev team and that's ~$${teamYearUsd.toLocaleString("en-US")}/year saved.`,
    );
  }
  out.push("");
  out.push(
    `  (Opus rates shown for context. On cheaper models the dollar number drops; the savings ratio holds.)`,
  );
  return out;
}

/**
 * Render the full 5-section narrative ("kitap gibi") layout — the
 * Mert-approved screenshot format the production ctx_stats handler
 * produces for users with conversation + lifetime + multi-adapter data.
 *
 * Order:
 *   Opener
 *   Section 1 — Where you are now            (datetime, /compact, timeline)
 *   Section 2 — What this chat captured      (per-category bars)
 *   Section 3 — The receipt — getting wider  (this conv vs all-work)
 *   Section 4 — For example: what would that cost?
 *   Section 5 — What context-mode learned about how you work (auto-memory)
 *   Footer
 *
 * Pure renderer: every input arrives via the args object so this
 * function is trivially testable end-to-end without mocking process or
 * Date. The caller (formatReport) is responsible for choosing a `now`
 * value that matches the conversation's age math and a `cwd` that
 * matches the user's project — defaults are sensible for production.
 */
function renderNarrative5Section(args: {
  conversation: ConversationStats;
  lifetime?: LifetimeStats;
  multiAdapter?: MultiAdapterLifetimeStats;
  realBytes?: { lifetime?: RealBytesStats; conversation?: RealBytesStats };
  cwd: string;
  locale: string;
  tz: string;
  now: number;
  version?: string;
  latestVersion?: string | null;
}): string[] {
  const { conversation, lifetime, multiAdapter, realBytes, cwd, locale, tz, now, version, latestVersion } = args;
  const out: string[] = [];

  // ── Token math (same monotonic-growth invariant as the legacy branch).
  const convEventsTokens = conversation.events * TOKENS_PER_EVENT;
  const convRescueTokens = Math.round((conversation.snapshotBytes ?? 0) / 4);
  const convLegacyTokens = convEventsTokens + convRescueTokens;
  const convRealTokens   = realBytes?.conversation?.totalSavedTokens ?? 0;
  const conversationTokens = Math.max(convLegacyTokens, convRealTokens);

  const lifetimeEventsTokens = (lifetime?.totalEvents ?? 0) * TOKENS_PER_EVENT;
  const lifetimeRescueTokens = Math.round((lifetime?.rescueBytes ?? 0) / 4);
  const lifetimeLegacyTokens = lifetimeEventsTokens + lifetimeRescueTokens;
  const lifetimeRealTokens   = realBytes?.lifetime?.totalSavedTokens ?? 0;
  const lifetimeTokensWithout = Math.max(lifetimeLegacyTokens, lifetimeRealTokens);
  // Lifetime "with" — measured when available, else legacy 0.02 fallback.
  // Honest definition (matches conversation bar below):
  //   "with"    = bytes_returned (what the model actually re-saw)
  //   "without" = bytes_returned + bytes_avoided
  // When the schema has measurement, derive `with` from `bytes_returned/4`.
  const lifeRet = realBytes?.lifetime?.bytesReturned ?? 0;
  const lifeAv  = realBytes?.lifetime?.bytesAvoided  ?? 0;
  const lifetimeTokensWith = (lifeRet + lifeAv) > 0
    ? Math.max(1, Math.floor(lifeRet / 4))
    : Math.max(1, Math.round(lifetimeTokensWithout * 0.02));

  // Bytes from realBytes when present, else derive from tokens (×4 — same
  // ratio Phase 8 uses everywhere). All-work bytes drives the opener tally
  // + the section-3 receipt + section-4 cost example.
  const lifetimeBytes = (multiAdapter?.totalBytes && multiAdapter.totalBytes > 0)
    ? multiAdapter.totalBytes
    : lifetimeTokensWithout * 4;
  const convBytes = realBytes?.conversation
    ? (realBytes.conversation.eventDataBytes + realBytes.conversation.bytesAvoided + realBytes.conversation.snapshotBytes)
    : conversationTokens * 4;

  // ── Days alive of THE CONVERSATION (section 1).
  const convDays = conversation.daysAlive >= 1
    ? `${conversation.daysAlive.toFixed(1)} days alive · still going`
    : `${Math.max(1, Math.round(conversation.daysAlive * 24))} hr alive · still going`;

  // ── Lifetime span (opener + receipt) — across every adapter / DB on disk.
  const sinceMs = lifetime?.firstEventMs ?? multiAdapter?.perAdapter?.[0]?.firstMs ?? 0;
  const lifetimeDays = sinceMs > 0
    ? Math.max(1, Math.round((now - sinceMs) / 86_400_000))
    : 0;
  const totalConversations = multiAdapter?.totalSessions ?? lifetime?.totalSessions ?? 1;
  const realAdapterCount = multiAdapter?.perAdapter.filter((a) => a.isReal).length ?? 0;
  let where: string;
  if (multiAdapter && realAdapterCount >= 2) {
    where = `across ${realAdapterCount} AI tools`;
  } else if (multiAdapter && realAdapterCount === 1) {
    const onlyReal = multiAdapter.perAdapter.find((a) => a.isReal);
    where = `in ${onlyReal ? adapterLabel(onlyReal.name) : "Claude Code"}`;
  } else {
    where = "in Claude Code";
  }

  // ── Opener.
  if (lifetimeDays > 0) {
    out.push(`  Across ${lifetimeDays} days you ran ${fmtNum(totalConversations)} conversations ${where}.`);
  } else {
    out.push(`  You ran ${fmtNum(totalConversations)} conversations ${where}.`);
  }
  // Daily-average sub-line — never tease users with a tiny number when the
  // average is sub-MB (still informative); fall back to KB display.
  const dailyBytes = lifetimeDays > 0 ? lifetimeBytes / lifetimeDays : 0;
  out.push(`  context-mode kept ${kb(lifetimeBytes)} out of your context window — about ${kb(dailyBytes)} every single day.`);
  out.push("");
  out.push("");

  // ── Section 1 — Where you are now.
  out.push("  ─── 1. Where you are now ───");
  out.push("");
  const startedStr = conversation.firstEventMs && conversation.firstEventMs > 0
    ? formatLocalDateTime(conversation.firstEventMs, locale, tz)
    : "";
  if (startedStr) {
    out.push(`  This conversation started ${startedStr} in ${shortPath(cwd)}.`);
  } else {
    out.push(`  This conversation lives in ${shortPath(cwd)}.`);
  }
  out.push(`  ${convDays}.`);
  if (conversation.snapshotsConsumed > 0 && conversation.snapshotBytes > 0) {
    const rescueAt = conversation.lastRescueMs && conversation.lastRescueMs > 0
      ? formatLocalDateTime(conversation.lastRescueMs, locale, tz)
      : "";
    const rescueKb = Math.round(conversation.snapshotBytes / 1024);
    if (rescueAt) {
      out.push(`  On ${rescueAt}, /compact fired — ${rescueKb} KB rescued from snapshot.`);
    } else {
      out.push(`  /compact fired — ${rescueKb} KB rescued from snapshot.`);
    }
    out.push(`  Without that, you'd be re-explaining everything to a blank model right now.`);
  }
  out.push("");

  // Without/With bars — measured from real per-event bytes_returned / bytes_avoided.
  //
  // Honest definitions:
  //   Without = bytes the model WOULD have re-seen with no filtering    = bytes_returned + bytes_avoided
  //   With    = bytes the model ACTUALLY re-saw after context-mode      = bytes_returned
  //
  // No fallback to heuristic. If the schema has zero signal for this
  // conversation (no hook ever populated bytes_avoided / bytes_returned),
  // the section is skipped entirely. Honesty over decoration.
  const realConv = realBytes?.conversation;
  const measuredAvoided  = realConv?.bytesAvoided  ?? 0;
  const measuredReturned = realConv?.bytesReturned ?? 0;

  if (measuredAvoided + measuredReturned > 0) {
    const convBytesWithout  = measuredReturned + measuredAvoided;
    const convBytesWith     = Math.max(1, measuredReturned);
    const convTokensWithout = Math.max(1, Math.floor(convBytesWithout / 4));
    const convTokensWith    = Math.max(1, Math.floor(convBytesWith    / 4));
    const withoutBar = dataBar(convTokensWithout, convTokensWithout, 32);
    const withBar    = dataBar(convTokensWith,    convTokensWithout, 32);
    const convPct    = (1 - convTokensWith / convTokensWithout) * 100;
    const convMult   = Math.max(1, Math.round(convTokensWithout / convTokensWith));
    out.push(`  Without context-mode  ${kb(convBytesWithout).padStart(8)}  ${withoutBar}   ${fmtNum(convTokensWithout).padStart(7)} tokens`);
    out.push(`  With context-mode     ${kb(convBytesWith).padStart(8)}  ${withBar}   ${fmtNum(convTokensWith).padStart(7)} tokens`);
    out.push(`                          ${convPct.toFixed(0)}% kept out of context · your AI ran ${convMult}× longer before /compact fired`);
    out.push("");
  }

  // Timeline — drop-in if conversation has byDay.
  if (conversation.byDay && conversation.byDay.length > 0) {
    const totalConvDays = conversation.lastEventMs && conversation.firstEventMs
      ? Math.max(1, Math.round((conversation.lastEventMs - conversation.firstEventMs) / 86_400_000) + 1)
      : conversation.byDay.length;
    out.push(`  How that ${kb(convBytes)} built up — ${totalConvDays} days, ${conversation.byDay.length} active:`);
    out.push("");
    out.push(...renderHorizontalTimeline(conversation.byDay, locale, tz));
  }
  out.push("");
  out.push("");

  // ── Section 2 — What this chat captured.
  out.push("  ─── 2. What this chat captured (used when you --continue or /resume here) ───");
  out.push("");
  const capturedTotal = conversation.byCategory.reduce((s, c) => s + c.count, 0);
  // Format with locale separator (en-* → "1,277"; en-TR → "1.277").
  const totalStr = capturedTotal.toLocaleString(locale);
  out.push(`  ${totalStr} things — files, errors, decisions, agent runs:`);
  out.push("");
  // ALL categories, no truncation (Slice 5).
  const max = conversation.byCategory[0]?.count ?? 1;
  for (const cat of conversation.byCategory) {
    out.push(`    ${cat.label.padEnd(26)} ${String(cat.count).padStart(5)}   ${dataBar(cat.count, max, 28)}`);
  }
  out.push("");
  out.push("");

  // ── Section 3 — Scope ladder, prose form (Mert: "cok daginik" → drop columns).
  // Two short sentences instead of a 4-column table — the same numbers framed
  // as "this chat" → "all your work" so the reader sees the scope getting wider
  // without being asked to scan a wide grid.
  out.push("  ─── 3. The scope, getting wider ───");
  out.push("");
  const convStartedYMD = conversation.firstEventMs && conversation.firstEventMs > 0
    ? new Intl.DateTimeFormat(locale, { timeZone: tz, year: "numeric", month: "short", day: "numeric" })
        .format(new Date(conversation.firstEventMs))
    : "";
  const lifeStartedYMD = sinceMs > 0
    ? new Intl.DateTimeFormat(locale, { timeZone: tz, year: "numeric", month: "short", day: "numeric" })
        .format(new Date(sinceMs))
    : "";
  const distinctProj = lifetime?.distinctProjects ?? 0;
  const allCaps = lifetime?.totalEvents ?? multiAdapter?.totalEvents ?? 0;
  out.push(
    `  This chat: ${kb(convBytes)} kept out · ${conversation.events.toLocaleString(locale)} captures${convStartedYMD ? ` · started ${convStartedYMD}` : ""}.`,
  );
  out.push(
    `  All your work: ${kb(lifetimeBytes)} kept out · ${allCaps.toLocaleString(locale)} captures across ${distinctProj} project${distinctProj === 1 ? "" : "s"}${lifeStartedYMD ? ` · since ${lifeStartedYMD}` : ""}.`,
  );
  out.push("");
  out.push("");

  // ── Section 4 — Marketing-grade cost framing (Mert: "math hesaplamalari ile
  // kalabalik yapma" → less math, more business value). One headline, one
  // optional team-scale callout, no scaling table, no math footnotes.
  out.push("  ─── 4. The bottom line ───");
  out.push("");
  out.push(...renderCostExample(lifetimeBytes, lifetimeTokensWithout, lifetimeDays));
  out.push("");
  out.push("");

  // ── Section 5 — What context-mode learned about how you work.
  out.push("  ─── 5. What context-mode learned about how you work ───");
  out.push("");
  if (lifetime && lifetime.autoMemoryCount > 0) {
    out.push(`  ${lifetime.autoMemoryCount} preferences picked up across ${lifetime.autoMemoryProjects} project${lifetime.autoMemoryProjects === 1 ? "" : "s"}:`);
    const entries = Object.entries(lifetime.autoMemoryByPrefix).sort((a, b) => b[1] - a[1]);
    const maxAm = entries.length > 0 ? entries[0][1] : 1;
    for (const [prefix, count] of entries) {
      const label = autoMemoryLabels[prefix] ?? prefix;
      out.push(`    ${label.padEnd(26)} ${String(count).padStart(2)}   ${dataBar(count, maxAm, 20)}`);
    }
  } else {
    out.push("  No preferences learned yet — context-mode picks them up automatically.");
  }
  out.push("");
  out.push("");

  // ── Footer.
  out.push("  Your AI talks less, remembers more, costs less.");
  out.push(`  Locale ${locale} · timezone ${tz} · pricing examples for illustration only.`);
  out.push("");
  const versionStr = version ? `v${version}` : "context-mode";
  out.push(`  ${versionStr}`);
  if (version && latestVersion && latestVersion !== "unknown" && semverNewer(latestVersion, version)) {
    out.push(`  Update available: v${version} -> v${latestVersion}  |  ctx_upgrade`);
  }

  // Suppress consecutive blank lines / leading blanks for tidier output —
  // we use `push("")` liberally above as paragraph separators, easier to
  // collapse here than to track flag state inline.
  return collapseBlanks(out);
}

/** Drop runs of >2 consecutive blank strings so the renderer never emits visual gaps. */
function collapseBlanks(lines: string[]): string[] {
  const out: string[] = [];
  let blankRun = 0;
  for (const ln of lines) {
    if (ln === "") {
      blankRun++;
      if (blankRun <= 2) out.push(ln);
    } else {
      blankRun = 0;
      out.push(ln);
    }
  }
  // Trim trailing blanks.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * One day on the horizontal narrative timeline. `ms` is midnight-UTC of
 * the day (caller is responsible for normalising); `count` is captures
 * for that day; `rescueBytes` (when >0) overlays the ◆ /compact glyph.
 */
export interface TimelineDay {
  ms: number;
  count: number;
  rescueBytes?: number;
}

/**
 * Render the proportional-spacing horizontal day strip used in section 1
 * of the 5-section narrative. Returns the lines verbatim ready to splice
 * into the formatReport line buffer:
 *
 *     apr 28 ●──────────────────────●────█──────────────────────◆────● may 10
 *
 *       apr 28   277 captures
 *       may 4    438 captures  ← peak
 *       may 9    261 captures  ◆ /compact rescued 1552 KB
 *       may 10   100 captures
 *
 *     ●  active day      █  peak day      ◆  /compact rescue
 *
 * The strip body is exactly 56 chars wide. Day positions are computed as
 * `round((day - first) / (last - first) * 55)`. Glyph priority for a
 * column: rescue (◆) > peak (█) > active (●). Filler is the box-drawing
 * `─` character so the strip reads cleanly in monospace terminals.
 */
export function renderHorizontalTimeline(
  days: TimelineDay[],
  locale: string,
  tz: string,
): string[] {
  if (days.length === 0) return [];
  // Sort ascending so first/last bookends + bar positions are stable.
  const sorted = [...days].sort((a, b) => a.ms - b.ms);
  const first = sorted[0];
  const last  = sorted[sorted.length - 1];
  const span  = Math.max(1, last.ms - first.ms);

  // Locate the peak day (max count). Ties: earliest wins so the visual
  // pin matches the chronologically first big day.
  let peak = sorted[0];
  for (const d of sorted) if (d.count > peak.count) peak = d;

  // Build the 56-char strip body.
  const WIDTH = 56;
  const body = Array.from({ length: WIDTH }, () => "─");
  for (const d of sorted) {
    const col = Math.round(((d.ms - first.ms) / span) * (WIDTH - 1));
    let glyph = "●";
    if (d === peak)               glyph = "█";
    if ((d.rescueBytes ?? 0) > 0) glyph = "◆"; // rescue beats peak
    body[col] = glyph;
  }

  // Lowercase short month names ("apr"/"may"/"jan") matching the target.
  const monthDay = (ms: number): string => {
    const dt = new Intl.DateTimeFormat(locale, {
      timeZone: tz,
      month: "short",
      day: "numeric",
    }).formatToParts(new Date(ms));
    const month = (dt.find((p) => p.type === "month")?.value ?? "").toLowerCase();
    const day   = dt.find((p) => p.type === "day")?.value ?? "";
    return `${month} ${day}`;
  };

  const out: string[] = [];
  out.push(`  ${monthDay(first.ms)} ${body.join("")} ${monthDay(last.ms)}`);
  out.push("");

  // Daily detail rows — count + " ← peak" + "◆ /compact rescued N KB".
  for (const d of sorted) {
    const label   = monthDay(d.ms).padEnd(7);
    const captures = `${d.count} captures`;
    const peakStr  = d === peak                  ? "  ← peak" : "";
    const rescue   = (d.rescueBytes ?? 0) > 0
      ? `  ◆ /compact rescued ${Math.round((d.rescueBytes ?? 0) / 1024)} KB`
      : "";
    out.push(`    ${label}  ${captures}${peakStr}${rescue}`);
  }
  out.push("");
  out.push("  ●  active day      █  peak day      ◆  /compact rescue");
  return out;
}

/**
 * Render a UTC ms timestamp as a human-readable local datetime string in
 * the canonical Mert-approved format:
 *
 *   "28 Apr 2026 at 12:16 (Europe/Istanbul)"
 *
 * Used by the 5-section narrative renderer (formatReport) so users see
 * exactly when their conversation started + when /compact rescues fired
 * in their wall-clock timezone — never UTC, never ambiguous.
 *
 * - 24-hour clock with zero-padded minutes ("20:54", not "8:54 PM").
 * - Day is NOT zero-padded ("9 May", not "09 May") to match the target.
 * - IANA timezone is appended verbatim in parentheses regardless of
 *   locale so users never misread Istanbul-time as UTC.
 * - Returns "" for ms === 0 or NaN so callers can guard the rendered
 *   line ("started …") without an extra timestamp-validity check.
 */
export function formatLocalDateTime(ms: number, locale: string, tz: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  // Intl.DateTimeFormat's "day"/"month"/"year" parts give us the locale's
  // ordering (en-* → "DD MMM YYYY"), and the explicit numeric hour/minute
  // forces 24-hour with leading zero on minute when in en-* with hour12=false.
  const dt = new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    dt.find((p) => p.type === type)?.value ?? "";
  const day   = get("day");
  const month = get("month");
  const year  = get("year");
  let hour    = get("hour");
  const min   = get("minute");
  // Some locales / some Node versions emit "24" for midnight under hour12=false.
  // Coerce back to "00" so the displayed time is always wall-clock-correct.
  if (hour === "24") hour = "00";
  return `${day} ${month} ${year} at ${hour}:${min} (${tz})`;
}

/** Format large numbers with K/M suffixes */
function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─────────────────────────────────────────────────────────
// Pricing (Bug #6) — Anthropic Opus input rate
// ─────────────────────────────────────────────────────────

/** Opus 4 input price: $15 per 1M tokens. */
export const OPUS_INPUT_PRICE_PER_TOKEN = 15 / 1_000_000;

/** Convert a token count to a USD string at the Opus input rate. */
export function tokensToUsd(tokens: number): string {
  const safe = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  return `$${(safe * OPUS_INPUT_PRICE_PER_TOKEN).toFixed(2)}`;
}

/**
 * Build a proportional bar using █ chars, scaled to a fixed width.
 * Returns e.g. "████████████████████████████████████████" for full width.
 */
function dataBar(bytes: number, maxBytes: number, width: number = 40): string {
  if (maxBytes <= 0) return "░".repeat(width);
  const filled = Math.max(1, Math.round((bytes / maxBytes) * width));
  return "█".repeat(Math.min(filled, width)) + "░".repeat(Math.max(0, width - filled));
}

/**
 * Render project memory section with category bars.
 *
 * Shows persistent event data, and — when supplied — lifetime totals
 * across every project's SessionDB so users see the cumulative value
 * (Bug #3).
 *
 * Caps the category list at `topN` and prints "N more categories" with the
 * actual remaining count (Bug #5 — was hardcoded "9 more").
 */
function renderProjectMemory(
  pm: FullReport["projectMemory"],
  opts?: {
    lifetime?: LifetimeStats;
    topN?: number;
    sessionTokensSaved?: number;
    /**
     * B3b Slice 3.6 — when supplied, the "All your work" header is
     * promoted to "All your work everywhere" and the lifetime totals
     * use the multi-adapter sums (events / sessions / bytes aggregated
     * across every adapter dir on disk) instead of the single-dir
     * lifetime numbers. The category bars still come from the single-dir
     * lifetime.categoryCounts because the multi-adapter scan today does
     * not bucket categories.
     */
    multiAdapter?: MultiAdapterLifetimeStats;
  },
): string[] {
  const sessionTokensSaved = opts?.sessionTokensSaved ?? 0;
  // Render when EITHER disk has data OR current session has earnings.
  if (
    pm.total_events === 0 &&
    (opts?.lifetime?.totalEvents ?? 0) === 0 &&
    sessionTokensSaved === 0 &&
    (opts?.multiAdapter?.totalEvents ?? 0) === 0
  ) {
    return [];
  }
  // Slice 5 — Mert: "honest, no tease". Show ALL categories. The legacy
  // topN cap silently hid real data; users would screenshot a stats card
  // missing half their work. The opts.topN parameter stays in the signature
  // for back-compat with any external caller that explicitly passes a cap.
  const topN = opts?.topN ?? Number.POSITIVE_INFINITY;
  const out: string[] = [];
  out.push("");
  // Header switches based on whether we have rich lifetime data from the new
  // pipeline. With it: forward-leaning "All your work" framing. Without it:
  // legacy "Persistent memory" line for back-compat with older fixtures + tests.
  // Slice 3.6: promote to "All your work everywhere" when multi-adapter
  // aggregation is supplied so the receipt scope matches the rendered totals.
  const ma = opts?.multiAdapter;
  const realAdapters = ma?.perAdapter.filter((a) => a.isReal).length ?? 0;
  const lifeEvents = ma?.totalEvents
    ?? opts?.lifetime?.totalEvents
    ?? pm.total_events;
  const lifeSessions = ma?.totalSessions
    ?? opts?.lifetime?.totalSessions
    ?? pm.session_count;
  const distinctProj = opts?.lifetime?.distinctProjects;
  if (lifeEvents > 0 && distinctProj && distinctProj > 0) {
    const everywhere = realAdapters >= 2 ? " everywhere" : "";
    out.push(`  All your work${everywhere}  ·  ${fmtNum(lifeEvents)} events captured across ${distinctProj} project${distinctProj === 1 ? "" : "s"}  ·  ${fmtNum(lifeSessions)} conversations`);
  } else {
    out.push("Persistent memory  ✓ preserved across compact, restart & upgrade");
    // Current session counts as 1 when no prior session has been recorded yet.
    const effectiveSessions =
      lifeSessions === 0 && sessionTokensSaved > 0 ? 1 : lifeSessions;
    const sessionLabel =
      effectiveSessions === 1 ? "1 session" : `${fmtNum(effectiveSessions)} sessions`;
    // Estimate lifetime savings: ~1KB per event → ~256 tokens/event at Opus rates,
    // plus current session's already-tracked token savings (in-memory).
    const lifetimeTokens = lifeEvents * 256 + sessionTokensSaved;
    out.push(`  ${fmtNum(lifeEvents)} events · ${sessionLabel} · ~${tokensToUsd(lifetimeTokens)} saved lifetime`);
  }
  out.push("");

  // Prefer lifetime categoryCounts (aggregated across every SessionDB) so
  // the bar block matches the lifetime header above. Falls back to the
  // project-local pm.by_category when lifetime data is absent (tests, older
  // callers) or when no sidecar has any events yet.
  const lifetimeCats = opts?.lifetime?.categoryCounts;
  let cats: Array<{ category: string; count: number; label: string }>;
  if (lifetimeCats && Object.keys(lifetimeCats).length > 0) {
    cats = Object.entries(lifetimeCats)
      .filter(([, c]) => c > 0)
      .map(([category, count]) => ({
        category,
        count,
        label: categoryLabels[category] || category,
      }))
      .sort((a, b) => b.count - a.count);
  } else {
    // Defensive: filter zero/null counts on the fallback path too — bumping
    // topN to 15 made any leaked empty rows visible as "label  0  ░░░░░░".
    cats = (pm.by_category ?? []).filter((c) => c && c.count > 0);
  }
  const visible = cats.slice(0, topN);
  const maxCount = visible.length > 0 ? visible[0].count : 1;
  for (const cat of visible) {
    out.push(`  ${cat.label.padEnd(26)} ${String(cat.count).padStart(5)}   ${dataBar(cat.count, maxCount, 30)}`);
  }

  // Bug #5: real overflow count, not hardcoded.
  const remaining = Math.max(0, cats.length - topN);
  if (remaining > 0) {
    out.push(`  ... ${remaining} more categor${remaining === 1 ? "y" : "ies"}`);
  }
  return out;
}

/**
 * Render the auto-memory section (Bug #4) — files Claude Code captured
 * under ~/.claude/projects/<project>/memory/ across the user's machine.
 */
function renderAutoMemory(lifetime: LifetimeStats | undefined): string[] {
  if (!lifetime || lifetime.autoMemoryCount === 0) return [];
  const out: string[] = [];
  out.push("");
  out.push(
    `  Preferences learned  ·  ${lifetime.autoMemoryCount} across ${lifetime.autoMemoryProjects} project${lifetime.autoMemoryProjects === 1 ? "" : "s"}`,
  );

  const entries = Object.entries(lifetime.autoMemoryByPrefix)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  // Top entry sets the bar scale so the visual stays proportional even when
  // the absolute counts are tiny. Entries are pre-sorted desc.
  const maxCount = entries.length > 0 ? entries[0][1] : 1;
  for (const [prefix, count] of entries) {
    const label = autoMemoryLabels[prefix] ?? prefix;
    out.push(
      `  ${label.padEnd(26)} ${String(count).padStart(2)}   ${dataBar(count, maxCount, 20)}`,
    );
  }
  return out;
}

/** Render the closing "Bottom line" footer (Bug #8). */
function renderBottomLine(sessionTokensSaved: number, lifetime: LifetimeStats | undefined): string[] {
  const out: string[] = [];
  const sessionUsd = tokensToUsd(sessionTokensSaved);
  // Lifetime = disk-aggregated events × 256 tokens + current session's
  // in-memory token savings. Two pipelines unified at the render edge so
  // lifetime ≥ session always (never the surprising "$X session · $0 lifetime"
  // a fresh user sees pre-flush).
  const lifetimeTokens = (lifetime?.totalEvents ?? 0) * 256 + sessionTokensSaved;
  const lifetimeUsd = tokensToUsd(lifetimeTokens);
  out.push("");
  out.push("─".repeat(65));
  out.push("Your AI talks less, remembers more, costs less.");
  out.push(`${sessionUsd} this session  ·  ${lifetimeUsd} lifetime`);
  out.push("─".repeat(65));
  return out;
}

/**
 * Constant token-per-event used everywhere we estimate session/lifetime $.
 * Kept in lockstep with `bin/statusline.mjs`'s persisted lifetime conversion.
 */
const TOKENS_PER_EVENT = 256;

/**
 * Render the LIFETIME Without/With hero — the screenshottable receipt.
 *
 * Why lifetime and not session: the "$X saved this session" framing is
 * arbitrary (a fresh PID can show $0 even while the user has weeks of work
 * banked). Lifetime is real, accumulating, and the number worth screenshotting.
 * The current conversation's contribution still shows below as a sub-block.
 */
function renderHero(args: {
  lifetimeTokensWithout: number;
  lifetimeTokensWith: number;
  lifetimeUsd: string;
  lifetimeWithUsd: string;
  savedPct: number;
  totalConversations: number;
  firstDate?: string;
}): string[] {
  const { lifetimeTokensWithout, lifetimeTokensWith, lifetimeUsd, lifetimeWithUsd, savedPct, totalConversations, firstDate } = args;
  const out: string[] = [];
  const since = firstDate ? `  ·  since ${firstDate}` : "";
  out.push(`  ${lifetimeUsd} saved with context-mode  ·  ${savedPct.toFixed(1)}% reduction${since}`);
  out.push("");
  const withoutBar = dataBar(lifetimeTokensWithout, lifetimeTokensWithout, 32);
  const withBar = dataBar(lifetimeTokensWith, lifetimeTokensWithout, 32);
  out.push(`  Without context-mode  ${fmtNum(lifetimeTokensWithout).padStart(7)} tokens  ${withoutBar}   ${lifetimeUsd}`);
  out.push(`  With context-mode     ${fmtNum(lifetimeTokensWith).padStart(7)} tokens  ${withBar}   ${lifetimeWithUsd}`);
  const kept = lifetimeTokensWithout - lifetimeTokensWith;
  out.push(`                        ${fmtNum(kept).padStart(7)} tokens kept out  ·  across ${totalConversations.toLocaleString("en-US")} conversations`);
  return out;
}

/**
 * Render the current conversation as a contribution narrative — not a hero.
 * Highlights the slice of lifetime savings this chat earned + concrete proof
 * (events, days alive, compact rescues).
 */
function renderConversation(c: ConversationStats, conversationUsd: string, contribPct: number): string[] {
  const out: string[] = [];
  const daysStr = c.daysAlive >= 1 ? `${c.daysAlive.toFixed(1)} days` : `${Math.max(1, Math.round(c.daysAlive * 24))} hr`;
  const pctStr = contribPct >= 1 ? `${contribPct.toFixed(0)}% of all-time` : `<1% of all-time`;
  out.push(`  This conversation contributed ${conversationUsd}  ·  ${pctStr}`);
  out.push(`  ${c.events.toLocaleString("en-US")} events  ·  ${daysStr} alive`);
  if (c.snapshotsConsumed > 0 && c.snapshotBytes > 0) {
    const rescuedTokens = Math.round(c.snapshotBytes / 4);
    out.push(`  ${c.snapshotsConsumed} compact weathered  ·  ${fmtNum(rescuedTokens)} tokens rescued from a ${(c.snapshotBytes / 1024).toFixed(0)} KB snapshot`);
  }
  out.push("");
  if (c.byCategory.length === 0) return out;
  const max = c.byCategory[0].count || 1;
  for (const cat of c.byCategory) {
    out.push(`    ${cat.label.padEnd(26)} ${String(cat.count).padStart(5)}   ${dataBar(cat.count, max, 28)}`);
  }
  return out;
}

/**
 * B3b Slice 3.2/3.3 — render the "Where it came from" sub-block from a
 * `MultiAdapterLifetimeStats` (analytics.ts:1231-1240). Two layers:
 *
 *  1. Real adapters (`isReal=true`) become a table row each:
 *       Tool          Captures   Indexed     Total kept out
 *       Claude Code     17.4K    276.7 MB        291.1 MB
 *       JetBrains            —     8.6 MB          8.6 MB
 *
 *  2. Filtered adapters (`isReal=false` but with at least one .db on disk)
 *     become a single "Skipped (N): name1, name2, ..." disclosure line so
 *     the user sees that fixtures/probes were intentionally hidden.
 *
 * Returns [] when `multiAdapter` is undefined OR when there are no real
 * adapters AND nothing skipped — keeping the renderer additive (Slice 3.5).
 */
function renderMultiAdapter(multiAdapter: MultiAdapterLifetimeStats | undefined): string[] {
  if (!multiAdapter) return [];
  const real     = multiAdapter.perAdapter.filter((a) => a.isReal);
  const skipped  = multiAdapter.perAdapter.filter((a) => !a.isReal);
  if (real.length === 0 && skipped.length === 0) return [];

  const out: string[] = [];
  if (real.length > 0) {
    out.push("");
    out.push("Where it came from (tools you actually used — fixtures + probes filtered):");
    out.push("");
    // Column widths chosen so the demo render stays visually aligned even
    // for adapters with very long marketing names. Right-aligned numerics.
    const NAME_W = 16;
    const CAP_W  = 10;
    const IDX_W  = 10;
    const TOT_W  = 16;
    out.push(
      `  ${"Tool".padEnd(NAME_W)}${"Captures".padStart(CAP_W)}${"Indexed".padStart(IDX_W)}${"Total kept out".padStart(TOT_W)}`,
    );
    // Sort by total kept out desc — biggest contributor first.
    const sorted = [...real].sort(
      (a, b) => (b.dataBytes + b.rescueBytes) - (a.dataBytes + a.rescueBytes),
    );
    for (const a of sorted) {
      const total = a.dataBytes + a.rescueBytes;
      // Em-dash for zero captures so the column reads "—" not "0".
      const captures = a.eventCount > 0 ? fmtNum(a.eventCount) : "—";
      const indexed  = kb(a.dataBytes);
      const totalStr = kb(total);
      out.push(
        `  ${adapterLabel(a.name).padEnd(NAME_W)}${captures.padStart(CAP_W)}${indexed.padStart(IDX_W)}${totalStr.padStart(TOT_W)}`,
      );
    }
  }

  if (skipped.length > 0) {
    if (real.length > 0) out.push("");
    const names = skipped.map((a) => adapterLabel(a.name)).join(", ");
    out.push(`  Skipped (${skipped.length}): ${names}`);
    out.push("  These adapters have DBs on disk but only test fixtures, dev skeletons,");
    out.push("  or detection probes — no real chat activity.");
  }

  return out;
}

/**
 * Render a FullReport as a visual savings dashboard designed for screenshotting.
 *
 * Design principles:
 * - Before/After comparison bar is the HERO — one glance = "wow"
 * - "tokens saved" is the number people share
 * - Per-tool breakdown shows what each tool SAVED, sorted by impact
 * - Project memory: category bars showing persistent data across sessions
 * - No: Pct column, category tables, tips, jargon
 */
export function formatReport(
  report: FullReport,
  version?: string,
  latestVersion?: string | null,
  opts?: {
    lifetime?: LifetimeStats;
    mcpUsage?: McpToolUsageRow[];
    conversation?: ConversationStats;
    /**
     * Phase 8 of D2 PRD — pass realBytes pre-aggregated from
     * `getRealBytesStats(...)` and the renderer will use those numbers
     * for the $ math instead of the conservative `events × 256` estimate.
     *
     * - `realBytes.lifetime` overrides `lifetimeTokensWithout`.
     * - `realBytes.conversation` overrides `conversationTokens`.
     * - Either may be omitted independently — missing values fall back
     *   to the legacy estimate so this feature can never produce
     *   a smaller number than before (Mert: stats only go up).
     * - When the new value is SMALLER than the legacy estimate (fresh
     *   sessions before any sandbox events emit), we keep the larger
     *   number to honour the same monotonic-growth invariant.
     */
    realBytes?: {
      lifetime?: RealBytesStats;
      conversation?: RealBytesStats;
    };
    /**
     * B3b — multi-adapter aggregation surfaced by
     * `getMultiAdapterLifetimeStats(...)` (analytics.ts:1248). When present,
     * the renderer adds a "Where it came from" sub-block under the receipt,
     * promotes the headline to "across N AI tools" when >= 2 real adapters
     * are detected, and renames the all-work block to "All your work
     * everywhere". Backward compat: omitting this opt preserves the legacy
     * single-adapter renderer output unchanged.
     */
    multiAdapter?: MultiAdapterLifetimeStats;
    /**
     * 5-section narrative renderer overrides. Defaults to ambient
     * `process.cwd()` + `Date.now()` + `detectLocaleAndTz()` for production
     * use; tests inject deterministic values so output is byte-stable.
     */
    cwd?: string;
    now?: number;
    locale?: string;
    tz?: string;
  },
): string {
  const lines: string[] = [];
  const duration = formatDuration(report.session.uptime_min);
  const lifetime = opts?.lifetime;
  const mcpUsage = opts?.mcpUsage;
  const conversation = opts?.conversation;
  const realBytes = opts?.realBytes;
  const multiAdapter = opts?.multiAdapter;
  // Real-adapter count drives the "across N AI tools" headline copy
  // (Slice 3.4) — we only call something a "tool you used" once it
  // passes the isReal filter inside getMultiAdapterLifetimeStats.
  const realAdapterCount = multiAdapter?.perAdapter.filter((a) => a.isReal).length ?? 0;

  // ── B3b Slice 3.4: opening tagline — runs in EVERY render path so the
  // multi-adapter headline appears regardless of which formatReport branch
  // executes (active session / fresh / per-conversation). Falls back to
  // "in Claude Code" when only one adapter qualifies as real, matching the
  // Mert-approved demo wording. Suppressed entirely without multiAdapter
  // so legacy single-adapter renders stay byte-identical (Slice 3.5).
  if (multiAdapter && realAdapterCount > 0) {
    const totalConvs = multiAdapter.totalSessions || lifetime?.totalSessions || 0;
    const sinceMs = lifetime?.firstEventMs ?? 0;
    const days = sinceMs > 0
      ? Math.max(1, Math.round((Date.now() - sinceMs) / 86_400_000))
      : 0;
    const daySegment = days > 0 ? `Across ${days} day${days === 1 ? "" : "s"} ` : "";
    const convStr = totalConvs > 0
      ? `you ran ${fmtNum(totalConvs)} conversation${totalConvs === 1 ? "" : "s"} `
      : "you ran ";
    let where: string;
    if (realAdapterCount >= 2) {
      where = `across ${realAdapterCount} AI tools`;
    } else {
      // Single real adapter — use its marketing label (defaults to Claude Code
      // if for some reason the only real adapter has no entry in adapterLabels).
      const onlyReal = multiAdapter.perAdapter.find((a) => a.isReal);
      where = `in ${onlyReal ? adapterLabel(onlyReal.name) : "Claude Code"}`;
    }
    lines.push(`${daySegment}${convStr}${where}.`);
    lines.push("");
  }

  // ── 5-section narrative ("kitap gibi") layout — Mert-approved
  //    screenshot format produced when the MCP handler has wired
  //    conversation + lifetime + multi-adapter through. Replaces the
  //    legacy hero/contribution/auto-memory stack with the:
  //      Opener
  //      1. Where you are now            (datetime, /compact, timeline)
  //      2. What this chat captured      (per-category bars)
  //      3. The receipt — getting wider
  //      4. For example: what would that cost?
  //      5. What context-mode learned about how you work
  //      Footer
  //    The opener block above (lines 1989-2005) is suppressed because
  //    renderNarrative5Section emits its own.
  if (conversation && conversation.events > 0) {
    // Strip the previous-block opener — narrative renderer emits its own.
    if (lines.length > 0) lines.length = 0;
    const detected = detectLocaleAndTz();
    const cwd    = opts?.cwd    ?? process.cwd();
    const now    = opts?.now    ?? Date.now();
    const locale = opts?.locale ?? detected.locale;
    const tz     = opts?.tz     ?? detected.tz;
    lines.push(...renderNarrative5Section({
      conversation, lifetime, multiAdapter, realBytes,
      cwd, locale, tz, now, version, latestVersion,
    }));
    return lines.join("\n");
  }

  // ── Compute real savings ──
  const totalKeptOut =
    report.savings.kept_out + (report.cache ? report.cache.bytes_saved : 0);
  const totalReturned = report.savings.total_bytes_returned;
  const totalCalls = report.savings.total_calls;
  const grandTotal = totalKeptOut + totalReturned;
  const savingsPct = grandTotal > 0 ? (totalKeptOut / grandTotal) * 100 : 0;
  const tokensSaved = Math.round(totalKeptOut / 4);
  const ratioMultiplier = totalReturned > 0
    ? Math.max(1, Math.round(grandTotal / Math.max(totalReturned, 1)))
    : 0;

  // ── Fresh session: no savings yet ──
  if (totalKeptOut === 0) {
    lines.push(`context-mode  ${duration}  ${totalCalls} calls`);
    lines.push("");

    if (totalCalls === 0) {
      lines.push("No tool calls yet. Use batch_execute or execute to start saving tokens.");
    } else {
      lines.push(`${kb(totalReturned)} entered context  |  0 tokens saved`);
    }

    // Project memory + auto-memory + bottom line
    lines.push(...renderProjectMemory(report.projectMemory, { lifetime, multiAdapter, sessionTokensSaved: 0 }));
    lines.push(...renderMultiAdapter(multiAdapter));
    lines.push(...renderAutoMemory(lifetime));
    lines.push(...renderBottomLine(0, lifetime));

    // Footer
    lines.push("");
    const versionStr = version ? `v${version}` : "context-mode";
    lines.push(versionStr);
    if (version && latestVersion && latestVersion !== "unknown" && semverNewer(latestVersion, version)) {
      lines.push(`Update available: v${version} -> v${latestVersion}  |  ctx_upgrade`);
    }
    return lines.join("\n");
  }

  // ── Active session: visual savings dashboard ──

  // Line 1: Hero metric — the screenshottable number
  // Bug #6: include Opus pricing on the hero line for credibility.
  lines.push(
    `${fmtNum(tokensSaved)} tokens saved  ·  ${savingsPct.toFixed(1)}% reduction  ·  ${duration}  ·  ~${tokensToUsd(tokensSaved)} saved (Opus)`,
  );
  lines.push("");

  // Lines 2-3: Before/After comparison bars — the visual proof
  lines.push(`Without context-mode  |${dataBar(grandTotal, grandTotal)}| ${kb(grandTotal)}`);
  lines.push(`With context-mode     |${dataBar(totalReturned, grandTotal)}| ${kb(totalReturned)}`);
  lines.push("");

  // Value statement — the line people share
  // Bug #7: replace meaningless "3.0x" ratio with "3× longer sessions".
  if (ratioMultiplier >= 2) {
    lines.push(`${kb(totalKeptOut)} kept out of your conversation — ${ratioMultiplier}× longer sessions before compact.`);
  } else {
    lines.push(`${kb(totalKeptOut)} kept out of your conversation. Never entered context.`);
  }
  lines.push("");

  // Compact stats row
  const statParts = [`${totalCalls} calls`];
  if (report.cache && report.cache.hits > 0) {
    statParts.push(`${report.cache.hits} cache hits (+${kb(report.cache.bytes_saved)})`);
  }
  lines.push(statParts.join("  ·  "));

  // ── Per-tool breakdown (only if 2+ tools, sorted by saved) ──
  const activatedTools = report.savings.by_tool.filter((t) => t.calls > 0);
  if (activatedTools.length >= 2) {
    lines.push("");

    // Estimate per-tool saved using global savings ratio
    const toolRows = activatedTools.map((t) => {
      const returnedBytes = t.context_kb * 1024;
      const estimatedTotal = savingsPct < 100
        ? returnedBytes / (1 - savingsPct / 100)
        : returnedBytes;
      const estimatedSaved = Math.max(0, estimatedTotal - returnedBytes);
      return { ...t, returnedBytes, estimatedSaved };
    }).sort((a, b) => b.estimatedSaved - a.estimatedSaved);

    // Compact table: tool name, calls, saved
    for (const t of toolRows) {
      const name = t.tool.length > 22 ? t.tool.slice(0, 19) + "..." : t.tool;
      lines.push(`  ${name.padEnd(22)}  ${String(t.calls).padStart(4)} calls  ${kb(t.estimatedSaved).padStart(8)} saved`);
    }
  }

  // ── Parallel I/O — value-forward framing for concurrent batch tools.
  // Suppressed when no tool ran with max_concurrency > 1 (don't claim
  // parallelism we didn't deliver). Internal mcp__*__ namespace stripped
  // for user-facing readability.
  if (mcpUsage && mcpUsage.length > 0) {
    const concurrent = mcpUsage.filter(
      (u) => u.median_concurrency != null && (u.max_concurrency ?? 1) > 1,
    );
    if (concurrent.length > 0) {
      lines.push("");
      lines.push(
        "Parallel I/O  ✓ one call did the work of many — faster runs, lower bill, same answer.",
      );
      for (const u of concurrent) {
        const name = u.tool_name.replace(/^mcp__.*?__/, "");
        lines.push(
          `  ${name.padEnd(22)} ${u.calls} batches · ${u.median_concurrency} typical, ${u.max_concurrency} peak`,
        );
      }
    }
  }

  // ── Project memory — persistent across sessions (Bug #3 + #5) ──
  lines.push(...renderProjectMemory(report.projectMemory, { lifetime, multiAdapter, sessionTokensSaved: tokensSaved }));

  // ── B3b Slice 3.2/3.3 — "Where it came from" per-adapter sub-block.
  // Sits under the lifetime memory block so the receipt-to-source flow is
  // visually contiguous (lifetime totals → which tools produced them).
  lines.push(...renderMultiAdapter(multiAdapter));

  // ── Auto-memory — Claude Code's preference learnings (Bug #4) ──
  lines.push(...renderAutoMemory(lifetime));

  // ── Bottom line — business value framing (Bug #8) ──
  lines.push(...renderBottomLine(tokensSaved, lifetime));

  // ── Footer ──
  lines.push("");
  const versionStr = version ? `v${version}` : "context-mode";
  lines.push(versionStr);
  if (version && latestVersion && latestVersion !== "unknown" && latestVersion !== version) {
    lines.push(`Update available: v${version} -> v${latestVersion}  |  ctx_upgrade`);
  }

  return lines.join("\n");
}
