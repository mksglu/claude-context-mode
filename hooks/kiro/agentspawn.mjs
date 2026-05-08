#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Kiro CLI agentSpawn hook for context-mode.
 *
 * agentSpawn is the Kiro semantic equivalent of Claude Code's SessionStart:
 * fires once when an agent loads. We use it to inject the routing block and
 * (on resume/compact) the session-resume directive.
 *
 * Source: https://kiro.dev/docs/cli/hooks
 */

import { createRoutingBlock } from "../routing-block.mjs";
import { createToolNamer } from "../core/tool-naming.mjs";

const toolNamer = createToolNamer("kiro");
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
  KIRO_OPTS,
} from "../session-helpers.mjs";
import { createSessionLoaders } from "../session-loaders.mjs";
import { unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HOOK_DIR = fileURLToPath(new URL(".", import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);
const OPTS = KIRO_OPTS;

let additionalContext = ROUTING_BLOCK;

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  // Kiro stdin shape mirrors codex/CC: { source, cwd, ... }. Default startup
  // when no source provided (single-shot agent spawn).
  const source = input.source ?? "startup";
  const projectDir = getInputProjectDir(input, OPTS);

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
  // Swallow errors — hook must not fail
}

// Kiro CLI agentSpawn JSON output shape mirrors CC SessionStart.
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "agentSpawn", additionalContext },
}) + "\n");
