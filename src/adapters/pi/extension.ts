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
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionDB } from "../../session/db.js";
import { extractEvents, extractUserEvents } from "../../session/extract.js";
import type { HookInput } from "../../session/extract.js";
import { buildResumeSnapshot } from "../../session/snapshot.js";
import type { SessionEvent } from "../../types.js";
import { bootstrapMCPTools, type BridgeHandle } from "./mcp-bridge.js";

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

// MCP bridge handle. The bridge spawns server.bundle.mjs once and
// registers each MCP tool through pi.registerTool() so the Pi LLM can
// actually call ctx_execute / ctx_search / etc. (#426). Pi 0.73.x has
// no native MCP support, so without this bridge the tools are
// invisible to the LLM and the routing block is dead weight.
let _mcpBridge: BridgeHandle | null = null;

/**
 * Settles when the MCP bridge bootstrap has finished — resolves on
 * success AND on failure (the bootstrap is best-effort; failures are
 * logged to stderr but never propagated). Exposed for tests so they
 * can `await` the wiring deterministically without relying on internal
 * timing or `setImmediate` polling.
 *
 * Reset to a fresh promise on every `piExtension(pi)` call so repeated
 * registrations in one test process don't see a stale resolution from
 * a prior load.
 */
export let _mcpBridgeReady: Promise<void> = Promise.resolve();

// Per-session gate: routing block injected at most once per session_id.
const _routingInjected: Set<string> = new Set();


// Cached routing-block string (built once per process from hooks/routing-block.mjs).
let _routingBlock: string | null = null;
async function getRoutingBlock(pluginRoot: string): Promise<string> {
  if (_routingBlock !== null) return _routingBlock;
  try {
    const routingMod = await import(
      pathToFileURL(join(pluginRoot, "hooks", "routing-block.mjs")).href
    );
    const namingMod = await import(
      pathToFileURL(join(pluginRoot, "hooks", "core", "tool-naming.mjs")).href
    );
    const t = namingMod.createToolNamer("pi");
    _routingBlock = String(routingMod.createRoutingBlock(t));
  } catch {
    _routingBlock = "";
  }
  return _routingBlock;
}

// Cached buildAutoInjection (500-token cap, prioritized).
let _buildAutoInjection:
  | ((events: Array<{ category: string; data: string }>) => string)
  | null
  | undefined = undefined;
async function getAutoInjection(
  pluginRoot: string,
): Promise<((events: Array<{ category: string; data: string }>) => string) | null> {
  if (_buildAutoInjection !== undefined) return _buildAutoInjection;
  try {
    const mod = await import(
      pathToFileURL(join(pluginRoot, "hooks", "auto-injection.mjs")).href
    );
    _buildAutoInjection = mod.buildAutoInjection;
  } catch {
    _buildAutoInjection = null;
  }
  return _buildAutoInjection ?? null;
}

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

/**
 * Parse SessionDB timestamps as UTC. SQLite datetime('now') returns
 * "YYYY-MM-DD HH:MM:SS" in UTC without a timezone suffix; JavaScript parses
 * that shape as local time, which skews ages by the local UTC offset.
 */
function parseSessionTimestampMs(value: string): number {
  const trimmed = value.trim();
  const sqliteUtc = trimmed.match(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/,
  );
  const normalized = sqliteUtc
    ? `${sqliteUtc[1]}T${sqliteUtc[2]}${sqliteUtc[3] ?? ""}Z`
    : trimmed;
  return Date.parse(normalized);
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
      const startedMs = parseSessionTimestampMs(stats.started_at);
      if (Number.isFinite(startedMs)) {
        const ageMinutes = Math.round((Date.now() - startedMs) / 60_000);
        lines.push(`- Session age: ${ageMinutes}m`);
      }
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
  const pluginRoot = resolve(buildDir, "..", "..", "..");
  const projectDir = process.env.PI_PROJECT_DIR || process.cwd();

  const db = getOrCreateDB();

  // ── 1. session_start — Initialize session ──────────────

  pi.on("session_start", (_event: any, ctx: any) => {
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

  // ── 4. before_agent_start — Routing + active_memory + resume injection ─

  pi.on("before_agent_start", async (event: any) => {
    try {
      // Block first agent start until the MCP bridge bootstrap has
      // settled so the LLM call dispatched right after this handler
      // sees the ctx_* tools in Pi's registry. Each subagent starts
      // a fresh `pi --mode json -p --no-session` process whose only
      // window to register tools is the gap between piExtension(pi)
      // returning and the first before_agent_start firing — that gap
      // is too small for the spawn → initialize → tools/list →
      // pi.registerTool round-trip, so without this await the first
      // (and often only) prompt of a subagent goes out with an empty
      // ctx_* registry and the routing block becomes dead weight.
      // Resolves on bootstrap failure too — the bridge is best-effort.
      await _mcpBridgeReady;

      if (!_sessionId) return;

      const prompt = String(event?.prompt ?? "");

      // Extract user events from the prompt text
      if (prompt) {
        const userEvents = extractUserEvents(prompt);
        for (const ev of userEvents) {
          db.insertEvent(_sessionId, ev as SessionEvent, "UserPromptSubmit");
        }
      }

      const existingPrompt = String(event?.systemPrompt ?? "");
      const parts: string[] = [];
      if (existingPrompt) parts.push(existingPrompt);

      // Pi-1: Inject routing block every turn.
      // Unlike Claude Code where the SessionStart hook injects once into a persistent
      // context, Pi rebuilds the system prompt fresh on every before_agent_start call.
      // The routing block must be re-injected each turn or it disappears after turn 1.
      const routingBlock = await getRoutingBlock(pluginRoot);
      if (routingBlock) {
        parts.push(routingBlock);
      }

      // Pi-3 + Pi-4: Always build active_memory (not just post-compact),
      // capped at 500 tokens via buildAutoInjection. Falls back to inline
      // budget loop if the helper is unavailable.
      const activeEvents = db.getEvents(_sessionId, {
        minPriority: 3,
        limit: 50,
      });
      if (activeEvents.length > 0) {
        const buildAuto = await getAutoInjection(pluginRoot);
        let memoryContext = "";
        if (buildAuto) {
          memoryContext = buildAuto(
            activeEvents.map((e: any) => ({
              category: String(e.category ?? ""),
              data: String(e.data ?? ""),
            })),
          );
        }
        // Fallback (or if helper produced empty output): inline 500-token cap.
        if (!memoryContext) {
          const memoryLines: string[] = ["<active_memory>"];
          let budget = 2000; // ~500 tokens at 4 chars/token
          for (const ev of activeEvents) {
            const line = `  <event type="${ev.type}" category="${ev.category}">${ev.data}</event>`;
            if (line.length > budget) break;
            memoryLines.push(line);
            budget -= line.length;
          }
          memoryLines.push("</active_memory>");
          if (memoryLines.length > 2) memoryContext = memoryLines.join("\n");
        }
        if (memoryContext) parts.push(memoryContext);
      }

      // Resume snapshot (only when present and unconsumed).
      const resume = db.getResume(_sessionId);
      if (resume && !resume.consumed && resume.snapshot) {
        parts.push(resume.snapshot);
        db.markResumeConsumed(_sessionId);
      }

      // Return modified systemPrompt only if we added something beyond existing.
      const baseLen = existingPrompt ? 1 : 0;
      if (parts.length > baseLen) {
        return { systemPrompt: parts.join("\n\n") };
      }
    } catch {
      // best effort — never break agent start
    }
  });

  // ── 4b. before_provider_response — capture response metadata ───
  // Pi-2: Register the missing event so providers can record latency,
  // model, and token usage when Pi exposes them. Best-effort only;
  // the handler must never throw or modify the response.

  pi.on("before_provider_response", (event: any) => {
    try {
      if (!_sessionId) return;
      const meta = {
        model: event?.model ?? event?.providerModel,
        provider: event?.provider,
        latencyMs: event?.latencyMs ?? event?.latency,
        tokens: event?.usage ?? event?.tokens,
      };
      // Skip when Pi gives us nothing useful — avoids noise in the DB.
      if (
        meta.model == null &&
        meta.provider == null &&
        meta.latencyMs == null &&
        meta.tokens == null
      ) {
        return;
      }
      const data = JSON.stringify(meta);
      db.insertEvent(
        _sessionId,
        {
          type: "provider_response",
          category: "pi",
          data,
          priority: 1,
          data_hash: createHash("sha256").update(data).digest("hex").slice(0, 16),
        },
        "PostToolUse",
      );
    } catch {
      // best effort — never break provider response
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
    if (_mcpBridge) {
      try {
        _mcpBridge.shutdown();
      } catch {
        // best effort — never throw during shutdown
      }
      _mcpBridge = null;
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

  // ── 9. MCP tool bridge (#426) ───────────────────────────
  //
  // Pi 0.73.x has no native MCP support. Without bridging here, the
  // routing block tells the LLM to call ctx_execute / ctx_search / etc.
  // but those tools never appear in Pi's tool list and the LLM cannot
  // reach them — context-mode becomes a pure cost (~2.5K tokens of
  // system-prompt overhead, 0 actual ctx_* calls).
  //
  // Spawn server.bundle.mjs as a long-lived MCP child and register
  // each of its tools via pi.registerTool() so they enter the Pi
  // tool list under their bare names — same names the routing block
  // emits for the Pi platform (per hooks/core/tool-naming.mjs).
  //
  // Best-effort: a missing bundle or a spawn failure must NOT prevent
  // the rest of the extension (session capture, hooks, slash commands)
  // from initializing. We log to stderr and continue.
  const serverBundle = resolve(pluginRoot, "server.bundle.mjs");
  if (existsSync(serverBundle)) {
    _mcpBridgeReady = bootstrapMCPTools(pi, serverBundle).then(
      (handle) => {
        _mcpBridge = handle;
      },
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[context-mode] WARNING: failed to bridge MCP tools to Pi (${msg}). ` +
            `ctx_* tools will not be callable from this session.\n`,
        );
      },
    );
  } else {
    // No bundle on disk → nothing to await. Tests can still rely on
    // _mcpBridgeReady being a settled promise.
    _mcpBridgeReady = Promise.resolve();
  }
}
