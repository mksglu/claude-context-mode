/**
 * OpenCode TypeScript plugin entry point for context-mode.
 *
 * Provides three hooks:
 *   - tool.execute.before  — Routing enforcement (deny/modify/passthrough)
 *   - tool.execute.after   — Session event capture
 *   - experimental.session.compacting — Compaction snapshot generation
 *
 * Loaded by OpenCode via: import("context-mode/plugin").ContextModePlugin(ctx)
 *
 * Constraints:
 *   - No SessionStart hook (OpenCode doesn't support it — #14808, #5409)
 *   - No context injection (canInjectSessionContext: false)
 *   - No routing file auto-write (avoid dirtying project trees)
 *   - Session cleanup happens at plugin init (no SessionStart)
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SessionDB } from "./session/db.js";
import { extractEvents } from "./session/extract.js";
import type { HookInput } from "./session/extract.js";
import { buildResumeSnapshot } from "./session/snapshot.js";
import type { SessionEvent } from "./types.js";
import { AdapterPlatformType, OpenCodeAdapter } from "./adapters/opencode/index.js";

// ── Types ─────────────────────────────────────────────────

/** OpenCode plugin context passed to the factory function. */
interface PluginContext {
  directory: string;
}

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

// ── Helpers ───────────────────────────────────────────────
function getPlatform(): AdapterPlatformType {
  return process.env.KILO ? "kilo" : "opencode";
}

function getSessionDir(): string {
  const dir = join(
    homedir(),
    ".config",
    getPlatform(),
    "context-mode",
    "sessions",
  );
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

// ── Plugin Factory ────────────────────────────────────────

/**
 * OpenCode plugin factory. Called once when OpenCode loads the plugin.
 * Returns an object mapping hook event names to async handler functions.
 */
export const ContextModePlugin = async (ctx: PluginContext) => {
  // Resolve build dir from compiled JS location
  const buildDir = dirname(fileURLToPath(import.meta.url));
  
  // Load routing module (ESM .mjs, lives outside build/ in hooks/)
  const routingPath = resolve(buildDir, "..", "hooks", "core", "routing.mjs");
  const routing = await import(pathToFileURL(routingPath).href);
  await routing.initSecurity(buildDir);
  
  // Initialize session
  const projectDir = ctx.directory;
  const db = new SessionDB({ dbPath: getDBPath(projectDir) });
  const sessionId = randomUUID();
  db.ensureSession(sessionId, projectDir);
  
  // Clean up old sessions on startup (replaces SessionStart hook)
  db.cleanupOldSessions(0);

  return {
    // ── PreToolUse: Routing enforcement ─────────────────

    "tool.execute.before": async (input: BeforeHookInput, output: BeforeHookOutput) => {
      const toolName = input.tool ?? "";
      const toolInput = output.args ?? {};

      let decision;
      try {
        decision = routing.routePreToolUse(toolName, toolInput, projectDir, "opencode");
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

      // "context" action → no-op (OpenCode doesn't support context injection)
    },

    // ── PostToolUse: Session event capture ──────────────

    "tool.execute.after": async (input: AfterHookInput, output: AfterHookOutput) => {
      try {
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

    // ── PreCompact: Snapshot generation ─────────────────

    "experimental.session.compacting": async (input: CompactingHookInput, output: CompactingHookOutput) => {
      try {
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

        return snapshot;
      } catch {
        return "";
      }
    },
  };
};
