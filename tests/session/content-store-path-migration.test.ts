import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashProjectDirCanonical,
  hashProjectDirLegacy,
  resolveContentStorePath,
} from "../../src/session/db.js";

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) {
    const p = cleanup.pop();
    if (p && existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

function makeContentDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ctx-content-"));
  cleanup.push(d);
  return d;
}

describe("resolveContentStorePath", () => {
  it("fresh install — no legacy, no canonical: returns canonical path (file not yet created)", () => {
    const projectDir = "/tmp/Some/Project";
    const contentDir = makeContentDir();
    const path = resolveContentStorePath({ projectDir, contentDir });
    expect(path.startsWith(contentDir)).toBe(true);
    expect(path.endsWith(".db")).toBe(true);
    expect(existsSync(path)).toBe(false); // caller opens it via ContentStore
  });

  it.skipIf(process.platform === "linux")(
    "Mac/Win: casing variants of same projectDir resolve to identical content store path",
    () => {
      const contentDir = makeContentDir();
      const upper = resolveContentStorePath({ projectDir: "/Users/Mert/X", contentDir });
      const lower = resolveContentStorePath({ projectDir: "/users/mert/x", contentDir });
      expect(upper).toBe(lower);
    },
  );

  it.skipIf(process.platform === "linux")(
    "migrates legacy raw-casing FTS5 db (with -wal/-shm sidecars) to canonical path",
    () => {
      const projectDir = "/Users/Mert/MigrateMe";
      const contentDir = makeContentDir();
      const legacyHash = hashProjectDirLegacy(projectDir);
      const canonicalHash = hashProjectDirCanonical(projectDir);
      if (legacyHash === canonicalHash) return; // nothing to migrate

      const legacyMain = join(contentDir, `${legacyHash}.db`);
      const legacyWal  = `${legacyMain}-wal`;
      const legacyShm  = `${legacyMain}-shm`;
      writeFileSync(legacyMain, "MAIN-DB");
      writeFileSync(legacyWal,  "WAL-DATA");
      writeFileSync(legacyShm,  "SHM-DATA");

      const resolved = resolveContentStorePath({ projectDir, contentDir });

      expect(resolved).toBe(join(contentDir, `${canonicalHash}.db`));
      expect(readFileSync(resolved, "utf8")).toBe("MAIN-DB");
      expect(readFileSync(`${resolved}-wal`, "utf8")).toBe("WAL-DATA");
      expect(readFileSync(`${resolved}-shm`, "utf8")).toBe("SHM-DATA");
      expect(existsSync(legacyMain)).toBe(false);
      expect(existsSync(legacyWal)).toBe(false);
      expect(existsSync(legacyShm)).toBe(false);
    },
  );

  it.skipIf(process.platform === "linux")(
    "DOES NOT migrate when both legacy AND canonical exist (data-loss safety)",
    () => {
      const projectDir = "/Users/Mert/BothExist";
      const contentDir = makeContentDir();
      const legacyHash = hashProjectDirLegacy(projectDir);
      const canonicalHash = hashProjectDirCanonical(projectDir);
      if (legacyHash === canonicalHash) return;

      const legacyPath = join(contentDir, `${legacyHash}.db`);
      const canonicalPath = join(contentDir, `${canonicalHash}.db`);
      writeFileSync(legacyPath, "LEGACY");
      writeFileSync(canonicalPath, "CANONICAL");

      const resolved = resolveContentStorePath({ projectDir, contentDir });

      expect(resolved).toBe(canonicalPath);
      expect(readFileSync(canonicalPath, "utf8")).toBe("CANONICAL"); // untouched
      expect(existsSync(legacyPath)).toBe(true);
      expect(readFileSync(legacyPath, "utf8")).toBe("LEGACY"); // preserved
    },
  );

  it("different projects stay in separate FTS5 files (no cross-migration)", () => {
    const contentDir = makeContentDir();
    const p1 = resolveContentStorePath({ projectDir: "/x/proj-1", contentDir });
    const p2 = resolveContentStorePath({ projectDir: "/x/proj-2", contentDir });
    expect(p1).not.toBe(p2);
  });

  it.skipIf(process.platform !== "linux")(
    "Linux: legacyHash === canonicalHash so migration never attempts",
    () => {
      const projectDir = "/Users/Mert/LinuxNoOp";
      const contentDir = makeContentDir();
      expect(hashProjectDirLegacy(projectDir)).toBe(hashProjectDirCanonical(projectDir));
      const hash = hashProjectDirCanonical(projectDir);
      const filePath = join(contentDir, `${hash}.db`);
      writeFileSync(filePath, "LINUX");
      const resolved = resolveContentStorePath({ projectDir, contentDir });
      expect(resolved).toBe(filePath);
      expect(readFileSync(filePath, "utf8")).toBe("LINUX");
    },
  );
});
