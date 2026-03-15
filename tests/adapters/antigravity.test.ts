import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { AntigravityAdapter } from "../../src/adapters/antigravity/index.js";

describe("AntigravityAdapter", () => {
  let tempRoot: string;
  let tempHome: string;
  let tempProject: string;
  let pluginRoot: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ctx-antigravity-"));
    tempHome = join(tempRoot, "home");
    tempProject = join(tempRoot, "project");
    pluginRoot = join(tempRoot, "plugin");
    savedEnv = { ...process.env };

    mkdirSync(tempProject, { recursive: true });
    mkdirSync(join(pluginRoot, "configs", "antigravity"), { recursive: true });

    writeFileSync(
      join(pluginRoot, "configs", "antigravity", "context-mode.md"),
      "# context-mode workflow\n\nUse context-mode MCP tools.\n",
      "utf-8",
    );
    writeFileSync(
      join(pluginRoot, "configs", "antigravity", "GEMINI.md"),
      "# context-mode — MANDATORY routing rules\n\nUse context-mode MCP tools.\n",
      "utf-8",
    );

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    vi.spyOn(process, "cwd").mockReturnValue(tempProject);
  });

  afterEach(() => {
    process.env = savedEnv;
    vi.restoreAllMocks();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("configureAllHooks writes Antigravity MCP config and workflow", () => {
    const adapter = new AntigravityAdapter();
    const changes = adapter.configureAllHooks(pluginRoot);

    const settingsPath = resolve(tempHome, ".gemini", "antigravity", "mcp_config.json");
    const workflowPath = resolve(tempProject, ".agent", "workflows", "context-mode.md");

    expect(existsSync(settingsPath)).toBe(true);
    expect(existsSync(workflowPath)).toBe(true);
    expect(changes.some((item) => item.includes("mcp_config.json"))).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      mcpServers?: Record<string, { command?: string }>;
    };
    expect(settings.mcpServers?.["context-mode"]?.command).toBe("context-mode");

    const workflow = readFileSync(workflowPath, "utf-8");
    expect(workflow).toContain("context-mode workflow");
  });

  it("merges into an existing empty mcp_config.json file", () => {
    const adapter = new AntigravityAdapter();
    const settingsPath = resolve(tempHome, ".gemini", "antigravity", "mcp_config.json");

    mkdirSync(resolve(tempHome, ".gemini", "antigravity"), { recursive: true });
    writeFileSync(settingsPath, "", "utf-8");

    adapter.configureAllHooks(pluginRoot);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      mcpServers?: Record<string, { command?: string }>;
    };
    expect(settings.mcpServers?.["context-mode"]?.command).toBe("context-mode");
  });

  it("uses GEMINI.md routing instructions for Antigravity projects", () => {
    const adapter = new AntigravityAdapter();
    const written = adapter.writeRoutingInstructions(tempProject, pluginRoot);
    const targetPath = resolve(tempProject, "GEMINI.md");

    expect(written).toBe(targetPath);
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toContain("context-mode");
  });
});
