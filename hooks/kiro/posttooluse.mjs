#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Kiro CLI PostToolUse hook — session event capture.
 * Must be fast (<20ms). No network, no LLM, just SQLite writes.
 *
 * Source: https://kiro.dev/docs/cli/hooks/
 */

import { readStdin, getSessionId, getSessionDBPath, getInputProjectDir, KIRO_OPTS } from "../session-helpers.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_SESSION = join(HOOK_DIR, "..", "..", "build", "session");
const OPTS = KIRO_OPTS;

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const { extractEvents } = await import(pathToFileURL(join(PKG_SESSION, "extract.js")).href);
  const { SessionDB } = await import(pathToFileURL(join(PKG_SESSION, "db.js")).href);

  const dbPath = getSessionDBPath(OPTS);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, OPTS);
  const projectDir = getInputProjectDir(input, OPTS);

  db.ensureSession(sessionId, projectDir);

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
  // Non-blocking — swallow errors silently
}

// PostToolUse is non-blocking — no stdout output
