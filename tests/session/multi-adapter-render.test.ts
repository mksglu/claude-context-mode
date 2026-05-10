/**
 * multi-adapter-render — B3b Slices 3.2/3.3/3.4/3.5/3.6
 *
 * Renderer-layer wiring for the multi-adapter aggregation that
 * `getMultiAdapterLifetimeStats` / `getMultiAdapterRealBytesStats`
 * produce (src/session/analytics.ts:1248-1326). Engineer #74 owns
 * the aggregation; this file pins the format the renderer must
 * produce when the new `multiAdapter` opt is supplied.
 *
 * Mert-approved demo design (PRD B3b Slice 3.2):
 *
 *   Where it came from (tools you actually used — fixtures + probes filtered):
 *
 *     Tool          Captures   Indexed     Total kept out
 *     Claude Code     17.413   276.7 MB        291.1 MB
 *     JetBrains            —     8.6 MB          8.6 MB
 *
 *     Skipped (7): Cursor, Codex CLI, Pi, Kiro, Gemini CLI, Openclaw
 *     These adapters have DBs on disk but only test fixtures, dev skeletons,
 *     or detection probes — no real chat activity.
 *
 * Slice 3.5 backward compat is asserted indirectly: this file passes the
 * `multiAdapter` opt and asserts new behaviour. The pre-existing
 * `tests/session/stats-output-format.test.ts` keeps running unchanged
 * to prove that omitting the opt preserves the legacy renderer output.
 */

import { describe, expect, test } from "vitest";
import { formatReport } from "../../src/session/analytics.js";
import type {
  AdapterScanResult,
  FullReport,
  LifetimeStats,
  MultiAdapterLifetimeStats,
} from "../../src/session/analytics.js";

function baseReport(): FullReport {
  // Mirrors tests/session/stats-output-format.test.ts:14-49 so the legacy
  // assertions stay applicable in the absence of the multiAdapter opt.
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
        { category: "rule", count: 80, label: "Project rules (CLAUDE.md)" },
      ],
    },
  };
}

function lifetime(): LifetimeStats {
  return {
    totalEvents: 17_500,
    totalSessions: 489,
    autoMemoryCount: 0,
    autoMemoryProjects: 0,
    autoMemoryByPrefix: {},
    categoryCounts: { file: 8000, cwd: 5000, rule: 2000, git: 1500, env: 1000 },
    rescueBytes: 1_500_000,
    firstEventMs: Date.UTC(2026, 3, 14),
    distinctProjects: 12,
  };
}

/**
 * Adapter row factory — mirrors the AdapterScanResult shape Engineer #74
 * exposes from `getMultiAdapterLifetimeStats().perAdapter`
 * (src/session/analytics.ts:1091-1114).
 */
function adapter(name: string, opts: {
  events?: number;
  data?: number;
  rescue?: number;
  content?: number;
  convs?: number;
  projects?: string[];
  firstMs?: number;
  lastMs?: number;
  isReal?: boolean;
}): AdapterScanResult {
  return {
    name,
    eventCount: opts.events ?? 0,
    sessionCount: opts.convs ?? 0,
    dataBytes: opts.data ?? 0,
    rescueBytes: opts.rescue ?? 0,
    contentBytes: opts.content ?? 0,
    uuidConvs: opts.convs ?? 0,
    projectDirs: opts.projects ?? [],
    firstMs: opts.firstMs ?? Date.UTC(2026, 3, 14),
    lastMs: opts.lastMs ?? Date.UTC(2026, 4, 9),
    isReal: opts.isReal ?? false,
  };
}

function multi(rows: AdapterScanResult[]): MultiAdapterLifetimeStats {
  const totalEvents   = rows.reduce((s, r) => s + r.eventCount, 0);
  const totalSessions = rows.reduce((s, r) => s + r.sessionCount, 0);
  const totalBytes    = rows.reduce((s, r) => s + r.dataBytes + r.rescueBytes, 0);
  return { totalEvents, totalSessions, totalBytes, perAdapter: rows };
}

describe("Slice 3.2 — formatReport renders 'Where it came from' sub-block", () => {
  test("emits 'Where it came from' header when multiAdapter has >= 2 real adapters", () => {
    const text = formatReport(baseReport(), "1.0.111", null, {
      lifetime: lifetime(),
      multiAdapter: multi([
        adapter("claude-code", { events: 17_413, data: 276_700_000, rescue: 14_400_000, projects: new Array(12).fill(0).map((_, i) => `/p/${i}`), isReal: true }),
        adapter("jetbrains-copilot", { events: 1_200, data: 8_600_000, projects: new Array(6).fill(0).map((_, i) => `/jb/${i}`), isReal: true }),
      ]),
    });
    expect(text).toMatch(/Where it came from/);
    // Real adapters render with marketing-grade labels (not raw IDs).
    expect(text).toMatch(/Claude Code/);
    expect(text).toMatch(/JetBrains/);
  });

  test("each rendered adapter row shows captures count and a byte total", () => {
    const text = formatReport(baseReport(), "1.0.111", null, {
      lifetime: lifetime(),
      multiAdapter: multi([
        adapter("claude-code", { events: 17_413, data: 276_700_000, rescue: 14_400_000, projects: new Array(12).fill(0).map((_, i) => `/p/${i}`), isReal: true }),
        adapter("jetbrains-copilot", { events: 1_200, data: 8_600_000, projects: new Array(6).fill(0).map((_, i) => `/jb/${i}`), isReal: true }),
      ]),
    });
    // Captures count formatted with K/M suffixes from fmtNum().
    expect(text).toMatch(/17\.4K|17,413|17\.4 K/);
    // Bytes formatted via the existing kb() helper → "276.7 MB" or similar.
    expect(text).toMatch(/MB/);
  });

  test("when no real adapters exist, no 'Where it came from' header is emitted", () => {
    const text = formatReport(baseReport(), "1.0.111", null, {
      lifetime: lifetime(),
      multiAdapter: multi([
        adapter("claude-code", { events: 5, data: 100, projects: ["/p"], isReal: false }),
      ]),
    });
    expect(text).not.toMatch(/Where it came from/);
  });
});

describe("Slice 3.3 — Skipped adapters disclosure", () => {
  test("lists skipped adapter names with count and 'no real chat activity' rationale", () => {
    const text = formatReport(baseReport(), "1.0.111", null, {
      lifetime: lifetime(),
      multiAdapter: multi([
        adapter("claude-code", { events: 17_413, data: 276_700_000, projects: new Array(12).fill(0).map((_, i) => `/p/${i}`), isReal: true }),
        adapter("cursor",      { events: 5, data: 100, projects: ["/p/c"], isReal: false }),
        adapter("codex",       { events: 2, data: 50,  projects: ["/p/cdx"], isReal: false }),
        adapter("pi",          { events: 1, data: 20,  projects: ["/p/pi"], isReal: false }),
      ]),
    });
    expect(text).toMatch(/Skipped \(3\):/);
    // Marketing names appear in the skipped list, not raw IDs.
    expect(text).toMatch(/Cursor/);
    expect(text).toMatch(/Codex/);
    expect(text).toMatch(/Pi/);
    // Disclosure rationale.
    expect(text).toMatch(/no real chat activity/i);
  });

  test("when no adapters are skipped, no 'Skipped' line appears", () => {
    const text = formatReport(baseReport(), "1.0.111", null, {
      lifetime: lifetime(),
      multiAdapter: multi([
        adapter("claude-code", { events: 17_413, data: 276_700_000, projects: new Array(12).fill(0).map((_, i) => `/p/${i}`), isReal: true }),
        adapter("jetbrains-copilot", { events: 1_200, data: 8_600_000, projects: new Array(6).fill(0).map((_, i) => `/jb/${i}`), isReal: true }),
      ]),
    });
    expect(text).not.toMatch(/Skipped \(/);
  });
});

describe("Slice 3.4 — Headline updates", () => {
  test("opening tagline mentions 'across N AI tools' when multiAdapter has >= 2 real adapters", () => {
    const text = formatReport(baseReport(), "1.0.111", null, {
      lifetime: lifetime(),
      multiAdapter: multi([
        adapter("claude-code",       { events: 17_413, data: 276_700_000, projects: new Array(12).fill(0).map((_, i) => `/p/${i}`), isReal: true }),
        adapter("jetbrains-copilot", { events: 1_200, data: 8_600_000,    projects: new Array(6).fill(0).map((_, i) => `/jb/${i}`), isReal: true }),
      ]),
    });
    // Phrase: "across N AI tools" — N is the real-adapter count.
    expect(text).toMatch(/across\s+2\s+AI\s+tools/i);
  });

  test("falls back to 'in Claude Code' framing when only one real adapter present", () => {
    const text = formatReport(baseReport(), "1.0.111", null, {
      lifetime: lifetime(),
      multiAdapter: multi([
        adapter("claude-code", { events: 17_413, data: 276_700_000, projects: new Array(12).fill(0).map((_, i) => `/p/${i}`), isReal: true }),
        adapter("cursor",      { events: 5, data: 100, projects: ["/p/c"], isReal: false }),
      ]),
    });
    expect(text).toMatch(/in\s+Claude\s+Code/);
    expect(text).not.toMatch(/across\s+1\s+AI\s+tools/i);
  });
});

describe("Slice 3.6 — Cross-adapter scope ladder ('the receipt — getting wider')", () => {
  test("receipt section names 'All your work everywhere' when multiAdapter present", () => {
    const text = formatReport(baseReport(), "1.0.111", null, {
      lifetime: lifetime(),
      multiAdapter: multi([
        adapter("claude-code",       { events: 17_413, data: 276_700_000, projects: new Array(12).fill(0).map((_, i) => `/p/${i}`), isReal: true }),
        adapter("jetbrains-copilot", { events: 1_200, data: 8_600_000,    projects: new Array(6).fill(0).map((_, i) => `/jb/${i}`), isReal: true }),
      ]),
    });
    expect(text).toMatch(/All your work everywhere/i);
  });
});
