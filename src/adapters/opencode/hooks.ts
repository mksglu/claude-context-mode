/**
 * adapters/opencode/hooks — OpenCode hook definitions and validators.
 *
 * Defines the hook types and validation helpers specific to OpenCode's
 * TypeScript plugin paradigm. This module is used by:
 *   - CLI setup/upgrade commands (to configure plugin in opencode.json)
 *   - Doctor command (to validate plugin configuration)
 *
 * OpenCode hook system reference:
 *   - I/O: TS plugin functions (not JSON stdin/stdout)
 *   - Hook names: tool.execute.before, tool.execute.after, experimental.session.compacting
 *   - Arg modification: output.args mutation
 *   - Blocking: throw Error in tool.execute.before
 *   - SessionStart: broken (#14808, no hook #5409)
 *   - Config: opencode.json plugin array, .opencode/plugins/*.ts
 */

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** OpenCode hook types (TS plugin event names). */
export const HOOK_TYPES = {
  BEFORE: "tool.execute.before",
  AFTER: "tool.execute.after",
  COMPACTING: "experimental.session.compacting",
} as const;

export type HookType = (typeof HOOK_TYPES)[keyof typeof HOOK_TYPES];

// ─────────────────────────────────────────────────────────
// Hook validation
// ─────────────────────────────────────────────────────────

/**
 * Required hooks that must be active for context-mode to function.
 * OpenCode uses TS plugin paradigm — no scripts, just event hooks.
 */
export const REQUIRED_HOOKS: HookType[] = [
  HOOK_TYPES.BEFORE,
  HOOK_TYPES.AFTER,
];

/**
 * Optional hooks that enhance functionality but aren't critical.
 * experimental.session.compacting is advisory.
 */
export const OPTIONAL_HOOKS: HookType[] = [
  HOOK_TYPES.COMPACTING,
];

/**
 * Check if an OpenCode plugin entry is the context-mode plugin.
 * OpenCode plugins are registered as strings in the plugin array.
 */
export function isContextModePlugin(pluginEntry: string): boolean {
  return pluginEntry.includes("context-mode");
}
