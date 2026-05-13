/**
 * adapters/qwen-code/hooks — Qwen Code hook definitions.
 *
 * Qwen Code is a Gemini CLI fork (packages/core/src/tools/tool-names.ts —
 * shares native names like `run_shell_command`, `read_file`). The hook wire
 * protocol is JSON stdin / stdout, identical to Claude Code and Gemini CLI.
 *
 * Config: ~/.qwen/settings.json under "hooks" key.
 */

// ─────────────────────────────────────────────────────────
// External MCP routing matcher (#529)
// ─────────────────────────────────────────────────────────

/**
 * Negative-lookahead matcher for external MCP tool namespaces on Qwen Code (#529).
 *
 * Qwen Code MCP wire shape: `mcp__<server>__<tool>` (shared with Gemini CLI
 * upstream). Own context-mode MCP surfaces as both
 * `mcp__plugin_context-mode_context-mode__ctx_*` (Claude shim path when users
 * install via the Claude marketplace) and `mcp__context-mode__ctx_*` (Qwen
 * canonical — see hooks/core/tool-naming.mjs). The negative lookahead
 * `(?!.*context-mode)` excludes both variants from the external-MCP routing
 * branch so context-mode's own tools (already wired by the explicit entries
 * above this catch-all) are not double-routed.
 *
 * Without this matcher, large payloads from slack / telegram / gdrive / notion
 * MCPs bypass the routing nudge and flood the model's context window —
 * PostToolUse runs too late to keep the raw data out.
 */
export const EXTERNAL_MCP_MATCHER_PATTERN = "mcp__(?!.*context-mode)";
