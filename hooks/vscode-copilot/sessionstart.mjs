#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * VS Code Copilot SessionStart hook for context-mode
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

const ROUTING_BLOCK = createRoutingBlock(createToolNamer("vscode-copilot"));
import { writeSessionEventsFile, buildSessionDirective, getSessionEvents, getLatestSessionEvents } from "../session-directive.mjs";
import {
  readStdin, getSessionId, getSessionDBPath, getSessionEventsPath, getCleanupFlagPath,
  getProjectDir, VSCODE_OPTS,
} from "../session-helpers.mjs";
import { join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const HOOK_DIR = fileURLToPath(new URL(".", import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);
const OPTS = VSCODE_OPTS;

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
      additionalContext += buildSessionDirective("compact", eventMeta);
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
      additionalContext += buildSessionDirective("resume", eventMeta);
    }

    db.close();
  } else if (source === "startup") {
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath(OPTS);
    const db = new SessionDB({ dbPath });
    try { unlinkSync(getSessionEventsPath(OPTS)); } catch { /* no stale file */ }

    const cleanupFlag = getCleanupFlagPath(OPTS);
    let previousWasFresh = false;
    try { readFileSync(cleanupFlag); previousWasFresh = true; } catch { /* no flag */ }

    if (previousWasFresh) {
      db.cleanupOldSessions(0);
    } else {
      db.cleanupOldSessions(7);
    }
    db.db.exec(`DELETE FROM session_events WHERE session_id NOT IN (SELECT session_id FROM session_meta)`);
    writeFileSync(cleanupFlag, new Date().toISOString(), "utf-8");

    const sessionId = getSessionId(input, OPTS);
    const projectDir = getProjectDir(OPTS);
    db.ensureSession(sessionId, projectDir);

    // Auto-write copilot-instructions.md on first startup if not present
    try {
      const { VSCodeCopilotAdapter } = await import(pathToFileURL(join(HOOK_DIR, "..", "..", "build", "adapters", "vscode-copilot", "index.js")).href);
      new VSCodeCopilotAdapter().writeRoutingInstructions(projectDir, join(HOOK_DIR, "..", ".."));
    } catch { /* best effort — don't block session start */ }

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

const output = `SessionStart:compact hook success: Success\nSessionStart hook additional context: \n${additionalContext}`;
process.stdout.write(output);
