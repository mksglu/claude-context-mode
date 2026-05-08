import "../setup-home";
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PLUGIN_DIR = resolve(__dirname, "../../.hermes-plugin");
const CONFIG_DIR = resolve(__dirname, "../../configs/hermes");
const TEST_SCRIPT = resolve(__dirname, "hermes_test.py");

// Hermes Agent is Linux/macOS only — skip behavioral tests on Windows
const isWindows = process.platform === "win32";

// ── File structure ──────────────────────────────────────

describe("plugin manifest", () => {
  it("plugin.yaml exists", () => {
    expect(existsSync(resolve(PLUGIN_DIR, "plugin.yaml"))).toBe(true);
  });

  it("plugin.yaml is valid YAML and declares name + hooks", () => {
    const content = readFileSync(resolve(PLUGIN_DIR, "plugin.yaml"), "utf-8");
    expect(content).toMatch(/^name:\s*.+/m);
    expect(content).toMatch(/hooks:/);
  });

  it("__init__.py exists with register()", () => {
    const path = resolve(PLUGIN_DIR, "__init__.py");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("def register(ctx):");
  });

  it("README.md exists", () => {
    expect(existsSync(resolve(PLUGIN_DIR, "README.md"))).toBe(true);
  });

  it("AGENTS.md exists in configs/hermes/", () => {
    expect(existsSync(resolve(CONFIG_DIR, "AGENTS.md"))).toBe(true);
  });
});

// ── Hook behavioral tests (via pytest) ──────────────────

const describeBehavior = isWindows ? describe.skip : describe;

describeBehavior("hook behavior", () => {
  it("passes all Python hook tests via pytest", () => {
    const result = spawnSync("pytest", [TEST_SCRIPT, "-x", "-q"], {
      encoding: "utf-8",
      timeout: 15_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
