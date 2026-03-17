/**
 * ctx_batch_execute — Execute multiple commands, auto-index, and search.
 *
 * One batch_execute call replaces 30+ execute calls + 10+ search calls.
 * Provide all commands to run and all queries to search — everything
 * happens in one round trip.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PolyglotExecutor } from "../executor.js";
import type { ContentStore } from "../store.js";
import type { ToolResult } from "../server/session-stats.js";
import { checkDenyPolicy } from "../server/security-wrapper.js";
import { extractSnippet } from "../server/snippet-extractor.js";
import { errorMessage } from "./tool-utils.js";
import { coerceJsonArray, coerceCommandsArray } from "../server/intent-search.js";

export interface ToolDeps {
  trackResponse: (toolName: string, response: ToolResult) => ToolResult;
  trackIndexed: (bytes: number) => void;
  getStore: () => ContentStore;
  executor: PolyglotExecutor;
}

export function registerBatchExecuteTool(server: McpServer, deps: ToolDeps): void {
  const { trackResponse, trackIndexed, getStore, executor } = deps;

  server.registerTool(
    "ctx_batch_execute",
    {
      title: "Batch Execute & Search",
      description:
        "Execute multiple commands in ONE call, auto-index all output, and search with multiple queries. " +
        "Returns search results directly \u2014 no follow-up calls needed.\n\n" +
        "THIS IS THE PRIMARY TOOL. Use this instead of multiple execute() calls.\n\n" +
        "One batch_execute call replaces 30+ execute calls + 10+ search calls.\n" +
        "Provide all commands to run and all queries to search \u2014 everything happens in one round trip.",
      inputSchema: z.object({
        commands: z
          .preprocess(
            (v) => coerceCommandsArray(v),
            z.array(
              z.object({
                label: z
                  .string()
                  .describe(
                    "Section header for this command's output (e.g., 'README', 'Package.json', 'Source Tree')",
                  ),
                command: z
                  .string()
                  .describe("Shell command to execute"),
              }),
            ).min(1),
          )
          .describe(
            "Commands to execute as a batch. Each runs sequentially, output is labeled with the section header.",
          ),
        queries: z
          .preprocess(
            (v) => coerceJsonArray(v),
            z.array(z.string()).min(1)
          )
          .describe(
            "Search queries to extract information from indexed output. Use 5-8 comprehensive queries. " +
            "Each returns top 5 matching sections with full content. " +
            "This is your ONLY chance \u2014 put ALL your questions here. No follow-up calls needed.",
          ),
        timeout: z
          .number()
          .optional()
          .default(60000)
          .describe("Max execution time in ms (default: 60s)"),
      }),
    },
    async ({ commands, queries, timeout }) => {
      // Security: check each command against deny patterns
      const tr = (tn: string, r: ToolResult) => trackResponse(tn, r);
      for (const cmd of commands) {
        const denied = checkDenyPolicy(cmd.command, "batch_execute", tr);
        if (denied) return denied;
      }

      try {
        // Execute each command individually so every command gets its own
        // smartTruncate budget (~100KB). Previously, all commands were
        // concatenated into a single script where smartTruncate (60% head +
        // 40% tail) could silently drop middle commands. (Issue #61)
        const perCommandOutputs: string[] = [];
        const startTime = Date.now();
        let timedOut = false;

        for (const cmd of commands) {
          const elapsed = Date.now() - startTime;
          const remaining = timeout - elapsed;
          if (remaining <= 0) {
            perCommandOutputs.push(
              `# ${cmd.label}\n\n(skipped \u2014 batch timeout exceeded)\n`,
            );
            timedOut = true;
            continue;
          }

          const result = await executor.execute({
            language: "shell",
            code: `${cmd.command} 2>&1`,
            timeout: remaining,
          });

          const output = result.stdout || "(no output)";
          perCommandOutputs.push(`# ${cmd.label}\n\n${output}\n`);

          if (result.timedOut) {
            timedOut = true;
            // Mark remaining commands as skipped
            const idx = commands.indexOf(cmd);
            for (let i = idx + 1; i < commands.length; i++) {
              perCommandOutputs.push(
                `# ${commands[i].label}\n\n(skipped \u2014 batch timeout exceeded)\n`,
              );
            }
            break;
          }
        }

        const stdout = perCommandOutputs.join("\n");
        const totalBytes = Buffer.byteLength(stdout);
        const totalLines = stdout.split("\n").length;

        if (timedOut && perCommandOutputs.length === 0) {
          return trackResponse("ctx_batch_execute", {
            content: [
              {
                type: "text" as const,
                text: `Batch timed out after ${timeout}ms. No output captured.`,
              },
            ],
            isError: true,
          });
        }

        // Track indexed bytes (raw data that stays in sandbox)
        trackIndexed(totalBytes);

        // Index into knowledge base — markdown heading chunking splits by # labels
        const store = getStore();
        const source = `batch:${commands
          .map((c) => c.label)
          .join(",")
          .slice(0, 80)}`;
        const indexed = store.index({ content: stdout, source });

        // Build section inventory — direct query by source_id (no FTS5 MATCH needed)
        const allSections = store.getChunksBySource(indexed.sourceId);
        const inventory: string[] = ["## Indexed Sections", ""];
        const sectionTitles: string[] = [];
        for (const s of allSections) {
          const bytes = Buffer.byteLength(s.content);
          inventory.push(`- ${s.title} (${(bytes / 1024).toFixed(1)}KB)`);
          sectionTitles.push(s.title);
        }

        // Run all search queries — 3 results each, smart snippets
        // Three-tier fallback: scoped -> boosted -> global
        const MAX_OUTPUT = 80 * 1024; // 80KB total output cap
        const queryResults: string[] = [];
        let outputSize = 0;

        for (const query of queries) {
          if (outputSize > MAX_OUTPUT) {
            queryResults.push(`## ${query}\n(output cap reached \u2014 use search(queries: ["${query}"]) for details)\n`);
            continue;
          }

          // Tier 1: scoped search with fallback (porter -> trigram -> fuzzy)
          let results = store.searchWithFallback(query, 3, source);
          let crossSource = false;

          // Tier 2: global fallback (no source filter) — warn about cross-source (Issue #61)
          if (results.length === 0) {
            results = store.searchWithFallback(query, 3);
            crossSource = results.length > 0;
          }

          queryResults.push(`## ${query}`);
          if (crossSource) {
            queryResults.push(
              `> **Note:** No results in current batch output. Showing results from previously indexed content.`,
            );
          }
          queryResults.push("");
          if (results.length > 0) {
            for (const r of results) {
              // Use larger snippet (3KB) for batch_execute to reduce tiny-fragment issue (Issue #61)
              const snippet = extractSnippet(r.content, query, 3000, r.highlighted);
              const sourceTag = crossSource ? ` _(source: ${r.source})_` : "";
              queryResults.push(`### ${r.title}${sourceTag}`);
              queryResults.push(snippet);
              queryResults.push("");
              outputSize += snippet.length + r.title.length;
            }
          } else {
            queryResults.push("No matching sections found.");
            queryResults.push("");
          }
        }

        // Get searchable terms for edge cases where follow-up is needed
        const distinctiveTerms = store.getDistinctiveTerms
          ? store.getDistinctiveTerms(indexed.sourceId)
          : [];

        const output = [
          `Executed ${commands.length} commands (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB). ` +
            `Indexed ${indexed.totalChunks} sections. Searched ${queries.length} queries.`,
          "",
          ...inventory,
          "",
          ...queryResults,
          distinctiveTerms.length > 0
            ? `\nSearchable terms for follow-up: ${distinctiveTerms.join(", ")}`
            : "",
        ].join("\n");

        return trackResponse("ctx_batch_execute", {
          content: [{ type: "text" as const, text: output }],
        });
      } catch (err: unknown) {
        const message = errorMessage(err);
        return trackResponse("ctx_batch_execute", {
          content: [
            {
              type: "text" as const,
              text: `Batch execution error: ${message}`,
            },
          ],
          isError: true,
        });
      }
    },
  );
}
