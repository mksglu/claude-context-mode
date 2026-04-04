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
  file: "Restored after compact \u2014 no need to re-read",
  rule: "Your project instructions survive context resets",
  prompt: "Continues exactly where you left off",
  decision: "Applied automatically \u2014 won\u2019t ask again",
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

    // ── Continuity data ──
    const eventTotal = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM session_events",
    ).get() as { cnt: number }).cnt;

    const byCategory = this.db.prepare(
      "SELECT category, COUNT(*) as cnt FROM session_events GROUP BY category ORDER BY cnt DESC",
    ).all() as Array<{ category: string; cnt: number }>;

    const meta = this.db.prepare(
      "SELECT compact_count FROM session_meta ORDER BY started_at DESC LIMIT 1",
    ).get() as { compact_count: number } | undefined;
    const compactCount = meta?.compact_count ?? 0;

    const resume = this.db.prepare(
      "SELECT event_count, consumed FROM session_resume ORDER BY created_at DESC LIMIT 1",
    ).get() as { event_count: number; consumed: number } | undefined;
    const resumeReady = resume ? !resume.consumed : false;

    // Build category previews
    const previewRows = this.db.prepare(
      "SELECT category, type, data FROM session_events ORDER BY id DESC",
    ).all() as Array<{ category: string; type: string; data: string }>;

    const previews = new Map<string, Set<string>>();
    for (const row of previewRows) {
      if (!previews.has(row.category)) previews.set(row.category, new Set());
      const set = previews.get(row.category)!;
      if (set.size < 5) {
        let display = row.data;
        if (row.category === "file") {
          display = row.data.split("/").pop() || row.data;
        } else if (row.category === "prompt") {
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
    };
  }
}

// ─────────────────────────────────────────────────────────
// formatReport — renders FullReport as concise, honest output
// ─────────────────────────────────────────────────────────

/** Format bytes as human-readable KB or MB. */
function kb(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
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
 * Build a before/after comparison bar.
 *
 * The "without" bar is always full (40 chars).
 * The "with" bar is proportional to the ratio of returned vs total.
 */
function comparisonBars(total: number, returned: number): { withoutBar: string; withBar: string } {
  const BAR_WIDTH = 40;
  const withoutBar = "#".repeat(BAR_WIDTH);
  const withFill = total > 0 ? Math.max(1, Math.round((returned / total) * BAR_WIDTH)) : BAR_WIDTH;
  const withBar = "#".repeat(withFill) + " ".repeat(BAR_WIDTH - withFill);
  return { withoutBar, withBar };
}

/**
 * Render a FullReport as a before/after comparison developers instantly understand.
 *
 * Design rules:
 * - If no savings, show "fresh session" format (no fake percentages)
 * - Active session shows BEFORE vs AFTER -- what would have flooded your conversation vs what actually did
 * - Per-tool table only if 2+ different tools were called
 * - Time gained is the hero metric
 * - Under 15 lines for typical sessions
 */
export function formatReport(report: FullReport, version?: string, latestVersion?: string | null): string {
  const lines: string[] = [];
  const duration = formatDuration(report.session.uptime_min);

  // ── Compute real savings ──
  const totalKeptOut =
    report.savings.kept_out + (report.cache ? report.cache.bytes_saved : 0);
  const totalReturned = report.savings.total_bytes_returned;
  const totalCalls = report.savings.total_calls;

  // ── Fresh session: almost no activity ──
  if (totalKeptOut === 0) {
    lines.push(`context-mode -- session (${duration})`);
    lines.push("");

    if (totalCalls === 0) {
      lines.push("No tool calls yet.");
    } else {
      const callLabel = totalCalls === 1 ? "1 tool call" : `${totalCalls} tool calls`;
      lines.push(`${callLabel}  |  ${kb(totalReturned)} in context  |  no savings yet`);
    }

    lines.push("");
    lines.push("Tip: Use ctx_execute to analyze files in sandbox -- savings start there.");
    lines.push("");
    lines.push(version ? `v${version}` : "context-mode");
    if (version && latestVersion && latestVersion !== "unknown" && latestVersion !== version) {
      lines.push(`Update available: v${version} -> v${latestVersion}  |  Run: ctx_upgrade`);
    }
    return lines.join("\n");
  }

  // ── Active session with real savings ──
  const grandTotal = totalKeptOut + totalReturned;
  const savingsPercent =
    grandTotal > 0
      ? ((totalKeptOut / grandTotal) * 100).toFixed(1)
      : "0.0";

  // ── Time saved estimate (hero metric) ──
  // ~4 bytes per token, ~1000 tokens per minute of context window capacity
  const minSaved = Math.round(totalKeptOut / 4 / 1000);

  lines.push(`context-mode -- session (${duration})`);
  lines.push("");

  // ── Before/after comparison ──
  const { withoutBar, withBar } = comparisonBars(grandTotal, totalReturned);
  lines.push(`Without context-mode:  |${withoutBar}| ${kb(grandTotal)} in your conversation`);
  lines.push(`With context-mode:     |${withBar}| ${kb(totalReturned)} in your conversation`);
  lines.push("");
  const savingsLine = `${kb(totalKeptOut)} processed in sandbox, never entered your conversation. (${savingsPercent}% reduction)`;
  lines.push(savingsLine);

  if (minSaved > 0) {
    const timeSaved = minSaved >= 60
      ? `+${Math.floor(minSaved / 60)}h ${minSaved % 60}m`
      : `+${minSaved}m`;
    lines.push(`${timeSaved} session time gained.`);
  }

  // ── Per-tool table (only if 2+ different tools) ──
  const activatedTools = report.savings.by_tool.filter((t) => t.calls > 0);
  if (activatedTools.length >= 2) {
    lines.push("");
    for (const t of activatedTools) {
      const returned = t.context_kb * 1024;
      const callLabel = `${t.calls} call${t.calls !== 1 ? "s" : ""}`;
      lines.push(
        `  ${t.tool.padEnd(22)} ${callLabel.padEnd(10)} ${kb(returned)} used`,
      );
    }
  }

  // ── Footer: continuity + version + outdated warning ──
  const footerParts: string[] = [];
  if (report.continuity.compact_count > 0) {
    footerParts.push(
      `${report.continuity.compact_count} compaction${report.continuity.compact_count !== 1 ? "s" : ""}`,
    );
  }
  if (report.continuity.total_events > 0) {
    footerParts.push(
      `${report.continuity.total_events} event${report.continuity.total_events !== 1 ? "s" : ""} preserved`,
    );
  }
  const versionStr = version ? `v${version}` : "context-mode";
  footerParts.push(versionStr);
  lines.push("");
  lines.push(footerParts.join("  |  "));

  // Outdated warning in footer
  if (version && latestVersion && latestVersion !== "unknown" && latestVersion !== version) {
    lines.push(`Update available: v${version} -> v${latestVersion}  |  Run: ctx_upgrade`);
  }

  return lines.join("\n");
}
