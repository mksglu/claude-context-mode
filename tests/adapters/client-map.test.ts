import { describe, it, expect } from "vitest";
import { CLIENT_NAME_TO_PLATFORM } from "../../src/adapters/client-map.js";

describe("CLIENT_NAME_TO_PLATFORM", () => {
  it("maps claude-code → claude-code", () => {
    expect(CLIENT_NAME_TO_PLATFORM["claude-code"]).toBe("claude-code");
  });

  it("maps antigravity-client → antigravity", () => {
    expect(CLIENT_NAME_TO_PLATFORM["antigravity-client"]).toBe("antigravity");
  });

  it("maps gemini-cli-mcp-client → gemini-cli", () => {
    expect(CLIENT_NAME_TO_PLATFORM["gemini-cli-mcp-client"]).toBe("gemini-cli");
  });

  it("maps cursor-vscode → cursor", () => {
    expect(CLIENT_NAME_TO_PLATFORM["cursor-vscode"]).toBe("cursor");
  });

  it("maps Visual-Studio-Code → vscode-copilot", () => {
    expect(CLIENT_NAME_TO_PLATFORM["Visual-Studio-Code"]).toBe("vscode-copilot");
  });

  it("maps Codex → codex", () => {
    expect(CLIENT_NAME_TO_PLATFORM["Codex"]).toBe("codex");
  });

  it("maps codex-mcp-client → codex", () => {
    expect(CLIENT_NAME_TO_PLATFORM["codex-mcp-client"]).toBe("codex");
  });

  it('maps "Kiro CLI" to "kiro"', () => {
    expect(CLIENT_NAME_TO_PLATFORM["Kiro CLI"]).toBe("kiro");
  });

  it("maps qwen-code client name to qwen-code platform", () => {
    expect(CLIENT_NAME_TO_PLATFORM["qwen-code"]).toBe("qwen-code");
  });

  it('maps "JetBrains Client" to "jetbrains-copilot"', () => {
    expect(CLIENT_NAME_TO_PLATFORM["JetBrains Client"]).toBe("jetbrains-copilot");
  });

  it('maps "IntelliJ IDEA" to "jetbrains-copilot"', () => {
    expect(CLIENT_NAME_TO_PLATFORM["IntelliJ IDEA"]).toBe("jetbrains-copilot");
  });

  it('maps "PyCharm" to "jetbrains-copilot"', () => {
    expect(CLIENT_NAME_TO_PLATFORM["PyCharm"]).toBe("jetbrains-copilot");
  });

  it("returns undefined for unknown client name", () => {
    expect(CLIENT_NAME_TO_PLATFORM["some-unknown-client"]).toBeUndefined();
  });
});
