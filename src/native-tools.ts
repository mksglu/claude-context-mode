import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeToolParameters {
  type: "object";
  properties: Record<string, NativeToolProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

interface NativeToolProperty {
  type: string;
  description?: string;
  items?: NativeToolProperty | NativeToolParameters;
  properties?: Record<string, NativeToolProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface NativeToolDef {
  name: string;
  label: string;
  description: string;
  parameters: NativeToolParameters;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

type TextContent = { type: "text"; text: string };

function getPluginRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  if (here.endsWith("/build") || here.endsWith("\\build")) {
    return resolve(here, "..");
  }
  if (here.endsWith("/src") || here.endsWith("\\src")) {
    return resolve(here, "..");
  }
  return here;
}

function safe(
  handler: (
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
): NativeToolDef["execute"] {
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

function mcpTool(toolName: string) {
  return safe(async (params) => {
    const root = getPluginRoot();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "start.mjs")],
      cwd: process.cwd(),
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          return typeof entry[1] === "string";
        }),
      ),
      stderr: "ignore",
    });
    const client = new Client(
      { name: "context-mode-native-plugin", version: "1.0.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport, { timeout: 15_000 });
      const result = await client.callTool(
        { name: toolName, arguments: params },
        undefined,
        { timeout: 120_000 },
      );
      const content = Array.isArray(result.content) ? result.content : [];
      return {
        content: content.filter((item): item is TextContent => {
          return (
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            item.type === "text" &&
            "text" in item &&
            typeof item.text === "string"
          );
        }),
      };
    } finally {
      await client.close();
    }
  });
}

export const NATIVE_TOOL_DEFS: readonly NativeToolDef[] = [
  {
    name: "ctx_execute",
    label: "ctx_execute",
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
    execute: mcpTool("ctx_execute"),
  },
  {
    name: "ctx_execute_file",
    label: "ctx_execute_file",
    description:
      "Execute code with a file path. Only printed summary enters context; raw file stays in sandbox.",
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
    execute: mcpTool("ctx_execute_file"),
  },
  {
    name: "ctx_index",
    label: "ctx_index",
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
    execute: mcpTool("ctx_index"),
  },
  {
    name: "ctx_search",
    label: "ctx_search",
    description: "Query indexed content via FTS5. Pass all questions as an array in ONE call.",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          description: "Search queries",
          items: { type: "string" },
        },
        source: { type: "string", description: "Optional source filter" },
        sort: { type: "string", description: "relevance | timeline" },
      },
      additionalProperties: true,
    },
    execute: mcpTool("ctx_search"),
  },
  {
    name: "ctx_fetch_and_index",
    label: "ctx_fetch_and_index",
    description: "Fetch a URL, chunk it, and index; raw HTML never enters context.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        source: { type: "string", description: "Source label for indexed chunks" },
      },
      required: ["url"],
      additionalProperties: true,
    },
    execute: mcpTool("ctx_fetch_and_index"),
  },
  {
    name: "ctx_batch_execute",
    label: "ctx_batch_execute",
    description:
      "Run multiple commands and search queries in ONE call. Primary research tool; replaces many individual calls.",
    parameters: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          description: "Array of {label, command} objects",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              command: { type: "string" },
            },
            required: ["label", "command"],
            additionalProperties: true,
          },
        },
        queries: {
          type: "array",
          description: "Search queries to run after indexing",
          items: { type: "string" },
        },
      },
      additionalProperties: true,
    },
    execute: mcpTool("ctx_batch_execute"),
  },
  {
    name: "ctx_stats",
    label: "ctx_stats",
    description: "Show context-mode session statistics; token consumption and per-tool breakdown.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    execute: mcpTool("ctx_stats"),
  },
  {
    name: "ctx_doctor",
    label: "ctx_doctor",
    description: "Run context-mode diagnostics; runtimes, hooks, FTS5, plugin registration.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    execute: mcpTool("ctx_doctor"),
  },
  {
    name: "ctx_upgrade",
    label: "ctx_upgrade",
    description: "Upgrade context-mode to the latest version.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    execute: mcpTool("ctx_upgrade"),
  },
  {
    name: "ctx_purge",
    label: "ctx_purge",
    description: "Permanently delete all indexed content and reset session stats. Destructive.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    execute: mcpTool("ctx_purge"),
  },
  {
    name: "ctx_insight",
    label: "ctx_insight",
    description: "Open the context-mode Insight analytics dashboard in the browser.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    execute: mcpTool("ctx_insight"),
  },
];

export const NATIVE_TOOL_NAMES: readonly string[] = NATIVE_TOOL_DEFS.map(
  (def) => def.name,
);
