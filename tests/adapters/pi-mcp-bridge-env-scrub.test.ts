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

    // v1.0.129 #561 — Foreign identification vars (CLAUDE_PLUGIN_ROOT,
    // CLAUDE_CODE_ENTRYPOINT) are now ALSO scrubbed because they hijack
    // detectPlatform() in the child. The original v1.0.124 #545 fix
    // PRESERVED them; the v1.0.129 hotfix correctly removes them when
    // Pi spawns a child under a different host.
    expect(spawned.CLAUDE_PLUGIN_ROOT).toBeUndefined();
    expect(spawned.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();

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

// v1.0.129 slice 4 — Issue #561 algorithmic identification env scrub.
// Pi runs alongside Claude Code; the spawned MCP child inherits both
// CLAUDE_CODE_ENTRYPOINT and CLAUDE_PLUGIN_ROOT, hijacking the child's
// detectPlatform() so it returns claude-code instead of pi. Pi's session
// data then writes to ~/.claude/context-mode/ — the root cause of #560.
// The fix mirrors the v1.0.124 #545 workspace scrub: derive the foreign
// identification ban set algorithmically from PLATFORM_ENV_VARS so adapter
// #16 inherits the scrub for free.
describe("Pi MCPStdioClient — foreign identification env scrub (issue #561)", () => {
  it("strips CLAUDE_CODE_ENTRYPOINT / CLAUDE_PLUGIN_ROOT / CLAUDE_SESSION_ID from spawned child env", () => {
    const env: NodeJS.ProcessEnv = {
      // Foreign identification leaks (Claude Code running co-resident
      // with Pi) — must be removed so the child does not detect as
      // claude-code.
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_PLUGIN_ROOT: "/Users/x/.claude/plugins/marketplaces/x/cm/1.0.128",
      CLAUDE_SESSION_ID: "abcd-1234",
      // Cross-host identification leaks from other adapters.
      CURSOR_TRACE_ID: "cursor-trace-xyz",
      VSCODE_PID: "55555",
      OPENCODE: "1",
      OPENCODE_PID: "66666",
      KILO: "1",
      CODEX_THREAD_ID: "codex-th-zzz",
      GEMINI_CLI: "1",
      ZED_TERM: "true",
      ANTIGRAVITY_CLI_ALIAS: "antigravity",
      // Pi's OWN identification vars — must SURVIVE so the child detects pi.
      PI_CONFIG_DIR: "/Users/x/.pi/config",
      PI_SESSION_FILE: "/Users/x/.pi/sessions/active.json",
      PI_COMPILED: "1",
      // Universal escape hatch — never scrubbed.
      CONTEXT_MODE_PROJECT_DIR: "/Users/x/escape",
      // Non-platform env — preserved as-is.
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: "/Users/x",
    };

    const client = new MCPStdioClient(fakeServer, env);
    clients.push(client);
    client.start();

    const spawned = client._spawnEnv;
    expect(spawned).not.toBeNull();
    if (!spawned) throw new Error("unreachable");

    // Foreign identification vars — REMOVED.
    expect(spawned.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(spawned.CLAUDE_PLUGIN_ROOT).toBeUndefined();
    expect(spawned.CLAUDE_SESSION_ID).toBeUndefined();
    expect(spawned.CURSOR_TRACE_ID).toBeUndefined();
    expect(spawned.VSCODE_PID).toBeUndefined();
    expect(spawned.OPENCODE).toBeUndefined();
    expect(spawned.OPENCODE_PID).toBeUndefined();
    expect(spawned.KILO).toBeUndefined();
    expect(spawned.CODEX_THREAD_ID).toBeUndefined();
    expect(spawned.GEMINI_CLI).toBeUndefined();
    expect(spawned.ZED_TERM).toBeUndefined();
    expect(spawned.ANTIGRAVITY_CLI_ALIAS).toBeUndefined();

    // Pi's OWN identification vars — PRESERVED (otherwise the child
    // can't detect itself as pi).
    expect(spawned.PI_CONFIG_DIR).toBe("/Users/x/.pi/config");
    expect(spawned.PI_SESSION_FILE).toBe("/Users/x/.pi/sessions/active.json");
    expect(spawned.PI_COMPILED).toBe("1");

    // Universal escape hatch — PRESERVED.
    expect(spawned.CONTEXT_MODE_PROJECT_DIR).toBe("/Users/x/escape");

    // Non-platform env — PRESERVED.
    expect(spawned.HOME).toBe("/Users/x");
  });

  it("workspace scrub from #545 still works alongside identification scrub from #561", () => {
    // Both filters must compose — workspace + identification leaks together.
    const env: NodeJS.ProcessEnv = {
      // Workspace leaks (#545) — scrubbed.
      CLAUDE_PROJECT_DIR: "/leak/workspace/claude",
      VSCODE_CWD: "/leak/workspace/vscode",
      // Identification leaks (#561) — scrubbed.
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_PLUGIN_ROOT: "/leak/identification/claude",
      VSCODE_PID: "11111",
      // Pi's own vars — preserved.
      PI_PROJECT_DIR: "/Users/x/own",
      PI_CONFIG_DIR: "/Users/x/.pi/config",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    };
    const client = new MCPStdioClient(fakeServer, env);
    clients.push(client);
    client.start();
    const spawned = client._spawnEnv;
    expect(spawned).not.toBeNull();
    if (!spawned) throw new Error("unreachable");

    // Both filter sets active.
    expect(spawned.CLAUDE_PROJECT_DIR).toBeUndefined();
    expect(spawned.VSCODE_CWD).toBeUndefined();
    expect(spawned.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(spawned.CLAUDE_PLUGIN_ROOT).toBeUndefined();
    expect(spawned.VSCODE_PID).toBeUndefined();
    // Pi's own vars survive both filters.
    expect(spawned.PI_PROJECT_DIR).toBe("/Users/x/own");
    expect(spawned.PI_CONFIG_DIR).toBe("/Users/x/.pi/config");
  });
});
