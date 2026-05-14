#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Gemini CLI SessionStart hook for context-mode
 *
 * Session lifecycle management:
 * - "startup"  → Cleanup old sessions, capture GEMINI.md rules
 * - "compact"  → Write events file, inject session knowledge directive
 * - "resume"   → Load previous session events, inject directive
 * - "clear"    → No action needed
 */

import { createRoutingBlock } from "../routing-block.mjs";
import { createToolNamer } from "../core/tool-naming.mjs";

const toolNamer = createToolNamer("gemini-cli");
const ROUTING_BLOCK = createRoutingBlock(toolNamer);
import { writeSessionEventsFile, buildSessionDirective, getSessionEvents } from "../session-directive.mjs";
import {
  readStdin, parseStdin, getSessionId, getSessionDBPath, getSessionEventsPath, getCleanupFlagPath,
  getInputProjectDir, GEMINI_OPTS,
} from "../session-helpers.mjs";
import { createSessionLoaders } from "../session-loaders.mjs";
import { join, dirname } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);
const OPTS = GEMINI_OPTS;

let additionalContext = ROUTING_BLOCK;

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const source = input.source ?? "startup";
  const projectDir = getInputProjectDir(input, OPTS);

  if (source === "compact") {
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath(OPTS, projectDir);
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input, OPTS);
    const resume = db.getResume(sessionId);

    if (resume && !resume.consumed) {
      db.markResumeConsumed(sessionId);
    }

    const events = getSessionEvents(db, sessionId);
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath(OPTS, projectDir));
      additionalContext += buildSessionDirective("compact", eventMeta, toolNamer);
    }

    db.close();
  } else if (source === "resume") {
    try { unlinkSync(getCleanupFlagPath(OPTS, projectDir)); } catch { /* no flag */ }

    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath(OPTS, projectDir);
    const db = new SessionDB({ dbPath });

    // Filter events to the session being resumed. Falling back to
    // getLatestSessionEvents(db) leaks events from any other session whose
    // session_meta.started_at is more recent — observed cross-session bleed
    // when a different session started after this one and before the resume.
    const sessionId = getSessionId(input, OPTS);
    const events = sessionId ? getSessionEvents(db, sessionId) : [];
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath(OPTS, projectDir));
      additionalContext += buildSessionDirective("resume", eventMeta, toolNamer);
    }

    db.close();
  } else if (source === "startup") {
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath(OPTS, projectDir);
    const db = new SessionDB({ dbPath });
    try { unlinkSync(getSessionEventsPath(OPTS, projectDir)); } catch { /* no stale file */ }

    db.cleanupOldSessions(7);
    db.db.exec(`DELETE FROM session_events WHERE session_id NOT IN (SELECT session_id FROM session_meta)`);

    const sessionId = getSessionId(input, OPTS);
    db.ensureSession(sessionId, projectDir);

    // NOTE (#558): excised the old GEMINI.md auto-write block. It loaded an
    // adapter from build/ (gitignored, missing on marketplace installs) and
    // called a method that was deleted from every adapter in commit 6dae20c.
    // Both layers were silently no-op'd by the surrounding try/catch on every
    // install path for many releases. If routing-instruction auto-write is
    // reintroduced it must come with its own PRD, method spec, and format
    // tests — out of scope for the security regression fix.

    const ruleFilePaths = [
      join(homedir(), ".gemini", "GEMINI.md"),
      join(projectDir, "GEMINI.md"),
    ];
    for (const p of ruleFilePaths) {
      try {
        const content = readFileSync(p, "utf-8");
        if (content.trim()) {
          db.insertEvent(sessionId, { type: "rule", category: "rule", data: p, priority: 1 });
          db.insertEvent(sessionId, { type: "rule_content", category: "rule", data: content, priority: 1 });
        }
      } catch { /* file doesn't exist — skip */ }
    }

    db.close();
  }
  // "clear" — no action needed
} catch (err) {
  try {
    const { appendFileSync } = await import("node:fs");
    const { join: pjoin } = await import("node:path");
    const { homedir: hd } = await import("node:os");
    appendFileSync(
      pjoin(hd(), ".gemini", "context-mode", "sessionstart-debug.log"),
      `[${new Date().toISOString()}] ${err?.message || err}\n${err?.stack || ""}\n`,
    );
  } catch { /* ignore logging failure */ }
}

// Emit structured JSON rather than plain text so Gemini CLI treats the
// routing block as hook metadata instead of user-visible output (#299).
// Matches the format already used by Claude Code and VS Code Copilot
// SessionStart hooks.
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext,
  },
}));
