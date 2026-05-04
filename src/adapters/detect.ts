/**
 * adapters/detect — Auto-detect which platform is running.
 *
 * Detection priority:
 *   1. Environment variables (high confidence)
 *   2. Config directory existence (medium confidence)
 *   3. Fallback to Claude Code (low confidence — most common)
 *
 * Verified env vars per platform (from source code audit):
 *   - Claude Code:    CLAUDE_PROJECT_DIR, CLAUDE_SESSION_ID | ~/.claude/
 *   - Gemini CLI:     GEMINI_PROJECT_DIR (hooks), GEMINI_CLI (MCP) | ~/.gemini/
 *   - KiloCode:       KILO, KILO_PID | ~/.config/kilo/
 *   - OpenCode:       OPENCODE, OPENCODE_PID | ~/.config/opencode/
 *   - OpenClaw:       OPENCLAW_HOME, OPENCLAW_CLI | ~/.openclaw/
 *   - Codex CLI:      CODEX_CI, CODEX_THREAD_ID | ~/.codex/
 *   - Cursor:         CURSOR_TRACE_ID (MCP), CURSOR_CLI (terminal) | ~/.cursor/
 *   - VS Code Copilot: VSCODE_PID, VSCODE_CWD | ~/.vscode/
 *   - JetBrains Copilot: IDEA_INITIAL_DIRECTORY, IDEA_HOME, JETBRAINS_CLIENT_ID | ~/.config/JetBrains/
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import type { PlatformId, DetectionSignal, HookAdapter } from "./types.js";
import { CLIENT_NAME_TO_PLATFORM } from "./client-map.js";

/**
 * High-confidence env vars per platform, checked in priority order.
 * Single source of truth — consumed by detectPlatform() below and by
 * tests that need to clear platform-related env vars deterministically.
 */
export const PLATFORM_ENV_VARS = [
  // Order matters: forks listed BEFORE the fork's parent so collision
  // detection works. Every entry verified against platform's own runtime
  // source code (PR #376 follow-up: full audit, May 2026 — see git blame).
  ["claude-code",        ["CLAUDE_PROJECT_DIR", "CLAUDE_SESSION_ID"]],
  // antigravity (Electron/VSCode fork) — google-gemini/gemini-cli
  // packages/core/src/ide/detect-ide.ts checks ANTIGRAVITY_CLI_ALIAS as the
  // canonical Antigravity marker. Listed before vscode-copilot.
  ["antigravity",        ["ANTIGRAVITY_CLI_ALIAS"]],
  // cursor (VSCode fork) — listed before vscode-copilot. CURSOR_TRACE_ID has
  // 800+ hits in major OSS detection libs (Vercel Next.js, Bun, Google
  // gemini-cli, Nx, CrewAI).
  ["cursor",             ["CURSOR_TRACE_ID", "CURSOR_CLI"]],
  // kilo (OpenCode fork) — Kilo-Org/kilocode packages/opencode/src/index.ts:138 + 139
  // sets `process.env.KILO = 1` + `process.env.KILO_PID = String(process.pid)`. 
  ["kilo",               ["KILO", "KILO_PID"]],
  // opencode — sst/opencode packages/opencode/src/index.ts:108-109 sets
  // OPENCODE=1 + OPENCODE_PID=<pid> on every CLI invocation.
  ["opencode",           ["OPENCODE", "OPENCODE_PID"]],
  // zed — zed-industries/zed crates/terminal/src/terminal.rs sets ZED_TERM=true
  // in `insert_zed_terminal_env()`. Google's gemini-cli uses ZED_SESSION_ID.
  ["zed",                ["ZED_SESSION_ID", "ZED_TERM"]],
  // codex — openai/codex codex-rs/core/src/exec_env.rs sets CODEX_THREAD_ID
  // per exec; unified_exec/process_manager.rs sets CODEX_CI in CI mode.
  ["codex",              ["CODEX_THREAD_ID", "CODEX_CI"]],
  // gemini-cli — GEMINI_PROJECT_DIR per google-gemini/gemini-cli
  // docs/hooks/index.md; GEMINI_CLI is the MCP-server sentinel.
  ["gemini-cli",         ["GEMINI_PROJECT_DIR", "GEMINI_CLI"]],
  // vscode-copilot — VSCODE_PID + VSCODE_CWD set by microsoft/vscode bootstrap.
  // Listed AFTER cursor and antigravity since they inherit these vars as forks.
  ["vscode-copilot",     ["VSCODE_PID", "VSCODE_CWD"]],
  // jetbrains-copilot — IDEA_INITIAL_DIRECTORY set by JetBrains launcher.
  // (IDEA_HOME and JETBRAINS_CLIENT_ID removed — no source-line evidence.)
  ["jetbrains-copilot",  ["IDEA_INITIAL_DIRECTORY"]],
  // qwen-code — QWEN_PROJECT_DIR per QwenLM/qwen-code docs/users/features/hooks.md.
  // (QWEN_SESSION_ID removed — 0 hits in qwen-code repository.)
  ["qwen-code",          ["QWEN_PROJECT_DIR"]],
  // pi — PI_PROJECT_DIR consumed by src/pi-extension.ts:154 + src/server.ts:153
  // — implies the Pi runtime sets it before invoking the extension.
  ["pi",                 ["PI_PROJECT_DIR"]],
  // openclaw — removed (runtime never sets OPENCLAW_HOME or OPENCLAW_CLI;
  // detection falls through to ~/.openclaw/ config-dir tier below).
  // kiro — not listed (no auto-set process env vars; ~/.kiro/ config-dir tier).
] as const satisfies ReadonlyArray<readonly [PlatformId, readonly string[]]>;

/**
 * Sync map from platform identifier → home-relative path segments where that
 * platform stores its config. Mirrors the `super([...])` argument passed by
 * each adapter — kept in sync as the single source of truth used when we need
 * a session dir BEFORE an adapter has been instantiated (race window between
 * MCP server start and `initialize` handshake completion).
 *
 * Returns `null` for "unknown" or any string outside the supported set so the
 * caller can decide on a safe fallback.
 */
export function getSessionDirSegments(platform: string): string[] | null {
  switch (platform) {
    case "claude-code":      return [".claude"];
    case "gemini-cli":       return [".gemini"];
    case "antigravity":      return [".gemini"];
    case "openclaw":         return [".openclaw"];
    case "codex":            return [".codex"];
    case "cursor":           return [".cursor"];
    case "vscode-copilot":   return [".vscode"];
    case "kiro":             return [".kiro"];
    case "pi":               return [".pi"];
    case "qwen-code":        return [".qwen"];
    case "kilo":             return [".config", "kilo"];
    case "opencode":         return [".config", "opencode"];
    case "zed":              return [".config", "zed"];
    case "jetbrains-copilot": return [".config", "JetBrains"];
    default:                 return null;
  }
}

/**
 * Detect the current platform by checking env vars and config dirs.
 *
 * @param clientInfo - Optional MCP clientInfo from initialize handshake.
 *   When provided, takes highest priority (zero-config detection).
 */
export function detectPlatform(clientInfo?: { name: string; version?: string }): DetectionSignal {
  // ── Highest priority: MCP clientInfo ──────────────────
  if (clientInfo?.name) {
    const platform = CLIENT_NAME_TO_PLATFORM[clientInfo.name];
    if (platform) {
      return {
        platform,
        confidence: "high",
        reason: `MCP clientInfo.name="${clientInfo.name}"`,
      };
    }
    // Qwen Code uses dynamic client names: qwen-cli-mcp-client-<serverName>
    if (clientInfo.name.startsWith("qwen-cli-mcp-client")) {
      return {
        platform: "qwen-code",
        confidence: "high",
        reason: `MCP clientInfo.name="${clientInfo.name}" (qwen-cli pattern)`,
      };
    }
  }

  // ── Explicit platform override ────────────────────────
  const platformOverride = process.env.CONTEXT_MODE_PLATFORM;
  if (platformOverride) {
    const validPlatforms: PlatformId[] = [
      "claude-code", "gemini-cli", "kilo", "opencode", "codex",
      "vscode-copilot", "jetbrains-copilot", "cursor", "antigravity", "kiro", "pi", "zed", "qwen-code",
    ];
    if (validPlatforms.includes(platformOverride as PlatformId)) {
      return {
        platform: platformOverride as PlatformId,
        confidence: "high",
        reason: `CONTEXT_MODE_PLATFORM=${platformOverride} override`,
      };
    }
  }

  // ── High confidence: environment variables ─────────────

  for (const [platform, vars] of PLATFORM_ENV_VARS) {
    if (vars.some((v) => process.env[v])) {
      return {
        platform,
        confidence: "high",
        reason: `${vars.join(" or ")} env var set`,
      };
    }
  }

  // ── Medium confidence: config directory existence ──────

  const home = homedir();

  if (existsSync(resolve(home, ".claude"))) {
    return {
      platform: "claude-code",
      confidence: "medium",
      reason: "~/.claude/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".gemini"))) {
    return {
      platform: "gemini-cli",
      confidence: "medium",
      reason: "~/.gemini/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".codex"))) {
    return {
      platform: "codex",
      confidence: "medium",
      reason: "~/.codex/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".cursor"))) {
    return {
      platform: "cursor",
      confidence: "medium",
      reason: "~/.cursor/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".kiro"))) {
    return {
      platform: "kiro",
      confidence: "medium",
      reason: "~/.kiro/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".pi"))) {
    return {
      platform: "pi",
      confidence: "medium",
      reason: "~/.pi/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".qwen"))) {
    return {
      platform: "qwen-code",
      confidence: "medium",
      reason: "~/.qwen/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".openclaw"))) {
    return {
      platform: "openclaw",
      confidence: "medium",
      reason: "~/.openclaw/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".config", "kilo"))) {
    return {
      platform: "kilo",
      confidence: "medium",
      reason: "~/.config/kilo/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".config", "JetBrains"))) {
    return {
      platform: "jetbrains-copilot",
      confidence: "medium",
      reason: "~/.config/JetBrains/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".config", "opencode"))) {
    return {
      platform: "opencode",
      confidence: "medium",
      reason: "~/.config/opencode/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".config", "zed"))) {
    return {
      platform: "zed",
      confidence: "medium",
      reason: "~/.config/zed/ directory exists",
    };
  }

  // ── Low confidence: fallback ───────────────────────────

  return {
    platform: "claude-code",
    confidence: "low",
    reason: "No platform detected, defaulting to Claude Code",
  };
}

/**
 * Get the adapter instance for a given platform.
 * Lazily imports platform-specific adapter modules.
 */
export async function getAdapter(platform?: PlatformId): Promise<HookAdapter> {
  const target = platform ?? detectPlatform().platform;

  switch (target) {
    case "claude-code": {
      const { ClaudeCodeAdapter } = await import("./claude-code/index.js");
      return new ClaudeCodeAdapter();
    }

    case "gemini-cli": {
      const { GeminiCLIAdapter } = await import("./gemini-cli/index.js");
      return new GeminiCLIAdapter();
    }

    case "kilo":
    case "opencode": {
      const { OpenCodeAdapter } = await import("./opencode/index.js");
      return new OpenCodeAdapter(target);
    }

    case "openclaw": {
      const { OpenClawAdapter } = await import("./openclaw/index.js");
      return new OpenClawAdapter();
    }

    case "codex": {
      const { CodexAdapter } = await import("./codex/index.js");
      return new CodexAdapter();
    }

    case "vscode-copilot": {
      const { VSCodeCopilotAdapter } = await import("./vscode-copilot/index.js");
      return new VSCodeCopilotAdapter();
    }

    case "jetbrains-copilot": {
      const { JetBrainsCopilotAdapter } = await import("./jetbrains-copilot/index.js");
      return new JetBrainsCopilotAdapter();
    }

    case "cursor": {
      const { CursorAdapter } = await import("./cursor/index.js");
      return new CursorAdapter();
    }

    case "antigravity": {
      const { AntigravityAdapter } = await import("./antigravity/index.js");
      return new AntigravityAdapter();
    }

    case "kiro": {
      const { KiroAdapter } = await import("./kiro/index.js");
      return new KiroAdapter();
    }

    case "zed": {
      const { ZedAdapter } = await import("./zed/index.js");
      return new ZedAdapter();
    }

    case "qwen-code": {
      const { QwenCodeAdapter } = await import("./qwen-code/index.js");
      return new QwenCodeAdapter();
    }

    default: {
      // Unsupported platform — fall back to Claude Code adapter
      // (MCP server works everywhere, hooks may not)
      const { ClaudeCodeAdapter } = await import("./claude-code/index.js");
      return new ClaudeCodeAdapter();
    }
  }
}
