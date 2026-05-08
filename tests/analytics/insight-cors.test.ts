import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";

const ROOT = resolve(import.meta.dirname, "../..");
const SOURCE_SERVER = resolve(ROOT, "insight", "server.mjs");
const DIST_INDEX_NAME = "index.html";

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill("SIGTERM"); } catch { /* best effort */ }
  }
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function seedFixtureDBs(baseDir: string): { sessionsDir: string; contentDir: string } {
  const sessionsDir = join(baseDir, "sessions");
  const contentDir = join(baseDir, "content");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(contentDir, { recursive: true });

  const sessionDb = new Database(join(sessionsDir, "abcd1234.db"));
  sessionDb.exec(`
    CREATE TABLE session_meta (
      session_id TEXT PRIMARY KEY,
      project_dir TEXT,
      started_at TEXT,
      last_event_at TEXT,
      event_count INTEGER,
      compact_count INTEGER
    );
    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      type TEXT,
      category TEXT,
      priority TEXT,
      data TEXT,
      source_hook TEXT,
      created_at TEXT
    );
    CREATE TABLE session_resume (
      session_id TEXT PRIMARY KEY,
      snapshot TEXT,
      event_count INTEGER,
      consumed INTEGER
    );
  `);
  sessionDb.prepare("INSERT INTO session_meta VALUES (?, ?, ?, ?, ?, ?)").run(
    "sess-1",
    "/secret/project",
    "2026-04-16T00:00:00Z",
    "2026-04-16T00:05:00Z",
    1,
    0,
  );
  sessionDb.prepare("INSERT INTO session_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    1,
    "sess-1",
    "user_prompt",
    "prompt",
    "high",
    "my prod api key is sk-live-local-demo",
    "sessionstart",
    "2026-04-16T00:01:00Z",
  );
  sessionDb.prepare("INSERT INTO session_resume VALUES (?, ?, ?, ?)").run(
    "sess-1",
    "resume snapshot secret",
    1,
    0,
  );
  sessionDb.close();

  const contentDb = new Database(join(contentDir, "feedface.db"));
  contentDb.exec(`
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY,
      label TEXT,
      title TEXT,
      content_type TEXT,
      created_at TEXT
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      source_id INTEGER,
      title TEXT,
      content TEXT,
      content_type TEXT
    );
  `);
  contentDb.prepare("INSERT INTO sources VALUES (?, ?, ?, ?, ?)").run(
    7,
    "payments",
    "payments doc",
    "markdown",
    "2026-04-16T00:00:00Z",
  );
  contentDb.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?, ?)").run(
    1,
    7,
    "payments",
    "secret operational note",
    "markdown",
  );
  contentDb.close();

  return { sessionsDir, contentDir };
}

async function waitForInsight(port: number, child: ChildProcess): Promise<void> {
  // Capture stderr for diagnostics if the server fails to start
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  // Detect early exit so we can fail fast with a useful message
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  child.on("exit", (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });

  // Poll HTTP endpoint with generous CI timeout (120 × 250ms = 30s)
  let lastError: string | undefined;
  for (let i = 0; i < 120; i++) {
    if (exited) {
      throw new Error(`Insight server exited (code=${exitCode}, signal=${exitSignal}) before becoming ready. stderr: ${stderr || "(empty)"}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/overview`);
      if (res.ok) return;
      lastError = `unexpected status ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Insight server did not become ready within 30s: ${lastError ?? "unknown"}. stderr: ${stderr || "(empty)"}`);
}

function startInsight(runtime: "node" | "bun" = "node"): { port: number; child: ChildProcess } {
  const tempRoot = mkdtempSync(join(tmpdir(), "ctx-insight-cors-"));
  tempDirs.push(tempRoot);

  const tempInsightDir = join(tempRoot, "insight");
  mkdirSync(join(tempInsightDir, "dist"), { recursive: true });
  cpSync(SOURCE_SERVER, join(tempInsightDir, "server.mjs"));
  writeFileSync(join(tempInsightDir, "dist", DIST_INDEX_NAME), "<!doctype html><html><body>stub</body></html>");
  symlinkSync(resolve(ROOT, "node_modules"), join(tempRoot, "node_modules"), "dir");

  const { sessionsDir, contentDir } = seedFixtureDBs(tempRoot);
  const port = 49152 + Math.floor(Math.random() * 16383);
  const cmd = runtime === "bun" ? "bun" : "node";
  const child = spawn(cmd, [join(tempInsightDir, "server.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      INSIGHT_SESSION_DIR: sessionsDir,
      INSIGHT_CONTENT_DIR: contentDir,
    },
  });
  children.push(child);
  return { port, child };
}

describe("Insight API same-machine cross-origin policy", () => {
  let port: number;
  let serverChild: ChildProcess;
  let serverTempDir: string | undefined;

  // Hook timeout must accommodate 3 attempts × 30s waitForInsight polling.
  // Vitest's default 10s hookTimeout guarantees failure on slow Windows
  // runners where Node spawn + sqlite open routinely exceeds 10s.
  beforeAll(async () => {
    // better-sqlite3 can SIGSEGV on CI under fork workers — retry spawn up to 3 times
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = startInsight("node");
      const child = started.child;
      // Remove from global cleanup arrays — this describe manages its own lifecycle.
      // afterEach would otherwise kill the server or delete its temp dir between tests.
      const childIdx = children.indexOf(child);
      if (childIdx !== -1) children.splice(childIdx, 1);
      const td = tempDirs.pop(); // startInsight pushes tempRoot last
      try {
        await waitForInsight(started.port, child);
        port = started.port;
        serverChild = child;
        serverTempDir = td;
        return;
      } catch (err) {
        lastErr = err;
        try { child.kill("SIGKILL"); } catch { /* best effort */ }
        if (td) { try { rmSync(td, { recursive: true, force: true }); } catch { /* best effort */ } }
      }
    }
    throw lastErr;
  }, 120_000);

  afterAll(() => {
    try { serverChild?.kill("SIGTERM"); } catch { /* best effort */ }
    if (serverTempDir) {
      try { rmSync(serverTempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  test("does not advertise permissive CORS headers on sensitive session endpoints (Node)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/abcd1234/events/sess-1`, {
      headers: { Origin: "http://127.0.0.1:8081" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
    const body = await res.json();
    expect(body.events[0].data).toContain("sk-live-local-demo");
  });

  test("OPTIONS returns 405 instead of permissive preflight (Node)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/content/feedface/source/7`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:8081",
        "Access-Control-Request-Method": "DELETE",
      },
    });

    expect(res.status).toBe(405);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
  });

});

describe.runIf(typeof Bun !== "undefined" || process.env.TEST_BUN_RUNTIME === "1")("Insight API CORS — Bun runtime", () => {
  test("does not advertise permissive CORS headers (Bun)", async () => {
    const { port, child } = startInsight("bun");
    await waitForInsight(port, child);

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/abcd1234/events/sess-1`, {
      headers: { Origin: "http://127.0.0.1:8081" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
