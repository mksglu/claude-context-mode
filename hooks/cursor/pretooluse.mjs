#!/usr/bin/env node
import "../suppress-stderr.mjs";
/**
 * Cursor preToolUse hook for context-mode.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin, parseStdin, getInputProjectDir, getSessionId, CURSOR_OPTS } from "../session-helpers.mjs";
import { routePreToolUse, initSecurity } from "../core/routing.mjs";
import { formatDecision } from "../core/formatters.mjs";

const __hookDir = dirname(fileURLToPath(import.meta.url));
await initSecurity(resolve(__hookDir, "..", "..", "build"));

const raw = await readStdin();
const input = parseStdin(raw);
const tool = input.tool_name ?? "";
const toolInput = input.tool_input ?? {};
const projectDir = getInputProjectDir(input, CURSOR_OPTS);

const decision = routePreToolUse(tool, toolInput, projectDir, "cursor", getSessionId(input, CURSOR_OPTS));
const response = formatDecision("cursor", decision);
// Cursor treats empty stdout as an invalid hook response,
// so even passthrough decisions must emit a syntactically valid no-op payload.
process.stdout.write(JSON.stringify(response ?? { agent_message: "" }) + "\n");
