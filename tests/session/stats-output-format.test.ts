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
import type { FullReport, LifetimeStats } from "../../src/session/analytics.js";

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
  return { totalEvents: 0, totalSessions: 0, autoMemoryCount: 0, autoMemoryProjects: 0, autoMemoryByPrefix: {} };
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

  test("computes the real overflow count (not hardcoded '9 more')", () => {
    const text = formatReport(baseReport(), "1.0.103", null, {
      lifetime: emptyLifetime(),
    });
    // baseReport has 8 categories; we render 2 → 6 more.
    expect(text).toMatch(/6 more categories/);
    expect(text).not.toMatch(/9 more categories/);
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

  test("renders auto-memory section when files are present", () => {
    const text = formatReport(baseReport(), "1.0.103", null, {
      lifetime: {
        totalEvents: 160,
        totalSessions: 40,
        autoMemoryCount: 18,
        autoMemoryProjects: 6,
        autoMemoryByPrefix: { user: 4, feedback: 7, project: 5, reference: 2 },
      },
    });
    expect(text).toMatch(/Auto-memory/);
    expect(text).toMatch(/18 preferences learned/);
    expect(text).toMatch(/across 6 projects/);
    expect(text).toMatch(/feedback\s+7/);
  });
});
