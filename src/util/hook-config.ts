import { parseNodeCommand, type HookAdapter } from "../adapters/types.js";

export function getCommandsFromHookEntry(entry: unknown): string[] {
  const commands: string[] = [];

  if (entry && typeof entry === "object") {
    const command = (entry as { command?: unknown }).command;
    if (typeof command === "string") commands.push(command);

    const hooks = (entry as { hooks?: unknown }).hooks;
    if (Array.isArray(hooks)) {
      for (const hook of hooks) {
        if (hook && typeof hook === "object") {
          const nestedCommand = (hook as { command?: unknown }).command;
          if (typeof nestedCommand === "string") commands.push(nestedCommand);
        }
      }
    }
  }

  return commands;
}

/**
 * Extract the hook script path from a hook command string.
 *
 * Post Algo-D2 this is a thin wrapper around `parseNodeCommand` with a
 * single legacy fallback retained for stale-entry cleanup
 * (`configureAllHooks` walks pre-v1.0.124 settings.json shapes that
 * predate `buildNodeCommand`). The legacy branches are deliberately
 * narrow:
 *
 *   1) Canonical: `"<nodePath>" "<scriptPath>.mjs"` — `parseNodeCommand`
 *      handles this; round-trips with `buildNodeCommand`.
 *   2) Legacy quoted: `node "<scriptPath>.mjs"` — emitted by claude-code
 *      pre-D3. The script segment is fully quoted, no whitespace
 *      ambiguity.
 *   3) Legacy unquoted: `node <scriptPath>.mjs` — only when the entire
 *      command is whitespace-safe (exactly two whitespace-separated
 *      tokens). The #548 wire shape — `node C:/Users/High Ground …` —
 *      contains internal whitespace so this branch refuses it. Returns
 *      `null` instead of grabbing the tail after the last whitespace.
 *
 * Anything else returns `null`, letting the doctor (Algo-D1) fall
 * through to direct `existsSync` instead of trusting the regex.
 */
export function extractHookScriptPath(command: string): string | null {
  const parsed = parseNodeCommand(command);
  if (parsed) {
    return parsed.scriptPath.endsWith(".mjs") ? parsed.scriptPath : null;
  }
  // Legacy quoted: `node "/path/with spaces/x.mjs"` (pre-D3 claude-code emit).
  const legacyQuoted = command.match(/^\s*node\s+"([^"]+\.mjs)"\s*$/);
  if (legacyQuoted) return legacyQuoted[1];
  // Legacy unquoted: `node /path/x.mjs` — refuses internal whitespace
  // by anchoring both tokens. The #548 ambiguous shape has 3+ tokens
  // (spaces in the path) and falls through to `null`.
  const legacyBare = command.match(/^\s*node\s+(\S+\.mjs)\s*$/);
  if (legacyBare) return legacyBare[1];
  return null;
}

export function getHookScriptPaths(adapter: HookAdapter, pluginRoot: string): string[] {
  const paths = new Set<string>();
  const hookConfig = adapter.generateHookConfig(pluginRoot);

  for (const entries of Object.values(hookConfig) as unknown[]) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const command of getCommandsFromHookEntry(entry)) {
        const scriptPath = extractHookScriptPath(command);
        if (scriptPath) paths.add(scriptPath);
      }
    }
  }

  return [...paths];
}
