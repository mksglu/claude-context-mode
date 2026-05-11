/**
 * resolveSessionPath — generalized variant of resolveSessionDbPath that
 * works for arbitrary file extensions (.db, -events.md, .cleanup, etc).
 *
 * Same case-fold + one-shot legacy migration semantics; the helper is the
 * single source of truth that both the TS server (db.ts internals) and the
 * .mjs hooks (hooks/session-helpers.mjs) consume — eliminating the
 * parallel JS implementation that drifted across rounds 5 and 6.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetWorktreeSuffixCacheForTests,
  hashProjectDirCanonical,
  hashProjectDirLegacy,
  resolveSessionPath,
} from "../../src/session/db.js";

const cleanup: string[] = [];
afterEach(() => {
  _resetWorktreeSuffixCacheForTests();
  while (cleanup.length) {
    const p = cleanup.pop();
    if (p && existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

function makeRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), `ctx-${prefix}-`));
  cleanup.push(repo);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "hi\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  return repo;
}

function makeSessionsDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ctx-sess-"));
  cleanup.push(d);
  return d;
}

describe("resolveSessionPath (generalized)", () => {
  it("composes <canonicalHash><suffix><ext> when no migration needed", () => {
    const repo = makeRepo("compose");
    const sessionsDir = makeSessionsDir();
    const dbPath = resolveSessionPath({ projectDir: repo, sessionsDir, ext: ".db" });
    const eventsPath = resolveSessionPath({
      projectDir: repo,
      sessionsDir,
      ext: "-events.md",
    });
    const cleanupPath = resolveSessionPath({
      projectDir: repo,
      sessionsDir,
      ext: ".cleanup",
    });
    expect(dbPath.startsWith(sessionsDir)).toBe(true);
    expect(dbPath.endsWith(".db")).toBe(true);
    expect(eventsPath.endsWith("-events.md")).toBe(true);
    expect(cleanupPath.endsWith(".cleanup")).toBe(true);
    // All three share the same hash prefix (only ext differs).
    const trimmed = (p: string, e: string) => p.slice(0, p.length - e.length);
    expect(trimmed(dbPath, ".db")).toBe(trimmed(eventsPath, "-events.md"));
    expect(trimmed(dbPath, ".db")).toBe(trimmed(cleanupPath, ".cleanup"));
  });

  it.skipIf(process.platform === "linux")(
    "migrates legacy raw-casing FILE to canonical name for arbitrary ext",
    () => {
      const repo = makeRepo("migrate-events");
      const sessionsDir = makeSessionsDir();
      const legacyHash = hashProjectDirLegacy(repo);
      const canonicalHash = hashProjectDirCanonical(repo);
      if (legacyHash === canonicalHash) return;

      // Pre-create a legacy events.md
      const legacyEvents = join(sessionsDir, `${legacyHash}-events.md`);
      writeFileSync(legacyEvents, "# legacy events\nhello");

      const resolved = resolveSessionPath({
        projectDir: repo,
        sessionsDir,
        ext: "-events.md",
      });

      expect(resolved).toBe(join(sessionsDir, `${canonicalHash}-events.md`));
      expect(existsSync(resolved)).toBe(true);
      expect(readFileSync(resolved, "utf8")).toBe("# legacy events\nhello");
      expect(existsSync(legacyEvents)).toBe(false);
    },
  );

  it.skipIf(process.platform === "linux")(
    "data-loss safety: leaves legacy alone when canonical also exists",
    () => {
      const repo = makeRepo("both-cleanup");
      const sessionsDir = makeSessionsDir();
      const legacyHash = hashProjectDirLegacy(repo);
      const canonicalHash = hashProjectDirCanonical(repo);
      if (legacyHash === canonicalHash) return;

      const legacyCleanup = join(sessionsDir, `${legacyHash}.cleanup`);
      const canonicalCleanup = join(sessionsDir, `${canonicalHash}.cleanup`);
      writeFileSync(legacyCleanup, "LEGACY-FLAG");
      writeFileSync(canonicalCleanup, "CANONICAL-FLAG");

      const resolved = resolveSessionPath({
        projectDir: repo,
        sessionsDir,
        ext: ".cleanup",
      });
      expect(resolved).toBe(canonicalCleanup);
      expect(readFileSync(canonicalCleanup, "utf8")).toBe("CANONICAL-FLAG");
      expect(existsSync(legacyCleanup)).toBe(true);
      expect(readFileSync(legacyCleanup, "utf8")).toBe("LEGACY-FLAG");
    },
  );

  it("Linux: legacy === canonical so no migration ever runs", () => {
    if (process.platform !== "linux") return;
    const repo = makeRepo("linux-events");
    const sessionsDir = makeSessionsDir();
    const hash = hashProjectDirLegacy(repo);
    expect(hash).toBe(hashProjectDirCanonical(repo));
    const file = join(sessionsDir, `${hash}-events.md`);
    writeFileSync(file, "# linux noop\n");
    const resolved = resolveSessionPath({
      projectDir: repo,
      sessionsDir,
      ext: "-events.md",
    });
    expect(resolved).toBe(file);
    expect(readFileSync(file, "utf8")).toBe("# linux noop\n");
  });

  it("worktree suffix flows through (different worktrees → different paths)", () => {
    const wt1 = makeRepo("wt-a");
    const wt2 = makeRepo("wt-b");
    const sessionsDir = makeSessionsDir();
    const p1 = resolveSessionPath({ projectDir: wt1, sessionsDir, ext: ".cleanup" });
    const p2 = resolveSessionPath({ projectDir: wt2, sessionsDir, ext: ".cleanup" });
    expect(p1).not.toBe(p2);
  });

  it("explicit `suffix` opt-in: hook layer can pass its own marker-cached suffix", () => {
    // The hook layer caches the worktree suffix in a tmpdir marker file
    // (so subsequent hook forks skip the git subprocess). It needs to be
    // able to inject that cached value without re-invoking git here.
    const repo = makeRepo("explicit-suffix");
    const sessionsDir = makeSessionsDir();
    const fakeSuffix = "__abc12345";
    const resolved = resolveSessionPath({
      projectDir: repo,
      sessionsDir,
      ext: ".db",
      suffix: fakeSuffix,
    });
    const canonicalHash = hashProjectDirCanonical(repo);
    expect(resolved).toBe(join(sessionsDir, `${canonicalHash}${fakeSuffix}.db`));
  });

  it("resolveSessionDbPath stays consistent with resolveSessionPath(ext: .db)", () => {
    // Lock the contract: the existing exported entrypoint must equal the
    // generalized helper for ext: ".db" so behavior cannot drift between them.
    const repo = makeRepo("contract");
    const sessionsDir = makeSessionsDir();
    // Re-import the canonical export to compare.
    return import("../../src/session/db.js").then(({ resolveSessionDbPath }) => {
      const a = resolveSessionDbPath({ projectDir: repo, sessionsDir });
      _resetWorktreeSuffixCacheForTests();
      const b = resolveSessionPath({ projectDir: repo, sessionsDir, ext: ".db" });
      expect(a).toBe(b);
    });
  });
});
