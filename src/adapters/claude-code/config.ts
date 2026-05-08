/**
 * adapters/claude-code/config — Thin re-exports from ClaudeCodeAdapter.
 *
 * This module exists for backward compatibility. All logic lives in the
 * adapter class (index.ts). New code should use getAdapter() from detect.ts.
 */

export { ClaudeCodeAdapter } from "./index.js";
export { HOOK_TYPES, HOOK_SCRIPTS, PRE_TOOL_USE_MATCHER_PATTERN } from "./hooks.js";
