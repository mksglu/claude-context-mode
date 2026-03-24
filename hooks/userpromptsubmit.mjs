#!/usr/bin/env node
import "./suppress-stderr.mjs";
import "./ensure-deps.mjs";
/**
 * UserPromptSubmit hook for context-mode session continuity.
 *
 * Captures every user prompt so the LLM can continue from the exact
 * point where the user left off after compact or session restart.
 *
 * Must be fast (<10ms). Just a single SQLite write.
 */

import { readStdin, getSessionId, getSessionDBPath } from "./session-helpers.mjs";
import { createSessionLoaders } from "./session-loaders.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract } = createSessionLoaders(HOOK_DIR);

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const prompt = input.prompt ?? input.message ?? "";
  const trimmed = (prompt || "").trim();

  // Skip system-generated messages — only capture genuine user prompts
  const isSystemMessage = trimmed.startsWith("<task-notification>")
    || trimmed.startsWith("<system-reminder>")
    || trimmed.startsWith("<context_guidance>")
    || trimmed.startsWith("<tool-result>");

  if (trimmed.length > 0 && !isSystemMessage) {
    const { SessionDB } = await loadSessionDB();
    const { extractUserEvents } = await loadExtract();
    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input);

    db.ensureSession(sessionId, process.env.CLAUDE_PROJECT_DIR || process.cwd());

    // 1. Always save the raw prompt
    db.insertEvent(sessionId, {
      type: "user_prompt",
      category: "prompt",
      data: prompt,
      priority: 1,
    }, "UserPromptSubmit");

    // 2. Extract decision/role/intent/data from user message
    const userEvents = extractUserEvents(trimmed);
    for (const ev of userEvents) {
      db.insertEvent(sessionId, ev, "UserPromptSubmit");
    }

    db.close();
  }
} catch {
  // UserPromptSubmit must never block the session — silent fallback
}
