import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface RpcResponse {
  id?: number;
  result?: { content?: Array<{ type: string; text: string }> };
  error?: { message: string };
}

interface Sample {
  label: string;
  median_ms: number;
  p95_ms: number;
  runs: number;
  threshold_ms: number;
  status: "pass" | "fail";
  baseline_median_ms?: number;
  ratio_vs_baseline?: number;
}

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const serverPath = join(repoRoot, "build", "server.js");
const hookPath = join(repoRoot, "hooks", "sessionstart.mjs");
const runs = Number(process.env.CONTEXT_MODE_PERF_RUNS ?? 3);
const assertThresholds = process.argv.includes("--assert");
const baselineArg = process.argv.find((arg) => arg.startsWith("--baseline="));
const baselinePath = baselineArg?.slice("--baseline=".length);

const thresholds: Record<string, number> = {
  fresh_mcp_startup: 5_000,
  tiny_ctx_execute: 10_000,
  large_ctx_execute_auto_index: 20_000,
  ctx_batch_execute_medium: 25_000,
  multi_query_ctx_search: 10_000,
  hook_startup: 3_000,
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length - 1] ?? 0;
}

function msSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function send(proc: ChildProcessWithoutNullStreams, payload: Record<string, unknown>): void {
  proc.stdin.write(`${JSON.stringify(payload)}\n`);
}

function waitFor(proc: ChildProcessWithoutNullStreams, id: number, timeoutMs = 20_000): Promise<RpcResponse> {
  return new Promise((resolveResponse, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      proc.stdout.off("data", onData);
      reject(new Error(`timeout waiting for rpc id ${id}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as RpcResponse;
          if (parsed.id === id) {
            clearTimeout(timer);
            proc.stdout.off("data", onData);
            resolveResponse(parsed);
            return;
          }
        } catch {
          // Ignore non-JSON process noise.
        }
      }
    };
    proc.stdout.on("data", onData);
  });
}

async function withServer<T>(fn: (proc: ChildProcessWithoutNullStreams) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "ctx-perf-"));
  const projectDir = join(root, "project");
  const proc = spawn("node", [serverPath], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CONTEXT_MODE_DISABLE_VERSION_CHECK: "1",
      CONTEXT_MODE_PROJECT_DIR: projectDir,
      CLAUDE_CONFIG_DIR: join(root, ".claude"),
      NO_COLOR: "1",
    },
  });
  try {
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "perf-smoke", version: "1.0" },
      },
    });
    const init = await waitFor(proc, 1);
    if (init.error) throw new Error(init.error.message);
    send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
    return await fn(proc);
  } finally {
    await stopServer(proc);
    rmSync(root, { recursive: true, force: true });
  }
}

async function stopServer(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.killed) return;
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* best effort */ }
      resolveStop();
    }, 2_000);
    proc.once("close", () => {
      clearTimeout(timer);
      resolveStop();
    });
    try { proc.kill("SIGTERM"); } catch { resolveStop(); }
  });
}

let nextId = 10;
async function callTool(proc: ChildProcessWithoutNullStreams, name: string, args: Record<string, unknown>): Promise<string> {
  const id = nextId++;
  send(proc, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const response = await waitFor(proc, id);
  if (response.error) throw new Error(response.error.message);
  return response.result?.content?.[0]?.text ?? "";
}

async function measure(label: string, fn: () => Promise<void> | void): Promise<Sample> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    await fn();
    times.push(msSince(start));
  }
  const threshold = thresholds[label] ?? 30_000;
  const sample: Sample = {
    label,
    median_ms: Math.round(median(times)),
    p95_ms: Math.round(p95(times)),
    runs,
    threshold_ms: threshold,
    status: p95(times) <= threshold ? "pass" : "fail",
  };
  return sample;
}

function loadBaseline(): Record<string, number> {
  if (!baselinePath) return {};
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, "utf8")) as { samples?: Array<{ label: string; median_ms: number }> };
    return Object.fromEntries((parsed.samples ?? []).map((s) => [s.label, s.median_ms]));
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const baseline = loadBaseline();
  const samples: Sample[] = [];

  samples.push(await measure("fresh_mcp_startup", async () => {
    await withServer(async () => undefined);
  }));

  samples.push(await measure("tiny_ctx_execute", async () => {
    await withServer(async (proc) => {
      await callTool(proc, "ctx_execute", { language: "javascript", code: "console.log('ok')" });
    });
  }));

  samples.push(await measure("large_ctx_execute_auto_index", async () => {
    await withServer(async (proc) => {
      const code = "process.stdout.write('alpha beta gamma\\n'.repeat(9000))";
      const text = await callTool(proc, "ctx_execute", { language: "javascript", code });
      if (!text.includes("ctx_search")) throw new Error("large stdout did not return search guidance");
    });
  }));

  samples.push(await measure("ctx_batch_execute_medium", async () => {
    await withServer(async (proc) => {
      const command = "node -e \"process.stdout.write('needle sqlite busy write queue\\\\n'.repeat(3500))\"";
      const text = await callTool(proc, "ctx_batch_execute", {
        commands: [{ label: "medium", command }],
        queries: ["sqlite busy", "write queue"],
      });
      if (!text.includes("Indexed Sections")) throw new Error("batch output missing inventory");
    });
  }));

  samples.push(await measure("multi_query_ctx_search", async () => {
    await withServer(async (proc) => {
      await callTool(proc, "ctx_index", {
        content: "# Alpha\nneedleOne term\n\n# Beta\nneedleTwo term\n\n# Gamma\nneedleThree term",
        source: "perf-search",
      });
      const text = await callTool(proc, "ctx_search", {
        queries: ["needleOne", "needleTwo", "needleThree"],
        source: "perf-search",
      });
      if (!text.includes("needleOne")) throw new Error("search result missing indexed content");
    });
  }));

  samples.push(await measure("hook_startup", () => {
    const input = JSON.stringify({ session_id: "perf", transcript_path: join(tmpdir(), "ctx-noop.jsonl") });
    const result = spawnSync("node", [hookPath], {
      cwd: repoRoot,
      input,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    if (result.status !== 0) throw new Error(result.stderr || `hook exit ${result.status}`);
  }));

  for (const sample of samples) {
    const base = baseline[sample.label];
    if (typeof base === "number" && base > 0) {
      sample.baseline_median_ms = base;
      sample.ratio_vs_baseline = Math.round((sample.median_ms / base) * 100) / 100;
    }
  }

  const summary = {
    created_at: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    runs,
    thresholds_coarse: true,
    samples,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (assertThresholds && samples.some((s) => s.status === "fail")) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
