/**
 * OpenCode / KiloCode TypeScript plugin entry point for context-mode.
 *
 * Provides five hooks (v1.0.107 — Mickey OC-1..OC-4 follow-up):
 *   - tool.execute.before  — Routing enforcement (deny/modify/passthrough)
 *   - tool.execute.after   — Session event capture + first-fire AGENTS.md scan (OC-4)
 *   - experimental.session.compacting — Compaction snapshot + budget-capped auto-injection (OC-3)
 *   - experimental.chat.system.transform — ROUTING_BLOCK + resume snapshot injection (OC-1)
 *   - chat.message         — User-prompt capture w/ CCv2 inline filter (OC-2) + AGENTS.md scan (OC-4)
 *
 * KiloCode loads this via: import("context-mode") → expects default export
 * with shape { server: (input) => Promise<Hooks> } (PluginModule).
 *
 * OpenCode loads this via: import("context-mode/plugin") → also supports
 * the named export ContextModePlugin for backward compat.
 *
 * Constraints:
 *   - No SessionStart hook (OpenCode doesn't support it — #14808, #5409)
 *   - context injection now via chat.system.transform surrogate (OC-1)
 *   - No routing file auto-write (avoid dirtying project trees)
 *   - Session cleanup happens at plugin init (no SessionStart)
 */

import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";

import { resolveSessionDbPath, SessionDB } from "../../session/db.js";
import { extractEvents, extractUserEvents } from "../../session/extract.js";
import type { HookInput } from "../../session/extract.js";
import { buildResumeSnapshot } from "../../session/snapshot.js";
import type { SessionEvent } from "../../types.js";
import { AdapterPlatformType, OpenCodeAdapter } from "./index.js";
import { PLATFORM_ENV_VARS } from "../detect.js";

// Read package.json version once at module load (not on every hook call).
// Used in the resume-injection visible signal so users can confirm in
// OPENCODE_DEBUG logs which plugin version actually injected.
const VERSION: string = (() => {
  try {
    const pkgRoot = dirname(fileURLToPath(import.meta.url));
    // Search both the legacy depths (when bundled flat under build/) and
    // the post-refactor depths (when compiled to build/adapters/opencode/).
    // `../../../package.json` is the canonical location after the
    // `src/opencode-plugin.ts → src/adapters/opencode/plugin.ts` move.
    for (const rel of ["../../../package.json", "../package.json", "./package.json"]) {
      const p = resolve(pkgRoot, rel);
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")).version ?? "unknown";
    }
  } catch { /* fall through */ }
  return "unknown";
})();

// ── Types ─────────────────────────────────────────────────

/** KiloCode/OpenCode plugin input — both platforms pass at least `directory`. */
type PluginClientAppLogBodyExtra = {
  sessionId?: string;
  source?: string;
};

type PluginClientAppLogBody = {
  service: string;
  level: "info" | "warn" | "error" | "debug"; // Strict union for log levels
  message: string;
  extra?: PluginClientAppLogBodyExtra;
};

type PluginClientAppLogOptions = {
  body: PluginClientAppLogBody;
};

type PluginClientApp = {
  log: (options: PluginClientAppLogOptions) => Promise<void>;
};

type PluginClient = {
  app: PluginClientApp;
};

type PluginContext = {
  client: PluginClient;
  directory: string;
};

/** OpenCode tool.execute.before — first parameter */
interface BeforeHookInput {
  tool: string;
  sessionID: string;
  callID: string;
}

/** OpenCode tool.execute.before — second parameter */
interface BeforeHookOutput {
  args: any;
}

/** OpenCode tool.execute.after — first parameter */
interface AfterHookInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: any;
}

/** OpenCode tool.execute.after — second parameter */
interface AfterHookOutput {
  title: string;
  output: string;
  metadata: any;
}

/** OpenCode experimental.session.compacting — first parameter */
interface CompactingHookInput {
  sessionID: string;
}

/** OpenCode experimental.session.compacting — second parameter */
interface CompactingHookOutput {
  context: string[];
  prompt?: string;
}

/**
 * OpenCode experimental.chat.system.transform — first parameter.
 * Verified against sst/opencode/dev/packages/plugin/src/index.ts:
 *   input: { sessionID?: string; model: Model }
 * `sessionID` is optional in the SDK type but is in practice always set
 * (the transform runs *for* a session). We treat it as required and
 * skip injection when absent rather than fall back to a fabricated ID.
 *
 * NOTE: We deliberately do NOT use `experimental.chat.messages.transform`.
 * Its SDK input shape is `{}` (no sessionID) and its output is
 * `{ messages: { info: Message; parts: Part[] }[] }` — the prior code
 * (`output.messages.unshift({ role, content })`) wrote a value of the
 * wrong shape and was silently dropped (Mickey / PR #376 root cause).
 */
interface SystemTransformHookInput {
  sessionID?: string;
  model: unknown;
}

/** OpenCode experimental.chat.system.transform — second parameter */
interface SystemTransformHookOutput {
  system: string[];
}

/**
 * OpenCode chat.message hook — verified against
 * refs/platforms/opencode/packages/plugin/src/index.ts:233.
 *   input:  { sessionID; agent?; model?; messageID?; variant? }
 *   output: { message: UserMessage; parts: Part[] }
 * We read text from `parts[*].text` (the orchestrator reference at
 * refs/plugin-examples/opencode/opencode-orchestrator/src/plugin-handlers/
 * chat-message-handler.ts:41-65 uses the same pattern).
 */
interface ChatMessageHookInput {
  sessionID: string;
  agent?: string;
  messageID?: string;
}

interface ChatMessagePart {
  type: string;
  text?: string;
}

interface ChatMessageHookOutput {
  message: unknown;
  parts: ChatMessagePart[];
}

// Synthetic message tags emitted by harnesses (CCv2 inline filter). When the
// user "message" is actually a system-generated nudge (e.g. tool-result, system
// reminder), capturing it as user_prompt would flood the DB with noise.
const SYNTHETIC_MESSAGE_PREFIXES = [
  "<task-notification>",
  "<system-reminder>",
  "<context_guidance>",
  "<tool-result>",
];

function isSyntheticMessage(text: string): boolean {
  const trimmed = text.trim();
  return SYNTHETIC_MESSAGE_PREFIXES.some((p) => trimmed.startsWith(p));
}

// ── Helpers ───────────────────────────────────────────────

// Quorum markers — must NOT be substrings of each other (#487).
// Each token uniquely identifies the routing block / context-mode rules
// without overlapping any other marker. The XML tag is the primary signal;
// the two distinctive bare tool names are the secondary signals. Together
// any 2 of 3 confirm the system prompt already carries routing instructions.
const ROUTING_MARKERS = [
  "<context_window_protection>",
  "ctx_search",
  "ctx_index",
];

function systemHasRoutingInstructions(system: string[]): boolean {
  const text = system.join("\n");
  // Word-boundary check guards against unrelated identifiers that happen to
  // share a prefix/suffix (e.g. a hypothetical `ctx_search_v2`).
  const wordBoundary = (m: string) => {
    if (m.startsWith("<")) return text.includes(m);
    const re = new RegExp(`(?:^|\\W)${m.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?:\\W|$)`);
    return re.test(text);
  };
  return ROUTING_MARKERS.filter(wordBoundary).length >= 2;
}

/**
 * Detect whether the plugin is running under KiloCode or OpenCode.
 *
 * Reuses the canonical PLATFORM_ENV_VARS list (src/adapters/detect.ts) instead
 * of hardcoding env var names — single source of truth, future-proof if Kilo
 * or OpenCode add/rename env vars upstream.
 *
 * Order matters: KiloCode is an OpenCode fork and sets `OPENCODE=1` in
 * addition to `KILO_PID`. PLATFORM_ENV_VARS lists `kilo` BEFORE `opencode`
 * so KILO_PID wins the iteration.
 *
 * Pre-fix version was `return process.env.KILO_PID ? "kilo" : "opencode";` —
 * surfaced by github.com/mksglu/context-mode/pull/376 (mikij). Full symmetric
 * fix: also actively check opencode env vars instead of blind fallback.
 */
function getPlatform(): AdapterPlatformType {
  for (const [platform, vars] of PLATFORM_ENV_VARS) {
    if (platform !== "kilo" && platform !== "opencode") continue;
    if (vars.some((v) => process.env[v.name])) {
      return platform as AdapterPlatformType;
    }
  }
  // Plugin host should always set one of the env vars. Fallback to opencode
  // (the wider ecosystem) when neither is set, for predictable behavior.
  return "opencode";
}

// ── Plugin Factory ────────────────────────────────────────

/**
 * Plugin factory. Called once when KiloCode/OpenCode loads the plugin.
 * Returns an object mapping hook event names to async handler functions.
 *
 * KiloCode expects: export default { id: string, server: (input) => Promise<Hooks> }
 * OpenCode expects: export const ContextModePlugin = (ctx) => Promise<Hooks>
 */
async function createContextModePlugin(ctx: PluginContext) {
  // Resolve build dir from compiled JS location
  const platform = getPlatform();
  const adapter = new OpenCodeAdapter(platform);
  const buildDir = dirname(fileURLToPath(import.meta.url));
  // initSecurity() looks for `<dir>/security.js`, which lives at the
  // top of build/ — two levels up from this adapter directory.
  const buildRoot = resolve(buildDir, "..", "..");

  // Load routing module (ESM .mjs, lives outside build/ in hooks/)
  const routingPath = resolve(buildDir, "..", "..", "..", "hooks", "core", "routing.mjs");
  const routing = await import(pathToFileURL(routingPath).href);
  await routing.initSecurity(buildRoot);

  // OC-1 / OC-3: Load hook helpers once at plugin init. Dynamic import keeps
  // the .mjs ESM islands isolated from the .ts compile graph.
  const routingBlockPath = resolve(buildDir, "..", "..", "..", "hooks", "routing-block.mjs");
  const routingBlockMod = await import(pathToFileURL(routingBlockPath).href);
  const toolNamingPath = resolve(buildDir, "..", "..", "..", "hooks", "core", "tool-naming.mjs");
  const toolNamingMod = await import(pathToFileURL(toolNamingPath).href);
  const autoInjectionPath = resolve(buildDir, "..", "..", "..", "hooks", "auto-injection.mjs");
  const autoInjectionMod = await import(pathToFileURL(autoInjectionPath).href);

  // Pre-build the routing block once per process — it is platform-specific
  // (tool naming differs between opencode and kilo) but does NOT depend on
  // sessionID, so we cache it. createToolNamer accepts both "opencode" and
  // "kilo" per hooks/core/tool-naming.mjs:25-26.
  const toolNamer = toolNamingMod.createToolNamer(platform);
  const routingBlock: string = routingBlockMod.createRoutingBlock(toolNamer);

  // Initialize per-process state. We do NOT fabricate a sessionId here —
  // OpenCode/Kilo provide the real `input.sessionID` on every hook, and a
  // process-global UUID would (a) never match prior-session resume rows and
  // (b) collide across multi-session reuse (Mickey / PR #376 root cause).
  const projectDir = ctx?.directory ?? process.cwd();
  // C2 narrowing: resolve DB path through the canonical helper directly.
  // BaseAdapter no longer exposes getSessionDBPath; the adapter only owns
  // the sessions DIR (per-platform), the helper owns the per-project FILE
  // (case-fold + worktree-suffix + one-shot legacy migration).
  const db = new SessionDB({
    dbPath: resolveSessionDbPath({ projectDir, sessionsDir: adapter.getSessionDir() }),
  });

  // Clean up old sessions on startup (no SessionStart hook to do this).
  db.cleanupOldSessions(7);

  // OC-4 (#487 follow-up): per-session capture gate. PR #487 trusted the host
  // to deliver AGENTS.md events, but OpenCode only fires `rule_content` events
  // when the user explicitly reads the file. snapshot.ts:172 + analytics.ts:152
  // CONSUME `rule_content` to render rules into the resume snapshot — without
  // this capture path, AGENTS.md is silently absent from continuity output.
  // Keyed by sessionId (NOT projectDir) so multi-session reuse within a long-
  // lived plugin process still gets per-session capture exactly once.
  const agentsMdCaptured = new Set<string>();

  /**
   * OC-4: Read AGENTS.md (with CLAUDE.md / CONTEXT.md fallbacks) from the
   * project directory and persist as `rule` + `rule_content` events. Mirrors
   * the CC SessionStart pattern at hooks/sessionstart.mjs:121-132 and the
   * OpenCode instruction.ts FILES order. Idempotent via `agentsMdCaptured`
   * Set keyed by sessionId. Fail-soft: missing/unreadable files do not throw.
   */
  function captureAgentsMd(sessionId: string): void {
    if (agentsMdCaptured.has(sessionId)) return;
    agentsMdCaptured.add(sessionId);
    const candidates = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"];
    for (const name of candidates) {
      try {
        const p = join(projectDir, name);
        if (!existsSync(p)) continue;
        const content = readFileSync(p, "utf-8");
        if (!content.trim()) continue;
        db.insertEvent(sessionId, {
          type: "rule",
          category: "rule",
          data: p,
          priority: 1,
        } as SessionEvent, "PluginInit");
        db.insertEvent(sessionId, {
          type: "rule_content",
          category: "rule",
          data: content,
          priority: 1,
        } as SessionEvent, "PluginInit");
      } catch {
        // file missing or unreadable — skip silently
      }
    }
  }

  function logger(
    message = "context-mode debug log",
    extra?: PluginClientAppLogBodyExtra,
  ): Promise<void> {
    return ctx.client.app.log({
      body: {
        service: "context-mode-logger",
        level: "info",
        message,
        extra,
      },
    });
  }

  /**
   * Drop-in wrapper for `logger` that NEVER rejects (#448).
   *
   * The OPENCODE_DEBUG branch awaits `logger(...)` from inside the chat-turn
   * hot path (chat.system.transform). If `ctx.client.app.log` rejects —
   * transport error, closed stream, oversized payload — the promise rejection
   * propagates back to OpenCode core and can break the turn. Debug logging
   * is best-effort; swallow errors silently and let the turn proceed.
   */
  async function safeLog(
    message?: string,
    extra?: PluginClientAppLogBodyExtra,
  ): Promise<void> {
    try {
      await logger(message, extra);
    } catch {
      // Never break the turn on debug-log failure.
    }
  }

  return {
    // ── PreToolUse: Routing enforcement ─────────────────

    "tool.execute.before": async (input: BeforeHookInput, output: BeforeHookOutput) => {
      const toolName = input.tool ?? "";
      const toolInput = output.args ?? {};

      let decision;
      try {
        decision = routing.routePreToolUse(toolName, toolInput, projectDir, platform);
      } catch {
        return; // Routing failure → allow passthrough
      }

      if (!decision) return; // No routing match → passthrough

      if (decision.action === "deny" || decision.action === "ask") {
        // Throw to block — OpenCode catches this and denies the tool call
        throw new Error(decision.reason ?? "Blocked by context-mode");
      }

      if (decision.action === "modify" && decision.updatedInput) {
        // Mutate output.args — OpenCode reads the mutated output object
        Object.assign(output.args, decision.updatedInput);
      }

      if (decision.action === "context" && decision.additionalContext) {
        // Mutate output.args — OpenCode reads the mutated output object
        output.args.additionalContext = decision.additionalContext;
      }
    },

    // ── PostToolUse: Session event capture ──────────────

    "tool.execute.after": async (input: AfterHookInput, output: AfterHookOutput) => {
      const sessionId = input.sessionID;
      if (!sessionId) return;
      try {
        db.ensureSession(sessionId, projectDir);
        // OC-4 (#487 follow-up): AGENTS.md → rule_content capture for snapshot
        // and auto-memory parity. Idempotent per-session via Set guard.
        captureAgentsMd(sessionId);

        const hookInput: HookInput = {
          tool_name: input.tool ?? "",
          tool_input: input.args ?? {},
          tool_response: output.output,
          tool_output: undefined, // OpenCode doesn't provide isError
        };

        const events = extractEvents(hookInput);
        for (const event of events) {
          // Cast: extract.ts SessionEvent lacks data_hash (computed by insertEvent)
          db.insertEvent(sessionId, event as SessionEvent, "PostToolUse");
        }
      } catch {
        // Silent — session capture must never break the tool call
      }
    },

    // ── chat.message: User-prompt capture (OC-2 / Z2) ───
    // SDK signature verified at refs/platforms/opencode/packages/plugin/src/
    // index.ts:233. Orchestrator reference at refs/plugin-examples/opencode/
    // opencode-orchestrator/src/plugin-handlers/chat-message-handler.ts:41-65.
    // CCv2 inline filter: skip synthetic harness messages (system reminders,
    // tool results, etc.) so we don't pollute the user-prompt event stream.
    "chat.message": async (input: ChatMessageHookInput, output: ChatMessageHookOutput) => {
      const sessionId = input?.sessionID;
      if (!sessionId) return;
      try {
        const parts = Array.isArray(output?.parts) ? output.parts : [];
        const textPart = parts.find((p) => p && p.type === "text" && typeof p.text === "string" && p.text.length > 0);
        if (!textPart || !textPart.text) return;
        const message = textPart.text;
        if (isSyntheticMessage(message)) return;

        db.ensureSession(sessionId, projectDir);
        // OC-4 (#487 follow-up): also capture on chat.message so sessions that
        // never invoke a tool still seed rule_content events for continuity.
        captureAgentsMd(sessionId);

        // 1. Always save the raw prompt
        db.insertEvent(sessionId, {
          type: "user_prompt",
          category: "user-prompt",
          data: message,
          priority: 1,
        } as SessionEvent, "UserPromptSubmit");

        // 2. Extract role/decision/intent/skill events from the prompt body
        const userEvents = extractUserEvents(message);
        for (const ev of userEvents) {
          db.insertEvent(sessionId, ev as SessionEvent, "UserPromptSubmit");
        }
      } catch {
        // Silent — chat.message must never break the turn
      }
    },

    // ── PreCompact: Snapshot generation ─────────────────

    "experimental.session.compacting": async (input: CompactingHookInput, output: CompactingHookOutput) => {
      const sessionId = input.sessionID;
      if (!sessionId) return "";
      try {
        db.ensureSession(sessionId, projectDir);
        const events = db.getEvents(sessionId);
        if (events.length === 0) return "";

        const stats = db.getSessionStats(sessionId);
        const snapshot = buildResumeSnapshot(events, {
          compactCount: (stats?.compact_count ?? 0) + 1,
        });

        db.upsertResume(sessionId, snapshot, events.length);
        db.incrementCompactCount(sessionId);

        // Mutate output.context to inject the snapshot
        output.context.push(snapshot);

        if (process.env.OPENCODE_DEBUG) {
          await safeLog(snapshot, {
            sessionId,
            source: "on compaction - snapshot",
          });
        }

        // OC-3 / Z3: Add budget-capped auto-injection (P1 role / P2 rules /
        // P3 skills / P4 intent — ≤500 tokens / ~2000 chars per
        // hooks/auto-injection.mjs). Pushed as a separate context entry so
        // OpenCode can fold it independently from the verbose snapshot.
        try {
          const autoBlock: string = autoInjectionMod.buildAutoInjection(events);
          if (autoBlock && autoBlock.length > 0) {
            output.context.push(autoBlock);
          }

          if (process.env.OPENCODE_DEBUG) {
            await safeLog(autoBlock, {
              sessionId,
              source: "on compaction - autoBlock",
            });
          }
        } catch {
          // Auto-injection failure must NOT break the snapshot path.
        }

        return snapshot;
      } catch {
        return "";
      }
    },

    // ── SessionStart equivalent (PR #376) ───────────────
    // OpenCode lacks a real SessionStart hook (#14808, #5409). The closest
    // surrogate is `experimental.chat.system.transform` — verified shape:
    //   input:  { sessionID?: string; model: Model }
    //   output: { system: string[] }
    // We claim the most-recent unconsumed resume snapshot atomically (race-
    // safe across concurrent processes) and prepend it to the system prompt.
    "experimental.chat.system.transform": async (
      input: SystemTransformHookInput,
      output: SystemTransformHookOutput,
    ) => {
      const sessionId = input?.sessionID;
      if (!sessionId) return;

      // ── OC-1 / CCv1: ROUTING_BLOCK injection ──────────────
      // Inject the <context_window_protection> XML block on the first
      // chat.system.transform per session. This is INDEPENDENT of the
      // resume snapshot path below — routing block must fire even when
      // no prior session row exists. Splice at index 1 (NOT unshift) for
      // the same OpenCode llm.ts:117-128 cache-fold reason as resume.
      //
      // Skip injection when system prompt already contains context-mode
      // routing rules (e.g. via AGENTS.md / CLAUDE.md loaded by the host).
      // Detect by checking for a quorum of distinctive tool names — any two
      // of ctx_execute, ctx_batch_execute, ctx_fetch_and_index confirms the
      // instructions are present and avoids ~2K chars of duplication.
      if (Array.isArray(output?.system)) {
        if (!systemHasRoutingInstructions(output.system)) {
          try {
            output.system.splice(1, 0, routingBlock);
          } catch {
            // Never break the chat turn on routing-block injection failure.
          }

          if (process.env.OPENCODE_DEBUG) {
            await safeLog(output.system[1], {sessionId, source: 'on routing block injection'});
          }
        } else if (process.env.OPENCODE_DEBUG) {
          await safeLog(`routing block skipped — system prompt already contains context-mode instructions`, {sessionId, source: 'on routing block injection'});
        }
      }

      try {
        // Pass current sessionId so SQL excludes self-injection (v1.0.106 — Mickey #376
        // follow-up): if Session B compacts mid-flight and produces its own row,
        // B's next system.transform must NOT claim that row back into B's prompt.
        const row = db.claimLatestUnconsumedResume(sessionId);
        if (!row || !row.snapshot) return;        // no row → retry on next turn

        if (process.env.OPENCODE_DEBUG) {
          await safeLog(row.snapshot, {
            sessionId,
            source: "on resume - snapshot",
          });
        }

        if (Array.isArray(output?.system)) {
          // Insert at index 1 (after the header) — NOT unshift.
          // OpenCode's llm.ts:117-128 saves `header = system[0]` BEFORE this
          // hook runs and then folds the rest into a 2-part structure
          // `[header, body]` only if `system[0] === header` after the hook.
          // Prepending via unshift replaces system[0] with the snapshot,
          // making the equality check fail → cache-fold is skipped → every
          // system block is sent as a separate `role: "system"` message →
          // provider prompt cache is invalidated on every resume injection.
          // Inserting at index 1 keeps the header invariant and lets the
          // snapshot ride along inside the cached body block.
          output.system.splice(1, 0, row.snapshot);
          // Mark consumed only AFTER successful splice so failed paths can retry
          if (process.env.OPENCODE_DEBUG) {
            await safeLog(output.system[1], { sessionId, source: "on resume" });
          }
        }
      } catch {
        // Silent — never break the chat turn
      }
    },
  };
}

// ── Exports ──────────────────────────────────────────────
// KiloCode PluginModule: default export with { server } shape
// OpenCode compat: named export for direct import("context-mode/plugin")
export default { id:"context-mode", server: createContextModePlugin };
export { createContextModePlugin as ContextModePlugin };
// Test surface — exported for unit testing the quorum substring fix (#487).
export { systemHasRoutingInstructions, ROUTING_MARKERS };
