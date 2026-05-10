#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Cursor sessionStart hook for context-mode.
 */

import { createRoutingBlock } from "../routing-block.mjs";
import { createToolNamer } from "../core/tool-naming.mjs";

const toolNamer = createToolNamer("cursor");
const ROUTING_BLOCK = createRoutingBlock(toolNamer);
import {
  writeSessionEventsFile,
  buildSessionDirective,
  getSessionEvents,
} from "../session-directive.mjs";
import {
  readStdin,
  parseStdin,
  getSessionId,
  getSessionDBPath,
  getSessionEventsPath,
  getCleanupFlagPath,
  getInputProjectDir,
  CURSOR_OPTS,
} from "../session-helpers.mjs";
import { unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSessionLoaders } from "../session-loaders.mjs";

const HOOK_DIR = fileURLToPath(new URL(".", import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);
const OPTS = CURSOR_OPTS;

let additionalContext = ROUTING_BLOCK;

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const source = input.source ?? input.trigger ?? "startup";
  const projectDir = getInputProjectDir(input, CURSOR_OPTS);

  if (projectDir && !process.env.CURSOR_CWD) {
    process.env.CURSOR_CWD = projectDir;
  }

  if (source === "compact" || source === "resume") {
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath(OPTS, projectDir);
    const db = new SessionDB({ dbPath });

    if (source === "compact") {
      const sessionId = getSessionId(input, OPTS);
      const resume = db.getResume(sessionId);
      if (resume && !resume.consumed) {
        db.markResumeConsumed(sessionId);
      }
    } else {
      try { unlinkSync(getCleanupFlagPath(OPTS, projectDir)); } catch { /* no flag */ }
    }

    // Filter events to the session being resumed/compacted. Falling back to
    // getLatestSessionEvents(db) for resume leaks events from any other
    // session whose session_meta.started_at is more recent — observed
    // cross-session bleed when a different session started after this one
    // and before the resume.
    const sessionId = getSessionId(input, OPTS);
    const events = sessionId ? getSessionEvents(db, sessionId) : [];
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath(OPTS, projectDir));
      additionalContext += buildSessionDirective(source, eventMeta, toolNamer);
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

    db.close();
  }
  // clear => routing block only
} catch {
  // Cursor treats stderr as hook failure; swallow and continue.
}

// Cursor treats empty stdout as an invalid hook response,
// so SessionStart always emits an explicit additional_context payload.
process.stdout.write(JSON.stringify({ additional_context: additionalContext }) + "\n");
