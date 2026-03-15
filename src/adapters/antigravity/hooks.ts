/**
 * adapters/antigravity/hooks — Antigravity workflow definitions (stub).
 *
 * Antigravity does not currently expose native pre/post tool hooks.
 * context-mode integrates via:
 *   - MCP registration in ~/.gemini/antigravity/mcp_config.json
 *   - project routing instructions in GEMINI.md
 *   - a workflow file in .agent/workflows/context-mode.md
 */

export const HOOK_TYPES = {} as const;

export const ROUTING_INSTRUCTIONS_PATH = "configs/antigravity/GEMINI.md";
export const WORKFLOW_TEMPLATE_PATH = "configs/antigravity/context-mode.md";
