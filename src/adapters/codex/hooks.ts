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
// External MCP routing matcher (#529)
// ─────────────────────────────────────────────────────────

/**
 * External MCP catch-all matcher for Codex CLI (#529, #547 hotfix).
 *
 * Codex CLI's hook `tool_name` payload uses `mcp__<server>__<tool>` for any
 * MCP-namespaced tool. Originally this constant used a negative lookahead
 * `mcp__(?!.*context-mode)` to exclude context-mode's own MCP tools at the
 * matcher layer. v1.0.124 shipped that pattern and Codex (Rust `regex` crate)
 * rejected the matcher at boot with "look-around not supported", breaking
 * every Codex user (#547).
 *
 * Fix: drop the lookaround. The matcher is now a charset-clean literal
 * (`[A-Za-z0-9_|]` only), satisfying Codex's `is_exact_matcher`
 * (refs/platforms/codex/codex-rs/hooks/src/events/common.rs:152) which
 * short-circuits the regex engine entirely. context-mode's own MCP tools are
 * already filtered in the hook BODY by `isExternalMcpTool()` in
 * hooks/core/routing.mjs — semantics preserved.
 */
export const EXTERNAL_MCP_MATCHER_PATTERN = "mcp__";

// ─────────────────────────────────────────────────────────
// Routing instructions
// ─────────────────────────────────────────────────────────

/**
 * Path to the routing instructions file for Codex CLI.
 * Used as fallback routing awareness alongside hook-based enforcement.
 */
export const ROUTING_INSTRUCTIONS_PATH = "configs/codex/AGENTS.md";
