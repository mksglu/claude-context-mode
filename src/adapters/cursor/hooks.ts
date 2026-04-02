/**
 * adapters/cursor/hooks — Cursor hook definitions and config helpers.
 *
 * Cursor native hook config lives in `.cursor/hooks.json` or `~/.cursor/hooks.json`.
 * Unlike Claude/Gemini/VS Code Copilot, each hook entry is a flat object rather
 * than a `{ matcher, hooks: [...] }` wrapper.
 */

/** Cursor hook type names. */
export const HOOK_TYPES = {
  PRE_TOOL_USE: "preToolUse",
  POST_TOOL_USE: "postToolUse",
  SESSION_START: "sessionStart",
  STOP: "stop",
  AFTER_AGENT_RESPONSE: "afterAgentResponse",
} as const;

export type HookType = (typeof HOOK_TYPES)[keyof typeof HOOK_TYPES];

/** Map of hook types to their script file names. */
export const HOOK_SCRIPTS: Record<HookType, string> = {
  [HOOK_TYPES.PRE_TOOL_USE]: "pretooluse.mjs",
  [HOOK_TYPES.POST_TOOL_USE]: "posttooluse.mjs",
  [HOOK_TYPES.SESSION_START]: "sessionstart.mjs",
  [HOOK_TYPES.STOP]: "stop.mjs",
  [HOOK_TYPES.AFTER_AGENT_RESPONSE]: "afteragentresponse.mjs",
};

/** Canonical Cursor-native matchers for tools context-mode routes proactively. */
export const PRE_TOOL_USE_MATCHERS = [
  "Shell",
  "Read",
  "Grep",
  "WebFetch",
  "mcp_web_fetch",
  "mcp_fetch_tool",
  "Task",
  "MCP:ctx_execute",
  "MCP:ctx_execute_file",
  "MCP:ctx_batch_execute",
] as const;

export const PRE_TOOL_USE_MATCHER_PATTERN = PRE_TOOL_USE_MATCHERS.join("|");

/** Required hooks for native Cursor support. */
export const REQUIRED_HOOKS: HookType[] = [
  HOOK_TYPES.PRE_TOOL_USE,
];

/** Optional hooks that improve behavior but aren't strictly required. */
export const OPTIONAL_HOOKS: HookType[] = [HOOK_TYPES.POST_TOOL_USE];

/** Minimal native Cursor hook entry shape. */
export interface CursorHookCommandEntry {
  type?: string;
  command?: string;
  matcher?: string;
  timeout?: number;
  loop_limit?: number | null;
  failClosed?: boolean;
}

/** Check whether a native Cursor hook entry points to context-mode. */
export function isContextModeHook(
  entry: CursorHookCommandEntry | { hooks?: Array<{ command?: string }> },
  hookType: HookType,
): boolean {
  const scriptName = HOOK_SCRIPTS[hookType];
  const cliCommand = buildHookCommand(hookType);

  if ("command" in entry) {
    return entry.command?.includes(scriptName) || entry.command?.includes(cliCommand) || false;
  }

  const wrappedEntry = entry as { hooks?: Array<{ command?: string }> };
  return (
    wrappedEntry.hooks?.some((hook: { command?: string }) =>
      hook.command?.includes(scriptName) || hook.command?.includes(cliCommand),
    ) ?? false
  );
}

/** Build the CLI dispatcher command for a Cursor hook type. */
export function buildHookCommand(hookType: HookType): string {
  return `context-mode hook cursor ${hookType.toLowerCase()}`;
}
