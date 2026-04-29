const TOOL_PREFIXES: Record<string, (tool: string) => string> = {
  "claude-code":    (tool) => `mcp__plugin_context-mode_context-mode__${tool}`,
  "gemini-cli":     (tool) => `mcp__context-mode__${tool}`,
  "antigravity":    (tool) => `mcp__context-mode__${tool}`,
  "opencode":       (tool) => `context-mode_${tool}`,
  "kilo":           (tool) => `context-mode_${tool}`,
  "vscode-copilot": (tool) => `context-mode_${tool}`,
  "jetbrains-copilot": (tool) => `context-mode_${tool}`,
  "kiro":           (tool) => `@context-mode/${tool}`,
  "zed":            (tool) => `mcp:context-mode:${tool}`,
  "cursor":         (tool) => tool,
  "codex":          (tool) => tool,
  "openclaw":       (tool) => tool,
  "pi":             (tool) => tool,
  "qwen-code":      (tool) => `mcp__context-mode__${tool}`,
};

export function getToolName(platform: string, bareTool: string): string {
  const fn = TOOL_PREFIXES[platform] || TOOL_PREFIXES["claude-code"];
  return fn(bareTool);
}

export type ToolNamer = (bareTool: string) => string;

export function createToolNamer(platform: string): ToolNamer {
  return (bareTool: string) => getToolName(platform, bareTool);
}

export const KNOWN_PLATFORMS: string[] = Object.keys(TOOL_PREFIXES);
