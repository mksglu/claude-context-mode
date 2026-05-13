/**
 * Issue #539: Claude Code running inside VS Code is misdetected as
 * vscode-copilot because Microsoft's `code` bootstrap exports VSCODE_PID
 * / VSCODE_CWD into every spawned child process — including a Claude Code
 * CLI launched from VS Code's integrated terminal.
 *
 * The classification table in `detect.ts` correctly lists `claude-code`
 * BEFORE `vscode-copilot` (line 37 vs line 63), but the only Claude Code
 * env-var markers were `CLAUDE_PROJECT_DIR` / `CLAUDE_SESSION_ID`. Neither
 * is set on every Claude Code boot (e.g., MCP server start before the hook
 * env hydrates). When those are absent and `VSCODE_PID` is present, detect
 * picks `vscode-copilot` and `getSettingsPath()` (copilot-base.ts:258)
 * writes `.github/hooks/context-mode.json` debris into the user's repo.
 *
 * Verified Claude-Code-set env vars (live `env` dump from a Claude Code
 * CLI process, 2026-05-11):
 *   CLAUDE_CODE_ENTRYPOINT=cli
 *   CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000
 *   CLAUDE_PLUGIN_DATA=/Users/.../plugins/data/<plugin>
 *   CLAUDE_PLUGIN_ROOT=/Users/.../plugins/cache/<plugin>/<version>
 *   CLAUDE_PROJECT_DIR=/Users/.../project
 *
 * `CLAUDE_CODE_ENTRYPOINT` is the most stable disambiguator — set on
 * every Claude Code session regardless of plugin/project state.
 * `CLAUDE_PLUGIN_ROOT` is set whenever Claude Code is running with a
 * plugin loaded (which is the case when context-mode itself is active).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin homedir() so installed_plugins.json detection can be exercised against
// a temp HOME instead of the developer's real ~/.claude (which actually does
// have context-mode installed in this repo's environment).
const homedirMock = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => homedirMock.current || actual.homedir(),
  };
});

const {
  detectPlatform,
  __resetClaudeCodePluginCacheForTests,
} = await import("../../src/adapters/detect.js");

describe("Issue #539 — Claude Code inside VS Code disambiguation", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Wipe every marker so each test starts from a clean slate.
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    delete process.env.VSCODE_PID;
    delete process.env.VSCODE_CWD;
    delete process.env.CONTEXT_MODE_PLATFORM;
    homedirMock.current = "";
    __resetClaudeCodePluginCacheForTests();
  });

  afterEach(() => {
    process.env = savedEnv;
    homedirMock.current = "";
    __resetClaudeCodePluginCacheForTests();
  });

  it("returns claude-code (NOT vscode-copilot) when VSCODE_PID set AND CLAUDE_CODE_ENTRYPOINT set", () => {
    // Reproduces issue #539: VS Code's integrated terminal exports
    // VSCODE_PID into the Claude Code CLI process; without this fix,
    // detect classified it as vscode-copilot and wrote .github/hooks/.
    process.env.VSCODE_PID = "12345";
    process.env.VSCODE_CWD = "/Users/me/project";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";

    const signal = detectPlatform();
    expect(signal.platform).toBe("claude-code");
    expect(signal.confidence).toBe("high");
  });

  it("returns claude-code when VSCODE_PID set AND CLAUDE_PLUGIN_ROOT set", () => {
    // CLAUDE_PLUGIN_ROOT is set when Claude Code runs with a plugin loaded
    // — context-mode is itself loaded as a Claude Code plugin so this var
    // is present whenever the issue manifests in practice.
    process.env.VSCODE_PID = "12345";
    process.env.CLAUDE_PLUGIN_ROOT =
      "/Users/me/.claude/plugins/cache/context-mode/context-mode/1.0.118";

    const signal = detectPlatform();
    expect(signal.platform).toBe("claude-code");
    expect(signal.confidence).toBe("high");
  });

  // ── Slice 2: installed_plugins.json fallback ────────────
  //
  // Belt-and-suspenders: if BOTH env-var disambiguators happen to be absent
  // (a real-world MCP-server-only boot we have not observed yet) but the
  // user has ~/.claude/plugins/installed_plugins.json with a context-mode
  // entry, treat that as proof the runtime is Claude Code with our plugin
  // loaded. File is read once per process via memoization to keep detect()
  // hot-path cost flat.

  it("returns claude-code (NOT vscode-copilot) when VSCODE_PID set AND ~/.claude/plugins/installed_plugins.json has context-mode entry", () => {
    // Create a fake $HOME with an installed_plugins.json that mentions
    // context-mode the same way the real file does.
    const fakeHome = mkdtempSync(join(tmpdir(), "ctx-mode-539-"));
    try {
      const pluginsDir = join(fakeHome, ".claude", "plugins");
      mkdirSync(pluginsDir, { recursive: true });
      writeFileSync(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "context-mode@context-mode": [
              {
                installPath:
                  "/Users/me/.claude/plugins/cache/context-mode/context-mode/1.0.121",
              },
            ],
          },
          enabledPlugins: { "context-mode@context-mode": true },
        }),
      );

      homedirMock.current = fakeHome;
      __resetClaudeCodePluginCacheForTests();

      process.env.VSCODE_PID = "12345";
      process.env.VSCODE_CWD = "/Users/me/project";

      const signal = detectPlatform();
      expect(signal.platform).toBe("claude-code");
      expect(signal.confidence).toBe("high");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // ── Slice 3: regression guard for genuine vscode-copilot ────
  //
  // Plain VS Code Copilot (no Claude Code in the picture) MUST still
  // resolve to vscode-copilot. The slice-1 env-var additions and the
  // slice-2 installed_plugins.json fallback must not over-correct away
  // from the genuine vscode-copilot case.

  it("STILL returns vscode-copilot when ONLY VSCODE_PID/VSCODE_CWD set (no CC markers, no plugin file)", () => {
    // Pin homedir to a fresh empty dir so the slice-2 plugin-file lookup
    // resolves to ENOENT and the env-var loop returns vscode-copilot.
    const fakeHome = mkdtempSync(join(tmpdir(), "ctx-mode-539-empty-"));
    try {
      homedirMock.current = fakeHome;
      __resetClaudeCodePluginCacheForTests();

      process.env.VSCODE_PID = "12345";
      process.env.VSCODE_CWD = "/Users/me/project";

      const signal = detectPlatform();
      expect(signal.platform).toBe("vscode-copilot");
      expect(signal.confidence).toBe("high");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // ── Slice 4: MCP clientInfo highest-priority path ─────────
  //
  // When the MCP `initialize` handshake reports clientInfo.name as
  // "claude-code", detect() MUST return claude-code regardless of any
  // env-var combination — even the polluted-shell case where VSCODE_PID
  // is set without any CC env marker. client-map.ts maps the name; this
  // test pins the priority order at the detect() boundary.

  it("prefers MCP clientInfo.name=\"claude-code\" over VSCODE_PID env detection", () => {
    // Worst-case: every vscode-copilot env marker present, no CC env vars.
    process.env.VSCODE_PID = "12345";
    process.env.VSCODE_CWD = "/Users/me/project";

    const signal = detectPlatform({ name: "claude-code" });
    expect(signal.platform).toBe("claude-code");
    expect(signal.confidence).toBe("high");
    expect(signal.reason).toMatch(/clientInfo/i);
  });
});
