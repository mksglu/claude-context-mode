/**
 * ctx_search — Search indexed content with progressive throttling.
 *
 * Pass ALL search questions as queries array in ONE call.
 * Throttles after 3 calls per 60s window, blocks after 8.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContentStore } from "../store.js";
import type { ToolResult } from "../server/session-stats.js";
import { extractSnippet } from "../server/snippet-extractor.js";
import { errorMessage } from "./tool-utils.js";
import { coerceJsonArray } from "../server/intent-search.js";

export interface ToolDeps {
  trackResponse: (toolName: string, response: ToolResult) => ToolResult;
  getStore: () => ContentStore;
}

// Track search calls per 60-second window for progressive throttling
let searchCallCount = 0;
let searchWindowStart = Date.now();
const SEARCH_WINDOW_MS = 60_000;
const SEARCH_MAX_RESULTS_AFTER = 3; // after 3 calls: 1 result per query
const SEARCH_BLOCK_AFTER = 8; // after 8 calls: refuse, demand batching

export function registerSearchTool(server: McpServer, deps: ToolDeps): void {
  const { trackResponse, getStore } = deps;

  server.registerTool(
    "ctx_search",
    {
      title: "Search Indexed Content",
      description:
        "Search indexed content. Pass ALL search questions as queries array in ONE call.\n\n" +
        "TIPS: 2-4 specific terms per query. Use 'source' to scope results.",
      inputSchema: z.object({
        queries: z
          .preprocess(
            (v) => coerceJsonArray(v),
            z.array(z.string()).optional(),
          )
          .describe("Array of search queries. Batch ALL questions in one call."),
        limit: z
          .number()
          .optional()
          .default(3)
          .describe("Results per query (default: 3)"),
        source: z
          .string()
          .optional()
          .describe("Filter to a specific indexed source (partial match)."),
      }),
    },
    async (params) => {
      try {
        const store = getStore();
        const raw = params as Record<string, unknown>;

        // Normalize: accept both query (string) and queries (array)
        const queryList: string[] = [];
        if (Array.isArray(raw.queries) && raw.queries.length > 0) {
          queryList.push(...(raw.queries as string[]));
        } else if (typeof raw.query === "string" && raw.query.length > 0) {
          queryList.push(raw.query as string);
        }

        if (queryList.length === 0) {
          return trackResponse("ctx_search", {
            content: [{ type: "text" as const, text: "Error: provide query or queries." }],
            isError: true,
          });
        }

        const { limit = 3, source } = params as { limit?: number; source?: string };

        // Progressive throttling: track calls in time window
        const now = Date.now();
        if (now - searchWindowStart > SEARCH_WINDOW_MS) {
          searchCallCount = 0;
          searchWindowStart = now;
        }
        searchCallCount++;

        // After SEARCH_BLOCK_AFTER calls: refuse
        if (searchCallCount > SEARCH_BLOCK_AFTER) {
          return trackResponse("ctx_search", {
            content: [{
              type: "text" as const,
              text: `BLOCKED: ${searchCallCount} search calls in ${Math.round((now - searchWindowStart) / 1000)}s. ` +
                "You're flooding context. STOP making individual search calls. " +
                "Use batch_execute(commands, queries) for your next research step.",
            }],
            isError: true,
          });
        }

        // Determine per-query result limit based on throttle level
        const effectiveLimit = searchCallCount > SEARCH_MAX_RESULTS_AFTER
          ? 1 // after 3 calls: only 1 result per query
          : Math.min(limit, 2); // normal: max 2

        const MAX_TOTAL = 40 * 1024; // 40KB total cap
        let totalSize = 0;
        const sections: string[] = [];

        for (const q of queryList) {
          if (totalSize > MAX_TOTAL) {
            sections.push(`## ${q}\n(output cap reached)\n`);
            continue;
          }

          const results = store.searchWithFallback(q, effectiveLimit, source);

          if (results.length === 0) {
            sections.push(`## ${q}\nNo results found.`);
            continue;
          }

          const formatted = results
            .map((r) => {
              const header = `--- [${r.source}] ---`;
              const heading = `### ${r.title}`;
              const snippet = extractSnippet(r.content, q, 1500, r.highlighted);
              return `${header}\n${heading}\n\n${snippet}`;
            })
            .join("\n\n");

          sections.push(`## ${q}\n\n${formatted}`);
          totalSize += formatted.length;
        }

        let output = sections.join("\n\n---\n\n");

        // Add throttle warning after threshold
        if (searchCallCount >= SEARCH_MAX_RESULTS_AFTER) {
          output += `\n\n\u26A0 search call #${searchCallCount}/${SEARCH_BLOCK_AFTER} in this window. ` +
            `Results limited to ${effectiveLimit}/query. ` +
            `Batch queries: search(queries: ["q1","q2","q3"]) or use batch_execute.`;
        }

        if (output.trim().length === 0) {
          const sources = store.listSources();
          const sourceList = sources.length > 0
            ? `\nIndexed sources: ${sources.map((s) => `"${s.label}" (${s.chunkCount} sections)`).join(", ")}`
            : "";
          return trackResponse("ctx_search", {
            content: [{ type: "text" as const, text: `No results found.${sourceList}` }],
          });
        }

        return trackResponse("ctx_search", {
          content: [{ type: "text" as const, text: output }],
        });
      } catch (err: unknown) {
        const message = errorMessage(err);
        return trackResponse("ctx_search", {
          content: [{ type: "text" as const, text: `Search error: ${message}` }],
          isError: true,
        });
      }
    },
  );
}
