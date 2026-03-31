import { describe, it, expect, beforeAll, beforeEach } from "vitest";

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
let READ_GUIDANCE: string;
let GREP_GUIDANCE: string;

beforeAll(async () => {
  const mod = await import("../../hooks/core/routing.mjs");
  routePreToolUse = mod.routePreToolUse;
  resetGuidanceThrottle = mod.resetGuidanceThrottle;

  const constants = await import("../../hooks/routing-block.mjs");
  ROUTING_BLOCK = constants.ROUTING_BLOCK;
  READ_GUIDANCE = constants.READ_GUIDANCE;
  GREP_GUIDANCE = constants.GREP_GUIDANCE;
});

beforeEach(() => {
  if (typeof resetGuidanceThrottle === "function") resetGuidanceThrottle();
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
      expect(result!.reason).toContain("mcp_web_fetch");
      expect(result!.reason).toContain("fetch_and_index");
      expect(result!.reason).toContain("ctx_search");
    });

    it("treats mcp_fetch_tool as WebFetch and blocks it", () => {
      const url = "https://example.com";
      const result = routePreToolUse("mcp_fetch_tool", { url });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reason).toContain("mcp_fetch_tool");
      expect(result!.reason).toContain("fetch_and_index");
      expect(result!.reason).toContain("ctx_search");
    });
  });

  // ─── Task routing ──────────────────────────────────────

  describe("Task tool", () => {
    it("injects ROUTING_BLOCK into prompt", () => {
      const result = routePreToolUse("Task", {
        prompt: "Analyze the codebase",
        subagent_type: "general-purpose",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect(result!.updatedInput).toBeDefined();
      expect((result!.updatedInput as Record<string, string>).prompt).toContain(
        "Analyze the codebase",
      );
      expect((result!.updatedInput as Record<string, string>).prompt).toContain(
        "context_window_protection",
      );
    });

    it("upgrades Bash subagent to general-purpose", () => {
      const result = routePreToolUse("Task", {
        prompt: "Run some commands",
        subagent_type: "Bash",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect(
        (result!.updatedInput as Record<string, string>).subagent_type,
      ).toBe("general-purpose");
    });

    it("keeps non-Bash subagent type unchanged", () => {
      const result = routePreToolUse("Task", {
        prompt: "Do research",
        subagent_type: "general-purpose",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect(
        (result!.updatedInput as Record<string, string>).subagent_type,
      ).toBe("general-purpose");
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
      expect(ROUTING_BLOCK).toContain("native Write tool");
      expect(ROUTING_BLOCK).toContain("Edit tool");
    });

    it("forbidden_actions blocks ctx_execute for file creation", () => {
      expect(ROUTING_BLOCK).toContain(
        "DO NOT use",
      );
      expect(ROUTING_BLOCK).toContain(
        "to create, modify, or overwrite files",
      );
    });

    it("artifact_policy specifies native Write tool", () => {
      expect(ROUTING_BLOCK).toContain(
        "Write artifacts (code, configs, PRDs) to FILES using the native Write tool",
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
