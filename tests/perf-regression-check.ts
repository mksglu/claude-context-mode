/**
 * Perf regression check — compare current bench numbers vs tests/perf-baseline.json.
 *
 * Modes:
 *   --check       run benches, compare against baseline for current platform,
 *                 print delta table, exit 0 (always; CI gate is reporting-only)
 *   --update      run benches, overwrite baseline entry for current platform
 *   --self-test   exercise threshold + extract logic against synthetic data
 *   --json        emit machine-readable summary on stdout (combine with --check)
 *
 * Platform key: `${process.platform}-${process.arch}` (e.g. darwin-arm64).
 *
 * Threshold rule:
 *   regression iff   delta > max(baseline * relPct, absFloor[unit])
 * where absFloor.ms = 50, absFloor.us = 5, relPct = 0.05.
 *
 * Metrics not present in baseline for the current platform are reported as
 * NEW and never trigger regression — first --update on that platform seeds
 * them. This is intentional: the matrix surfaces linux/windows numbers
 * before owner commits to a budget.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BASELINE_PATH = resolve(__dirname, "perf-baseline.json");

type Unit = "ms" | "us";
interface MetricValue { value: number; unit: Unit }
interface PlatformBaseline {
  node?: string;
  notes?: string;
  metrics: Record<string, MetricValue>;
}
interface Baseline {
  schemaVersion: string;
  lastUpdated: string;
  thresholds: { relPct: number; absFloorMs: number; absFloorUs: number };
  platforms: Record<string, PlatformBaseline>;
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function validateBaseline(b: unknown): asserts b is Baseline {
  if (!b || typeof b !== "object") throw new Error("baseline: not an object");
  const x = b as Record<string, unknown>;
  if (x.schemaVersion !== "ctx-perf-baseline/v1") {
    throw new Error(`baseline: unsupported schemaVersion ${String(x.schemaVersion)} (expected ctx-perf-baseline/v1)`);
  }
  const t = x.thresholds as Record<string, unknown> | undefined;
  if (!t || typeof t !== "object") throw new Error("baseline: thresholds missing or not object");
  for (const k of ["relPct", "absFloorMs", "absFloorUs"] as const) {
    const v = t[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(`baseline: thresholds.${k} must be a positive finite number, got ${String(v)}`);
    }
  }
  if (!x.platforms || typeof x.platforms !== "object") throw new Error("baseline: platforms missing or not object");
}

function loadBaseline(): Baseline {
  const raw: unknown = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  validateBaseline(raw);
  return raw;
}

const BENCH_TIMEOUT_MS = 600_000; // 10 min ceiling — cold-start can run ~5min on Windows.

function runJsonBench(relPath: string, env: Record<string, string> = {}): Record<string, unknown> {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(REPO_ROOT, relPath), "--json"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      timeout: BENCH_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  if (r.signal === "SIGKILL") {
    throw new Error(`${relPath} timed out (>${BENCH_TIMEOUT_MS / 1000}s)\n${r.stderr ?? ""}`);
  }
  if (r.status !== 0) {
    throw new Error(`${relPath} failed (exit ${r.status}):\n${r.stderr}`);
  }
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

function extractMetrics(
  coldStart: Record<string, unknown>,
  executor: Record<string, unknown>,
): Record<string, MetricValue> {
  const out: Record<string, MetricValue> = {};

  if (typeof coldStart.p95Ms === "number") {
    out["coldStart.p95Ms"] = { value: coldStart.p95Ms, unit: "ms" };
  }

  const benches = executor.benchmarks as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(benches)) {
    for (const b of benches) {
      if (b.language !== "javascript") continue; // cross-platform stable subset
      const key = `executor.${b.name}/javascript.p95Ms`;
      if (typeof b.p95Ms === "number") {
        out[key] = { value: b.p95Ms, unit: "ms" };
      }
    }
  }

  const search = executor.search as Record<string, number> | undefined;
  if (search && typeof search.fuzzyWarmUs === "number") {
    out["search.fuzzyWarmUs"] = { value: search.fuzzyWarmUs, unit: "us" };
  }
  if (search && typeof search.dedupDedupedUs === "number") {
    out["search.dedupDedupedUs"] = { value: search.dedupDedupedUs, unit: "us" };
  }

  return out;
}

function regressionThreshold(baselineValue: number, unit: Unit, t: Baseline["thresholds"]): number {
  const floor = unit === "ms" ? t.absFloorMs : t.absFloorUs;
  return Math.max(baselineValue * t.relPct, floor);
}

interface DeltaRow {
  metric: string;
  unit: Unit;
  baseline: number | null;
  current: number;
  deltaAbs: number | null;
  deltaPct: number | null;
  status: "ok" | "regression" | "improved" | "new";
}

function check(
  baseline: Baseline,
  platform: string,
  current: Record<string, MetricValue>,
): { rows: DeltaRow[]; regressions: DeltaRow[] } {
  const platformBaseline = baseline.platforms[platform];
  const rows: DeltaRow[] = [];

  for (const [metric, cur] of Object.entries(current)) {
    const base = platformBaseline?.metrics[metric];
    if (!base) {
      rows.push({
        metric, unit: cur.unit, baseline: null, current: cur.value,
        deltaAbs: null, deltaPct: null, status: "new",
      });
      continue;
    }
    const deltaAbs = cur.value - base.value;
    const deltaPct = (deltaAbs / base.value) * 100;
    const threshold = regressionThreshold(base.value, base.unit, baseline.thresholds);
    let status: DeltaRow["status"] = "ok";
    if (deltaAbs > threshold) status = "regression";
    else if (deltaAbs < -threshold) status = "improved";
    rows.push({
      metric, unit: cur.unit, baseline: base.value, current: cur.value,
      deltaAbs, deltaPct, status,
    });
  }

  rows.sort((a, b) => a.metric.localeCompare(b.metric));
  return { rows, regressions: rows.filter((r) => r.status === "regression") };
}

function fmt(n: number, unit: Unit): string {
  return unit === "ms" ? `${n.toFixed(1)}ms` : `${n.toFixed(2)}µs`;
}

const STATUS_ICON: Record<DeltaRow["status"], string> = {
  ok: "OK  ",
  regression: "FAIL",
  improved: "FAST",
  new: "NEW ",
};

function printTable(rows: DeltaRow[]): void {
  console.log("");
  console.log(
    "| Status | Metric                                          | Baseline      | Current       | Δ (abs)       | Δ (%)    |",
  );
  console.log(
    "|--------|-------------------------------------------------|---------------|---------------|---------------|----------|",
  );
  for (const r of rows) {
    const icon = STATUS_ICON[r.status];
    const baseline = r.baseline === null ? "—" : fmt(r.baseline, r.unit);
    const current = fmt(r.current, r.unit);
    const dAbs = r.deltaAbs === null ? "—" : (r.deltaAbs >= 0 ? "+" : "") + fmt(r.deltaAbs, r.unit);
    const dPct = r.deltaPct === null ? "—" : (r.deltaPct >= 0 ? "+" : "") + r.deltaPct.toFixed(1) + "%";
    console.log(
      `| ${icon}   | ${r.metric.padEnd(47)} | ${baseline.padStart(13)} | ${current.padStart(13)} | ${dAbs.padStart(13)} | ${dPct.padStart(8)} |`,
    );
  }
}

function update(baseline: Baseline, platform: string, current: Record<string, MetricValue>): Baseline {
  const next: Baseline = structuredClone(baseline);
  next.lastUpdated = new Date().toISOString().slice(0, 10);
  next.platforms[platform] = {
    ...(next.platforms[platform] ?? {}),
    node: process.version,
    metrics: current,
  };
  return next;
}

function selfTest(): void {
  const errors: string[] = [];
  const t = { relPct: 0.05, absFloorMs: 50, absFloorUs: 5 };

  // Threshold floor: 5% of 100ms = 5ms; floor=50ms wins.
  const thresh100ms = regressionThreshold(100, "ms", t);
  if (thresh100ms !== 50) errors.push(`thresh(100ms) expected 50, got ${thresh100ms}`);

  // Threshold relative: 5% of 2000ms = 100ms; relative wins.
  const thresh2000ms = regressionThreshold(2000, "ms", t);
  if (thresh2000ms !== 100) errors.push(`thresh(2000ms) expected 100, got ${thresh2000ms}`);

  // Threshold µs floor: 5% of 50µs = 2.5µs; floor=5µs wins.
  const thresh50us = regressionThreshold(50, "us", t);
  if (thresh50us !== 5) errors.push(`thresh(50us) expected 5, got ${thresh50us}`);

  // check() classifies regression vs improved vs ok vs new.
  const baseline: Baseline = {
    schemaVersion: "test", lastUpdated: "2026-01-01", thresholds: t,
    platforms: { "test-arch": { metrics: {
      "metric.fast": { value: 100, unit: "ms" },
      "metric.slow": { value: 2000, unit: "ms" },
      "metric.us":   { value: 50, unit: "us" },
    } } },
  };
  const current: Record<string, MetricValue> = {
    "metric.fast": { value: 160, unit: "ms" },  // +60ms > 50ms floor → regression
    "metric.slow": { value: 2050, unit: "ms" }, // +50ms = 5% of 1000, but 5%×2000=100ms threshold → ok
    "metric.us":   { value: 44, unit: "us" },   // -6µs > 5µs floor → improved
    "metric.new":  { value: 10, unit: "ms" },   // not in baseline → new
  };
  const result = check(baseline, "test-arch", current);
  const byMetric = Object.fromEntries(result.rows.map((r) => [r.metric, r.status]));
  if (byMetric["metric.fast"] !== "regression") errors.push(`metric.fast expected regression, got ${byMetric["metric.fast"]}`);
  if (byMetric["metric.slow"] !== "ok") errors.push(`metric.slow expected ok, got ${byMetric["metric.slow"]}`);
  if (byMetric["metric.us"] !== "improved") errors.push(`metric.us expected improved, got ${byMetric["metric.us"]}`);
  if (byMetric["metric.new"] !== "new") errors.push(`metric.new expected new, got ${byMetric["metric.new"]}`);
  if (result.regressions.length !== 1) errors.push(`expected 1 regression, got ${result.regressions.length}`);

  // extractMetrics handles missing fields gracefully
  const empty = extractMetrics({}, {});
  if (Object.keys(empty).length !== 0) errors.push(`extractMetrics({},{}) should be empty`);

  // extractMetrics filters non-javascript benches
  const ext = extractMetrics(
    { p95Ms: 300 },
    {
      benchmarks: [
        { name: "hello-world", language: "javascript", p95Ms: 50 },
        { name: "hello-world", language: "python", p95Ms: 80 },
      ],
      search: { fuzzyWarmUs: 1.5, dedupDedupedUs: 30 },
    },
  );
  if (!("executor.hello-world/javascript.p95Ms" in ext))
    errors.push("javascript bench missing from extracted metrics");
  if ("executor.hello-world/python.p95Ms" in ext)
    errors.push("python bench should not be in extracted metrics");
  if (ext["coldStart.p95Ms"]?.value !== 300) errors.push("coldStart.p95Ms not extracted");
  if (ext["search.fuzzyWarmUs"]?.value !== 1.5) errors.push("search.fuzzyWarmUs not extracted");

  if (errors.length > 0) {
    console.error("self-test FAILED:");
    for (const e of errors) console.error("  -", e);
    process.exit(1);
  }
  console.log("self-test PASSED (13 assertions)");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");

  if (args.includes("--self-test")) {
    selfTest();
    return;
  }

  const wantCheck = args.includes("--check");
  const wantUpdate = args.includes("--update");
  if (!wantCheck && !wantUpdate) {
    console.error("usage: perf-regression-check.ts [--check | --update | --self-test] [--json]");
    process.exit(2);
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error(`baseline file missing: ${BASELINE_PATH}`);
    process.exit(2);
  }

  const baseline = loadBaseline();
  const platform = platformKey();

  console.error(`[perf-check] platform=${platform} node=${process.version}`);
  console.error("[perf-check] running cold-start bench...");
  const coldStart = runJsonBench("tests/cold-start-benchmark.ts", {
    ITERATIONS: process.env.PERF_COLDSTART_ITER ?? "10",
    WARMUP: process.env.PERF_COLDSTART_WARMUP ?? "1",
  });
  console.error("[perf-check] running executor bench...");
  const executor = runJsonBench("tests/benchmark.ts");

  const current = extractMetrics(coldStart, executor);

  if (wantUpdate) {
    const next = update(baseline, platform, current);
    const tmp = BASELINE_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, BASELINE_PATH);
    console.error(`[perf-check] baseline updated for ${platform} (${Object.keys(current).length} metrics)`);
    return;
  }

  const { rows, regressions } = check(baseline, platform, current);
  if (jsonMode) {
    process.stdout.write(JSON.stringify({
      schema: "ctx-perf-check/v1",
      platform, node: process.version,
      baselinePresent: platform in baseline.platforms,
      regressionCount: regressions.length,
      newCount: rows.filter((r) => r.status === "new").length,
      rows,
    }, null, 2) + "\n");
  } else {
    if (!(platform in baseline.platforms)) {
      console.log(`[perf-check] no baseline yet for ${platform} — all metrics will show NEW`);
    }
    printTable(rows);
    console.log("");
    if (regressions.length > 0) {
      console.log(`${regressions.length} regression(s) detected (informational; CI does not fail).`);
    } else {
      console.log("No regressions vs baseline.");
    }
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify({
      schema: "ctx-perf-check/v1",
      ok: false,
      errorKind: "unknown",
      message,
    }, null, 2) + "\n");
  } else {
    console.error("perf-regression-check error:", err);
  }
  process.exit(1);
});
