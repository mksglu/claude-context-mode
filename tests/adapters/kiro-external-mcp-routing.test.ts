/**
 * External MCP routing — Kiro slice (#529 follow-up).
 *
 * Kiro MCP wire shape: `@<server>/<tool>` (verified in
 * hooks/core/tool-naming.mjs — `@context-mode/<tool>` for own MCP, and
 * src/adapters/kiro/hooks.ts:47-49). Context-mode's own tools surface as
 * `@context-mode/ctx_*`. External MCPs land as `@<other>/<tool>`.
 *
 * The negative-lookahead `@(?!context-mode/)` fires for every external Kiro
 * MCP. Routing.mjs `isExternalMcpTool` is also extended to recognise the
 * `@<server>/<tool>` shape so the routing branch returns guidance.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { KiroAdapter } from "../../src/adapters/kiro/index.js";
import {
  EXTERNAL_MCP_MATCHER_PATTERN,
  PRE_TOOL_USE_MATCHER_PATTERN,
} from "../../src/adapters/kiro/hooks.js";

describe("KiroAdapter — external MCP routing (#529)", () => {
  let adapter: KiroAdapter;
  beforeEach(() => {
    adapter = new KiroAdapter();
  });

  it("exports EXTERNAL_MCP_MATCHER_PATTERN constant", () => {
    expect(typeof EXTERNAL_MCP_MATCHER_PATTERN).toBe("string");
    expect(EXTERNAL_MCP_MATCHER_PATTERN.length).toBeGreaterThan(0);
  });

  it("EXTERNAL_MCP_MATCHER_PATTERN matches external MCP tools but not context-mode's own", () => {
    const re = new RegExp(EXTERNAL_MCP_MATCHER_PATTERN);

    // External Kiro MCP tools — MUST match
    expect(re.test("@slack/list_channels")).toBe(true);
    expect(re.test("@notion/query_database")).toBe(true);
    expect(re.test("@gdrive/search")).toBe(true);
    expect(re.test("@telegram/list_messages")).toBe(true);

    // context-mode's own MCP — MUST NOT match
    expect(re.test("@context-mode/ctx_execute")).toBe(false);
    expect(re.test("@context-mode/ctx_execute_file")).toBe(false);
    expect(re.test("@context-mode/ctx_batch_execute")).toBe(false);

    // Kiro native (non-MCP) tools — MUST NOT match
    expect(re.test("execute_bash")).toBe(false);
    expect(re.test("fs_read")).toBe(false);
    expect(re.test("fs_write")).toBe(false);
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

  it("isExternalMcpTool routing.mjs recognises kiro @server/ prefix as external", async () => {
    const { routePreToolUse, resetGuidanceThrottle } = await import(
      "../../hooks/core/routing.mjs"
    );
    resetGuidanceThrottle();
    const result = routePreToolUse("@slack/post_message", {});
    expect(result).not.toBeNull();
    expect(result!.action).toBe("context");
    expect(result!.additionalContext).toContain("External MCP tools");
  });

  it("isExternalMcpTool routing.mjs does NOT classify @context-mode/ctx_* as external", async () => {
    const { routePreToolUse, resetGuidanceThrottle } = await import(
      "../../hooks/core/routing.mjs"
    );
    resetGuidanceThrottle();
    const result = routePreToolUse(
      "@context-mode/ctx_execute",
      { language: "javascript", code: "1+1" },
    );
    // ctx_execute branch handles this — must NOT fire external-MCP guidance.
    if (result !== null) {
      expect(result.additionalContext ?? "").not.toContain("External MCP tools");
    }
  });
});
