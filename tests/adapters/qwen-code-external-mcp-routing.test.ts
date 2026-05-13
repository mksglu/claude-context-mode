/**
 * External MCP routing — Qwen Code slice (#529 follow-up).
 *
 * Qwen Code is a Gemini CLI fork (verified in
 * src/adapters/qwen-code/index.ts:13 — `qwen-cli-mcp-client-*` pattern) and
 * shares the `mcp__<server>__<tool>` wire shape. Own MCP surfaces as both
 * `mcp__plugin_context-mode_context-mode__ctx_*` (Claude shim) and
 * `mcp__context-mode__ctx_*` (canonical). The negative-lookahead
 * `mcp__(?!.*context-mode)` excludes both.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { QwenCodeAdapter } from "../../src/adapters/qwen-code/index.js";
import { EXTERNAL_MCP_MATCHER_PATTERN } from "../../src/adapters/qwen-code/hooks.js";

describe("QwenCodeAdapter — external MCP routing (#529)", () => {
  let adapter: QwenCodeAdapter;
  beforeEach(() => {
    adapter = new QwenCodeAdapter();
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

    // context-mode's own MCP (Qwen sees both prefixes) — MUST NOT match
    expect(re.test("mcp__plugin_context-mode_context-mode__ctx_execute")).toBe(false);
    expect(re.test("mcp__context-mode__ctx_execute")).toBe(false);
    expect(re.test("mcp__plugin_context-mode_context-mode__ctx_batch_execute")).toBe(false);

    // Qwen native bare tool names — MUST NOT match
    expect(re.test("run_shell_command")).toBe(false);
    expect(re.test("read_file")).toBe(false);
    expect(re.test("agent")).toBe(false);
  });

  it("generateHookConfig PreToolUse matcher contains EXTERNAL_MCP_MATCHER_PATTERN", () => {
    const config = adapter.generateHookConfig("/some/plugin/root") as Record<
      string,
      Array<{ matcher: string }>
    >;
    const matcher = config.PreToolUse?.[0]?.matcher ?? "";
    expect(matcher).toContain(EXTERNAL_MCP_MATCHER_PATTERN);
  });
});
