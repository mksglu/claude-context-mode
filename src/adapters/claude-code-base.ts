/**
 * adapters/claude-code-base — Shared base for Claude Code wire-protocol adapters.
 *
 * Claude Code and Qwen Code use the identical JSON stdin/stdout hook protocol:
 *   - Input fields: tool_name, tool_input, tool_output, is_error, session_id,
 *     transcript_path, source
 *   - Blocking: `permissionDecision: "deny"` in response
 *   - Arg modification: `updatedInput` field in response
 *   - Output modification: `updatedMCPToolOutput` field in response
 *   - Context injection: `additionalContext` at response root (not wrapped)
 *   - PreCompact/SessionStart: stdout on exit 0
 *
 * This base class implements the 8 shared parse/format methods.
 * Subclasses provide platform-specific config (env vars, settings path,
 * session ID priority, hook config, diagnostics, upgrade).
 */

import { BaseAdapter } from "./base.js";

import type {
  PreToolUseEvent,
  PostToolUseEvent,
  PreCompactEvent,
  SessionStartEvent,
  PreToolUseResponse,
  PostToolUseResponse,
  PreCompactResponse,
  SessionStartResponse,
} from "./types.js";

// ─────────────────────────────────────────────────────────
// Shared raw input type for Claude Code wire protocol
// ─────────────────────────────────────────────────────────

export interface ClaudeCodeWireInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  is_error?: boolean;
  session_id?: string;
  transcript_path?: string;
  source?: string;
}

// ─────────────────────────────────────────────────────────
// Base adapter for Claude Code wire protocol
// ─────────────────────────────────────────────────────────

export abstract class ClaudeCodeBaseAdapter extends BaseAdapter {
  /**
   * Environment variable name for the project directory.
   * Claude Code: "CLAUDE_PROJECT_DIR", Qwen Code: "QWEN_PROJECT_DIR"
   */
  protected abstract readonly projectDirEnvVar: string;

  // ── Input parsing (shared wire format) ─────────────────

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as ClaudeCodeWireInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: process.env[this.projectDirEnvVar] ?? process.cwd(),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as ClaudeCodeWireInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      toolOutput: input.tool_output,
      isError: input.is_error,
      sessionId: this.extractSessionId(input),
      projectDir: process.env[this.projectDirEnvVar] ?? process.cwd(),
      raw,
    };
  }

  parsePreCompactInput(raw: unknown): PreCompactEvent {
    const input = raw as ClaudeCodeWireInput;
    return {
      sessionId: this.extractSessionId(input),
      projectDir: process.env[this.projectDirEnvVar] ?? process.cwd(),
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as ClaudeCodeWireInput;
    const rawSource = input.source ?? "startup";

    let source: SessionStartEvent["source"];
    switch (rawSource) {
      case "compact":
        source = "compact";
        break;
      case "resume":
        source = "resume";
        break;
      case "clear":
        source = "clear";
        break;
      default:
        source = "startup";
    }

    return {
      sessionId: this.extractSessionId(input),
      source,
      projectDir: process.env[this.projectDirEnvVar] ?? process.cwd(),
      raw,
    };
  }

  // ── Response formatting (shared wire format) ───────────

  formatPreToolUseResponse(response: PreToolUseResponse): unknown {
    if (response.decision === "deny") {
      return {
        permissionDecision: "deny",
        reason: response.reason ?? "Blocked by context-mode hook",
      };
    }
    if (response.decision === "modify" && response.updatedInput) {
      return { updatedInput: response.updatedInput };
    }
    if (response.decision === "context" && response.additionalContext) {
      return { additionalContext: response.additionalContext };
    }
    if (response.decision === "ask") {
      return { permissionDecision: "ask" };
    }
    // "allow" — return undefined for passthrough
    return undefined;
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    const result: Record<string, unknown> = {};
    if (response.additionalContext) {
      result.additionalContext = response.additionalContext;
    }
    if (response.updatedOutput) {
      result.updatedMCPToolOutput = response.updatedOutput;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  formatPreCompactResponse(response: PreCompactResponse): unknown {
    return response.context ?? "";
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    return response.context ?? "";
  }

  // ── Session ID extraction (overridable) ────────────────

  /**
   * Extract session ID from wire input. Default priority (Claude Code):
   *   transcript_path UUID > session_id > env var > ppid fallback
   *
   * Override in subclasses for different priority (e.g., Qwen: session_id first).
   */
  protected abstract extractSessionId(input: ClaudeCodeWireInput): string;
}
