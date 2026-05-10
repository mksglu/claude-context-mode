#!/usr/bin/env tsx
/**
 * Production proof script — invokes the EXACT formatReport handler the
 * production ctx_stats MCP tool calls (src/server.ts:2636) with the
 * Mert-approved demo fixture (67 days × 128 conversations × 356 MB
 * lifetime / 1277 captures × 12 days × 1552 KB rescue conversation)
 * and prints the rendered string verbatim.
 *
 * Use this to validate the ctx_stats output WITHOUT having to wait for
 * a real conversation to age 67 days / accumulate 17,493 captures. The
 * script wires the same opts the production handler wires (`conversation`,
 * `lifetime`, `multiAdapter`, `realBytes`) plus deterministic locale/tz/
 * cwd/now for byte-stable output.
 *
 * Run:
 *   npx tsx scripts/prove-narrative-render.ts
 */

import { formatReport } from "../src/session/analytics.js";
import type {
  AdapterScanResult,
  ConversationStats,
  FullReport,
  LifetimeStats,
  MultiAdapterLifetimeStats,
  RealBytesStats,
} from "../src/session/analytics.js";

// ── Demo fixture — mirrors the Mert-approved target output exactly.
const report: FullReport = {
  savings: {
    processed_kb: 0, entered_kb: 0, saved_kb: 0, pct: 0, savings_ratio: 0,
    by_tool: [],
    total_calls: 0, total_bytes_returned: 0, kept_out: 0, total_processed: 0,
  },
  session: { id: "demo-conv", uptime_min: "0" },
  continuity: { total_events: 0, by_category: [], compact_count: 0, resume_ready: false },
  projectMemory: {
    total_events: 1277, session_count: 1,
    by_category: [],
  },
};

const conversation: ConversationStats = {
  sessionId: "demo-conv",
  events: 1277,
  dbCount: 1,
  daysAlive: 12.0,
  snapshotBytes: 1552 * 1024,
  snapshotsConsumed: 1,
  byCategory: [
    { category: "external-ref",     count: 500, label: "External docs indexed" },
    { category: "file",             count: 132, label: "Files tracked" },
    { category: "error",            count: 119, label: "Errors caught" },
    { category: "constraint",       count: 100, label: "Constraints you set" },
    { category: "git",              count:  78, label: "Git operations" },
    { category: "subagent",         count:  62, label: "Delegated work" },
    { category: "agent-finding",    count:  58, label: "Agent insights kept" },
    { category: "latency",          count:  55, label: "Slow tools recorded" },
    { category: "rejected-approach",count:  39, label: "Approaches you rejected" },
    { category: "intent",           count:  33, label: "Session goal" },
    { category: "decision",         count:  28, label: "Your decisions" },
    { category: "cwd",              count:  27, label: "Working directory" },
    { category: "data",             count:  24, label: "Data references" },
    { category: "user-prompt",      count:  12, label: "Your messages remembered" },
    { category: "env",              count:   6, label: "Environment setup" },
    { category: "skill",            count:   2, label: "Skills used" },
    { category: "role",             count:   1, label: "Behavior rules" },
    { category: "task",             count:   1, label: "Tasks in progress" },
  ],
  firstEventMs: Date.UTC(2026, 3, 28, 9, 16, 0),  // 28 Apr 12:16 Istanbul
  lastEventMs:  Date.UTC(2026, 4, 10, 17, 54, 0),
  lastRescueMs: Date.UTC(2026, 4, 9, 17, 54, 0),  //  9 May 20:54 Istanbul
  byDay: [
    { ms: Date.UTC(2026, 3, 28),  count: 277 },
    { ms: Date.UTC(2026, 4,  3),  count: 201 },
    { ms: Date.UTC(2026, 4,  4),  count: 438 },                            // peak
    { ms: Date.UTC(2026, 4,  9),  count: 261, rescueBytes: 1552 * 1024 }, // rescue
    { ms: Date.UTC(2026, 4, 10),  count: 100 },
  ],
};

const lifetime: LifetimeStats = {
  totalEvents: 17_493,
  totalSessions: 128,
  autoMemoryCount: 22,
  autoMemoryProjects: 6,
  autoMemoryByPrefix: { project: 11, feedback: 7, user: 3, reference: 1 },
  categoryCounts: {},
  rescueBytes: 1552 * 1024,
  firstEventMs: Date.UTC(2026, 2, 4),  // 4 Mar 2026
  distinctProjects: 123,
};

const multiAdapter: MultiAdapterLifetimeStats = {
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

// Real-bytes drives the section-3 receipt + section-4 cost example.
const realBytesLifetime: RealBytesStats = {
  eventDataBytes:   80_000_000,
  bytesAvoided:    285_000_000,
  bytesReturned:     2_000_000,
  snapshotBytes:     8_261_000,
  totalSavedTokens: 93_315_333, // back-solved to produce the target $1399.73
};
const realBytesConversation: RealBytesStats = {
  eventDataBytes: 1_500_000,
  bytesAvoided:   1_400_000,
  bytesReturned:    100_000,
  snapshotBytes:  1_552 * 1024,
  totalSavedTokens: 776_300,
};

// ── Render — production code path, deterministic env.
const text = formatReport(report, "1.0.111", null, {
  conversation,
  lifetime,
  multiAdapter,
  realBytes: { lifetime: realBytesLifetime, conversation: realBytesConversation },
  cwd:    "/home/u/Server/Mert/context-mode/.cw/ctx-analytics",
  // 67 days after lifetime.firstEventMs (2026-03-04) — matches the
  // Mert-approved demo target exactly. 67 days × 86_400_000 ms.
  now:    Date.UTC(2026, 2, 4) + 67 * 86_400_000,
  locale: "en-TR",
  tz:     "Europe/Istanbul",
});

console.log(text);
