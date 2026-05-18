/**
 * adapters/jetbrains-copilot/hooks — JetBrains Copilot hook definitions and matchers.
 *
 * Defines the hook types, matchers, and registration format specific to
 * JetBrains Copilot's hook system. This module is used by:
 *   - CLI setup/upgrade commands (to configure hooks)
 *   - Doctor command (to validate hook configuration)
 *   - Hook config generation
 *
 * JetBrains Copilot hook system reference:
 *   - Hooks are registered in .github/hooks/*.json
 *   - Hook names: PreToolUse, PostToolUse, PreCompact, SessionStart (PascalCase)
 *   - Additional hooks: Stop, SubagentStart, SubagentStop
 *   - CRITICAL: matchers are parsed but IGNORED (all hooks fire on all tools)
 *   - Input: JSON on stdin
 *   - Output: JSON on stdout (or empty for passthrough)
 *   - JetBrains Copilot shares the same hook paradigm as VS Code Copilot
 */

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** JetBrains Copilot hook types. */
export const HOOK_TYPES = {
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  PRE_COMPACT: "PreCompact",
  SESSION_START: "SessionStart",
  // Additional hooks (shared with VS Code Copilot)
  STOP: "Stop",
  SUBAGENT_START: "SubagentStart",
  SUBAGENT_STOP: "SubagentStop",
} as const;

export type HookType = (typeof HOOK_TYPES)[keyof typeof HOOK_TYPES];

// ─────────────────────────────────────────────────────────
// Hook script file names
// ─────────────────────────────────────────────────────────

/** Map of hook types to their script file names. */
export const HOOK_SCRIPTS: Record<string, string> = {
  [HOOK_TYPES.PRE_TOOL_USE]: "pretooluse.mjs",
  [HOOK_TYPES.POST_TOOL_USE]: "posttooluse.mjs",
  [HOOK_TYPES.PRE_COMPACT]: "precompact.mjs",
  [HOOK_TYPES.SESSION_START]: "sessionstart.mjs",
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
];

/**
 * Check if a hook entry points to a context-mode hook script.
 * Matches both legacy format (node .../pretooluse.mjs) and
 * CLI dispatcher format (context-mode hook jetbrains-copilot pretooluse).
 */
export function isContextModeHook(
  entry: { hooks?: Array<{ command?: string }> },
  hookType: HookType,
): boolean {
  const scriptName = HOOK_SCRIPTS[hookType];
  if (!scriptName) return false;
  const cliCommand = buildHookCommand(hookType);
  return (
    entry.hooks?.some((h) =>
      h.command?.includes(scriptName) || h.command?.includes(cliCommand),
    ) ?? false
  );
}

/**
 * Build the hook command string for a given hook type.
 *
 * Always emits the CLI dispatcher form
 * (`context-mode hook jetbrains-copilot <event>`) — the `pluginRoot`
 * argument is accepted for API compatibility but intentionally ignored.
 *
 * Same Tier C contract as VS Code Copilot (Issue #613):
 * `.github/hooks/context-mode.json` is workspace-committed (team-shared
 * via git). Embedding `process.execPath` or absolute pluginRoot paths
 * leaks PII and breaks cross-machine portability. See
 * src/adapters/vscode-copilot/hooks.ts for the full archaeology.
 */
export function buildHookCommand(hookType: HookType, _pluginRoot?: string): string {
  const scriptName = HOOK_SCRIPTS[hookType];
  if (!scriptName) {
    throw new Error(`No script defined for hook type: ${hookType}`);
  }
  return `context-mode hook jetbrains-copilot ${hookType.toLowerCase()}`;
}
