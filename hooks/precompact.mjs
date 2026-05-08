#!/usr/bin/env node
/**
 * PreCompact hook for context-mode session continuity.
 *
 * Triggered when Claude Code is about to compact the conversation.
 * Reads all captured session events, builds a priority-sorted resume
 * snapshot (<2KB XML), and stores it for injection after compact.
 *
 * Crash-resilience: wrapped via runHook (#414).
 */

import { runHook } from "./run-hook.mjs";

await runHook(async () => {
  const {
    readStdin,
    parseStdin,
    getSessionId,
    getSessionDBPath,
    resolveConfigDir,
  } = await import("./session-helpers.mjs");
  const { createSessionLoaders } = await import("./session-loaders.mjs");
  const { appendFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  // Resolve absolute path for imports
  const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
  const { loadSessionDB, loadSnapshot } = createSessionLoaders(HOOK_DIR);
  const DEBUG_LOG = join(resolveConfigDir(), "context-mode", "precompact-debug.log");

  try {
    const raw = await readStdin();
    const input = parseStdin(raw);

    const { buildResumeSnapshot } = await loadSnapshot();
    const { SessionDB } = await loadSessionDB();

    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input);

    // Get all events for this session
    const events = db.getEvents(sessionId);

    if (events.length > 0) {
      const stats = db.getSessionStats(sessionId);
      const snapshot = buildResumeSnapshot(events, {
        compactCount: (stats?.compact_count ?? 0) + 1,
      });

      db.upsertResume(sessionId, snapshot, events.length);
      db.incrementCompactCount(sessionId);

      // Write compaction category event for analytics
      const fileEvents = events.filter(e => e.category === "file");
      db.insertEvent(sessionId, {
        type: "compaction_summary",
        category: "compaction",
        data: `Session compacted. ${events.length} events, ${fileEvents.length} files touched.`,
        priority: 1,
      }, "PreCompact");
    }

    db.close();
  } catch (err) {
    try {
      appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${err.message}\n`);
    } catch {
      // Silent fallback
    }
  }

  // PreCompact doesn't need hookSpecificOutput
  console.log(JSON.stringify({}));
});
