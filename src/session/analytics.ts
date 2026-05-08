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

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadDatabase as loadDatabaseImpl } from "../db-base.js";

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

/** Human-readable labels for event categories. */
export const categoryLabels: Record<string, string> = {
  file: "Files tracked",
  rule: "Project rules (CLAUDE.md)",
  prompt: "Your requests saved",
  mcp: "Plugin tools used",
  git: "Git operations",
  env: "Environment setup",
  error: "Errors caught",
  task: "Tasks in progress",
  decision: "Your decisions",
  cwd: "Working directory",
  skill: "Skills used",
  subagent: "Delegated work",
  intent: "Session mode",
  data: "Data references",
  role: "Behavioral directives",
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
  const sessionsDir = opts?.sessionsDir
    ?? join(homedir(), ".claude", "context-mode", "sessions");
  const memoryRoot = opts?.memoryRoot
    ?? join(homedir(), ".claude", "projects");

  let totalEvents = 0;
  let totalSessions = 0;
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
  };
}

// ─────────────────────────────────────────────────────────
// formatReport — renders FullReport as sales-grade savings dashboard
// ─────────────────────────────────────────────────────────

/** Format bytes as human-readable KB or MB. */
function kb(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${Math.round(b)} B`;
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
  opts?: { lifetime?: LifetimeStats; topN?: number; sessionTokensSaved?: number },
): string[] {
  const sessionTokensSaved = opts?.sessionTokensSaved ?? 0;
  // Render when EITHER disk has data OR current session has earnings.
  if (
    pm.total_events === 0 &&
    (opts?.lifetime?.totalEvents ?? 0) === 0 &&
    sessionTokensSaved === 0
  ) {
    return [];
  }
  const topN = opts?.topN ?? 2;
  const out: string[] = [];
  out.push("");
  out.push("Persistent memory  ✓ preserved across compact, restart & upgrade");

  // Lifetime line — disk-aggregated lifetime PLUS current session's in-memory
  // savings. Two separate accounting pipelines (server bytes vs hook events)
  // get unified at the render edge so the user always sees a monotonic total
  // (lifetime ≥ session). Without this, fresh users / pre-b8e11bf sidecars /
  // not-yet-flushed events show $0 lifetime even when the session earned $X.
  const lifeEvents = opts?.lifetime?.totalEvents ?? pm.total_events;
  const lifeSessions = opts?.lifetime?.totalSessions ?? pm.session_count;
  // Current session counts as 1 when no prior session has been recorded yet.
  const effectiveSessions =
    lifeSessions === 0 && sessionTokensSaved > 0 ? 1 : lifeSessions;
  const sessionLabel =
    effectiveSessions === 1 ? "1 session" : `${fmtNum(effectiveSessions)} sessions`;
  // Estimate lifetime savings: ~1KB per event → ~256 tokens/event at Opus rates,
  // plus current session's already-tracked token savings (in-memory).
  const lifetimeTokens = lifeEvents * 256 + sessionTokensSaved;
  out.push(`  ${fmtNum(lifeEvents)} events · ${sessionLabel} · ~${tokensToUsd(lifetimeTokens)} saved lifetime`);
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
    cats = pm.by_category;
  }
  const visible = cats.slice(0, topN);
  const maxCount = visible.length > 0 ? visible[0].count : 1;
  for (const cat of visible) {
    out.push(`  ${cat.label.padEnd(18)} ${String(cat.count).padStart(5)}   ${dataBar(cat.count, maxCount, 30)}`);
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
    `Auto-memory  ✓ ${lifetime.autoMemoryCount} preference${lifetime.autoMemoryCount === 1 ? "" : "s"} learned across ${lifetime.autoMemoryProjects} project${lifetime.autoMemoryProjects === 1 ? "" : "s"}`,
  );

  const entries = Object.entries(lifetime.autoMemoryByPrefix)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  // Top entry sets the bar scale so the visual stays proportional even when
  // the absolute counts are tiny. Entries are pre-sorted desc.
  const maxCount = entries.length > 0 ? entries[0][1] : 1;
  for (const [prefix, count] of entries) {
    out.push(
      `  ${prefix.padEnd(12)} ${String(count).padStart(2)}   ${dataBar(count, maxCount, 20)}`,
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
  opts?: { lifetime?: LifetimeStats; mcpUsage?: McpToolUsageRow[] },
): string {
  const lines: string[] = [];
  const duration = formatDuration(report.session.uptime_min);
  const lifetime = opts?.lifetime;
  const mcpUsage = opts?.mcpUsage;

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
    lines.push(...renderProjectMemory(report.projectMemory, { lifetime, sessionTokensSaved: 0 }));
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
  lines.push(...renderProjectMemory(report.projectMemory, { lifetime, sessionTokensSaved: tokensSaved }));

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
