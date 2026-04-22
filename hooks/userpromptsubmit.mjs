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

import { readStdin, getSessionId, getSessionDBPath, getInputProjectDir } from "./session-helpers.mjs";
import { createSessionLoaders } from "./session-loaders.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const projectDir = getInputProjectDir(input);

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
    const { resolveProjectAttributions } = await loadProjectAttribution();
    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input);

    db.ensureSession(sessionId, projectDir);
    const sessionStats = db.getSessionStats(sessionId);
    const lastKnownProjectDir = typeof db.getLatestAttributedProjectDir === "function"
      ? db.getLatestAttributedProjectDir(sessionId)
      : null;

    // 1. Always save the raw prompt
    const promptEvent = {
      type: "user_prompt",
      category: "prompt",
      data: prompt,
      priority: 1,
    };
    const promptAttribution = resolveProjectAttributions([promptEvent], {
      sessionOriginDir: sessionStats?.project_dir || projectDir,
      inputProjectDir: projectDir,
      workspaceRoots: Array.isArray(input.workspace_roots) ? input.workspace_roots : [],
      lastKnownProjectDir,
    })[0];
    db.insertEvent(sessionId, promptEvent, "UserPromptSubmit", promptAttribution);

    // 2. Extract decision/role/intent/data from user message
    const userEvents = extractUserEvents(trimmed);
    const userAttributions = resolveProjectAttributions(userEvents, {
      sessionOriginDir: sessionStats?.project_dir || projectDir,
      inputProjectDir: projectDir,
      workspaceRoots: Array.isArray(input.workspace_roots) ? input.workspace_roots : [],
      lastKnownProjectDir: promptAttribution?.projectDir || lastKnownProjectDir,
    });
    for (let i = 0; i < userEvents.length; i++) {
      db.insertEvent(sessionId, userEvents[i], "UserPromptSubmit", userAttributions[i]);
    }

    db.close();
  }
} catch {
  // UserPromptSubmit must never block the session — silent fallback
}
