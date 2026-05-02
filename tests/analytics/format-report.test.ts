/**
 * formatReport — Tests for the visual savings dashboard output.
 *
 * Design rules under test:
 * 1. Fresh session (totalKeptOut === 0) shows honest "no savings yet" format
 * 2. Active session: hero metric is "X tokens saved" with percentage
 * 3. Before/After comparison bars are the visual proof
 * 4. Per-tool table shows what each tool SAVED, sorted by impact
 * 5. Session memory: one line, reframed as value
 * 6. No: Pct column, category tables, tips, jargon, "efficiency meter"
 * 7. Under 22 lines for heavy sessions, under 8 for fresh
 * 8. Version and update info in footer
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
    projectMemory: {
      total_events: 0,
      session_count: 0,
      by_category: [],
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────

describe("formatReport", () => {
  describe("fresh session (no savings)", () => {
    it("shows no tool calls message when zero calls", () => {
      const report = makeReport();
      const output = formatReport(report, "1.0.71");

      expect(output).toContain("context-mode");
      expect(output).toContain("0 calls");
      expect(output).toContain("No tool calls yet");
      expect(output).toContain("v1.0.71");
    });

    it("shows context size and zero tokens saved when calls exist but no savings", () => {
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

      expect(output).toContain("1 calls");
      expect(output).toContain("entered context");
      expect(output).toContain("0 tokens saved");
      // Should NOT show the hero metric line or bars
      expect(output).not.toContain("tokens saved  ·");
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

      expect(output).not.toMatch(/\d+\.\d+% reduction/);
      expect(output).toContain("0 tokens saved");
    });
  });

  describe("active session (savings dashboard)", () => {
    it("shows hero metric: tokens saved with percentage and duration", () => {
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

      expect(output).toContain("tokens saved");
      expect(output).toContain("reduction");
      expect(output).toContain("v1.0.71");
    });

    it("shows before/after comparison bars", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 2000,
          kept_out: 8000, // 80%
        },
      });
      const output = formatReport(report);

      expect(output).toContain("Without context-mode");
      expect(output).toContain("With context-mode");
      // Bars should contain unicode block characters
      expect(output).toMatch(/[█░]/);
      // The "Without" bar should be longer than "With" bar
      const withoutLine = output.split("\n").find((l: string) => l.includes("Without"));
      const withLine = output.split("\n").find((l: string) => l.includes("With context-mode"));
      expect(withoutLine).toBeDefined();
      expect(withLine).toBeDefined();
      const withoutFilled = (withoutLine!.match(/█/g) || []).length;
      const withFilled = (withLine!.match(/█/g) || []).length;
      expect(withoutFilled).toBeGreaterThan(withFilled);
    });

    it("shows per-tool table when 2+ tools used, sorted by saved", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 8,
          total_bytes_returned: 2000,
          kept_out: 50000,
          by_tool: [
            { tool: "ctx_execute", calls: 3, context_kb: 0.8, tokens: 205 },
            { tool: "ctx_batch_execute", calls: 5, context_kb: 1.1, tokens: 282 },
          ],
        },
      });
      const output = formatReport(report);

      expect(output).toContain("ctx_batch_execute");
      expect(output).toContain("ctx_execute");
      expect(output).toContain("calls");
      expect(output).toContain("saved");

      // batch_execute has more context_kb so more estimated saved - should be first
      const lines = output.split("\n");
      const batchLine = lines.findIndex((l: string) => l.includes("ctx_batch_execute"));
      const execLine = lines.findIndex((l: string) => l.includes("ctx_execute"));
      expect(batchLine).toBeLessThan(execLine);
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

      // Should not show tool rows (indented tool lines)
      const toolLines = output.split("\n").filter((l: string) => l.match(/^\s+ctx_/));
      expect(toolLines.length).toBe(0);
    });

    it("includes cache savings in totalKeptOut and shows cache hits", () => {
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

      // totalKeptOut = 10000 + 5000 = 15000, grandTotal = 16000
      // savingsPct = 15000/16000 = 93.75%
      expect(output).toContain("93.8%");
      expect(output).toContain("cache hits");
    });

    it("tokens saved uses K/M suffixes for large numbers", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 100,
          total_bytes_returned: 4_000_000,
          kept_out: 25_000_000,
        },
      });
      const output = formatReport(report);

      // 25MB / 4 bytes per token = 6.25M tokens
      expect(output).toMatch(/6\.3M/);
    });

    it("does NOT show Pct column, Tip lines, or category breakdown table", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 2000,
          kept_out: 8000,
          by_tool: [
            { tool: "ctx_batch_execute", calls: 5, context_kb: 1.0, tokens: 256 },
            { tool: "ctx_execute", calls: 5, context_kb: 1.0, tokens: 256 },
          ],
        },
        continuity: {
          total_events: 100,
          by_category: [
            { category: "file", count: 50, label: "Files tracked", preview: "a.ts", why: "" },
            { category: "git", count: 30, label: "Git ops", preview: "main", why: "" },
          ],
          compact_count: 0,
          resume_ready: false,
        },
      });
      const output = formatReport(report);

      expect(output).not.toContain("Pct");
      expect(output).not.toContain("Tip:");
      expect(output).not.toContain("file 50");
      expect(output).not.toContain("git 30");
    });
  });

  describe("project memory", () => {
    it("shows project memory with category bars when data exists", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 2000,
          kept_out: 100000,
        },
        projectMemory: {
          total_events: 1656,
          session_count: 6,
          by_category: [
            { category: "file", count: 752, label: "Files tracked" },
            { category: "prompt", count: 250, label: "Prompts saved" },
            { category: "subagent", count: 202, label: "Delegated work" },
            { category: "git", count: 155, label: "Git operations" },
            { category: "rule", count: 152, label: "Project rules" },
            { category: "error", count: 61, label: "Errors caught" },
            { category: "decision", count: 27, label: "Your decisions" },
          ],
        },
      });
      const output = formatReport(report, "1.0.71");

      // New format (Bug #3 fix): "Persistent memory" header with lifetime line.
      expect(output).toContain("Persistent memory");
      expect(output).toContain("1.7K events");
      expect(output).toContain("6 sessions");
      expect(output).toContain("Files tracked");
      // Only top 2 categories are visible; rest collapse to "N more categories".
      // Bars should contain unicode block characters.
      expect(output).toMatch(/[█░]/);
    });

    it("shows project memory bars on fresh session too", () => {
      const report = makeReport({
        projectMemory: {
          total_events: 100,
          session_count: 2,
          by_category: [
            { category: "file", count: 50, label: "Files tracked" },
            { category: "git", count: 30, label: "Git operations" },
          ],
        },
      });
      const output = formatReport(report, "1.0.71");

      // New format: "Persistent memory" header + cumulative line.
      expect(output).toContain("Persistent memory");
      expect(output).toContain("100 events");
      expect(output).toContain("2 sessions");
      expect(output).toContain("Files tracked");
      expect(output).toContain("Git operations");
      expect(output).toMatch(/█/);
    });

    it("categories sorted by count DESC — highest first", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 5,
          total_bytes_returned: 1000,
          kept_out: 50000,
        },
        projectMemory: {
          total_events: 100,
          session_count: 3,
          by_category: [
            { category: "file", count: 60, label: "Files tracked" },
            { category: "git", count: 25, label: "Git operations" },
            { category: "error", count: 15, label: "Errors caught" },
          ],
        },
      });
      const output = formatReport(report, "1.0.71");
      const lines = output.split("\n");
      const fileLine = lines.findIndex((l: string) => l.includes("Files tracked"));
      const gitLine = lines.findIndex((l: string) => l.includes("Git operations"));
      // Top-2 cap (Bug #5): "Errors caught" rolls into "1 more category".
      expect(fileLine).toBeLessThan(gitLine);
      expect(output).toContain("1 more categor");
    });

    it("hides project memory when no events", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 5,
          total_bytes_returned: 1000,
          kept_out: 50000,
        },
        projectMemory: {
          total_events: 0,
          session_count: 0,
          by_category: [],
        },
      });
      const output = formatReport(report);

      expect(output).not.toContain("events remembered");
    });

    it("singular session label for 1 session", () => {
      const report = makeReport({
        projectMemory: {
          total_events: 25,
          session_count: 1,
          by_category: [
            { category: "file", count: 25, label: "Files tracked" },
          ],
        },
      });
      const output = formatReport(report);

      // New format includes "1 session" (no plural "s").
      expect(output).toContain("1 session");
      expect(output).not.toMatch(/\d+ sessions/);
    });
  });

  describe("output constraints", () => {
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
    });

    it("active session with tools + project memory is under 32 lines", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 184,
          total_bytes_returned: 4_194_304,  // 4 MB
          kept_out: 26_314_342,             // ~25.1 MB
          by_tool: [
            { tool: "ctx_batch_execute", calls: 126, context_kb: 2800, tokens: 717_000 },
            { tool: "ctx_search", calls: 35, context_kb: 760, tokens: 194_560 },
            { tool: "ctx_execute", calls: 22, context_kb: 390, tokens: 99_840 },
            { tool: "ctx_fetch_and_index", calls: 1, context_kb: 50, tokens: 12_800 },
          ],
        },
        projectMemory: {
          total_events: 1109,
          session_count: 4,
          by_category: [
            { category: "file", count: 554, label: "Files tracked" },
            { category: "subagent", count: 174, label: "Delegated work" },
            { category: "prompt", count: 122, label: "Requests saved" },
            { category: "rule", count: 96, label: "Project rules" },
            { category: "git", count: 89, label: "Git operations" },
            { category: "error", count: 35, label: "Errors caught" },
          ],
        },
      });
      const output = formatReport(report, "1.0.71");
      const lineCount = output.split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(32);
    });

    it("fresh session output is under 14 lines without project memory", () => {
      // After Bug #8 we always render a 5-line "Bottom line" footer, so the
      // empty-state header now fits within ~13 lines instead of the old 8.
      const report = makeReport();
      const output = formatReport(report, "1.0.71");
      const lineCount = output.split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(14);
    });
  });

  describe("version handling", () => {
    it("shows update warning when latestVersion differs", () => {
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

    it("no update warning when version matches", () => {
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

    it("shows update warning on fresh session too", () => {
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
      expect(output).toContain("2 min");
    });

    it("shows minutes for medium sessions", () => {
      const report = makeReport({
        session: { ...makeReport().session, uptime_min: "45.0" },
      });
      const output = formatReport(report);
      expect(output).toContain("45 min");
    });

    it("shows hours format for 60+ minutes", () => {
      const report = makeReport({
        session: { ...makeReport().session, uptime_min: "90.0" },
      });
      const output = formatReport(report);
      expect(output).toContain("1h 30m");
    });
  });

  describe("realistic scenario: heavy session", () => {
    it("produces the expected output shape for a 184-call session", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 184,
          total_bytes_returned: 4_194_304,  // 4 MB
          kept_out: 26_314_342,             // ~25.1 MB
          by_tool: [
            { tool: "ctx_batch_execute", calls: 126, context_kb: 2800, tokens: 717_000 },
            { tool: "ctx_search", calls: 35, context_kb: 760, tokens: 194_560 },
            { tool: "ctx_execute", calls: 22, context_kb: 390, tokens: 99_840 },
            { tool: "ctx_fetch_and_index", calls: 1, context_kb: 50, tokens: 12_800 },
          ],
        },
        cache: {
          hits: 3,
          bytes_saved: 524_288,
          ttl_hours_left: 18,
          total_with_cache: 31_032_934,
          total_savings_ratio: 7.4,
        },
        session: {
          id: "heavy-session",
          uptime_min: "306.0",
        },
        projectMemory: {
          total_events: 1109,
          session_count: 4,
          by_category: [
            { category: "file", count: 554, label: "Files tracked" },
            { category: "subagent", count: 174, label: "Delegated work" },
            { category: "prompt", count: 122, label: "Requests saved" },
            { category: "rule", count: 96, label: "Project rules" },
            { category: "git", count: 89, label: "Git operations" },
            { category: "error", count: 35, label: "Errors caught" },
          ],
        },
      });
      const output = formatReport(report, "1.0.71");

      // Hero metric: tokens saved with percentage
      expect(output).toMatch(/6\.\d+M tokens saved/);
      expect(output).toContain("reduction");
      expect(output).toContain("5h 6m");

      // Before/After bars
      expect(output).toContain("Without context-mode");
      expect(output).toContain("With context-mode");

      // Per-tool breakdown
      expect(output).toContain("ctx_batch_execute");
      expect(output).toContain("ctx_search");
      expect(output).toContain("ctx_execute");
      expect(output).toContain("ctx_fetch_and_index");

      // Cache
      expect(output).toContain("cache hits");

      // Project memory (new format — "Persistent memory" header + lifetime line).
      expect(output).toContain("Persistent memory");
      expect(output).toContain("1.1K events");
      expect(output).toContain("4 sessions");
      expect(output).toContain("Files tracked");

      // Footer
      expect(output).toContain("v1.0.71");

      // No forbidden elements
      expect(output).not.toContain("Tip:");
      expect(output).not.toContain("Pct");

      // Verify line lengths are reasonable
      const allLines = output.split("\n");
      for (const line of allLines) {
        expect(line.length).toBeLessThanOrEqual(100);
      }
    });

    it("the visual output matches the design spec", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 184,
          total_bytes_returned: 4_194_304,
          kept_out: 26_314_342,
          by_tool: [
            { tool: "ctx_batch_execute", calls: 126, context_kb: 3686.4, tokens: 943_718 },
            { tool: "ctx_search", calls: 35, context_kb: 406, tokens: 103_936 },
            { tool: "ctx_execute", calls: 22, context_kb: 37, tokens: 9_472 },
            { tool: "ctx_fetch_and_index", calls: 1, context_kb: 0.1, tokens: 26 },
          ],
        },
        cache: {
          hits: 3,
          bytes_saved: 524_288,
          ttl_hours_left: 18,
          total_with_cache: 31_032_934,
          total_savings_ratio: 7.4,
        },
        session: {
          id: "heavy-session",
          uptime_min: "306.0",
        },
        projectMemory: {
          total_events: 1109,
          session_count: 4,
          by_category: [
            { category: "file", count: 554, label: "Files tracked" },
            { category: "subagent", count: 174, label: "Delegated work" },
          ],
        },
      });
      const output = formatReport(report, "1.0.71");

      // Print for visual inspection during development
      // console.log(output);

      // Structure checks
      const lines = output.split("\n");

      // Line 0: Hero metric
      expect(lines[0]).toMatch(/tokens saved\s+·\s+.*reduction\s+·\s+5h 6m/);

      // Lines 2-3: Before/After bars
      expect(lines[2]).toMatch(/Without context-mode\s+\|█+\|\s+\d/);
      expect(lines[3]).toMatch(/With context-mode\s+\|█+░+\|\s+\d/);

      // "kept out" value statement
      expect(output).toContain("kept out of your conversation");

      // Stats line
      expect(output).toContain("184 calls");

      // Tool breakdown (4 tools)
      const toolLines = lines.filter((l: string) => l.match(/^\s+ctx_/));
      expect(toolLines.length).toBe(4);

      // Total under 32 lines
      expect(lines.length).toBeLessThanOrEqual(32);
    });
  });
});
