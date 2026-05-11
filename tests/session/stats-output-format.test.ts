/**
 * stats-output-format — Bugs #5, #6, #7, #8
 *
 * #5: "9 more categories" was hardcoded — must compute the real overflow.
 * #6: "~$0.42 saved" was a guess — must use Opus pricing ($15 / 1M tokens).
 * #7: "3.0x" is meaningless — must read "3× longer sessions".
 * #8: No business-value framing — must end with a "Bottom line" footer.
 */

import { describe, expect, test } from "vitest";
import { formatReport, tokensToUsd } from "../../src/session/analytics.js";
import type {
  AdapterScanResult,
  ConversationStats,
  FullReport,
  LifetimeStats,
  MultiAdapterLifetimeStats,
} from "../../src/session/analytics.js";

function baseReport(): FullReport {
  return {
    savings: {
      processed_kb: 50,
      entered_kb: 10,
      saved_kb: 40,
      pct: 80,
      savings_ratio: 5,
      by_tool: [
        { tool: "ctx_search", calls: 3, context_kb: 5, tokens: 1280 },
        { tool: "ctx_fetch_and_index", calls: 1, context_kb: 5, tokens: 1280 },
      ],
      total_calls: 4,
      total_bytes_returned: 10 * 1024,
      kept_out: 40 * 1024,
      total_processed: 50 * 1024,
    },
    session: { id: "sess-x", uptime_min: "3.0" },
    continuity: { total_events: 0, by_category: [], compact_count: 0, resume_ready: false },
    projectMemory: {
      total_events: 160,
      session_count: 40,
      by_category: [
        { category: "file", count: 391, label: "Files tracked" },
        { category: "cwd",  count: 173, label: "Working directory" },
        { category: "rule", count: 80,  label: "Project rules (CLAUDE.md)" },
        { category: "git",  count: 50,  label: "Git operations" },
        { category: "env",  count: 40,  label: "Environment setup" },
        { category: "task", count: 30,  label: "Tasks in progress" },
        { category: "skill",count: 20,  label: "Skills used" },
        { category: "data", count: 10,  label: "Data references" },
        // 8 categories total — first 2 shown, 6 more remaining.
      ],
    },
  };
}

function emptyLifetime(): LifetimeStats {
  return {
    totalEvents: 0,
    totalSessions: 0,
    autoMemoryCount: 0,
    autoMemoryProjects: 0,
    autoMemoryByPrefix: {},
    categoryCounts: {},
  };
}

describe("Opus pricing", () => {
  test("tokensToUsd uses $15 per 1M input tokens", () => {
    expect(tokensToUsd(1_000_000)).toBe("$15.00");
    expect(tokensToUsd(42_000)).toBe("$0.63");
    expect(tokensToUsd(0)).toBe("$0.00");
  });
});

describe("formatReport — Bugs #5/#6/#7/#8", () => {
  test("includes Opus pricing line for the active session", () => {
    const text = formatReport(baseReport(), "1.0.103", null, {
      lifetime: emptyLifetime(),
    });
    expect(text).toMatch(/\$\d+\.\d{2}.*Opus/);
  });

  test("uses '× longer sessions' phrasing instead of bare ratio", () => {
    const text = formatReport(baseReport(), "1.0.103", null, {
      lifetime: emptyLifetime(),
    });
    // Tolerate either '×' or 'x' depending on glyph choice, but require the phrase.
    expect(text).toMatch(/\d+\s*[×x]\s+longer sessions/i);
    // And it should NOT use the meaningless bare "3.0x" form alone.
    expect(text).not.toMatch(/\b\d+\.\dx\b(?!\s+longer)/);
  });

  test("never emits the legacy hardcoded '9 more categories' string", () => {
    const text = formatReport(baseReport(), "1.0.103", null, {
      lifetime: emptyLifetime(),
    });
    // Slice 5 — Mert: 'honest, no tease'. The renderer no longer emits
    // any "+ N more categor" overflow line; instead all 8 baseReport
    // categories appear in full. The legacy hardcoded "9 more categories"
    // bug must never come back regardless.
    expect(text).not.toMatch(/9 more categories/);
    expect(text).not.toMatch(/\d+ more categor/);
    // Every baseReport category label must show up.
    for (const c of baseReport().projectMemory.by_category) {
      expect(text).toContain(c.label);
    }
  });

  test("ends with a 'Bottom line' / business-value footer", () => {
    const text = formatReport(baseReport(), "1.0.103", null, {
      lifetime: { ...emptyLifetime(), totalEvents: 160, totalSessions: 40 },
    });
    // Footer must include the session $ and lifetime $ summary.
    expect(text).toMatch(/talks less, remembers more, costs less/i);
    expect(text).toMatch(/\$\d+\.\d{2} this session/);
    expect(text).toMatch(/\$\d+(\.\d{2})? lifetime/);
  });

  test("renders the auto-memory block when files are present", () => {
    // Updated to current renderer copy: legacy active-session path emits
    // "Preferences learned  ·  N across K projects" (no "Auto-memory"
    // header label — that was the early prototype copy). The narrative
    // renderer's section 5 surfaces the same data via "N preferences
    // picked up across K projects". Either path satisfies the spirit
    // of the test: the auto-memory data must be visible.
    const text = formatReport(baseReport(), "1.0.103", null, {
      lifetime: {
        totalEvents: 160,
        totalSessions: 40,
        autoMemoryCount: 18,
        autoMemoryProjects: 6,
        autoMemoryByPrefix: { user: 4, feedback: 7, project: 5, reference: 2 },
      },
    });
    expect(text).toMatch(/Preferences learned|preferences picked up/);
    expect(text).toMatch(/18\s+(preferences|across)/);
    expect(text).toMatch(/across 6 project/);
    // The renderer translates raw prefixes via autoMemoryLabels:
    //   feedback → "How you work"  (count 7 in this fixture)
    //   project  → "What you're building" (count 5)
    // Assert the displayed label, not the raw prefix.
    expect(text).toMatch(/How you work\s+7/);
  });

  // ── Cycle 1: Auto-memory must include proportional bars (Mert: "no bars") ──
  test("auto-memory rows include proportional █ bars", () => {
    const text = formatReport(baseReport(), "1.0.103", null, {
      lifetime: {
        totalEvents: 160,
        totalSessions: 40,
        autoMemoryCount: 22,
        autoMemoryProjects: 5,
        autoMemoryByPrefix: { project: 11, memory: 6, feedback: 3, user: 1, reference: 1 },
      },
    });
    // Auto-memory block has bars under the "Preferences learned" header.
    expect(text).toMatch(/Preferences learned[\s\S]*?█/);
    // Largest entry (project=11) bar must be wider than smallest (reference=1).
    // The renderer translates raw prefixes via autoMemoryLabels — capture
    // bar widths against the rendered LABELS:
    //   project   → "What you're building"
    //   reference → "Where to look"
    const projectBar = (text.match(/What you're building\s+\d+\s+(█+)/) ?? [])[1] ?? "";
    const referenceBar = (text.match(/Where to look\s+\d+\s+(█+)/) ?? [])[1] ?? "";
    expect(projectBar.length).toBeGreaterThan(0);
    expect(referenceBar.length).toBeGreaterThan(0);
    expect(projectBar.length).toBeGreaterThan(referenceBar.length);
  });

  // ── Slice 5: ALL categories render — no "+ N more" tease (Mert: honest,
  // no tease). This applies to BOTH the narrative section 2 and the legacy
  // active-session renderProjectMemory path so a screenshot never hides
  // categories the user actually has.
  test("renderProjectMemory shows all categories without truncation tease", () => {
    // 20 categories — far above the legacy topN=15 cap. None should be hidden.
    const cats: FullReport["projectMemory"]["by_category"] = Array.from(
      { length: 20 },
      (_, i) => ({
        category: `c${i}`,
        count: 100 - i,
        label: `Label ${i}`,
      }),
    );
    const report: FullReport = {
      ...baseReport(),
      projectMemory: { ...baseReport().projectMemory, by_category: cats },
    };
    const text = formatReport(report, "1.0.111", null, {
      lifetime: { ...emptyLifetime(), totalEvents: 1000, totalSessions: 10 },
    });
    // Must NOT emit any "+ N more categor[y/ies]" tease.
    expect(text).not.toMatch(/\d+ more categor/);
    // Every label must appear in the rendered output.
    for (const c of cats) expect(text).toContain(c.label);
  });

  // ── Slice 4 (5-section narrative): formatReport must produce the
  // Mert-approved "kitap gibi" 5-section layout when conversation +
  // realBytes + multiAdapter are all present. Pin the section headers
  // + key openers + footer order so the renderer can never drift.
  test("narrative renderer emits all 5 section headers in order", () => {
    const conv: ConversationStats = {
      sessionId: "narrative-fixture",
      events: 1277,
      dbCount: 2,
      daysAlive: 12.0,
      snapshotBytes: 1552 * 1024,
      snapshotsConsumed: 1,
      byCategory: [
        { category: "external-ref",      count: 500, label: "External docs indexed" },
        { category: "file",              count: 132, label: "Files tracked" },
        { category: "error",             count: 119, label: "Errors caught" },
        { category: "constraint",        count: 100, label: "Constraints you set" },
        { category: "git",               count:  78, label: "Git operations" },
      ],
      // Section-1 datetime fields — the production handler always
      // populates these via getConversationStats; this fixture mirrors
      // the demo target (started 28 Apr 12:16 Istanbul, /compact 9 May 20:54).
      firstEventMs: Date.UTC(2026, 3, 28, 9, 16, 0),
      lastEventMs:  Date.UTC(2026, 4, 10, 9, 16, 0),
      lastRescueMs: Date.UTC(2026, 4,  9, 17, 54, 0),
      byDay: [
        { ms: Date.UTC(2026, 3, 28),  count: 277 },
        { ms: Date.UTC(2026, 4,  3),  count: 201 },
        { ms: Date.UTC(2026, 4,  4),  count: 438 },
        { ms: Date.UTC(2026, 4,  9),  count: 261, rescueBytes: 1552 * 1024 },
        { ms: Date.UTC(2026, 4, 10),  count: 100 },
      ],
    };
    const lifetime: LifetimeStats = {
      totalEvents: 17_493,
      totalSessions: 128,
      autoMemoryCount: 22,
      autoMemoryProjects: 6,
      autoMemoryByPrefix: { project: 11, feedback: 7, user: 3, reference: 1 },
      categoryCounts: {
        "external-ref": 500, file: 132, error: 119, constraint: 100, git: 78,
        subagent: 62, "agent-finding": 58,
      },
      rescueBytes: 1552 * 1024,
      firstEventMs: Date.UTC(2026, 2, 4),
      distinctProjects: 123,
    };
    const ma: MultiAdapterLifetimeStats = {
      totalEvents: 17_493,
      totalSessions: 128,
      totalBytes: 356 * 1024 * 1024,
      perAdapter: [
        {
          name: "claude-code",
          eventCount: 17_493,
          sessionCount: 128,
          dataBytes: 356 * 1024 * 1024,
          rescueBytes: 1552 * 1024,
          contentBytes: 0,
          uuidConvs: 128,
          projectDirs: new Array(123).fill(0).map((_, i) => `/p/${i}`),
          firstMs: Date.UTC(2026, 2, 4),
          lastMs:  Date.UTC(2026, 4, 10),
          isReal: true,
        } satisfies AdapterScanResult,
      ],
    };

    const text = formatReport(baseReport(), "1.0.111", null, {
      conversation: conv,
      lifetime,
      multiAdapter: ma,
      realBytes: {
        // Lifetime: ~93.3M tokens (target's 356 MB / ~3.81 ratio).
        lifetime: {
          eventDataBytes:   80_000_000,
          bytesAvoided:    285_000_000,
          bytesReturned:     2_000_000,
          snapshotBytes:    8_261_000,
          totalSavedTokens: 93_315_333,
        },
        // Conversation: ~776K tokens.
        conversation: {
          eventDataBytes: 1_500_000,
          bytesAvoided:   1_400_000,
          bytesReturned:    100_000,
          snapshotBytes:  1_552 * 1024,
          totalSavedTokens: 776_300,
        },
      },
      // Pin locale/tz/cwd/now so the assertion is byte-stable across
      // CI machines (no ambient process.env / process.cwd dependency).
      cwd:    "/home/u/Server/Mert/context-mode/.cw/ctx-analytics",
      now:    Date.UTC(2026, 4, 10, 18, 0, 0),
      locale: "en-TR",
      tz:     "Europe/Istanbul",
    });

    // Five mandatory section headers, in order.
    const idx1 = text.indexOf("─── 1. Where you are now ───");
    const idx2 = text.indexOf("─── 2. What this chat captured");
    const idx3 = text.indexOf("─── 3. The scope, getting wider ───");
    const idx4 = text.indexOf("─── 4. The bottom line ───");
    const idx5 = text.indexOf("─── 5. What context-mode learned about how you work ───");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
    expect(idx4).toBeGreaterThan(idx3);
    expect(idx5).toBeGreaterThan(idx4);

    // Opener — the headline tally.
    expect(text).toMatch(/Across\s+\d+\s+days you ran\s+\d+\s+conversations/);
    // Single-unit auto-decimals: >= 100 drops the decimal (356 MB, not 356.0 MB).
    expect(text).toMatch(/context-mode kept\s+356 MB[^\n]*out of your context window/);

    // Section 1 — datetime + days alive + rescue.
    expect(text).toMatch(/started.*\d{4}.*at \d{2}:\d{2}/);
    expect(text).toMatch(/days alive · still going/);
    expect(text).toMatch(/\/compact fired — 1552 KB rescued from snapshot/);
    expect(text).toMatch(/How that .* built up/);

    // Section 2 — captures heading + ALL conversation categories.
    expect(text).toMatch(/things — files, errors, decisions, agent runs:/);
    expect(text).toMatch(/External docs indexed\s+500/);
    expect(text).toMatch(/Files tracked\s+132/);

    // Section 3 — receipt-style rows (no "$X · Y%" framing anymore).
    expect(text).toMatch(/This chat:/);
    expect(text).toMatch(/All your work:/);
    expect(text).toMatch(/17,493 captures across 123 projects/);

    // Section 4 — cost example + EXAMPLES disclaimer.
    expect(text).toMatch(/\$1399\.73 of Opus 4 tokens your team didn't burn/);
    expect(text).toMatch(/Opus rates shown for context/);

    // Section 5 — auto-memory tally.
    expect(text).toMatch(/22 preferences picked up across 6 projects/);

    // Footer.
    expect(text).toMatch(/Your AI talks less, remembers more, costs less/);
    expect(text).toMatch(/v1\.0\.111/);
  });

  // ── Cycle 2: Persistent memory bar block must use lifetime category counts ──
  // Aggregated across every SessionDB so the bars are never silently empty
  // when a fresh project's local DB has no events yet.
  test("persistent memory bars render from lifetime.categoryCounts when project DB is empty", () => {
    const fresh: FullReport = {
      ...baseReport(),
      projectMemory: {
        total_events: 0, // fresh project — no local events yet
        session_count: 0,
        by_category: [],
      },
    };
    const text = formatReport(fresh, "1.0.103", null, {
      lifetime: {
        totalEvents: 16_300,
        totalSessions: 489,
        autoMemoryCount: 0,
        autoMemoryProjects: 0,
        autoMemoryByPrefix: {},
        categoryCounts: { file: 8000, cwd: 5000, rule: 2000, git: 1000, env: 300 },
      },
    });
    // Lifetime header still present.
    expect(text).toMatch(/events.*sessions.*saved lifetime/);
    // Bar block now populated from lifetime categoryCounts.
    expect(text).toMatch(/Files tracked/);
    expect(text).toMatch(/Working directory/);
    // Must contain bar characters under the persistent memory header.
    expect(text).toMatch(/Persistent memory[\s\S]*?Files tracked[\s\S]*?█/);
  });
});
