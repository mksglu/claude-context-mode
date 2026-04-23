#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * JetBrains Copilot SessionStart hook for context-mode
 *
 * Session lifecycle management:
 * - "startup"  → Cleanup old sessions, capture instruction file rules
 * - "compact"  → Write events file, inject session knowledge directive
 * - "resume"   → Load previous session events, inject directive
 * - "clear"    → No action needed
 */

import { createSessionLoaders } from "../session-loaders.mjs";
import { createRoutingBlock } from "../routing-block.mjs";
import { createToolNamer } from "../core/tool-naming.mjs";

const toolNamer = createToolNamer("jetbrains-copilot");
const ROUTING_BLOCK = createRoutingBlock(toolNamer);
import { writeSessionEventsFile, buildSessionDirective, getSessionEvents, getLatestSessionEvents } from "../session-directive.mjs";
import {
  readStdin, getSessionId, getSessionDBPath, getSessionEventsPath, getCleanupFlagPath,
  getProjectDir, JETBRAINS_OPTS,
} from "../session-helpers.mjs";
import { join } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const HOOK_DIR = fileURLToPath(new URL(".", import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);
const OPTS = JETBRAINS_OPTS;

let additionalContext = ROUTING_BLOCK;

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const source = input.source ?? "startup";

  if (source === "compact") {
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath(OPTS);
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input, OPTS);
    const resume = db.getResume(sessionId);

    if (resume && !resume.consumed) {
      db.markResumeConsumed(sessionId);
    }

    const events = getSessionEvents(db, sessionId);
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath(OPTS));
      additionalContext += buildSessionDirective("compact", eventMeta, toolNamer);
    }

    db.close();
  } else if (source === "resume") {
    try { unlinkSync(getCleanupFlagPath(OPTS)); } catch { /* no flag */ }

    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath(OPTS);
    const db = new SessionDB({ dbPath });

    const events = getLatestSessionEvents(db);
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath(OPTS));
      additionalContext += buildSessionDirective("resume", eventMeta, toolNamer);
    }

    db.close();
  } else if (source === "startup") {
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath(OPTS);
    const db = new SessionDB({ dbPath });
    try { unlinkSync(getSessionEventsPath(OPTS)); } catch { /* no stale file */ }

    db.cleanupOldSessions(7);
    db.db.exec(`DELETE FROM session_events WHERE session_id NOT IN (SELECT session_id FROM session_meta)`);

    const sessionId = getSessionId(input, OPTS);
    const projectDir = getProjectDir(OPTS);
    db.ensureSession(sessionId, projectDir);

    // Auto-write copilot-instructions.md on first startup if not present
    try {
      const { JetBrainsCopilotAdapter } = await import(pathToFileURL(join(HOOK_DIR, "..", "..", "build", "adapters", "jetbrains-copilot", "index.js")).href);
      const adapter = new JetBrainsCopilotAdapter();
      adapter.writeRoutingInstructions?.(projectDir, join(HOOK_DIR, "..", ".."));
    } catch { /* best effort — don't block session start */ }

    // Prefer JetBrains convention; fall back to GitHub Copilot convention.
    const ruleFilePaths = [
      join(projectDir, ".idea", "copilot-instructions.md"),
      join(projectDir, ".github", "copilot-instructions.md"),
    ];
    for (const p of ruleFilePaths) {
      try {
        const content = readFileSync(p, "utf-8");
        if (content.trim()) {
          db.insertEvent(sessionId, { type: "rule", category: "rule", data: p, priority: 1 });
          db.insertEvent(sessionId, { type: "rule_content", category: "rule", data: content, priority: 1 });
          break;
        }
      } catch { /* file doesn't exist — try next */ }
    }

    db.close();
  }
  // "clear" — no action needed
} catch (err) {
  try {
    const { appendFileSync, mkdirSync } = await import("node:fs");
    const { join: pjoin } = await import("node:path");
    const { homedir: hd } = await import("node:os");
    const debugDir = pjoin(hd(), ".config", "JetBrains", "context-mode");
    mkdirSync(debugDir, { recursive: true });
    appendFileSync(
      pjoin(debugDir, "sessionstart-debug.log"),
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
