import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// Dynamic import for .mjs module
let routePreToolUse: (
  toolName: string,
  toolInput: Record<string, unknown>,
  projectDir?: string,
) => {
  action: string;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
} | null;

let resetGuidanceThrottle: () => void;
let ROUTING_BLOCK: string;
let createRoutingBlock: (t: any, options?: { includeCommands?: boolean }) => string;
let READ_GUIDANCE: string;
let GREP_GUIDANCE: string;

beforeAll(async () => {
  const mod = await import("../../hooks/core/routing.mjs");
  routePreToolUse = mod.routePreToolUse;
  resetGuidanceThrottle = mod.resetGuidanceThrottle;

  const constants = await import("../../hooks/routing-block.mjs");
  ROUTING_BLOCK = constants.ROUTING_BLOCK;
  createRoutingBlock = constants.createRoutingBlock;
  READ_GUIDANCE = constants.READ_GUIDANCE;
  GREP_GUIDANCE = constants.GREP_GUIDANCE;
});

// MCP readiness sentinel — most tests expect MCP to be ready (deny behavior).
// Tests for graceful degradation (#230) remove sentinel explicitly.
//
// Use an isolated temp dir for sentinels so the directory scan in isMCPReady()
// is not polluted by leftover sentinels from real MCP servers running on the
// developer's machine. The hook honors CONTEXT_MODE_MCP_SENTINEL_DIR.
const _sentinelDir = mkdtempSync(join(tmpdir(), "ctx-test-sentinels-"));
process.env.CONTEXT_MODE_MCP_SENTINEL_DIR = _sentinelDir;
const mcpSentinel = resolve(_sentinelDir, `context-mode-mcp-ready-${process.pid}`);

beforeEach(() => {
  if (typeof resetGuidanceThrottle === "function") resetGuidanceThrottle();
  writeFileSync(mcpSentinel, String(process.pid));
});

afterEach(() => {
  try { unlinkSync(mcpSentinel); } catch {}
});

afterAll(() => {
  try { rmSync(_sentinelDir, { recursive: true, force: true }); } catch {}
  delete process.env.CONTEXT_MODE_MCP_SENTINEL_DIR;
});

describe("routePreToolUse", () => {
  // ─── Bash routing ──────────────────────────────────────

  describe("Bash tool", () => {
    it("denies curl commands with modify action", () => {
      const result = routePreToolUse("Bash", {
        command: "curl https://example.com",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect(result!.updatedInput).toBeDefined();
      expect((result!.updatedInput as Record<string, string>).command).toContain(
        "curl/wget blocked",
      );
    });

    it("denies wget commands with modify action", () => {
      const result = routePreToolUse("Bash", {
        command: "wget https://example.com/file.tar.gz",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain(
        "curl/wget blocked",
      );
    });

    // ─── curl/wget file-output allow-list (#166) ────────────

    it("allows curl -sLo file (silent + file output)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -sL https://example.com/file.tar.gz -o /tmp/file.tar.gz",
      });
      expect(result).toBeNull(); // null = allow through
    });

    it("allows curl -s --output file", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -s --output /tmp/stripe.tar.gz https://github.com/stripe/stripe-cli/releases/download/v1.38.1/stripe.tar.gz",
      });
      expect(result).toBeNull();
    });

    it("allows wget -q -O file (quiet + file output)", () => {
      const result = routePreToolUse("Bash", {
        command: "wget -q -O /tmp/terraform.zip https://releases.hashicorp.com/terraform/1.0.0/terraform_1.0.0_linux_amd64.zip",
      });
      expect(result).toBeNull();
    });

    it("allows curl -s > file (silent + shell redirect)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -s https://example.com/data.json > /tmp/data.json",
      });
      expect(result).toBeNull();
    });

    it("blocks curl -o - (stdout alias)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -s -o - https://example.com",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("blocks curl -o file WITHOUT silent flag", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -L -o /tmp/file.tar.gz https://example.com/file.tar.gz",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("blocks curl -o file with --verbose", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -s --verbose -o /tmp/file.tar.gz https://example.com/file.tar.gz",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("blocks chained: curl -sLo file && curl url (second floods)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -sL -o /tmp/file.tar.gz https://example.com/a.tar.gz && curl https://example.com/api",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("allows chained: curl -sLo file && tar xzf file (both safe)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -sL -o /tmp/file.tar.gz https://example.com/a.tar.gz && tar xzf /tmp/file.tar.gz -C /tmp",
      });
      expect(result).toBeNull();
    });

    it("denies inline fetch() with modify action", () => {
      const result = routePreToolUse("Bash", {
        command: 'node -e "fetch(\'https://api.example.com/data\')"',
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain(
        "Inline HTTP blocked",
      );
    });

    it("denies requests.get() with modify action", () => {
      const result = routePreToolUse("Bash", {
        command: 'python -c "import requests; requests.get(\'https://example.com\')"',
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain(
        "Inline HTTP blocked",
      );
    });

    it("allows git status with BASH_GUIDANCE context", () => {
      const result = routePreToolUse("Bash", { command: "git status" });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
      expect(result!.additionalContext).toBeDefined();
    });

    it("allows mkdir with BASH_GUIDANCE context", () => {
      const result = routePreToolUse("Bash", {
        command: "mkdir -p /tmp/test-dir",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
    });

    it("allows npm install with BASH_GUIDANCE context", () => {
      const result = routePreToolUse("Bash", { command: "npm install" });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
    });

    it("redirects ./gradlew build to execute sandbox", () => {
      const result = routePreToolUse("Bash", {
        command: "./gradlew build",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain(
        "Build tool redirected",
      );
    });

    it("redirects gradle test to execute sandbox", () => {
      const result = routePreToolUse("Bash", {
        command: "gradle test --info",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("redirects mvn package to execute sandbox", () => {
      const result = routePreToolUse("Bash", {
        command: "mvn clean package -DskipTests",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("redirects ./mvnw verify to execute sandbox", () => {
      const result = routePreToolUse("Bash", {
        command: "./mvnw verify",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("does not false-positive on gradle in quoted text", () => {
      const result = routePreToolUse("Bash", {
        command: 'echo "run gradle build to compile"',
      });
      expect(result).not.toBeNull();
      // stripped version removes quoted content → no gradle match → context
      expect(result!.action).toBe("context");
    });
  });

  // ─── Read routing ──────────────────────────────────────

  describe("Read tool", () => {
    it("returns context action with READ_GUIDANCE", () => {
      const result = routePreToolUse("Read", {
        file_path: "/some/file.ts",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
      expect(result!.additionalContext).toBe(READ_GUIDANCE);
    });
  });

  // ─── Grep routing ──────────────────────────────────────

  describe("Grep tool", () => {
    it("returns context action with GREP_GUIDANCE", () => {
      const result = routePreToolUse("Grep", {
        pattern: "TODO",
        path: "/some/dir",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
      expect(result!.additionalContext).toBe(GREP_GUIDANCE);
    });
  });

  // ─── WebFetch routing ──────────────────────────────────

  describe("WebFetch tool", () => {
    it("returns deny action with redirect message", () => {
      const result = routePreToolUse("WebFetch", {
        url: "https://docs.example.com",
        prompt: "Get the docs",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reason).toContain("WebFetch blocked");
      expect(result!.reason).toContain("fetch_and_index");
    });

    it("includes the URL in deny reason", () => {
      const url = "https://api.github.com/repos/test";
      const result = routePreToolUse("WebFetch", { url });
      expect(result).not.toBeNull();
      expect(result!.reason).toContain(url);
    });

    it("treats mcp_web_fetch as WebFetch and blocks it", () => {
      const url = "https://example.com";
      const result = routePreToolUse("mcp_web_fetch", { url });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reason).toContain("WebFetch blocked");
      expect(result!.reason).toContain("fetch_and_index");
      expect(result!.reason).toContain("ctx_search");
    });

    it("treats mcp_fetch_tool as WebFetch and blocks it", () => {
      const url = "https://example.com";
      const result = routePreToolUse("mcp_fetch_tool", { url });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reason).toContain("WebFetch blocked");
      expect(result!.reason).toContain("fetch_and_index");
      expect(result!.reason).toContain("ctx_search");
    });

    it("allows WebFetch when MCP server not ready (#230)", () => {
      // Remove sentinel to simulate MCP not started
      try { unlinkSync(mcpSentinel); } catch {}
      const result = routePreToolUse("WebFetch", { url: "https://example.com" });
      expect(result).toBeNull();
    });

    it("allows mcp_web_fetch alias when MCP server not ready (#230)", () => {
      try { unlinkSync(mcpSentinel); } catch {}
      const result = routePreToolUse("mcp_web_fetch", { url: "https://example.com" });
      expect(result).toBeNull();
    });
  });

  // ─── MCP readiness: all redirects degrade gracefully (#230) ───

  describe("MCP readiness graceful degradation (#230)", () => {
    it("allows curl when MCP server not ready", () => {
      try { unlinkSync(mcpSentinel); } catch {}
      const result = routePreToolUse("Bash", { command: "curl https://example.com" });
      expect(result).toBeNull();
    });

    it("allows inline HTTP when MCP server not ready", () => {
      try { unlinkSync(mcpSentinel); } catch {}
      const result = routePreToolUse("Bash", { command: "node -e \"fetch('https://example.com')\"" });
      expect(result).toBeNull();
    });

    it("allows build tools when MCP server not ready", () => {
      try { unlinkSync(mcpSentinel); } catch {}
      const result = routePreToolUse("Bash", { command: "./gradlew build" });
      expect(result).toBeNull();
    });
  });

  // ─── Subagent ctx_commands omission (#233) ──────────────

  describe("Subagent ctx_commands omission (#233)", () => {
    it("Agent subagent prompt omits ctx_commands", () => {
      const result = routePreToolUse("Agent", {
        prompt: "Search the codebase",
        subagent_type: "general-purpose",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      const prompt = (result!.updatedInput as Record<string, string>).prompt;
      expect(prompt).not.toContain("<ctx_commands>");
      expect(prompt).toContain("<tool_selection_hierarchy>");
    });

    it("ROUTING_BLOCK constant includes ctx_commands for main session", () => {
      expect(ROUTING_BLOCK).toContain("<ctx_commands>");
      expect(ROUTING_BLOCK).toContain("ctx stats");
    });

    it("createRoutingBlock with includeCommands: false omits section", () => {
      const t = (name: string) => `mcp__test__${name}`;
      const block = createRoutingBlock(t, { includeCommands: false });
      expect(block).not.toContain("<ctx_commands>");
      expect(block).toContain("<tool_selection_hierarchy>");
    });

    it("createRoutingBlock default includes ctx_commands", () => {
      const t = (name: string) => `mcp__test__${name}`;
      const block = createRoutingBlock(t);
      expect(block).toContain("<ctx_commands>");
    });
  });

  // ─── Task routing (#241: removed — substring matching catches TaskCreate etc.) ──

  describe("Task tool (#241)", () => {
    it("returns null (passthrough) — no longer intercepted", () => {
      const result = routePreToolUse("Task", {
        prompt: "Analyze the codebase",
        subagent_type: "general-purpose",
      });
      expect(result).toBeNull();
    });

    it("TaskCreate returns null (passthrough)", () => {
      const result = routePreToolUse("TaskCreate", {
        title: "my task",
      });
      expect(result).toBeNull();
    });

    it("TaskUpdate returns null (passthrough)", () => {
      const result = routePreToolUse("TaskUpdate", {
        id: "123",
        status: "done",
      });
      expect(result).toBeNull();
    });
  });

  // ─── MCP tools ─────────────────────────────────────────

  describe("MCP execute tools", () => {
    it("passes through non-shell execute", () => {
      const result = routePreToolUse(
        "mcp__plugin_context-mode_context-mode__ctx_execute",
        { language: "javascript", code: "console.log('hello')" },
      );
      expect(result).toBeNull();
    });

    it("passes through execute_file without security", () => {
      const result = routePreToolUse(
        "mcp__plugin_context-mode_context-mode__ctx_execute_file",
        {
          path: "/some/file.log",
          language: "python",
          code: "print(len(FILE_CONTENT))",
        },
      );
      expect(result).toBeNull();
    });

    it("passes through batch_execute without security", () => {
      const result = routePreToolUse(
        "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
        {
          commands: [{ label: "test", command: "ls -la" }],
          queries: ["file list"],
        },
      );
      expect(result).toBeNull();
    });
  });

  // ─── Routing block content ──────────────────────────────

  describe("routing block content", () => {
    it("contains file_writing_policy forbidding ctx_execute for file writes", () => {
      expect(ROUTING_BLOCK).toContain("<file_writing_policy>");
      expect(ROUTING_BLOCK).toContain("NEVER use");
      expect(ROUTING_BLOCK).toContain("ctx_execute");
      expect(ROUTING_BLOCK).toContain("native Write/Edit tools");
    });

    it("forbidden_actions blocks ctx_execute for file creation", () => {
      expect(ROUTING_BLOCK).toContain(
        "NO",
      );
      expect(ROUTING_BLOCK).toContain(
        "for file creation/modification",
      );
    });

    it("artifact_policy specifies native Write tool", () => {
      expect(ROUTING_BLOCK).toContain(
        "Write artifacts (code, configs, PRDs) to FILES. NEVER inline.",
      );
    });
  });

  // ─── Unknown tools ─────────────────────────────────────

  describe("unknown tools", () => {
    it("returns null for Glob", () => {
      const result = routePreToolUse("Glob", { pattern: "**/*.ts" });
      expect(result).toBeNull();
    });

    it("returns null for Edit", () => {
      const result = routePreToolUse("Edit", {
        file_path: "/some/file.ts",
        old_string: "foo",
        new_string: "bar",
      });
      expect(result).toBeNull();
    });

    it("returns null for Write", () => {
      const result = routePreToolUse("Write", {
        file_path: "/some/file.ts",
        content: "hello",
      });
      expect(result).toBeNull();
    });

    it("returns null for WebSearch", () => {
      const result = routePreToolUse("WebSearch", {
        query: "vitest documentation",
      });
      expect(result).toBeNull();
    });
  });
});
