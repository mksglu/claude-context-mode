import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

let getToolName: (platform: string, bareTool: string) => string;
let createToolNamer: (platform: string) => (bareTool: string) => string;
let KNOWN_PLATFORMS: string[];
let routePreToolUse: (
  toolName: string,
  toolInput: Record<string, unknown>,
  projectDir?: string,
  platform?: string,
) => {
  action: string;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
} | null;
let resetGuidanceThrottle: () => void;
let createRoutingBlock: (t: (tool: string) => string) => string;
let createReadGuidance: (t: (tool: string) => string) => string;
let createGrepGuidance: (t: (tool: string) => string) => string;
let createBashGuidance: (t: (tool: string) => string) => string;
let ROUTING_BLOCK: string;
let READ_GUIDANCE: string;
let GREP_GUIDANCE: string;
let BASH_GUIDANCE: string;

beforeAll(async () => {
  const naming = await import("../../hooks/core/tool-naming.mjs");
  getToolName = naming.getToolName;
  createToolNamer = naming.createToolNamer;
  KNOWN_PLATFORMS = naming.KNOWN_PLATFORMS;

  const routing = await import("../../hooks/core/routing.mjs");
  routePreToolUse = routing.routePreToolUse;
  resetGuidanceThrottle = routing.resetGuidanceThrottle;

  const block = await import("../../hooks/routing-block.mjs");
  createRoutingBlock = block.createRoutingBlock;
  createReadGuidance = block.createReadGuidance;
  createGrepGuidance = block.createGrepGuidance;
  createBashGuidance = block.createBashGuidance;
  ROUTING_BLOCK = block.ROUTING_BLOCK;
  READ_GUIDANCE = block.READ_GUIDANCE;
  GREP_GUIDANCE = block.GREP_GUIDANCE;
  BASH_GUIDANCE = block.BASH_GUIDANCE;
});

// MCP readiness sentinel — routing.mjs checks process.ppid in-process
const mcpSentinel = resolve(tmpdir(), `context-mode-mcp-ready-${process.ppid}`);

beforeEach(() => {
  if (typeof resetGuidanceThrottle === "function") resetGuidanceThrottle();
  writeFileSync(mcpSentinel, String(process.ppid));
});

afterEach(() => {
  try { unlinkSync(mcpSentinel); } catch {}
});

// ═══════════════════════════════════════════════════════════════════
// Tool Naming — getToolName and createToolNamer
// ═══════════════════════════════════════════════════════════════════

describe("getToolName", () => {
  it("returns correct name for claude-code", () => {
    expect(getToolName("claude-code", "ctx_fetch_and_index")).toBe(
      "mcp__plugin_context-mode_context-mode__ctx_fetch_and_index",
    );
  });

  it("returns correct name for gemini-cli", () => {
    expect(getToolName("gemini-cli", "ctx_fetch_and_index")).toBe(
      "mcp__context-mode__ctx_fetch_and_index",
    );
  });

  it("returns correct name for antigravity", () => {
    expect(getToolName("antigravity", "ctx_execute")).toBe(
      "mcp__context-mode__ctx_execute",
    );
  });

  it("returns correct name for opencode", () => {
    expect(getToolName("opencode", "ctx_search")).toBe(
      "context-mode_ctx_search",
    );
  });

  it("returns correct name for vscode-copilot", () => {
    expect(getToolName("vscode-copilot", "ctx_batch_execute")).toBe(
      "context-mode_ctx_batch_execute",
    );
  });

  it("returns correct name for kiro", () => {
    expect(getToolName("kiro", "ctx_execute_file")).toBe(
      "@context-mode/ctx_execute_file",
    );
  });

  it("returns correct name for zed", () => {
    expect(getToolName("zed", "ctx_index")).toBe(
      "mcp:context-mode:ctx_index",
    );
  });

  it("returns bare name for cursor", () => {
    expect(getToolName("cursor", "ctx_fetch_and_index")).toBe(
      "ctx_fetch_and_index",
    );
  });

  it("returns bare name for codex", () => {
    expect(getToolName("codex", "ctx_execute")).toBe("ctx_execute");
  });

  it("returns bare name for openclaw", () => {
    expect(getToolName("openclaw", "ctx_search")).toBe("ctx_search");
  });

  it("returns bare name for pi", () => {
    expect(getToolName("pi", "ctx_batch_execute")).toBe("ctx_batch_execute");
  });

  it("falls back to claude-code for unknown platforms", () => {
    expect(getToolName("unknown-platform", "ctx_search")).toBe(
      "mcp__plugin_context-mode_context-mode__ctx_search",
    );
  });
});

describe("createToolNamer", () => {
  it("returns a function that produces correct names", () => {
    const t = createToolNamer("gemini-cli");
    expect(t("ctx_execute")).toBe("mcp__context-mode__ctx_execute");
    expect(t("ctx_search")).toBe("mcp__context-mode__ctx_search");
  });
});

describe("KNOWN_PLATFORMS", () => {
  it("contains all 12 platforms", () => {
    expect(KNOWN_PLATFORMS).toContain("claude-code");
    expect(KNOWN_PLATFORMS).toContain("gemini-cli");
    expect(KNOWN_PLATFORMS).toContain("antigravity");
    expect(KNOWN_PLATFORMS).toContain("opencode");
    expect(KNOWN_PLATFORMS).toContain("kilo");
    expect(KNOWN_PLATFORMS).toContain("vscode-copilot");
    expect(KNOWN_PLATFORMS).toContain("kiro");
    expect(KNOWN_PLATFORMS).toContain("zed");
    expect(KNOWN_PLATFORMS).toContain("cursor");
    expect(KNOWN_PLATFORMS).toContain("codex");
    expect(KNOWN_PLATFORMS).toContain("openclaw");
    expect(KNOWN_PLATFORMS).toContain("pi");
    expect(KNOWN_PLATFORMS.length).toBe(12);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Routing Block Factory Functions
// ═══════════════════════════════════════════════════════════════════

describe("createRoutingBlock", () => {
  it("produces block with platform-specific tool names for gemini-cli", () => {
    const t = createToolNamer("gemini-cli");
    const block = createRoutingBlock(t);
    expect(block).toContain("mcp__context-mode__ctx_batch_execute");
    expect(block).toContain("mcp__context-mode__ctx_search");
    expect(block).toContain("mcp__context-mode__ctx_execute");
    expect(block).toContain("mcp__context-mode__ctx_fetch_and_index");
    // Must NOT contain claude-code prefix
    expect(block).not.toContain("mcp__plugin_context-mode_context-mode__");
  });

  it("produces block with bare names for cursor", () => {
    const t = createToolNamer("cursor");
    const block = createRoutingBlock(t);
    expect(block).toContain("ctx_batch_execute(commands, queries)");
    expect(block).toContain("ctx_search(queries:");
    expect(block).not.toContain("mcp__");
  });
});

describe("createReadGuidance", () => {
  it("uses kiro-style tool names for kiro platform", () => {
    const t = createToolNamer("kiro");
    const guidance = createReadGuidance(t);
    expect(guidance).toContain("@context-mode/ctx_execute_file");
  });
});

describe("createGrepGuidance", () => {
  it("uses opencode-style tool names for opencode platform", () => {
    const t = createToolNamer("opencode");
    const guidance = createGrepGuidance(t);
    expect(guidance).toContain("context-mode_ctx_execute");
  });
});

describe("createBashGuidance", () => {
  it("uses zed-style tool names for zed platform", () => {
    const t = createToolNamer("zed");
    const guidance = createBashGuidance(t);
    expect(guidance).toContain("mcp:context-mode:ctx_batch_execute");
    expect(guidance).toContain("mcp:context-mode:ctx_execute");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Backward Compat — Static Exports
// ═══════════════════════════════════════════════════════════════════

describe("backward compat static exports", () => {
  it("ROUTING_BLOCK uses claude-code naming", () => {
    expect(ROUTING_BLOCK).toContain(
      "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
    );
    expect(ROUTING_BLOCK).toContain(
      "mcp__plugin_context-mode_context-mode__ctx_search",
    );
  });

  it("READ_GUIDANCE uses claude-code naming", () => {
    expect(READ_GUIDANCE).toContain(
      "mcp__plugin_context-mode_context-mode__ctx_execute_file",
    );
  });

  it("GREP_GUIDANCE uses claude-code naming", () => {
    expect(GREP_GUIDANCE).toContain(
      "mcp__plugin_context-mode_context-mode__ctx_execute",
    );
  });

  it("BASH_GUIDANCE uses claude-code naming", () => {
    expect(BASH_GUIDANCE).toContain(
      "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// routePreToolUse with Platform Parameter
// ═══════════════════════════════════════════════════════════════════

describe("routePreToolUse with platform parameter", () => {
  it("curl block message uses gemini-cli tool names when platform=gemini-cli", () => {
    const result = routePreToolUse("Bash", { command: "curl https://example.com" }, "/tmp", "gemini-cli");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("modify");
    const cmd = (result!.updatedInput as Record<string, string>).command;
    expect(cmd).toContain("mcp__context-mode__ctx_fetch_and_index");
    expect(cmd).toContain("mcp__context-mode__ctx_execute");
    expect(cmd).not.toContain("mcp__plugin_context-mode_context-mode__");
  });

  it("curl block message uses claude-code tool names when platform is omitted", () => {
    const result = routePreToolUse("Bash", { command: "curl https://example.com" }, "/tmp");
    expect(result).not.toBeNull();
    const cmd = (result!.updatedInput as Record<string, string>).command;
    expect(cmd).toContain("mcp__plugin_context-mode_context-mode__ctx_fetch_and_index");
  });

  it("inline HTTP block uses cursor bare names when platform=cursor", () => {
    const result = routePreToolUse("Bash", {
      command: 'python -c "requests.get(\'http://example.com\')"',
    }, "/tmp", "cursor");
    expect(result).not.toBeNull();
    const cmd = (result!.updatedInput as Record<string, string>).command;
    expect(cmd).toContain("ctx_execute");
    expect(cmd).toContain("Think in Code");
    expect(cmd).not.toContain("mcp__");
  });

  it("WebFetch deny uses kiro tool names when platform=kiro", () => {
    const result = routePreToolUse("WebFetch", { url: "https://example.com" }, "/tmp", "kiro");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("deny");
    expect(result!.reason).toContain("@context-mode/ctx_fetch_and_index");
    expect(result!.reason).toContain("@context-mode/ctx_search");
  });

  it("Task is no longer routed — returns null (#241)", () => {
    const result = routePreToolUse("Task", {
      prompt: "Analyze the code",
    }, "/tmp", "opencode");
    expect(result).toBeNull();
  });

  it("Read guidance uses vscode-copilot tool names when platform=vscode-copilot", () => {
    const result = routePreToolUse("Read", { file_path: "/tmp/a.ts" }, "/tmp", "vscode-copilot");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("context");
    expect(result!.additionalContext).toContain("context-mode_ctx_execute_file");
    expect(result!.additionalContext).not.toContain("mcp__plugin_context-mode_context-mode__");
  });

  it("Grep guidance uses zed tool names when platform=zed", () => {
    const result = routePreToolUse("Grep", { pattern: "TODO" }, "/tmp", "zed");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("context");
    expect(result!.additionalContext).toContain("mcp:context-mode:ctx_execute");
  });

  it("Bash guidance uses openclaw bare names when platform=openclaw", () => {
    const result = routePreToolUse("Bash", { command: "ls" }, "/tmp", "openclaw");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("context");
    expect(result!.additionalContext).toContain("ctx_batch_execute");
    expect(result!.additionalContext).toContain("ctx_execute");
    expect(result!.additionalContext).not.toContain("mcp__");
  });

  it("build tool redirect uses platform tool names when platform=gemini-cli", () => {
    const result = routePreToolUse("Bash", { command: "./gradlew build" }, "/tmp", "gemini-cli");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("modify");
    const cmd = (result!.updatedInput as Record<string, string>).command;
    expect(cmd).toContain("mcp__context-mode__ctx_execute");
    expect(cmd).not.toContain("mcp__plugin_context-mode_context-mode__");
  });
});
