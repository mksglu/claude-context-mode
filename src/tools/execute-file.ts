/**
 * ctx_execute_file — Read a file and process it in a sandboxed subprocess.
 *
 * The file is read into a FILE_CONTENT variable inside the sandbox.
 * Only the printed summary enters context.
 * Supports intent-driven search for large outputs.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PolyglotExecutor } from "../executor.js";
import type { ContentStore } from "../store.js";
import type { ToolResult } from "../server/session-stats.js";
import {
  checkDenyPolicy,
  checkNonShellDenyPolicy,
  checkFilePathDenyPolicy,
} from "../server/security-wrapper.js";
import { intentSearch, INTENT_SEARCH_THRESHOLD } from "../server/intent-search.js";
import { classifyNonZeroExit } from "../exit-classify.js";
import { errorMessage } from "./tool-utils.js";

export interface ToolDeps {
  trackResponse: (toolName: string, response: ToolResult) => ToolResult;
  trackIndexed: (bytes: number) => void;
  getStore: () => ContentStore;
  executor: PolyglotExecutor;
}

export function registerExecuteFileTool(server: McpServer, deps: ToolDeps): void {
  const { trackResponse, trackIndexed, getStore, executor } = deps;

  server.registerTool(
    "ctx_execute_file",
    {
      title: "Execute File Processing",
      description:
        "Read a file and process it without loading contents into context. The file is read into a FILE_CONTENT variable inside the sandbox. Only your printed summary enters context.\n\nPREFER THIS OVER Read/cat for: log files, data files (CSV, JSON, XML), large source files for analysis, and any file where you need to extract specific information rather than read the entire content.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute file path or relative to project root"),
        language: z
          .enum([
            "javascript",
            "typescript",
            "python",
            "shell",
            "ruby",
            "go",
            "rust",
            "php",
            "perl",
            "r",
            "elixir",
          ])
          .describe("Runtime language"),
        code: z
          .string()
          .describe(
            "Code to process FILE_CONTENT (file_content in Elixir). Print summary via console.log/print/echo/IO.puts.",
          ),
        timeout: z
          .number()
          .optional()
          .default(30000)
          .describe("Max execution time in ms"),
        intent: z
          .string()
          .optional()
          .describe(
            "What you're looking for in the output. When provided and output is large (>5KB), " +
            "returns only matching sections via BM25 search instead of truncated output.",
          ),
      }),
    },
    async ({ path, language, code, timeout, intent }) => {
      // Security: check file path against Read deny patterns
      const tr = (tn: string, r: ToolResult) => trackResponse(tn, r);
      const pathDenied = checkFilePathDenyPolicy(path, "execute_file", tr);
      if (pathDenied) return pathDenied;

      // Security: check code parameter against Bash deny patterns
      if (language === "shell") {
        const codeDenied = checkDenyPolicy(code, "execute_file", tr);
        if (codeDenied) return codeDenied;
      } else {
        const codeDenied = checkNonShellDenyPolicy(code, language, "execute_file", tr);
        if (codeDenied) return codeDenied;
      }

      try {
        const result = await executor.executeFile({
          path,
          language,
          code,
          timeout,
        });

        if (result.timedOut) {
          return trackResponse("ctx_execute_file", {
            content: [
              {
                type: "text" as const,
                text: `Timed out processing ${path} after ${timeout}ms`,
              },
            ],
            isError: true,
          });
        }

        if (result.exitCode !== 0) {
          const { isError, output } = classifyNonZeroExit({
            language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
          });
          if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
            trackIndexed(Buffer.byteLength(output));
            return trackResponse("ctx_execute_file", {
              content: [
                { type: "text" as const, text: intentSearch(output, intent, isError ? `file:${path}:error` : `file:${path}`, getStore, trackIndexed) },
              ],
              isError,
            });
          }
          return trackResponse("ctx_execute_file", {
            content: [
              { type: "text" as const, text: output },
            ],
            isError,
          });
        }

        const stdout = result.stdout || "(no output)";

        if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
          trackIndexed(Buffer.byteLength(stdout));
          return trackResponse("ctx_execute_file", {
            content: [
              { type: "text" as const, text: intentSearch(stdout, intent, `file:${path}`, getStore, trackIndexed) },
            ],
          });
        }

        return trackResponse("ctx_execute_file", {
          content: [
            { type: "text" as const, text: stdout },
          ],
        });
      } catch (err: unknown) {
        const message = errorMessage(err);
        return trackResponse("ctx_execute_file", {
          content: [
            { type: "text" as const, text: `Runtime error: ${message}` },
          ],
          isError: true,
        });
      }
    },
  );
}
