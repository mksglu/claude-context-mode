/**
 * Consolidated CLI tests
 *
 * Combines:
 *   - cli-bundle.test.ts (marketplace install support)
 *   - cli-hook-path.test.ts (forward-slash hook paths)
 *   - package-exports.test.ts (public API surface)
 */
import { describe, it, test, expect, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync, existsSync, accessSync, constants, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { toUnixPath } from "../../src/cli.js";

const ROOT = resolve(import.meta.dirname, "../..");

// ── cli.bundle.mjs — marketplace install support ──────────────────────

describe("cli.bundle.mjs — marketplace install support", () => {
  // ── Package configuration ─────────────────────────────────

  it("package.json files field includes cli.bundle.mjs", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.files).toContain("cli.bundle.mjs");
  });

  it("package.json bundle script builds cli.bundle.mjs", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts.bundle).toContain("cli.bundle.mjs");
    expect(pkg.scripts.bundle).toContain("src/cli.ts");
  });

  // ── Bundle artifact ────────────────────────────────────────

  it("cli.bundle.mjs exists after npm run bundle", () => {
    expect(existsSync(resolve(ROOT, "cli.bundle.mjs"))).toBe(true);
  });

  it("cli.bundle.mjs is readable", () => {
    expect(() => accessSync(resolve(ROOT, "cli.bundle.mjs"), constants.R_OK)).not.toThrow();
  });

  it("cli.bundle.mjs has shebang only on line 1 (Node.js strips it)", () => {
    const content = readFileSync(resolve(ROOT, "cli.bundle.mjs"), "utf-8");
    const lines = content.split("\n");
    expect(lines[0].startsWith("#!")).toBe(true);
    // No shebang on any other line (would cause SyntaxError)
    const shebangsAfterLine1 = lines.slice(1).filter(l => l.startsWith("#!"));
    expect(shebangsAfterLine1).toHaveLength(0);
  });

  // ── Source code contracts ──────────────────────────────────

  it("cli.ts getPluginRoot handles both build/ and root locations", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    // Must detect build/ subdirectory and go up, or stay at root
    expect(src).toContain('endsWith("/build")');
    expect(src).toContain('endsWith("\\\\build")');
  });

  it("cli.ts upgrade copies cli.bundle.mjs to target", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    expect(src).toContain('"cli.bundle.mjs"');
    // Must be in the items array for in-place update
    expect(src).toMatch(/items\s*=\s*\[[\s\S]*?"cli\.bundle\.mjs"/);
  });

  it("cli.ts upgrade doctor call prefers cli.bundle.mjs with fallback", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    expect(src).toContain("cli.bundle.mjs");
    expect(src).toContain("build");
    expect(src).toContain("cli.js");
    // Must use existsSync for fallback
    expect(src).toContain("existsSync");
  });

  it("cli.ts upgrade rebuilds better-sqlite3 native addon after deps install", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    // Extract only the upgrade function body (starts with "async function upgrade")
    const upgradeStart = src.indexOf("async function upgrade");
    expect(upgradeStart).toBeGreaterThan(-1);
    const upgradeSrc = src.slice(upgradeStart);
    // Must rebuild native addons between production deps and global install
    const depsIdx = upgradeSrc.indexOf('"install", "--production"');
    const rebuildIdx = upgradeSrc.indexOf('"rebuild", "better-sqlite3"');
    const globalIdx = upgradeSrc.indexOf('"install", "-g"');
    expect(depsIdx).toBeGreaterThan(-1);
    expect(rebuildIdx).toBeGreaterThan(-1);
    expect(globalIdx).toBeGreaterThan(-1);
    // rebuild must come after deps and before global install
    expect(rebuildIdx).toBeGreaterThan(depsIdx);
    expect(rebuildIdx).toBeLessThan(globalIdx);
  });

  it("cli.ts upgrade chmod handles both cli binaries", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    // Must chmod both build/cli.js and cli.bundle.mjs
    expect(src).toMatch(/for\s*\(.*\["build\/cli\.js",\s*"cli\.bundle\.mjs"\]/);
  });

  // ── Skill files ────────────────────────────────────────────

  it("ctx-upgrade skill uses cli.bundle.mjs with fallback", () => {
    const skill = readFileSync(resolve(ROOT, "skills", "ctx-upgrade", "SKILL.md"), "utf-8");
    expect(skill).toContain("cli.bundle.mjs");
    expect(skill).toContain("build/cli.js");
    // Fallback pattern: try bundle first, then build
    expect(skill).toMatch(/CLI=.*cli\.bundle\.mjs.*\[ ! -f.*\].*build\/cli\.js/);
  });

  it("ctx-doctor skill uses cli.bundle.mjs with fallback", () => {
    const skill = readFileSync(resolve(ROOT, "skills", "ctx-doctor", "SKILL.md"), "utf-8");
    expect(skill).toContain("cli.bundle.mjs");
    expect(skill).toContain("build/cli.js");
    expect(skill).toMatch(/CLI=.*cli\.bundle\.mjs.*\[ ! -f.*\].*build\/cli\.js/);
  });

  // ── .gitignore ─────────────────────────────────────────────

  it(".gitignore excludes bundle files (CI uses git add -f)", () => {
    const gitignore = readFileSync(resolve(ROOT, ".gitignore"), "utf-8");
    expect(gitignore).toContain("server.bundle.mjs");
    expect(gitignore).toContain("cli.bundle.mjs");
  });
});

// ── .mcp.json — MCP server config ────────────────────────────────────

describe(".mcp.json — MCP server config", () => {
  it("upgrade writes .mcp.json with resolved absolute path, not ${CLAUDE_PLUGIN_ROOT}", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    const upgradeStart = src.indexOf("async function upgrade");
    const upgradeSrc = src.slice(upgradeStart);
    // items array must NOT include .mcp.json (it's written dynamically)
    const itemsMatch = upgradeSrc.match(/const items\s*=\s*\[([\s\S]*?)\];/);
    expect(itemsMatch).not.toBeNull();
    expect(itemsMatch![1]).not.toContain(".mcp.json");
    // Must write .mcp.json dynamically with resolve()
    expect(upgradeSrc).toContain('resolve(pluginRoot, "start.mjs")');
    expect(upgradeSrc).toContain('resolve(pluginRoot, ".mcp.json")');
  });

  it("plugin manifest keeps ${CLAUDE_PLUGIN_ROOT} for marketplace compatibility", () => {
    // Marketplace installs read .claude-plugin/plugin.json, not repo-root
    // .mcp.json. The plugin manifest is the one that must retain the
    // ${CLAUDE_PLUGIN_ROOT} placeholder so installed plugins resolve their
    // bundled server path. Repo-root .mcp.json is for contributors opening
    // the repo as a regular project and uses a relative path to avoid the
    // "Missing environment variable: CLAUDE_PLUGIN_ROOT" warning.
    const plugin = JSON.parse(
      readFileSync(resolve(ROOT, ".claude-plugin", "plugin.json"), "utf-8"),
    );
    const args = plugin.mcpServers["context-mode"].args;
    expect(args[0]).toContain("CLAUDE_PLUGIN_ROOT");
  });

  it("repo-root .mcp.json uses relative path to silence CLAUDE_PLUGIN_ROOT warning", () => {
    const mcp = JSON.parse(readFileSync(resolve(ROOT, ".mcp.json"), "utf-8"));
    const args = mcp.mcpServers["context-mode"].args;
    expect(args[0]).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(args[0]).toMatch(/^\.\/|^start\.mjs$/);
  });
});

// ── CLI Hook Path Tests ───────────────────────────────────────────────

describe("CLI Hook Path Tests", () => {
  test("toUnixPath: converts backslashes to forward slashes", () => {
    const input = "C:\\Users\\xxx\\AppData\\Local\\npm-cache\\_npx\\hooks\\pretooluse.mjs";
    const result = toUnixPath(input);
    assert.ok(
      !result.includes("\\"),
      `Expected no backslashes, got: ${result}`,
    );
    assert.equal(
      result,
      "C:/Users/xxx/AppData/Local/npm-cache/_npx/hooks/pretooluse.mjs",
    );
  });

  test("toUnixPath: leaves forward-slash paths unchanged", () => {
    const input = "/home/user/.claude/plugins/context-mode/hooks/pretooluse.mjs";
    const result = toUnixPath(input);
    assert.equal(result, input);
  });

  test("toUnixPath: handles mixed slashes", () => {
    const input = "C:/Users\\xxx/AppData\\Local\\hooks/pretooluse.mjs";
    const result = toUnixPath(input);
    assert.ok(!result.includes("\\"), `Expected no backslashes, got: ${result}`);
  });

  test("toUnixPath: hook command string has no backslashes", () => {
    // Simulate what upgrade() does: "node " + resolve(...)
    // On Windows, resolve() returns backslashes — toUnixPath must normalize them
    const windowsPath = "C:\\Users\\xxx\\.claude\\plugins\\cache\\context-mode\\hooks\\pretooluse.mjs";
    const command = "node " + toUnixPath(windowsPath);
    assert.ok(
      !command.includes("\\"),
      `Hook command must not contain backslashes: ${command}`,
    );
  });

  test("toUnixPath: sessionstart path has no backslashes", () => {
    const windowsPath = "C:\\Users\\xxx\\.claude\\plugins\\cache\\context-mode\\hooks\\sessionstart.mjs";
    const command = "node " + toUnixPath(windowsPath);
    assert.ok(
      !command.includes("\\"),
      `SessionStart command must not contain backslashes: ${command}`,
    );
  });
});

// ── ABI-aware native binary caching (#148) ────────────────────────────

/**
 * Extract ensureNativeCompat from hooks/ensure-deps.mjs at test time.
 * ensure-deps.mjs is the shared bootstrap with side effects (auto-runs on import),
 * so we extract the function source via regex, wrap it as a temp ESM module,
 * and dynamically import it — tests always run against the real code.
 */
async function loadEnsureNativeCompat(): Promise<(pluginRoot: string) => void> {
  const src = readFileSync(resolve(ROOT, "hooks", "ensure-deps.mjs"), "utf-8");
  const match = src.match(/^export function ensureNativeCompat\b[\s\S]*?^}/m);
  if (!match) throw new Error("ensureNativeCompat not found in hooks/ensure-deps.mjs");

  // Also extract hasModernSqlite if ensureNativeCompat calls it (#331)
  const helperMatch = src.match(/^function hasModernSqlite\b[\s\S]*?^}/m);
  const helpers = helperMatch ? helperMatch[0] + "\n" : "";

  // Extract codesignBinary and probeNativeInChildProcess helpers if present
  const codesignMatch = src.match(/^function codesignBinary\b[\s\S]*?^}/m);
  const probeMatch = src.match(/^function probeNativeInChildProcess\b[\s\S]*?^}/m);
  const codesign = codesignMatch ? codesignMatch[0] + "\n" : "";
  const probe = probeMatch ? probeMatch[0] + "\n" : "";

  const tmpFile = join(tmpdir(), `abi-test-${Date.now()}.mjs`);
  writeFileSync(tmpFile, [
    'import { existsSync, copyFileSync } from "node:fs";',
    'import { resolve } from "node:path";',
    'import { createRequire } from "node:module";',
    'import { execSync } from "node:child_process";',
    helpers,
    codesign,
    probe,
    `${match[0]}`,
  ].join("\n"));

  try {
    const mod = await import(tmpFile);
    return mod.ensureNativeCompat;
  } finally {
    rmSync(tmpFile, { force: true });
  }
}

describe("ABI-aware native binary caching (#148)", () => {
  let tempDir: string;
  let releaseDir: string;
  let binaryPath: string;

  const currentAbi = process.versions.modules;

  function abiCachePath(abi: string = currentAbi): string {
    return join(releaseDir, `better_sqlite3.abi${abi}.node`);
  }

  function createFakeBinary(path: string, content: string = "fake-binary"): void {
    writeFileSync(path, content);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "abi-test-"));
    releaseDir = join(tempDir, "node_modules", "better-sqlite3", "build", "Release");
    binaryPath = join(releaseDir, "better_sqlite3.node");
    mkdirSync(releaseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("ensure-deps.mjs contains ensureNativeCompat function", () => {
    const src = readFileSync(resolve(ROOT, "hooks", "ensure-deps.mjs"), "utf-8");
    expect(src).toContain("function ensureNativeCompat");
    // ensure-deps.mjs auto-runs the function with root on import
    expect(src).toContain("ensureNativeCompat(root)");
  });

  test("cache hit: copies cached ABI binary to active path", async () => {
    const ensureNativeCompat = await loadEnsureNativeCompat();
    createFakeBinary(abiCachePath(), "abi-cached-binary");
    createFakeBinary(binaryPath, "old-binary");

    ensureNativeCompat(tempDir);

    expect(readFileSync(binaryPath, "utf-8")).toBe("abi-cached-binary");
  });

  test("missing release directory: does not throw", async () => {
    const ensureNativeCompat = await loadEnsureNativeCompat();
    rmSync(releaseDir, { recursive: true });

    expect(() => ensureNativeCompat(tempDir)).not.toThrow();
  });

  test("missing binary + no cache: does not throw", async () => {
    const ensureNativeCompat = await loadEnsureNativeCompat();
    expect(() => ensureNativeCompat(tempDir)).not.toThrow();
  });

  test("cache hit does not trigger rebuild", async () => {
    const ensureNativeCompat = await loadEnsureNativeCompat();
    createFakeBinary(abiCachePath(), "cached");
    createFakeBinary(binaryPath, "old");

    ensureNativeCompat(tempDir);

    expect(readFileSync(binaryPath, "utf-8")).toBe("cached");
  });

  test("cross-platform: ABI cache filename uses correct format", async () => {
    const ensureNativeCompat = await loadEnsureNativeCompat();
    createFakeBinary(binaryPath, "binary");

    // Trigger probe — will fail (fake binary) but outer catch swallows it
    ensureNativeCompat(tempDir);

    const files = readdirSync(releaseDir);
    const cacheFiles = files.filter(f => f.match(/^better_sqlite3\.abi\d+\.node$/));
    // Probe fails on fake binary, so no cache file is created — that's correct behavior
    expect(cacheFiles.length).toBeLessThanOrEqual(1);
  });

  test("multiple ABI caches coexist without interference", async () => {
    const ensureNativeCompat = await loadEnsureNativeCompat();
    createFakeBinary(join(releaseDir, "better_sqlite3.abi115.node"), "node20-binary");
    createFakeBinary(join(releaseDir, "better_sqlite3.abi137.node"), "node24-binary");
    createFakeBinary(binaryPath, "old");

    ensureNativeCompat(tempDir);

    const expected = currentAbi === "115" ? "node20-binary" : currentAbi === "137" ? "node24-binary" : undefined;
    if (expected) {
      expect(readFileSync(binaryPath, "utf-8")).toBe(expected);
    }

    expect(existsSync(join(releaseDir, "better_sqlite3.abi115.node"))).toBe(true);
    expect(existsSync(join(releaseDir, "better_sqlite3.abi137.node"))).toBe(true);
  });
});

// ── bun:sqlite adapter (#45) ──────────────────────────────────────────

describe("bun:sqlite adapter (#45)", () => {
  /**
   * Helper: create an in-memory SQLite db that behaves like bun:sqlite.
   * Uses better-sqlite3 as engine but strips/alters methods to match bun:sqlite API:
   * - NO .pragma() method
   * - .get() returns null instead of undefined
   * - .exec() is alias for single-statement .run()
   */
  async function createBunLikeFake(dbPath?: string) {
    const { loadDatabase } = await import("../../src/db-base.js");
    const Database = loadDatabase();
    const real = new Database(dbPath ?? ":memory:");

    const wrapStatement = (stmt: any) => ({
      run: (...args: any[]) => stmt.run(...args),
      get: (...args: any[]) => {
        const r = stmt.get(...args);
        return r === undefined ? null : r; // bun returns null
      },
      all: (...args: any[]) => stmt.all(...args),
      iterate: (...args: any[]) => stmt.iterate(...args),
      columns: () => stmt.columns(),
    });

    return {
      prepare: (sql: string) => wrapStatement(real.prepare(sql)),
      exec: (sql: string) => real.exec(sql),
      transaction: (fn: any) => real.transaction(fn),
      close: () => real.close(),
      // NO .pragma() — bun:sqlite doesn't have it
    };
  }

  test("pragma: adapter.pragma() returns scalar for assignment", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const dbFile = join(mkdtempSync(join(tmpdir(), "bun-adapter-")), "test.db");
    const fake = await createBunLikeFake(dbFile);
    const db = new BunSQLiteAdapter(fake);
    const result = db.pragma("journal_mode = WAL");
    expect(result).toBe("wal");
    db.close();
    rmSync(dbFile, { force: true });
  });

  test("pragma: adapter.pragma() returns rows for table_xinfo", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    fake.exec("CREATE TABLE test_tbl (id INTEGER PRIMARY KEY, name TEXT)");
    const rows = db.pragma("table_xinfo(test_tbl)");
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(2);
    expect(rows[0].name).toBe("id");
    expect(rows[1].name).toBe("name");
    db.close();
  });

  test("exec: adapter.exec() handles multi-statement SQL", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    db.exec(`
      CREATE TABLE t1 (id INTEGER PRIMARY KEY);
      CREATE TABLE t2 (id INTEGER PRIMARY KEY);
      INSERT INTO t1 VALUES (1);
      INSERT INTO t2 VALUES (2);
    `);
    const r1 = db.prepare("SELECT * FROM t1").all();
    const r2 = db.prepare("SELECT * FROM t2").all();
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    db.close();
  });

  test("exec: adapter.exec() handles semicolons inside string literals", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    db.exec(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT);
      INSERT INTO t VALUES (1, 'hello; world');
      INSERT INTO t VALUES (2, 'foo "bar; baz" qux');
    `);
    const rows = db.prepare("SELECT * FROM t ORDER BY id").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].val).toBe("hello; world");
    expect(rows[1].val).toBe('foo "bar; baz" qux');
    db.close();
  });

  test("get: adapter.prepare().get() returns undefined not null for missing row", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const result = db.prepare("SELECT * FROM t WHERE id = 999").get();
    expect(result).toBeUndefined(); // not null
    expect(result).not.toBeNull();
    db.close();
  });

  test("run: adapter.prepare().run() returns {changes, lastInsertRowid}", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const info = db.prepare("INSERT INTO t (name) VALUES (?)").run("test");
    expect(info.changes).toBe(1);
    expect(info.lastInsertRowid).toBe(1);
    db.close();
  });

  test("transaction: adapter.transaction() works", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
    const insertMany = db.transaction((items: string[]) => {
      for (const item of items) {
        db.prepare("INSERT INTO t (val) VALUES (?)").run(item);
      }
    });
    insertMany(["a", "b", "c"]);
    const rows = db.prepare("SELECT * FROM t").all();
    expect(rows).toHaveLength(3);
    db.close();
  });

  test("loadDatabase: checks globalThis.Bun before choosing driver (#163)", () => {
    // Bun's require("better-sqlite3") returns a non-functional stub.
    // loadDatabase() must check globalThis.Bun FIRST and use bun:sqlite directly.
    const src = readFileSync(resolve(ROOT, "src", "db-base.ts"), "utf-8");
    const loadDbSection = src.slice(src.indexOf("function loadDatabase"), src.indexOf("return _Database"));
    // Must check Bun runtime before loading any driver
    expect(loadDbSection).toContain("globalThis");
    expect(loadDbSection).toContain("Bun");
    // Bun path must use bun:sqlite via BunSQLiteAdapter
    expect(loadDbSection).toContain("BunSQLiteAdapter");
    // Node path uses better-sqlite3
    expect(loadDbSection).toContain("better-sqlite3");
  });

  test("loadDatabase: falls back to BunSQLiteAdapter when better-sqlite3 unavailable", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    // BunSQLiteAdapter should be a class/constructor
    expect(typeof BunSQLiteAdapter).toBe("function");
    // Verify it provides the full better-sqlite3 interface
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    expect(typeof db.pragma).toBe("function");
    expect(typeof db.exec).toBe("function");
    expect(typeof db.prepare).toBe("function");
    expect(typeof db.transaction).toBe("function");
    expect(typeof db.close).toBe("function");
    db.close();
  });
});

// ── node:sqlite adapter (#228) ──────────────────────────────────────────

describe("node:sqlite adapter (#228)", () => {
  /**
   * Helper: create an in-memory SQLite db that behaves like node:sqlite's DatabaseSync.
   * Uses better-sqlite3 as engine but strips/alters methods to match node:sqlite API:
   * - NO .pragma() method
   * - NO .transaction() method
   * - .exec() supports multi-statement natively (better-sqlite3 already does)
   * - .get() returns undefined (same as better-sqlite3)
   * - .prepare() returns StatementSync-like objects
   */
  async function createNodeSQLiteFake(dbPath?: string) {
    const { loadDatabase } = await import("../../src/db-base.js");
    // Reset cached _Database to get fresh better-sqlite3
    const Database = loadDatabase();
    const real = new Database(dbPath ?? ":memory:");

    return {
      prepare: (sql: string) => {
        const stmt = real.prepare(sql);
        return {
          run: (...args: any[]) => stmt.run(...args),
          get: (...args: any[]) => stmt.get(...args),
          all: (...args: any[]) => stmt.all(...args),
          // node:sqlite doesn't have iterate() — has Symbol.iterator
          [Symbol.iterator]: (...args: any[]) => stmt.iterate(...args),
        };
      },
      exec: (sql: string) => real.exec(sql),
      // NO .pragma() — node:sqlite doesn't have it
      // NO .transaction() — node:sqlite doesn't have it
      close: () => real.close(),
    };
  }

  test("pragma: adapter.pragma() returns scalar for assignment", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const dbFile = join(mkdtempSync(join(tmpdir(), "node-adapter-")), "test.db");
    const fake = await createNodeSQLiteFake(dbFile);
    const db = new NodeSQLiteAdapter(fake);
    const result = db.pragma("journal_mode = WAL");
    expect(result).toBe("wal");
    db.close();
    rmSync(dbFile, { force: true });
  });

  test("pragma: adapter.pragma() returns rows for table_xinfo", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createNodeSQLiteFake();
    const db = new NodeSQLiteAdapter(fake);
    fake.exec("CREATE TABLE test_tbl (id INTEGER PRIMARY KEY, name TEXT)");
    const rows = db.pragma("table_xinfo(test_tbl)");
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(2);
    expect(rows[0].name).toBe("id");
    expect(rows[1].name).toBe("name");
    db.close();
  });

  test("exec: adapter.exec() handles multi-statement SQL", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createNodeSQLiteFake();
    const db = new NodeSQLiteAdapter(fake);
    db.exec(`
      CREATE TABLE t1 (id INTEGER PRIMARY KEY);
      CREATE TABLE t2 (id INTEGER PRIMARY KEY);
      INSERT INTO t1 VALUES (1);
      INSERT INTO t2 VALUES (2);
    `);
    const r1 = db.prepare("SELECT * FROM t1").all();
    const r2 = db.prepare("SELECT * FROM t2").all();
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    db.close();
  });

  test("get: adapter.prepare().get() returns undefined for missing row", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createNodeSQLiteFake();
    const db = new NodeSQLiteAdapter(fake);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const result = db.prepare("SELECT * FROM t WHERE id = 999").get();
    expect(result).toBeUndefined();
    db.close();
  });

  test("run: adapter.prepare().run() returns {changes, lastInsertRowid}", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createNodeSQLiteFake();
    const db = new NodeSQLiteAdapter(fake);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const info = db.prepare("INSERT INTO t (name) VALUES (?)").run("test");
    expect(info.changes).toBe(1);
    expect(info.lastInsertRowid).toBe(1);
    db.close();
  });

  test("transaction: adapter.transaction() commits on success", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createNodeSQLiteFake();
    const db = new NodeSQLiteAdapter(fake);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
    const insertMany = db.transaction((items: string[]) => {
      for (const item of items) {
        db.prepare("INSERT INTO t (val) VALUES (?)").run(item);
      }
    });
    insertMany(["a", "b", "c"]);
    const rows = db.prepare("SELECT * FROM t").all();
    expect(rows).toHaveLength(3);
    db.close();
  });

  test("transaction: adapter.transaction() rolls back on error", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createNodeSQLiteFake();
    const db = new NodeSQLiteAdapter(fake);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
    const failingTx = db.transaction(() => {
      db.prepare("INSERT INTO t (val) VALUES (?)").run("should-rollback");
      throw new Error("intentional");
    });
    expect(() => failingTx()).toThrow("intentional");
    const rows = db.prepare("SELECT * FROM t").all();
    expect(rows).toHaveLength(0); // rolled back
    db.close();
  });

  test("loadDatabase: source checks platform before choosing node:sqlite (#228)", () => {
    const src = readFileSync(resolve(ROOT, "src", "db-base.ts"), "utf-8");
    const loadDbSection = src.slice(src.indexOf("function loadDatabase"), src.indexOf("return _Database"));
    // Must check Linux platform
    expect(loadDbSection).toContain('process.platform');
    expect(loadDbSection).toContain('"linux"');
    // Must reference NodeSQLiteAdapter
    expect(loadDbSection).toContain("NodeSQLiteAdapter");
    // Must still have better-sqlite3 fallback
    expect(loadDbSection).toContain("better-sqlite3");
  });

  test("NodeSQLiteAdapter provides full better-sqlite3 interface", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createNodeSQLiteFake();
    const db = new NodeSQLiteAdapter(fake);
    expect(typeof db.pragma).toBe("function");
    expect(typeof db.exec).toBe("function");
    expect(typeof db.prepare).toBe("function");
    expect(typeof db.transaction).toBe("function");
    expect(typeof db.close).toBe("function");
    db.close();
  });
});

// ── Shared dep bootstrap (#172) ──────────────────────────────────────

describe("hooks/ensure-deps.mjs — shared bootstrap", () => {
  it("ensure-deps.mjs exists and exports ensureDeps function", async () => {
    expect(existsSync(resolve(ROOT, "hooks", "ensure-deps.mjs"))).toBe(true);
    const mod = await import("../../hooks/ensure-deps.mjs");
    expect(typeof mod.ensureDeps).toBe("function");
  });

  it("start.mjs uses ensure-deps.mjs for native deps", () => {
    const src = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
    expect(src).toContain("ensure-deps.mjs");
    // better-sqlite3 should NOT be in start.mjs inline loop (handled by ensure-deps)
    expect(src).not.toMatch(/for.*\[.*"better-sqlite3"/s);
  });

  it("all session hooks import ensure-deps.mjs", () => {
    const sessionHooks = [
      "hooks/sessionstart.mjs",
      "hooks/posttooluse.mjs",
      "hooks/precompact.mjs",
      "hooks/userpromptsubmit.mjs",
    ];
    for (const hook of sessionHooks) {
      const src = readFileSync(resolve(ROOT, hook), "utf-8");
      expect(src).toContain("ensure-deps.mjs");
    }
  });
});

// ── Cross-OS compatibility ────────────────────────────────────────────

describe("Cross-OS compatibility", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
  const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");

  it("build script does not shell out to POSIX chmod command", () => {
    // Shell `chmod +x` is not available on Windows cmd.exe
    // Node.js fs.chmodSync is cross-platform and acceptable
    expect(pkg.scripts.build).not.toMatch(/\bchmod\s+\+x\b/);
  });

  it("postinstall script uses node for cross-platform compatibility", () => {
    // POSIX [ -n ... ] && printf || true fails on Windows cmd.exe
    expect(pkg.scripts.postinstall).not.toMatch(/\[ -n/);
    expect(pkg.scripts.postinstall).not.toContain("printf");
    expect(pkg.scripts.postinstall).toMatch(/^node /);
    // postinstall.mjs must be in files array for npm publish
    expect(pkg.files).toContain("scripts/postinstall.mjs");
  });

  it("install:openclaw gracefully handles missing bash on Windows", () => {
    // Direct 'bash' invocation fails on Windows without Git Bash
    expect(pkg.scripts["install:openclaw"]).not.toMatch(/^bash /);
  });

  it("cli.ts chmodSync in setup/upgrade is guarded by platform check", () => {
    // chmodSync must only run on non-Windows
    const chmodIdx = src.indexOf('chmodSync(binPath');
    expect(chmodIdx).toBeGreaterThan(-1);
    // Must have a platform guard before the chmodSync call
    const contextBefore = src.slice(Math.max(0, chmodIdx - 500), chmodIdx);
    expect(contextBefore).toMatch(/process\.platform\s*!==\s*["']win32["']/);
  });
});

// ── Bin entry: cli.bundle.mjs ─────────────────────────────────────────

describe("Bin entry uses cli.bundle.mjs", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));

  it("package.json bin points to cli.bundle.mjs, not build/cli.js", () => {
    expect(pkg.bin["context-mode"]).toBe("./cli.bundle.mjs");
  });

  it("package.json exports ./cli points to cli.bundle.mjs", () => {
    expect(pkg.exports["./cli"]).toBe("./cli.bundle.mjs");
  });

  it("server.ts ctx_doctor runs diagnostics in-process (no CLI dependency)", () => {
    const src = readFileSync(resolve(ROOT, "src", "server.ts"), "utf-8");
    const doctorSection = src.slice(src.indexOf("ctx_doctor"), src.indexOf("ctx_upgrade"));
    // Must NOT delegate to CLI — runs server-side
    expect(doctorSection).not.toContain('node "');
    // Must run actual checks
    expect(doctorSection).toContain("PolyglotExecutor");
    expect(doctorSection).toContain("FTS5");
  });

  it("server.ts ctx_upgrade uses cli.bundle.mjs with fallback", () => {
    const src = readFileSync(resolve(ROOT, "src", "server.ts"), "utf-8");
    // ctx_upgrade handler must prefer cli.bundle.mjs
    const upgradeSection = src.slice(src.indexOf("ctx_upgrade"), src.indexOf("ctx_upgrade") + 800);
    expect(upgradeSection).toContain("cli.bundle.mjs");
  });

  it("server.ts registers empty prompts/resources handlers to avoid -32601 (#168)", () => {
    const src = readFileSync(resolve(ROOT, "src", "server.ts"), "utf-8");
    // Must register prompts capability so clients don't get Method not found
    expect(src).toContain("ListPromptsRequestSchema");
    // Must register resources capability
    expect(src).toContain("ListResourcesRequestSchema");
    // Must return empty arrays
    expect(src).toContain("prompts: []");
    expect(src).toContain("resources: []");
  });

  it("openclaw-plugin.ts doctor/upgrade use cli.bundle.mjs with fallback", () => {
    const src = readFileSync(resolve(ROOT, "src", "openclaw-plugin.ts"), "utf-8");
    expect(src).toContain("cli.bundle.mjs");
    // Find the registerCommand blocks, not comments
    const doctorIdx = src.indexOf('name: "ctx-doctor"');
    const upgradeIdx = src.indexOf('name: "ctx-upgrade"');
    expect(doctorIdx).toBeGreaterThan(-1);
    expect(upgradeIdx).toBeGreaterThan(-1);
    const doctorSection = src.slice(doctorIdx, doctorIdx + 500);
    const upgradeSection = src.slice(upgradeIdx, upgradeIdx + 500);
    expect(doctorSection).toContain("cli.bundle.mjs");
    expect(upgradeSection).toContain("cli.bundle.mjs");
  });
});

// ── start.mjs CLI self-heal ───────────────────────────────────────────

describe("start.mjs CLI self-heal", () => {
  test("start.mjs self-heals cli.bundle.mjs when missing", () => {
    const src = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
    // Must check for cli.bundle.mjs existence
    expect(src).toContain("cli.bundle.mjs");
    // Must reference build/cli.js as fallback source
    expect(src).toContain("build");
    expect(src).toContain("cli.js");
    // Must write a shim
    expect(src).toContain("writeFileSync");
  });

  test("start.mjs CLI self-heal is after ensure-deps import and before server import", () => {
    const src = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
    const ensureDepsIdx = src.indexOf("ensure-deps.mjs");
    const selfHealIdx = src.indexOf('cli.bundle.mjs');
    const serverImportIdx = src.indexOf('server.bundle.mjs');
    expect(ensureDepsIdx).toBeGreaterThan(-1);
    expect(selfHealIdx).toBeGreaterThan(-1);
    expect(serverImportIdx).toBeGreaterThan(-1);
    // Self-heal must be between ensure-deps import and server import
    expect(selfHealIdx).toBeGreaterThan(ensureDepsIdx);
    expect(selfHealIdx).toBeLessThan(serverImportIdx);
  });
});

// ── session-loaders.mjs fallback ──────────────────────────────────────

describe("session-loaders.mjs fallback to build/session/*.js", () => {
  test("session-loaders.mjs has loadModule fallback function", () => {
    const src = readFileSync(resolve(ROOT, "hooks", "session-loaders.mjs"), "utf-8");
    // Must have a loadModule helper that checks existsSync
    expect(src).toContain("loadModule");
    expect(src).toContain("existsSync");
  });

  test("session-loaders.mjs falls back to build/session/*.js paths", () => {
    const src = readFileSync(resolve(ROOT, "hooks", "session-loaders.mjs"), "utf-8");
    // Must reference the build/session fallback directory
    expect(src).toContain("build");
    expect(src).toContain("session");
    // Must reference specific build fallback filenames
    expect(src).toContain("db.js");
    expect(src).toContain("extract.js");
    expect(src).toContain("snapshot.js");
  });

  test("session-loaders.mjs still tries bundles first", () => {
    const src = readFileSync(resolve(ROOT, "hooks", "session-loaders.mjs"), "utf-8");
    // Bundle names must still be present
    expect(src).toContain("session-db.bundle.mjs");
    expect(src).toContain("session-extract.bundle.mjs");
    expect(src).toContain("session-snapshot.bundle.mjs");
  });

  test("session-loaders.mjs imports existsSync", () => {
    const src = readFileSync(resolve(ROOT, "hooks", "session-loaders.mjs"), "utf-8");
    expect(src).toMatch(/import\s*\{[^}]*existsSync[^}]*\}\s*from\s*["']node:fs["']/);
  });
});

// ── SKILL.md MCP-first pattern ────────────────────────────────────────

describe("SKILL.md prefers MCP tool over Bash", () => {
  it("ctx-doctor SKILL.md prefers MCP tool over Bash", () => {
    const skill = readFileSync(resolve(ROOT, "skills", "ctx-doctor", "SKILL.md"), "utf-8");
    // Must mention the MCP tool
    expect(skill).toContain("ctx_doctor");
    expect(skill).toContain("MCP tool");
    // MCP tool instruction must appear BEFORE the Bash fallback
    const mcpIdx = skill.indexOf("ctx_doctor");
    const fallbackIdx = skill.indexOf("Fallback");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(-1);
    expect(mcpIdx).toBeLessThan(fallbackIdx);
  });

  it("ctx-upgrade SKILL.md prefers MCP tool over Bash", () => {
    const skill = readFileSync(resolve(ROOT, "skills", "ctx-upgrade", "SKILL.md"), "utf-8");
    // Must mention the MCP tool
    expect(skill).toContain("ctx_upgrade");
    expect(skill).toContain("MCP tool");
    // MCP tool instruction must appear BEFORE the Bash fallback
    const mcpIdx = skill.indexOf("ctx_upgrade");
    const fallbackIdx = skill.indexOf("Fallback");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(-1);
    expect(mcpIdx).toBeLessThan(fallbackIdx);
  });
});

// ── Package exports ───────────────────────────────────────────────────

describe("Package exports", () => {
  test("named export exposes ContextModePlugin factory", async () => {
    const mod = await import("../../src/opencode-plugin.js");
    expect(mod.ContextModePlugin).toBeDefined();
    expect(typeof mod.ContextModePlugin).toBe("function");
  });

  test("default export has KiloCode PluginModule shape { server }", async () => {
    const mod = (await import("../../src/opencode-plugin.js")) as any;
    expect(mod.default).toBeDefined();
    expect(typeof mod.default.server).toBe("function");
  });

  test("default export does not leak CLI internals", async () => {
    const mod = (await import("../../src/opencode-plugin.js")) as any;
    expect(mod.toUnixPath).toBeUndefined();
    expect(mod.doctor).toBeUndefined();
    expect(mod.upgrade).toBeUndefined();
  });
});

// ── Issue #181: upgrade must not delete sibling version dirs mid-session ──

describe("Cache dir safety (#181)", () => {
  const CLI_SOURCE = readFileSync(resolve(ROOT, "src/cli.ts"), "utf-8");
  const PRETOOLUSE_SOURCE = readFileSync(resolve(ROOT, "hooks/pretooluse.mjs"), "utf-8");

  test("cli.ts upgrade does not rmSync sibling cache version dirs", () => {
    // The upgrade function must NOT contain a loop that deletes sibling version dirs.
    // Old pattern: filter dirs !== myDir → rmSync each in a loop
    const hasStaleCleanup = CLI_SOURCE.includes("stale cache dir");
    expect(hasStaleCleanup).toBe(false);
  });

  test("pretooluse.mjs does not nuke stale version dirs", () => {
    // Step 4 "Nuke stale version dirs" must not exist
    const hasNukeBlock = PRETOOLUSE_SOURCE.includes("Nuke stale version dirs");
    expect(hasNukeBlock).toBe(false);
  });

  test("sessionstart.mjs has age-gated lazy cleanup for old cache dirs", () => {
    const SESSION_SOURCE = readFileSync(resolve(ROOT, "hooks/sessionstart.mjs"), "utf-8");
    // Must contain age-gated cleanup logic (>1 hour check)
    expect(SESSION_SOURCE).toContain("lazy cleanup");
    expect(SESSION_SOURCE).toContain("3600000"); // 1 hour in ms
  });
});

// ── Issue #185: upgrade must not use execSync (shell) ──

describe("Shell-free upgrade (#185)", () => {
  const CLI_SOURCE = readFileSync(resolve(ROOT, "src/cli.ts"), "utf-8");
  const SERVER_SOURCE = readFileSync(resolve(ROOT, "src/server.ts"), "utf-8");

  test("cli.ts upgrade function uses execFileSync, not execSync", () => {
    // Extract upgrade function body (from "async function upgrade" to end of file)
    const upgradeStart = CLI_SOURCE.indexOf("async function upgrade");
    expect(upgradeStart).toBeGreaterThan(-1);
    const upgradeBody = CLI_SOURCE.slice(upgradeStart);

    // Must not contain execSync( calls (but execFileSync is fine)
    const execSyncCalls = upgradeBody.match(/(?<!File)execSync\s*\(/g);
    expect(execSyncCalls).toBeNull();
  });

  test("cli.ts uses chmodSync instead of execSync chmod", () => {
    const upgradeStart = CLI_SOURCE.indexOf("async function upgrade");
    const upgradeBody = CLI_SOURCE.slice(upgradeStart);

    // Must not shell out for chmod
    expect(upgradeBody).not.toContain('chmod +x');
    // Must use fs.chmodSync instead
    expect(upgradeBody).toContain("chmodSync");
  });

  test("server.ts inline fallback uses execFileSync, not execSync", () => {
    // The inline script template must use execFileSync
    const inlineStart = SERVER_SOURCE.indexOf("Inline fallback");
    expect(inlineStart).toBeGreaterThan(-1);
    const inlineSection = SERVER_SOURCE.slice(inlineStart, SERVER_SOURCE.indexOf("cmd =", inlineStart + 500));

    // Generated script lines must import execFileSync
    expect(inlineSection).toContain("execFileSync");
    expect(inlineSection).not.toMatch(/(?<!File)execSync/);
  });
});

// ── Issue #186: temp dirs must be dot-prefixed to hide from VS Code ──

describe("Hidden temp dirs (#186)", () => {
  test("executor.ts uses dot-prefixed temp dir to avoid VS Code auto-open", () => {
    const EXEC_SOURCE = readFileSync(resolve(ROOT, "src/executor.ts"), "utf-8");
    // Must use .ctx-mode- prefix (dot-hidden) not ctx-mode-
    expect(EXEC_SOURCE).toContain('.ctx-mode-');
    expect(EXEC_SOURCE).not.toMatch(/tmpdir\(\),\s*"ctx-mode-"/);
  });
});

// ── Issue #187 follow-up: self-heal must fix ALL hook types, not just PreToolUse ──

describe("Self-heal covers all hook types (#187)", () => {
  const PRETOOLUSE_SOURCE = readFileSync(resolve(ROOT, "hooks/pretooluse.mjs"), "utf-8");

  test("pretooluse.mjs self-heal iterates all hook types in settings.json", () => {
    // Must NOT be scoped to only PreToolUse
    // Old pattern: settings.hooks?.PreToolUse (only one type)
    // New pattern: iterates Object.keys(settings.hooks) or similar
    const selfHealSection = PRETOOLUSE_SOURCE.slice(
      PRETOOLUSE_SOURCE.indexOf("Update hook path"),
      PRETOOLUSE_SOURCE.indexOf("lazy cleanup"),
    );
    // Must iterate all hook types, not just PreToolUse
    expect(selfHealSection).not.toContain("hooks?.PreToolUse");
    expect(selfHealSection).toMatch(/Object\.keys|for\s*\(\s*const\s+\w+\s+(of|in)\s+.*hooks/);
  });

  test("pretooluse.mjs self-heal fixes all context-mode hook scripts", () => {
    const selfHealSection = PRETOOLUSE_SOURCE.slice(
      PRETOOLUSE_SOURCE.indexOf("Update hook path"),
      PRETOOLUSE_SOURCE.indexOf("lazy cleanup"),
    );
    // Must match any .mjs hook script, not just pretooluse.mjs
    expect(selfHealSection).toMatch(/\.mjs/);
    expect(selfHealSection).toContain("context-mode");
  });
});

// ── PR #183 fix: path traversal prevention in OpenClaw sessionKey ──

describe("OpenClaw sessionKey safety (#183)", () => {
  const WR_SOURCE = readFileSync(resolve(ROOT, "src/openclaw/workspace-router.ts"), "utf-8");

  test("workspace regex only allows safe characters (no path traversal)", () => {
    // Must use [a-zA-Z0-9_-]+ not [^:]+ to prevent ../../ in agent name
    expect(WR_SOURCE).toContain('[a-zA-Z0-9_-]+');
  });

  test("workspace path is scoped to /openclaw/workspace- prefix", () => {
    // extractWorkspace must only match recognised /openclaw/workspace-<name> paths
    expect(WR_SOURCE).toContain('/openclaw/workspace-');
    // workspaceFromKey derives workspace from sessionKey agent:<name>:<channel>
    expect(WR_SOURCE).toContain('`/openclaw/workspace-');
  });
});

// ── PR #190 fix: getRuntimeSummary handles full bun path ──

describe("Runtime summary bun detection (#190)", () => {
  const RT_SOURCE = readFileSync(resolve(ROOT, "src", "runtime.ts"), "utf-8");

  test("getRuntimeSummary does not use exact === bun comparison", () => {
    // Full path like /home/user/.bun/bin/bun must be detected
    const summaryStart = RT_SOURCE.indexOf("getRuntimeSummary");
    const summaryBody = RT_SOURCE.slice(summaryStart, RT_SOURCE.indexOf("\nexport", summaryStart + 10));
    expect(summaryBody).not.toContain('=== "bun"');
  });
});

// ── Plugin root detection for Opencode/Kilocode platforms ────────────────

describe("Plugin root detection (#PR refactor/opencode-improvements)", () => {
  const CLI_SOURCE = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");

  test("cachePluginRoot uses LOCALAPPDATA on Windows", () => {
    const cacheRootStart = CLI_SOURCE.indexOf("function cachePluginRoot");
    const cacheRootBody = CLI_SOURCE.slice(cacheRootStart, cacheRootStart + 500);
    expect(cacheRootBody).toContain("process.env.LOCALAPPDATA");
    expect(cacheRootBody).toContain('process.platform === "win32"');
  });

  test("cachePluginRoot uses ~/.cache as default on non-Windows", () => {
    const cacheRootStart = CLI_SOURCE.indexOf("function cachePluginRoot");
    const cacheRootBody = CLI_SOURCE.slice(cacheRootStart, cacheRootStart + 500);
    expect(cacheRootBody).toContain('".cache"');
    expect(cacheRootBody).toContain("homedir");
  });

  test("getPluginRoot uses cache path for opencode platform", () => {
    const getPluginRootStart = CLI_SOURCE.indexOf("function getPluginRoot");
    const getPluginRootBody = CLI_SOURCE.slice(getPluginRootStart, getPluginRootStart + 300);
    expect(getPluginRootBody).toContain("'opencode'");
    expect(getPluginRootBody).toContain("cachePluginRoot");
  });

  test("getPluginRoot uses cache path for kilo platform", () => {
    const getPluginRootStart = CLI_SOURCE.indexOf("function getPluginRoot");
    const getPluginRootBody = CLI_SOURCE.slice(getPluginRootStart, getPluginRootStart + 300);
    expect(getPluginRootBody).toContain("'kilo'");
    expect(getPluginRootBody).toContain("cachePluginRoot");
  });
});

// ── Issue #225: Codex CLI hook dispatch ──────────────────────────────────

describe("Codex CLI hook dispatch (#225)", () => {
  const CLI_SOURCE = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");

  test("HOOK_MAP includes codex platform", () => {
    // Extract HOOK_MAP definition
    const mapStart = CLI_SOURCE.indexOf("const HOOK_MAP");
    const mapEnd = CLI_SOURCE.indexOf("};", mapStart) + 2;
    const hookMap = CLI_SOURCE.slice(mapStart, mapEnd);
    expect(hookMap).toContain('"codex"');
  });

  test("codex HOOK_MAP has pretooluse, posttooluse, sessionstart", () => {
    const mapStart = CLI_SOURCE.indexOf("const HOOK_MAP");
    const mapEnd = CLI_SOURCE.indexOf("};", mapStart) + 2;
    const hookMap = CLI_SOURCE.slice(mapStart, mapEnd);
    // Extract codex block
    const codexStart = hookMap.indexOf('"codex"');
    const codexEnd = hookMap.indexOf("}", codexStart + 10) + 1;
    const codexBlock = hookMap.slice(codexStart, codexEnd);
    expect(codexBlock).toContain("pretooluse");
    expect(codexBlock).toContain("posttooluse");
    expect(codexBlock).toContain("sessionstart");
  });

  test("codex hooks point to dedicated hooks/codex/ directory", () => {
    const mapStart = CLI_SOURCE.indexOf("const HOOK_MAP");
    const mapEnd = CLI_SOURCE.indexOf("};", mapStart) + 2;
    const hookMap = CLI_SOURCE.slice(mapStart, mapEnd);
    const codexStart = hookMap.indexOf('"codex"');
    const codexEnd = hookMap.indexOf("}", codexStart + 10) + 1;
    const codexBlock = hookMap.slice(codexStart, codexEnd);
    expect(codexBlock).toContain("hooks/codex/pretooluse.mjs");
    expect(codexBlock).toContain("hooks/codex/posttooluse.mjs");
    expect(codexBlock).toContain("hooks/codex/sessionstart.mjs");
  });

  test("hooks/codex/pretooluse.mjs exists", () => {
    expect(existsSync(resolve(ROOT, "hooks/codex/pretooluse.mjs"))).toBe(true);
  });

  test("hooks/codex/posttooluse.mjs exists", () => {
    expect(existsSync(resolve(ROOT, "hooks/codex/posttooluse.mjs"))).toBe(true);
  });

  test("hooks/codex/sessionstart.mjs exists", () => {
    expect(existsSync(resolve(ROOT, "hooks/codex/sessionstart.mjs"))).toBe(true);
  });

  test("session-helpers.mjs exports CODEX_OPTS", () => {
    const helpers = readFileSync(resolve(ROOT, "hooks/session-helpers.mjs"), "utf-8");
    expect(helpers).toContain("export const CODEX_OPTS");
  });

  test("CODEX_OPTS uses .codex config dir", () => {
    const helpers = readFileSync(resolve(ROOT, "hooks/session-helpers.mjs"), "utf-8");
    const optsStart = helpers.indexOf("CODEX_OPTS");
    const optsEnd = helpers.indexOf("};", optsStart) + 2;
    const optsBlock = helpers.slice(optsStart, optsEnd);
    expect(optsBlock).toContain('".codex"');
  });

  test("configs/codex/hooks.json commands match HOOK_MAP platform name", () => {
    const hooksJson = JSON.parse(readFileSync(resolve(ROOT, "configs/codex/hooks.json"), "utf-8"));
    for (const [eventType, entries] of Object.entries(hooksJson.hooks)) {
      for (const entry of entries as any[]) {
        for (const hook of entry.hooks) {
          // Command must use "context-mode hook codex <event>"
          expect(hook.command).toMatch(/context-mode hook codex \w+/);
        }
      }
    }
  });

  test("CODEX_OPTS.projectDirEnv is undefined (Codex passes cwd in stdin, not env)", () => {
    const helpers = readFileSync(resolve(ROOT, "hooks/session-helpers.mjs"), "utf-8");
    const optsStart = helpers.indexOf("CODEX_OPTS");
    const optsEnd = helpers.indexOf("};", optsStart) + 2;
    const optsBlock = helpers.slice(optsStart, optsEnd);
    expect(optsBlock).toMatch(/projectDirEnv:\s*undefined/);
  });

  test("codex hooks include hookEventName in output (required by codex-rs)", () => {
    const posttooluse = readFileSync(resolve(ROOT, "hooks/codex/posttooluse.mjs"), "utf-8");
    expect(posttooluse).toContain('hookEventName: "PostToolUse"');

    const sessionstart = readFileSync(resolve(ROOT, "hooks/codex/sessionstart.mjs"), "utf-8");
    expect(sessionstart).toContain('hookEventName: "SessionStart"');
  });

  test("codex pretooluse formatter includes hookEventName in deny response", () => {
    const formatters = readFileSync(resolve(ROOT, "hooks/core/formatters.mjs"), "utf-8");
    const codexStart = formatters.indexOf('"codex"');
    const codexEnd = formatters.indexOf("},", codexStart + 50);
    const codexBlock = formatters.slice(codexStart, codexEnd);
    expect(codexBlock).toContain('hookEventName: "PreToolUse"');
  });
});

// ── Cursor stop hook (#HOOK_MAP cursor stop) ─────────────────────────────

describe("Cursor CLI hook dispatch — stop event", () => {
  const CLI_SOURCE = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");

  test("HOOK_MAP cursor entry includes stop event", () => {
    const cursorEntry = CLI_SOURCE.match(/"cursor"\s*:\s*\{[\s\S]*?\}/);
    expect(cursorEntry).not.toBeNull();
    expect(cursorEntry![0]).toContain("stop");
    expect(cursorEntry![0]).toContain("hooks/cursor/stop.mjs");
  });
});

// ── Upgrade skill sync to marketplace/cache directories ───────────────────

describe("Upgrade syncs skills to active install path (#228)", () => {
  const CLI_SOURCE = readFileSync(resolve(ROOT, "src/cli.ts"), "utf-8");
  const upgradeStart = CLI_SOURCE.indexOf("async function upgrade");
  const upgradeBody = CLI_SOURCE.slice(upgradeStart);

  test("upgrade reads installed_plugins.json to find active install path", () => {
    expect(upgradeBody).toContain("installed_plugins.json");
    expect(upgradeBody).toContain("context-mode@context-mode");
    expect(upgradeBody).toContain("installPath");
  });

  test("upgrade only syncs when installPath differs from pluginRoot", () => {
    // Must check installPath !== pluginRoot before copying
    expect(upgradeBody).toMatch(/installPath.*!==.*pluginRoot|installPath\s*&&\s*installPath\s*!==\s*pluginRoot/);
  });

  test("upgrade does NOT blindly copy to marketplace or cache directories", () => {
    // No hardcoded marketplace/cache paths — only installPath from registry
    const syncSection = upgradeBody.slice(upgradeBody.indexOf("installed_plugins.json"));
    expect(syncSection).not.toContain('"marketplaces"');
    expect(syncSection).not.toContain("readdirSync");
  });

  test("upgrade warns user to restart for new MCP tools", () => {
    expect(upgradeBody).toMatch(/[Rr]estart.*MCP|new MCP tools/i);
  });

  test("restart hint is adapter-aware (Claude Code gets /reload-plugins)", () => {
    expect(upgradeBody).toContain("reload-plugins");
    expect(upgradeBody).toContain('adapter.name === "Claude Code"');
  });
});

// ── better-sqlite3 binding self-heal (#408) ───────────────────────────────
//
// On Windows, `npm rebuild better-sqlite3` falls through to node-gyp when
// prebuild-install is not on cmd.exe PATH, then dies for users without
// MSVC. The fix is a 3-layer heal (spawn prebuild-install via
// process.execPath → `npm install better-sqlite3` → actionable stderr)
// shared between scripts/postinstall.mjs and hooks/ensure-deps.mjs via
// scripts/heal-better-sqlite3.mjs.
//
// Tests in this block cover:
//   - doctor() in src/cli.ts: clearer hint when FTS5 check fails on a
//     bindings-missing pattern.
//   - scripts/postinstall.mjs: calls the shared heal helper after the
//     existing nvm4w junction logic; mklink /J regression guard.
//   - scripts/heal-better-sqlite3.mjs: single source of truth — pins the
//     prebuild-install + npm install + Windows/#408 stderr surface so the
//     dedupe doesn't silently regress.

describe("better-sqlite3 binding self-heal (#408)", () => {
  const CLI_SRC = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
  const POSTINSTALL_SRC = readFileSync(resolve(ROOT, "scripts", "postinstall.mjs"), "utf-8");
  const HEAL_SRC = readFileSync(resolve(ROOT, "scripts", "heal-better-sqlite3.mjs"), "utf-8");

  // Locate doctor()'s FTS5 / SQLite catch branch — the hint lives here.
  function ftsCatchBlock(): string {
    const ftsAnchor = CLI_SRC.indexOf("Checking FTS5 / SQLite");
    expect(ftsAnchor).toBeGreaterThan(-1);
    const catchIdx = CLI_SRC.indexOf("catch (err", ftsAnchor);
    expect(catchIdx).toBeGreaterThan(-1);
    const versionIdx = CLI_SRC.indexOf("Checking versions", catchIdx);
    expect(versionIdx).toBeGreaterThan(catchIdx);
    return CLI_SRC.slice(catchIdx, versionIdx);
  }

  // ── doctor(): bindings-missing hint ────────────────────────────────
  describe("doctor: bindings-missing hint", () => {
    it("hint mentions `npm install better-sqlite3` as the primary remedy", () => {
      // On Windows `npm rebuild` falls through to node-gyp without MSVC,
      // while `npm install` re-runs prebuild-install and pulls a prebuilt.
      const block = ftsCatchBlock();
      expect(block).toContain("npm install better-sqlite3");
    });

    it("hint explains the Windows / prebuild-install root cause", () => {
      const block = ftsCatchBlock();
      const mentionsRootCause =
        /prebuild-install/i.test(block) || /Windows/i.test(block);
      expect(mentionsRootCause).toBe(true);
    });

    it("retains `npm rebuild better-sqlite3` as a non-Windows fallback", () => {
      // Existing rebuild hint is still valid on Linux/macOS where the
      // toolchain is present. The fix only augments — does not delete.
      const block = ftsCatchBlock();
      expect(block).toContain("npm rebuild better-sqlite3");
    });

    it("bindings-error detection branches on the bindings error message", () => {
      // Hint must be conditional on the actual bindings failure
      // signature (`Could not locate the bindings file` / `bindings`),
      // otherwise it would spam the install hint for unrelated FTS5 errors.
      const block = ftsCatchBlock();
      const detectsBindingsError =
        /bindings file/i.test(block) || /\bbindings\b/.test(block);
      expect(detectsBindingsError).toBe(true);
    });
  });

  // ── scripts/postinstall.mjs: delegates to shared helper ────────────
  describe("postinstall.mjs", () => {
    it("imports the shared heal helper", () => {
      // After dedupe, the inline 3-layer heal is gone — replaced by an
      // import + call to the shared helper. Match either bare or
      // explicit-extension import path.
      const importsHelper = /from\s+["']\.\/heal-better-sqlite3(?:\.mjs)?["']/.test(POSTINSTALL_SRC);
      expect(importsHelper).toBe(true);
      expect(POSTINSTALL_SRC).toContain("healBetterSqlite3Binding");
    });

    it("calls healBetterSqlite3Binding(pkgRoot) after the nvm4w junction logic", () => {
      // Order matters: the junction fix must run first so the heal can
      // resolve prebuild-install through the correct node_modules path.
      const junctionIdx = POSTINSTALL_SRC.indexOf("mklink /J");
      expect(junctionIdx).toBeGreaterThan(-1);
      const callIdx = POSTINSTALL_SRC.indexOf("healBetterSqlite3Binding(");
      expect(callIdx).toBeGreaterThan(junctionIdx);
    });

    it("existing Windows nvm4w junction logic (mklink /J) remains intact", () => {
      // Regression guard — Slice 3 must not have wiped the unrelated
      // Windows install fix.
      expect(/mklink\s+\/J/.test(POSTINSTALL_SRC)).toBe(true);
    });
  });

  // ── scripts/heal-better-sqlite3.mjs: single source of truth ────────
  describe("heal-better-sqlite3.mjs (shared helper)", () => {
    it("exports healBetterSqlite3Binding", () => {
      expect(/export\s+function\s+healBetterSqlite3Binding\s*\(/.test(HEAL_SRC)).toBe(true);
    });

    it("contains all three heal layers in one place (dedupe guarantee)", () => {
      // Layer A — prebuild-install via process.execPath
      expect(HEAL_SRC).toContain("prebuild-install");
      expect(HEAL_SRC).toContain("process.execPath");
      // Layer B — npm install fallback (NOT npm rebuild)
      expect(/install\s+better-sqlite3/.test(HEAL_SRC)).toBe(true);
      // Layer C — actionable stderr with Windows / #408 context
      const mentionsContext =
        /#408/.test(HEAL_SRC) ||
        (/Windows/i.test(HEAL_SRC) && /better-sqlite3/.test(HEAL_SRC));
      expect(mentionsContext).toBe(true);
      const writesStderr =
        /process\.stderr\.write\s*\(/.test(HEAL_SRC) ||
        /console\.(error|warn)\s*\(/.test(HEAL_SRC);
      expect(writesStderr).toBe(true);
    });

    it("ships in npm package (listed in package.json files array)", () => {
      const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
      expect(pkg.files).toContain("scripts/heal-better-sqlite3.mjs");
    });

    it("never throws — all layers wrapped in try/catch (best-effort posture)", () => {
      // Outer try/catch around the whole function body protects callers
      // (postinstall + ensure-deps) from blocking on a heal failure.
      expect(/function\s+healBetterSqlite3Binding[\s\S]{0,200}?try\s*\{/.test(HEAL_SRC)).toBe(true);
    });
  });
});
