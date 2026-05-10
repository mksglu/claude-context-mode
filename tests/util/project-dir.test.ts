import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPluginInstallPath,
  resolveProjectDir,
  resolveProjectDirFromTranscript,
} from "../../src/util/project-dir.js";

const cleanup: string[] = [];
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
});
