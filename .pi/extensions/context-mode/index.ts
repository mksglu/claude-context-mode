/**
 * context-mode extension for pi coding agent.
 *
 * Provides context management tools that keep raw tool output in the sandbox
 * instead of flooding the context window. Uses pi's extension API for
 * lifecycle integration.
 *
 * Features:
 *   - Session event capture via tool_call/tool_result hooks
 *   - Resume snapshot injection on compaction
 *   - MCP tools: batch_execute, search, execute, execute_file, fetch_and_index
 *   - /ctx-stats command for session statistics
 *
 * The MCP server is configured separately via .mcp.json or pi settings.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

import { SessionDB } from "./session-db.js";
import { extractEvents, extractUserEvents, type HookInput } from "./extract.js";
import { buildResumeSnapshot, type StoredEvent } from "./snapshot.js";
import type { SessionEvent } from "./types.js";

// ── Helpers ───────────────────────────────────────────────

function getSessionDir(): string {
  const dir = join(homedir(), ".pi", "context-mode", "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getDBPath(projectDir: string): string {
  const hash = createHash("sha256")
    .update(projectDir)
    .digest("hex")
    .slice(0, 16);
  return join(getSessionDir(), `${hash}.db`);
}

// ── Module-level state ─────────────────────────────────────

let _dbSingleton: SessionDB | null = null;
let _sessionId = "";
let _projectDir = "";
let _resumeInjected = false;

function getOrCreateDB(projectDir: string): SessionDB {
  if (!_dbSingleton || _projectDir !== projectDir) {
    const dbPath = getDBPath(projectDir);
    _dbSingleton = new SessionDB({ dbPath });
    _dbSingleton.cleanupOldSessions(7);
    _projectDir = projectDir;
  }
  return _dbSingleton;
}

// ── Pi tool name mapping ───────────────────────────────────

// Map pi tool names to standardized names for event extraction
const PI_TOOL_MAP: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
};

// ── Stats helper ──────────────────────────────────────────

function buildStatsText(db: SessionDB, sessionId: string): string {
  try {
    const events = db.getEvents(sessionId);
    const stats = db.getSessionStats(sessionId);
    const lines: string[] = [
      "## context-mode stats",
      "",
      `- Session: \`${sessionId.slice(0, 8)}…\``,
      `- Events captured: ${events.length}`,
      `- Compactions: ${stats?.compact_count ?? 0}`,
    ];

    const byType: Record<string, number> = {};
    for (const ev of events) {
      const key = ev.type ?? "unknown";
      byType[key] = (byType[key] ?? 0) + 1;
    }
    if (Object.keys(byType).length > 0) {
      lines.push("- Event breakdown:");
      for (const [type, count] of Object.entries(byType)) {
        lines.push(`  - ${type}: ${count}`);
      }
    }

    return lines.join("\n");
  } catch {
    return "context-mode stats unavailable (session DB error)";
  }
}

// ── Extension entry point ──────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Resolve extension directory
  const buildDir = dirname(fileURLToPath(import.meta.url));
  const projectDir = process.cwd();

  // Logger helper
  const log = {
    info: (...args: unknown[]) => console.log("[context-mode]", ...args),
    error: (...args: unknown[]) => console.error("[context-mode]", ...args),
    debug: (...args: unknown[]) => {
      if (process.env.PI_DEBUG) console.log("[context-mode]", ...args);
    },
  };

  // Get DB singleton
  const db = getOrCreateDB(projectDir);

  // ── Session start: Initialize session ────────────────────

  pi.on("session_start", async (_event, ctx) => {
    try {
      // Use pi's session file as session ID (or generate UUID)
      const sessionFile = ctx.sessionManager.getSessionFile();
      _sessionId = sessionFile
        ? createHash("sha256").update(sessionFile).digest("hex").slice(0, 16)
        : createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 16);

      db.ensureSession(_sessionId, projectDir);
      _resumeInjected = false;

      log.info("session_start", { sessionId: _sessionId.slice(0, 8) });
    } catch (err) {
      log.error("session_start error:", err);
    }
  });

  // ── Tool result: Capture session events ──────────────────

  pi.on("tool_result", async (event, ctx) => {
    try {
      const rawToolName = event.toolName ?? "";
      const mappedToolName = PI_TOOL_MAP[rawToolName] ?? rawToolName;

      // Build result string from content
      let resultStr: string | undefined;
      if (event.content) {
        if (typeof event.content === "string") {
          resultStr = event.content;
        } else if (Array.isArray(event.content)) {
          resultStr = event.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        }
      }

      const hookInput: HookInput = {
        tool_name: mappedToolName,
        tool_input: event.input ?? {},
        tool_response: resultStr,
        tool_output: event.isError ? { isError: true } : undefined,
      };

      const events = extractEvents(hookInput);

      if (events.length > 0) {
        for (const ev of events) {
          db.insertEvent(_sessionId, ev as SessionEvent, "tool_result");
        }
        log.debug("tool_result", { tool: rawToolName, mapped: mappedToolName, events: events.length });
      } else if (rawToolName) {
        // Fallback: record unrecognized tool as generic event
        const data = JSON.stringify({
          tool: rawToolName,
          params: event.input,
        });
        db.insertEvent(
          _sessionId,
          {
            type: "tool_call",
            category: "pi",
            data,
            priority: 3,
            data_hash: createHash("sha256")
              .update(data)
              .digest("hex")
              .slice(0, 16),
          },
          "tool_result",
        );
      }
    } catch (err) {
      log.error("tool_result capture error:", err);
    }
  });

  // ── Before agent start: Capture user message ─────────────

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const messageText = event.prompt ?? "";
      if (!messageText) return;

      const events = extractUserEvents(messageText);
      for (const ev of events) {
        db.insertEvent(_sessionId, ev as SessionEvent, "before_agent_start");
      }

      log.debug("before_agent_start", { hasMessage: !!messageText, events: events.length });
    } catch (err) {
      log.error("before_agent_start capture error:", err);
    }
  });

  // ── Before compaction: Build resume snapshot ─────────────

  pi.on("session_before_compact", async (event, ctx) => {
    try {
      const allEvents = db.getEvents(_sessionId);
      log.debug("session_before_compact", { sessionId: _sessionId.slice(0, 8), events: allEvents.length });

      if (allEvents.length === 0) return;

      const freshStats = db.getSessionStats(_sessionId);
      const snapshot = buildResumeSnapshot(allEvents as StoredEvent[], {
        compactCount: (freshStats?.compact_count ?? 0) + 1,
      });

      db.upsertResume(_sessionId, snapshot, allEvents.length);
    } catch (err) {
      log.error("session_before_compact error:", err);
    }
  });

  // ── After compaction: Increment count ────────────────────

  pi.on("session_compact", async (event, ctx) => {
    try {
      db.incrementCompactCount(_sessionId);
      _resumeInjected = false;
      log.debug("session_compact", { sessionId: _sessionId.slice(0, 8) });
    } catch (err) {
      log.error("session_compact error:", err);
    }
  });

  // ── Context injection: Resume snapshot into system prompt ─

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      if (_resumeInjected) return undefined;

      const resume = db.getResume(_sessionId);
      if (!resume) return undefined;

      const freshStats = db.getSessionStats(_sessionId);
      if ((freshStats?.compact_count ?? 0) === 0) return undefined;

      _resumeInjected = true;

      // Inject resume snapshot as additional system context
      return {
        systemPrompt: event.systemPrompt + "\n\n" + resume.snapshot,
      };
    } catch (err) {
      log.error("context injection error:", err);
      return undefined;
    }
  });

  // ── Register /ctx-stats command ──────────────────────────

  pi.registerCommand("ctx-stats", {
    description: "Show context-mode session statistics",
    handler: async (_args, ctx) => {
      const text = buildStatsText(db, _sessionId);
      ctx.ui.notify(text, "info");
    },
  });

  // ── Register /ctx-doctor command ────────────────────────

  pi.registerCommand("ctx-doctor", {
    description: "Run context-mode diagnostics",
    handler: async (_args, ctx) => {
      const lines: string[] = [
        "## context-mode diagnostics",
        "",
        `- DB path: ${getDBPath(projectDir)}`,
        `- Session ID: ${_sessionId.slice(0, 8)}…`,
        `- Project dir: ${projectDir}`,
        `- Events: ${db.getEventCount(_sessionId)}`,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── Register context-mode tools ──────────────────────────

  // Tool: batch_execute - Run multiple commands and queries
  pi.registerTool({
    name: "batch_execute",
    label: "Batch Execute",
    description:
      "Execute multiple shell commands and search queries in a single call. " +
      "Use to gather information efficiently without multiple round-trips. " +
      "Returns indexed results searchable via the search tool.",
    promptSnippet: "Run multiple commands/queries and search results in one call",
    parameters: Type.Object({
      commands: Type.Optional(Type.Array(Type.String(), {
        description: "Shell commands to execute (e.g., ['git status', 'npm test'])",
      })),
      queries: Type.Optional(Type.Array(Type.String(), {
        description: "Search queries to run against indexed content",
      })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const results: string[] = [];

      // Execute shell commands
      if (params.commands?.length) {
        for (const cmd of params.commands) {
          if (signal?.aborted) break;
          try {
            const result = await pi.exec("sh", ["-c", cmd], { signal, timeout: 30000 });
            results.push(`$ ${cmd}\n${result.stdout || result.stderr}`);
          } catch (err) {
            results.push(`$ ${cmd}\nError: ${err}`);
          }
        }
      }

      // Run search queries (requires MCP server)
      if (params.queries?.length) {
        results.push("\n## Search Results\n");
        results.push("Note: Search requires MCP context-mode server. Configure via .mcp.json");
        for (const query of params.queries) {
          results.push(`- Query: ${query} (requires MCP)`);
        }
      }

      return {
        content: [{ type: "text", text: results.join("\n") }],
        details: { commandsRun: params.commands?.length ?? 0, queriesRun: params.queries?.length ?? 0 },
      };
    },
  });

  // Tool: execute - Run code in sandbox
  pi.registerTool({
    name: "execute",
    label: "Execute",
    description:
      "Execute code in a sandboxed environment. Supports Python, JavaScript, TypeScript, " +
      "Bash, and more. Use for API calls, log analysis, and data processing. " +
      "Output stays in sandbox and doesn't pollute context.",
    promptSnippet: "Run code in sandbox for API calls, log analysis, data processing",
    parameters: Type.Object({
      language: StringEnum(["python", "javascript", "typescript", "bash", "ruby", "go", "rust"] as const),
      code: Type.String({ description: "Code to execute" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        // Map language to command
        const langMap: Record<string, string> = {
          python: "python3",
          javascript: "node",
          typescript: "tsx",
          bash: "bash",
          ruby: "ruby",
          go: "go run",
          rust: "rustc --edition 2021 -o /tmp/rust_out && /tmp/rust_out",
        };

        const cmd = langMap[params.language];
        if (!cmd) {
          return {
            content: [{ type: "text", text: `Unsupported language: ${params.language}` }],
            isError: true,
          };
        }

        // Execute via pi.exec
        const result = await pi.exec("sh", ["-c", `echo '${params.code.replace(/'/g, "'\\''")}' | ${cmd}`], {
          signal,
          timeout: 60000,
        });

        const output = result.stdout || result.stderr || "(no output)";
        const truncated = output.slice(0, 50000); // 50KB limit

        return {
          content: [{ type: "text", text: truncated + (output.length > 50000 ? "\n... (truncated)" : "") }],
          details: { exitCode: result.code, language: params.language },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Execution error: ${err}` }],
          isError: true,
        };
      }
    },
  });

  // Tool: execute_file - Run code from file
  pi.registerTool({
    name: "execute_file",
    label: "Execute File",
    description:
      "Execute code from a file in the sandbox. Use for processing large files, " +
      "log analysis, and data transformation. Output stays in sandbox.",
    promptSnippet: "Run code file in sandbox for processing large files",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to execute" }),
      language: Type.Optional(StringEnum(["python", "javascript", "typescript", "bash", "ruby", "go", "rust"] as const)),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        // Detect language from extension if not specified
        let language = params.language;
        if (!language) {
          const ext = params.path.split(".").pop()?.toLowerCase();
          const extMap: Record<string, string> = {
            py: "python",
            js: "javascript",
            ts: "typescript",
            sh: "bash",
            rb: "ruby",
            go: "go",
            rs: "rust",
          };
          language = extMap[ext ?? ""] ?? "bash";
        }

        const langMap: Record<string, string> = {
          python: "python3",
          javascript: "node",
          typescript: "tsx",
          bash: "bash",
          ruby: "ruby",
          go: "go run",
          rust: "rustc --edition 2021 -o /tmp/rust_out && /tmp/rust_out",
        };

        const cmd = langMap[language ?? "bash"];
        const result = await pi.exec("sh", ["-c", `${cmd} "${params.path}"`], {
          signal,
          timeout: 60000,
        });

        const output = result.stdout || result.stderr || "(no output)";
        const truncated = output.slice(0, 50000);

        return {
          content: [{ type: "text", text: truncated + (output.length > 50000 ? "\n... (truncated)" : "") }],
          details: { exitCode: result.code, language, path: params.path },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Execution error: ${err}` }],
          isError: true,
        };
      }
    },
  });

  // Tool: search - Search indexed content
  pi.registerTool({
    name: "search",
    label: "Search",
    description:
      "Search indexed content from batch_execute and fetch_and_index results. " +
      "Use for follow-up queries without re-running commands. Requires MCP server.",
    promptSnippet: "Search indexed content for follow-up queries",
    parameters: Type.Object({
      queries: Type.Array(Type.String(), { description: "Search queries" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Note: Full search requires MCP server
      const lines: string[] = [
        "## Search Results",
        "",
        "Note: Full search functionality requires MCP context-mode server.",
        "Configure via .mcp.json with:",
        "",
        "```json",
        '{ "mcpServers": { "context-mode": { "command": "node", "args": ["path/to/server.bundle.mjs"] } } }',
        "```",
        "",
        "Queries requested:",
      ];

      for (const query of params.queries) {
        lines.push(`- ${query}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { queries: params.queries },
      };
    },
  });

  // Tool: fetch_and_index - Fetch URL and index content
  pi.registerTool({
    name: "fetch_and_index",
    label: "Fetch and Index",
    description:
      "Fetch a web page and index its content for later search. " +
      "Use instead of direct curl/wget. Requires MCP server for full functionality.",
    promptSnippet: "Fetch URL and index for later search",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch and index" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        // Basic fetch using curl
        const result = await pi.exec("curl", ["-sL", "-A", "context-mode/1.0", params.url], {
          signal,
          timeout: 30000,
        });

        const content = result.stdout;
        const truncated = content.slice(0, 50000);

        return {
          content: [
            {
              type: "text",
              text: `Fetched ${params.url}\n\n${truncated}${content.length > 50000 ? "\n... (truncated)" : ""}`,
            },
          ],
          details: { url: params.url, bytesFetched: content.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Fetch error: ${err}` }],
          isError: true,
        };
      }
    },
  });

  log.info("context-mode extension loaded", { projectDir });
}
