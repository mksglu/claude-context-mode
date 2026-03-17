/**
 * ctx_doctor — Diagnostics meta-tool.
 *
 * Returns a shell command for the caller to execute and display as a
 * markdown checklist. No dependencies on executor, store, or sessionStats.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findPluginRoot } from "../plugin-root.js";
import type { ToolResult } from "../server/session-stats.js";

export interface ToolDeps {
  trackResponse: (toolName: string, response: ToolResult) => ToolResult;
}

export function registerDoctorTool(server: McpServer, deps: ToolDeps): void {
  const { trackResponse } = deps;

  server.registerTool(
    "ctx_doctor",
    {
      title: "Run Diagnostics",
      description:
        "Diagnose context-mode installation. Returns a shell command to execute. " +
        "You MUST run the returned command using your shell tool (Bash, shell_execute, " +
        "run_in_terminal, etc.) and display the output as a markdown checklist.",
      inputSchema: z.object({}),
    },
    async () => {
      const pluginRoot = findPluginRoot(import.meta.url);
      const cliPath = existsSync(resolve(pluginRoot, "cli.bundle.mjs"))
        ? resolve(pluginRoot, "cli.bundle.mjs")
        : resolve(pluginRoot, "build/cli.js");
      const cmd = `node "${cliPath}" doctor`;

      const text = [
        "## ctx-doctor",
        "",
        "Run this command using your shell execution tool:",
        "",
        "```",
        cmd,
        "```",
        "",
        "After the command completes, display results as a markdown checklist:",
        "- `[x]` for PASS, `[ ]` for FAIL, `[-]` for WARN",
        "- Example format:",
        "  ```",
        "  ## context-mode doctor",
        "  - [x] Runtimes: 6/10 (javascript, typescript, python, shell, ruby, perl)",
        "  - [x] Performance: FAST (Bun)",
        "  - [x] Server test: PASS",
        "  - [x] Hooks: PASS",
        "  - [x] FTS5: PASS",
        "  - [x] npm: v0.9.23",
        "  ```",
      ].join("\n");

      return trackResponse("ctx_doctor", {
        content: [{ type: "text" as const, text }],
      });
    },
  );
}
