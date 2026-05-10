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

  // Case-insensitive filesystems (macOS HFS+/APFS, Windows NTFS) used to
  // produce a spurious worktree suffix when the user-supplied projectDir and
  // git's `worktree list --porcelain` output differed only in path casing.
  // Skip on Linux where the filesystem is strictly case-sensitive.
  it.skipIf(process.platform === "linux")(
    "treats casing-only path differences as the same worktree on case-insensitive FS",
    () => {
      const repo = mkdtempSync(join(tmpdir(), "ctx-case-"));
      cleanupPaths.push(repo);
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo, stdio: "ignore" });
      writeFileSync(join(repo, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });

      // Case-flip the final segment of the repo path. On HFS+/APFS/NTFS this
      // still resolves to the same on-disk directory, so suffix MUST be "".
      const flipped = repo.replace(/[a-z]/, (c) => c.toUpperCase());
      expect(flipped).not.toBe(repo);
      expect(getWorktreeSuffix(flipped)).toBe("");
    },
  );

  it("does not crash when projectDir does not exist on disk", () => {
    // realpathSync.native throws ENOENT for missing paths. The case-fold
    // comparator must swallow that error and fall back to the as-given root,
    // so callers (tests, ephemeral CI dirs) never see a thrown error from
    // getWorktreeSuffix.
    const ghost = join(tmpdir(), `ctx-ghost-${Date.now()}`);
    expect(() => getWorktreeSuffix(ghost)).not.toThrow();
  });

  it("returns a stable suffix across repeated calls in a linked worktree", () => {
    const repo = mkdtempSync(join(tmpdir(), "ctx-stable-"));
    const worktreeParent = mkdtempSync(join(tmpdir(), "ctx-stable-linked-"));
    const linked = join(worktreeParent, "linked");
    cleanupPaths.push(worktreeParent, repo);

    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "README.md"), "hello\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "-b", "feature/stable", linked], { cwd: repo, stdio: "ignore" });

    const first = getWorktreeSuffix(linked);
    _resetWorktreeSuffixCacheForTests();
    const second = getWorktreeSuffix(linked);
    expect(first).toMatch(/^__[a-f0-9]{8}$/);
    expect(second).toBe(first);
  });
});
