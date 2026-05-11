#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Codex CLI Stop hook — record turn/session end state for continuity.
 */

import { readStdin, parseStdin, getSessionId, getSessionDBPath, getInputProjectDir, CODEX_OPTS } from "../session-helpers.mjs";
import { createSessionLoaders } from "../session-loaders.mjs";
import { buildContinuousMemoryCapsule, isMemoryGovernorEnabled } from "./memory-governor.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);
const OPTS = CODEX_OPTS;

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input, OPTS);
  const memoryGovernorEnabled = isMemoryGovernorEnabled();

  const { SessionDB } = await loadSessionDB();
  const dbPath = getSessionDBPath(OPTS, projectDir);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, OPTS);

  db.ensureSession(sessionId, projectDir);
  db.insertEvent(sessionId, {
    type: "session_end",
    category: "session",
    data: JSON.stringify({
      status: "completed",
      stop_hook_active: input.stop_hook_active ?? false,
      last_assistant_message: typeof input.last_assistant_message === "string"
        ? input.last_assistant_message.slice(0, 2000)
        : null,
    }),
    priority: 2,
  }, "Stop");

  if (memoryGovernorEnabled) {
    db.deleteWorkingStateCapsules(sessionId);
    const events = db.getEvents(sessionId);
    const capsule = buildContinuousMemoryCapsule(events, {
      source: "stop",
      searchTool: "ctx_search",
    });
    if (capsule) {
      db.insertEvent(sessionId, {
        type: "working_state_capsule",
        category: "memory-governor",
        data: capsule,
        priority: 5,
      }, "Stop", {
        projectDir,
        source: "stop",
        confidence: 1,
      });
    }
  }

  db.close();
} catch {
  // Codex hooks must not block the session.
}

process.stdout.write("{}\n");
