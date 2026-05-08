import { describe, it, expect } from "vitest";
import { formatters, formatDecision } from "../hooks/core/formatters.mjs";

describe("claude-code formatter", () => {
  it("deny uses permissionDecisionReason, not reason", () => {
    const result = formatters["claude-code"].deny("blocked by sandbox");
    const output = result.hookSpecificOutput;
    expect(output.permissionDecisionReason).toBe("blocked by sandbox");
    expect(output).not.toHaveProperty("reason");
  });

  it("modify includes permissionDecision and permissionDecisionReason alongside updatedInput", () => {
    const result = formatters["claude-code"].modify({ command: "ls" });
    const output = result.hookSpecificOutput;
    expect(output.permissionDecision).toBe("allow");
    expect(output.permissionDecisionReason).toBeDefined();
    expect(output.updatedInput).toEqual({ command: "ls" });
  });
});

describe("vscode-copilot formatter", () => {
  it("deny uses permissionDecisionReason, not reason", () => {
    const result = formatters["vscode-copilot"].deny("not allowed");
    expect(result.permissionDecisionReason).toBe("not allowed");
    expect(result).not.toHaveProperty("reason");
  });

  it("modify includes permissionDecision and permissionDecisionReason alongside updatedInput", () => {
    const result = formatters["vscode-copilot"].modify({ file_path: "/tmp/x" });
    const output = result.hookSpecificOutput;
    expect(output.permissionDecision).toBe("allow");
    expect(output.permissionDecisionReason).toBeDefined();
    expect(output.updatedInput).toEqual({ file_path: "/tmp/x" });
  });
});

describe("formatDecision integration", () => {
  it("claude-code deny flows through with correct field names", () => {
    const result = formatDecision("claude-code", { action: "deny", reason: "sandbox only" });
    expect(result.hookSpecificOutput.permissionDecisionReason).toBe("sandbox only");
    expect(result.hookSpecificOutput).not.toHaveProperty("reason");
  });

  it("claude-code modify flows through with permissionDecision", () => {
    const result = formatDecision("claude-code", { action: "modify", updatedInput: { command: "echo hi" } });
    expect(result.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result.hookSpecificOutput.updatedInput).toEqual({ command: "echo hi" });
  });
});
