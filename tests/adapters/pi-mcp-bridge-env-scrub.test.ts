import "../setup-home";
/**
 * Issue #545 — Pi bridge env scrub.
 *
 * Pi's MCP bridge spawns server.bundle.mjs as a long-lived child via stdio.
 * Without scrubbing, the child inherits the host shell's env including
 * CLAUDE_PROJECT_DIR, GEMINI_PROJECT_DIR, VSCODE_CWD, IDEA_INITIAL_DIRECTORY
 * etc. — leaked from a prior `claude` / `gemini` invocation. The MCP server
 * then resolves `getProjectDir()` to the foreign workspace and Pi's sessions
 * write into the wrong project.
 *
 * Fix: on child spawn, delete every var in `foreignWorkspaceEnv("pi")` from
 * the inherited env. Pi's own workspace vars (PI_WORKSPACE_DIR,
 * PI_PROJECT_DIR) and identification vars (CLAUDE_PLUGIN_ROOT, etc.) are
 * preserved — only project-path leaks from OTHER platforms are stripped.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPStdioClient } from "../../src/adapters/pi/mcp-bridge.js";

let scratch: string;
let fakeServer: string;
const clients: MCPStdioClient[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ctx-pi-env-scrub-"));
  // Fake MCP server that does nothing — keeps stdin alive so the bridge
  // doesn't see an immediate exit. We never send a request, so this is fine.
  fakeServer = join(scratch, "noop-server.mjs");
  writeFileSync(fakeServer, `process.stdin.resume();`, "utf-8");
});

afterEach(() => {
  for (const c of clients.splice(0)) {
    try { c.shutdown(); } catch { /* best effort */ }
  }
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("Pi MCPStdioClient — foreign workspace env scrub (issue #545)", () => {
  it("strips CLAUDE_PROJECT_DIR / GEMINI_PROJECT_DIR / VSCODE_CWD / IDEA_INITIAL_DIRECTORY from spawned child env", () => {
    const env: NodeJS.ProcessEnv = {
      // Foreign workspace leaks — must be removed.
      CLAUDE_PROJECT_DIR: "/leak/from/claude",
      GEMINI_PROJECT_DIR: "/leak/from/gemini",
      VSCODE_CWD: "/leak/from/vscode",
      IDEA_INITIAL_DIRECTORY: "/leak/from/idea",
      OPENCODE_PROJECT_DIR: "/leak/from/opencode",
      QWEN_PROJECT_DIR: "/leak/from/qwen",
      CURSOR_CWD: "/leak/from/cursor",
      // Pi's own workspace vars — must survive.
      PI_WORKSPACE_DIR: "/Users/x/own-pi-workspace",
      PI_PROJECT_DIR: "/Users/x/own-pi-project",
      // Identification vars — never scrubbed.
      CLAUDE_PLUGIN_ROOT: "/some/plugin/root",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      // Universal escape hatch — never scrubbed.
      CONTEXT_MODE_PROJECT_DIR: "/Users/x/escape",
      // Non-platform env — preserved as-is (not in any registry).
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: "/Users/x",
    };

    const client = new MCPStdioClient(fakeServer, env);
    clients.push(client);
    client.start();

    const spawned = client._spawnEnv;
    expect(spawned).not.toBeNull();
    if (!spawned) throw new Error("unreachable");

    // Foreign workspace vars — REMOVED.
    expect(spawned.CLAUDE_PROJECT_DIR).toBeUndefined();
    expect(spawned.GEMINI_PROJECT_DIR).toBeUndefined();
    expect(spawned.VSCODE_CWD).toBeUndefined();
    expect(spawned.IDEA_INITIAL_DIRECTORY).toBeUndefined();
    expect(spawned.OPENCODE_PROJECT_DIR).toBeUndefined();
    expect(spawned.QWEN_PROJECT_DIR).toBeUndefined();
    expect(spawned.CURSOR_CWD).toBeUndefined();

    // Pi's own workspace vars — PRESERVED.
    expect(spawned.PI_WORKSPACE_DIR).toBe("/Users/x/own-pi-workspace");
    expect(spawned.PI_PROJECT_DIR).toBe("/Users/x/own-pi-project");

    // Identification vars — PRESERVED (some are load-bearing for hooks).
    expect(spawned.CLAUDE_PLUGIN_ROOT).toBe("/some/plugin/root");
    expect(spawned.CLAUDE_CODE_ENTRYPOINT).toBe("cli");

    // Universal escape hatch — PRESERVED.
    expect(spawned.CONTEXT_MODE_PROJECT_DIR).toBe("/Users/x/escape");

    // Non-platform env — PRESERVED.
    expect(spawned.HOME).toBe("/Users/x");
  });

  it("scrub is symmetric: foreign vars from any other adapter are stripped (registry-driven)", () => {
    // OMP's PI_CODING_AGENT_DIR is a foreign workspace var for Pi — derived
    // from the registry, NOT a hardcoded list. If a future adapter registers
    // a workspace var, this test still passes without modification.
    const env: NodeJS.ProcessEnv = {
      PI_CODING_AGENT_DIR: "/leak/from/omp",
      PI_PROJECT_DIR: "/Users/x/own",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    };
    const client = new MCPStdioClient(fakeServer, env);
    clients.push(client);
    client.start();
    const spawned = client._spawnEnv;
    expect(spawned).not.toBeNull();
    if (!spawned) throw new Error("unreachable");
    // OMP's PI_CODING_AGENT_DIR is a foreign workspace var for Pi — scrubbed.
    expect(spawned.PI_CODING_AGENT_DIR).toBeUndefined();
    // Pi's own var survives.
    expect(spawned.PI_PROJECT_DIR).toBe("/Users/x/own");
  });
});
