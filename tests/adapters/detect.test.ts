import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { detectPlatform, getAdapter } from "../../src/adapters/detect.js";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";
import { GeminiCLIAdapter } from "../../src/adapters/gemini-cli/index.js";
import { OpenCodeAdapter } from "../../src/adapters/opencode/index.js";
import { OpenClawAdapter } from "../../src/adapters/openclaw/index.js";
import { CodexAdapter } from "../../src/adapters/codex/index.js";
import { VSCodeCopilotAdapter } from "../../src/adapters/vscode-copilot/index.js";
import { CursorAdapter } from "../../src/adapters/cursor/index.js";
import { AntigravityAdapter } from "../../src/adapters/antigravity/index.js";
import { KiroAdapter } from "../../src/adapters/kiro/index.js";

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
    delete process.env.CONTEXT_MODE_PLATFORM;
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

  it("returns kilo when KILO is set", () => {
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

  // ── OpenClaw ───────────────────────────────────────────

  it("returns openclaw when OPENCLAW_HOME is set", () => {
    process.env.OPENCLAW_HOME = "/home/user/.openclaw";
    const signal = detectPlatform();
    expect(signal.platform).toBe("openclaw");
    expect(signal.confidence).toBe("high");
  });

  it("returns openclaw when OPENCLAW_CLI is set", () => {
    process.env.OPENCLAW_CLI = "1";
    const signal = detectPlatform();
    expect(signal.platform).toBe("openclaw");
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

  // ── Fallback ───────────────────────────────────────────

  it("returns a valid platform as default when no env vars are set", () => {
    // No env vars set — result depends on which config dirs exist on this machine.
    const signal = detectPlatform();
    expect(["claude-code", "gemini-cli", "codex", "cursor", "opencode", "kilo", "openclaw", "vscode-copilot", "antigravity", "kiro", "pi", "zed"]).toContain(signal.platform);
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

  it("returns ClaudeCodeAdapter for unknown platform", async () => {
    const adapter = await getAdapter("unknown" as any);
    expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
  });
});
