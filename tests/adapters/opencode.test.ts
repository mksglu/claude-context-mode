import "../setup-home";
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("OpenCodeAdapter", () => {
  describe("OpenCode platform (default)", () => {
    let adapter: OpenCodeAdapter;

    beforeEach(() => {
      adapter = new OpenCodeAdapter();
    });

  // ── Capabilities ──────────────────────────────────────

  describe("capabilities", () => {
    it("sessionStart is false", () => {
      expect(adapter.capabilities.sessionStart).toBe(false);
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

    it("session dir is under platform-specific config directory", () => {
      const sessionDir = adapter.getSessionDir();
      let expectedDir: string;
      if (process.platform === "win32") {
        const configDir = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
        expectedDir = join(configDir, "opencode", "context-mode", "sessions");
      } else {
        const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
        expectedDir = join(configDir, "opencode", "context-mode", "sessions");
      }
      expect(sessionDir).toBe(expectedDir);
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

    it("readSettings prioritizes config with context-mode plugin", () => {
      const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
      const dir = join(root, "project");
      const home = join(root, "home");
      const conf = join(home, ".config", "opencode");
      const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
      const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
      mkdirSync(dir, { recursive: true });
      mkdirSync(conf, { recursive: true });
      writeFileSync(join(conf, "opencode.json"), JSON.stringify({ plugin: ["other-plugin"] }, null, 2) + "\n");
      writeFileSync(resolve(dir, "opencode.json"), JSON.stringify({ plugin: ["context-mode"] }, null, 2) + "\n");
      const run = spawnSync(
        process.execPath,
        [
          tsx,
          "-e",
          `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();a.readSettings();console.log(JSON.stringify({path:a.settingsPath}))`,
        ],
        {
          cwd: dir,
          env: env(home),
          encoding: "utf-8",
        },
      );

      expect(run.status).toBe(0);
      const resultPath = JSON.parse(run.stdout).path;
      expect(resultPath).toContain(join("project", "opencode.json"));

      rmSync(root, { recursive: true, force: true });
    });

    it("readSettings falls back to global config when no plugin found", () => {
      const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
      const dir = join(root, "project");
      const home = join(root, "home");
      const conf = join(home, ".config", "opencode");
      const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
      const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
      mkdirSync(dir, { recursive: true });
      mkdirSync(conf, { recursive: true });
      writeFileSync(join(conf, "opencode.json"), JSON.stringify({ plugin: ["other-plugin"] }, null, 2) + "\n");
      writeFileSync(resolve(dir, "opencode.json"), JSON.stringify({ plugin: [] }, null, 2) + "\n");
      const run = spawnSync(
        process.execPath,
        [
          tsx,
          "-e",
          `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();a.readSettings();console.log(JSON.stringify({path:a.settingsPath}))`,
        ],
        {
          cwd: dir,
          env: env(home),
          encoding: "utf-8",
        },
      );

      expect(run.status).toBe(0);
      const resultPath = JSON.parse(run.stdout).path;
      expect(resultPath).toContain(join(home, ".config", "opencode", "opencode.json"));

      rmSync(root, { recursive: true, force: true });
    });

    it("readSettings reads opencode.jsonc with comments stripped", () => {
      const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
      const dir = join(root, "project");
      const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
      const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "opencode.jsonc"),
        `{
  // This is a line comment
  "plugin": ["context-mode"],
  /* Block comment */
  "version": "1.0"
}
`,
      );
      const run = spawnSync(
        process.execPath,
        [
          tsx,
          "-e",
          `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.readSettings()))`,
        ],
        { cwd: dir, env: env(join(root, "home")), encoding: "utf-8" },
      );
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ plugin: ["context-mode"], version: "1.0" });
      rmSync(root, { recursive: true, force: true });
    });

    it("prefers opencode.json over opencode.jsonc when both exist", () => {
      const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
      const dir = join(root, "project");
      const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
      const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "opencode.json"), JSON.stringify({ from: "json" }));
      writeFileSync(join(dir, "opencode.jsonc"), `{ /* comment */ "from": "jsonc" }`);
      const run = spawnSync(
        process.execPath,
        [
          tsx,
          "-e",
          `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.readSettings()))`,
        ],
        { cwd: dir, env: env(join(root, "home")), encoding: "utf-8" },
      );
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ from: "json" });
      rmSync(root, { recursive: true, force: true });
    });

    it("configureAllHooks works with opencode.jsonc", () => {
      const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
      const dir = join(root, "project");
      const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
      const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "opencode.jsonc"),
        `{
  // My config
  "plugin": []
}
`,
      );
      const run = spawnSync(
        process.execPath,
        [
          tsx,
          "-e",
          `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.configureAllHooks('/tmp/plugin')))`,
        ],
        { cwd: dir, env: env(join(root, "home")), encoding: "utf-8" },
      );
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual(["Added context-mode to plugin array"]);
      // Should write back to .jsonc (same file it read)
      expect(JSON.parse(readFileSync(join(dir, "opencode.jsonc"), "utf-8"))).toEqual({
        plugin: ["context-mode"],
      });
      rmSync(root, { recursive: true, force: true });
    });

    it("validates hooks with jsonc config shows correct error message", () => {
      const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
      const dir = join(root, "project");
      const src = resolve(process.cwd(), "src", "adapters", "opencode", "index.ts");
      const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
      mkdirSync(dir, { recursive: true });
      // No config file at all
      const run = spawnSync(
        process.execPath,
        [
          tsx,
          "-e",
          `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.validateHooks('/tmp')))`,
        ],
        { cwd: dir, env: env(join(root, "home")), encoding: "utf-8" },
      );
      expect(run.status).toBe(0);
      const results = JSON.parse(run.stdout);
      const pluginCheck = results.find((r: { check: string }) => r.check === "Plugin configuration");
      expect(pluginCheck.message).toContain("jsonc");
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
      expect(adapter.capabilities.sessionStart).toBe(false);
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

    it("session dir is under platform-specific config directory", () => {
      const sessionDir = adapter.getSessionDir();
      let expectedDir: string;
      if (process.platform === "win32") {
        const configDir = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
        expectedDir = join(configDir, "kilo", "context-mode", "sessions");
      } else {
        const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
        expectedDir = join(configDir, "kilo", "context-mode", "sessions");
      }
      expect(sessionDir).toBe(expectedDir);
    });
  });
});
