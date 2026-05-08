import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { _resetWorktreeSuffixCacheForTests, getWorktreeSuffix } from "../src/session/db.js";

describe("getWorktreeSuffix", () => {
  let cleanupPaths: string[] = [];

  beforeEach(() => {
    _resetWorktreeSuffixCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetWorktreeSuffixCacheForTests();
    for (const cleanupPath of cleanupPaths.reverse()) {
      rmSync(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths = [];
  });

  it("returns empty or __<8-hex> when no env override is set", () => {
    // In main worktree (CI, normal dev) → ""
    // In secondary worktree → "__<8-hex-chars>"
    const suffix = getWorktreeSuffix();
    expect(suffix).toMatch(/^(__[a-f0-9]{8})?$/);
  });

  it("returns empty string when CONTEXT_MODE_SESSION_SUFFIX is empty", () => {
    vi.stubEnv("CONTEXT_MODE_SESSION_SUFFIX", "");
    expect(getWorktreeSuffix()).toBe("");
  });

  it("returns __<value> when CONTEXT_MODE_SESSION_SUFFIX is set", () => {
    vi.stubEnv("CONTEXT_MODE_SESSION_SUFFIX", "my-worktree");
    expect(getWorktreeSuffix()).toBe("__my-worktree");
  });

  it("uses the git worktree root instead of the process cwd", () => {
    const repo = mkdtempSync(join(tmpdir(), "ctx-main-"));
    const worktreeParent = mkdtempSync(join(tmpdir(), "ctx-linked-parent-"));
    const linkedWorktree = join(worktreeParent, "linked");
    cleanupPaths.push(worktreeParent, repo);

    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "README.md"), "hello\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "-b", "feature/test", linkedWorktree], { cwd: repo, stdio: "ignore" });

    const mainSubdir = join(repo, "nested");
    const linkedSubdir = join(linkedWorktree, "nested");
    mkdirSync(mainSubdir);
    mkdirSync(linkedSubdir);

    expect(getWorktreeSuffix(mainSubdir)).toBe("");

    const linkedRootSuffix = getWorktreeSuffix(linkedWorktree);
    expect(linkedRootSuffix).toMatch(/^__[a-f0-9]{8}$/);
    expect(getWorktreeSuffix(linkedSubdir)).toBe(linkedRootSuffix);
  });
});
