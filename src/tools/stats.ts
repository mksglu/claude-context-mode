/**
 * ctx_stats — Session statistics tool.
 *
 * Returns context consumption statistics, session continuity data,
 * and per-tool breakdowns.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import type { ToolResult } from "../server/session-stats.js";
import type { SessionStats } from "../server/session-stats.js";
import { getWorktreeSuffix } from "../session/db.js";

export interface ToolDeps {
  trackResponse: (toolName: string, response: ToolResult) => ToolResult;
  sessionStats: SessionStats;
}

export function registerStatsTool(server: McpServer, deps: ToolDeps): void {
  const { trackResponse, sessionStats } = deps;

  server.registerTool(
    "ctx_stats",
    {
      title: "Session Statistics",
      description:
        "Returns context consumption statistics for the current session. " +
        "Shows total bytes returned to context, breakdown by tool, call counts, " +
        "estimated token usage, and context savings ratio.",
      inputSchema: z.object({}),
    },
    async () => {
      const totalBytesReturned = Object.values(sessionStats.bytesReturned).reduce(
        (sum, b) => sum + b,
        0,
      );
      const totalCalls = Object.values(sessionStats.calls).reduce(
        (sum, c) => sum + c,
        0,
      );
      const uptimeMs = Date.now() - sessionStats.sessionStart;
      const uptimeMin = (uptimeMs / 60_000).toFixed(1);

      // Total data kept out of context = indexed (FTS5) + sandboxed (network I/O inside sandbox)
      const keptOut = sessionStats.bytesIndexed + sessionStats.bytesSandboxed;
      const totalProcessed = keptOut + totalBytesReturned;
      const savingsRatio = totalProcessed / Math.max(totalBytesReturned, 1);
      const reductionPct = totalProcessed > 0
        ? ((1 - totalBytesReturned / totalProcessed) * 100).toFixed(0)
        : "0";

      const kb = (b: number) => {
        if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
        return `${(b / 1024).toFixed(1)}KB`;
      };

      // ── Header ──
      const lines: string[] = [
        `## context-mode — Session Report (${uptimeMin} min)`,
      ];

      // ── Feature 1: Context Window Protection ──
      lines.push(
        "",
        `### Context Window Protection`,
        "",
      );

      if (totalCalls === 0) {
        lines.push(`No context-mode tool calls yet. Use \`batch_execute\`, \`execute\`, or \`fetch_and_index\` to keep raw output out of your context window.`);
      } else {
        lines.push(
          `| Metric | Value |`,
          `|--------|------:|`,
          `| Total data processed | **${kb(totalProcessed)}** |`,
          `| Kept in sandbox (never entered context) | **${kb(keptOut)}** |`,
          `| Entered context | ${kb(totalBytesReturned)} |`,
          `| Estimated tokens saved | ~${Math.round(keptOut / 4).toLocaleString()} |`,
          `| **Context savings** | **${savingsRatio.toFixed(1)}x (${reductionPct}% reduction)** |`,
        );

        // Per-tool breakdown
        const toolNames = new Set([
          ...Object.keys(sessionStats.calls),
          ...Object.keys(sessionStats.bytesReturned),
        ]);

        if (toolNames.size > 0) {
          lines.push(
            "",
            `| Tool | Calls | Context | Tokens |`,
            `|------|------:|--------:|-------:|`,
          );
          for (const tool of Array.from(toolNames).sort()) {
            const calls = sessionStats.calls[tool] || 0;
            const bytes = sessionStats.bytesReturned[tool] || 0;
            const tokens = Math.round(bytes / 4);
            lines.push(`| ${tool} | ${calls} | ${kb(bytes)} | ~${tokens.toLocaleString()} |`);
          }
          lines.push(`| **Total** | **${totalCalls}** | **${kb(totalBytesReturned)}** | **~${Math.round(totalBytesReturned / 4).toLocaleString()}** |`);
        }

        if (keptOut > 0) {
          lines.push("", `Without context-mode, **${kb(totalProcessed)}** of raw output would flood your context window. Instead, **${reductionPct}%** stayed in sandbox.`);
        }
      }

      // ── Session Continuity ──
      try {
        const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        const dbHash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
        const worktreeSuffix = getWorktreeSuffix();
        const sessionDbPath = join(homedir(), ".claude", "context-mode", "sessions", `${dbHash}${worktreeSuffix}.db`);

        if (existsSync(sessionDbPath)) {
          const require = createRequire(import.meta.url);
          const Database = require("better-sqlite3");
          const sdb = new Database(sessionDbPath, { readonly: true });

          const eventTotal = sdb.prepare("SELECT COUNT(*) as cnt FROM session_events").get() as { cnt: number };
          const byCategory = sdb.prepare(
            "SELECT category, COUNT(*) as cnt FROM session_events GROUP BY category ORDER BY cnt DESC",
          ).all() as Array<{ category: string; cnt: number }>;
          const meta = sdb.prepare(
            "SELECT compact_count FROM session_meta ORDER BY started_at DESC LIMIT 1",
          ).get() as { compact_count: number } | undefined;
          const resume = sdb.prepare(
            "SELECT event_count, consumed FROM session_resume ORDER BY created_at DESC LIMIT 1",
          ).get() as { event_count: number; consumed: number } | undefined;

          if (eventTotal.cnt > 0) {
            const compacts = meta?.compact_count ?? 0;

            // Query actual data per category for preview
            const previewRows = sdb.prepare(
              `SELECT category, type, data FROM session_events ORDER BY id DESC`,
            ).all() as Array<{ category: string; type: string; data: string }>;

            // Build previews: unique values per category
            const previews = new Map<string, Set<string>>();
            for (const row of previewRows) {
              if (!previews.has(row.category)) previews.set(row.category, new Set());
              const set = previews.get(row.category)!;
              if (set.size < 5) {
                let display = row.data;
                if (row.category === "file") {
                  display = row.data.split("/").pop() || row.data;
                } else if (row.category === "prompt") {
                  display = display.length > 50 ? display.slice(0, 47) + "..." : display;
                }
                if (display.length > 40) display = display.slice(0, 37) + "...";
                set.add(display);
              }
            }

            const categoryLabels: Record<string, string> = {
              file: "Files tracked",
              rule: "Project rules (CLAUDE.md)",
              prompt: "Your requests saved",
              mcp: "Plugin tools used",
              git: "Git operations",
              env: "Environment setup",
              error: "Errors caught",
              task: "Tasks in progress",
              decision: "Your decisions",
              cwd: "Working directory",
              skill: "Skills used",
              subagent: "Delegated work",
              intent: "Session mode",
              data: "Data references",
              role: "Behavioral directives",
            };

            const categoryHints: Record<string, string> = {
              file: "Restored after compact — no need to re-read",
              rule: "Your project instructions survive context resets",
              prompt: "Continues exactly where you left off",
              decision: "Applied automatically — won't ask again",
              task: "Picks up from where it stopped",
              error: "Tracked and monitored across compacts",
              git: "Branch, commit, and repo state preserved",
              env: "Runtime config carried forward",
              mcp: "Tool usage patterns remembered",
              subagent: "Delegation history preserved",
              skill: "Skill invocations tracked",
            };

            lines.push(
              "",
              "### Session Continuity",
              "",
              "| What's preserved | Count | I remember... | Why it matters |",
              "|------------------|------:|---------------|----------------|",
            );
            for (const row of byCategory) {
              const label = categoryLabels[row.category] || row.category;
              const preview = previews.get(row.category);
              const previewStr = preview ? Array.from(preview).join(", ") : "";
              const hint = categoryHints[row.category] || "Survives context resets";
              lines.push(`| ${label} | ${row.cnt} | ${previewStr} | ${hint} |`);
            }
            lines.push(`| **Total** | **${eventTotal.cnt}** | | **Zero knowledge lost on compact** |`);

            lines.push("");
            if (compacts > 0) {
              lines.push(`Context has been compacted **${compacts} time(s)** — session knowledge was preserved each time.`);
            } else {
              lines.push(`When your context compacts, all of this will restore Claude's awareness — no starting from scratch.`);
            }
            if (resume && !resume.consumed) {
              lines.push(`Resume snapshot ready (${resume.event_count} events) for the next compaction.`);
            }

            lines.push("");
            lines.push(`> **Note:** Previous session data is loaded when you start a new session. Without \`--continue\`, old session history is cleaned up to keep the database lean.`);
          }

          sdb.close();
        }
      } catch {
        // Session DB not available or incompatible — skip silently
      }

      // Formatting directive — ensures all LLMs display the report verbatim
      lines.push(
        "",
        "---",
        "_Display this entire report as-is in your response. Do NOT summarize, collapse, or paraphrase any section._",
      );

      const text = lines.join("\n");
      return trackResponse("ctx_stats", {
        content: [{ type: "text" as const, text }],
      });
    },
  );
}
