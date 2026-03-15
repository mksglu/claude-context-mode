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
 *   - Antigravity:    ANTIGRAVITY_PROJECT_DIR, ANTIGRAVITY | project .agent/ + ~/.gemini/antigravity/ (best-effort)
 *   - OpenCode:       OPENCODE, OPENCODE_PID | ~/.config/opencode/
 *   - Codex CLI:      CODEX_CI, CODEX_THREAD_ID | ~/.codex/
 *   - Cursor:         CURSOR_TRACE_ID (MCP), CURSOR_CLI (terminal) | ~/.cursor/
 *   - VS Code Copilot: VSCODE_PID, VSCODE_CWD | ~/.vscode/
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import type { PlatformId, DetectionSignal, HookAdapter } from "./types.js";

function getAntigravityHome(): string {
  return process.env.ANTIGRAVITY_HOME
    ?? process.env.HOME
    ?? process.env.USERPROFILE
    ?? homedir();
}

/**
 * Detect the current platform by checking env vars and config dirs.
 */
export function detectPlatform(): DetectionSignal {
  // ── High confidence: environment variables ─────────────

  if (process.env.CLAUDE_PROJECT_DIR || process.env.CLAUDE_SESSION_ID) {
    return {
      platform: "claude-code",
      confidence: "high",
      reason: "CLAUDE_PROJECT_DIR or CLAUDE_SESSION_ID env var set",
    };
  }

  if (process.env.GEMINI_PROJECT_DIR || process.env.GEMINI_CLI) {
    return {
      platform: "gemini-cli",
      confidence: "high",
      reason: "GEMINI_PROJECT_DIR or GEMINI_CLI env var set",
    };
  }

  if (process.env.ANTIGRAVITY_PROJECT_DIR || process.env.ANTIGRAVITY) {
    return {
      platform: "antigravity",
      confidence: "high",
      reason: "ANTIGRAVITY_PROJECT_DIR or ANTIGRAVITY env var set",
    };
  }

  if (process.env.OPENCODE || process.env.OPENCODE_PID) {
    return {
      platform: "opencode",
      confidence: "high",
      reason: "OPENCODE or OPENCODE_PID env var set",
    };
  }

  if (process.env.CODEX_CI || process.env.CODEX_THREAD_ID) {
    return {
      platform: "codex",
      confidence: "high",
      reason: "CODEX_CI or CODEX_THREAD_ID env var set",
    };
  }

  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_CLI) {
    return {
      platform: "cursor",
      confidence: "high",
      reason: "CURSOR_TRACE_ID or CURSOR_CLI env var set",
    };
  }

  if (process.env.VSCODE_PID || process.env.VSCODE_CWD) {
    return {
      platform: "vscode-copilot",
      confidence: "high",
      reason: "VSCODE_PID or VSCODE_CWD env var set",
    };
  }

  // ── Medium confidence: config directory existence ──────

  const home = homedir();
  const antigravityHome = getAntigravityHome();

  if (existsSync(resolve(home, ".claude"))) {
    return {
      platform: "claude-code",
      confidence: "medium",
      reason: "~/.claude/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".gemini"))) {
    if (
      existsSync(resolve(antigravityHome, ".gemini", "antigravity")) &&
      existsSync(resolve(process.cwd(), ".agent"))
    ) {
      return {
        platform: "antigravity",
        confidence: "medium",
        reason: "~/.gemini/antigravity/ and project .agent/ directory exist",
      };
    }

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

  if (existsSync(resolve(home, ".config", "opencode"))) {
    return {
      platform: "opencode",
      confidence: "medium",
      reason: "~/.config/opencode/ directory exists",
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

    case "antigravity": {
      const { AntigravityAdapter } = await import("./antigravity/index.js");
      return new AntigravityAdapter();
    }

    case "opencode": {
      const { OpenCodeAdapter } = await import("./opencode/index.js");
      return new OpenCodeAdapter();
    }

    case "codex": {
      const { CodexAdapter } = await import("./codex/index.js");
      return new CodexAdapter();
    }

    case "vscode-copilot": {
      const { VSCodeCopilotAdapter } = await import("./vscode-copilot/index.js");
      return new VSCodeCopilotAdapter();
    }

    case "cursor": {
      const { CursorAdapter } = await import("./cursor/index.js");
      return new CursorAdapter();
    }

    default: {
      // Unsupported platform — fall back to Claude Code adapter
      // (MCP server works everywhere, hooks may not)
      const { ClaudeCodeAdapter } = await import("./claude-code/index.js");
      return new ClaudeCodeAdapter();
    }
  }
}
