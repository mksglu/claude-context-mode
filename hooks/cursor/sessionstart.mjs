#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Cursor sessionStart hook for context-mode.
 */

import { createRoutingBlock } from "../routing-block.mjs";
import { createToolNamer } from "../core/tool-naming.mjs";

const ROUTING_BLOCK = createRoutingBlock(createToolNamer("cursor"));
import {
  writeSessionEventsFile,
  buildSessionDirective,
  getSessionEvents,
  getLatestSessionEvents,
} from "../session-directive.mjs";
import {
  readStdin,
  getSessionId,
  getSessionDBPath,
  getSessionEventsPath,
  getCleanupFlagPath,
  getInputProjectDir,
  CURSOR_OPTS,
} from "../session-helpers.mjs";
import { join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_DIR = fileURLToPath(new URL(".", import.meta.url));
const PKG_SESSION = join(HOOK_DIR, "..", "..", "build", "session");
const OPTS = CURSOR_OPTS;

let additionalContext = ROUTING_BLOCK;

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const source = input.source ?? input.trigger ?? "startup";
  const projectDir = getInputProjectDir(input, CURSOR_OPTS);

  if (projectDir && !process.env.CURSOR_CWD) {
    process.env.CURSOR_CWD = projectDir;
  }

  if (source === "compact" || source === "resume") {
    const { SessionDB } = await import(pathToFileURL(join(PKG_SESSION, "db.js")).href);
    const dbPath = getSessionDBPath(OPTS);
    const db = new SessionDB({ dbPath });

    if (source === "compact") {
      const sessionId = getSessionId(input, OPTS);
      const resume = db.getResume(sessionId);
      if (resume && !resume.consumed) {
        db.markResumeConsumed(sessionId);
      }
    } else {
      try { unlinkSync(getCleanupFlagPath(OPTS)); } catch { /* no flag */ }
    }

    const events = source === "compact"
      ? getSessionEvents(db, getSessionId(input, OPTS))
      : getLatestSessionEvents(db);
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath(OPTS));
      additionalContext += buildSessionDirective(source, eventMeta);
    }

    db.close();
  } else if (source === "startup") {
    const { SessionDB } = await import(pathToFileURL(join(PKG_SESSION, "db.js")).href);
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
    db.ensureSession(sessionId, projectDir);

    db.close();
  }
  // clear => routing block only
} catch {
  // Cursor treats stderr as hook failure; swallow and continue.
}

// Cursor treats empty stdout as an invalid hook response,
// so SessionStart always emits an explicit additional_context payload.
process.stdout.write(JSON.stringify({ additional_context: additionalContext }) + "\n");
