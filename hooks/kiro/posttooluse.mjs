#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Kiro CLI PostToolUse hook — session event capture.
 * Must be fast (<20ms). No network, no LLM, just SQLite writes.
 *
 * Source: https://kiro.dev/docs/cli/hooks/
 */

import { readStdin, parseStdin, getSessionId, getSessionDBPath, getInputProjectDir, KIRO_OPTS } from "../session-helpers.mjs";
import { createSessionLoaders, attributeAndInsertEvents } from "../session-loaders.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);
const OPTS = KIRO_OPTS;

try {
  const raw = await readStdin();
  const input = parseStdin(raw);

  const { extractEvents } = await loadExtract();
  const { resolveProjectAttributions } = await loadProjectAttribution();
  const { SessionDB } = await loadSessionDB();

  const sessionId = getSessionId(input, OPTS);
  const projectDir = getInputProjectDir(input, OPTS);
  const dbPath = getSessionDBPath(OPTS, projectDir);
  const db = new SessionDB({ dbPath });

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

  db.close();
} catch {
  // Non-blocking — swallow errors silently
}

// PostToolUse is non-blocking — no stdout output
