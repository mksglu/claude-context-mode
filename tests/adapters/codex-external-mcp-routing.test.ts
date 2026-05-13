/**
 * External MCP routing — Codex slice (#529 follow-up).
 *
 * PR #532 added the `mcp__(?!plugin_context-mode_)` PreToolUse matcher for
 * Claude Code so external MCP servers (slack, telegram, gdrive, notion …)
 * trigger the context-guidance nudge before their large payloads spill into
 * context. This slice extends the same protection to Codex CLI.
 *
 * Codex MCP wire shape: `mcp__<server>__<tool>` (verified in
 * configs/codex/hooks.json line 5 which already matches `mcp__.*__ctx_execute`
 * style — proving hook tool_name carries the `mcp__` prefix for MCP-namespaced
 * tools). Codex own context-mode tools surface as bare `ctx_execute` AND as
 * `mcp__<server>__ctx_execute` (the existing PRE_TOOL_USE_MATCHER_PATTERN
 * already wires both). The negative-lookahead pattern below carves out any
 * `mcp__` tool name whose server segment contains `context-mode`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CodexAdapter } from "../../src/adapters/codex/index.js";
import { EXTERNAL_MCP_MATCHER_PATTERN } from "../../src/adapters/codex/hooks.js";

describe("CodexAdapter — external MCP routing (#529)", () => {
  let adapter: CodexAdapter;
  beforeEach(() => {
    adapter = new CodexAdapter();
  });

  it("exports EXTERNAL_MCP_MATCHER_PATTERN constant", () => {
    expect(typeof EXTERNAL_MCP_MATCHER_PATTERN).toBe("string");
    expect(EXTERNAL_MCP_MATCHER_PATTERN.length).toBeGreaterThan(0);
  });

  it("EXTERNAL_MCP_MATCHER_PATTERN is the literal `mcp__` prefix (#547 hotfix)", () => {
    // v1.0.124 used `mcp__(?!.*context-mode)` — Codex's Rust regex crate
    // rejects look-around at boot, breaking every Codex user. v1.0.125 drops
    // the lookaround in favor of a literal that satisfies Codex's
    // `is_exact_matcher` charset (`[A-Za-z0-9_|]`). The hook BODY filters
    // context-mode's own MCP tools via `isExternalMcpTool()` in
    // hooks/core/routing.mjs, so semantics are preserved end-to-end.
    expect(EXTERNAL_MCP_MATCHER_PATTERN).toBe("mcp__");
    expect(EXTERNAL_MCP_MATCHER_PATTERN).toMatch(/^[A-Za-z0-9_|]+$/);

    // Substring semantics — the prefix is shared by every external MCP
    // tool name Codex emits (`mcp__<server>__<tool>`).
    expect("mcp__slack__list_channels".startsWith(EXTERNAL_MCP_MATCHER_PATTERN)).toBe(true);
    expect("mcp__plugin_telegram__list_messages".startsWith(EXTERNAL_MCP_MATCHER_PATTERN)).toBe(true);
    // Non-MCP bare codex tool names do not start with the prefix.
    expect("local_shell".startsWith(EXTERNAL_MCP_MATCHER_PATTERN)).toBe(false);
    expect("Bash".startsWith(EXTERNAL_MCP_MATCHER_PATTERN)).toBe(false);
  });

  it("generateHookConfig PreToolUse matcher includes the external MCP pattern", () => {
    const config = adapter.generateHookConfig("/some/plugin/root") as Record<
      string,
      Array<{ matcher: string }>
    >;
    const preToolUseMatcher = config.PreToolUse?.[0]?.matcher ?? "";
    expect(preToolUseMatcher).toContain(EXTERNAL_MCP_MATCHER_PATTERN);
  });

  it("configs/codex/hooks.json PreToolUse matcher contains EXTERNAL_MCP_MATCHER_PATTERN", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const path = resolve(__dirname, "..", "..", "configs", "codex", "hooks.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      hooks: { PreToolUse: Array<{ matcher: string }> };
    };
    const matcher = parsed.hooks.PreToolUse[0]?.matcher ?? "";
    expect(matcher).toContain(EXTERNAL_MCP_MATCHER_PATTERN);
  });
});
