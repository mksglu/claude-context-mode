#!/usr/bin/env node
import "../suppress-stderr.mjs";
/**
 * JetBrains Copilot PreToolUse hook for context-mode
 * Thin wrapper — uses shared routing core, no self-heal, no Claude Code-specific logic.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin } from "../core/stdin.mjs";
import { routePreToolUse, initSecurity } from "../core/routing.mjs";
import { formatDecision } from "../core/formatters.mjs";
import { parseStdin, getSessionId, JETBRAINS_OPTS } from "../session-helpers.mjs";

const __hookDir = dirname(fileURLToPath(import.meta.url));
await initSecurity(resolve(__hookDir, "..", "..", "build"));

const raw = await readStdin();
const input = parseStdin(raw);
const tool = input.tool_name ?? "";
const toolInput = input.tool_input ?? {};

const decision = routePreToolUse(tool, toolInput, process.env.IDEA_INITIAL_DIRECTORY || process.env.CLAUDE_PROJECT_DIR, "jetbrains-copilot", getSessionId(input, JETBRAINS_OPTS));
const response = formatDecision("jetbrains-copilot", decision);
if (response !== null) {
  process.stdout.write(JSON.stringify(response) + "\n");
}
