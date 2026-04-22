#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Cursor postToolUse hook — session event capture.
 */

import { readStdin, getSessionId, getSessionDBPath, getInputProjectDir, CURSOR_OPTS } from "../session-helpers.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionLoaders } from "../session-loaders.mjs";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);
const OPTS = CURSOR_OPTS;

function normalizeToolName(toolName) {
  if (toolName === "Shell") return "Bash";
  if (toolName === "MCP:ctx_execute") {
    return "mcp__plugin_context-mode_context-mode__ctx_execute";
  }
  if (toolName === "MCP:ctx_execute_file") {
    return "mcp__plugin_context-mode_context-mode__ctx_execute_file";
  }
  if (toolName === "MCP:ctx_batch_execute") {
    return "mcp__plugin_context-mode_context-mode__ctx_batch_execute";
  }
  return toolName;
}

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const projectDir = getInputProjectDir(input, CURSOR_OPTS);

  if (projectDir && !process.env.CURSOR_CWD) {
    process.env.CURSOR_CWD = projectDir;
  }

  const { extractEvents } = await loadExtract();
  const { resolveProjectAttributions } = await loadProjectAttribution();
  const { SessionDB } = await loadSessionDB();

  const dbPath = getSessionDBPath(OPTS);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, OPTS);

  db.ensureSession(sessionId, projectDir);

  const normalizedInput = {
    tool_name: normalizeToolName(input.tool_name ?? ""),
    tool_input: input.tool_input ?? {},
    tool_response: typeof input.tool_output === "string"
      ? input.tool_output
      : JSON.stringify(input.tool_output ?? input.error_message ?? ""),
    tool_output: input.error_message
      ? { isError: true }
      : undefined,
  };

  const events = extractEvents(normalizedInput);

  const sessionStats = db.getSessionStats(sessionId);
  const lastKnownProjectDir = typeof db.getLatestAttributedProjectDir === "function"
    ? db.getLatestAttributedProjectDir(sessionId)
    : null;
  const attributions = resolveProjectAttributions(events, {
    sessionOriginDir: sessionStats?.project_dir || projectDir,
    inputProjectDir: projectDir,
    workspaceRoots: Array.isArray(input.workspace_roots) ? input.workspace_roots : [],
    lastKnownProjectDir,
  });

  for (let i = 0; i < events.length; i++) {
    db.insertEvent(sessionId, events[i], "PostToolUse", attributions[i]);
  }

  db.close();
} catch {
  // Cursor treats stderr as hook failure; swallow and continue.
}

// Cursor treats empty stdout as an invalid hook response,
// so we emit an explicit no-op payload after persisting events.
process.stdout.write(JSON.stringify({ additional_context: "" }) + "\n");
