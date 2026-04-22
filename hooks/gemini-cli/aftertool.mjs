#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Gemini CLI AfterTool hook — session event capture.
 *
 * Captures session events from tool calls (13 categories) and stores
 * them in the per-project SessionDB for later resume snapshot building.
 *
 * Must be fast (<20ms). No network, no LLM, just SQLite writes.
 */

import { readStdin, getSessionId, getSessionDBPath, getInputProjectDir, GEMINI_OPTS } from "../session-helpers.mjs";
import { createSessionLoaders } from "../session-loaders.mjs";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);
const OPTS = GEMINI_OPTS;
const DEBUG_LOG = join(homedir(), ".gemini", "context-mode", "aftertool-debug.log");

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
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

  const sessionStats = db.getSessionStats(sessionId);
  const lastKnownProjectDir = typeof db.getLatestAttributedProjectDir === "function"
    ? db.getLatestAttributedProjectDir(sessionId)
    : null;
  const attributions = resolveProjectAttributions(events, {
    sessionOriginDir: sessionStats?.project_dir || projectDir,
    inputProjectDir: projectDir,
    workspaceRoots: Array.isArray(input.workspace_roots) ? input.workspace_roots : [],
    lastKnownProjectDir,
  });

  for (let i = 0; i < events.length; i++) {
    db.insertEvent(sessionId, events[i], "AfterTool", attributions[i]);
  }

  appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] OK: ${input.tool_name} → ${events.length} events\n`);
  db.close();
} catch (err) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ERR: ${err?.message || err}\n`);
  } catch { /* silent */ }
}

// AfterTool is non-blocking — no stdout output
