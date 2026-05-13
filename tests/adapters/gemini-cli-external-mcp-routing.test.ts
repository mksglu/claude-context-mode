/**
 * External MCP routing — Gemini CLI slice (#529 follow-up).
 *
 * Gemini CLI MCP wire shape: `mcp__<server>__<tool>` (verified in
 * hooks/core/tool-naming.mjs — `mcp__context-mode__<tool>` for own MCP).
 * The negative-lookahead `mcp__(?!.*context-mode)` catches every external
 * MCP server while skipping context-mode's own family (both the canonical
 * `mcp__context-mode__*` and the Claude shim `mcp__plugin_context-mode_*`).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { GeminiCLIAdapter } from "../../src/adapters/gemini-cli/index.js";
import { EXTERNAL_MCP_MATCHER_PATTERN } from "../../src/adapters/gemini-cli/hooks.js";

describe("GeminiCLIAdapter — external MCP routing (#529)", () => {
  let adapter: GeminiCLIAdapter;
  beforeEach(() => {
    adapter = new GeminiCLIAdapter();
  });

  it("exports EXTERNAL_MCP_MATCHER_PATTERN constant", () => {
    expect(typeof EXTERNAL_MCP_MATCHER_PATTERN).toBe("string");
    expect(EXTERNAL_MCP_MATCHER_PATTERN.length).toBeGreaterThan(0);
  });

  it("EXTERNAL_MCP_MATCHER_PATTERN matches external MCP tools but not context-mode's own", () => {
    const re = new RegExp(EXTERNAL_MCP_MATCHER_PATTERN);

    // External MCP namespaces — MUST match
    expect(re.test("mcp__slack__list_channels")).toBe(true);
    expect(re.test("mcp__plugin_telegram__list_messages")).toBe(true);
    expect(re.test("mcp__notion__query_database")).toBe(true);
    expect(re.test("mcp__claude_ai_Google_Drive__search")).toBe(true);

    // context-mode's own MCP (gemini canonical + Claude shim) — MUST NOT match
    expect(re.test("mcp__context-mode__ctx_execute")).toBe(false);
    expect(re.test("mcp__context-mode__ctx_search")).toBe(false);
    expect(re.test("mcp__plugin_context-mode_context-mode__ctx_execute")).toBe(false);

    // Bare gemini-native tool names — MUST NOT match
    expect(re.test("run_shell_command")).toBe(false);
    expect(re.test("read_file")).toBe(false);
    expect(re.test("web_fetch")).toBe(false);
  });

  it("generateHookConfig BeforeTool matcher contains EXTERNAL_MCP_MATCHER_PATTERN", () => {
    const config = adapter.generateHookConfig("/some/plugin/root") as Record<
      string,
      Array<{ matcher: string }>
    >;
    // Gemini CLI's PreToolUse equivalent is BeforeTool.
    const beforeTool = config.BeforeTool ?? [];
    const matcher = beforeTool[0]?.matcher ?? "";
    expect(matcher).toContain(EXTERNAL_MCP_MATCHER_PATTERN);
  });
});
