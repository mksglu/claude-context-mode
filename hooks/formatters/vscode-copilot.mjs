/**
 * VS Code Copilot formatter — converts routing decisions into VS Code Copilot hook output format.
 *
 * VS Code Copilot expects a flat structure for deny/ask, nested for modify/context:
 *   { permissionDecision: "deny", reason: "..." }               — deny
 *   { permissionDecision: "ask" }                                 — ask
 *   { hookSpecificOutput: { ... }, hookEventName: "PreToolUse" }  — modify/context
 *
 * Key differences from Claude Code:
 *   - deny/ask are flat (not wrapped in hookSpecificOutput)
 *   - modify/context include hookEventName at top level alongside hookSpecificOutput
 *
 * Decision shape from routing.mjs:
 *   - { action: "deny", reason: string }
 *   - { action: "ask" }
 *   - { action: "modify", updatedInput: object }
 *   - { action: "context", additionalContext: string }
 *   - null (passthrough)
 *
 * @param {object | null} decision - Normalized decision from routePreToolUse
 * @returns {object | null} VS Code Copilot hook response, or null for passthrough
 */
export function formatDecision(decision) {
  if (!decision) return null;

  switch (decision.action) {
    case "deny":
      return {
        permissionDecision: "deny",
        reason: decision.reason ?? "Blocked by context-mode",
      };

    case "ask":
      return {
        permissionDecision: "ask",
      };

    case "modify":
      return {
        hookSpecificOutput: decision.updatedInput,
        hookEventName: "PreToolUse",
      };

    case "context":
      return {
        hookSpecificOutput: {
          additionalContext: decision.additionalContext ?? "",
        },
        hookEventName: "PreToolUse",
      };

    default:
      return null;
  }
}
