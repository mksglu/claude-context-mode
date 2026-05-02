import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

// Dynamic import for .mjs modules
let claudeCodeFormat: (decision: unknown) => unknown;
let geminiCliFormat: (decision: unknown) => unknown;
let vscodeCopilotFormat: (decision: unknown) => unknown;
let cursorFormat: (decision: unknown) => unknown;

beforeAll(async () => {
  const ccMod = await import("../../hooks/formatters/claude-code.mjs");
  claudeCodeFormat = ccMod.formatDecision;

  const gemMod = await import("../../hooks/formatters/gemini-cli.mjs");
  geminiCliFormat = gemMod.formatDecision;

  const vscMod = await import("../../hooks/formatters/vscode-copilot.mjs");
  vscodeCopilotFormat = vscMod.formatDecision;

  const cursorMod = await import("../../hooks/formatters/cursor.mjs");
  cursorFormat = cursorMod.formatDecision;
});

// ─── Shared test decisions ───────────────────────────────

const denyDecision = {
  action: "deny",
  reason: "WebFetch blocked. Use fetch_and_index instead.",
};

const askDecision = {
  action: "ask",
};

const modifyDecision = {
  action: "modify",
  updatedInput: {
    command: 'echo "context-mode: curl/wget blocked."',
  },
};

const contextDecision = {
  action: "context",
  additionalContext: "<context_guidance>Use execute_file instead</context_guidance>",
};

// ─────────────────────────────────────────────────────────

describe("formatDecision", () => {
  // ─── Claude Code formatter ─────────────────────────────

  describe("claude-code formatter", () => {
    it("formats deny with hookSpecificOutput.permissionDecision", () => {
      const result = claudeCodeFormat(denyDecision) as Record<string, unknown>;
      expect(result).not.toBeNull();

      const output = result.hookSpecificOutput as Record<string, unknown>;
      expect(output.hookEventName).toBe("PreToolUse");
      expect(output.permissionDecision).toBe("deny");
      expect(output.reason).toBe(denyDecision.reason);
    });

    it("formats ask with hookSpecificOutput.permissionDecision:'ask'", () => {
      const result = claudeCodeFormat(askDecision) as Record<string, unknown>;
      expect(result).not.toBeNull();

      const output = result.hookSpecificOutput as Record<string, unknown>;
      expect(output.hookEventName).toBe("PreToolUse");
      expect(output.permissionDecision).toBe("ask");
    });

    it("formats modify with hookSpecificOutput.updatedInput", () => {
      const result = claudeCodeFormat(modifyDecision) as Record<string, unknown>;
      expect(result).not.toBeNull();

      const output = result.hookSpecificOutput as Record<string, unknown>;
      expect(output.hookEventName).toBe("PreToolUse");
      expect(output.updatedInput).toEqual(modifyDecision.updatedInput);
    });

    it("formats context with hookSpecificOutput.additionalContext", () => {
      const result = claudeCodeFormat(contextDecision) as Record<string, unknown>;
      expect(result).not.toBeNull();

      const output = result.hookSpecificOutput as Record<string, unknown>;
      expect(output.hookEventName).toBe("PreToolUse");
      expect(output.additionalContext).toBe(contextDecision.additionalContext);
    });

    it("returns null for null decision", () => {
      const result = claudeCodeFormat(null);
      expect(result).toBeNull();
    });

    // ─── Headless mode (--print, no TTY) — passthrough on ask ───
    describe("when CLAUDE_CODE_HEADLESS=1 (headless --print mode)", () => {
      let saved: string | undefined;
      beforeEach(() => {
        saved = process.env.CLAUDE_CODE_HEADLESS;
        process.env.CLAUDE_CODE_HEADLESS = "1";
      });
      afterEach(() => {
        if (saved === undefined) delete process.env.CLAUDE_CODE_HEADLESS;
        else process.env.CLAUDE_CODE_HEADLESS = saved;
      });

      it("returns null for ask (passthrough — no TTY to surface prompt, prevents --print hang)", () => {
        const result = claudeCodeFormat(askDecision);
        expect(result).toBeNull();
      });

      it("returns null for deny (passthrough — headless agents have no UI to reconsider)", () => {
        const result = claudeCodeFormat(denyDecision);
        expect(result).toBeNull();
      });

      it("returns null for modify (passthrough — modify rewrites silently break headless tool calls)", () => {
        const result = claudeCodeFormat(modifyDecision);
        expect(result).toBeNull();
      });

      it("still formats context normally (informational, doesn't block the tool)", () => {
        const result = claudeCodeFormat(contextDecision) as Record<string, unknown>;
        expect(result).not.toBeNull();
        const output = result.hookSpecificOutput as Record<string, unknown>;
        expect(output.additionalContext).toBe(contextDecision.additionalContext);
      });
    });
  });

  // ─── Gemini CLI formatter ──────────────────────────────

  describe("gemini-cli formatter", () => {
    it("formats deny with decision:'deny' (NOT permissionDecision)", () => {
      const result = geminiCliFormat(denyDecision) as Record<string, unknown>;
      expect(result).not.toBeNull();

      const output = result.hookSpecificOutput as Record<string, unknown>;
      expect(output.decision).toBe("deny");
      expect(output.reason).toBe(denyDecision.reason);
      // Should NOT have permissionDecision
      expect(output).not.toHaveProperty("permissionDecision");
    });

    it("returns null for ask (no ask concept)", () => {
      const result = geminiCliFormat(askDecision);
      expect(result).toBeNull();
    });

    it("formats modify with hookSpecificOutput.tool_input", () => {
      const result = geminiCliFormat(modifyDecision) as Record<string, unknown>;
      expect(result).not.toBeNull();

      const output = result.hookSpecificOutput as Record<string, unknown>;
      expect(output.tool_input).toEqual(modifyDecision.updatedInput);
      // Should NOT have updatedInput
      expect(output).not.toHaveProperty("updatedInput");
    });

    it("formats context with hookSpecificOutput.additionalContext", () => {
      const result = geminiCliFormat(contextDecision) as Record<string, unknown>;
      expect(result).not.toBeNull();

      const output = result.hookSpecificOutput as Record<string, unknown>;
      expect(output.additionalContext).toBe(contextDecision.additionalContext);
    });
  });

  // ─── VS Code Copilot formatter ─────────────────────────

  describe("vscode-copilot formatter", () => {
    it("formats deny with permissionDecision (flat, not wrapped)", () => {
      const result = vscodeCopilotFormat(denyDecision) as Record<string, unknown>;
      expect(result).not.toBeNull();

      // Flat — NOT nested inside hookSpecificOutput
      expect(result.permissionDecision).toBe("deny");
      expect(result.reason).toBe(denyDecision.reason);
      expect(result).not.toHaveProperty("hookSpecificOutput");
    });

    it("formats ask with permissionDecision:'ask'", () => {
      const result = vscodeCopilotFormat(askDecision) as Record<string, unknown>;
      expect(result).not.toBeNull();

      expect(result.permissionDecision).toBe("ask");
      expect(result).not.toHaveProperty("hookSpecificOutput");
    });

    it("formats modify with hookSpecificOutput + hookEventName", () => {
      const result = vscodeCopilotFormat(modifyDecision) as Record<string, unknown>;
      expect(result).not.toBeNull();

      expect(result.hookEventName).toBe("PreToolUse");
      expect(result.hookSpecificOutput).toEqual(modifyDecision.updatedInput);
      // Should NOT have permissionDecision
      expect(result).not.toHaveProperty("permissionDecision");
    });

    it("formats context with hookSpecificOutput + hookEventName", () => {
      const result = vscodeCopilotFormat(contextDecision) as Record<string, unknown>;
      expect(result).not.toBeNull();

      expect(result.hookEventName).toBe("PreToolUse");
      const output = result.hookSpecificOutput as Record<string, unknown>;
      expect(output.additionalContext).toBe(contextDecision.additionalContext);
    });
  });

  describe("cursor formatter", () => {
    it("formats deny with permission and user_message", () => {
      const result = cursorFormat(denyDecision) as Record<string, unknown>;
      expect(result.permission).toBe("deny");
      expect(result.user_message).toBe(denyDecision.reason);
    });

    it("formats ask with permission:'ask'", () => {
      const result = cursorFormat(askDecision) as Record<string, unknown>;
      expect(result.permission).toBe("ask");
    });

    it("formats modify with updated_input", () => {
      const result = cursorFormat(modifyDecision) as Record<string, unknown>;
      expect(result.updated_input).toEqual(modifyDecision.updatedInput);
    });

    it("formats context with agent_message", () => {
      const result = cursorFormat(contextDecision) as Record<string, unknown>;
      expect(result.agent_message).toBe(contextDecision.additionalContext);
    });
  });
});
