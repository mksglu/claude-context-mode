/**
 * Pi coding agent extension for context-mode.
 *
 * Follows the OpenClaw adapter pattern: imports shared session modules,
 * registers Pi-specific hooks. NO copy-paste of session logic.
 * NO external npm dependencies beyond what Pi runtime provides.
 *
 * Entry point: `export default function(pi: ExtensionAPI) { ... }`
 *
 * Lifecycle: session_start, tool_call, tool_result, before_agent_start,
 * session_before_compact, session_compact, session_shutdown.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionDB } from "./session/db.js";
import { extractEvents, extractUserEvents } from "./session/extract.js";
import type { HookInput } from "./session/extract.js";
import { buildResumeSnapshot } from "./session/snapshot.js";
import type { SessionEvent } from "./types.js";

// ── Pi Tool Name Mapping ─────────────────────────────────
// Pi uses lowercase; shared extractors expect PascalCase (Claude Code convention).
const PI_TOOL_MAP: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
};

// ── Routing patterns ─────────────────────────────────────
// Inline HTTP client patterns to block in bash — self-contained, no routing module needed.
const BLOCKED_BASH_PATTERNS: RegExp[] = [
  /\bcurl\s/,
  /\bwget\s/,
  /\bfetch\s*\(/,
  /\brequests\.get\s*\(/,
  /\brequests\.post\s*\(/,
  /\bhttp\.get\s*\(/,
  /\bhttp\.request\s*\(/,
  /\burllib\.request/,
  /\bInvoke-WebRequest\b/,
];

// ── Module-level DB singleton ────────────────────────────

let _db: SessionDB | null = null;
let _sessionId = "";

// ── Helpers ──────────────────────────────────────────────

function getSessionDir(): string {
  const dir = join(homedir(), ".pi", "context-mode", "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getDBPath(): string {
  return join(getSessionDir(), "context-mode.db");
}

function getOrCreateDB(): SessionDB {
  if (!_db) {
    _db = new SessionDB({ dbPath: getDBPath() });
  }
  return _db;
}

/** Derive a stable session ID from Pi's session file path (SHA256, 16 hex chars). */
function deriveSessionId(ctx: Record<string, unknown>): string {
  try {
    const sessionManager = ctx.sessionManager as
      | { getSessionFile?: () => string }
      | undefined;
    const sessionFile = sessionManager?.getSessionFile?.();
    if (sessionFile && typeof sessionFile === "string") {
      return createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
    }
  } catch {
    // best effort
  }
  return `pi-${Date.now()}`;
}

/** Build stats text for the /ctx-stats command. */
function buildStatsText(db: SessionDB, sessionId: string): string {
  try {
    const events = db.getEvents(sessionId);
    const stats = db.getSessionStats(sessionId);
    const lines: string[] = [
      "## context-mode stats (Pi)",
      "",
      `- Session: \`${sessionId.slice(0, 8)}...\``,
      `- Events captured: ${events.length}`,
      `- Compactions: ${stats?.compact_count ?? 0}`,
    ];

    // Event breakdown by category
    const byCategory: Record<string, number> = {};
    for (const ev of events) {
      const key = ev.category ?? "unknown";
      byCategory[key] = (byCategory[key] ?? 0) + 1;
    }
    if (Object.keys(byCategory).length > 0) {
      lines.push("- Event breakdown:");
      for (const [category, count] of Object.entries(byCategory)) {
        lines.push(`  - ${category}: ${count}`);
      }
    }

    // Session age
    if (stats?.started_at) {
      const startedMs = new Date(stats.started_at).getTime();
      const ageMinutes = Math.round((Date.now() - startedMs) / 60_000);
      lines.push(`- Session age: ${ageMinutes}m`);
    }

    return lines.join("\n");
  } catch {
    return "context-mode stats unavailable (session DB error)";
  }
}

function resolveCommandContext(argsOrCtx: unknown, ctx: unknown): any {
  if (ctx !== undefined) return ctx;
  if (argsOrCtx && typeof argsOrCtx === "object") return argsOrCtx;
  return undefined;
}

function handleCommandText(
  text: string,
  ctx: any,
): { text: string } | undefined {
  if (ctx?.hasUI) {
    ctx.ui.notify(text, "info");
    return;
  }

  return { text };
}

// ── Extension entry point ────────────────────────────────

/** Pi extension default export. Called once by Pi runtime with the extension API. */
export default function piExtension(pi: any): void {
  const buildDir = dirname(fileURLToPath(import.meta.url));
  const pluginRoot = resolve(buildDir, "..");
  const projectDir = process.env.PI_PROJECT_DIR || process.cwd();

  const db = getOrCreateDB();

  // ── 1. session_start — Initialize session ──────────────

  pi.on("session_start", (ctx: any) => {
    try {
      _sessionId = deriveSessionId(ctx ?? {});
      db.ensureSession(_sessionId, projectDir);
      db.cleanupOldSessions(7);
    } catch {
      // best effort — never break session start
      if (!_sessionId) {
        _sessionId = `pi-${Date.now()}`;
      }
    }
  });

  // ── 2. tool_call — PreToolUse routing enforcement ──────
  // Block bash commands that contain curl/wget/fetch/requests patterns.

  pi.on("tool_call", (event: any) => {
    try {
      const toolName = String(event?.toolName ?? "").toLowerCase();
      if (toolName !== "bash") return;

      const command = String(event?.input?.command ?? "");
      if (!command) return;

      const isBlocked = BLOCKED_BASH_PATTERNS.some((p) => p.test(command));
      if (isBlocked) {
        return {
          block: true,
          reason:
            "Use context-mode MCP tools (execute, fetch_and_index) instead of inline HTTP clients. " +
            "Raw curl/wget/fetch output floods the context window.",
        };
      }
    } catch {
      // Routing failure — allow passthrough
    }
  });

  // ── 3. tool_result — PostToolUse event capture ─────────

  pi.on("tool_result", (event: any) => {
    try {
      if (!_sessionId) return;

      const rawToolName = String(event?.toolName ?? event?.tool_name ?? "");
      const mappedToolName =
        PI_TOOL_MAP[rawToolName.toLowerCase()] ?? rawToolName;

      // Normalize result to string
      const rawResult = event?.result ?? event?.output;
      const resultStr =
        typeof rawResult === "string"
          ? rawResult
          : rawResult != null
            ? JSON.stringify(rawResult)
            : undefined;

      // Detect errors
      const hasError = Boolean(event?.error || event?.isError);

      const hookInput: HookInput = {
        tool_name: mappedToolName,
        tool_input: event?.params ?? event?.input ?? {},
        tool_response: resultStr,
        tool_output: hasError ? { isError: true } : undefined,
      };

      const events = extractEvents(hookInput);

      if (events.length > 0) {
        for (const ev of events) {
          db.insertEvent(_sessionId, ev as SessionEvent, "PostToolUse");
        }
      } else if (rawToolName) {
        // Fallback: record unrecognized tool call as generic event
        const data = JSON.stringify({
          tool: rawToolName,
          params: event?.params ?? event?.input,
        });
        db.insertEvent(
          _sessionId,
          {
            type: "tool_call",
            category: "pi",
            data,
            priority: 1,
            data_hash: createHash("sha256")
              .update(data)
              .digest("hex")
              .slice(0, 16),
          },
          "PostToolUse",
        );
      }
    } catch {
      // Silent — session capture must never break the tool call
    }
  });

  // ── 4. before_agent_start — Resume injection + user events ─

  pi.on("before_agent_start", (event: any) => {
    try {
      if (!_sessionId) return;

      const prompt = String(event?.prompt ?? "");

      // Extract user events from the prompt text
      if (prompt) {
        const userEvents = extractUserEvents(prompt);
        for (const ev of userEvents) {
          db.insertEvent(_sessionId, ev as SessionEvent, "UserPromptSubmit");
        }
      }

      // Check for unconsumed resume snapshot
      const resume = db.getResume(_sessionId);
      if (!resume || resume.consumed) return;

      // Build FTS5 active memory from the current prompt
      const stats = db.getSessionStats(_sessionId);
      if ((stats?.compact_count ?? 0) === 0) return;

      // Mark resume as consumed so it is not re-injected
      db.markResumeConsumed(_sessionId);

      // Build memory context from recent high-priority events
      const allEvents = db.getEvents(_sessionId, { minPriority: 3, limit: 50 });
      let memoryContext = "";
      if (allEvents.length > 0) {
        const memoryLines: string[] = ["<active_memory>"];
        for (const ev of allEvents) {
          memoryLines.push(
            `  <event type="${ev.type}" category="${ev.category}">${ev.data}</event>`,
          );
        }
        memoryLines.push("</active_memory>");
        memoryContext = memoryLines.join("\n");
      }

      // Compose the augmented system prompt
      const existingPrompt = String(event?.systemPrompt ?? "");
      const parts: string[] = [];
      if (existingPrompt) parts.push(existingPrompt);
      if (resume.snapshot) parts.push(resume.snapshot);
      if (memoryContext) parts.push(memoryContext);

      if (parts.length > (existingPrompt ? 1 : 0)) {
        return { systemPrompt: parts.join("\n\n") };
      }
    } catch {
      // best effort — never break agent start
    }
  });

  // ── 5. session_before_compact — Build resume snapshot ──

  pi.on("session_before_compact", () => {
    try {
      if (!_sessionId) return;

      const allEvents = db.getEvents(_sessionId);
      if (allEvents.length === 0) return;

      const stats = db.getSessionStats(_sessionId);
      const snapshot = buildResumeSnapshot(allEvents, {
        compactCount: (stats?.compact_count ?? 0) + 1,
      });

      db.upsertResume(_sessionId, snapshot, allEvents.length);
    } catch {
      // best effort — never break compaction
    }
  });

  // ── 6. session_compact — Increment compact counter ─────

  pi.on("session_compact", () => {
    try {
      if (!_sessionId) return;
      db.incrementCompactCount(_sessionId);
    } catch {
      // best effort
    }
  });

  // ── 7. session_shutdown — Cleanup old sessions ─────────

  pi.on("session_shutdown", () => {
    try {
      if (_db) {
        _db.cleanupOldSessions(7);
      }
      _db = null;
      _sessionId = "";
    } catch {
      // best effort — never throw during shutdown
    }
  });

  // ── 8. Slash commands ──────────────────────────────────

  pi.registerCommand("ctx-stats", {
    description: "Show context-mode session statistics",
    handler: async (argsOrCtx: unknown, maybeCtx: unknown) => {
      const ctx = resolveCommandContext(argsOrCtx, maybeCtx);
      const text =
        !_db || !_sessionId
          ? "context-mode: no active session"
          : buildStatsText(_db, _sessionId);

      return handleCommandText(text, ctx);
    },
  });

  pi.registerCommand("ctx-doctor", {
    description: "Run context-mode diagnostics",
    handler: async (argsOrCtx: unknown, maybeCtx: unknown) => {
      const ctx = resolveCommandContext(argsOrCtx, maybeCtx);
      const dbPath = getDBPath();
      const dbExists = existsSync(dbPath);
      const lines: string[] = [
        "## ctx-doctor (Pi)",
        "",
        `- DB path: \`${dbPath}\``,
        `- DB exists: ${dbExists}`,
        `- Session ID: \`${_sessionId ? _sessionId.slice(0, 8) + "..." : "none"}\``,
        `- Plugin root: \`${pluginRoot}\``,
        `- Project dir: \`${projectDir}\``,
      ];

      if (_db && _sessionId) {
        try {
          const stats = _db.getSessionStats(_sessionId);
          const eventCount = _db.getEventCount(_sessionId);
          lines.push(`- Events: ${eventCount}`);
          lines.push(`- Compactions: ${stats?.compact_count ?? 0}`);
          const resume = _db.getResume(_sessionId);
          lines.push(
            `- Resume snapshot: ${resume ? (resume.consumed ? "consumed" : "available") : "none"}`,
          );
        } catch {
          lines.push("- DB query error");
        }
      }

      const text = lines.join("\n");
      return handleCommandText(text, ctx);
    },
  });
}
