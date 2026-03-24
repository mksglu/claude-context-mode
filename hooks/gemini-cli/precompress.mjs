#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Gemini CLI PreCompress hook — snapshot generation.
 *
 * Triggered when Gemini CLI is about to compress the conversation.
 * Reads all captured session events, builds a priority-sorted resume
 * snapshot (<2KB XML), and stores it for injection after compress.
 */

import { readStdin, getSessionId, getSessionDBPath, GEMINI_OPTS } from "../session-helpers.mjs";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_SESSION = join(HOOK_DIR, "..", "..", "build", "session");
const OPTS = GEMINI_OPTS;
const DEBUG_LOG = join(homedir(), ".gemini", "context-mode", "precompress-debug.log");

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const { buildResumeSnapshot } = await import(pathToFileURL(join(PKG_SESSION, "snapshot.js")).href);
  const { SessionDB } = await import(pathToFileURL(join(PKG_SESSION, "db.js")).href);

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

// PreCompress is advisory — no stdout output needed
