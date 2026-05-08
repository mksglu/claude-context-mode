/**
 * adapters/codex/hooks — Codex CLI hook definitions.
 *
 * Codex CLI hooks are stable (codex_hooks Stage::Stable, default_enabled: true).
 * 5 hook events: PreToolUse, PostToolUse, SessionStart, UserPromptSubmit, Stop.
 * Same JSON stdin/stdout wire protocol as Claude Code.
 *
 * Config: ~/.codex/hooks.json (JSON format, same schema as Claude Code)
 * MCP: full support via [mcp_servers] in ~/.codex/config.toml
 *
 * Known limitations:
 *   - PreToolUse: deny works, updatedInput not yet supported (openai/codex#18491)
 *   - PostToolUse: updatedMCPToolOutput parsed but logged as unsupported
 *   - PostToolUse does not fire on failing Bash calls (upstream bug)
 */

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** Codex CLI hook types — mirrors Claude Code's 5-event model. */
export const HOOK_TYPES = {
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  SESSION_START: "SessionStart",
  USER_PROMPT_SUBMIT: "UserPromptSubmit",
  STOP: "Stop",
} as const;

// ─────────────────────────────────────────────────────────
// Routing instructions
// ─────────────────────────────────────────────────────────

/**
 * Path to the routing instructions file for Codex CLI.
 * Used as fallback routing awareness alongside hook-based enforcement.
 */
export const ROUTING_INSTRUCTIONS_PATH = "configs/codex/AGENTS.md";
