import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Integration test for the v1.0.113 hotfix. Spawns a stripped-down replica of
 * `start.mjs`'s top-of-file env-bootstrap logic in a SUBPROCESS with cwd set
 * to a fake plugin install path, asserts the env vars are NOT poisoned by
 * that path. We don't run real `start.mjs` because it boots the full MCP
 * server (multi-second + side effects).
 */

function runStartMjsBootstrap(opts: {
  cwd: string;
  preExisting?: { CLAUDE_PROJECT_DIR?: string; CONTEXT_MODE_PROJECT_DIR?: string };
}): { CLAUDE_PROJECT_DIR: string | undefined; CONTEXT_MODE_PROJECT_DIR: string | undefined } {
  const code = `
    const isPluginInstallPath = (p) =>
      /[/\\\\]\\.claude[/\\\\]plugins[/\\\\](cache|marketplaces)[/\\\\]/.test(p);
    const originalCwd = process.cwd();
    const safeOriginalCwd = isPluginInstallPath(originalCwd) ? null : originalCwd;
    if (!process.env.CLAUDE_PROJECT_DIR && safeOriginalCwd) {
      process.env.CLAUDE_PROJECT_DIR = safeOriginalCwd;
    }
    if (!process.env.CONTEXT_MODE_PROJECT_DIR && safeOriginalCwd) {
      process.env.CONTEXT_MODE_PROJECT_DIR = safeOriginalCwd;
    }
    process.stdout.write(JSON.stringify({
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
      CONTEXT_MODE_PROJECT_DIR: process.env.CONTEXT_MODE_PROJECT_DIR,
    }));
  `;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
  };
  if (opts.preExisting?.CLAUDE_PROJECT_DIR) env.CLAUDE_PROJECT_DIR = opts.preExisting.CLAUDE_PROJECT_DIR;
  if (opts.preExisting?.CONTEXT_MODE_PROJECT_DIR) env.CONTEXT_MODE_PROJECT_DIR = opts.preExisting.CONTEXT_MODE_PROJECT_DIR;
  const out = execFileSync(process.execPath, ["-e", code], { cwd: opts.cwd, env, encoding: "utf8" });
  return JSON.parse(out);
}

describe("start.mjs env bootstrap — plugin path no-poison", () => {
  const cleanup: string[] = [];
  const makePluginDir = () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-fake-plugin-"));
    cleanup.push(root);
    const pluginPath = join(root, ".claude", "plugins", "cache", "context-mode", "context-mode", "1.0.113");
    mkdirSync(pluginPath, { recursive: true });
    return pluginPath;
  };
  const makeProjectDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-fake-project-"));
    cleanup.push(dir);
    return dir;
  };

  // After tests finish, clean every tmpdir we created.
  // Vitest's `afterEach` global is auto-injected.
  afterEach(() => {
    while (cleanup.length) {
      const p = cleanup.pop();
      if (p) try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("does NOT set CLAUDE_PROJECT_DIR or CONTEXT_MODE_PROJECT_DIR when cwd is plugin install path", () => {
    const pluginPath = makePluginDir();
    const result = runStartMjsBootstrap({ cwd: pluginPath });
    expect(result.CLAUDE_PROJECT_DIR).toBeUndefined();
    expect(result.CONTEXT_MODE_PROJECT_DIR).toBeUndefined();
  });

  it("DOES set both env vars to cwd when cwd is a normal project path", () => {
    const projectPath = makeProjectDir();
    // macOS resolves /var → /private/var inside the subprocess, so compare via realpath.
    const expected = realpathSync(projectPath);
    const result = runStartMjsBootstrap({ cwd: projectPath });
    expect(result.CLAUDE_PROJECT_DIR).toBe(expected);
    expect(result.CONTEXT_MODE_PROJECT_DIR).toBe(expected);
  });

  it("preserves a pre-set CLAUDE_PROJECT_DIR even when cwd is plugin path", () => {
    const pluginPath = makePluginDir();
    const result = runStartMjsBootstrap({
      cwd: pluginPath,
      preExisting: { CLAUDE_PROJECT_DIR: "/Users/x/preset/proj" },
    });
    expect(result.CLAUDE_PROJECT_DIR).toBe("/Users/x/preset/proj");
  });
});

