/**
 * src/util/atomic-fs — atomic JSON write contract.
 *
 * Verifies the tmp+rename strategy used by every shared-JSON writer in the
 * project (adapters, scripts, CLI). The atomic guarantee that matters is:
 * a concurrent reader sees either the old contents or the new contents,
 * never a half-flushed truncated JSON.
 *
 * Coverage:
 *   - Happy path (encoding + mode bits round-trip)
 *   - EXDEV fallback (mock renameSync to throw EXDEV)
 *   - Concurrent writers via child_process.fork (two children racing; final
 *     payload parses cleanly and equals exactly one of the inputs)
 *   - Stale `.tmp.*` cleanup via process.on("exit")
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import { atomicWriteFileSync } from "../../src/util/atomic-fs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const HELPER_TS = join(REPO_ROOT, "src", "util", "atomic-fs.ts");
const TSX_LOADER = "tsx/esm";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "ctx-atomic-fs-"));
});

afterEach(() => {
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function runScript(scriptBody: string, args: string[] = []): Promise<void> {
  const script = join(workDir, `fork-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(script, scriptBody);
  return new Promise((resolve, reject) => {
    const child = fork(script, args, {
      execArgv: ["--import", TSX_LOADER],
      stdio: "ignore",
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`script exit ${code}`)),
    );
    child.on("error", reject);
  });
}

describe("atomicWriteFileSync — happy path", () => {
  it("writes the exact string content with default utf-8 encoding", () => {
    const target = join(workDir, "config.json");
    const content = JSON.stringify({ hello: "мир" }, null, 2) + "\n";

    atomicWriteFileSync(target, content);

    expect(readFileSync(target, "utf-8")).toBe(content);
  });

  it("honors explicit encoding option", () => {
    const target = join(workDir, "ascii.json");
    const content = '{"a":1}';

    atomicWriteFileSync(target, content, { encoding: "utf-8" });

    expect(readFileSync(target, "utf-8")).toBe(content);
  });

  it("accepts Buffer content", () => {
    const target = join(workDir, "binary.bin");
    const buf = Buffer.from([0x00, 0xff, 0x42, 0x10]);

    atomicWriteFileSync(target, buf);

    const read = readFileSync(target);
    expect(read.equals(buf)).toBe(true);
  });

  it("applies mode bits when specified", () => {
    const target = join(workDir, "exec.sh");
    atomicWriteFileSync(target, "#!/bin/sh\necho hi\n", { mode: 0o755 });

    // chmod is meaningless on Windows; only assert on POSIX.
    if (process.platform !== "win32") {
      const mode = statSync(target).mode & 0o777;
      expect(mode).toBe(0o755);
    }
  });

  it("overwrites existing file atomically (no merge, no append)", () => {
    const target = join(workDir, "config.json");
    writeFileSync(target, '{"old":true}\n', "utf-8");
    atomicWriteFileSync(target, '{"new":true}\n');
    expect(readFileSync(target, "utf-8")).toBe('{"new":true}\n');
  });

  it("does not leave .tmp.* files in the target dir on success", () => {
    const target = join(workDir, "leak-check.json");
    atomicWriteFileSync(target, '{"ok":1}');

    const leftover = readdirSync(workDir).filter((n) => n.startsWith(".tmp."));
    expect(leftover).toEqual([]);
  });
});

describe("atomicWriteFileSync — EXDEV fallback", () => {
  // Subprocess-based simulation: a wrapper script preloads a patched
  // `node:fs` (via internal --require) so the helper's import sees the
  // patched `renameSync` from the start. vitest can't `vi.spyOn` frozen
  // ESM namespaces, so we cannot run this in-process.
  it("falls back to writeFileSync, emits stderr warning, file still written", () => {
    const target = join(workDir, "exdev.json");
    // CJS preload — runs before any ESM import, patches the live
    // exports object of node:fs (which IS mutable inside the V8 builtin
    // module; ESM's namespace freeze is a *view*, not the underlying data).
    const preload = join(workDir, "preload.cjs");
    writeFileSync(
      preload,
      `
const fs = require("fs");
fs.renameSync = function () {
  const err = new Error("EXDEV simulated");
  err.code = "EXDEV";
  throw err;
};
`.trim(),
    );
    const wrapper = join(workDir, "exdev-wrapper.mjs");
    writeFileSync(
      wrapper,
      `
const { atomicWriteFileSync } = await import(${JSON.stringify(HELPER_TS)});
let warning = "";
const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk) => { warning += String(chunk); return true; };
atomicWriteFileSync(${JSON.stringify(target)}, JSON.stringify({ ok: true }));
process.stderr.write = origWrite;
process.stdout.write(JSON.stringify({ warning }));
`.trim(),
    );
    const result = spawnSync(
      process.execPath,
      ["--require", preload, "--import", TSX_LOADER, wrapper],
      { encoding: "utf-8" },
    );
    if (result.status !== 0) {
      throw new Error(`subprocess failed (${result.status}): ${result.stderr}`);
    }
    const parsed = JSON.parse(result.stdout) as { warning: string };
    expect(parsed.warning).toMatch(/EXDEV/);
    expect(readFileSync(target, "utf-8")).toBe('{"ok":true}');
  });
});

describe("atomicWriteFileSync — concurrent writers", () => {
  it("two concurrent fork() writers produce parseable JSON equal to one of the two payloads", async () => {
    const target = join(workDir, "race.json");
    const payloadA = JSON.stringify({ writer: "A", iteration: 1 }, null, 2);
    const payloadB = JSON.stringify({ writer: "B", iteration: 2 }, null, 2);
    const workerBody = `
import { atomicWriteFileSync } from ${JSON.stringify(HELPER_TS)};
const [target, payload] = process.argv.slice(2);
for (let i = 0; i < 50; i++) atomicWriteFileSync(target, payload);
process.exit(0);
`.trim();

    await Promise.all([
      runScript(workerBody, [target, payloadA]),
      runScript(workerBody, [target, payloadB]),
    ]);

    // The final contents MUST be valid JSON and MUST equal one of the two
    // payloads — never an interleaved torn write.
    const final = readFileSync(target, "utf-8");
    expect(() => JSON.parse(final)).not.toThrow();
    expect([payloadA, payloadB]).toContain(final);

    // No stale .tmp.* files should remain (exit handler must have cleaned up).
    const leftover = readdirSync(workDir).filter((n) => n.startsWith(".tmp."));
    expect(leftover).toEqual([]);
  }, 20_000);
});

describe("atomicWriteFileSync — stale tmp cleanup at exit", () => {
  it("removes .tmp.* artefacts when a child process exits cleanly", async () => {
    // Pre-seed the target dir with a stale tmp file as if a prior crash left it.
    const fakeStale = join(workDir, ".tmp.config.json.stale-marker");
    writeFileSync(fakeStale, "leftover");
    expect(existsSync(fakeStale)).toBe(true);

    const target = join(workDir, "config.json");
    await runScript(
      `
import { atomicWriteFileSync } from ${JSON.stringify(HELPER_TS)};
atomicWriteFileSync(${JSON.stringify(target)}, '{"ok":1}');
process.exit(0);
`.trim(),
    );

    const remaining = readdirSync(workDir).filter((n) => n.startsWith(".tmp."));
    expect(remaining).toEqual([]);
    expect(readFileSync(target, "utf-8")).toBe('{"ok":1}');
  }, 15_000);
});
