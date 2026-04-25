#!/usr/bin/env node
import "./suppress-stderr.mjs";
import "./ensure-deps.mjs";
/**
 * SessionStart hook for context-mode
 *
 * Provides the agent with XML-structured "Rules of Engagement"
 * at the beginning of each session. Injects session knowledge on
 * both startup and compact to maintain continuity.
 *
 * Session Lifecycle Rules:
 * - "startup"  → Fresh session. Inject previous session knowledge. Cleanup old data.
 * - "compact"  → Auto-compact triggered. Inject resume snapshot + stats.
 * - "resume"   → User used --continue. Full history, no resume needed.
 * - "clear"    → User cleared context. No resume.
 */

import { createRoutingBlock } from "./routing-block.mjs";
import { createToolNamer } from "./core/tool-naming.mjs";

const toolNamer = createToolNamer("claude-code");
const ROUTING_BLOCK = createRoutingBlock(toolNamer);
import { readStdin, getSessionId, getSessionDBPath, getSessionEventsPath, getCleanupFlagPath, resolveConfigDir } from "./session-helpers.mjs";
import { writeSessionEventsFile, buildSessionDirective, getSessionEvents, getLatestSessionEvents } from "./session-directive.mjs";
import { createSessionLoaders } from "./session-loaders.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, unlinkSync, readdirSync, rmSync, statSync } from "node:fs";

// Resolve absolute path for imports (fileURLToPath for Windows compat)
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);

let additionalContext = ROUTING_BLOCK;

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const source = input.source ?? "startup";

  if (source === "compact") {
    // Session was compacted — write events to file for auto-indexing, inject directive only
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input);
    const resume = db.getResume(sessionId);

    if (resume && !resume.consumed) {
      db.markResumeConsumed(sessionId);
    }

    const events = getSessionEvents(db, sessionId);
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath());
      additionalContext += buildSessionDirective("compact", eventMeta, toolNamer);
    }

    db.close();
  } else if (source === "resume") {
    // User used --continue — clear cleanup flag so startup doesn't wipe data
    try { unlinkSync(getCleanupFlagPath()); } catch { /* no flag */ }

    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });

    const events = getLatestSessionEvents(db);
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath());
      additionalContext += buildSessionDirective("resume", eventMeta, toolNamer);
    }

    db.close();
  } else if (source === "startup") {
    // Fresh session (no --continue) — clean slate, capture CLAUDE.md rules.
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });
    try { unlinkSync(getSessionEventsPath()); } catch { /* no stale file */ }

    // Detect true fresh start vs --continue (which fires startup→resume).
    // If cleanup flag exists from a PREVIOUS startup that was never followed by
    // resume, that was a true fresh start — aggressively wipe all data.
    db.cleanupOldSessions(7);
    db.db.exec(`DELETE FROM session_events WHERE session_id NOT IN (SELECT session_id FROM session_meta)`);

    // Proactively capture CLAUDE.md files — Claude Code loads them as system
    // context at startup, invisible to PostToolUse hooks. We read them from
    // disk so they survive compact/resume via the session events pipeline.
    const sessionId = getSessionId(input);
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    db.ensureSession(sessionId, projectDir);
    const claudeMdPaths = [
      join(resolveConfigDir(), "CLAUDE.md"),
      join(projectDir, "CLAUDE.md"),
      join(projectDir, ".claude", "CLAUDE.md"),
    ];
    for (const p of claudeMdPaths) {
      try {
        const content = readFileSync(p, "utf-8");
        if (content.trim()) {
          db.insertEvent(sessionId, { type: "rule", category: "rule", data: p, priority: 1 });
          db.insertEvent(sessionId, { type: "rule_content", category: "rule", data: content, priority: 1 });
        }
      } catch { /* file doesn't exist — skip */ }
    }

    db.close();

    // Age-gated lazy cleanup of old plugin cache version dirs (#181).
    // Only delete dirs older than 1 hour to avoid breaking active sessions.
    try {
      const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
      if (pluginRoot) {
        const cacheParentMatch = pluginRoot.match(/^(.*[\\/]plugins[\\/]cache[\\/][^\\/]+[\\/][^\\/]+[\\/])/);
        if (cacheParentMatch) {
          const cacheParent = cacheParentMatch[1];
          const myDir = pluginRoot.replace(cacheParent, "").replace(/[\\/]/g, "");
          const ONE_HOUR = 3600000;
          const now = Date.now();
          for (const d of readdirSync(cacheParent)) {
            if (d === myDir) continue;
            try {
              const st = statSync(join(cacheParent, d));
              if (now - st.mtimeMs > ONE_HOUR) {
                rmSync(join(cacheParent, d), { recursive: true, force: true });
              }
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* best effort — never block session start */ }
  }
  // "clear" — no reset needed; ctx_purge is the only wipe mechanism
} catch (err) {
  // Session continuity is best-effort — never block session start
  try {
    const { appendFileSync } = await import("node:fs");
    const { join: pjoin } = await import("node:path");
    const { homedir } = await import("node:os");
    const { resolveConfigDir: _resolve } = await import("./session-helpers.mjs");
    appendFileSync(
      pjoin(_resolve(), "context-mode", "sessionstart-debug.log"),
      `[${new Date().toISOString()}] ${err?.message || err}\n${err?.stack || ""}\n`,
    );
  } catch { /* ignore logging failure */ }
}

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext,
  },
}));
