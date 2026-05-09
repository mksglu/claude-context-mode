import type { HookAdapter } from "../adapters/types.js";

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

export function extractHookScriptPath(command: string): string | null {
  const match = command.match(/(?:"([^"]+\.mjs)"|'([^']+\.mjs)'|(\S+\.mjs))/);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
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
