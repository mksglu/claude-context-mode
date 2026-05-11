import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isPluginInstallPath,
  resolveProjectDir,
  resolveProjectDirFromTranscript,
} from "../../src/util/project-dir.js";

const cleanup: string[] = [];
const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

afterEach(() => {
  while (cleanup.length) {
    const p = cleanup.pop();
    if (p) try { rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

function makeTranscriptsRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "ctx-transcripts-"));
  cleanup.push(d);
  return d;
}

function writeTranscript(root: string, encodedDir: string, sessionId: string, cwd: string, mtime?: Date) {
  const dir = join(root, encodedDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  // Mirror Claude Code's transcript shape: line 1 = session metadata, line 2+ has cwd
  const lines = [
    JSON.stringify({ type: "session-meta", sessionId, permissionMode: "default" }),
    JSON.stringify({ type: "user", cwd, sessionId }),
  ];
  writeFileSync(file, lines.join("\n") + "\n");
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

function compiledResolverScript(): string {
  const moduleUrl = pathToFileURL(join(process.cwd(), "build/util/project-dir.js")).href;
  return `
    import { resolveProjectDir } from ${JSON.stringify(moduleUrl)};
    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/fallback",
      pwd: undefined,
      transcriptsRoot: "/nonexistent/transcripts"
    });
    console.log(result);
  `;
}

function runCompiledResolver(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf-8",
    env: { ...process.env, PWD: "" },
  }).trim();
}

describe("isPluginInstallPath", () => {
  it("matches macOS / Linux plugin cache paths", () => {
    expect(isPluginInstallPath("/Users/x/.claude/plugins/cache/context-mode/context-mode/1.0.112")).toBe(true);
    expect(isPluginInstallPath("/home/x/.claude/plugins/cache/foo/foo/1.0.0")).toBe(true);
  });

  it("matches plugin marketplace paths", () => {
    expect(isPluginInstallPath("/Users/x/.claude/plugins/marketplaces/context-mode")).toBe(true);
  });

  it("matches Windows plugin cache paths (backslash + drive letter)", () => {
    expect(isPluginInstallPath("C:\\Users\\x\\.claude\\plugins\\cache\\foo\\foo\\1.0.0")).toBe(true);
  });

  it("returns false for ordinary project paths", () => {
    expect(isPluginInstallPath("/Users/x/Server/proj")).toBe(false);
    expect(isPluginInstallPath("/home/x/work/proj")).toBe(false);
    expect(isPluginInstallPath("C:\\Users\\x\\proj")).toBe(false);
  });

  it("returns false for unrelated .claude subpaths (e.g. session storage)", () => {
    // This path is under .claude but NOT under .claude/plugins/* — must not match.
    expect(isPluginInstallPath("/Users/x/.claude/projects/-Users-x-proj")).toBe(false);
    expect(isPluginInstallPath("/Users/x/.claude/context-mode/sessions/abc.db")).toBe(false);
  });

  it("returns false for empty / null-ish inputs", () => {
    expect(isPluginInstallPath("")).toBe(false);
    expect(isPluginInstallPath("/")).toBe(false);
  });
});

describe("resolveProjectDir", () => {
  it("returns the first non-plugin env var in priority order", () => {
    const result = resolveProjectDir({
      env: {
        CLAUDE_PROJECT_DIR: "/Users/x/proj",
        CONTEXT_MODE_PROJECT_DIR: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0", // poisoned
      },
      cwd: "/some/cwd",
      pwd: undefined,
    });
    expect(result).toBe("/Users/x/proj");
  });

  it("rejects plugin path env vars and falls through to the next source", () => {
    const result = resolveProjectDir({
      env: {
        CLAUDE_PROJECT_DIR: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
        CONTEXT_MODE_PROJECT_DIR: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
      },
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
      pwd: "/Users/x/Server/realproj",
    });
    expect(result).toBe("/Users/x/Server/realproj"); // PWD wins, skipping poisoned env + plugin cwd
  });

  it("uses cwd as last resort when env + PWD are missing or all poisoned", () => {
    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/proj",
      pwd: undefined,
    });
    expect(result).toBe("/Users/x/proj");
  });

  it("falls back to cwd EVEN IF cwd is plugin path when nothing else exists (no panics)", () => {
    // Last-resort behavior: rather than throw, return cwd. ctx_stats can detect
    // and render a "project context unavailable" message, but the function
    // itself stays total so other tools (sandbox execute, fetch) keep working.
    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
      pwd: undefined,
    });
    expect(result).toBe("/Users/x/.claude/plugins/cache/foo/foo/1.0.0");
  });

  it("respects adapter-specific env vars (GEMINI/VSCODE/OPENCODE/PI/IDEA) in the chain", () => {
    expect(resolveProjectDir({
      env: { GEMINI_PROJECT_DIR: "/g/proj" },
      cwd: "/x", pwd: undefined,
    })).toBe("/g/proj");
    expect(resolveProjectDir({
      env: { IDEA_INITIAL_DIRECTORY: "/i/proj" },
      cwd: "/x", pwd: undefined,
    })).toBe("/i/proj");
  });

  // Issue #521 Slice 1: CURSOR_CWD is honored when Cursor (or the user) sets
  // it as an MCP env override. The cursor adapter already trusts CURSOR_CWD
  // for hook input resolution (src/adapters/cursor/index.ts:581) — extend the
  // same trust to the global resolver so ctx_stats / SessionDB / hash hit the
  // workspace path instead of the chdir'd plugin install dir.
  it("respects CURSOR_CWD when set (Cursor MCP env override or user workaround)", () => {
    const result = resolveProjectDir({
      env: { CURSOR_CWD: "/Users/x/cursor-proj" },
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0", // plugin path → rejected
      pwd: undefined,
    });
    expect(result).toBe("/Users/x/cursor-proj");
  });

  it("rejects CURSOR_CWD when it points at a plugin install path", () => {
    const result = resolveProjectDir({
      env: { CURSOR_CWD: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0" },
      cwd: "/x",
      pwd: "/Users/x/realproj",
    });
    expect(result).toBe("/Users/x/realproj"); // PWD wins, CURSOR_CWD rejected as poisoned
  });
});

describe("resolveProjectDirFromTranscript", () => {
  it("returns cwd from the most-recently-modified Claude Code transcript", () => {
    const root = makeTranscriptsRoot();
    writeTranscript(root, "-Users-x-old", "old-session", "/Users/x/old-proj", new Date(Date.now() - 60_000));
    writeTranscript(root, "-Users-x-new", "new-session", "/Users/x/new-proj", new Date());

    const result = resolveProjectDirFromTranscript({ projectsRoot: root });
    expect(result).toBe("/Users/x/new-proj");
  });

  it("returns undefined when projects dir does not exist", () => {
    const result = resolveProjectDirFromTranscript({ projectsRoot: "/nonexistent/path" });
    expect(result).toBeUndefined();
  });

  it("returns undefined when no jsonl files exist", () => {
    const root = makeTranscriptsRoot();
    mkdirSync(join(root, "-Users-x-empty"), { recursive: true });
    const result = resolveProjectDirFromTranscript({ projectsRoot: root });
    expect(result).toBeUndefined();
  });

  it("skips transcripts without a cwd field in any of their first lines", () => {
    const root = makeTranscriptsRoot();
    const dir = join(root, "-Users-x-cwd-less");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.jsonl"),
      JSON.stringify({ type: "session-meta", sessionId: "s1" }) + "\n" +
      JSON.stringify({ type: "user", text: "hi" }) + "\n",
    );
    const result = resolveProjectDirFromTranscript({ projectsRoot: root });
    expect(result).toBeUndefined();
  });

  it("resolveProjectDir prefers transcript cwd over PWD when env is empty and cwd is plugin path", () => {
    const root = makeTranscriptsRoot();
    writeTranscript(root, "-Users-x-real", "active-session", "/Users/x/real-proj");

    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0", // plugin path → rejected
      pwd: "/Users/x", // home dir, not a real project
      transcriptsRoot: root,
    });
    expect(result).toBe("/Users/x/real-proj");
  });

  it("resolveProjectDir falls back to PWD when transcript yields nothing", () => {
    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
      pwd: "/Users/x/proj",
      transcriptsRoot: "/nonexistent/transcripts",
    });
    expect(result).toBe("/Users/x/proj");
  });

  it("compiled ESM resolver runs under Node without CommonJS require", () => {
    const output = runCompiledResolver(process.execPath, [
      "--input-type=module",
      "-e",
      compiledResolverScript(),
    ]);

    expect(output).toBe("/Users/x/fallback");
  });

  it.runIf(bunAvailable)("compiled ESM resolver runs under Bun without CommonJS require", () => {
    const output = runCompiledResolver("bun", ["-e", compiledResolverScript()]);

    expect(output).toBe("/Users/x/fallback");
  });
});
