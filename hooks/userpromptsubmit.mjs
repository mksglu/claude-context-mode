#!/usr/bin/env node
/**
 * UserPromptSubmit hook for context-mode session continuity.
 *
 * Captures every user prompt so the LLM can continue from the exact
 * point where the user left off after compact or session restart.
 *
 * Must be fast (<10ms). Just a single SQLite write.
 *
 * Crash-resilience: wrapped via runHook (#414) — module loads happen
 * dynamically so missing deps log + exit 0 instead of MODULE_NOT_FOUND.
 */

import { runHook } from "./run-hook.mjs";

await runHook(async () => {
  const {
    readStdin,
    parseStdin,
    getSessionId,
    getSessionDBPath,
    getInputProjectDir,
  } = await import("./session-helpers.mjs");
  const { createSessionLoaders, attributeAndInsertEvents } = await import("./session-loaders.mjs");
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
  const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);

  try {
    const raw = await readStdin();
    const input = parseStdin(raw);
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

      // 1. Always save the raw prompt
      const promptEvent = {
        type: "user_prompt",
        category: "user-prompt",
        data: prompt,
        priority: 1,
      };
      const promptAttributions = attributeAndInsertEvents(
        db, sessionId, [promptEvent], input, projectDir, "UserPromptSubmit", resolveProjectAttributions,
      );

      // 2. Extract decision/role/intent/data from user message
      const userEvents = extractUserEvents(trimmed);
      // Feed lastKnownProjectDir from the first attribution into the second batch
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
        db.insertEvent(sessionId, userEvents[i], "UserPromptSubmit", userAttributions[i]);
      }

      db.close();
    }
  } catch {
    // UserPromptSubmit must never block the session — silent fallback
  }
});
