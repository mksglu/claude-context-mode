import "../setup-home";
/**
 * Pi MCP bridge — fork-bomb prevention (#516).
 *
 * Original bug: src/adapters/pi/mcp-bridge.ts:76 used `process.execPath`
 * to spawn the MCP server child. When context-mode runs *inside* the
 * Pi binary (Bun-only Fedora 44 ships no `node`), `process.execPath`
 * IS the Pi binary itself — every spawn re-executes Pi, which re-loads
 * context-mode, which spawns another Pi … fork bomb that takes the box
 * down.
 *
 * These tests pin the three guarantees that make the bridge safe:
 *
 *   1. Resolve a real JS runtime (bun/node), reject pi-named binaries
 *      even when they are returned by `detectRuntimes().javascript`.
 *   2. Pass `CONTEXT_MODE_BRIDGE_DEPTH=1` into the child env so any
 *      transitive bridge load can detect the recursion.
 *   3. Refuse to bootstrap if `CONTEXT_MODE_BRIDGE_DEPTH > 0` is
 *      already set in the current process env (catches recursion that
 *      bypasses the binary-name check, e.g. `node` shim that re-execs
 *      Pi).
 *   4. When neither node nor bun is on PATH AND execPath is pi, log
 *      once and skip the bridge instead of throwing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ctx-pi-forkbomb-"));
});

afterEach(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  delete process.env.CONTEXT_MODE_BRIDGE_DEPTH;
});

// Slice 1 — runtime name guard
describe("resolveJsRuntimeForBridge — Pi fork-bomb guard (#516)", () => {
  it("rejects a pi-named binary returned by detectRuntimes and falls back to PATH node/bun", async () => {
    const mod = await import("../../src/adapters/pi/mcp-bridge.js");
    const { resolveJsRuntimeForBridge } = mod as unknown as {
      resolveJsRuntimeForBridge: (deps?: {
        detect?: () => { javascript: string | null };
        which?: (cmd: string) => string | null;
        execPath?: string;
      }) => string | null;
    };
    expect(typeof resolveJsRuntimeForBridge).toBe("function");

    // Detect returns the Pi binary (the bug condition). Helper must
    // refuse it and fall back to whatever `which` resolves for node/bun.
    const resolved = resolveJsRuntimeForBridge({
      detect: () => ({ javascript: "/usr/local/bin/pi" }),
      which: (cmd) => (cmd === "node" ? "/usr/bin/node" : null),
      execPath: "/usr/local/bin/pi",
    });

    expect(resolved).toBe("/usr/bin/node");
  });

  it("rejects pi.exe (case-insensitive, .exe suffix) on Windows-shaped paths", async () => {
    const mod = await import("../../src/adapters/pi/mcp-bridge.js");
    const { resolveJsRuntimeForBridge } = mod as unknown as {
      resolveJsRuntimeForBridge: (deps?: {
        detect?: () => { javascript: string | null };
        which?: (cmd: string) => string | null;
        execPath?: string;
      }) => string | null;
    };

    const resolved = resolveJsRuntimeForBridge({
      detect: () => ({ javascript: "C:\\Program Files\\Pi\\Pi.EXE" }),
      which: (cmd) => (cmd === "bun" ? "C:\\bun\\bun.exe" : null),
      execPath: "C:\\Program Files\\Pi\\Pi.EXE",
    });

    expect(resolved).toBe("C:\\bun\\bun.exe");
  });
});

// Slice 2 — env depth counter
describe("MCP bridge spawn — passes CONTEXT_MODE_BRIDGE_DEPTH=1 to child env (#516)", () => {
  it("child process inherits CONTEXT_MODE_BRIDGE_DEPTH=1", async () => {
    // Fake server that prints the depth env var and exits.
    const fakePath = join(scratch, "echo-depth.mjs");
    writeFileSync(
      fakePath,
      `process.stdout.write(JSON.stringify({ depth: process.env.CONTEXT_MODE_BRIDGE_DEPTH }) + "\\n");
       setInterval(() => {}, 1000);`,
      "utf-8",
    );

    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-bridge.js");
    const client = new MCPStdioClient(fakePath);
    client.start();

    // Pluck the live env that was passed into spawn — exposed for tests.
    const live = (client as unknown as { _spawnEnv?: NodeJS.ProcessEnv })._spawnEnv;
    expect(live?.CONTEXT_MODE_BRIDGE_DEPTH).toBe("1");

    client.shutdown();
  });
});

// Slice 3 — recursion guard via env counter
describe("bootstrapMCPTools — recursion guard (#516)", () => {
  it("aborts and logs once when CONTEXT_MODE_BRIDGE_DEPTH > 0 already set", async () => {
    process.env.CONTEXT_MODE_BRIDGE_DEPTH = "1";

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { bootstrapMCPTools } = await import("../../src/adapters/pi/mcp-bridge.js");
    const fakePi = { registerTool: vi.fn() };

    const handle = await bootstrapMCPTools(fakePi, "/non/existent/server.mjs");

    expect(handle.tools).toEqual([]);
    expect(fakePi.registerTool).not.toHaveBeenCalled();
    // Diagnostic must mention recursion / depth so ops can grep it.
    const messages = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(messages).toMatch(/recursion|depth|fork/i);

    stderrSpy.mockRestore();
  });
});

// Slice 4 — graceful skip when no JS runtime
describe("bootstrapMCPTools — no JS runtime + execPath is pi (#516)", () => {
  it("logs once to stderr and returns an empty handle without throwing", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { bootstrapMCPTools } = await import("../../src/adapters/pi/mcp-bridge.js");
    const fakePi = { registerTool: vi.fn() };

    // Inject the no-runtime condition through the same DI hook the
    // bridge uses internally — see resolveJsRuntimeForBridge above.
    const handle = await bootstrapMCPTools(fakePi, "/non/existent/server.mjs", {
      _resolveJsRuntime: () => null,
    } as unknown as { env?: NodeJS.ProcessEnv });

    expect(handle.tools).toEqual([]);
    expect(fakePi.registerTool).not.toHaveBeenCalled();

    const messages = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(messages).toMatch(/no JS runtime|node.*bun|runtime.*not found/i);

    stderrSpy.mockRestore();
  });
});

// Slice 5 — respawn after idle self-shutdown (#583)
//
// Regression: in v1.0.132 the MCP server gained an idle self-shutdown
// (#565/#568, lifecycle.ts). When the Pi-spawned child exits cleanly
// after CONTEXT_MODE_IDLE_TIMEOUT_MS of inactivity, Pi keeps the
// previously-registered tool handles, but the bridge client has
// `exited=true` and every subsequent request rejects with
// "MCP server has exited". The user sees a permanently broken set of
// `ctx_*` tools until they restart Pi.
//
// Fix: when `callTool()` is invoked on an exited client, respawn the
// MCP child + re-`initialize()` transparently before issuing the call,
// so already-registered Pi tools recover on the very next use.
describe("MCPStdioClient — respawns after idle self-shutdown (#583)", () => {
  it("re-spawns the child when callTool is invoked after exit, and the call succeeds", async () => {
    // Fake MCP server: handles initialize, tools/list, tools/call.
    // On its FIRST process incarnation it exits cleanly after the first
    // tools/call — mirroring lifecycle.ts gracefulShutdown(0) firing on
    // idle. A marker file on disk distinguishes the original child from
    // the respawned one so the second incarnation stays alive.
    const markerPath = join(scratch, "first-incarnation-marker");
    const fakePath = join(scratch, "exit-after-call.mjs");
    writeFileSync(
      fakePath,
      `
      import { existsSync, writeFileSync } from "node:fs";
      const MARKER = ${JSON.stringify(markerPath)};
      const isFirst = !existsSync(MARKER);
      let line = "";
      let callCount = 0;
      process.stdin.on("data", (chunk) => {
        line += chunk.toString("utf-8");
        let idx;
        while ((idx = line.indexOf("\\n")) >= 0) {
          const raw = line.slice(0, idx).trim();
          line = line.slice(idx + 1);
          if (!raw) continue;
          let msg;
          try { msg = JSON.parse(raw); } catch { continue; }
          if (msg.method === "initialize") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }) + "\\n");
          } else if (msg.method === "tools/list") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "p", inputSchema: { type: "object" } }] } }) + "\\n");
          } else if (msg.method === "tools/call") {
            callCount++;
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong-pid-" + process.pid }] } }) + "\\n");
            // First incarnation: mimic idle self-shutdown after one call.
            if (isFirst && callCount === 1) {
              writeFileSync(MARKER, "1");
              setTimeout(() => process.exit(0), 10);
            }
          }
        }
      });
      // Keep the event loop alive until stdin closes / we exit.
      setInterval(() => {}, 60000);
      `,
      "utf-8",
    );

    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-bridge.js");
    const client = new MCPStdioClient(fakePath);
    client.start();
    await client.initialize();

    // First call: succeeds, then the fake server exits cleanly.
    const r1 = await client.callTool("ping", {});
    const t1 = r1.content?.[0]?.text ?? "";
    expect(t1).toMatch(/^pong-pid-/);
    const pid1 = t1.replace(/^pong-pid-/, "");

    // Wait for the child to actually exit so the client observes onExit.
    await new Promise<void>((resolve) => {
      const wait = () => {
        if ((client as unknown as { exited: boolean }).exited) return resolve();
        setTimeout(wait, 25);
      };
      wait();
    });

    // Second call: MUST NOT reject with "MCP server has exited" — the
    // client should respawn and re-initialize transparently.
    const r2 = await client.callTool("ping", {});
    const t2 = r2.content?.[0]?.text ?? "";
    expect(t2).toMatch(/^pong-pid-/);
    const pid2 = t2.replace(/^pong-pid-/, "");
    // New PID proves a fresh child was spawned, not the original.
    expect(pid2).not.toBe(pid1);

    client.shutdown();
  }, 15_000);
});

// ── #583 follow-up: hardening on top of the original respawn-on-exit fix ──
//
// The original #583 patch put the respawn guard in `callTool()` only.
// The follow-up moves it into `request()` (covering `tools/list` and
// `initialize` paths after idle exit) AND adds a single-flight guard so
// concurrent callers don't each spawn their own child and leak orphans.
describe("MCPStdioClient — request() respawns for any method after idle exit (#583 follow-up)", () => {
  it("listTools() after an idle exit triggers respawn (not just callTool)", async () => {
    // Fake server: exits after the FIRST tools/list response. The bridge
    // must respawn on the next listTools() invocation — proving the
    // respawn guard fires for `tools/list`, not only `tools/call`.
    const markerPath = join(scratch, "first-incarnation-marker-list");
    const fakePath = join(scratch, "exit-after-list.mjs");
    writeFileSync(
      fakePath,
      `
      import { existsSync, writeFileSync } from "node:fs";
      const MARKER = ${JSON.stringify(markerPath)};
      const isFirst = !existsSync(MARKER);
      let line = "";
      let listCount = 0;
      process.stdin.on("data", (chunk) => {
        line += chunk.toString("utf-8");
        let idx;
        while ((idx = line.indexOf("\\n")) >= 0) {
          const raw = line.slice(0, idx).trim();
          line = line.slice(idx + 1);
          if (!raw) continue;
          let msg;
          try { msg = JSON.parse(raw); } catch { continue; }
          if (msg.method === "initialize") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }) + "\\n");
          } else if (msg.method === "tools/list") {
            listCount++;
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping-pid-" + process.pid, description: "p", inputSchema: { type: "object" } }] } }) + "\\n");
            if (isFirst && listCount === 1) {
              writeFileSync(MARKER, "1");
              setTimeout(() => process.exit(0), 10);
            }
          }
        }
      });
      setInterval(() => {}, 60000);
      `,
      "utf-8",
    );

    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-bridge.js");
    const client = new MCPStdioClient(fakePath);
    client.start();
    await client.initialize();

    // First listTools: original incarnation responds, then exits.
    const tools1 = await client.listTools();
    expect(tools1).toHaveLength(1);
    const pid1 = tools1[0].name.replace(/^ping-pid-/, "");

    // Wait for the child to actually exit.
    await new Promise<void>((resolve) => {
      const wait = () => {
        if ((client as unknown as { exited: boolean }).exited) return resolve();
        setTimeout(wait, 25);
      };
      wait();
    });

    // Second listTools: should respawn + re-init, NOT reject. Bug class:
    // pre-fix, this would reject with "MCP server has exited" because the
    // respawn guard lived in callTool only and tools/list went straight
    // through request().
    const tools2 = await client.listTools();
    expect(tools2).toHaveLength(1);
    const pid2 = tools2[0].name.replace(/^ping-pid-/, "");
    expect(pid2).not.toBe(pid1);

    client.shutdown();
  }, 15_000);

  it("concurrent callTool() invocations after exit share ONE respawn (no orphan children)", async () => {
    // Failure mode without the single-flight guard: caller A and caller B
    // both observe `this.exited === true`, both invoke respawn(), each
    // spawns a child. The loser of the race overwrites `this.child` and
    // its child becomes an orphan with no `.kill()` reference.
    //
    // The fake server marks every PID it spawns under a directory. After
    // two concurrent calls, exactly ONE new PID should be observed.
    const markerPath = join(scratch, "first-incarnation-marker-concurrent");
    const pidsDir = join(scratch, "spawned-pids-concurrent");
    const fakePath = join(scratch, "exit-after-call-concurrent.mjs");
    writeFileSync(
      fakePath,
      `
      import { existsSync, writeFileSync, mkdirSync } from "node:fs";
      import { join as joinPath } from "node:path";
      const MARKER = ${JSON.stringify(markerPath)};
      const PIDS_DIR = ${JSON.stringify(pidsDir)};
      mkdirSync(PIDS_DIR, { recursive: true });
      // Record this process pid the moment we boot — covers both the
      // first incarnation AND any respawned child.
      writeFileSync(joinPath(PIDS_DIR, String(process.pid)), "1");
      const isFirst = !existsSync(MARKER);
      let line = "";
      let callCount = 0;
      process.stdin.on("data", (chunk) => {
        line += chunk.toString("utf-8");
        let idx;
        while ((idx = line.indexOf("\\n")) >= 0) {
          const raw = line.slice(0, idx).trim();
          line = line.slice(idx + 1);
          if (!raw) continue;
          let msg;
          try { msg = JSON.parse(raw); } catch { continue; }
          if (msg.method === "initialize") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }) + "\\n");
          } else if (msg.method === "tools/list") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "p", inputSchema: { type: "object" } }] } }) + "\\n");
          } else if (msg.method === "tools/call") {
            callCount++;
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong-" + process.pid }] } }) + "\\n");
            if (isFirst && callCount === 1) {
              writeFileSync(MARKER, "1");
              setTimeout(() => process.exit(0), 10);
            }
          }
        }
      });
      setInterval(() => {}, 60000);
      `,
      "utf-8",
    );

    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-bridge.js");
    const client = new MCPStdioClient(fakePath);
    client.start();
    await client.initialize();

    // First call: original incarnation responds and exits.
    await client.callTool("ping", {});

    // Wait for exit.
    await new Promise<void>((resolve) => {
      const wait = () => {
        if ((client as unknown as { exited: boolean }).exited) return resolve();
        setTimeout(wait, 25);
      };
      wait();
    });

    // Now fire TWO callTool invocations simultaneously — both see
    // `this.exited === true`. Without single-flight, both would call
    // respawn(), each spawning its own child. With single-flight, only
    // one child should be spawned and both calls share it.
    const [r1, r2] = await Promise.all([
      client.callTool("ping", {}),
      client.callTool("ping", {}),
    ]);
    const respPid1 = (r1.content?.[0]?.text ?? "").replace(/^pong-/, "");
    const respPid2 = (r2.content?.[0]?.text ?? "").replace(/^pong-/, "");
    // Both calls must resolve through the SAME respawned child.
    expect(respPid1).toBe(respPid2);

    // Filesystem evidence: exactly two pids ever marked (original +
    // one respawn). If two respawns raced, we'd see 3 pid files.
    const { readdirSync } = await import("node:fs");
    const recordedPids = readdirSync(pidsDir);
    expect(recordedPids).toHaveLength(2);

    client.shutdown();
  }, 20_000);

  it("respawn() resets state in the documented order — `exited=false` BEFORE initialize()", async () => {
    // Pin the sequencing contract called out in respawn()'s JSDoc.
    // If a future refactor moves `this.exited = false` to AFTER
    // `await this.initialize()`, the recursive request("initialize", ...)
    // inside respawn would see `exited === true` and re-enter respawn
    // forever (infinite loop, not just a stale reject).
    //
    // We exercise the path: state ALL clears before initialize fires.
    const fakePath = join(scratch, "introspect-respawn.mjs");
    writeFileSync(
      fakePath,
      `
      let line = "";
      process.stdin.on("data", (chunk) => {
        line += chunk.toString("utf-8");
        let idx;
        while ((idx = line.indexOf("\\n")) >= 0) {
          const raw = line.slice(0, idx).trim();
          line = line.slice(idx + 1);
          if (!raw) continue;
          let msg;
          try { msg = JSON.parse(raw); } catch { continue; }
          if (msg.method === "initialize") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }) + "\\n");
          } else if (msg.method === "tools/call") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } }) + "\\n");
          }
        }
      });
      setInterval(() => {}, 60000);
      `,
      "utf-8",
    );

    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-bridge.js");
    const client = new MCPStdioClient(fakePath);
    client.start();
    await client.initialize();

    // Force the exited flag, then trigger a callTool — request() should
    // run respawn, which must reset state before initialize() fires.
    const internal = client as unknown as {
      exited: boolean;
      initialized: boolean;
      child: unknown;
    };

    // Mark it as exited manually (simulating the post-onExit state
    // without actually killing the child — keeps test deterministic).
    internal.exited = true;

    // callTool must succeed via the respawn path. If `exited` is not
    // cleared before the recursive request("initialize", ...) call,
    // this hangs forever and the test times out at the per-it limit.
    const res = await client.callTool("ping", {});
    expect((res.content?.[0]?.text ?? "")).toBe("ok");

    // Post-call invariants — proves respawn finished cleanly.
    expect(internal.exited).toBe(false);
    expect(internal.initialized).toBe(true);
    expect(internal.child).not.toBeNull();

    client.shutdown();
  }, 15_000);
});
