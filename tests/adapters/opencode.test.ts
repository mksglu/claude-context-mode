import "../setup-home";
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { OpenCodeAdapter } from "../../src/adapters/opencode/index.js";

function env(home: string) {
  const root = parse(home).root;
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: root.replace(/[\\/]+$/, ""),
    HOMEPATH: home.slice(root.length) || root,
  };
}

function createOpenCodePluginRoot(base: string): string {
  const pluginRoot = join(base, "plugin-root");
  const configDir = join(pluginRoot, "configs", "opencode");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "AGENTS.md"),
    "# Context Mode\n\nUse context-mode MCP tools.\n",
  );
  return pluginRoot;
}

describe("OpenCodeAdapter", () => {
  describe("OpenCode platform (default)", () => {
    let adapter: OpenCodeAdapter;

    beforeEach(() => {
      adapter = new OpenCodeAdapter();
    });

    // ── Capabilities ──────────────────────────────────────

    describe("capabilities", () => {
      it("sessionStart is true", () => {
        expect(adapter.capabilities.sessionStart).toBe(true);
      });

      it("canInjectSessionContext is false", () => {
        expect(adapter.capabilities.canInjectSessionContext).toBe(false);
      });

      it("preToolUse and postToolUse are true", () => {
        expect(adapter.capabilities.preToolUse).toBe(true);
        expect(adapter.capabilities.postToolUse).toBe(true);
      });

      it("paradigm is ts-plugin", () => {
        expect(adapter.paradigm).toBe("ts-plugin");
      });
    });

    // ── parsePreToolUseInput ──────────────────────────────

    describe("parsePreToolUseInput", () => {
      it("extracts sessionId from sessionID (camelCase)", () => {
        const event = adapter.parsePreToolUseInput({
          tool: "shell",
          sessionID: "oc-session-123",
        });
        expect(event.sessionId).toBe("oc-session-123");
      });

      it("projectDir falls back to cwd when no OPENCODE_PROJECT_DIR", () => {
        const event = adapter.parsePreToolUseInput({
          tool: "shell",
        });
        expect(event.projectDir).toBe(process.cwd());
      });

      it("extracts toolName from tool", () => {
        const event = adapter.parsePreToolUseInput({
          tool: "read_file",
          args: { path: "/some/file" },
        });
        expect(event.toolName).toBe("read_file");
      });

      it("falls back to pid when no sessionID", () => {
        const event = adapter.parsePreToolUseInput({
          tool: "shell",
        });
        expect(event.sessionId).toBe(`pid-${process.ppid}`);
      });
    });

    // ── formatPreToolUseResponse ──────────────────────────

    describe("formatPreToolUseResponse", () => {
      it("throws Error for deny decision", () => {
        expect(() =>
          adapter.formatPreToolUseResponse({
            decision: "deny",
            reason: "Blocked",
          }),
        ).toThrow("Blocked");
      });

      it("throws Error with default message when no reason for deny", () => {
        expect(() =>
          adapter.formatPreToolUseResponse({
            decision: "deny",
          }),
        ).toThrow("Blocked by context-mode hook");
      });

      it("returns args object for modify", () => {
        const updatedInput = { command: "echo hi" };
        const result = adapter.formatPreToolUseResponse({
          decision: "modify",
          updatedInput,
        });
        expect(result).toEqual({ args: updatedInput });
      });

      it("returns undefined for allow", () => {
        const result = adapter.formatPreToolUseResponse({
          decision: "allow",
        });
        expect(result).toBeUndefined();
      });
    });

    // ── formatPostToolUseResponse ─────────────────────────

    describe("formatPostToolUseResponse", () => {
      it("formats updatedOutput as output field", () => {
        const result = adapter.formatPostToolUseResponse({
          updatedOutput: "New output",
        });
        expect(result).toEqual({ output: "New output" });
      });

      it("formats additionalContext", () => {
        const result = adapter.formatPostToolUseResponse({
          additionalContext: "Extra info",
        });
        expect(result).toEqual({ additionalContext: "Extra info" });
      });

      it("returns undefined for empty response", () => {
        const result = adapter.formatPostToolUseResponse({});
        expect(result).toBeUndefined();
      });
    });

    // ── parseSessionStartInput ────────────────────────────

    describe("parseSessionStartInput", () => {
      it("parses startup source by default", () => {
        const event = adapter.parseSessionStartInput({});
        expect(event.source).toBe("startup");
        expect(event.projectDir).toBe(process.cwd());
      });

      it("parses compact source", () => {
        const event = adapter.parseSessionStartInput({ source: "compact" });
        expect(event.source).toBe("compact");
      });

      it("parses resume source", () => {
        const event = adapter.parseSessionStartInput({ source: "resume" });
        expect(event.source).toBe("resume");
      });

      it("parses clear source", () => {
        const event = adapter.parseSessionStartInput({ source: "clear" });
        expect(event.source).toBe("clear");
      });

      it("extracts sessionId from sessionID", () => {
        const event = adapter.parseSessionStartInput({ sessionID: "oc-123" });
        expect(event.sessionId).toBe("oc-123");
      });
    });

    // ── Config paths ──────────────────────────────────────

    describe("config paths", () => {
      it("settings path is opencode.json (relative)", () => {
        expect(adapter.getSettingsPath()).toBe(resolve("opencode.json"));
      });

      it("session dir is under ~/.config/opencode/context-mode/sessions/", () => {
        const sessionDir = adapter.getSessionDir();
        expect(sessionDir).toBe(
          join(homedir(), ".config", "opencode", "context-mode", "sessions"),
        );
      });

      it("configureAllHooks writes back to the global config it read", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const dir = join(root, "project");
        const home = join(root, "home");
        const conf = join(home, ".config", "opencode");
        const file = join(conf, "opencode.json");
        const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        mkdirSync(dir, { recursive: true });
        mkdirSync(conf, { recursive: true });
        writeFileSync(file, JSON.stringify({ plugin: [] }, null, 2) + "\n");
        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify({backup:a.backupSettings(),changes:a.configureAllHooks('/tmp/plugin')}))`,
          ],
          {
            cwd: dir,
            env: env(home),
            encoding: "utf-8",
          },
        );

        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual({
          backup: file + ".bak",
          changes: ["Added context-mode to plugin array"],
        });
        expect(() => readFileSync(resolve(dir, "opencode.json"), "utf-8")).toThrow();
        expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ plugin: ["context-mode"] });

        rmSync(root, { recursive: true, force: true });
      });

      it("configureAllHooks keeps project config precedence", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const dir = join(root, "project");
        const home = join(root, "home");
        const conf = join(home, ".config", "opencode");
        const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        mkdirSync(dir, { recursive: true });
        mkdirSync(conf, { recursive: true });
        writeFileSync(join(conf, "opencode.json"), JSON.stringify({ plugin: [] }, null, 2) + "\n");
        writeFileSync(resolve(dir, "opencode.json"), JSON.stringify({ plugin: [] }, null, 2) + "\n");
        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.configureAllHooks('/tmp/plugin')))`,
          ],
          {
            cwd: dir,
            env: env(home),
            encoding: "utf-8",
          },
        );

        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual(["Added context-mode to plugin array"]);
        expect(JSON.parse(readFileSync(resolve(dir, "opencode.json"), "utf-8"))).toEqual({
          plugin: ["context-mode"],
        });
        expect(JSON.parse(readFileSync(join(conf, "opencode.json"), "utf-8"))).toEqual({
          plugin: [],
        });

        rmSync(root, { recursive: true, force: true });
      });

      it("configureAllHooks writes back to .opencode/opencode.json when that is the selected config", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const dir = join(root, "project");
        const home = join(root, "home");
        const conf = join(dir, ".opencode");
        const file = join(conf, "opencode.json");
        const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        mkdirSync(dir, { recursive: true });
        mkdirSync(conf, { recursive: true });
        writeFileSync(file, JSON.stringify({ plugin: [] }, null, 2) + "\n");
        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.configureAllHooks('/tmp/plugin')))`,
          ],
          {
            cwd: dir,
            env: env(home),
            encoding: "utf-8",
          },
        );

        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual(["Added context-mode to plugin array"]);
        expect(() => readFileSync(resolve(dir, "opencode.json"), "utf-8")).toThrow();
        expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ plugin: ["context-mode"] });

        rmSync(root, { recursive: true, force: true });
      });
    });

    describe("writeRoutingInstructions — global injection", () => {
      it("writes to global path when OPENCODE_INJECT_GLOBAL=true", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const projectDir = join(root, "project");
        const home = join(root, "home");
        const pluginRoot = createOpenCodePluginRoot(root);
        const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

        mkdirSync(projectDir, { recursive: true });
        mkdirSync(join(home, ".config", "opencode"), { recursive: true });

        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.writeRoutingInstructions(${JSON.stringify(projectDir)}, ${JSON.stringify(pluginRoot)})));`,
          ],
          {
            cwd: projectDir,
            env: { ...env(home), OPENCODE_INJECT_GLOBAL: "true" },
            encoding: "utf-8",
          },
        );

        expect(run.status).toBe(0);
        const result = JSON.parse(run.stdout);
        expect(result).toContain(join(".config", "opencode", "AGENTS.md"));
        expect(readFileSync(join(home, ".config", "opencode", "AGENTS.md"), "utf-8")).toContain("context-mode");
        expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(false);

        rmSync(root, { recursive: true, force: true });
      });

      it("writes to project path when OPENCODE_INJECT_GLOBAL is not set", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const projectDir = join(root, "project");
        const home = join(root, "home");
        const pluginRoot = createOpenCodePluginRoot(root);
        const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

        mkdirSync(projectDir, { recursive: true });
        mkdirSync(home, { recursive: true });

        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.writeRoutingInstructions(${JSON.stringify(projectDir)}, ${JSON.stringify(pluginRoot)})));`,
          ],
          {
            cwd: projectDir,
            env: { ...env(home), OPENCODE_INJECT_GLOBAL: undefined },
            encoding: "utf-8",
          },
        );

        expect(run.status).toBe(0);
        const result = JSON.parse(run.stdout);
        expect(result).toBe(join(projectDir, "AGENTS.md"));
        expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(true);

        rmSync(root, { recursive: true, force: true });
      });

      it("creates parent directory for global path when it does not exist", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const projectDir = join(root, "project");
        const home = join(root, "home");
        const pluginRoot = createOpenCodePluginRoot(root);
        const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

        mkdirSync(projectDir, { recursive: true });
        mkdirSync(home, { recursive: true });

        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.writeRoutingInstructions(${JSON.stringify(projectDir)}, ${JSON.stringify(pluginRoot)})));`,
          ],
          {
            cwd: projectDir,
            env: { ...env(home), OPENCODE_INJECT_GLOBAL: "true" },
            encoding: "utf-8",
          },
        );

        expect(run.status).toBe(0);
        expect(existsSync(join(home, ".config", "opencode", "AGENTS.md"))).toBe(true);

        rmSync(root, { recursive: true, force: true });
      });

      it("appends to existing global file without context-mode content", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const projectDir = join(root, "project");
        const home = join(root, "home");
        const pluginRoot = createOpenCodePluginRoot(root);
        const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

        mkdirSync(projectDir, { recursive: true });
        const confDir = join(home, ".config", "opencode");
        mkdirSync(confDir, { recursive: true });
        writeFileSync(join(confDir, "AGENTS.md"), "# My Rules\n\nDo not use tabs.\n");

        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.writeRoutingInstructions(${JSON.stringify(projectDir)}, ${JSON.stringify(pluginRoot)})));`,
          ],
          {
            cwd: projectDir,
            env: { ...env(home), OPENCODE_INJECT_GLOBAL: "true" },
            encoding: "utf-8",
          },
        );

        expect(run.status).toBe(0);
        const content = readFileSync(join(confDir, "AGENTS.md"), "utf-8");
        expect(content).toContain("My Rules");
        expect(content).toContain("context-mode");

        rmSync(root, { recursive: true, force: true });
      });

      it("skips when global file already contains context-mode (idempotent)", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const projectDir = join(root, "project");
        const home = join(root, "home");
        const pluginRoot = createOpenCodePluginRoot(root);
        const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

        mkdirSync(projectDir, { recursive: true });
        const confDir = join(home, ".config", "opencode");
        mkdirSync(confDir, { recursive: true });
        writeFileSync(join(confDir, "AGENTS.md"), "# context-mode\n\nAlready installed.\n");

        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.writeRoutingInstructions(${JSON.stringify(projectDir)}, ${JSON.stringify(pluginRoot)})));`,
          ],
          {
            cwd: projectDir,
            env: { ...env(home), OPENCODE_INJECT_GLOBAL: "true" },
            encoding: "utf-8",
          },
        );

        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout)).toBeNull();

        rmSync(root, { recursive: true, force: true });
      });

      it("writes to project path when OPENCODE_INJECT_GLOBAL=false", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const projectDir = join(root, "project");
        const home = join(root, "home");
        const pluginRoot = createOpenCodePluginRoot(root);
        const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

        mkdirSync(projectDir, { recursive: true });
        mkdirSync(home, { recursive: true });

        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.writeRoutingInstructions(${JSON.stringify(projectDir)}, ${JSON.stringify(pluginRoot)})));`,
          ],
          {
            cwd: projectDir,
            env: { ...env(home), OPENCODE_INJECT_GLOBAL: "false" },
            encoding: "utf-8",
          },
        );

        expect(run.status).toBe(0);
        const result = JSON.parse(run.stdout);
        expect(result).toContain(projectDir);
        expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(true);

        rmSync(root, { recursive: true, force: true });
      });

      it("returns null when source config is missing (global mode)", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const projectDir = join(root, "project");
        const home = join(root, "home");
        const emptyPluginRoot = join(root, "empty-plugin");
        const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

        mkdirSync(projectDir, { recursive: true });
        mkdirSync(emptyPluginRoot, { recursive: true });
        mkdirSync(home, { recursive: true });

        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.writeRoutingInstructions(${JSON.stringify(projectDir)}, ${JSON.stringify(emptyPluginRoot)})));`,
          ],
          {
            cwd: projectDir,
            env: { ...env(home), OPENCODE_INJECT_GLOBAL: "true" },
            encoding: "utf-8",
          },
        );

        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout)).toBeNull();

        rmSync(root, { recursive: true, force: true });
      });

      it("reads OPENCODE_INJECT_GLOBAL from opencode.json mcp config", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const projectDir = join(root, "project");
        const home = join(root, "home");
        const pluginRoot = createOpenCodePluginRoot(root);
        const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

        mkdirSync(projectDir, { recursive: true });
        mkdirSync(join(home, ".config", "opencode"), { recursive: true });

        // Write opencode.json with the env flag in MCP config — no shell env var set
        writeFileSync(
          join(projectDir, "opencode.json"),
          JSON.stringify({
            mcp: {
              "context-mode": {
                type: "local",
                command: ["context-mode"],
                environment: { OPENCODE_INJECT_GLOBAL: "true" },
              },
            },
          }),
        );

        // Run WITHOUT OPENCODE_INJECT_GLOBAL in process env
        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.writeRoutingInstructions(${JSON.stringify(projectDir)}, ${JSON.stringify(pluginRoot)})));`,
          ],
          {
            cwd: projectDir,  // opencode.json is resolved relative to cwd
            env: { ...env(home), OPENCODE_INJECT_GLOBAL: undefined },   // NO OPENCODE_INJECT_GLOBAL env var
            encoding: "utf-8",
          },
        );

        expect(run.status).toBe(0);
        const result = JSON.parse(run.stdout);
        // Should write to global path because the config was read from opencode.json
        expect(result).toContain(join(".config", "opencode", "AGENTS.md"));
        expect(existsSync(join(home, ".config", "opencode", "AGENTS.md"))).toBe(true);
        expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(false);

        rmSync(root, { recursive: true, force: true });
      });
    });
  });
});

describe("OpenCodeAdapter for KiloCode", () => {
  let adapter: OpenCodeAdapter;

  beforeEach(() => {
    adapter = new OpenCodeAdapter("kilo");
  });

  describe("constructor and name", () => {
    it("accepts kilo platform parameter", () => {
      expect(adapter).toBeInstanceOf(OpenCodeAdapter);
    });

    it("returns KiloCode as name when platform is kilo", () => {
      expect(adapter.name).toBe("KiloCode");
    });
  });

  describe("capabilities", () => {
    it("has same capabilities as OpenCode", () => {
      expect(adapter.capabilities.sessionStart).toBe(true);
      expect(adapter.capabilities.canInjectSessionContext).toBe(false);
      expect(adapter.capabilities.preToolUse).toBe(true);
      expect(adapter.capabilities.postToolUse).toBe(true);
      expect(adapter.paradigm).toBe("ts-plugin");
    });
  });

  describe("config paths", () => {
    it("settings path is kilo.json (relative)", () => {
      expect(adapter.getSettingsPath()).toBe(resolve("kilo.json"));
    });

    it("session dir is under ~/.config/kilo/context-mode/sessions/", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toBe(
        join(homedir(), ".config", "kilo", "context-mode", "sessions"),
      );
    });
  });
});
