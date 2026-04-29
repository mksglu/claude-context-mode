import { buildNodeCommand } from "../types.js";

/**
 * adapters/kiro/hooks — Kiro CLI hook definitions and matchers.
 *
 * Kiro CLI hook system reference:
 *   - Hooks are in agent config files (~/.kiro/agents/<name>.json) under "hooks" key
 *   - Each hook type maps to an array of { matcher, command } entries
 *   - Hook names: preToolUse, postToolUse, agentSpawn, userPromptSubmit
 *   - Input: JSON on stdin
 *   - Output: exit codes (0=allow, 2=block) + stdout/stderr
 *
 * Source: https://kiro.dev/docs/cli/custom-agents/configuration-reference#hooks-field
 */

export const HOOK_TYPES = {
  PRE_TOOL_USE: "preToolUse",
  POST_TOOL_USE: "postToolUse",
  AGENT_SPAWN: "agentSpawn",
  USER_PROMPT_SUBMIT: "userPromptSubmit",
} as const;

export type HookType = (typeof HOOK_TYPES)[keyof typeof HOOK_TYPES];

export const HOOK_SCRIPTS: Record<string, string> = {
  [HOOK_TYPES.PRE_TOOL_USE]: "pretooluse.mjs",
  [HOOK_TYPES.POST_TOOL_USE]: "posttooluse.mjs",
};

// ─────────────────────────────────────────────────────────
// PreToolUse matchers
// ─────────────────────────────────────────────────────────

/**
 * Tools that context-mode's PreToolUse hook intercepts on Kiro.
 *
 * Kiro native tool names (from TOOL_ALIASES in routing.mjs):
 *   execute_bash → Bash, fs_read → Read, fs_write → Write
 *
 * MCP tools surface as @context-mode/ctx_* in Kiro.
 */
export const PRE_TOOL_USE_MATCHERS = [
  "execute_bash",
  "fs_read",
  "@context-mode/ctx_execute",
  "@context-mode/ctx_execute_file",
  "@context-mode/ctx_batch_execute",
] as const;

/**
 * Combined matcher pattern for Kiro hook config (pipe-separated).
 * Used by generateHookConfig and configureAllHooks.
 */
export const PRE_TOOL_USE_MATCHER_PATTERN = PRE_TOOL_USE_MATCHERS.join("|");

export const REQUIRED_HOOKS: string[] = [
  HOOK_TYPES.PRE_TOOL_USE,
];

export const OPTIONAL_HOOKS: string[] = [
  HOOK_TYPES.POST_TOOL_USE,
];

/**
 * Check if a hook entry points to a context-mode hook script.
 */
export function isContextModeHook(
  entry: { command?: string },
  hookType: string,
): boolean {
  const scriptName = HOOK_SCRIPTS[hookType];
  if (!scriptName) return false;
  return entry.command?.includes(scriptName) || entry.command?.includes("context-mode hook kiro") || false;
}

/**
 * Build the hook command string for a given hook type.
 */
export function buildHookCommand(hookType: string, pluginRoot?: string): string {
  const scriptName = HOOK_SCRIPTS[hookType];
  if (pluginRoot && scriptName) {
    return buildNodeCommand(`${pluginRoot}/hooks/kiro/${scriptName}`);
  }
  return `context-mode hook kiro ${hookType.toLowerCase()}`;
}
