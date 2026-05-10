import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetWorktreeSuffixCacheForTests,
  hashProjectDirCanonical,
  hashProjectDirLegacy,
  resolveSessionDbPath,
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

describe("hashProjectDirCanonical", () => {
  it.skipIf(process.platform === "linux")(
    "Mac/Win: casing variants of same path produce identical hash",
    () => {
      const upper = "/Users/Mert/proj";
      const lower = "/users/mert/proj";
      expect(hashProjectDirCanonical(upper)).toBe(hashProjectDirCanonical(lower));
    },
  );

  it("different paths still produce different hashes (no collapsing)", () => {
    expect(hashProjectDirCanonical("/x/proj-1")).not.toBe(hashProjectDirCanonical("/x/proj-2"));
  });

  it.skipIf(process.platform !== "linux")(
    "Linux: case-sensitive — variants produce different hashes",
    () => {
      expect(hashProjectDirCanonical("/Users/Mert/proj"))
        .not.toBe(hashProjectDirCanonical("/users/mert/proj"));
    },
  );

  it("legacy hash (raw casing) differs from canonical on Mac/Win for mixed-case input", () => {
    if (process.platform === "linux") return;
    const mixed = "/Users/Mert/proj";
    expect(hashProjectDirLegacy(mixed)).not.toBe(hashProjectDirCanonical(mixed));
  });
});

describe("resolveSessionDbPath", () => {
  it("fresh install — no legacy, no canonical: returns canonical path (file not yet created)", () => {
    const repo = makeRepo("fresh");
    const sessionsDir = makeSessionsDir();
    const path = resolveSessionDbPath({ projectDir: repo, sessionsDir });
    expect(path.startsWith(sessionsDir)).toBe(true);
    expect(path.endsWith(".db")).toBe(true);
    expect(existsSync(path)).toBe(false); // not created yet — caller opens it
  });

  it.skipIf(process.platform === "linux")(
    "migrates legacy raw-casing DB to canonical when only legacy exists",
    () => {
      const repo = makeRepo("migrate");
      const sessionsDir = makeSessionsDir();

      const legacyHash = hashProjectDirLegacy(repo);
      const canonicalHash = hashProjectDirCanonical(repo);
      // Sanity: the test only matters when the two differ. realpath may
      // already lowercase on some macOS configs; skip if no migration to do.
      if (legacyHash === canonicalHash) return;

      const legacyPath = join(sessionsDir, `${legacyHash}.db`);
      writeFileSync(legacyPath, "LEGACY-DB-CONTENT");

      const resolved = resolveSessionDbPath({ projectDir: repo, sessionsDir });

      expect(resolved).toBe(join(sessionsDir, `${canonicalHash}.db`));
      expect(existsSync(resolved)).toBe(true);
      expect(readFileSync(resolved, "utf8")).toBe("LEGACY-DB-CONTENT");
      expect(existsSync(legacyPath)).toBe(false); // legacy renamed away
    },
  );

  it.skipIf(process.platform === "linux")(
    "DOES NOT migrate when both legacy AND canonical exist (data-loss safety)",
    () => {
      const repo = makeRepo("both");
      const sessionsDir = makeSessionsDir();
      const legacyHash = hashProjectDirLegacy(repo);
      const canonicalHash = hashProjectDirCanonical(repo);
      if (legacyHash === canonicalHash) return;

      const legacyPath = join(sessionsDir, `${legacyHash}.db`);
      const canonicalPath = join(sessionsDir, `${canonicalHash}.db`);
      writeFileSync(legacyPath, "LEGACY-CONTENT");
      writeFileSync(canonicalPath, "CANONICAL-CONTENT");

      const resolved = resolveSessionDbPath({ projectDir: repo, sessionsDir });

      expect(resolved).toBe(canonicalPath);
      expect(readFileSync(canonicalPath, "utf8")).toBe("CANONICAL-CONTENT"); // untouched
      expect(existsSync(legacyPath)).toBe(true); // preserved — manual reconciliation needed
      expect(readFileSync(legacyPath, "utf8")).toBe("LEGACY-CONTENT");
    },
  );

  it("different worktrees stay in separate DB files (no cross-migration)", () => {
    const wt1 = makeRepo("wt1");
    const wt2 = makeRepo("wt2");
    const sessionsDir = makeSessionsDir();

    const path1 = resolveSessionDbPath({ projectDir: wt1, sessionsDir });
    const path2 = resolveSessionDbPath({ projectDir: wt2, sessionsDir });

    expect(path1).not.toBe(path2);
  });

  it("idempotent — calling twice does not throw and returns same path", () => {
    const repo = makeRepo("idem");
    const sessionsDir = makeSessionsDir();
    const first = resolveSessionDbPath({ projectDir: repo, sessionsDir });
    _resetWorktreeSuffixCacheForTests();
    const second = resolveSessionDbPath({ projectDir: repo, sessionsDir });
    expect(second).toBe(first);
  });

  it.skipIf(process.platform !== "linux")(
    "Linux: legacy hash ALWAYS equals canonical hash → no migration path is ever attempted",
    () => {
      const repo = makeRepo("linux-noop");
      const sessionsDir = makeSessionsDir();
      // Pre-create a "legacy"-named file that would be migrated on Mac/Win.
      // On Linux, hashProjectDirLegacy === hashProjectDirCanonical so this
      // file IS the canonical file, no rename should occur.
      const hash = hashProjectDirLegacy(repo);
      expect(hash).toBe(hashProjectDirCanonical(repo));
      const filePath = join(sessionsDir, `${hash}.db`);
      writeFileSync(filePath, "LINUX-NO-OP");

      const resolved = resolveSessionDbPath({ projectDir: repo, sessionsDir });
      expect(resolved).toBe(filePath);
      expect(readFileSync(filePath, "utf8")).toBe("LINUX-NO-OP");
    },
  );
});
