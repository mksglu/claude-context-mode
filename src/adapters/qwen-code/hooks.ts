/**
 * adapters/qwen-code/hooks — Qwen Code hook definitions and matchers.
 *
 * Defines the hook types, matchers, and registration format specific to
 * Qwen Code's hook system. This module is used by:
 *   - CLI setup/upgrade commands (to configure hooks in settings.json)
 *   - Doctor command (to validate hook configuration)
 *
 * Qwen Code hook system reference:
 *   - Hooks are registered in ~/.qwen/settings.json under "hooks" key
 *   - Each hook type maps to an array of { matcher, hooks } entries
 *   - matcher: tool name pattern (empty = match all tools)
 *   - hooks: array of { type: "command", command: "..." }
 *   - Input: JSON on stdin
 *   - Output: JSON on stdout (or empty for passthrough)
 *   - Hook I/O format is identical to Claude Code (hookSpecificOutput.permissionDecision)
 */

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** Qwen Code hook types (same names as Claude Code). */
export const HOOK_TYPES = {
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  PRE_COMPACT: "PreCompact",
  SESSION_START: "SessionStart",
  USER_PROMPT_SUBMIT: "UserPromptSubmit",
} as const;

export type HookType = (typeof HOOK_TYPES)[keyof typeof HOOK_TYPES];

// ─────────────────────────────────────────────────────────
// PreToolUse matchers
// ─────────────────────────────────────────────────────────

/** Tools that context-mode's PreToolUse hook intercepts in Qwen Code. */
export const PRE_TOOL_USE_MATCHERS = [
  "run_shell_command",
  "web_fetch",
  "read_file",
  "grep_search",
  "agent",
  "mcp__context-mode__ctx_execute",
  "mcp__context-mode__ctx_execute_file",
  "mcp__context-mode__ctx_batch_execute",
] as const;

/**
 * Combined matcher pattern for settings.json (pipe-separated).
 * Used by the upgrade command when writing a single consolidated entry.
 */
export const PRE_TOOL_USE_MATCHER_PATTERN = PRE_TOOL_USE_MATCHERS.join("|");

// ─────────────────────────────────────────────────────────
// PostToolUse matchers
// ─────────────────────────────────────────────────────────

/**
 * Tools that context-mode's PostToolUse hook should fire on.
 * Only tools that extractEvents() actually handles — all others
 * produce zero events and cause false "hook error" display.
 */
export const POST_TOOL_USE_MATCHERS = [
  "run_shell_command",
  "read_file",
  "write_file",
  "edit",
  "glob",
  "grep_search",
  "todo_write",
  "agent",
  "ask_user_question",
  "mcp__",
] as const;

/**
 * Combined matcher pattern for PostToolUse in settings.json.
 */
export const POST_TOOL_USE_MATCHER_PATTERN = POST_TOOL_USE_MATCHERS.join("|");

// ─────────────────────────────────────────────────────────
// Hook script file names
// ─────────────────────────────────────────────────────────

/** Map of hook types to their script file names. */
export const HOOK_SCRIPTS: Record<HookType, string> = {
  PreToolUse: "pretooluse.mjs",
  PostToolUse: "posttooluse.mjs",
  PreCompact: "precompact.mjs",
  SessionStart: "sessionstart.mjs",
  UserPromptSubmit: "userpromptsubmit.mjs",
};

// ─────────────────────────────────────────────────────────
// Hook validation
// ─────────────────────────────────────────────────────────

/** Required hooks that must be configured for context-mode to function. */
export const REQUIRED_HOOKS: HookType[] = [
  HOOK_TYPES.PRE_TOOL_USE,
  HOOK_TYPES.SESSION_START,
];

/** Optional hooks that enhance functionality but aren't critical. */
export const OPTIONAL_HOOKS: HookType[] = [
  HOOK_TYPES.POST_TOOL_USE,
  HOOK_TYPES.PRE_COMPACT,
  HOOK_TYPES.USER_PROMPT_SUBMIT,
];

/**
 * Check if a hook entry points to a context-mode hook script.
 * Matches both legacy format (node .../pretooluse.mjs) and
 * CLI dispatcher format (context-mode hook qwen-code pretooluse).
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
  if (pluginRoot) {
    const scriptName = HOOK_SCRIPTS[hookType];
    return `node "${pluginRoot}/hooks/${scriptName}"`;
  }
  return `context-mode hook qwen-code ${hookType.toLowerCase()}`;
}

/**
 * Extract the hook script file path from a command string.
 * Returns the path if the command uses the `node "/path/to/hook.mjs"` format,
 * or null if it uses the CLI dispatcher format (which is path-independent).
 *
 * Handles both quoted and unquoted paths, and both forward/back slashes.
 */
export function extractHookScriptPath(command: string): string | null {
  // Match: node "/path/to/hooks/scriptname.mjs" or node /path/to/hooks/scriptname.mjs
  const match = command.match(/node\s+"?([^"]+\.mjs)"?/);
  return match?.[1] ?? null;
}

/**
 * Check if a hook entry is a context-mode hook (any hook type).
 * Broader than `isContextModeHook` — matches any context-mode script name
 * without requiring a specific hookType.
 */
export function isAnyContextModeHook(
  entry: { hooks?: Array<{ command?: string }> },
): boolean {
  const scriptNames = Object.values(HOOK_SCRIPTS);
  return (
    entry.hooks?.some((h) =>
      h.command != null &&
      (scriptNames.some((s) => h.command!.includes(s)) ||
        h.command.includes("context-mode hook")),
    ) ?? false
  );
}
