import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { CursorAdapter } from "../../src/adapters/cursor/index.js";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(process.cwd(), "tests", "fixtures", "cursor", name), "utf-8"),
  ) as Record<string, unknown>;

describe("CursorAdapter", () => {
  let adapter: CursorAdapter;

  beforeEach(() => {
    adapter = new CursorAdapter();
  });

  describe("capabilities", () => {
    it("enables native Cursor v1 hooks without preCompact", () => {
      expect(adapter.capabilities.preToolUse).toBe(true);
      expect(adapter.capabilities.postToolUse).toBe(true);
      expect(adapter.capabilities.sessionStart).toBe(false);
      expect(adapter.capabilities.preCompact).toBe(false);
      expect(adapter.capabilities.canModifyArgs).toBe(true);
      expect(adapter.capabilities.canModifyOutput).toBe(false);
      expect(adapter.capabilities.canInjectSessionContext).toBe(true);
    });

    it("paradigm is json-stdio", () => {
      expect(adapter.paradigm).toBe("json-stdio");
    });
  });

  describe("parsePreToolUseInput", () => {
    it("parses built-in tool fixtures", () => {
      const event = adapter.parsePreToolUseInput(fixture("pretooluse-shell.json"));
      expect(event.toolName).toBe("Shell");
      expect(event.toolInput).toEqual({ command: "curl https://example.com/api" });
      expect(event.sessionId).toBe("cursor-conv-001");
      expect(event.projectDir).toBe("/tmp/cursor-project");
    });

    it("parses MCP tool fixtures", () => {
      const event = adapter.parsePreToolUseInput(fixture("pretooluse-mcp.json"));
      expect(event.toolName).toBe("MCP:ctx_execute");
      expect(event.toolInput).toEqual({ language: "shell", code: "npm test" });
      expect(event.sessionId).toBe("cursor-conv-001");
    });
  });

  describe("parsePostToolUseInput", () => {
    it("parses tool output", () => {
      const event = adapter.parsePostToolUseInput(fixture("posttooluse-shell.json"));
      expect(event.toolName).toBe("Shell");
      expect(event.toolOutput).toContain("src/app.ts");
      expect(event.isError).toBe(false);
    });
  });

  describe("parseSessionStartInput", () => {
    it("maps startup source", () => {
      const event = adapter.parseSessionStartInput(fixture("sessionstart.json"));
      expect(event.source).toBe("startup");
      expect(event.sessionId).toBe("cursor-conv-001");
      expect(event.projectDir).toBe("/tmp/cursor-project");
    });

    it("uses workspace_roots when cwd is absent", () => {
      const event = adapter.parseSessionStartInput({
        conversation_id: "cursor-conv-003",
        workspace_roots: ["/tmp/cursor-project"],
      });
      expect(event.source).toBe("startup");
      expect(event.sessionId).toBe("cursor-conv-003");
      expect(event.projectDir).toBe("/tmp/cursor-project");
    });

    it("maps trigger fallback", () => {
      const event = adapter.parseSessionStartInput({
        trigger: "resume",
        cwd: "/tmp/cursor-project",
        conversation_id: "cursor-conv-002",
      });
      expect(event.source).toBe("resume");
      expect(event.sessionId).toBe("cursor-conv-002");
    });
  });

  describe("formatPreToolUseResponse", () => {
    it("formats deny with native Cursor fields", () => {
      expect(
        adapter.formatPreToolUseResponse({ decision: "deny", reason: "Blocked" }),
      ).toEqual({
        permission: "deny",
        user_message: "Blocked",
      });
    });

    it("formats modify with updated_input", () => {
      const updatedInput = { command: "echo blocked" };
      expect(
        adapter.formatPreToolUseResponse({ decision: "modify", updatedInput }),
      ).toEqual({ updated_input: updatedInput });
    });

    it("formats context with agent_message", () => {
      expect(
        adapter.formatPreToolUseResponse({
          decision: "context",
          additionalContext: "Use sandbox tools.",
        }),
      ).toEqual({ agent_message: "Use sandbox tools." });
    });

    it("formats ask with permission ask", () => {
      expect(adapter.formatPreToolUseResponse({ decision: "ask" })).toEqual({
        permission: "ask",
        user_message: "Action requires user confirmation (security policy)",
      });
    });

    it("returns minimal agent_message when empty", () => {
      expect(adapter.formatPreToolUseResponse({} as any)).toEqual({
        agent_message: "",
      });
    });
  });

  describe("formatPostToolUseResponse", () => {
    it("formats additional_context", () => {
      expect(
        adapter.formatPostToolUseResponse({ additionalContext: "Captured." }),
      ).toEqual({ additional_context: "Captured." });
    });

    it("returns minimal additional_context when empty", () => {
      expect(adapter.formatPostToolUseResponse({})).toEqual({ additional_context: "" });
    });
  });

  describe("formatSessionStartResponse", () => {
    it("formats additional_context", () => {
      expect(adapter.formatSessionStartResponse({ context: "Resume here." })).toEqual({
        additional_context: "Resume here.",
      });
    });

    it("returns minimal additional_context when empty", () => {
      expect(adapter.formatSessionStartResponse({})).toEqual({
        additional_context: "",
      });
    });
  });

  describe("config paths", () => {
    it("uses native project hooks path", () => {
      expect(adapter.getSettingsPath()).toBe(resolve(".cursor", "hooks.json"));
    });

    it("uses a dedicated Cursor session dir", () => {
      expect(adapter.getSessionDir()).toBe(
        join(homedir(), ".cursor", "context-mode", "sessions"),
      );
    });
  });

  describe("hook config management", () => {
    let tempDir: string;
    let projectCursorDir: string;
    let projectCursorDirExisted: boolean;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "cursor-adapter-test-"));
      projectCursorDir = resolve(".cursor");
      projectCursorDirExisted = existsSync(projectCursorDir);
      Object.defineProperty(adapter, "getSettingsPath", {
        value: () => join(tempDir, "hooks.json"),
        configurable: true,
      });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
      try { rmSync(resolve(".cursor", "mcp.json"), { force: true }); } catch { /* best effort */ }
      if (!projectCursorDirExisted) {
        try { rmSync(resolve(".cursor"), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });

    it("generates native Cursor hook entries for v1 hooks only", () => {
      const config = adapter.generateHookConfig(process.cwd()) as Record<string, unknown>;
      expect(Object.keys(config).sort()).toEqual([
        "afterAgentResponse",
        "postToolUse",
        "preToolUse",
        "sessionStart",
        "stop",
      ]);
      expect(config.preCompact).toBeUndefined();
    });

    it("writes project hooks in native Cursor format", () => {
      const changes = adapter.configureAllHooks(process.cwd());
      const written = JSON.parse(
        readFileSync(join(tempDir, "hooks.json"), "utf-8"),
      ) as Record<string, unknown>;

      expect(changes).toContain(`Wrote native Cursor hooks to ${join(tempDir, "hooks.json")}`);
      expect(written.version).toBe(1);
      expect(written.hooks).toBeTruthy();

      const hooks = written.hooks as Record<string, Array<Record<string, unknown>>>;
      expect(String(hooks.preToolUse?.[0]?.command)).toContain("hook cursor pretooluse");
      expect(String(hooks.postToolUse?.[0]?.command)).toContain("hook cursor posttooluse");
      expect(String(hooks.sessionStart?.[0]?.command)).toContain("hook cursor sessionstart");
      expect(hooks.preCompact).toBeUndefined();
    });

    it("validates native project hooks before compatibility fallbacks", () => {
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(
        join(tempDir, "hooks.json"),
        JSON.stringify({
          version: 1,
          hooks: {
            preToolUse: [{ type: "command", command: "context-mode hook cursor pretooluse" }],
            sessionStart: [{ type: "command", command: "context-mode hook cursor sessionstart" }],
          },
        }, null, 2),
      );

      const results = adapter.validateHooks(process.cwd());

      expect(results[0]?.check).toBe("Native hook config");
      expect(results[0]?.status).toBe("pass");
      expect(results.find((result) => result.check === "preToolUse")?.status).toBe("pass");
      // sessionStart is not validated — Cursor rejects it currently
      expect(results.find((result) => result.check === "postToolUse")?.status).toBe("warn");
      expect(results.find((result) => result.check === "Claude compatibility")?.status).toBe("warn");
    });

    it("detects Cursor MCP registration from project config", () => {
      mkdirSync(resolve(".cursor"), { recursive: true });
      writeFileSync(
        resolve(".cursor", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            "context-mode": {
              command: "context-mode",
            },
          },
        }, null, 2),
      );

      const result = adapter.checkPluginRegistration();
      expect(result.status).toBe("pass");
      expect(result.message).toContain(join(".cursor", "mcp.json"));
    });
  });

  describe("stop hook", () => {
    it("capabilities includes stop", () => {
      expect(typeof adapter.parseStopInput).toBe("function");
    });

    it("parseStopInput extracts conversation_id as sessionId", () => {
      const event = adapter.parseStopInput({
        conversation_id: "conv-789",
        status: "completed",
        loop_count: 0,
      });
      expect(event.sessionId).toBe("conv-789");
      expect(event.status).toBe("completed");
      expect(event.loopCount).toBe(0);
    });

    it("parseStopInput extracts transcript_path", () => {
      const event = adapter.parseStopInput({
        conversation_id: "conv-1",
        status: "completed",
        loop_count: 3,
        transcript_path: "/tmp/transcript.json",
      });
      expect(event.transcriptPath).toBe("/tmp/transcript.json");
    });

    it("formatStopResponse with followup returns followup_message", () => {
      const resp = adapter.formatStopResponse({ followupMessage: "continue working" });
      expect(resp).toEqual({ followup_message: "continue working" });
    });

    it("formatStopResponse without followup returns empty object", () => {
      const resp = adapter.formatStopResponse({});
      expect(resp).toEqual({});
    });
  });

  describe("afterAgentResponse hook", () => {
    it("parseAfterAgentResponseInput extracts text", () => {
      const event = adapter.parseAfterAgentResponseInput({ text: "Here is the code..." });
      expect(event.text).toBe("Here is the code...");
    });
  });

  describe("generateHookConfig includes stop", () => {
    it("generates hooks with stop entry", () => {
      const config = adapter.generateHookConfig("/path/to/plugin");
      expect(config).toHaveProperty("stop");
    });
  });
});
