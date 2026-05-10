#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Gemini CLI BeforeAgent hook — UserPromptSubmit equivalent.
 *
 * Captures every user prompt so the LLM can resume from the exact point
 * the user left off after compact / resume. Mirrors hooks/userpromptsubmit.mjs
 * but reads `input.prompt` (Gemini wire shape, types.ts:547-549) and emits
 * `hookSpecificOutput.hookEventName: "BeforeAgent"` (types.ts:554-559) so
 * Gemini's hookRunner appends additionalContext to the prompt
 * (hookRunner.ts:183-197).
 *
 * Must be fast (<10ms). Single SQLite write.
 */

import {
  readStdin,
  parseStdin,
  getSessionId,
  getSessionDBPath,
  getInputProjectDir,
  GEMINI_OPTS,
} from "../session-helpers.mjs";
import { createSessionLoaders, attributeAndInsertEvents } from "../session-loaders.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);
const OPTS = GEMINI_OPTS;

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input, OPTS);

  const prompt = input.prompt ?? input.message ?? "";
  const trimmed = (prompt || "").trim();

  // Skip system-generated messages — only capture genuine user prompts.
  const isSystemMessage = trimmed.startsWith("<task-notification>")
    || trimmed.startsWith("<system-reminder>")
    || trimmed.startsWith("<context_guidance>")
    || trimmed.startsWith("<tool-result>");

  if (trimmed.length > 0 && !isSystemMessage) {
    const { SessionDB } = await loadSessionDB();
    const { extractUserEvents } = await loadExtract();
    const { resolveProjectAttributions } = await loadProjectAttribution();
    const dbPath = getSessionDBPath(OPTS, projectDir);
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input, OPTS);

    db.ensureSession(sessionId, projectDir);

    // 1. Always save the raw prompt.
    const promptEvent = {
      type: "user_prompt",
      category: "user-prompt",
      data: prompt,
      priority: 1,
    };
    const promptAttributions = attributeAndInsertEvents(
      db, sessionId, [promptEvent], input, projectDir, "BeforeAgent", resolveProjectAttributions,
    );

    // 2. Extract decision/role/intent/data from user message.
    const userEvents = extractUserEvents(trimmed);
    const savedLastKnown = promptAttributions[0]?.projectDir || null;
    const sessionStats = db.getSessionStats(sessionId);
    const lastKnownProjectDir = typeof db.getLatestAttributedProjectDir === "function"
      ? db.getLatestAttributedProjectDir(sessionId)
      : null;
    const userAttributions = resolveProjectAttributions(userEvents, {
      sessionOriginDir: sessionStats?.project_dir || projectDir,
      inputProjectDir: projectDir,
      workspaceRoots: Array.isArray(input.workspace_roots) ? input.workspace_roots : [],
      lastKnownProjectDir: savedLastKnown || lastKnownProjectDir,
    });
    for (let i = 0; i < userEvents.length; i++) {
      db.insertEvent(sessionId, userEvents[i], "BeforeAgent", userAttributions[i]);
    }

    db.close();
  }
} catch {
  // BeforeAgent must never block the session — silent fallback.
}

// Emit empty additionalContext so Gemini's hookRunner treats the response as
// metadata (no prompt mutation). Matches the SessionStart hook's structured-
// output convention (sessionstart.mjs:130-135).
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "BeforeAgent",
    additionalContext: "",
  },
}));
