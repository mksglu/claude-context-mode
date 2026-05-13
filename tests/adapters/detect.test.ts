import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sep } from "node:path";
import {
  detectPlatform,
  getAdapter,
  __seedClaudeCodePluginCacheMissForTests,
} from "../../src/adapters/detect.js";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";
import { GeminiCLIAdapter } from "../../src/adapters/gemini-cli/index.js";
import { OpenCodeAdapter } from "../../src/adapters/opencode/index.js";
import { OpenClawAdapter } from "../../src/adapters/openclaw/index.js";
import { CodexAdapter } from "../../src/adapters/codex/index.js";
import { VSCodeCopilotAdapter } from "../../src/adapters/vscode-copilot/index.js";
import { CursorAdapter } from "../../src/adapters/cursor/index.js";
import { AntigravityAdapter } from "../../src/adapters/antigravity/index.js";
import { KiroAdapter } from "../../src/adapters/kiro/index.js";
import { QwenCodeAdapter } from "../../src/adapters/qwen-code/index.js";
import { JetBrainsCopilotAdapter } from "../../src/adapters/jetbrains-copilot/index.js";
import { OMPAdapter } from "../../src/adapters/omp/index.js";
import { PiAdapter } from "../../src/adapters/pi/index.js";

// ─────────────────────────────────────────────────────────
// detectPlatform — env var detection
// ─────────────────────────────────────────────────────────

describe("detectPlatform", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Clear all platform-specific env vars to get a clean slate
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_SESSION_ID;
    // Issue #539 follow-up: CLAUDE_CODE_ENTRYPOINT / CLAUDE_PLUGIN_ROOT are
    // exported by Claude Code itself, so any test process that runs INSIDE
    // CC will inherit them. Without this wipe, every non-claude-code env-var
    // assertion below short-circuits to "claude-code" via PLATFORM_ENV_VARS.
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.GEMINI_PROJECT_DIR;
    delete process.env.GEMINI_CLI;
    delete process.env.KILO;
    delete process.env.KILO_PID;
    delete process.env.OPENCODE;
    delete process.env.OPENCODE_PID;
    delete process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_CLI;
    delete process.env.CODEX_CI;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CURSOR_CWD;
    delete process.env.CURSOR_SESSION_ID;
    delete process.env.CURSOR_TRACE_ID;
    delete process.env.VSCODE_PID;
    delete process.env.VSCODE_CWD;
    delete process.env.QWEN_PROJECT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    // Issue #542 — Pi-runtime markers (PI_CONFIG_DIR, PI_SESSION_FILE,
    // PI_COMPILED) replace the stale PI_PROJECT_DIR detection signal.
    delete process.env.PI_CONFIG_DIR;
    delete process.env.PI_SESSION_FILE;
    delete process.env.PI_COMPILED;
    delete process.env.PI_PROJECT_DIR;
    delete process.env.IDEA_INITIAL_DIRECTORY;
    delete process.env.IDEA_HOME;
    delete process.env.JETBRAINS_CLIENT_ID;
    delete process.env.CONTEXT_MODE_PLATFORM;
    // Issue #539 slice 2: tests in this file pre-date the installed_plugins.json
    // fallback and assume env-var-only detection. Seed the plugin cache to a
    // "miss" so the fallback never triggers — explicit slice-2 coverage lives
    // in detect-claude-code-in-vscode.test.ts which exercises the real read.
    __seedClaudeCodePluginCacheMissForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  // ── Claude Code ────────────────────────────────────────

  it("returns claude-code when CLAUDE_PROJECT_DIR is set", () => {
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    const signal = detectPlatform();
    expect(signal.platform).toBe("claude-code");
    expect(signal.confidence).toBe("high");
  });

  it("returns claude-code when CLAUDE_SESSION_ID is set", () => {
    process.env.CLAUDE_SESSION_ID = "abc-123";
    const signal = detectPlatform();
    expect(signal.platform).toBe("claude-code");
    expect(signal.confidence).toBe("high");
  });

  // ── Gemini CLI ─────────────────────────────────────────

  it("returns gemini-cli when GEMINI_PROJECT_DIR is set (hooks context)", () => {
    process.env.GEMINI_PROJECT_DIR = "/some/project";
    const signal = detectPlatform();
    expect(signal.platform).toBe("gemini-cli");
    expect(signal.confidence).toBe("high");
  });

  it("returns gemini-cli when GEMINI_CLI is set (MCP context)", () => {
    process.env.GEMINI_CLI = "1";
    const signal = detectPlatform();
    expect(signal.platform).toBe("gemini-cli");
    expect(signal.confidence).toBe("high");
  });

  // ── OpenCode ───────────────────────────────────────────

  it("returns opencode when OPENCODE=1 is set", () => {
    process.env.OPENCODE = "1";
    const signal = detectPlatform();
    expect(signal.platform).toBe("opencode");
    expect(signal.confidence).toBe("high");
  });

  it("returns opencode when OPENCODE_PID is set", () => {
    process.env.OPENCODE_PID = "12345";
    const signal = detectPlatform();
    expect(signal.platform).toBe("opencode");
    expect(signal.confidence).toBe("high");
  });

  // ── Kilo ────────────────────────────────────────────────
  // Kilo is an OpenCode fork. PLATFORM_ENV_VARS in src/adapters/detect.ts:36
  // explicitly orders forks BEFORE parents — kilo (line 48) is checked before
  // opencode (line 51) so a Kilo runtime that sets BOTH `KILO=1` and
  // `OPENCODE=1` (Kilo-Org/kilocode packages/opencode/src/index.ts:138-139)
  // resolves to "kilo", not "opencode". Regression coverage below.

  it("returns kilo when KILO=1 is set", () => {
    process.env.KILO = "1";
    const signal = detectPlatform();
    expect(signal.platform).toBe("kilo");
    expect(signal.confidence).toBe("high");
  });


  it("returns kilo when KILO_PID is set", () => {
    process.env.KILO_PID = "12345";
    const signal = detectPlatform();
    expect(signal.platform).toBe("kilo");
    expect(signal.confidence).toBe("high");
  });

  // Regression for #424: Kilo runtime sets KILO + OPENCODE simultaneously.
  // Fork-precedence ordering in PLATFORM_ENV_VARS (detect.ts:36 — "forks
  // listed BEFORE the fork's parent") MUST hold regardless of which env var
  // was assigned first by the harness.
  it("returns kilo when KILO and OPENCODE both set (Kilo is OpenCode fork — fork listed before parent)", () => {
    process.env.KILO = "1";
    process.env.OPENCODE = "1";
    const signal = detectPlatform();
    expect(signal.platform).toBe("kilo");
    expect(signal.confidence).toBe("high");
  });

  it("returns kilo when OPENCODE set first then KILO (assignment order must not matter)", () => {
    process.env.OPENCODE = "1";
    process.env.KILO = "1";
    const signal = detectPlatform();
    expect(signal.platform).toBe("kilo");
    expect(signal.confidence).toBe("high");
  });

  it("returns kilo when KILO_PID and OPENCODE_PID both set (PID-variant fork precedence)", () => {
    process.env.OPENCODE_PID = "12345";
    process.env.KILO_PID = "67890";
    const signal = detectPlatform();
    expect(signal.platform).toBe("kilo");
    expect(signal.confidence).toBe("high");
  });

  // Negative coverage: empty/zero KILO must NOT trigger kilo. detect.ts:159
  // uses `process.env[v]` (truthy check) — the empty string "" is falsy and
  // the assignment "0" is truthy (non-empty string), so we only assert the
  // empty-string negative path.
  it("does NOT return kilo when KILO is empty string (falls through to opencode)", () => {
    process.env.KILO = "";
    process.env.OPENCODE = "1";
    const signal = detectPlatform();
    expect(signal.platform).toBe("opencode");
    expect(signal.confidence).toBe("high");
  });

  it("does NOT return kilo when KILO is unset and only OPENCODE is set", () => {
    process.env.OPENCODE = "1";
    const signal = detectPlatform();
    expect(signal.platform).toBe("opencode");
    expect(signal.confidence).toBe("high");
  });

  // ── OpenClaw ───────────────────────────────────────────
  // Removed env-var detection: OpenClaw runtime never sets OPENCLAW_HOME or
  // OPENCLAW_CLI (verified by local repo audit). Detection now relies on
  // ~/.openclaw/ config-dir tier (tested in detect-config-dir.test.ts).

  // ── Antigravity (Google) ───────────────────────────────
  // google-gemini/gemini-cli packages/core/src/ide/detect-ide.ts checks
  // ANTIGRAVITY_CLI_ALIAS as the canonical Antigravity marker.

  it("detects antigravity via ANTIGRAVITY_CLI_ALIAS env var", () => {
    process.env.ANTIGRAVITY_CLI_ALIAS = "agtg";
    const signal = detectPlatform();
    expect(signal.platform).toBe("antigravity");
    expect(signal.confidence).toBe("high");
  });

  // ── Zed ────────────────────────────────────────────────
  // zed-industries/zed crates/terminal/src/terminal.rs sets ZED_TERM=true.
  // google-gemini/gemini-cli detect-ide.ts checks ZED_SESSION_ID first.

  it("detects zed via ZED_SESSION_ID env var", () => {
    process.env.ZED_SESSION_ID = "01HZED-uuid";
    const signal = detectPlatform();
    expect(signal.platform).toBe("zed");
    expect(signal.confidence).toBe("high");
  });

  it("detects zed via ZED_TERM env var", () => {
    process.env.ZED_TERM = "true";
    const signal = detectPlatform();
    expect(signal.platform).toBe("zed");
    expect(signal.confidence).toBe("high");
  });

  // ── Pi ─────────────────────────────────────────────────
  // Issue #542 — PI_PROJECT_DIR is consumed by src/adapters/pi/extension.ts
  // but is NOT auto-set by the Pi runtime (verified at
  // refs/platforms/oh-my-pi/packages/coding-agent/src/mcp/transports/stdio.ts:55-63
  // — env passthrough only, no synthesis). Detection markers now use the
  // Pi-exclusive PI_CONFIG_DIR / PI_SESSION_FILE / PI_COMPILED set by
  // the runtime.

  it("detects pi via PI_CONFIG_DIR env var", () => {
    process.env.PI_CONFIG_DIR = "/home/u/.pi";
    const signal = detectPlatform();
    expect(signal.platform).toBe("pi");
    expect(signal.confidence).toBe("high");
  });

  it("detects pi via PI_SESSION_FILE env var", () => {
    process.env.PI_SESSION_FILE = "/home/u/.pi/sessions/abc.json";
    const signal = detectPlatform();
    expect(signal.platform).toBe("pi");
    expect(signal.confidence).toBe("high");
  });

  it("does NOT match pi on PI_PROJECT_DIR alone (issue #542 — dead marker removed)", () => {
    // PI_PROJECT_DIR is consumed by src/adapters/pi/extension.ts but is
    // not auto-set by the Pi runtime, so it cannot be a detection signal.
    // Test guards against regressing back to the broken marker.
    process.env.PI_PROJECT_DIR = "/some/project";
    const signal = detectPlatform();
    expect(signal.platform).not.toBe("pi");
  });

  // ── OMP (Oh My Pi) ──────────────────────────────────────
  // PI_CODING_AGENT_DIR is the upstream OMP agent-dir override per
  // can1357/oh-my-pi `packages/utils/src/dirs.ts:193`. Listed BEFORE pi in
  // PLATFORM_ENV_VARS so an OMP-running harness is not misclassified as Pi
  // when both are installed.

  it("detects omp via PI_CODING_AGENT_DIR env var", () => {
    process.env.PI_CODING_AGENT_DIR = "/home/user/.omp/agent";
    const signal = detectPlatform();
    expect(signal.platform).toBe("omp");
    expect(signal.confidence).toBe("high");
  });

  it("prefers omp over pi when both PI_CODING_AGENT_DIR and PI_CONFIG_DIR are set", () => {
    process.env.PI_CODING_AGENT_DIR = "/home/user/.omp/agent";
    process.env.PI_CONFIG_DIR = "/home/u/.pi";
    const signal = detectPlatform();
    expect(signal.platform).toBe("omp");
    expect(signal.confidence).toBe("high");
  });

  // ── Codex CLI ──────────────────────────────────────────

  it("returns codex when CODEX_CI is set", () => {
    process.env.CODEX_CI = "1";
    const signal = detectPlatform();
    expect(signal.platform).toBe("codex");
    expect(signal.confidence).toBe("high");
  });

  it("returns codex when CODEX_THREAD_ID is set", () => {
    process.env.CODEX_THREAD_ID = "thread-abc";
    const signal = detectPlatform();
    expect(signal.platform).toBe("codex");
    expect(signal.confidence).toBe("high");
  });

  // ── Cursor ─────────────────────────────────────────────

  it("returns cursor when CURSOR_TRACE_ID is set", () => {
    process.env.CURSOR_TRACE_ID = "trace-abc-123";
    const signal = detectPlatform();
    expect(signal.platform).toBe("cursor");
    expect(signal.confidence).toBe("high");
  });

  it("returns cursor when CURSOR_CLI is set", () => {
    process.env.CURSOR_CLI = "1";
    const signal = detectPlatform();
    expect(signal.platform).toBe("cursor");
    expect(signal.confidence).toBe("high");
  });

  it("prefers cursor over vscode-copilot when both Cursor and VS Code env vars are set", () => {
    process.env.CURSOR_TRACE_ID = "trace-abc-123";
    process.env.VSCODE_PID = "12345";
    const signal = detectPlatform();
    expect(signal.platform).toBe("cursor");
    expect(signal.confidence).toBe("high");
  });

  // ── VS Code Copilot ────────────────────────────────────

  it("returns vscode-copilot when VSCODE_PID is set", () => {
    process.env.VSCODE_PID = "12345";
    const signal = detectPlatform();
    expect(signal.platform).toBe("vscode-copilot");
    expect(signal.confidence).toBe("high");
  });

  it("returns vscode-copilot when VSCODE_CWD is set", () => {
    process.env.VSCODE_CWD = "/some/dir";
    const signal = detectPlatform();
    expect(signal.platform).toBe("vscode-copilot");
    expect(signal.confidence).toBe("high");
  });

  // ── MCP clientInfo detection ─────────────────────────────

  it("returns antigravity when clientInfo name is antigravity-client", () => {
    const signal = detectPlatform({ name: "antigravity-client", version: "1.0" });
    expect(signal.platform).toBe("antigravity");
    expect(signal.confidence).toBe("high");
    expect(signal.reason).toContain("clientInfo");
  });

  it("returns kiro when clientInfo name is Kiro CLI", () => {
    const signal = detectPlatform({ name: "Kiro CLI", version: "1.0.0" });
    expect(signal.platform).toBe("kiro");
    expect(signal.confidence).toBe("high");
  });

  it("returns gemini-cli when clientInfo name is gemini-cli-mcp-client", () => {
    const signal = detectPlatform({ name: "gemini-cli-mcp-client", version: "1.0" });
    expect(signal.platform).toBe("gemini-cli");
    expect(signal.confidence).toBe("high");
  });

  it("returns cursor when clientInfo name is cursor-vscode", () => {
    const signal = detectPlatform({ name: "cursor-vscode", version: "1.0" });
    expect(signal.platform).toBe("cursor");
    expect(signal.confidence).toBe("high");
  });

  it("clientInfo takes priority over env vars", () => {
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    const signal = detectPlatform({ name: "antigravity-client", version: "1.0" });
    expect(signal.platform).toBe("antigravity");
  });

  it("unknown clientInfo falls through to env var detection", () => {
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    const signal = detectPlatform({ name: "some-unknown-client", version: "1.0" });
    expect(signal.platform).toBe("claude-code");
  });

  // ── CONTEXT_MODE_PLATFORM override ──────────────────────

  it("returns antigravity when CONTEXT_MODE_PLATFORM=antigravity", () => {
    process.env.CONTEXT_MODE_PLATFORM = "antigravity";
    const signal = detectPlatform();
    expect(signal.platform).toBe("antigravity");
    expect(signal.confidence).toBe("high");
    expect(signal.reason).toContain("CONTEXT_MODE_PLATFORM");
  });

  it("returns kiro when CONTEXT_MODE_PLATFORM=kiro", () => {
    process.env.CONTEXT_MODE_PLATFORM = "kiro";
    const signal = detectPlatform();
    expect(signal.platform).toBe("kiro");
    expect(signal.confidence).toBe("high");
    expect(signal.reason).toContain("CONTEXT_MODE_PLATFORM");
  });

  it("CONTEXT_MODE_PLATFORM takes priority over env vars", () => {
    process.env.CONTEXT_MODE_PLATFORM = "antigravity";
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    const signal = detectPlatform();
    expect(signal.platform).toBe("antigravity");
  });

  it("clientInfo takes priority over CONTEXT_MODE_PLATFORM", () => {
    process.env.CONTEXT_MODE_PLATFORM = "codex";
    const signal = detectPlatform({ name: "antigravity-client", version: "1.0" });
    expect(signal.platform).toBe("antigravity");
  });

  it("invalid CONTEXT_MODE_PLATFORM is ignored", () => {
    process.env.CONTEXT_MODE_PLATFORM = "not-a-platform";
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    const signal = detectPlatform();
    expect(signal.platform).toBe("claude-code");
  });

  // ── JetBrains Copilot ────────────────────────────────────

  it("detects jetbrains-copilot via IDEA_INITIAL_DIRECTORY env var", () => {
    process.env.IDEA_INITIAL_DIRECTORY = "/home/user/project";
    const signal = detectPlatform();
    expect(signal.platform).toBe("jetbrains-copilot");
    expect(signal.confidence).toBe("high");
  });

  // IDEA_HOME and JETBRAINS_CLIENT_ID were previously listed but are NOT
  // verifiable in any JetBrains source repo — removed from PLATFORM_ENV_VARS.
  // IDEA_INITIAL_DIRECTORY (set by JetBrains launcher) is the sole remaining
  // env var detection signal for jetbrains-copilot. Detection of JB IDE
  // installations also still works via ~/.config/JetBrains/ config-dir tier.

  // ── Qwen Code ──────────────────────────────────────────

  it("detects qwen-code via QWEN_PROJECT_DIR env var", () => {
    process.env.QWEN_PROJECT_DIR = "/some/project";
    const signal = detectPlatform();
    expect(signal.platform).toBe("qwen-code");
    expect(signal.confidence).toBe("high");
  });

  it("detects qwen-code via qwen-cli-mcp-client pattern in clientInfo", () => {
    const signal = detectPlatform({ name: "qwen-cli-mcp-client-context-mode" });
    expect(signal.platform).toBe("qwen-code");
    expect(signal.confidence).toBe("high");
  });

  // ── Fallback ───────────────────────────────────────────

  it("returns a valid platform as default when no env vars are set", () => {
    // No env vars set — result depends on which config dirs exist on this machine.
    const signal = detectPlatform();
    expect(["claude-code", "gemini-cli", "codex", "cursor", "opencode", "kilo", "openclaw", "vscode-copilot", "antigravity", "kiro", "pi", "omp", "zed", "qwen-code", "jetbrains-copilot"]).toContain(signal.platform);
  });
});

// ─────────────────────────────────────────────────────────
// getAdapter — returns correct adapter for each platform
// ─────────────────────────────────────────────────────────

describe("getAdapter", () => {
  it("returns ClaudeCodeAdapter for claude-code", async () => {
    const adapter = await getAdapter("claude-code");
    expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
  });

  it("returns GeminiCLIAdapter for gemini-cli", async () => {
    const adapter = await getAdapter("gemini-cli");
    expect(adapter).toBeInstanceOf(GeminiCLIAdapter);
  });

  it("returns OpenCodeAdapter for opencode", async () => {
    const adapter = await getAdapter("opencode");
    expect(adapter).toBeInstanceOf(OpenCodeAdapter);
  });

  it("returns OpenCodeAdapter for kilo", async () => {
    const adapter = await getAdapter("kilo");
    expect(adapter).toBeInstanceOf(OpenCodeAdapter);
    expect(adapter.name).toBe("KiloCode");
  });

  it("returns OpenClawAdapter for openclaw", async () => {
    const adapter = await getAdapter("openclaw");
    expect(adapter).toBeInstanceOf(OpenClawAdapter);
  });

  it("returns CodexAdapter for codex", async () => {
    const adapter = await getAdapter("codex");
    expect(adapter).toBeInstanceOf(CodexAdapter);
  });

  it("returns VSCodeCopilotAdapter for vscode-copilot", async () => {
    const adapter = await getAdapter("vscode-copilot");
    expect(adapter).toBeInstanceOf(VSCodeCopilotAdapter);
  });

  it("returns CursorAdapter for cursor", async () => {
    const adapter = await getAdapter("cursor");
    expect(adapter).toBeInstanceOf(CursorAdapter);
  });

  it("returns AntigravityAdapter for antigravity", async () => {
    const adapter = await getAdapter("antigravity");
    expect(adapter).toBeInstanceOf(AntigravityAdapter);
  });

  it("returns KiroAdapter for kiro", async () => {
    const adapter = await getAdapter("kiro");
    expect(adapter).toBeInstanceOf(KiroAdapter);
  });

  it("returns QwenCodeAdapter for qwen-code", async () => {
    const adapter = await getAdapter("qwen-code");
    expect(adapter).toBeInstanceOf(QwenCodeAdapter);
  });

  it("returns JetBrainsCopilotAdapter for jetbrains-copilot", async () => {
    const adapter = await getAdapter("jetbrains-copilot");
    expect(adapter).toBeInstanceOf(JetBrainsCopilotAdapter);
  });

  it("returns OMPAdapter for omp", async () => {
    const adapter = await getAdapter("omp");
    expect(adapter).toBeInstanceOf(OMPAdapter);
  });

  it("returns PiAdapter for pi (NOT ClaudeCodeAdapter — bug B2 fix)", async () => {
    // Before this fix, getAdapter("pi") fell through to default and
    // returned ClaudeCodeAdapter. That misrouted Pi sessions to
    // ~/.claude/context-mode/sessions/ instead of ~/.pi/.
    const adapter = await getAdapter("pi");
    expect(adapter).toBeInstanceOf(PiAdapter);
    expect(adapter).not.toBeInstanceOf(ClaudeCodeAdapter);
  });

  it("clientInfo 'Pi CLI' resolves sessionsDir to ~/.pi/ (end-to-end)", async () => {
    // Reproduces the exact server.ts:3402-3404 path:
    //   const clientInfo = server.server.getClientVersion();
    //   const signal = detectPlatform(clientInfo ?? undefined);
    //   _detectedAdapter = await getAdapter(signal.platform);
    // Pi MCP bridge sends clientInfo.name="Pi CLI" per
    // src/adapters/client-map.ts:25; the resulting sessionsDir MUST
    // live under ~/.pi, NEVER under ~/.claude.
    const signal = detectPlatform({ name: "Pi CLI", version: "0.73.0" });
    expect(signal.platform).toBe("pi");

    const adapter = await getAdapter(signal.platform);
    expect(adapter).toBeInstanceOf(PiAdapter);

    const sessionsDir = adapter.getSessionDir();
    expect(sessionsDir).toContain(".pi");
    expect(sessionsDir).not.toContain(".claude");
    expect(sessionsDir.endsWith(`${sep}.pi${sep}context-mode${sep}sessions`)).toBe(true);
  });

  it("clientInfo 'Pi Coding Agent' resolves sessionsDir to ~/.pi/", async () => {
    // Second alias from src/adapters/client-map.ts:26.
    const signal = detectPlatform({ name: "Pi Coding Agent", version: "1.0" });
    expect(signal.platform).toBe("pi");
    const adapter = await getAdapter(signal.platform);
    expect(adapter.getSessionDir()).toContain(".pi");
    expect(adapter.getSessionDir()).not.toContain(".claude");
  });

  it("clientInfo 'omp-coding-agent' resolves to omp adapter (issue #542 rebrand)", async () => {
    // refs/platforms/oh-my-pi/packages/coding-agent/src/mcp/client.ts:46-49
    // ships clientInfo.name = "omp-coding-agent" as the rebrand canonical
    // name. Verifies the high-confidence clientInfo tier short-circuits
    // before falling through to the config-dir heuristic (which is the
    // root cause of issue #542 misdetecting OMP/Pi installs as Cursor).
    const signal = detectPlatform({ name: "omp-coding-agent", version: "1.0.0" });
    expect(signal.platform).toBe("omp");
    expect(signal.confidence).toBe("high");
    expect(signal.reason).toContain("clientInfo");
    expect(signal.reason).toContain("omp-coding-agent");

    const adapter = await getAdapter(signal.platform);
    expect(adapter).toBeInstanceOf(OMPAdapter);
  });

  it("returns ClaudeCodeAdapter for unknown platform", async () => {
    const adapter = await getAdapter("unknown" as any);
    expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
  });
});

// ─────────────────────────────────────────────────────────
// Issue #545 — PLATFORM_ENV_VARS typed with workspace/identification roles.
//
// The registry must split each entry into {name, role} so resolveProjectDir
// can ALGORITHMICALLY derive ALLOW (own-platform workspace vars) and BAN
// (other platforms' workspace vars) sets. Adding a 16th adapter must require
// only one row in the registry — no edit to the resolver.
// ─────────────────────────────────────────────────────────

describe("PLATFORM_ENV_VARS — typed registry (issue #545 algorithmic design)", () => {
  it("each entry tags name + role: 'workspace' | 'identification'", async () => {
    const { PLATFORM_ENV_VARS } = await import("../../src/adapters/detect.js");
    const claudeEntries = PLATFORM_ENV_VARS.get("claude-code");
    expect(claudeEntries).toBeDefined();
    expect(claudeEntries).toContainEqual({ name: "CLAUDE_PROJECT_DIR", role: "workspace" });
    expect(claudeEntries).toContainEqual({ name: "CLAUDE_CODE_ENTRYPOINT", role: "identification" });
    expect(claudeEntries).toContainEqual({ name: "CLAUDE_PLUGIN_ROOT", role: "identification" });
    expect(claudeEntries).toContainEqual({ name: "CLAUDE_SESSION_ID", role: "identification" });
  });

  it("getEnvVarNames(p) shim returns string[] for backwards compatibility", async () => {
    const { getEnvVarNames } = await import("../../src/adapters/detect.js");
    const names = getEnvVarNames("claude-code");
    expect(Array.isArray(names)).toBe(true);
    expect(names).toContain("CLAUDE_PROJECT_DIR");
    expect(names).toContain("CLAUDE_CODE_ENTRYPOINT");
  });

  it("workspaceEnvVarsFor(p) returns only role=workspace names in registry order", async () => {
    const { workspaceEnvVarsFor } = await import("../../src/adapters/detect.js");
    const claude = workspaceEnvVarsFor("claude-code");
    expect(claude).toEqual(["CLAUDE_PROJECT_DIR"]);
    const codex = workspaceEnvVarsFor("codex");
    // Codex has no workspace var — id-only registry rows.
    expect(codex).toEqual([]);
  });

  // Slice 2 — Pi's workspace var registry. PI_WORKSPACE_DIR (extension-set,
  // freshest) before PI_PROJECT_DIR (user override) per registry-author order.
  it("workspaceEnvVarsFor('pi') returns [PI_WORKSPACE_DIR, PI_PROJECT_DIR] in cascade order", async () => {
    const { workspaceEnvVarsFor } = await import("../../src/adapters/detect.js");
    expect(workspaceEnvVarsFor("pi")).toEqual(["PI_WORKSPACE_DIR", "PI_PROJECT_DIR"]);
  });

  it("foreignWorkspaceEnv(p) returns workspace vars from OTHER platforms", async () => {
    const { foreignWorkspaceEnv } = await import("../../src/adapters/detect.js");
    const banForPi = foreignWorkspaceEnv("pi");
    // Other platforms' workspace vars must be banned for Pi.
    expect(banForPi.has("CLAUDE_PROJECT_DIR")).toBe(true);
    expect(banForPi.has("GEMINI_PROJECT_DIR")).toBe(true);
    expect(banForPi.has("VSCODE_CWD")).toBe(true);
    expect(banForPi.has("IDEA_INITIAL_DIRECTORY")).toBe(true);
    // Identification vars (e.g. CLAUDE_PLUGIN_ROOT) are NEVER scrubbed.
    expect(banForPi.has("CLAUDE_PLUGIN_ROOT")).toBe(false);
    expect(banForPi.has("CLAUDE_CODE_ENTRYPOINT")).toBe(false);
  });
});
