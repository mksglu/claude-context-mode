#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * JetBrains Copilot PostToolUse hook — session event capture.
 *
 * Captures session events from tool calls (13 categories) and stores
 * them in the per-project SessionDB for later resume snapshot building.
 *
 * Must be fast (<20ms). No network, no LLM, just SQLite writes.
 */

import { createSessionLoaders, attributeAndInsertEvents } from "../session-loaders.mjs";
import { readStdin, parseStdin, getSessionId, getSessionDBPath, getInputProjectDir, JETBRAINS_OPTS } from "../session-helpers.mjs";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);
const OPTS = JETBRAINS_OPTS;
const DEBUG_LOG = join(homedir(), ".config", "JetBrains", "context-mode", "posttooluse-debug.log");

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input, OPTS);

  appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] CALL: ${input.tool_name}\n`);

  const { extractEvents } = await loadExtract();
  const { resolveProjectAttributions } = await loadProjectAttribution();
  const { SessionDB } = await loadSessionDB();

  const dbPath = getSessionDBPath(OPTS);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, OPTS);

  db.ensureSession(sessionId, projectDir);

  const events = extractEvents({
    tool_name: input.tool_name,
    tool_input: input.tool_input ?? {},
    tool_response: typeof input.tool_response === "string"
      ? input.tool_response
      : JSON.stringify(input.tool_response ?? ""),
    tool_output: input.tool_output,
  });

  attributeAndInsertEvents(db, sessionId, events, input, projectDir, "PostToolUse", resolveProjectAttributions);

  appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] OK: ${input.tool_name} → ${events.length} events\n`);
  db.close();
} catch (err) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ERR: ${err?.message || err}\n`);
  } catch { /* silent */ }
}

// PostToolUse — no stdout output
