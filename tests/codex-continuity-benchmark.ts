import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex/index.js";
import { resolveSessionDbPath, SessionDB } from "../src/session/db.js";

type BenchEvent = {
  type: string;
  category: string;
  data: string;
  priority: number;
};

const repoRoot = process.cwd();
const codexHome = mkdtempSync(join(tmpdir(), "ctx-codex-continuity-bench-"));
const sessionId = `bench-${Date.now()}`;
const noiseCount = Number(process.env.NOISE_EVENTS ?? 260);
const noiseLines = Number(process.env.NOISE_LINES ?? 24);
const keepBenchHome = process.env.KEEP_CODEX_BENCH_HOME === "1";
const mode = process.env.BENCH_MODE ?? "single";
process.env.CODEX_HOME = codexHome;
process.env.CONTEXT_MODE_SESSION_SUFFIX = "bench";
const env = {
  ...process.env,
  CODEX_HOME: codexHome,
  CONTEXT_MODE_SESSION_SUFFIX: "bench",
};

const criticalFacts = [
  "ctx_doctor",
  "resolve(pluginRoot, scriptPath)",
  "src/server.ts",
  "tests/core/server.test.ts",
  "PreCompact runtime-gated warning",
  "Windows EBUSY temp-dir cleanup is unrelated",
];

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function approxTokens(byteCount: number): number {
  return Math.ceil(byteCount / 4);
}

function runHook(event: string, payload: Record<string, unknown>): { stdout: string; ms: number } {
  const start = performance.now();
  const result = spawnSync(
    process.execPath,
    ["cli.bundle.mjs", "hook", "codex", event],
    {
      cwd: repoRoot,
      env,
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  const ms = performance.now() - start;
  if (result.status !== 0) {
    throw new Error(`${event} failed: ${result.stderr || result.stdout}`);
  }
  return { stdout: result.stdout, ms };
}

function makeNoise(i: number): string {
  const line = `noise-${i}: dependency install log, repeated grep output, stale branch note, old failing attempt`;
  return Array.from({ length: noiseLines }, (_, n) => `${line} chunk-${n}`).join("\n");
}

function seedEvents(db: SessionDB, events: BenchEvent[]): void {
  for (const event of events) {
    db.insertEvent(sessionId, event, "Benchmark", {
      projectDir: repoRoot,
      source: "benchmark",
      confidence: 1,
    });
  }
}

const usefulEvents: BenchEvent[] = [
  {
    type: "intent",
    category: "intent",
    data: "implement",
    priority: 1,
  },
  {
    type: "decision",
    category: "decision",
    data: "Fix ctx_doctor by resolving relative hook script paths with resolve(pluginRoot, scriptPath).",
    priority: 1,
  },
  {
    type: "decision",
    category: "decision",
    data: "Keep Codex PreCompact runtime-gated warning, not a hard validation failure.",
    priority: 1,
  },
  {
    type: "error_tool",
    category: "error",
    data: "Windows EBUSY temp-dir cleanup is unrelated to Codex hook continuity.",
    priority: 1,
  },
  {
    type: "task_create",
    category: "task",
    data: JSON.stringify({ subject: "Patch src/server.ts ctx_doctor hook path resolution" }),
    priority: 1,
  },
  {
    type: "task_create",
    category: "task",
    data: JSON.stringify({ subject: "Add tests/core/server.test.ts regression for hook script paths" }),
    priority: 1,
  },
  {
    type: "file_edit",
    category: "file",
    data: "src/server.ts",
    priority: 1,
  },
  {
    type: "file_edit",
    category: "file",
    data: "tests/core/server.test.ts",
    priority: 1,
  },
  {
    type: "rule",
    category: "rule",
    data: "Do not touch real CODEX_HOME during local hook smoke tests.",
    priority: 1,
  },
  {
    type: "cwd",
    category: "cwd",
    data: repoRoot,
    priority: 1,
  },
];

function runBenchmark(runNoiseCount: number) {
  const adapter = new CodexAdapter();
  const dbPath = resolveSessionDbPath({
    projectDir: repoRoot,
    sessionsDir: adapter.getSessionDir(),
  });
  const db = new SessionDB({ dbPath });
  const runSessionId = `${sessionId}-${runNoiseCount}`;
  db.ensureSession(runSessionId, repoRoot);

  const noiseEvents: BenchEvent[] = Array.from({ length: runNoiseCount }, (_, i) => ({
    type: "tool_output_noise",
    category: "data",
    data: makeNoise(i),
    priority: 5,
  }));
  const events = [...noiseEvents, ...usefulEvents];
  for (const event of events) {
    db.insertEvent(runSessionId, event, "Benchmark", {
      projectDir: repoRoot,
      source: "benchmark",
      confidence: 1,
    });
  }
  const storedBefore = db.getEvents(runSessionId, { limit: 10_000 });
  const rawEventBytes = storedBefore.reduce((sum, event) => sum + bytes(event.data), 0);
  db.close();

  const precompact = runHook("precompact", {
    session_id: runSessionId,
    cwd: repoRoot,
    hook_event_name: "PreCompact",
  });
  const sessionstart = runHook("sessionstart", {
    session_id: runSessionId,
    cwd: repoRoot,
    hook_event_name: "SessionStart",
    source: "compact",
  });

  const parsed = JSON.parse(sessionstart.stdout);
  const additionalContext = String(parsed.hookSpecificOutput?.additionalContext ?? "");

  const verifyDb = new SessionDB({ dbPath });
  const resume = verifyDb.getResume(runSessionId);
  const stats = verifyDb.getSessionStats(runSessionId);
  const snapshot = resume?.snapshot ?? "";
  verifyDb.close();

  const retainedFacts = criticalFacts.filter(
    (fact) => snapshot.includes(fact) || additionalContext.includes(fact),
  );
  const snapshotBytes = bytes(snapshot);
  const injectedBytes = bytes(additionalContext);
  const rawApproxTokens = approxTokens(rawEventBytes);
  const snapshotApproxTokens = approxTokens(snapshotBytes);
  const injectedApproxTokens = approxTokens(injectedBytes);

  return {
    sessionId: runSessionId,
    codexHome,
    noiseEvents: runNoiseCount,
    noiseLines,
    eventsSeeded: events.length,
    eventsStored: storedBefore.length,
    rawEventBytes,
    rawApproxTokens,
    resumeSnapshotBytes: snapshotBytes,
    resumeApproxTokens: snapshotApproxTokens,
    sessionStartAdditionalContextBytes: injectedBytes,
    sessionStartApproxTokens: injectedApproxTokens,
    rawToSnapshotCompression: +(rawEventBytes / Math.max(1, snapshotBytes)).toFixed(1),
    rawToInjectedContextCompression: +(rawEventBytes / Math.max(1, injectedBytes)).toFixed(1),
    tokensSavedVsRawSnapshot: rawApproxTokens - snapshotApproxTokens,
    tokensSavedVsRawInjected: rawApproxTokens - injectedApproxTokens,
    snapshotHelps: snapshotApproxTokens < rawApproxTokens,
    injectedContextHelps: injectedApproxTokens < rawApproxTokens,
    compactCount: stats?.compact_count ?? null,
    resumeConsumed: resume?.consumed ?? null,
    precompactMs: +precompact.ms.toFixed(1),
    sessionstartMs: +sessionstart.ms.toFixed(1),
    retainedFacts: `${retainedFacts.length}/${criticalFacts.length}`,
    retainedFactRatio: +(retainedFacts.length / criticalFacts.length).toFixed(2),
    missingFacts: criticalFacts.filter((fact) => !retainedFacts.includes(fact)),
  };
}

function printTable(results: ReturnType<typeof runBenchmark>[]): void {
  const rows = results.map((r) => ({
    noise: r.noiseEvents,
    rawTok: r.rawApproxTokens,
    snapshotTok: r.resumeApproxTokens,
    injectedTok: r.sessionStartApproxTokens,
    rawToSnapshot: `${r.rawToSnapshotCompression}x`,
    rawToInjected: `${r.rawToInjectedContextCompression}x`,
    injectedSaved: r.tokensSavedVsRawInjected,
    facts: r.retainedFacts,
    hookMs: `${Math.round(r.precompactMs + r.sessionstartMs)}ms`,
  }));
  console.table(rows);
}

const runs = mode === "sweep" ? [0, 50, 260, 500] : [noiseCount];
const results = runs.map(runBenchmark);

if (mode === "sweep") {
  printTable(results);
}

console.log(JSON.stringify(mode === "sweep" ? { codexHome, results } : results[0], null, 2));

for (const result of results) {
  if (result.retainedFactRatio < 1) process.exitCode = 1;
  if (result.noiseEvents >= 50 && !result.injectedContextHelps) process.exitCode = 1;
}

if (!keepBenchHome) {
  rmSync(codexHome, { recursive: true, force: true });
}
