/**
 * ctx_index — Index content into FTS5 knowledge base.
 *
 * Accepts raw content or a file path, chunks by headings, and stores
 * in the ephemeral FTS5 database.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContentStore } from "../store.js";
import type { ToolResult } from "../server/session-stats.js";
import { errorMessage } from "./tool-utils.js";

export interface ToolDeps {
  trackResponse: (toolName: string, response: ToolResult) => ToolResult;
  trackIndexed: (bytes: number) => void;
  getStore: () => ContentStore;
}

export function registerIndexTool(server: McpServer, deps: ToolDeps): void {
  const { trackResponse, trackIndexed, getStore } = deps;

  server.registerTool(
    "ctx_index",
    {
      title: "Index Content",
      description:
        "Index documentation or knowledge content into a searchable BM25 knowledge base. " +
        "Chunks markdown by headings (keeping code blocks intact) and stores in ephemeral FTS5 database. " +
        "The full content does NOT stay in context — only a brief summary is returned.\n\n" +
        "WHEN TO USE:\n" +
        "- Documentation from Context7, Skills, or MCP tools (API docs, framework guides, code examples)\n" +
        "- API references (endpoint details, parameter specs, response schemas)\n" +
        "- MCP tools/list output (exact tool signatures and descriptions)\n" +
        "- Skill prompts and instructions that are too large for context\n" +
        "- README files, migration guides, changelog entries\n" +
        "- Any content with code examples you may need to reference precisely\n\n" +
        "After indexing, use 'search' to retrieve specific sections on-demand.\n" +
        "Do NOT use for: log files, test output, CSV, build output — use 'execute_file' for those.",
      inputSchema: z.object({
        content: z
          .string()
          .optional()
          .describe(
            "Raw text/markdown to index. Provide this OR path, not both.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "File path to read and index (content never enters context). Provide this OR content.",
          ),
        source: z
          .string()
          .optional()
          .describe(
            "Label for the indexed content (e.g., 'Context7: React useEffect', 'Skill: frontend-design')",
          ),
      }),
    },
    async ({ content, path, source }) => {
      if (!content && !path) {
        return trackResponse("ctx_index", {
          content: [
            {
              type: "text" as const,
              text: "Error: Either content or path must be provided",
            },
          ],
          isError: true,
        });
      }

      try {
        // Track the raw bytes being indexed (content or file)
        if (content) trackIndexed(Buffer.byteLength(content));
        else if (path) {
          try {
            const fs = await import("fs");
            trackIndexed(fs.readFileSync(path).byteLength);
          } catch { /* ignore — file read errors handled by store */ }
        }
        const store = getStore();
        const result = store.index({ content, path, source });

        return trackResponse("ctx_index", {
          content: [
            {
              type: "text" as const,
              text: `Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from: ${result.label}\nUse search(queries: ["..."]) to query this content. Use source: "${result.label}" to scope results.`,
            },
          ],
        });
      } catch (err: unknown) {
        const message = errorMessage(err);
        return trackResponse("ctx_index", {
          content: [
            { type: "text" as const, text: `Index error: ${message}` },
          ],
          isError: true,
        });
      }
    },
  );
}
