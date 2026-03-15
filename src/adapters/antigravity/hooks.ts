/**
 * adapters/antigravity/hooks — Antigravity hook definitions (stub).
 *
 * Antigravity (Google DeepMind's agentic IDE) does NOT support hooks.
 * It is a standalone Electron-based environment that lacks a public
 * plugin API or MCP hook infrastructure. Only MCP integration is available.
 * This module exports empty/stub constants for interface consistency
 * with other adapters.
 *
 * Config: ~/.gemini/antigravity/settings.json (JSON format)
 * MCP: full support via mcpServers in settings
 */

// ─────────────────────────────────────────────────────────
// Hook type constants (empty — no hook support)
// ─────────────────────────────────────────────────────────

/**
 * Antigravity hook types — empty object.
 * Antigravity has no hook support; only MCP integration is available.
 */
export const HOOK_TYPES = {} as const;

// ─────────────────────────────────────────────────────────
// Routing instructions
// ─────────────────────────────────────────────────────────

/**
 * Path to the routing instructions file appended to the system prompt
 * when Antigravity initializes the MCP server. This is the only integration
 * point since hooks are not supported.
 */
export const ROUTING_INSTRUCTIONS_PATH = "configs/antigravity/ANTIGRAVITY.md";
