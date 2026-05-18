/**
 * adapters/vscode-copilot/hooks — VS Code Copilot hook definitions and matchers.
 *
 * Defines the hook types, matchers, and registration format specific to
 * VS Code Copilot's hook system. This module is used by:
 *   - CLI setup/upgrade commands (to configure hooks)
 *   - Doctor command (to validate hook configuration)
 *   - Hook config generation
 *
 * VS Code Copilot hook system reference:
 *   - Hooks are registered in .github/hooks/*.json
 *   - Hook names: PreToolUse, PostToolUse, PreCompact, SessionStart (PascalCase)
 *   - CRITICAL: matchers are parsed but IGNORED (all hooks fire on all tools)
 *   - Input: JSON on stdin
 *   - Output: JSON on stdout (or empty for passthrough)
 *   - Preview status — API may change
 */

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** VS Code Copilot hook types. */
export const HOOK_TYPES = {
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  PRE_COMPACT: "PreCompact",
  SESSION_START: "SessionStart",
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
 * CLI dispatcher format (context-mode hook vscode-copilot pretooluse).
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
 * (`context-mode hook vscode-copilot <event>`) — the `pluginRoot` argument
 * is accepted for API compatibility but intentionally ignored.
 *
 * Why the dispatcher form is mandatory here (Issue #613 — Tier C contract):
 *   `.github/hooks/context-mode.json` is a **workspace-committed** file
 *   (upstream: refs/platforms/vscode-copilot/assets/prompts/skills/
 *   agent-customization/references/hooks.md line 7 — "Workspace
 *   (team-shared)"). It lands in every teammate's `git status`. Embedding
 *   `process.execPath` or any absolute pluginRoot path here:
 *     - Leaks PII (username, `C:/Users/<user>/...` paths).
 *     - Breaks cross-machine portability (fnm/nvm/volta/brew shims are
 *       per-shell-session ephemeral; the path goes stale immediately on
 *       Windows + fnm).
 *
 * Commit `f5c9d02` (2026-03-06) added an absolute-path branch when a
 * pluginRoot was passed. It solved a real PATH-availability bug on
 * Brew/nvm setups by going too far — the CLI then always passes
 * pluginRoot, so the portable form became unreachable in production
 * and every `/ctx-upgrade` baked a non-portable command into the
 * committed config. This reverts to the pre-`f5c9d02` shape.
 *
 * For users without a global install, the recovery path is the same as
 * every other CLI-dispatcher adapter (cursor, codex):
 *   `npm install -g context-mode`
 */
export function buildHookCommand(hookType: HookType, _pluginRoot?: string): string {
  const scriptName = HOOK_SCRIPTS[hookType];
  if (!scriptName) {
    throw new Error(`No script defined for hook type: ${hookType}`);
  }
  return `context-mode hook vscode-copilot ${hookType.toLowerCase()}`;
}
