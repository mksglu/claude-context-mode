import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { spawn } from "node:child_process";
import {
  writeFileSync,
  mkdirSync,
  unlinkSync,
  existsSync,
  readdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  sentinelDir,
  sentinelPathForPid,
  isMCPReady,
} from "../../hooks/core/mcp-ready.mjs";

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
let initSecurity: (buildDir: string) => Promise<boolean>;
let ROUTING_BLOCK: string;
let createRoutingBlock: (t: any, options?: { includeCommands?: boolean }) => string;
let READ_GUIDANCE: string;
let GREP_GUIDANCE: string;

beforeAll(async () => {
  const mod = await import("../../hooks/core/routing.mjs");
  routePreToolUse = mod.routePreToolUse;
  resetGuidanceThrottle = mod.resetGuidanceThrottle;
  initSecurity = mod.initSecurity;

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

    it("git status — bypassed by structurally-bounded allowlist (#463)", () => {
      // Pre-#463: this returned BASH_GUIDANCE context. The #463 allowlist
      // now short-circuits the nudge for read-only git subcommands so the
      // guidance reads as signal, not noise.
      const result = routePreToolUse("Bash", { command: "git status" });
      expect(result).toBeNull();
    });

    it("mkdir — bypassed by structurally-bounded allowlist (#463)", () => {
      const result = routePreToolUse("Bash", {
        command: "mkdir -p /tmp/test-dir",
      });
      expect(result).toBeNull();
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
      // Use a command whose first word is NOT in the #463 structurally-bounded
      // allowlist (`echo` is allowlisted), so we still exercise the
      // strip-quotes-then-match-gradle path. The intent is to prove the
      // gradle build-tool redirect doesn't fire on quoted occurrences.
      const result = routePreToolUse("Bash", {
        command: 'find . -name "run gradle build to compile"',
      });
      expect(result).not.toBeNull();
      // stripped version removes quoted content → no gradle match → context
      expect(result!.action).toBe("context");
    });

    // Issue #406 — sbt added alongside gradle/maven
    it("redirects sbt compile to execute sandbox (Issue #406)", () => {
      const result = routePreToolUse("Bash", {
        command: "sbt compile",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain(
        "Build tool redirected",
      );
    });

    it("redirects ./sbt test to execute sandbox", () => {
      const result = routePreToolUse("Bash", {
        command: "./sbt test",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("does not false-positive on substrings like gradle-wrapper-config or mvnDocker", () => {
      // Word-boundary guard — these are NOT gradle/mvn invocations.
      const r1 = routePreToolUse("Bash", { command: "ls gradle-wrapper-config" });
      expect(r1?.action).not.toBe("modify");
      const r2 = routePreToolUse("Bash", { command: "echo mvnDocker-image" });
      // Quoted/echo passes context, not modify
      expect(r2?.action).not.toBe("modify");
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

  describe("Codex context-mode MCP execute security", () => {
    let projectDir: string;

    beforeAll(async () => {
      await initSecurity(resolve(process.cwd(), "build"));
    });

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "ctx-codex-routing-"));
      mkdirSync(join(projectDir, ".claude"), { recursive: true });
      writeFileSync(
        join(projectDir, ".claude", "settings.local.json"),
        JSON.stringify({ permissions: { deny: ["Bash(sudo *)"] } }),
        "utf-8",
      );
    });

    afterEach(() => {
      try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
    });

    it.each([
      ["ctx_execute", { language: "shell", code: "sudo whoami" }],
      ["mcp__other__ctx_execute", { language: "shell", code: "sudo whoami" }],
      ["ctx_execute_file", { path: "script.sh", language: "shell", code: "sudo whoami" }],
      ["mcp__other__ctx_execute_file", { path: "script.sh", language: "shell", code: "sudo whoami" }],
      ["ctx_batch_execute", { commands: [{ label: "bad", command: "sudo whoami" }] }],
      ["mcp__other__ctx_batch_execute", { commands: [{ label: "bad", command: "sudo whoami" }] }],
    ])("denies shell policy matches for %s", (toolName, toolInput) => {
      const result = routePreToolUse(toolName, toolInput, projectDir);
      expect(result?.action).toBe("deny");
      expect(result?.reason).toContain("deny pattern");
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

  // ─── External MCP tools (#529) ──────────────────────────
  //
  // hooks/hooks.json registers a `mcp__(?!plugin_context-mode_)` matcher so
  // PreToolUse fires on slack/telegram/gdrive/notion-style MCPs whose payloads
  // would otherwise spill into context before PostToolUse can act. The routing
  // branch emits a one-shot context guidance nudge — same throttle model as
  // bash/read/grep guidance.
  describe("External MCP tools (#529)", () => {
    it("emits context guidance for an external slack-style MCP tool", () => {
      const result = routePreToolUse("mcp__slack__list_channels", {});
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
      expect(result!.additionalContext).toContain("External MCP tools");
    });

    it("emits context guidance for telegram, gdrive, and notion namespaces", () => {
      const tools = [
        "mcp__plugin_telegram__list_messages",
        "mcp__claude_ai_Google_Drive__search",
        "mcp__notion__query_database",
      ];
      for (const tool of tools) {
        resetGuidanceThrottle();
        const result = routePreToolUse(tool, {});
        expect(result, `expected guidance for ${tool}`).not.toBeNull();
        expect(result!.action).toBe("context");
      }
    });

    it("does NOT match context-mode's own MCP tools (no double-firing)", () => {
      // These are routed by dedicated branches above (ctx_execute,
      // ctx_execute_file, ctx_batch_execute) — they must NOT receive the
      // external-MCP guidance, which would be redundant noise.
      const contextModeTools = [
        "mcp__plugin_context-mode_context-mode__ctx_execute",
        "mcp__plugin_context-mode_context-mode__ctx_execute_file",
        "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
        "mcp__context-mode__ctx_execute",
      ];
      for (const tool of contextModeTools) {
        resetGuidanceThrottle();
        const result = routePreToolUse(tool, { language: "javascript", code: "1+1" });
        // ctx_execute returns null (no security violation, no guidance).
        // The external-MCP branch must NOT have run for these.
        if (result !== null) {
          expect(result.additionalContext ?? "").not.toContain("External MCP tools");
        }
      }
    });

    it("respects the once-per-session guidance throttle", () => {
      const first = routePreToolUse("mcp__slack__post_message", {});
      expect(first).not.toBeNull();
      expect(first!.action).toBe("context");

      // Second call in the same session — guidanceOnce should suppress it.
      const second = routePreToolUse("mcp__slack__list_users", {});
      expect(second).toBeNull();
    });

    it("does NOT match plain Bash/Read/etc as external MCP", () => {
      // Sanity: tools without the mcp__ prefix should not hit this branch.
      // Use a tool name the routing branches don't otherwise handle (Bash
      // would return a guidance from its own branch).
      const result = routePreToolUse("Glob", { pattern: "**/*.ts" });
      expect(result).toBeNull();
    });

    it("treats external MCP tools whose tool part contains 'context-mode' as external", () => {
      // Guards against the substring-on-full-name false negative: only the
      // server segment (first chunk after the mcp__ prefix) is checked, so a
      // notion / slack / etc tool that happens to mention context-mode in its
      // tool name still receives the external-MCP guidance.
      const externals = [
        "mcp__notion__search_context-mode_notes",
        "mcp__slack__post_to_context-mode_channel",
      ];
      for (const tool of externals) {
        resetGuidanceThrottle();
        const result = routePreToolUse(tool, {});
        expect(result, `expected guidance for ${tool}`).not.toBeNull();
        expect(result!.action).toBe("context");
        expect(result!.additionalContext).toContain("External MCP tools");
      }
    });

    it("does NOT trip on degenerate tool names (empty / bare prefix / null)", () => {
      // String() coerces these to non-MCP names — must pass through silently.
      for (const tool of ["", "mcp__", null as unknown as string, undefined as unknown as string]) {
        resetGuidanceThrottle();
        const result = routePreToolUse(tool, {});
        // Either null (passthrough) or NOT external-MCP guidance — never the
        // external-MCP branch.
        if (result !== null) {
          expect(result.additionalContext ?? "").not.toContain("External MCP tools");
        }
      }
    });
  });
});

// ─── mcp-ready.mjs regression matrix (#347 guard) ──────────────────────────
//
// PR #347 replaced the PPID-keyed sentinel lookup with a directory-scan over
// `<sentinelDir()>/context-mode-mcp-ready-*` files. These tests lock in the
// directory-scan contract so a future refactor cannot silently regress to a
// PPID-coupled lookup. The test runner's own sentinel (written by the
// file-level beforeEach above) is removed inside cleanup tests where its
// presence would mask dead-PID cleanup.

const SENTINEL_PREFIX = "context-mode-mcp-ready-";
const DEAD_PID = 2_147_483_647; // INT32_MAX — never a live PID on any platform

const fixtures = new Set<string>();
function createSentinel(pidOrLabel: number | string, content?: string): string {
  const path = join(sentinelDir(), `${SENTINEL_PREFIX}${pidOrLabel}`);
  writeFileSync(path, content ?? String(pidOrLabel));
  fixtures.add(path);
  return path;
}

function hasUnrelatedLiveSentinel(): boolean {
  try {
    const dir = sentinelDir();
    for (const f of readdirSync(dir).filter((f) => f.startsWith(SENTINEL_PREFIX))) {
      try {
        const pid = parseInt(readFileSync(join(dir, f), "utf8"), 10);
        if (!Number.isNaN(pid) && pid !== process.pid) {
          process.kill(pid, 0);
          return true;
        }
      } catch { /* dead — ignore */ }
    }
    return false;
  } catch {
    return false;
  }
}
const POLLUTED = hasUnrelatedLiveSentinel();

describe("mcp-ready: contract", () => {
  afterEach(() => {
    for (const p of fixtures) {
      try { unlinkSync(p); } catch { /* already gone */ }
    }
    fixtures.clear();
  });

  it("sentinelPathForPid joins sentinelDir + prefix + pid", () => {
    expect(sentinelPathForPid(12345)).toBe(join(sentinelDir(), `${SENTINEL_PREFIX}12345`));
  });

  describe("sentinelDir platform branch", () => {
    let originalPlatform: NodeJS.Platform;
    let originalEnv: string | undefined;
    beforeEach(() => {
      originalPlatform = process.platform;
      originalEnv = process.env.CONTEXT_MODE_MCP_SENTINEL_DIR;
      delete process.env.CONTEXT_MODE_MCP_SENTINEL_DIR;
    });
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      if (originalEnv !== undefined) {
        process.env.CONTEXT_MODE_MCP_SENTINEL_DIR = originalEnv;
      }
    });

    it("returns os.tmpdir() on win32", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      expect(sentinelDir()).toBe(tmpdir());
    });

    it("returns /tmp on non-win32", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      expect(sentinelDir()).toBe("/tmp");
    });
  });

  it("isMCPReady returns true when a sentinel with a live PID exists", () => {
    createSentinel(process.pid);
    expect(isMCPReady()).toBe(true);
  });

  it.each([
    ["empty payload", "test-empty-9991", ""],
    ["non-numeric payload", "test-garbage-9992", "abc"],
  ])("isMCPReady does not throw on %s sentinels", (_label, pid, content) => {
    createSentinel(pid, content);
    expect(() => isMCPReady()).not.toThrow();
  });
});

describe.skipIf(POLLUTED)("mcp-ready: stale-cleanup self-healing", () => {
  // The file-level beforeEach above writes a live sentinel at process.pid,
  // which would mask the cleanup we want to verify. Remove it here.
  beforeEach(() => {
    try { unlinkSync(mcpSentinel); } catch {}
  });

  afterEach(() => {
    for (const p of fixtures) {
      try { unlinkSync(p); } catch { /* already gone */ }
    }
    fixtures.clear();
  });

  it("unlinks a sentinel whose PID is dead", () => {
    const path = createSentinel(DEAD_PID);
    isMCPReady();
    expect(existsSync(path)).toBe(false);
    fixtures.delete(path);
  });

  it("unlinks two dead sentinels in a single scan", () => {
    const a = createSentinel(DEAD_PID);
    const b = createSentinel(DEAD_PID - 1);
    expect(isMCPReady()).toBe(false);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    fixtures.delete(a);
    fixtures.delete(b);
  });
});

describe("mcp-ready: PPID-independence (regression for #347)", () => {
  it("returns true when the only live sentinel is at a child PID outside the runner's process tree", async () => {
    // Pass the resolved sentinel directory in via env var so the child does not
    // re-derive it — keeps mcp-ready.mjs as the single source of truth for the
    // path shape, and avoids node-CLI argv ambiguity with `-e`.
    const childScript = `
      const { writeFileSync, unlinkSync } = require("node:fs");
      const { join } = require("node:path");
      const dir = process.env.MCP_SENTINEL_DIR;
      const path = join(dir, "context-mode-mcp-ready-" + process.pid);
      writeFileSync(path, String(process.pid));
      const cleanup = () => { try { unlinkSync(path); } catch {} process.exit(0); };
      process.on("SIGTERM", cleanup);
      process.on("SIGINT", cleanup);
      setInterval(() => {}, 1000);
    `;
    const resolvedDir = sentinelDir();
    const child = spawn(process.execPath, ["-e", childScript], {
      stdio: "ignore",
      env: { ...process.env, MCP_SENTINEL_DIR: resolvedDir },
    });
    const childPid = child.pid!;
    const childSentinel = join(resolvedDir, `${SENTINEL_PREFIX}${childPid}`);

    try {
      // Wait up to 2s for child to write its sentinel.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !existsSync(childSentinel)) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(childSentinel)).toBe(true);

      // The regression-defining assertion: the sentinel's PID is not in the
      // test runner's process tree. A PPID-keyed lookup would return false here.
      expect(childPid).not.toBe(process.pid);
      expect(childPid).not.toBe(process.ppid);

      // Directory-scan finds the child's sentinel regardless of PPID.
      expect(isMCPReady()).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((r) => child.on("exit", () => r()));
      try { unlinkSync(childSentinel); } catch { /* child cleaned up */ }
    }
  });
});

// ─────────────────────────────────────────────────────────
// Slice 4 — additionalContext surfacing on security init fail (#558)
// ─────────────────────────────────────────────────────────
//
// The pre-558 silent-fail UX gap: when initSecurity() fails to load the
// security module (marketplace install missing build/security.js AND
// hooks/security.bundle.mjs), the only signal is a stderr WARNING line
// that adapters typically suppress / discard. The user has no in-band
// signal that permissions.deny is fail-open.
//
// Fix: routing.mjs exposes `buildSecurityWarningContext()` — a pure
// helper that returns a structured agent-facing block when
// isSecurityInitFailed() is true, and null otherwise. SessionStart
// hooks call initSecurity() and append the block to their
// additionalContext, so the agent sees the warning in-context (not
// just in suppressed stderr).

describe("buildSecurityWarningContext — agent-facing security warning (#558)", () => {
  it("returns null when security init has not failed (default state)", async () => {
    // Use a subprocess so the module-scoped securityInitFailed flag
    // is in its initial false state — the in-process module from
    // beforeAll() above may have been touched by other tests.
    const r = await spawnRoutingProbe(`
      import { buildSecurityWarningContext, isSecurityInitFailed } from ${routingUrl()};
      process.stdout.write(JSON.stringify({
        failed: isSecurityInitFailed(),
        warning: buildSecurityWarningContext(),
      }));
    `);
    expect(r.parsed.failed).toBe(false);
    expect(r.parsed.warning).toBeNull();
  });

  it("returns a structured warning string when security init has failed", async () => {
    const missingBundle = join(tmpdir(), `ctx-slice4-no-bundle-${Date.now()}.bundle.mjs`);
    const missingBuild = join(tmpdir(), `ctx-slice4-no-build-${Date.now()}`);
    const r = await spawnRoutingProbe(
      `
      import { initSecurity, buildSecurityWarningContext, isSecurityInitFailed } from ${routingUrl()};
      await initSecurity(${JSON.stringify(missingBuild)});
      process.stdout.write(JSON.stringify({
        failed: isSecurityInitFailed(),
        warning: buildSecurityWarningContext(),
      }));
      `,
      {
        CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "1",
        CONTEXT_MODE_SECURITY_BUNDLE_PATH: missingBundle,
      },
    );
    expect(r.parsed.failed).toBe(true);
    expect(r.parsed.warning).toBeTruthy();
    expect(typeof r.parsed.warning).toBe("string");
    // Must mention the security gap and the remediation, AND must use
    // a recognizable XML-ish wrapper so the agent can parse / scope it.
    expect(r.parsed.warning).toMatch(/security/i);
    expect(r.parsed.warning).toMatch(/permissions\.deny|deny pattern/i);
    expect(r.parsed.warning).toMatch(/<context_mode_security_warning>|security_warning/);
    // Must point users at the actionable fix.
    expect(r.parsed.warning).toMatch(/npm run bundle|security\.bundle\.mjs|reinstall/i);
  });

  it("hooks/sessionstart.mjs wires initSecurity + buildSecurityWarningContext into the SessionStart additionalContext", () => {
    // Static-source check — the wiring must be present in the
    // top-level Claude Code SessionStart hook so users see the
    // warning in-band on first session of a broken install.
    const src = readFileSync(resolve(SLICE4_DIRNAME, "..", "..", "hooks", "sessionstart.mjs"), "utf-8");
    expect(src).toContain("initSecurity");
    expect(src).toContain("buildSecurityWarningContext");
    expect(src).toContain("isSecurityInitFailed");
  });
});

/**
 * Helper — spawn a fresh node subprocess and run a small ESM snippet
 * against routing.mjs. Returns parsed stdout JSON. Each call is
 * isolated (no shared module state) so the global securityInitFailed
 * flag starts false in every test.
 */
const SLICE4_DIRNAME = (() => {
  // ESM-safe __dirname for the slice 4 helpers (vitest's main file
  // doesn't have one). Lazily evaluated to avoid touching top-level state.
  const { fileURLToPath } = require("node:url");
  const { dirname } = require("node:path");
  return dirname(fileURLToPath(import.meta.url));
})();

function routingUrl(): string {
  const path = resolve(SLICE4_DIRNAME, "..", "..", "hooks", "core", "routing.mjs");
  // pathToFileURL handles Windows drive letters correctly.
  const { pathToFileURL } = require("node:url");
  return JSON.stringify(pathToFileURL(path).href);
}

async function spawnRoutingProbe(
  code: string,
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; parsed: any }> {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("node", ["--input-type=module", "-e", code], {
    encoding: "utf-8",
    timeout: 15_000,
    env: { ...process.env, ...env },
  });
  const stdout = (r.stdout ?? "").trim();
  let parsed: any = null;
  try { parsed = JSON.parse(stdout); } catch { /* surface raw */ }
  return { status: r.status, stdout, parsed };
}
