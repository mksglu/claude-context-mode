#!/usr/bin/env node
import "../suppress-stderr.mjs";
/**
 * Kiro CLI PreToolUse hook for context-mode.
 * Uses exit codes instead of JSON stdout:
 *   - Exit 0: allow (stdout → agent context)
 *   - Exit 2: block (stderr → agent error)
 *
 * Source: https://kiro.dev/docs/cli/hooks/
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin } from "../core/stdin.mjs";
import { routePreToolUse, initSecurity } from "../core/routing.mjs";
import { parseStdin, getSessionId, KIRO_OPTS } from "../session-helpers.mjs";

const __hookDir = dirname(fileURLToPath(import.meta.url));
await initSecurity(resolve(__hookDir, "..", "..", "build"));

const raw = await readStdin();
const input = parseStdin(raw);
// Kiro stdin: { hook_event_name, cwd, tool_name, tool_input }
const tool = input.tool_name ?? "";
const toolInput = input.tool_input ?? {};
const projectDir = input.cwd ?? process.cwd();

const decision = routePreToolUse(tool, toolInput, projectDir, "kiro", getSessionId(input, KIRO_OPTS));

if (!decision) process.exit(0);

switch (decision.action) {
  case "deny":
    process.stderr.write(decision.reason ?? "Blocked by context-mode");
    process.exit(2);
    break;

  case "modify":
    // Kiro CLI cannot modify tool input — deny with redirect message
    // The updatedInput.command contains an echo "..." wrapper — extract inner message
    if (typeof decision.updatedInput?.command === "string") {
      const msg = decision.updatedInput.command
        .replace(/^echo\s+"?/, "")
        .replace(/"?\s*$/, "");
      process.stderr.write(msg);
    } else {
      process.stderr.write(decision.reason ?? "Blocked by context-mode routing");
    }
    process.exit(2);
    break;

  case "context":
    process.stdout.write(decision.additionalContext ?? "");
    process.exit(0);
    break;

  case "ask":
    // Kiro CLI has no "ask" concept — passthrough
    process.exit(0);
    break;

  default:
    process.exit(0);
}
