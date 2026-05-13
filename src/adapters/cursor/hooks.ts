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

/** Map of hook types that have actual script files. */
export const HOOK_SCRIPTS: Partial<Record<HookType, string>> = {
  [HOOK_TYPES.PRE_TOOL_USE]: "pretooluse.mjs",
  [HOOK_TYPES.POST_TOOL_USE]: "posttooluse.mjs",
  [HOOK_TYPES.SESSION_START]: "sessionstart.mjs",
  [HOOK_TYPES.STOP]: "stop.mjs",
  [HOOK_TYPES.AFTER_AGENT_RESPONSE]: "afteragentresponse.mjs",
};

/**
 * Negative-lookahead matcher for external MCP tool namespaces on Cursor (#529).
 *
 * Cursor MCP wire shape: `MCP:<tool>` (verified in
 * tests/fixtures/cursor/pretooluse-mcp.json, hooks/cursor/posttooluse.mjs:19-25).
 * Context-mode's own tools surface as `MCP:ctx_<...>`. The negative lookahead
 * on the `ctx_` prefix fires for every other MCP tool whose payload would
 * otherwise flood the model's context window before PostToolUse can act.
 *
 * Routing.mjs `isExternalMcpTool` is extended to recognise the `MCP:` prefix
 * so the routing branch returns external-MCP guidance instead of passthrough.
 */
export const EXTERNAL_MCP_MATCHER_PATTERN = "MCP:(?!ctx_)";

/** Canonical Cursor-native matchers for tools context-mode routes proactively. */
// NOTE (Cursor-3, deferred): Cursor is closed-source and does not currently
// publish the exact tool name it uses for sub-agent dispatch (the analogue of
// Claude Code's "Task" tool). The "Task" matcher below is kept as a best-guess
// placeholder until probe data from a real Cursor session confirms the wire
// name. If/when that probe lands, replace or supplement this entry — do NOT
// add unverified matchers in the meantime. See Phase 7 audit
// `/tmp/v1.0.107-adapter-cursor.json` (Cursor-3) for the full deferral note.
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
  EXTERNAL_MCP_MATCHER_PATTERN,
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
    const cmd = entry.command ?? "";
    return (scriptName != null && cmd.includes(scriptName)) || cmd.includes(cliCommand);
  }

  const wrappedEntry = entry as { hooks?: Array<{ command?: string }> };
  return (
    wrappedEntry.hooks?.some((hook: { command?: string }) => {
      const cmd = hook.command ?? "";
      return (scriptName != null && cmd.includes(scriptName)) || cmd.includes(cliCommand);
    }) ?? false
  );
}

/** Build the CLI dispatcher command for a Cursor hook type. */
export function buildHookCommand(hookType: HookType): string {
  return `context-mode hook cursor ${hookType.toLowerCase()}`;
}
