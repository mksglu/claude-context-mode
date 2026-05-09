/**
 * adapters/codex/hooks — Codex CLI hook definitions.
 *
 * Codex CLI hooks run behind the current `hooks` feature flag surface.
 * Prefer `[features].hooks`; the legacy `[features].codex_hooks` alias is still
 * accepted in current Codex builds.
 * 6 hook events: PreToolUse, PostToolUse, PreCompact, SessionStart,
 * UserPromptSubmit, Stop. PreCompact is runtime-gated on Codex builds that emit
 * the event.
 * Same JSON stdin/stdout wire protocol as Claude Code.
 *
 * Config: $CODEX_HOME/hooks.json or ~/.codex/hooks.json.
 * MCP: full support via [mcp_servers] in $CODEX_HOME/config.toml.
 *
 * Known limitations:
 *   - PreToolUse: deny works, updatedInput not yet supported (openai/codex#18491)
 *   - PostToolUse: updatedMCPToolOutput parsed but logged as unsupported
 *   - PostToolUse does not fire on failing Bash calls (upstream bug)
 */

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** Codex CLI hook types — mirrors Claude Code's continuity events. */
export const HOOK_TYPES = {
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  PRE_COMPACT: "PreCompact",
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
