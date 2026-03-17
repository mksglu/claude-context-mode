/**
 * ctx_upgrade — Upgrade meta-tool.
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

export function registerUpgradeTool(server: McpServer, deps: ToolDeps): void {
  const { trackResponse } = deps;

  server.registerTool(
    "ctx_upgrade",
    {
      title: "Upgrade Plugin",
      description:
        "Upgrade context-mode to the latest version. Returns a shell command to execute. " +
        "You MUST run the returned command using your shell tool (Bash, shell_execute, " +
        "run_in_terminal, etc.) and display the output as a checklist. " +
        "Tell the user to restart their session after upgrade.",
      inputSchema: z.object({}),
    },
    async () => {
      const pluginRoot = findPluginRoot(import.meta.url);
      const cliPath = existsSync(resolve(pluginRoot, "cli.bundle.mjs"))
        ? resolve(pluginRoot, "cli.bundle.mjs")
        : resolve(pluginRoot, "build/cli.js");
      const cmd = `node "${cliPath}" upgrade`;

      const text = [
        "## ctx-upgrade",
        "",
        "Run this command using your shell execution tool:",
        "",
        "```",
        cmd,
        "```",
        "",
        "After the command completes, display results as a markdown checklist:",
        "- `[x]` for success, `[ ]` for failure",
        "- Example format:",
        "  ```",
        "  ## context-mode upgrade",
        "  - [x] Pulled latest from GitHub",
        "  - [x] Built and installed v0.9.24",
        "  - [x] npm global updated",
        "  - [x] Hooks configured",
        "  - [x] Doctor: all checks PASS",
        "  ```",
        "- Tell the user to restart their session to pick up the new version.",
      ].join("\n");

      return trackResponse("ctx_upgrade", {
        content: [{ type: "text" as const, text }],
      });
    },
  );
}
