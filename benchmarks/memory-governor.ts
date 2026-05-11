import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { MCPStdioClient } from "../src/adapters/pi/mcp-bridge.js";
import { resolveSessionDbPath, SessionDB } from "../src/session/db.js";
import {
  buildContinuousMemoryCapsule,
  getLatestContinuousMemoryCapsule,
  type MemoryGovernorEvent,
} from "../src/session/memory-governor.js";

interface Scenario {
  name: string;
  description: string;
  events: MemoryGovernorEvent[];
}

interface BenchResult {
  name: string;
  events: number;
  rawBytes: number;
  capsuleBytes: number;
  rawTokens: number;
  capsuleTokens: number;
  savedPercent: number;
  compressionRatio: number;
  largestEventBytes: number;
  recallSummaryBytes: number;
  avgBuildMs: number;
  p95BuildMs: number;
  persisted: boolean;
}

interface McpBenchResult {
  scenario: string;
  tools: number;
  curateMs: number;
  recallMs: number;
  curateBytes: number;
  recallBytes: number;
  rawBytes: number;
  returnedSavedPercent: number;
}

const ITERATIONS = Number(process.env.MEMORY_GOVERNOR_BENCH_ITERS ?? 200);
const CAPSULE_BUDGET_TOKENS = Number(process.env.MEMORY_GOVERNOR_BUDGET_TOKENS ?? 1200);
const CAPSULE_BUDGET_BYTES = CAPSULE_BUDGET_TOKENS * 4;
const RUN_MCP = process.argv.includes("--mcp") || process.env.MEMORY_GOVERNOR_BENCH_MCP === "1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function approxTokens(value: number): number {
  return Math.ceil(value / 4);
}

function event(type: string, category: string, data: string, priority = 2): MemoryGovernorEvent {
  return { type, category, data, priority, created_at: new Date().toISOString() };
}

function block(label: string, lines: number, width: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const prefix = `${label}:${String(i).padStart(4, "0")}`;
    out.push(`${prefix} ${"x".repeat(Math.max(0, width - prefix.length - 1))}`);
  }
  return out.join("\n");
}

function repeatedJson(count: number): string {
  const rows: string[] = [];
  for (let i = 0; i < count; i++) {
    rows.push(JSON.stringify({
      file: `src/module-${i % 17}/component-${i % 9}.ts`,
      line: i + 1,
      message: `matched context-mode symbol ${i % 23}`,
      snippet: "const value = computeLargeIntermediateState(payload, options);",
    }));
  }
  return rows.join("\n");
}

function makeScenarios(): Scenario[] {
  return [
    {
      name: "codex-pr-review-session",
      description: "PR review with grep output, decisions, active files, and follow-up tasks.",
      events: [
        event("current_goal", "memory-governor", "Build experimental ctx_curate and ctx_recall APIs for Compactless Sessions", 5),
        event("intent", "intent", "implement experimental local benchmark", 4),
        event("cwd", "cwd", "C:/Users/marcu/context-mode-codex-slim-preserve", 4),
        event("file_edit", "file", "src/server.ts", 4),
        event("file_edit", "file", "src/session/memory-governor.ts", 4),
        event("file_edit", "file", "tests/session/session-snapshot.test.ts", 3),
        event("decision", "decision", "Keep the feature framed as experimental and do not open a PR yet.", 5),
        event("task_create", "task", JSON.stringify({ subject: "Add benchmark proving capsule savings" }), 4),
        event("task_update", "task", JSON.stringify({ taskId: "1", status: "in_progress" }), 4),
        event("grep_output", "tool-output", repeatedJson(1200), 1),
        event("test_output", "tool-output", block("vitest", 900, 120), 1),
      ],
    },
    {
      name: "test-failure-loop",
      description: "Repeated failing test logs where only the newest error and file set matter.",
      events: [
        event("current_goal", "memory-governor", "Fix failing Codex SessionStart compact restore test", 5),
        event("file_edit", "file", "hooks/codex/sessionstart.mjs", 4),
        event("file_edit", "file", "tests/adapters/codex.test.ts", 4),
        event("error", "error", "Expected additionalContext to include compact resume snapshot before markResumeConsumed", 5),
        event("decision", "decision", "Mark resume consumed only after appending snapshot to additionalContext.", 5),
        event("test_output", "tool-output", block("failed-run-a", 1800, 140), 1),
        event("test_output", "tool-output", block("failed-run-b", 1800, 140), 1),
        event("test_output", "tool-output", block("passing-run", 1000, 120), 1),
      ],
    },
    {
      name: "long-agent-handoff",
      description: "Long coding session with build logs, search dumps, and a compact handoff state.",
      events: [
        event("current_goal", "memory-governor", "Prototype Continuous Memory Governor for Codex", 5),
        event("intent", "intent", "reduce auto-compaction damage through continuous curation", 5),
        event("cwd", "cwd", "C:/Users/marcu/context-mode-codex-slim-preserve", 4),
        event("file_edit", "file", "hooks/codex/stop.mjs", 4),
        event("file_edit", "file", "hooks/codex/sessionstart.mjs", 4),
        event("file_edit", "file", "src/server.ts", 4),
        event("decision", "decision", "Use Stop-hook curation instead of claiming transcript mutation.", 5),
        event("decision", "decision", "SessionStart injects the latest capsule only when no PreCompact resume snapshot exists.", 5),
        event("task_create", "task", JSON.stringify({ subject: "Benchmark raw transcript versus curated capsule" }), 4),
        event("task_create", "task", JSON.stringify({ subject: "Keep benchmark isolated from live MCP transport" }), 4),
        event("build_output", "tool-output", block("tsc", 2200, 150), 1),
        event("search_dump", "tool-output", repeatedJson(2600), 1),
        event("review_bundle", "tool-output", block("review", 1600, 130), 1),
      ],
    },
  ];
}

function percentile(values: number[], pct: number): number {
  const idx = Math.min(values.length - 1, Math.floor(values.length * pct));
  return values[idx] ?? 0;
}

function measureBuild(events: MemoryGovernorEvent[]): { capsule: string; avgMs: number; p95Ms: number } {
  const times: number[] = [];
  let capsule = "";
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    capsule = buildContinuousMemoryCapsule(events, {
      source: "benchmark",
      searchTool: "ctx_search",
      maxBytes: CAPSULE_BUDGET_BYTES,
    });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    capsule,
    avgMs: times.reduce((sum, value) => sum + value, 0) / times.length,
    p95Ms: percentile(times, 0.95),
  };
}

function persistRoundTrip(name: string, events: MemoryGovernorEvent[], capsule: string): boolean {
  const root = mkdtempSync(join(tmpdir(), "memory-governor-bench-"));
  const dbPath = join(root, "session.db");
  const sessionId = `bench-${name}`;
  const projectDir = join(root, "project");
  const db = new SessionDB({ dbPath });
  try {
    db.ensureSession(sessionId, projectDir);
    for (const ev of events) {
      db.insertEvent(sessionId, ev, "benchmark", { projectDir, source: "test", confidence: 1 });
    }
    db.insertEvent(
      sessionId,
      { type: "working_state_capsule", category: "memory-governor", data: capsule, priority: 5 },
      "benchmark",
      { projectDir, source: "test", confidence: 1 },
    );
    return getLatestContinuousMemoryCapsule(db.getEvents(sessionId, { limit: 5000 })) === capsule;
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function seedScenarioDb(root: string, scenario: Scenario): { projectDir: string; sessionId: string; rawBytes: number } {
  const projectDir = join(root, "project");
  const sessionsDir = join(root, "codex-home", "context-mode", "sessions");
  const dbPath = resolveSessionDbPath({ projectDir, sessionsDir });
  const sessionId = `bench-${scenario.name}`;
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  const db = new SessionDB({ dbPath });
  try {
    db.ensureSession(sessionId, projectDir);
    for (const ev of scenario.events) {
      db.insertEvent(sessionId, ev, "benchmark", { projectDir, source: "test", confidence: 1 });
    }
  } finally {
    db.close();
  }
  return {
    projectDir,
    sessionId,
    rawBytes: scenario.events.reduce((sum, ev) => sum + bytes(ev.data), 0),
  };
}

function textBytes(result: { content?: Array<{ text?: string }> }): number {
  return bytes((result.content ?? []).map((part) => part.text ?? "").join("\n"));
}

function textResult(result: { content?: Array<{ text?: string }> }): string {
  return (result.content ?? []).map((part) => part.text ?? "").join("\n");
}

async function runMcpScenario(scenario: Scenario): Promise<McpBenchResult> {
  const root = mkdtempSync(join(tmpdir(), "memory-governor-mcp-bench-"));
  const codexHome = join(root, "codex-home");
  const serverScript = existsSync(join(REPO_ROOT, "server.bundle.mjs"))
    ? join(REPO_ROOT, "server.bundle.mjs")
    : join(REPO_ROOT, "build", "server.js");
  const seeded = seedScenarioDb(root, scenario);
  const client = new MCPStdioClient(serverScript, {
    ...process.env,
    CODEX_HOME: codexHome,
    CONTEXT_MODE_PLATFORM: "codex",
    CONTEXT_MODE_MEMORY_GOVERNOR: "1",
    CONTEXT_MODE_PROJECT_DIR: seeded.projectDir,
    CONTEXT_MODE_SESSION_ID: seeded.sessionId,
    CONTEXT_MODE_SESSION_SUFFIX: "",
  });

  try {
    client.start();
    await client.initialize();
    const tools = await client.listTools();

    const curateStart = performance.now();
    const curate = await client.callTool("ctx_curate", {
      budgetTokens: CAPSULE_BUDGET_TOKENS,
    });
    const curateMs = performance.now() - curateStart;
    const curateText = textResult(curate);
    const expectedCount = scenario.events.length;
    if (!curateText.includes(`events scanned: ${expectedCount}`)) {
      throw new Error(`ctx_curate scanned the wrong event count for ${scenario.name}; expected ${expectedCount}. Output:\n${curateText}`);
    }
    const expectedMarker = scenario.events.find((ev) => ev.category === "decision" || ev.category === "file")?.data;
    if (expectedMarker && !curateText.includes(String(expectedMarker).slice(0, 80))) {
      throw new Error(`ctx_curate output did not include seeded scenario marker for ${scenario.name}: ${expectedMarker}`);
    }

    const recallStart = performance.now();
    const recall = await client.callTool("ctx_recall", {
      id: "latest",
      maxBytes: CAPSULE_BUDGET_BYTES,
    });
    const recallMs = performance.now() - recallStart;
    const recallText = textResult(recall);
    if (expectedMarker && !recallText.includes(String(expectedMarker).slice(0, 80))) {
      throw new Error(`ctx_recall output did not include seeded scenario marker for ${scenario.name}: ${expectedMarker}`);
    }

    const returned = bytes(curateText) + bytes(recallText);
    return {
      scenario: scenario.name,
      tools: tools.length,
      curateMs: +curateMs.toFixed(2),
      recallMs: +recallMs.toFixed(2),
      curateBytes: textBytes(curate),
      recallBytes: textBytes(recall),
      rawBytes: seeded.rawBytes,
      returnedSavedPercent: +(100 * (1 - returned / seeded.rawBytes)).toFixed(2),
    };
  } finally {
    client.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}

function recallSummaryBytes(events: MemoryGovernorEvent[]): number {
  const largest = [...events].sort((a, b) => bytes(b.data) - bytes(a.data))[0];
  if (!largest) return 0;
  const text = String(largest.data ?? "").replace(/\s+/g, " ").trim();
  return bytes(text.length <= 500 ? text : `${text.slice(0, 497)}...`);
}

function runScenario(scenario: Scenario): BenchResult {
  const rawBytes = scenario.events.reduce((sum, ev) => sum + bytes(ev.data), 0);
  const largestEventBytes = Math.max(...scenario.events.map((ev) => bytes(ev.data)));
  const measured = measureBuild(scenario.events);
  const capsuleBytes = bytes(measured.capsule);
  const persisted = persistRoundTrip(scenario.name, scenario.events, measured.capsule);
  return {
    name: scenario.name,
    events: scenario.events.length,
    rawBytes,
    capsuleBytes,
    rawTokens: approxTokens(rawBytes),
    capsuleTokens: approxTokens(capsuleBytes),
    savedPercent: +(100 * (1 - capsuleBytes / rawBytes)).toFixed(2),
    compressionRatio: +(rawBytes / capsuleBytes).toFixed(1),
    largestEventBytes,
    recallSummaryBytes: recallSummaryBytes(scenario.events),
    avgBuildMs: +measured.avgMs.toFixed(3),
    p95BuildMs: +measured.p95Ms.toFixed(3),
    persisted,
  };
}

function printTable(results: BenchResult[]): void {
  console.log("\n| Scenario | Events | Raw KB | Capsule B | Saved | Ratio | Raw tok | Capsule tok | Avg ms | P95 ms | Persist |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const r of results) {
    console.log(
      `| ${r.name} | ${r.events} | ${(r.rawBytes / 1024).toFixed(1)} | ${r.capsuleBytes} | ${r.savedPercent.toFixed(2)}% | ${r.compressionRatio}x | ${r.rawTokens} | ${r.capsuleTokens} | ${r.avgBuildMs} | ${r.p95BuildMs} | ${r.persisted ? "yes" : "no"} |`,
    );
  }
}

function printRecallTable(results: BenchResult[]): void {
  console.log("\n| Scenario | Largest raw event KB | Recall summary B | Recall saved |");
  console.log("|---|---:|---:|---:|");
  for (const r of results) {
    const saved = 100 * (1 - r.recallSummaryBytes / r.largestEventBytes);
    console.log(
      `| ${r.name} | ${(r.largestEventBytes / 1024).toFixed(1)} | ${r.recallSummaryBytes} | ${saved.toFixed(2)}% |`,
    );
  }
}

function printMcpTable(results: McpBenchResult[]): void {
  console.log("\nIsolated MCP subprocess benchmark");
  console.log("| Scenario | Tools | Raw KB | ctx_curate B | ctx_recall B | Returned saved | Curate ms | Recall ms |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of results) {
    console.log(
      `| ${r.scenario} | ${r.tools} | ${(r.rawBytes / 1024).toFixed(1)} | ${r.curateBytes} | ${r.recallBytes} | ${r.returnedSavedPercent.toFixed(2)}% | ${r.curateMs} | ${r.recallMs} |`,
    );
  }
}

async function main(): Promise<void> {
  console.log("Continuous Memory Governor benchmark");
  console.log("====================================");
  console.log(`iterations: ${ITERATIONS}`);
  console.log(`capsule budget: ${CAPSULE_BUDGET_TOKENS} tokens (~${CAPSULE_BUDGET_BYTES} bytes)`);
  console.log(`scope: isolated synthetic SessionDB + pure capsule builder${RUN_MCP ? " + isolated MCP subprocess" : "; no live MCP server calls"}`);

  const scenarios = makeScenarios();
  const results = scenarios.map(runScenario);
  printTable(results);
  printRecallTable(results);

  const totals = results.reduce(
    (acc, r) => {
      acc.rawBytes += r.rawBytes;
      acc.capsuleBytes += r.capsuleBytes;
      return acc;
    },
    { rawBytes: 0, capsuleBytes: 0 },
  );
  const totalSaved = 100 * (1 - totals.capsuleBytes / totals.rawBytes);
  console.log("\nSummary:");
  console.log(`raw total: ${(totals.rawBytes / 1024).toFixed(1)} KB (~${approxTokens(totals.rawBytes)} tokens)`);
  console.log(`capsule total: ${(totals.capsuleBytes / 1024).toFixed(1)} KB (~${approxTokens(totals.capsuleBytes)} tokens)`);
  console.log(`saved: ${totalSaved.toFixed(2)}% (${(totals.rawBytes / totals.capsuleBytes).toFixed(1)}x smaller)`);

  if (RUN_MCP) {
    const mcpResults: McpBenchResult[] = [];
    for (const scenario of scenarios) {
      mcpResults.push(await runMcpScenario(scenario));
    }
    printMcpTable(mcpResults);
  } else {
    console.log("\nTip: run `npm run benchmark:memory-governor -- --mcp` for isolated MCP subprocess timings.");
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
