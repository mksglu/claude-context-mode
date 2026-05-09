#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Codex CLI postToolUse hook — session event capture.
 */

import { readStdin, parseStdin, getSessionId, getSessionDBPath, getInputProjectDir, CODEX_OPTS } from "../session-helpers.mjs";
import { createSessionLoaders, attributeAndInsertEvents } from "../session-loaders.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);
const OPTS = CODEX_OPTS;

function normalizeToolName(toolName) {
  // Keep Codex-native tool names like apply_patch intact; only normalize
  // legacy shell aliases that should route through the Bash extractors.
  if (toolName === "Shell") return "Bash";
  return toolName;
}

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input, OPTS);

  const { extractEvents } = await loadExtract();
  const { resolveProjectAttributions } = await loadProjectAttribution();
  const { SessionDB } = await loadSessionDB();

  const dbPath = getSessionDBPath(OPTS, projectDir);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, OPTS);

  db.ensureSession(sessionId, projectDir);

  const normalizedInput = {
    tool_name: normalizeToolName(input.tool_name ?? ""),
    tool_input: input.tool_input ?? {},
    tool_response: typeof input.tool_response === "string"
      ? input.tool_response
      : JSON.stringify(input.tool_response ?? ""),
    tool_output: input.tool_output
      ? {
        ...input.tool_output,
        isError: input.tool_output.isError === true || input.tool_output.is_error === true,
      }
      : undefined,
  };

  const events = extractEvents(normalizedInput);

  attributeAndInsertEvents(db, sessionId, events, input, projectDir, "PostToolUse", resolveProjectAttributions);

  db.close();
} catch {
  // Swallow errors — hook must not fail
}

// Codex PostToolUse requires hookEventName in hookSpecificOutput
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "" },
}) + "\n");
