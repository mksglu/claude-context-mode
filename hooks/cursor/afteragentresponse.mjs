#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Cursor afterAgentResponse hook — fires once Cursor finishes streaming
 * the assistant turn back to the user (per Cursor v1 hook docs:
 * https://cursor.com/docs/agent/hooks#afteragentresponse).
 *
 * Input:  { "conversation_id": "...", "generation_id": "...", "text": "<final assistant message>" }
 * Output: { "additional_context": "" }  (Cursor rejects empty stdout, so emit a no-op payload)
 *
 * The hook records the agent_response event so session analytics + the
 * resume directive can reconstruct the last assistant turn. Mirrors
 * stop.mjs (turn lifecycle telemetry) — afterAgentResponse fires
 * BEFORE stop, so we capture the produced text here while stop captures
 * loop_count + final status.
 */

import {
  readStdin,
  parseStdin,
  getSessionId,
  getSessionDBPath,
  getInputProjectDir,
  CURSOR_OPTS,
} from "../session-helpers.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionLoaders } from "../session-loaders.mjs";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);
const OPTS = CURSOR_OPTS;

// Truncate large assistant responses before persisting — keeps the
// session_events table from ballooning when an agent emits long output.
const MAX_TEXT_BYTES = 8 * 1024;

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input, CURSOR_OPTS);

  if (projectDir && !process.env.CURSOR_CWD) {
    process.env.CURSOR_CWD = projectDir;
  }

  const text = typeof input.text === "string" ? input.text : "";
  const truncated = text.length > MAX_TEXT_BYTES
    ? text.slice(0, MAX_TEXT_BYTES)
    : text;

  const { SessionDB } = await loadSessionDB();
  const dbPath = getSessionDBPath(OPTS, projectDir);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, OPTS);

  db.ensureSession(sessionId, projectDir);
  db.insertEvent(sessionId, {
    type: "agent_response",
    generation_id: input.generation_id ?? null,
    text_bytes: text.length,
    truncated: text.length > MAX_TEXT_BYTES,
    text: truncated,
  }, "AfterAgentResponse");

  db.close();
} catch {
  // Cursor treats stderr as hook failure; swallow and continue.
}

// Cursor rejects empty stdout as "no valid response", so emit a no-op
// additional_context payload (same convention as sessionstart.mjs).
process.stdout.write(JSON.stringify({ additional_context: "" }) + "\n");
