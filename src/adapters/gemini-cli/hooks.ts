import { buildNodeCommand } from "../types.js";

/**
 * adapters/gemini-cli/hooks — Gemini CLI hook definitions and matchers.
 *
 * Defines the hook types, matchers, and registration format specific to
 * Gemini CLI's hook system. This module is used by:
 *   - CLI setup/upgrade commands (to configure hooks in settings.json)
 *   - Doctor command (to validate hook configuration)
 *   - Hook config generation
 *
 * Gemini CLI hook system reference:
 *   - Hooks are registered in ~/.gemini/settings.json under "hooks" key
 *   - Each hook type maps to an array of { matcher, hooks } entries
 *   - Hook names: BeforeTool, AfterTool, PreCompress, SessionStart
 *   - Input: JSON on stdin
 *   - Output: JSON on stdout (or empty for passthrough)
 */

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** Gemini CLI hook types. */
export const HOOK_TYPES = {
  BEFORE_TOOL: "BeforeTool",
  AFTER_TOOL: "AfterTool",
  PRE_COMPRESS: "PreCompress",
  SESSION_START: "SessionStart",
} as const;

export type HookType = (typeof HOOK_TYPES)[keyof typeof HOOK_TYPES];

// ─────────────────────────────────────────────────────────
// Hook script file names
// ─────────────────────────────────────────────────────────

/** Map of hook types to their script file names. */
export const HOOK_SCRIPTS: Record<HookType, string> = {
  [HOOK_TYPES.BEFORE_TOOL]: "beforetool.mjs",
  [HOOK_TYPES.AFTER_TOOL]: "aftertool.mjs",
  [HOOK_TYPES.PRE_COMPRESS]: "precompress.mjs",
  [HOOK_TYPES.SESSION_START]: "sessionstart.mjs",
};

// ─────────────────────────────────────────────────────────
// Hook validation
// ─────────────────────────────────────────────────────────

/** Required hooks that must be configured for context-mode to function. */
export const REQUIRED_HOOKS: HookType[] = [
  HOOK_TYPES.BEFORE_TOOL,
  HOOK_TYPES.SESSION_START,
];

/** Optional hooks that enhance functionality but aren't critical. */
export const OPTIONAL_HOOKS: HookType[] = [
  HOOK_TYPES.AFTER_TOOL,
  HOOK_TYPES.PRE_COMPRESS,
];

/**
 * Check if a hook entry points to a context-mode hook script.
 * Matches both legacy format (node .../beforetool.mjs) and
 * CLI dispatcher format (context-mode hook gemini-cli beforetool).
 */
export function isContextModeHook(
  entry: { hooks?: Array<{ command?: string }> },
  hookType: HookType,
): boolean {
  const scriptName = HOOK_SCRIPTS[hookType];
  const cliCommand = buildHookCommand(hookType);
  return (
    entry.hooks?.some((h) =>
      h.command?.includes(scriptName) || h.command?.includes(cliCommand),
    ) ?? false
  );
}

/**
 * Build the hook command string for a given hook type.
 * Uses absolute node path to avoid PATH issues (homebrew, nvm, volta, etc.).
 * Falls back to CLI dispatcher if pluginRoot is not provided.
 */
export function buildHookCommand(hookType: HookType, pluginRoot?: string): string {
  const scriptName = HOOK_SCRIPTS[hookType];
  if (pluginRoot && scriptName) {
    return buildNodeCommand(`${pluginRoot}/hooks/${scriptName}`);
  }
  return `context-mode hook gemini-cli ${hookType.toLowerCase()}`;
}
