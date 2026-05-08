/**
 * Gemini CLI formatter — converts routing decisions into Gemini CLI hook output format.
 *
 * Gemini CLI expects:
 *   { hookSpecificOutput: { decision?, reason?, tool_input?, additionalContext? } }
 *
 * Key differences from Claude Code:
 *   - Uses "decision" instead of "permissionDecision"
 *   - Uses "tool_input" instead of "updatedInput"
 *   - No "ask" concept — Gemini CLI only supports deny/allow
 *
 * Decision shape from routing.mjs:
 *   - { action: "deny", reason: string }
 *   - { action: "ask" }
 *   - { action: "modify", updatedInput: object }
 *   - { action: "context", additionalContext: string }
 *   - null (passthrough)
 *
 * @param {object | null} decision - Normalized decision from routePreToolUse
 * @returns {object | null} Gemini CLI hook response, or null for passthrough
 */
export function formatDecision(decision) {
  if (!decision) return null;

  switch (decision.action) {
    case "deny":
      return {
        hookSpecificOutput: {
          decision: "deny",
          reason: decision.reason ?? "Blocked by context-mode",
        },
      };

    case "ask":
      // Gemini CLI has no "ask" concept — return null (passthrough)
      return null;

    case "modify":
      return {
        hookSpecificOutput: {
          tool_input: decision.updatedInput,
        },
      };

    case "context":
      return {
        hookSpecificOutput: {
          additionalContext: decision.additionalContext ?? "",
        },
      };

    default:
      return null;
  }
}
