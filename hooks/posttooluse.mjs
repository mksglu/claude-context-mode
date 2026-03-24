#!/usr/bin/env node
import "./suppress-stderr.mjs";
import "./ensure-deps.mjs";
/**
 * PostToolUse hook for context-mode session continuity.
 *
 * Captures session events from tool calls (13 categories) and stores
 * them in the per-project SessionDB for later resume snapshot building.
 *
 * Must be fast (<20ms). No network, no LLM, just SQLite writes.
 */

import { readStdin, getSessionId, getSessionDBPath } from "./session-helpers.mjs";
import { createSessionLoaders } from "./session-loaders.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve absolute path for imports — relative dynamic imports can fail
// when Claude Code invokes hooks from a different working directory.
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract } = createSessionLoaders(HOOK_DIR);

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const { extractEvents } = await loadExtract();
  const { SessionDB } = await loadSessionDB();

  const dbPath = getSessionDBPath();
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input);

  // Ensure session meta exists
  db.ensureSession(sessionId, process.env.CLAUDE_PROJECT_DIR || process.cwd());

  // Extract and store events
  const events = extractEvents({
    tool_name: input.tool_name,
    tool_input: input.tool_input ?? {},
    tool_response: typeof input.tool_response === "string"
      ? input.tool_response
      : JSON.stringify(input.tool_response ?? ""),
    tool_output: input.tool_output,
  });

  for (const event of events) {
    db.insertEvent(sessionId, event, "PostToolUse");
  }

  db.close();
} catch {
  // PostToolUse must never block the session — silent fallback
}

// PostToolUse hooks don't need hookSpecificOutput
