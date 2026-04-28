/**
 * Claude Code formatter — converts routing decisions into Claude Code hook output format.
 *
 * Claude Code expects:
 *   { hookSpecificOutput: { hookEventName, permissionDecision?, reason?, updatedInput?, additionalContext? } }
 *
 * Decision shape from routing.mjs:
 *   - { action: "deny", reason: string }
 *   - { action: "ask" }
 *   - { action: "modify", updatedInput: object }
 *   - { action: "context", additionalContext: string }
 *   - null (passthrough)
 *
 * @param {object | null} decision - Normalized decision from routePreToolUse
 * @returns {object | null} Claude Code hook response, or null for passthrough
 */

// In `claude --print` (headless) the CLI has no TTY to surface an "ask" prompt,
// so the agent stalls forever. Launchers running headless set CLAUDE_CODE_HEADLESS=1;
// when set, we mirror gemini-cli.mjs and passthrough on ask instead of blocking.
const isHeadless = () => process.env.CLAUDE_CODE_HEADLESS === "1";

export function formatDecision(decision) {
  if (!decision) return null;

  switch (decision.action) {
    case "deny":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          reason: decision.reason ?? "Blocked by context-mode",
        },
      };

    case "ask":
      if (isHeadless()) return null;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
        },
      };

    case "modify":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: decision.updatedInput,
        },
      };

    case "context":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: decision.additionalContext ?? "",
        },
      };

    default:
      return null;
  }
}
