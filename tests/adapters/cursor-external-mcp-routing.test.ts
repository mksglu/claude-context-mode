/**
 * External MCP routing — Cursor slice (#529 follow-up).
 *
 * Cursor MCP wire shape: `MCP:<tool>` (verified in
 * src/adapters/cursor/hooks.ts:45-47, tests/fixtures/cursor/pretooluse-mcp.json,
 * hooks/cursor/posttooluse.mjs:19-25). Context-mode's own tools surface as
 * `MCP:ctx_execute`, `MCP:ctx_execute_file`, `MCP:ctx_batch_execute`.
 *
 * The external-MCP matcher is a negative lookahead on the `ctx_` prefix:
 * `MCP:(?!ctx_)` fires for any MCP-namespaced tool whose leaf does NOT belong
 * to context-mode's family. Routing.mjs `isExternalMcpTool` is also extended
 * to recognise the `MCP:` prefix so the routing branch returns guidance
 * instead of passthrough.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CursorAdapter } from "../../src/adapters/cursor/index.js";
import {
  EXTERNAL_MCP_MATCHER_PATTERN,
  PRE_TOOL_USE_MATCHER_PATTERN,
} from "../../src/adapters/cursor/hooks.js";

describe("CursorAdapter — external MCP routing (#529)", () => {
  let adapter: CursorAdapter;
  beforeEach(() => {
    adapter = new CursorAdapter();
  });

  it("exports EXTERNAL_MCP_MATCHER_PATTERN constant", () => {
    expect(typeof EXTERNAL_MCP_MATCHER_PATTERN).toBe("string");
    expect(EXTERNAL_MCP_MATCHER_PATTERN.length).toBeGreaterThan(0);
  });

  it("EXTERNAL_MCP_MATCHER_PATTERN matches external MCP tools but not context-mode's own", () => {
    const re = new RegExp(EXTERNAL_MCP_MATCHER_PATTERN);

    // External MCP tools — MUST match
    expect(re.test("MCP:slack_list_channels")).toBe(true);
    expect(re.test("MCP:notion_query_database")).toBe(true);
    expect(re.test("MCP:gdrive_search")).toBe(true);

    // context-mode's own MCP — MUST NOT match
    expect(re.test("MCP:ctx_execute")).toBe(false);
    expect(re.test("MCP:ctx_execute_file")).toBe(false);
    expect(re.test("MCP:ctx_batch_execute")).toBe(false);
    expect(re.test("MCP:ctx_fetch_and_index")).toBe(false);

    // Non-MCP cursor tools — MUST NOT match
    expect(re.test("Shell")).toBe(false);
    expect(re.test("Read")).toBe(false);
  });

  it("PRE_TOOL_USE_MATCHER_PATTERN includes EXTERNAL_MCP_MATCHER_PATTERN", () => {
    expect(PRE_TOOL_USE_MATCHER_PATTERN).toContain(EXTERNAL_MCP_MATCHER_PATTERN);
  });

  it("generateHookConfig preToolUse matcher contains EXTERNAL_MCP_MATCHER_PATTERN", () => {
    const config = adapter.generateHookConfig("/some/plugin/root") as Record<
      string,
      Array<{ matcher?: string }>
    >;
    const preToolUse = config.preToolUse ?? [];
    const matcher = preToolUse[0]?.matcher ?? "";
    expect(matcher).toContain(EXTERNAL_MCP_MATCHER_PATTERN);
  });

  it("isExternalMcpTool routing.mjs recognises cursor MCP: prefix as external", async () => {
    const { routePreToolUse, resetGuidanceThrottle } = await import(
      "../../hooks/core/routing.mjs"
    );
    resetGuidanceThrottle();
    const result = routePreToolUse("MCP:slack_post_message", {});
    expect(result).not.toBeNull();
    expect(result!.action).toBe("context");
    expect(result!.additionalContext).toContain("External MCP tools");
  });

  it("isExternalMcpTool routing.mjs does NOT classify MCP:ctx_* as external", async () => {
    const { routePreToolUse, resetGuidanceThrottle } = await import(
      "../../hooks/core/routing.mjs"
    );
    resetGuidanceThrottle();
    // MCP:ctx_execute is handled by the dedicated ctx_execute branch — the
    // external-MCP guidance must NOT fire for it.
    const result = routePreToolUse(
      "MCP:ctx_execute",
      { language: "javascript", code: "1+1" },
    );
    if (result !== null) {
      expect(result.additionalContext ?? "").not.toContain("External MCP tools");
    }
  });
});
