#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Cursor stop hook — fires when the agent turn ends.
 *
 * Input:  { "conversation_id": "...", "status": "completed"|"error", "loop_count": N, "transcript_path": "..." }
 * Output: { "followup_message": "" }  (empty = don't continue the loop)
 */

import { readStdin, parseStdin, getSessionId, getSessionDBPath, getInputProjectDir, CURSOR_OPTS } from "../session-helpers.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionLoaders } from "../session-loaders.mjs";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);
const OPTS = CURSOR_OPTS;

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input, CURSOR_OPTS);

  if (projectDir && !process.env.CURSOR_CWD) {
    process.env.CURSOR_CWD = projectDir;
  }

  const { SessionDB } = await loadSessionDB();

  const dbPath = getSessionDBPath(OPTS);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, OPTS);

  db.ensureSession(sessionId, projectDir);
  db.insertEvent(sessionId, {
    type: "session_end",
    status: input.status ?? "completed",
    loop_count: input.loop_count ?? 0,
  }, "Stop");

  db.close();
} catch {
  // Cursor treats stderr as hook failure; swallow and continue.
}

// Emit empty followup — don't continue the agent loop.
process.stdout.write(JSON.stringify({ followup_message: "" }) + "\n");
