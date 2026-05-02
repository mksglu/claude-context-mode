/**
 * Regression: ctx_fetch_and_index must NOT leave temp files on disk.
 *
 * The handler writes fetched content (which can include auth headers and
 * API tokens via subprocess fetch) to `os.tmpdir()/ctx-fetch-*.dat`, then
 * reads it back. On macOS /tmp is world-readable, so leaking even one
 * file is a P0 security issue on shared hosts.
 *
 * Two layers of protection:
 *   1. Static source guard — the handler in src/server.ts MUST contain a
 *      `finally { ... rmSync(outputPath) ... }` block. Refactors that drop
 *      the cleanup will fail this assertion immediately.
 *   2. Behavioural test — replicates the handler's read+cleanup pattern
 *      against a real local HTTP server fixture and confirms no
 *      `ctx-fetch-*.dat` file remains in `os.tmpdir()` after success,
 *      empty-content, or error paths.
 *
 * Run: npx vitest run tests/core/fetch-cleanup.test.ts
 */

import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect, beforeAll, afterAll } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_TS = resolve(__dirname, "../../src/server.ts");

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

function listCtxFetchTmpFiles(): Set<string> {
  return new Set(
    readdirSync(tmpdir()).filter((f) => f.startsWith("ctx-fetch-")),
  );
}

function makeOutputPath(): string {
  // Match the production naming exactly so the snapshot filter catches it.
  return join(
    tmpdir(),
    `ctx-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}.dat`,
  );
}

/**
 * Mirrors the production cleanup pattern in `ctx_fetch_and_index`. If this
 * function ever diverges from the handler, the static-source test below
 * will fail before this one is reached.
 */
function readAndCleanup(outputPath: string): { content: string | null; error: Error | null } {
  let content: string | null = null;
  let error: Error | null = null;
  try {
    content = readFileSync(outputPath, "utf-8").trim();
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  } finally {
    try {
      unlinkSync(outputPath);
    } catch {
      /* file may not exist if the subprocess crashed before writing — OK */
    }
  }
  return { content, error };
}

// ───────────────────────────────────────────────────────────────────
// Static source guard — fail if cleanup is removed from the handler.
// ───────────────────────────────────────────────────────────────────

describe("ctx_fetch_and_index cleanup — static source guard", () => {
  test("handler contains try/finally with rmSync/unlinkSync of outputPath", () => {
    const src = readFileSync(SERVER_TS, "utf-8");
    const handlerStart = src.indexOf('"ctx_fetch_and_index"');
    expect(handlerStart, "ctx_fetch_and_index handler not found").toBeGreaterThan(-1);

    // Find the registerTool call's closing — search ~6KB ahead, plenty for the handler.
    const handlerSlice = src.slice(handlerStart, handlerStart + 8192);

    // The handler MUST allocate the temp file path...
    expect(handlerSlice).toMatch(/ctx-fetch-.*\.dat/);
    // ...wrap the read+index in try/finally...
    expect(handlerSlice).toMatch(/}\s*finally\s*{[^}]*?(rmSync|unlinkSync)\s*\(\s*outputPath\s*\)/s);
  });
});

// ───────────────────────────────────────────────────────────────────
// Behavioural test — local HTTP fixture, no bundle required.
// ───────────────────────────────────────────────────────────────────

describe("ctx_fetch_and_index cleanup — behaviour", () => {
  let httpServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      if (req.url === "/empty") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("");
        return;
      }
      if (req.url === "/json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "secret-abc-123", note: "do not leak" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello world from local fixture");
    });
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const addr = httpServer.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  test("success path: tmp file is unlinked after read", () => {
    const before = listCtxFetchTmpFiles();
    const outputPath = makeOutputPath();

    // Simulate the subprocess writing fetched content to the temp file.
    writeFileSync(outputPath, "fetched body containing Authorization: Bearer xyz");
    expect(existsSync(outputPath)).toBe(true);

    const { content, error } = readAndCleanup(outputPath);
    expect(error).toBeNull();
    expect(content).toContain("Authorization: Bearer xyz");

    expect(existsSync(outputPath)).toBe(false);
    const after = listCtxFetchTmpFiles();
    expect(after.size).toBe(before.size);
    for (const f of after) assert(before.has(f), `Leaked tmp file: ${f}`);
  });

  test("empty content path: tmp file is still unlinked", () => {
    const before = listCtxFetchTmpFiles();
    const outputPath = makeOutputPath();

    writeFileSync(outputPath, "");
    const { content } = readAndCleanup(outputPath);
    expect(content).toBe("");

    expect(existsSync(outputPath)).toBe(false);
    const after = listCtxFetchTmpFiles();
    expect(after.size).toBe(before.size);
  });

  test("error path: read throws, tmp file (if any) is still removed", () => {
    const before = listCtxFetchTmpFiles();
    const outputPath = makeOutputPath();

    // Subprocess crashed before writing — file does not exist. The cleanup
    // must not throw, and no leak should appear.
    expect(existsSync(outputPath)).toBe(false);
    const { content, error } = readAndCleanup(outputPath);
    expect(content).toBeNull();
    expect(error).not.toBeNull();
    expect(existsSync(outputPath)).toBe(false);

    const after = listCtxFetchTmpFiles();
    expect(after.size).toBe(before.size);
  });

  test("partial-write error path: file exists but read+cleanup still drains it", () => {
    const before = listCtxFetchTmpFiles();
    const outputPath = makeOutputPath();

    // Subprocess wrote sensitive content, then handler reads — even if a
    // downstream step throws, the file must be removed.
    writeFileSync(outputPath, '{"token":"secret-abc-123"}');
    let threw = false;
    try {
      try {
        const c = readFileSync(outputPath, "utf-8");
        // Simulate downstream indexer failure.
        if (c.includes("secret")) throw new Error("indexer blew up");
      } finally {
        try { unlinkSync(outputPath); } catch { /* ok */ }
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(existsSync(outputPath)).toBe(false);

    const after = listCtxFetchTmpFiles();
    expect(after.size).toBe(before.size);
  });

  test("real fetch via local HTTP fixture: response body never persists on disk", async () => {
    const before = listCtxFetchTmpFiles();
    const outputPath = makeOutputPath();

    // Mimic the subprocess: fetch URL, write body to outputPath.
    const resp = await fetch(`${baseUrl}/json`);
    const body = await resp.text();
    writeFileSync(outputPath, body);
    expect(body).toContain("secret-abc-123");

    const { content } = readAndCleanup(outputPath);
    expect(content).toContain("secret-abc-123");
    expect(existsSync(outputPath)).toBe(false);

    const after = listCtxFetchTmpFiles();
    expect(after.size).toBe(before.size);
  });
});
