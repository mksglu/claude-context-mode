import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetWorktreeSuffixCacheForTests,
  hashProjectDirCanonical,
  hashProjectDirLegacy,
  getWorktreeSuffix,
} from "../../src/session/db.js";
import { purgeSession } from "../../src/session/purge.js";

const cleanup: string[] = [];
afterEach(() => {
  _resetWorktreeSuffixCacheForTests();
  while (cleanup.length) {
    const p = cleanup.pop();
    if (p && existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

function makeRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), `ctx-purge-${prefix}-`));
  cleanup.push(repo);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "hi\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  return repo;
}

function makeTmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `ctx-purge-${prefix}-`));
  cleanup.push(d);
  return d;
}

function touchSqliteTriple(path: string): void {
  writeFileSync(path, "DB");
  writeFileSync(`${path}-wal`, "WAL");
  writeFileSync(`${path}-shm`, "SHM");
}

// ─────────────────────────────────────────────────────────
// Slice 1 — session events SQLite DB (canonical) + sidecars
// ─────────────────────────────────────────────────────────

describe("purgeSession — slice 1: session events DB (canonical)", () => {
  it("wipes <canonicalHash><suffix>.db plus -wal and -shm sidecars", () => {
    const projectDir = makeRepo("s1");
    const sessionsDir = makeTmpDir("sess1");
    const suffix = getWorktreeSuffix(projectDir);
    const canonicalHash = hashProjectDirCanonical(projectDir);
    const dbPath = join(sessionsDir, `${canonicalHash}${suffix}.db`);
    touchSqliteTriple(dbPath);

    const r = purgeSession({ projectDir, sessionsDir });

    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(r.deleted).toContain("session events DB");
    expect(r.wipedPaths).toEqual(expect.arrayContaining([dbPath, `${dbPath}-wal`, `${dbPath}-shm`]));
  });
});

// ─────────────────────────────────────────────────────────
// Slice 2 — session events DB at LEGACY raw-casing hash too
// ─────────────────────────────────────────────────────────

describe("purgeSession — slice 2: session events DB (legacy raw casing)", () => {
  it.skipIf(process.platform === "linux")(
    "wipes <legacyHash><suffix>.db when only the legacy file exists",
    () => {
      const projectDir = makeRepo("s2");
      const sessionsDir = makeTmpDir("sess2");
      const suffix = getWorktreeSuffix(projectDir);
      const canonicalHash = hashProjectDirCanonical(projectDir);
      const legacyHash = hashProjectDirLegacy(projectDir);
      // realpath may already lowercase on some macOS configs; skip when the
      // two hashes coincide and the slice has nothing to assert.
      if (canonicalHash === legacyHash) return;

      const legacyPath = join(sessionsDir, `${legacyHash}${suffix}.db`);
      touchSqliteTriple(legacyPath);

      const r = purgeSession({ projectDir, sessionsDir });

      expect(existsSync(legacyPath)).toBe(false);
      expect(existsSync(`${legacyPath}-wal`)).toBe(false);
      expect(existsSync(`${legacyPath}-shm`)).toBe(false);
      expect(r.deleted).toContain("session events DB");
      expect(r.wipedPaths).toEqual(expect.arrayContaining([legacyPath]));
    },
  );

  it.skipIf(process.platform === "linux")(
    "wipes BOTH canonical and legacy DBs when both exist (case-fold drift)",
    () => {
      const projectDir = makeRepo("s2b");
      const sessionsDir = makeTmpDir("sess2b");
      const suffix = getWorktreeSuffix(projectDir);
      const canonicalHash = hashProjectDirCanonical(projectDir);
      const legacyHash = hashProjectDirLegacy(projectDir);
      if (canonicalHash === legacyHash) return;

      const canonicalPath = join(sessionsDir, `${canonicalHash}${suffix}.db`);
      const legacyPath = join(sessionsDir, `${legacyHash}${suffix}.db`);
      writeFileSync(canonicalPath, "C");
      writeFileSync(legacyPath, "L");

      purgeSession({ projectDir, sessionsDir });

      expect(existsSync(canonicalPath)).toBe(false);
      expect(existsSync(legacyPath)).toBe(false);
    },
  );
});

// ─────────────────────────────────────────────────────────
// Slice 3 — session events markdown
// ─────────────────────────────────────────────────────────

describe("purgeSession — slice 3: session events markdown", () => {
  it("wipes <hash><suffix>-events.md", () => {
    const projectDir = makeRepo("s3");
    const sessionsDir = makeTmpDir("sess3");
    const suffix = getWorktreeSuffix(projectDir);
    const canonicalHash = hashProjectDirCanonical(projectDir);
    const eventsPath = join(sessionsDir, `${canonicalHash}${suffix}-events.md`);
    writeFileSync(eventsPath, "# events\n");

    const r = purgeSession({ projectDir, sessionsDir });

    expect(existsSync(eventsPath)).toBe(false);
    expect(r.deleted).toContain("session events markdown");
    expect(r.wipedPaths).toContain(eventsPath);
  });

  it.skipIf(process.platform === "linux")(
    "wipes events.md at BOTH canonical and legacy hashes",
    () => {
      const projectDir = makeRepo("s3b");
      const sessionsDir = makeTmpDir("sess3b");
      const suffix = getWorktreeSuffix(projectDir);
      const canonicalHash = hashProjectDirCanonical(projectDir);
      const legacyHash = hashProjectDirLegacy(projectDir);
      if (canonicalHash === legacyHash) return;

      const canonicalEvents = join(sessionsDir, `${canonicalHash}${suffix}-events.md`);
      const legacyEvents = join(sessionsDir, `${legacyHash}${suffix}-events.md`);
      writeFileSync(canonicalEvents, "C");
      writeFileSync(legacyEvents, "L");

      purgeSession({ projectDir, sessionsDir });

      expect(existsSync(canonicalEvents)).toBe(false);
      expect(existsSync(legacyEvents)).toBe(false);
    },
  );
});

// ─────────────────────────────────────────────────────────
// Slice 4 — cleanup flag
// ─────────────────────────────────────────────────────────

describe("purgeSession — slice 4: cleanup flag", () => {
  it("wipes <hash><suffix>.cleanup at canonical hash", () => {
    const projectDir = makeRepo("s4");
    const sessionsDir = makeTmpDir("sess4");
    const suffix = getWorktreeSuffix(projectDir);
    const canonicalHash = hashProjectDirCanonical(projectDir);
    const flag = join(sessionsDir, `${canonicalHash}${suffix}.cleanup`);
    writeFileSync(flag, "1");

    const r = purgeSession({ projectDir, sessionsDir });

    expect(existsSync(flag)).toBe(false);
    expect(r.wipedPaths).toContain(flag);
  });

  it.skipIf(process.platform === "linux")(
    "wipes cleanup flag at BOTH canonical and legacy hashes",
    () => {
      const projectDir = makeRepo("s4b");
      const sessionsDir = makeTmpDir("sess4b");
      const suffix = getWorktreeSuffix(projectDir);
      const canonicalHash = hashProjectDirCanonical(projectDir);
      const legacyHash = hashProjectDirLegacy(projectDir);
      if (canonicalHash === legacyHash) return;

      const canonicalFlag = join(sessionsDir, `${canonicalHash}${suffix}.cleanup`);
      const legacyFlag = join(sessionsDir, `${legacyHash}${suffix}.cleanup`);
      writeFileSync(canonicalFlag, "1");
      writeFileSync(legacyFlag, "1");

      purgeSession({ projectDir, sessionsDir });

      expect(existsSync(canonicalFlag)).toBe(false);
      expect(existsSync(legacyFlag)).toBe(false);
    },
  );
});

// ─────────────────────────────────────────────────────────
// Slice 5 — knowledge base FTS5 store (per-platform)
// ─────────────────────────────────────────────────────────

describe("purgeSession — slice 5: knowledge base FTS5 store", () => {
  it("wipes the storePath db + sidecars when storePath provided", () => {
    const projectDir = makeRepo("s5");
    const sessionsDir = makeTmpDir("sess5");
    const contentDir = makeTmpDir("content5");
    const storePath = join(contentDir, "abcdef0123456789.db");
    touchSqliteTriple(storePath);

    const r = purgeSession({ projectDir, sessionsDir, storePath });

    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(`${storePath}-wal`)).toBe(false);
    expect(existsSync(`${storePath}-shm`)).toBe(false);
    expect(r.deleted).toContain("knowledge base (FTS5)");
    expect(r.wipedPaths).toEqual(expect.arrayContaining([storePath, `${storePath}-wal`, `${storePath}-shm`]));
  });

  it("does NOT include 'knowledge base (FTS5)' label when no storePath provided AND nothing wiped", () => {
    const projectDir = makeRepo("s5b");
    const sessionsDir = makeTmpDir("sess5b");

    const r = purgeSession({ projectDir, sessionsDir });

    expect(r.deleted).not.toContain("knowledge base (FTS5)");
  });
});

// ─────────────────────────────────────────────────────────
// Slice 6 — legacy ~/.context-mode/content/<hash>.db store
// ─────────────────────────────────────────────────────────

describe("purgeSession — slice 6: legacy shared content store", () => {
  it("wipes legacy content db + sidecars at legacyContentDir/<contentHash>.db", () => {
    const projectDir = makeRepo("s6");
    const sessionsDir = makeTmpDir("sess6");
    const legacyContentDir = makeTmpDir("legacy6");
    const contentHash = "deadbeefcafebabe";
    const legacyDb = join(legacyContentDir, `${contentHash}.db`);
    touchSqliteTriple(legacyDb);

    purgeSession({ projectDir, sessionsDir, legacyContentDir, contentHash });

    expect(existsSync(legacyDb)).toBe(false);
    expect(existsSync(`${legacyDb}-wal`)).toBe(false);
    expect(existsSync(`${legacyDb}-shm`)).toBe(false);
  });

  it("is a no-op when legacyContentDir not provided", () => {
    const projectDir = makeRepo("s6b");
    const sessionsDir = makeTmpDir("sess6b");
    // no throw; result has no legacy path entries
    expect(() => purgeSession({ projectDir, sessionsDir })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────
// Slice 7 — fresh install (no files exist) is non-throwing no-op
// ─────────────────────────────────────────────────────────

describe("purgeSession — slice 7: fresh install no-op", () => {
  it("returns empty wipedPaths and empty deleted when no files exist", () => {
    const projectDir = makeRepo("s7");
    const sessionsDir = makeTmpDir("sess7");

    const r = purgeSession({ projectDir, sessionsDir });

    expect(r.wipedPaths).toEqual([]);
    expect(r.deleted).toEqual([]);
  });

  it("idempotent — calling twice on same fresh dir is safe", () => {
    const projectDir = makeRepo("s7b");
    const sessionsDir = makeTmpDir("sess7b");

    purgeSession({ projectDir, sessionsDir });
    expect(() => purgeSession({ projectDir, sessionsDir })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────
// Slice 8 — WORKTREE SEPARATION GUARANTEE
// ─────────────────────────────────────────────────────────

describe("purgeSession — slice 8: worktree separation", () => {
  it("only wipes files for THIS projectDir's hash; sibling worktree DB untouched", () => {
    const wt1 = makeRepo("wt1");
    const wt2 = makeRepo("wt2");
    const sessionsDir = makeTmpDir("sess-wt");
    const suffix1 = getWorktreeSuffix(wt1);
    const suffix2 = getWorktreeSuffix(wt2);
    const hash1 = hashProjectDirCanonical(wt1);
    const hash2 = hashProjectDirCanonical(wt2);

    const db1 = join(sessionsDir, `${hash1}${suffix1}.db`);
    const db2 = join(sessionsDir, `${hash2}${suffix2}.db`);
    const events1 = join(sessionsDir, `${hash1}${suffix1}-events.md`);
    const events2 = join(sessionsDir, `${hash2}${suffix2}-events.md`);
    const flag1 = join(sessionsDir, `${hash1}${suffix1}.cleanup`);
    const flag2 = join(sessionsDir, `${hash2}${suffix2}.cleanup`);

    touchSqliteTriple(db1);
    touchSqliteTriple(db2);
    writeFileSync(events1, "1");
    writeFileSync(events2, "2");
    writeFileSync(flag1, "1");
    writeFileSync(flag2, "2");

    const r = purgeSession({ projectDir: wt1, sessionsDir });

    // wt1 — gone
    expect(existsSync(db1)).toBe(false);
    expect(existsSync(events1)).toBe(false);
    expect(existsSync(flag1)).toBe(false);
    // wt2 — UNTOUCHED
    expect(existsSync(db2)).toBe(true);
    expect(existsSync(`${db2}-wal`)).toBe(true);
    expect(existsSync(`${db2}-shm`)).toBe(true);
    expect(existsSync(events2)).toBe(true);
    expect(existsSync(flag2)).toBe(true);
    // and the result paths must NEVER reference wt2's files
    for (const p of r.wipedPaths) {
      expect(p).not.toContain(hash2);
    }
  });
});

// ─────────────────────────────────────────────────────────
// Slice 9 — deleted labels match the legacy ctx_purge contract
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// Slice 10 — FTS5 content store: dual-hash sweep via contentDir
// ─────────────────────────────────────────────────────────

describe("purgeSession — slice 10: FTS5 dual-hash sweep via contentDir", () => {
  it.skipIf(process.platform === "linux")(
    "wipes BOTH legacy raw-casing and canonical FTS5 store .db + sidecars",
    () => {
      const projectDir = makeRepo("s10");
      const sessionsDir = makeTmpDir("sess10");
      const contentDir = makeTmpDir("content10");
      const canonicalHash = hashProjectDirCanonical(projectDir);
      const legacyHash = hashProjectDirLegacy(projectDir);
      // Cross-platform skip: if the test repo's path happens to be already
      // lowercased (rare on macOS tmpdir but possible), the dual-sweep
      // collapses to a single sweep — slice 5 already covers that.
      if (canonicalHash === legacyHash) return;

      const canonicalDb = join(contentDir, `${canonicalHash}.db`);
      const legacyDb    = join(contentDir, `${legacyHash}.db`);
      touchSqliteTriple(canonicalDb);
      touchSqliteTriple(legacyDb);

      const r = purgeSession({ projectDir, sessionsDir, contentDir });

      for (const p of [canonicalDb, `${canonicalDb}-wal`, `${canonicalDb}-shm`,
                       legacyDb, `${legacyDb}-wal`, `${legacyDb}-shm`]) {
        expect(existsSync(p)).toBe(false);
      }
      expect(r.deleted).toContain("knowledge base (FTS5)");
      // Label appears once even though both hashes were swept.
      expect(r.deleted.filter((l) => l === "knowledge base (FTS5)")).toHaveLength(1);
    },
  );

  it("contentDir triggers FTS5 sweep even when no FTS5 file exists (no-op safe)", () => {
    const projectDir = makeRepo("s10b");
    const sessionsDir = makeTmpDir("sess10b");
    const contentDir = makeTmpDir("content10b");
    const r = purgeSession({ projectDir, sessionsDir, contentDir });
    expect(r.deleted).not.toContain("knowledge base (FTS5)");
  });

  it.skipIf(process.platform !== "linux")(
    "Linux: legacyHash === canonicalHash so dual-sweep collapses to single pass",
    () => {
      const projectDir = makeRepo("s10c");
      const sessionsDir = makeTmpDir("sess10c");
      const contentDir = makeTmpDir("content10c");
      expect(hashProjectDirCanonical(projectDir)).toBe(hashProjectDirLegacy(projectDir));
      const dbPath = join(contentDir, `${hashProjectDirCanonical(projectDir)}.db`);
      touchSqliteTriple(dbPath);
      const r = purgeSession({ projectDir, sessionsDir, contentDir });
      expect(existsSync(dbPath)).toBe(false);
      expect(r.deleted).toContain("knowledge base (FTS5)");
    },
  );

  it("worktree separation: sibling project's FTS5 file at different hash is untouched", () => {
    const wt1 = makeRepo("s10wt1");
    const wt2 = makeRepo("s10wt2");
    const sessionsDir = makeTmpDir("sess10wt");
    const contentDir = makeTmpDir("content10wt");
    const wt1Hash = hashProjectDirCanonical(wt1);
    const wt2Hash = hashProjectDirCanonical(wt2);
    expect(wt1Hash).not.toBe(wt2Hash); // distinct projects
    const wt1Db = join(contentDir, `${wt1Hash}.db`);
    const wt2Db = join(contentDir, `${wt2Hash}.db`);
    touchSqliteTriple(wt1Db);
    touchSqliteTriple(wt2Db);

    purgeSession({ projectDir: wt1, sessionsDir, contentDir });

    expect(existsSync(wt1Db)).toBe(false); // wiped
    expect(existsSync(wt2Db)).toBe(true);  // untouched
  });
});

describe("purgeSession — slice 9: backward-compatible labels", () => {
  it("uses the exact legacy labels: 'knowledge base (FTS5)', 'session events DB', 'session events markdown'", () => {
    const projectDir = makeRepo("s9");
    const sessionsDir = makeTmpDir("sess9");
    const contentDir = makeTmpDir("content9");
    const storePath = join(contentDir, "feedface00000000.db");
    const suffix = getWorktreeSuffix(projectDir);
    const canonicalHash = hashProjectDirCanonical(projectDir);

    touchSqliteTriple(storePath);
    touchSqliteTriple(join(sessionsDir, `${canonicalHash}${suffix}.db`));
    writeFileSync(join(sessionsDir, `${canonicalHash}${suffix}-events.md`), "x");

    const r = purgeSession({ projectDir, sessionsDir, storePath });

    expect(r.deleted).toEqual(expect.arrayContaining([
      "knowledge base (FTS5)",
      "session events DB",
      "session events markdown",
    ]));
    // labels are de-duped
    const counts = r.deleted.reduce<Record<string, number>>((acc, l) => {
      acc[l] = (acc[l] ?? 0) + 1;
      return acc;
    }, {});
    for (const [, n] of Object.entries(counts)) expect(n).toBe(1);
  });
});
