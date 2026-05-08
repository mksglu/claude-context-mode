/**
 * adapters/openclaw/hooks — OpenClaw hook definitions and validators.
 *
 * Defines the hook types and validation helpers specific to OpenClaw's
 * TypeScript plugin paradigm. This module is used by:
 *   - CLI setup/upgrade commands (to configure plugin in openclaw.json)
 *   - Doctor command (to validate plugin configuration)
 *
 * OpenClaw hook system reference:
 *   - I/O: TS plugin functions via api.registerHook() and api.on()
 *   - Hook events: tool_call:before, tool_call:after, command:new, command:reset
 *   - Lifecycle: session_start, before_compaction, after_compaction, before_prompt_build, before_model_resolve
 *   - Context engine: api.registerContextEngine() with ownsCompaction
 *   - Blocking: return { block: true, blockReason } from tool_call:before
 *   - Config: openclaw.json plugins.entries, ~/.openclaw/extensions/
 */

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** OpenClaw hook event names (registered via api.registerHook). */
export const HOOK_EVENTS = {
  TOOL_CALL_BEFORE: "tool_call:before",
  TOOL_CALL_AFTER: "tool_call:after",
  COMMAND_NEW: "command:new",
  COMMAND_RESET: "command:reset",
  COMMAND_STOP: "command:stop",
} as const;

/** OpenClaw lifecycle hook names (registered via api.on). */
export const LIFECYCLE_HOOKS = {
  SESSION_START: "session_start",
  BEFORE_COMPACTION: "before_compaction",
  AFTER_COMPACTION: "after_compaction",
  BEFORE_PROMPT_BUILD: "before_prompt_build",
  BEFORE_MODEL_RESOLVE: "before_model_resolve",
  BEFORE_AGENT_START: "before_agent_start",
} as const;

export type HookEvent = (typeof HOOK_EVENTS)[keyof typeof HOOK_EVENTS];
export type LifecycleHook = (typeof LIFECYCLE_HOOKS)[keyof typeof LIFECYCLE_HOOKS];

// ─────────────────────────────────────────────────────────
// Hook validation
// ─────────────────────────────────────────────────────────

/**
 * Required hooks that must be active for context-mode to function.
 * OpenClaw registers these via api.registerHook() in the plugin entry point.
 */
export const REQUIRED_HOOKS: HookEvent[] = [
  HOOK_EVENTS.TOOL_CALL_BEFORE,
  HOOK_EVENTS.TOOL_CALL_AFTER,
];

/**
 * Optional hooks that enhance functionality but aren't critical.
 * command:new provides session cleanup; context engine handles compaction.
 */
export const OPTIONAL_HOOKS: HookEvent[] = [
  HOOK_EVENTS.COMMAND_NEW,
];

/**
 * Check if a plugin entry is the context-mode plugin.
 * OpenClaw plugins are registered by id in plugins.entries.
 */
export function isContextModePlugin(pluginId: string): boolean {
  return pluginId.includes("context-mode");
}
