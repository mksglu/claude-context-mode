import "../setup-home";
import { fakeHome } from "../setup-home";
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

// Adapters that honor XDG_CONFIG_HOME / APPDATA (e.g. opencode) read the env
// var BEFORE falling back to homedir(). GitHub Actions Ubuntu can have these
// set to the runner's real home and bypass the homedir mock — anchor them
// under fakeHome so adapters stay sandboxed regardless of host env.
process.env.XDG_CONFIG_HOME = join(fakeHome, ".config");
process.env.XDG_DATA_HOME = join(fakeHome, ".local", "share");
process.env.APPDATA = join(fakeHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(fakeHome, "AppData", "Local");

import { QwenCodeAdapter } from "../../src/adapters/qwen-code/index.js";
import { GeminiCLIAdapter } from "../../src/adapters/gemini-cli/index.js";
import { CodexAdapter } from "../../src/adapters/codex/index.js";
import { OpenCodeAdapter } from "../../src/adapters/opencode/index.js";
import { CursorAdapter } from "../../src/adapters/cursor/index.js";
import { VSCodeCopilotAdapter } from "../../src/adapters/vscode-copilot/index.js";
import { JetBrainsCopilotAdapter } from "../../src/adapters/jetbrains-copilot/index.js";
import { KiroAdapter } from "../../src/adapters/kiro/index.js";
import { ZedAdapter } from "../../src/adapters/zed/index.js";
import { AntigravityAdapter } from "../../src/adapters/antigravity/index.js";
import { OpenClawAdapter } from "../../src/adapters/openclaw/index.js";

/**
 * Slice 3 — per-adapter memory/config conventions.
 *
 * Each adapter declares its own configDir, instructionFiles, memoryDir.
 * These are consumed by:
 *   - searchAutoMemory()  (auto-memory file scan)
 *   - ctx_search timeline (configDir for prior session lookup)
 *   - extract.ts isRule  (instruction file detection)
 */

describe("Adapter memory conventions", () => {
  describe("QwenCodeAdapter", () => {
    const a = new QwenCodeAdapter();
    it("getConfigDir is ~/.qwen", () => {
      expect(a.getConfigDir()).toBe(join(homedir(), ".qwen"));
    });
    it("getInstructionFiles is ['QWEN.md']", () => {
      expect(a.getInstructionFiles()).toEqual(["QWEN.md"]);
    });
    it("getMemoryDir is ~/.qwen/memory", () => {
      expect(a.getMemoryDir()).toBe(join(homedir(), ".qwen", "memory"));
    });
  });

  describe("GeminiCLIAdapter", () => {
    const a = new GeminiCLIAdapter();
    it("getConfigDir is ~/.gemini", () => {
      expect(a.getConfigDir()).toBe(join(homedir(), ".gemini"));
    });
    it("getInstructionFiles is ['GEMINI.md']", () => {
      expect(a.getInstructionFiles()).toEqual(["GEMINI.md"]);
    });
    it("getMemoryDir is ~/.gemini/memory", () => {
      expect(a.getMemoryDir()).toBe(join(homedir(), ".gemini", "memory"));
    });
  });

  describe("CodexAdapter", () => {
    const a = new CodexAdapter();
    it("getConfigDir is ~/.codex", () => {
      expect(a.getConfigDir()).toBe(join(homedir(), ".codex"));
    });
    it("getInstructionFiles is ['AGENTS.md', 'AGENTS.override.md']", () => {
      expect(a.getInstructionFiles()).toEqual(["AGENTS.md", "AGENTS.override.md"]);
    });
    it("getMemoryDir is ~/.codex/memories (plural)", () => {
      expect(a.getMemoryDir()).toBe(join(homedir(), ".codex", "memories"));
    });
  });

  // OpenCode/KiloCode honor XDG_CONFIG_HOME on POSIX and APPDATA on Windows.
  // setup-home anchors both env vars under fakeHome, so the expected root
  // depends on platform.
  const xdgRoot =
    process.platform === "win32"
      ? join(homedir(), "AppData", "Roaming")
      : join(homedir(), ".config");

  describe("OpenCodeAdapter (default platform=opencode)", () => {
    const a = new OpenCodeAdapter();
    it("getConfigDir is <xdg>/opencode", () => {
      expect(a.getConfigDir()).toBe(join(xdgRoot, "opencode"));
    });
    it("getInstructionFiles is ['AGENTS.md']", () => {
      expect(a.getInstructionFiles()).toEqual(["AGENTS.md"]);
    });
    it("getMemoryDir is <xdg>/opencode/memory", () => {
      expect(a.getMemoryDir()).toBe(join(xdgRoot, "opencode", "memory"));
    });
  });

  describe("OpenCodeAdapter (kilo variant)", () => {
    const a = new OpenCodeAdapter("kilo");
    it("getConfigDir is <xdg>/kilo", () => {
      expect(a.getConfigDir()).toBe(join(xdgRoot, "kilo"));
    });
    it("getInstructionFiles is ['AGENTS.md']", () => {
      expect(a.getInstructionFiles()).toEqual(["AGENTS.md"]);
    });
    it("getMemoryDir is <xdg>/kilo/memory", () => {
      expect(a.getMemoryDir()).toBe(join(xdgRoot, "kilo", "memory"));
    });
  });

  describe("CursorAdapter", () => {
    const a = new CursorAdapter();
    it("getConfigDir is .cursor (project-relative)", () => {
      expect(a.getConfigDir()).toBe(".cursor");
    });
    it("getInstructionFiles is ['context-mode.mdc']", () => {
      expect(a.getInstructionFiles()).toEqual(["context-mode.mdc"]);
    });
    it("getMemoryDir is .cursor/memory (project-relative)", () => {
      expect(a.getMemoryDir()).toBe(join(".cursor", "memory"));
    });
  });

  describe("VSCodeCopilotAdapter", () => {
    const a = new VSCodeCopilotAdapter();
    it("getConfigDir is .github (project-relative)", () => {
      expect(a.getConfigDir()).toBe(".github");
    });
    it("getInstructionFiles is ['copilot-instructions.md']", () => {
      expect(a.getInstructionFiles()).toEqual(["copilot-instructions.md"]);
    });
    it("getMemoryDir is .github/memory", () => {
      expect(a.getMemoryDir()).toBe(join(".github", "memory"));
    });
  });

  describe("JetBrainsCopilotAdapter", () => {
    const a = new JetBrainsCopilotAdapter();
    it("getConfigDir is .github (project-relative)", () => {
      expect(a.getConfigDir()).toBe(".github");
    });
    it("getInstructionFiles is ['copilot-instructions.md']", () => {
      expect(a.getInstructionFiles()).toEqual(["copilot-instructions.md"]);
    });
    it("getMemoryDir is .github/memory", () => {
      expect(a.getMemoryDir()).toBe(join(".github", "memory"));
    });
  });

  describe("KiroAdapter", () => {
    const a = new KiroAdapter();
    it("getConfigDir is .kiro (project-relative)", () => {
      expect(a.getConfigDir()).toBe(".kiro");
    });
    it("getInstructionFiles is ['KIRO.md']", () => {
      expect(a.getInstructionFiles()).toEqual(["KIRO.md"]);
    });
    it("getMemoryDir is .kiro/memory", () => {
      expect(a.getMemoryDir()).toBe(join(".kiro", "memory"));
    });
  });

  describe("ZedAdapter", () => {
    const a = new ZedAdapter();
    it("getConfigDir is ~/.config/zed", () => {
      expect(a.getConfigDir()).toBe(join(homedir(), ".config", "zed"));
    });
    it("getInstructionFiles is ['AGENTS.md']", () => {
      expect(a.getInstructionFiles()).toEqual(["AGENTS.md"]);
    });
    it("getMemoryDir is ~/.config/zed/memory", () => {
      expect(a.getMemoryDir()).toBe(join(homedir(), ".config", "zed", "memory"));
    });
  });

  describe("AntigravityAdapter", () => {
    const a = new AntigravityAdapter();
    it("getConfigDir is ~/.gemini/antigravity", () => {
      expect(a.getConfigDir()).toBe(join(homedir(), ".gemini", "antigravity"));
    });
    it("getInstructionFiles is ['GEMINI.md']", () => {
      expect(a.getInstructionFiles()).toEqual(["GEMINI.md"]);
    });
    it("getMemoryDir is ~/.gemini/antigravity/memory", () => {
      expect(a.getMemoryDir()).toBe(
        join(homedir(), ".gemini", "antigravity", "memory"),
      );
    });
  });

  describe("OpenClawAdapter", () => {
    const a = new OpenClawAdapter();
    it("getConfigDir is empty string (project-rooted)", () => {
      expect(a.getConfigDir()).toBe("");
    });
    it("getInstructionFiles is ['AGENTS.md']", () => {
      expect(a.getInstructionFiles()).toEqual(["AGENTS.md"]);
    });
    it("getMemoryDir is 'memory' (project-relative)", () => {
      expect(a.getMemoryDir()).toBe("memory");
    });
  });
});
