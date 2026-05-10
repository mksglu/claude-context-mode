import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { CursorAdapter } from "../../src/adapters/cursor/index.js";

/**
 * Helpers for the "cursor doctor — plugin install detection" suite.
 * Plugin layout per Cursor convention:
 *   <root>/<plugin-name>/.cursor-plugin/plugin.json
 */
function writePluginManifest(rootDir: string, pluginName: string, manifest: unknown): string {
  const pluginDir = join(rootDir, pluginName, ".cursor-plugin");
  mkdirSync(pluginDir, { recursive: true });
  const manifestPath = join(pluginDir, "plugin.json");
  const body = typeof manifest === "string" ? (manifest as string) : JSON.stringify(manifest, null, 2);
  writeFileSync(manifestPath, body, "utf-8");
  return manifestPath;
}

function pluginRoots(): { local: string; cache: string } {
  return {
    local: join(homedir(), ".cursor", "plugins", "local"),
    cache: join(homedir(), ".cursor", "plugins", "cache"),
  };
}

function clearPluginRoots(): void {
  const { local, cache } = pluginRoots();
  try { rmSync(local, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(cache, { recursive: true, force: true }); } catch { /* best effort */ }
}

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
      // Cursor-1 fix: sessionStart capability must align with the
      // hooks/cursor/sessionstart.mjs script + dispatcher entry that ship
      // with this build.
      expect(adapter.capabilities.sessionStart).toBe(true);
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

    // Cursor-2 fix: registering afterAgentResponse in generateHookConfig +
    // configureAllHooks without a backing script produced a dangling entry —
    // Cursor would invoke `context-mode hook cursor afteragentresponse` and
    // the dispatcher would exit(1). Verify both the dispatcher entry and the
    // script file actually exist on disk.
    it("ships afteragentresponse.mjs script for the registered hook entry", () => {
      const scriptPath = join(
        process.cwd(),
        "hooks",
        "cursor",
        "afteragentresponse.mjs",
      );
      expect(existsSync(scriptPath)).toBe(true);
    });
  });

  describe("capability ↔ script alignment", () => {
    // Cursor-1 RED test: every capability flag set to true MUST have a
    // matching hook script on disk. A capability without a script means the
    // adapter advertises functionality the runtime cannot deliver.
    it("each enabled hook capability has a backing script in hooks/cursor", () => {
      const hooksDir = join(process.cwd(), "hooks", "cursor");
      const capabilityToScript: Record<string, string> = {
        preToolUse: "pretooluse.mjs",
        postToolUse: "posttooluse.mjs",
        sessionStart: "sessionstart.mjs",
      };

      for (const [capability, script] of Object.entries(capabilityToScript)) {
        const enabled = (adapter.capabilities as Record<string, unknown>)[capability];
        if (enabled === true) {
          expect(
            existsSync(join(hooksDir, script)),
            `capability ${capability}=true requires hooks/cursor/${script}`,
          ).toBe(true);
        }
      }
    });
  });

  describe("generateHookConfig includes stop", () => {
    it("generates hooks with stop entry", () => {
      const config = adapter.generateHookConfig("/path/to/plugin");
      expect(config).toHaveProperty("stop");
    });
  });

  // #489 round-3 — pin detectPluginInstalls + plugin-aware checkPluginRegistration.
  // Validates the previously-uncovered path under src/adapters/cursor/index.ts:367-435
  // and resolves the self-contradiction where a plugin-only install could still
  // emit `MCP registration: warn` while `Plugin install: pass`.
  describe("cursor doctor — plugin install detection", () => {
    let projectCursorDirExisted: boolean;

    beforeEach(() => {
      clearPluginRoots();
      projectCursorDirExisted = existsSync(resolve(".cursor"));
    });

    afterEach(() => {
      clearPluginRoots();
      try { rmSync(resolve(".cursor", "mcp.json"), { force: true }); } catch { /* best effort */ }
      if (!projectCursorDirExisted) {
        try { rmSync(resolve(".cursor"), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });

    // Case A — clean machine. No plugin roots → empty array, no throw.
    it("returns [] when no plugin roots exist", () => {
      const detect = (adapter as unknown as { detectPluginInstalls: () => string[] }).detectPluginInstalls.bind(adapter);
      expect(detect()).toEqual([]);
    });

    // Case B — single valid install under `local`.
    it("returns the manifest path for a valid plugin under local root", () => {
      const { local } = pluginRoots();
      const manifestPath = writePluginManifest(local, "context-mode", { name: "context-mode", version: "1.0.0" });

      const detect = (adapter as unknown as { detectPluginInstalls: () => string[] }).detectPluginInstalls.bind(adapter);
      const found = detect();
      expect(found).toEqual([manifestPath]);
    });

    // Case C — both `local` and `cache` populated → 2 paths.
    it("returns paths from both local and cache roots", () => {
      const { local, cache } = pluginRoots();
      const localManifest = writePluginManifest(local, "context-mode", { name: "context-mode" });
      const cacheManifest = writePluginManifest(cache, "context-mode", { name: "context-mode" });

      const detect = (adapter as unknown as { detectPluginInstalls: () => string[] }).detectPluginInstalls.bind(adapter);
      const found = detect();
      expect(found).toHaveLength(2);
      expect(found).toContain(localManifest);
      expect(found).toContain(cacheManifest);
    });

    // Case D — corrupt JSON must not throw; siblings with valid manifests still surface.
    it("ignores corrupt plugin.json without throwing and still returns valid siblings", () => {
      const { local } = pluginRoots();
      writePluginManifest(local, "broken", "{ not valid json");
      const validManifest = writePluginManifest(local, "context-mode", { name: "context-mode" });

      const detect = (adapter as unknown as { detectPluginInstalls: () => string[] }).detectPluginInstalls.bind(adapter);
      let found: string[] = [];
      expect(() => { found = detect(); }).not.toThrow();
      expect(found).toEqual([validManifest]);
    });

    // Case E — native hooks.json + plugin install → duplication warn.
    it("emits Plugin/native hook duplication warn when native hooks coexist with plugin", () => {
      const { local } = pluginRoots();
      writePluginManifest(local, "context-mode", { name: "context-mode" });

      // Native config with a context-mode hook command — drives the duplication branch.
      const nativeDir = join(homedir(), ".cursor");
      mkdirSync(nativeDir, { recursive: true });
      writeFileSync(
        join(nativeDir, "hooks.json"),
        JSON.stringify({
          version: 1,
          hooks: {
            preToolUse: [{ type: "command", command: "context-mode hook cursor pretooluse" }],
          },
        }, null, 2),
        "utf-8",
      );

      const results = adapter.validateHooks(process.cwd());
      const dup = results.find((r) => r.check === "Plugin/native hook duplication");
      expect(dup).toBeDefined();
      expect(dup?.status).toBe("warn");
      expect(dup?.message).toContain("context-mode plugin detected");

      // Cleanup native hooks.json so it doesn't leak into other tests.
      try { rmSync(join(nativeDir, "hooks.json"), { force: true }); } catch { /* best effort */ }
    });

    // Case F — plugin-only install (no native mcp.json) must report MCP registration: pass.
    // Resolves the self-contradicting `Plugin install: pass` + `MCP registration: warn`.
    it("checkPluginRegistration returns pass when plugin is installed even without native mcp.json", () => {
      const { local } = pluginRoots();
      const manifestPath = writePluginManifest(local, "context-mode", { name: "context-mode" });

      // Ensure no native mcp.json files exist anywhere we read from.
      try { rmSync(resolve(".cursor", "mcp.json"), { force: true }); } catch { /* best effort */ }
      try { rmSync(join(homedir(), ".cursor", "mcp.json"), { force: true }); } catch { /* best effort */ }

      const result = adapter.checkPluginRegistration();
      expect(result.status).toBe("pass");
      expect(result.message).toContain(manifestPath);
    });

    // Regression — native mcp.json still wins (hybrid install) and returns the mcp.json path.
    it("checkPluginRegistration still recognises native mcp.json when both are present", () => {
      const { local } = pluginRoots();
      writePluginManifest(local, "context-mode", { name: "context-mode" });

      mkdirSync(resolve(".cursor"), { recursive: true });
      writeFileSync(
        resolve(".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { "context-mode": { command: "context-mode" } } }, null, 2),
        "utf-8",
      );

      const result = adapter.checkPluginRegistration();
      expect(result.status).toBe("pass");
      expect(result.message).toContain(join(".cursor", "mcp.json"));
    });
  });
});
