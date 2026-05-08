/**
 * Platform-specific response formatters.
 * Takes normalized decision from routing.mjs -> platform-specific JSON output.
 */

export const formatters = {
  "claude-code": {
    deny: (reason) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
    ask: () => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
      },
    }),
    modify: (updatedInput) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Routed to context-mode sandbox",
        updatedInput,
      },
    }),
    context: (additionalContext) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext,
      },
    }),
  },

  "gemini-cli": {
    deny: (reason) => ({ decision: "deny", reason }),
    ask: () => null, // Gemini CLI has no "ask" concept
    modify: (updatedInput) => ({
      hookSpecificOutput: { tool_input: updatedInput },
    }),
    context: (additionalContext) => ({
      hookSpecificOutput: { additionalContext },
    }),
  },

  "vscode-copilot": {
    deny: (reason) => ({
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    }),
    ask: () => ({
      permissionDecision: "ask",
    }),
    modify: (updatedInput) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Routed to context-mode sandbox",
        updatedInput,
      },
    }),
    context: (additionalContext) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext,
      },
    }),
  },

  "jetbrains-copilot": {
    deny: (reason) => ({
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    }),
    ask: () => ({
      permissionDecision: "ask",
    }),
    modify: (updatedInput) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Routed to context-mode sandbox",
        updatedInput,
      },
    }),
    context: (additionalContext) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext,
      },
    }),
  },

  "codex": {
    deny: (reason) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
    ask: () => null, // Codex rejects permissionDecision: "ask" in PreToolUse
    modify: () => null, // Codex rejects updatedInput in PreToolUse
    context: () => null, // Codex rejects additionalContext in PreToolUse (fails open)
  },

  "cursor": {
    deny: (reason) => ({
      permission: "deny",
      user_message: reason,
    }),
    ask: () => ({
      permission: "ask",
    }),
    modify: (updatedInput) => ({
      updated_input: updatedInput,
    }),
    context: (additionalContext) => ({
      agent_message: additionalContext,
    }),
  },
};

/**
 * Apply a formatter to a normalized routing decision.
 * Returns the platform-specific JSON response, or null for passthrough.
 */
export function formatDecision(platform, decision) {
  if (!decision) return null;

  const fmt = formatters[platform];
  if (!fmt) return null;

  switch (decision.action) {
    case "deny": return fmt.deny(decision.reason);
    case "ask": return fmt.ask();
    case "modify": return fmt.modify(decision.updatedInput);
    case "context": return fmt.context(decision.additionalContext);
    default: return null;
  }
}
