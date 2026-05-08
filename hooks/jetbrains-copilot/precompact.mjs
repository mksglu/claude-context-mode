#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * JetBrains Copilot PreCompact hook — snapshot generation.
 *
 * Triggered when JetBrains Copilot is about to compact the conversation.
 * Reads all captured session events, builds a priority-sorted resume
 * snapshot (<2KB XML), and stores it for injection after compact.
 */

import { createSessionLoaders } from "../session-loaders.mjs";
import { readStdin, parseStdin, getSessionId, getSessionDBPath, JETBRAINS_OPTS } from "../session-helpers.mjs";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadSnapshot } = createSessionLoaders(HOOK_DIR);
const OPTS = JETBRAINS_OPTS;
const DEBUG_LOG = join(homedir(), ".config", "JetBrains", "context-mode", "precompact-debug.log");

try {
  const raw = await readStdin();
  const input = parseStdin(raw);

  const { buildResumeSnapshot } = await loadSnapshot();
  const { SessionDB } = await loadSessionDB();

  const dbPath = getSessionDBPath(OPTS);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, OPTS);

  const events = db.getEvents(sessionId);

  if (events.length > 0) {
    const stats = db.getSessionStats(sessionId);
    const snapshot = buildResumeSnapshot(events, {
      compactCount: (stats?.compact_count ?? 0) + 1,
    });

    db.upsertResume(sessionId, snapshot, events.length);
    db.incrementCompactCount(sessionId);
  }

  db.close();
} catch (err) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${err?.message || err}\n`);
  } catch { /* silent */ }
}

// PreCompact — no stdout output needed
