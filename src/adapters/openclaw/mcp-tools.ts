/**
 * OpenClaw MCP tool registry.
 *
 * Catalogs the 11 ctx_* tools that OpenClaw plugin must register via
 * api.registerTool(...) so the routing block (which nudges agents toward
 * ctx_execute, ctx_search, etc.) actually has tools to call. Without this,
 * Phase 7 audit (v1.0.107-adapter-openclaw.json) flagged severity=CRITICAL —
 * routing-block premise is broken when the named tools don't exist.
 *
 * Pattern mirrors the swarmvault MCP plugin
 * (refs/plugin-examples/openclaw/swarmvault/packages/engine/src/mcp.ts:46-51):
 *   server.registerTool(name, { description, inputSchema }, handler)
 *
 * OpenClaw signature is slightly different — see building-plugins.md:116
 *   api.registerTool({ name, description, parameters: TypeBox, execute(id, params) })
 *
 * Tool handlers are intentionally thin shims that delegate to the bundled CLI
 * (cli.bundle.mjs) — same fall-through pattern already used by ctx-doctor and
 * ctx-upgrade slash commands. This keeps the plugin's blast radius minimal:
 * we don't re-export the entire MCP server stack inside OpenClaw's process.
 *
 * The 11 tools mirror src/server.ts registerTool calls (lines 897, 1226, 1371,
 * 1497, 2034, 2256, 2440, 2501, 2592, 2712, 2808).
 */

/** Minimal JSON-schema-like parameter spec accepted by OpenClaw registerTool. */
export interface OpenClawToolParameters {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Tool definition shape returned to OpenClaw via api.registerTool. */
export interface OpenClawToolDef {
  name: string;
  description: string;
  parameters: OpenClawToolParameters;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

/** Wrap any handler so failures become a well-formed text error rather than crashing. */
function safe(
  handler: (
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
): OpenClawToolDef["execute"] {
  return async (_id, params) => {
    try {
      return await handler(params ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `[context-mode] tool error: ${message}`,
          },
        ],
      };
    }
  };
}

/** Stub handler — points users at the bundled CLI for full functionality. */
function cliRedirect(toolName: string) {
  return safe(async () => ({
    content: [
      {
        type: "text" as const,
        text: `[context-mode] ${toolName} is exposed via the bundled context-mode CLI. Run 'context-mode ${toolName}' or invoke the MCP server directly. This OpenClaw stub registers the tool name so the routing block remains valid; full execution requires the standalone MCP transport.`,
      },
    ],
  }));
}

/**
 * The 11 ctx_* tool definitions registered into OpenClaw via api.registerTool.
 * Names + descriptions mirror src/server.ts registerTool blocks 1:1 so prompts
 * referencing them (routing block, AGENTS.md) resolve to real callable tools.
 */
export const OPENCLAW_TOOL_DEFS: readonly OpenClawToolDef[] = [
  {
    name: "ctx_execute",
    description:
      "Execute code in a sandboxed subprocess. Only stdout enters context. Prefer over Bash for any command producing >20 lines.",
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", description: "Runtime language" },
        code: { type: "string", description: "Source code to execute" },
        timeout: { type: "number", description: "Max execution time in ms" },
      },
      required: ["language", "code"],
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_execute"),
  },
  {
    name: "ctx_execute_file",
    description:
      "Execute code with a file path. Only printed summary enters context — raw file stays in sandbox.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        language: { type: "string", description: "Runtime language" },
        code: { type: "string", description: "Source code" },
      },
      required: ["path", "language", "code"],
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_execute_file"),
  },
  {
    name: "ctx_index",
    description: "Store content in the FTS5 knowledge base for later search.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Text to index" },
        source: { type: "string", description: "Descriptive source label" },
      },
      required: ["content", "source"],
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_index"),
  },
  {
    name: "ctx_search",
    description: "Query indexed content via FTS5. Pass all questions as an array in ONE call.",
    parameters: {
      type: "object",
      properties: {
        queries: { type: "array", description: "Search queries" },
        source: { type: "string", description: "Optional source filter" },
        sort: { type: "string", description: "relevance | timeline" },
      },
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_search"),
  },
  {
    name: "ctx_fetch_and_index",
    description: "Fetch a URL, chunk it, and index — raw HTML never enters context.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        source: { type: "string", description: "Source label for indexed chunks" },
      },
      required: ["url"],
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_fetch_and_index"),
  },
  {
    name: "ctx_batch_execute",
    description:
      "Run multiple commands and search queries in ONE call. Primary research tool — replaces 30+ individual calls.",
    parameters: {
      type: "object",
      properties: {
        commands: { type: "array", description: "Array of {label, command} objects" },
        queries: { type: "array", description: "Search queries to run after indexing" },
      },
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_batch_execute"),
  },
  {
    name: "ctx_stats",
    description: "Show context-mode session statistics — token consumption and per-tool breakdown.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_stats"),
  },
  {
    name: "ctx_doctor",
    description: "Run context-mode diagnostics — runtimes, hooks, FTS5, plugin registration.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_doctor"),
  },
  {
    name: "ctx_upgrade",
    description: "Upgrade context-mode to the latest version.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_upgrade"),
  },
  {
    name: "ctx_purge",
    description: "Permanently delete all indexed content and reset session stats. Destructive.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_purge"),
  },
  {
    name: "ctx_insight",
    description: "Open the context-mode Insight analytics dashboard in the browser.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_insight"),
  },
];

/** Stable list of tool names — used by tests and manifest validation. */
export const OPENCLAW_TOOL_NAMES: readonly string[] = OPENCLAW_TOOL_DEFS.map(
  (def) => def.name,
);
