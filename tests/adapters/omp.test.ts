import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { OMPAdapter } from "../../src/adapters/omp/index.js";
import { hashProjectDirCanonical, resolveSessionDbPath } from "../../src/session/db.js";

describe("OMPAdapter", () => {
  let adapter: OMPAdapter;
  let savedAgentDir: string | undefined;

  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    adapter = new OMPAdapter();
  });

  afterEach(() => {
    if (savedAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    }
  });

  // ── Identity ───────────────────────────────────────────

  describe("identity", () => {
    it("name is OMP", () => {
      expect(adapter.name).toBe("OMP");
    });

    it("paradigm is mcp-only", () => {
      expect(adapter.paradigm).toBe("mcp-only");
    });
  });

  // ── Capabilities ──────────────────────────────────────

  describe("capabilities", () => {
    it("all capabilities are false", () => {
      expect(adapter.capabilities.preToolUse).toBe(false);
      expect(adapter.capabilities.postToolUse).toBe(false);
      expect(adapter.capabilities.preCompact).toBe(false);
      expect(adapter.capabilities.sessionStart).toBe(false);
      expect(adapter.capabilities.canModifyArgs).toBe(false);
      expect(adapter.capabilities.canModifyOutput).toBe(false);
      expect(adapter.capabilities.canInjectSessionContext).toBe(false);
    });
  });

  // ── Parse methods (all throw) ─────────────────────────

  describe("parse methods", () => {
    it("parsePreToolUseInput throws", () => {
      expect(() => adapter.parsePreToolUseInput({})).toThrow(
        /OMP hooks not wired by this adapter/,
      );
    });

    it("parsePostToolUseInput throws", () => {
      expect(() => adapter.parsePostToolUseInput({})).toThrow(
        /OMP hooks not wired by this adapter/,
      );
    });

    it("parsePreCompactInput throws", () => {
      expect(() => adapter.parsePreCompactInput({})).toThrow(
        /OMP hooks not wired by this adapter/,
      );
    });

    it("parseSessionStartInput throws", () => {
      expect(() => adapter.parseSessionStartInput({})).toThrow(
        /OMP hooks not wired by this adapter/,
      );
    });
  });

  // ── Format methods (all return undefined) ─────────────

  describe("format methods", () => {
    it("formatPreToolUseResponse returns undefined", () => {
      expect(
        adapter.formatPreToolUseResponse({ decision: "deny", reason: "test" }),
      ).toBeUndefined();
    });

    it("formatPostToolUseResponse returns undefined", () => {
      expect(
        adapter.formatPostToolUseResponse({ additionalContext: "test" }),
      ).toBeUndefined();
    });

    it("formatPreCompactResponse returns undefined", () => {
      expect(
        adapter.formatPreCompactResponse({ context: "test" }),
      ).toBeUndefined();
    });

    it("formatSessionStartResponse returns undefined", () => {
      expect(
        adapter.formatSessionStartResponse({ context: "test" }),
      ).toBeUndefined();
    });
  });

  // ── Hook config (all empty) ───────────────────────────

  describe("hook config", () => {
    it("generateHookConfig returns empty object", () => {
      expect(adapter.generateHookConfig("/some/plugin/root")).toEqual({});
    });

    it("configureAllHooks returns empty array", () => {
      expect(adapter.configureAllHooks("/some/plugin/root")).toEqual([]);
    });

    it("setHookPermissions returns empty array", () => {
      expect(adapter.setHookPermissions("/some/plugin/root")).toEqual([]);
    });
  });

  // ── Config paths ──────────────────────────────────────
  // The OMP fix for issue #473 — verifies storage roots NEVER bleed into
  // ~/.claude/, regardless of which harness installed context-mode.

  describe("config paths", () => {
    it("session dir is under ~/.omp/context-mode/sessions/", () => {
      expect(adapter.getSessionDir()).toBe(
        join(homedir(), ".omp", "context-mode", "sessions"),
      );
    });

    it("session DB path contains project hash and lives under .omp", () => {
      const dbPath = resolveSessionDbPath({ projectDir: "/test/project", sessionsDir: adapter.getSessionDir() });
      expect(dbPath).toMatch(/[a-f0-9]{16}\.db$/);
      expect(dbPath).toContain(".omp");
      expect(dbPath).not.toContain(".claude");
    });

    it("session events path contains project hash and lives under .omp", () => {
      const eventsPath = join(adapter.getSessionDir(), `${hashProjectDirCanonical("/test/project")}-events.md`);
      expect(eventsPath).toMatch(/[a-f0-9]{16}-events\.md$/);
      expect(eventsPath).toContain(".omp");
      expect(eventsPath).not.toContain(".claude");
    });

    it("default settings path is ~/.omp/agent/mcp.json", () => {
      expect(adapter.getSettingsPath()).toBe(
        resolve(homedir(), ".omp", "agent", "mcp.json"),
      );
    });

    it("default config dir is ~/.omp/agent", () => {
      expect(adapter.getConfigDir()).toBe(
        resolve(homedir(), ".omp", "agent"),
      );
    });

    it("PI_CODING_AGENT_DIR overrides settings path", () => {
      process.env.PI_CODING_AGENT_DIR = "/custom/omp/agent";
      expect(adapter.getSettingsPath()).toBe(
        resolve("/custom/omp/agent", "mcp.json"),
      );
    });

    it("PI_CODING_AGENT_DIR overrides config dir", () => {
      process.env.PI_CODING_AGENT_DIR = "/custom/omp/agent";
      expect(adapter.getConfigDir()).toBe("/custom/omp/agent");
    });
  });

  // ── Instruction file ──────────────────────────────────

  describe("instruction files", () => {
    it("uses SYSTEM.md (OMP-native) plus AGENTS.md (universally discovered)", () => {
      // Verified upstream:
      //   - SYSTEM.md: packages/coding-agent/src/main.ts:394-402
      //   - AGENTS.md: packages/coding-agent/src/discovery/agents-md.ts:25-29
      expect(adapter.getInstructionFiles()).toEqual(["SYSTEM.md", "AGENTS.md"]);
    });
  });
});
