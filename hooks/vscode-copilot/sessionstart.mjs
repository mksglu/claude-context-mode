#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * VS Code Copilot SessionStart hook for context-mode (v1.0.107)
 *
 * Created to close the v1.0.107 audit-flagged path bug: hooks.ts:98
 * was resolving SessionStart to the Claude-Code generic top-level
 * `hooks/sessionstart.mjs`. With the fix, the path now resolves
 * to this file. Mirrors the JetBrains Copilot hook (same shape,
 * same Microsoft Copilot wire contract).
 *
 * Session lifecycle management:
 * - "startup"  → Cleanup old sessions, capture .github/copilot-instructions.md as rule events
 * - "compact"  → Write events file, inject session knowledge directive
 * - "resume"   → Load previous session events, inject directive
 * - "clear"    → No action needed
 */

import { createSessionLoaders } from "../session-loaders.mjs";
import { createRoutingBlock } from "../routing-block.mjs";
import { createToolNamer } from "../core/tool-naming.mjs";

const toolNamer = createToolNamer("vscode-copilot");
const ROUTING_BLOCK = createRoutingBlock(toolNamer);
import { writeSessionEventsFile, buildSessionDirective, getSessionEvents } from "../session-directive.mjs";
import {
  readStdin, parseStdin, getSessionId, getSessionDBPath, getSessionEventsPath, getCleanupFlagPath,
  getInputProjectDir, VSCODE_OPTS,
} from "../session-helpers.mjs";
import { join } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HOOK_DIR = fileURLToPath(new URL(".", import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);
const OPTS = VSCODE_OPTS;

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

    // Filter events to the session being resumed (cross-session bleed guard).
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

    // VSCode Copilot's canonical project-level instruction file.
    // Captured as rule_content events so they survive compact and become
    // searchable via ctx_search() — same pattern as Claude Code captures CLAUDE.md.
    const ruleFilePaths = [
      join(projectDir, ".github", "copilot-instructions.md"),
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
      pjoin(hd(), ".vscode", "context-mode", "sessionstart-debug.log"),
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
