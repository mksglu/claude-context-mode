/**
 * formatReport — Tests for the redesigned ctx_stats output.
 *
 * Design rules under test:
 * 1. Fresh session (totalKeptOut === 0) shows honest "no savings yet" format
 * 2. Active session shows before/after comparison bars
 * 3. Per-tool table only shown when 2+ different tools called
 * 4. No analytics JSON in default output
 * 5. Version shown at bottom
 * 6. Name is "context-mode", not "Think in Code"
 * 7. Under 15 lines for typical sessions
 * 8. Time gained is the hero metric
 */

import { describe, it, expect } from "vitest";
import { formatReport, type FullReport } from "../../src/session/analytics.js";

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function makeReport(overrides: Partial<FullReport> = {}): FullReport {
  return {
    savings: {
      processed_kb: 0,
      entered_kb: 0,
      saved_kb: 0,
      pct: 0,
      savings_ratio: 0,
      by_tool: [],
      total_calls: 0,
      total_bytes_returned: 0,
      kept_out: 0,
      total_processed: 0,
    },
    session: {
      id: "test-session",
      uptime_min: "2.0",
    },
    continuity: {
      total_events: 0,
      by_category: [],
      compact_count: 0,
      resume_ready: false,
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────

describe("formatReport", () => {
  describe("fresh session (no savings)", () => {
    it("shows 'no savings yet' when totalKeptOut is 0 and no calls", () => {
      const report = makeReport();
      const output = formatReport(report, "1.0.71");

      expect(output).toContain("context-mode -- session");
      expect(output).toContain("No tool calls yet.");
      expect(output).toContain("Tip:");
      expect(output).toContain("v1.0.71");
    });

    it("shows call count and bytes when calls exist but no savings", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 1,
          total_bytes_returned: 3891,
          kept_out: 0,
          by_tool: [
            { tool: "ctx_stats", calls: 1, context_kb: 3.8, tokens: 973 },
          ],
        },
      });
      const output = formatReport(report, "1.0.71");

      expect(output).toContain("1 tool call");
      expect(output).toContain("in context");
      expect(output).toContain("no savings yet");
      // Should NOT show before/after comparison
      expect(output).not.toContain("Without context-mode");
    });

    it("does not show fake percentages for fresh session", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 2,
          total_bytes_returned: 1600,
          kept_out: 0,
        },
      });
      const output = formatReport(report);

      expect(output).not.toMatch(/\d+\.\d+%/);
      expect(output).toContain("no savings yet");
    });
  });

  describe("active session (before/after comparison)", () => {
    it("shows before/after comparison bars", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 16,
          total_bytes_returned: 3277,
          kept_out: 536576, // 524 KB
          by_tool: [
            { tool: "ctx_batch_execute", calls: 5, context_kb: 1.1, tokens: 282 },
            { tool: "ctx_execute", calls: 3, context_kb: 0.8, tokens: 205 },
            { tool: "ctx_search", calls: 8, context_kb: 1.3, tokens: 333 },
          ],
        },
        continuity: {
          total_events: 47,
          by_category: [],
          compact_count: 3,
          resume_ready: true,
        },
      });
      const output = formatReport(report, "1.0.71");

      expect(output).toContain("Without context-mode:");
      expect(output).toContain("With context-mode:");
      expect(output).toContain("in your conversation");
      expect(output).toContain("never entered your conversation");
      expect(output).toContain("v1.0.71");
    });

    it("shows time gained as hero metric", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 2000,
          kept_out: 500000, // ~125 min saved
        },
      });
      const output = formatReport(report);
      expect(output).toMatch(/session time gained/);
    });

    it("shows per-tool table when 2+ tools used", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 8,
          total_bytes_returned: 2000,
          kept_out: 50000,
          by_tool: [
            { tool: "ctx_batch_execute", calls: 5, context_kb: 1.1, tokens: 282 },
            { tool: "ctx_execute", calls: 3, context_kb: 0.8, tokens: 205 },
          ],
        },
      });
      const output = formatReport(report);

      expect(output).toContain("ctx_batch_execute");
      expect(output).toContain("ctx_execute");
      expect(output).toContain("used");
    });

    it("does NOT show per-tool table when only 1 tool used", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 5,
          total_bytes_returned: 2000,
          kept_out: 50000,
          by_tool: [
            { tool: "ctx_batch_execute", calls: 5, context_kb: 2.0, tokens: 512 },
          ],
        },
      });
      const output = formatReport(report);
      // Only ctx_ references should be in the before/after explanation, not a tool table
      const toolTableLines = output.split("\n").filter((l) => l.trimStart().startsWith("ctx_"));
      expect(toolTableLines.length).toBe(0);
    });

    it("includes cache savings in totalKeptOut", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 5,
          total_bytes_returned: 1000,
          kept_out: 10000,
        },
        cache: {
          hits: 3,
          bytes_saved: 5000,
          ttl_hours_left: 20,
          total_with_cache: 16000,
          total_savings_ratio: 16,
        },
      });
      const output = formatReport(report);

      // totalKeptOut = 10000 + 5000 = 15000
      expect(output).toContain("Without context-mode:");
      expect(output).toContain("14.6 KB"); // 15000 / 1024 = 14.6 KB
      expect(output).toContain("never entered your conversation");
    });

    it("before bar is always full, after bar is proportional", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 5000,
          kept_out: 5000, // 50%
        },
      });
      const output = formatReport(report);
      const withoutLine = output.split("\n").find((l) => l.includes("Without context-mode"));
      const withLine = output.split("\n").find((l) => l.includes("With context-mode"));
      expect(withoutLine).toBeDefined();
      expect(withLine).toBeDefined();

      // Without bar should be fully filled (40 #)
      const withoutBarMatch = withoutLine!.match(/\|([#]+)\|/);
      expect(withoutBarMatch).not.toBeNull();
      expect(withoutBarMatch![1].length).toBe(40);

      // With bar: 50% = 20 # and 20 spaces
      const withBarMatch = withLine!.match(/\|([# ]+)\|/);
      expect(withBarMatch).not.toBeNull();
      const hashes = (withBarMatch![1].match(/#/g) || []).length;
      expect(hashes).toBe(20);
    });
  });

  describe("continuity footer", () => {
    it("shows compactions and events in footer", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 5,
          total_bytes_returned: 1000,
          kept_out: 50000,
        },
        continuity: {
          total_events: 47,
          by_category: [],
          compact_count: 3,
          resume_ready: false,
        },
      });
      const output = formatReport(report, "1.0.71");

      expect(output).toContain("3 compactions");
      expect(output).toContain("47 events preserved");
      expect(output).toContain("v1.0.71");
    });

    it("omits compaction count when zero", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 5,
          total_bytes_returned: 1000,
          kept_out: 50000,
        },
        continuity: {
          total_events: 10,
          by_category: [],
          compact_count: 0,
          resume_ready: false,
        },
      });
      const output = formatReport(report);

      expect(output).not.toContain("compaction");
      expect(output).toContain("10 events preserved");
    });
  });

  describe("output constraints", () => {
    it("uses 'context-mode' as name, not 'Think in Code'", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 2000,
          kept_out: 100000,
        },
      });
      const output = formatReport(report);

      expect(output).toContain("context-mode");
      expect(output).not.toContain("Think in Code");
    });

    it("does not include analytics JSON", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 2000,
          kept_out: 100000,
        },
      });
      const output = formatReport(report);

      expect(output).not.toContain("```json");
      expect(output).not.toContain("Analytics (27");
    });

    it("active session output is under 15 lines", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 16,
          total_bytes_returned: 3277,
          kept_out: 536576,
          by_tool: [
            { tool: "ctx_batch_execute", calls: 5, context_kb: 1.1, tokens: 282 },
            { tool: "ctx_execute", calls: 3, context_kb: 0.8, tokens: 205 },
            { tool: "ctx_search", calls: 8, context_kb: 1.3, tokens: 333 },
          ],
        },
        continuity: {
          total_events: 47,
          by_category: [],
          compact_count: 3,
          resume_ready: true,
        },
      });
      const output = formatReport(report, "1.0.71");
      const lineCount = output.split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(15);
    });

    it("fresh session output is under 15 lines", () => {
      const report = makeReport();
      const output = formatReport(report, "1.0.71");
      const lineCount = output.split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(15);
    });

    it("does not contain emojis", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 2000,
          kept_out: 100000,
        },
      });
      const output = formatReport(report, "1.0.71");
      // Check for common emoji ranges
      expect(output).not.toMatch(
        /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u,
      );
    });
  });

  describe("version handling", () => {
    it("shows outdated warning when latestVersion differs", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 2000,
          kept_out: 100000,
        },
      });
      const output = formatReport(report, "1.0.65", "1.0.70");
      expect(output).toContain("Update available");
      expect(output).toContain("v1.0.65 -> v1.0.70");
      expect(output).toContain("ctx_upgrade");
    });

    it("no outdated warning when version matches", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 2000,
          kept_out: 100000,
        },
      });
      const output = formatReport(report, "1.0.70", "1.0.70");
      expect(output).not.toContain("Update available");
    });

    it("shows outdated warning on fresh session too", () => {
      const report = makeReport();
      const output = formatReport(report, "1.0.65", "1.0.70");
      expect(output).toContain("Update available");
    });

    it("shows version when provided", () => {
      const report = makeReport();
      const output = formatReport(report, "1.0.71");
      expect(output).toContain("v1.0.71");
    });

    it("falls back to 'context-mode' when version not provided", () => {
      const report = makeReport();
      const output = formatReport(report);
      expect(output).toContain("context-mode");
    });
  });

  describe("duration formatting", () => {
    it("shows minutes for short sessions", () => {
      const report = makeReport({
        session: { ...makeReport().session, uptime_min: "2.0" },
      });
      const output = formatReport(report);
      expect(output).toContain("session (2 min)");
    });

    it("shows hours and minutes for long sessions", () => {
      const report = makeReport({
        session: { ...makeReport().session, uptime_min: "45.0" },
      });
      const output = formatReport(report);
      expect(output).toContain("session (45 min)");
    });

    it("shows hours format for 60+ minutes", () => {
      const report = makeReport({
        session: { ...makeReport().session, uptime_min: "90.0" },
      });
      const output = formatReport(report);
      expect(output).toContain("session (1h 30m)");
    });
  });
});
