/**
 * Cursor formatter — converts routing decisions into native Cursor hook output.
 *
 * Cursor expects flat response objects:
 *   { permission: "deny" | "ask", user_message?: string }
 *   { updated_input: { ... } }
 *   { agent_message: "..." }
 */
export function formatDecision(decision) {
  if (!decision) return null;

  switch (decision.action) {
    case "deny":
      return {
        permission: "deny",
        user_message: decision.reason ?? "Blocked by context-mode",
      };

    case "ask":
      return {
        permission: "ask",
      };

    case "modify":
      return {
        updated_input: decision.updatedInput,
      };

    case "context":
      return {
        agent_message: decision.additionalContext ?? "",
      };

    default:
      return null;
  }
}
