/**
 * atomic-fs — torn-write protection for shared JSON config files.
 *
 * Covers the helper in hooks/util/atomic-fs.mjs that wraps
 * writeFileSync(tmp) + renameSync(tmp, finalPath), so concurrent MCP
 * + hook writers can't leave a half-truncated file on disk. See callers
 * in start.mjs, hooks/normalize-hooks.mjs, hooks/pretooluse.mjs,
 * hooks/cache-heal-utils.mjs.
 *
 * Slices:
 *   1. Happy path — write → readback identical, mode preserved.
 *   2. EXDEV fallback — when rename is cross-mount, fall back to plain
 *      writeFileSync with a console.error warning.
 *   3. Concurrent writers — two forked subprocesses write distinct
 *      payloads to the same path; final state is exactly one of them,
 *      no torn JSON.
 *   4. Cleanup of stale tmps — a fork registers a target, helper runs,
 *      pre-seeded stale `.tmp.*` sibling is cleaned on exit.
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { fork } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error — JS module, no TS declarations
import { atomicWriteFileSync, trackForCleanup } from "../../hooks/util/atomic-fs.mjs";

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
});

function makeTmp(prefix = "ctx-atomic-fs-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = resolve(__dirname, "..", "..", "hooks", "util", "atomic-fs.mjs");

// ─────────────────────────────────────────────────────────────────────────
// Slice 1 — happy path
// ─────────────────────────────────────────────────────────────────────────

describe("atomicWriteFileSync — happy path", () => {
  test("writes content and re-reads identical bytes", () => {
    const dir = makeTmp();
    const target = join(dir, "config.json");
    const payload = JSON.stringify({ hello: "world", n: 42 }, null, 2) + "\n";

    atomicWriteFileSync(target, payload);

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe(payload);
  });

  test("applies mode when provided", () => {
    const dir = makeTmp();
    const target = join(dir, "script.mjs");
    atomicWriteFileSync(target, "#!/usr/bin/env node\n", { mode: 0o755 });

    expect(existsSync(target)).toBe(true);
    const mode = statSync(target).mode & 0o777;
    // Skip exact-mode assertion on Windows where chmod is best-effort.
    if (process.platform !== "win32") {
      expect(mode).toBe(0o755);
    }
  });

  test("overwrites an existing file in place", () => {
    const dir = makeTmp();
    const target = join(dir, "config.json");
    writeFileSync(target, "old", "utf-8");

    atomicWriteFileSync(target, "new");

    expect(readFileSync(target, "utf-8")).toBe("new");
  });

  test("leaves no .tmp.* siblings behind on the happy path", () => {
    const dir = makeTmp();
    const target = join(dir, "config.json");

    atomicWriteFileSync(target, "x");

    const leftover = readdirSync(dir).filter((n) => n.startsWith(".tmp."));
    expect(leftover).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 2 — EXDEV fallback
// ─────────────────────────────────────────────────────────────────────────

describe("atomicWriteFileSync — EXDEV fallback", () => {
  test("falls back to plain write when renameSync throws EXDEV", async () => {
    const dir = makeTmp();
    const target = join(dir, "config.json");

    // ESM bindings of node:fs are live: redefining a property on the
    // CJS-side `require("fs")` namespace BEFORE the helper's ESM
    // `import { renameSync } from "node:fs"` evaluates also rewires the
    // ESM binding (both share the same underlying module record). Drive
    // the EXDEV path by spawning a child Node process with a CJS preload
    // that swaps fs.renameSync to throw EXDEV on first call.
    const preloadScript = `
      const fs = require("fs");
      const realRename = fs.renameSync;
      let thrown = false;
      Object.defineProperty(fs, "renameSync", {
        configurable: true,
        get() {
          return function (a, b) {
            if (!thrown) {
              thrown = true;
              const err = new Error("EXDEV cross-device link not permitted");
              err.code = "EXDEV";
              throw err;
            }
            return realRename(a, b);
          };
        },
      });
    `;
    const preloadPath = join(dir, "preload-exdev.cjs");
    writeFileSync(preloadPath, preloadScript, "utf-8");

    const childScript = `
      let warned = false;
      console.error = (...args) => {
        const msg = args.map(String).join(" ");
        if (msg.includes("atomic-fs")) warned = true;
      };
      const { atomicWriteFileSync } = await import(${JSON.stringify(HELPER_PATH)});
      const { readFileSync, existsSync } = await import("node:fs");
      const target = process.argv[2];
      atomicWriteFileSync(target, "exdev-payload");
      process.stdout.write(JSON.stringify({
        warned,
        content: existsSync(target) ? readFileSync(target, "utf-8") : null,
      }));
    `;
    const scriptPath = join(dir, "child-exdev.mjs");
    writeFileSync(scriptPath, childScript, "utf-8");

    const targetPath = join(dir, "config.json");

    const result = await new Promise<{ warned: boolean; content: string | null }>((resolveP, rejectP) => {
      const child = fork(scriptPath, [targetPath], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        execArgv: ["--require", preloadPath],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (b) => (stdout += b.toString()));
      child.stderr?.on("data", (b) => (stderr += b.toString()));
      child.on("error", rejectP);
      child.on("exit", (code) => {
        if (code !== 0) {
          rejectP(new Error(`child exited ${code}; stderr=${stderr}`));
          return;
        }
        try {
          resolveP(JSON.parse(stdout));
        } catch (_e) {
          rejectP(new Error(`bad stdout: ${stdout}; stderr=${stderr}`));
        }
      });
    });

    expect(result.content).toBe("exdev-payload");
    expect(result.warned).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 3 — concurrent writers
// ─────────────────────────────────────────────────────────────────────────

describe("atomicWriteFileSync — concurrent writers", () => {
  test(
    "two forked writers produce no torn JSON; final state is one of them",
    async () => {
      const dir = makeTmp();
      const target = join(dir, "config.json");

      const childScript = `
        import { atomicWriteFileSync } from ${JSON.stringify(HELPER_PATH)};
        const target = process.argv[2];
        const label = process.argv[3];
        const iters = Number(process.argv[4]) || 50;
        for (let i = 0; i < iters; i++) {
          const payload = JSON.stringify({ writer: label, i, blob: "x".repeat(2048) }, null, 2) + "\\n";
          atomicWriteFileSync(target, payload);
        }
      `;
      const scriptPath = join(dir, "child-conc.mjs");
      writeFileSync(scriptPath, childScript, "utf-8");

      function runChild(label: string): Promise<void> {
        return new Promise((resolveP, rejectP) => {
          const child = fork(scriptPath, [target, label, "50"], {
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          });
          let stderr = "";
          child.stderr?.on("data", (b) => (stderr += b.toString()));
          child.on("error", rejectP);
          child.on("exit", (code) => {
            if (code !== 0) rejectP(new Error(`child ${label} exited ${code}; stderr=${stderr}`));
            else resolveP();
          });
        });
      }

      await Promise.all([runChild("alpha"), runChild("beta")]);

      // Final content must parse as JSON and match one of the two writers.
      const final = readFileSync(target, "utf-8");
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(final);
      }).not.toThrow();
      expect((parsed as { writer: string }).writer === "alpha" || (parsed as { writer: string }).writer === "beta").toBe(true);

      // No tmp leftovers from rename — happy path leaves the dir clean.
      // (Crashed writers may leave tmps, but graceful exits should not.)
      const leftover = readdirSync(dir).filter((n) => n.startsWith(".tmp."));
      expect(leftover).toEqual([]);
    },
    20_000,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 4 — stale .tmp.* cleanup on exit
// ─────────────────────────────────────────────────────────────────────────

describe("atomicWriteFileSync — stale tmp cleanup", () => {
  test(
    "process.on('exit') removes pre-existing stale .tmp.* siblings",
    async () => {
      const dir = makeTmp();
      const target = join(dir, "config.json");
      // Seed a stale tmp left over from a hypothetical previous crash.
      const stale = join(dir, ".tmp.config.json.deadbeefcafef00d");
      writeFileSync(stale, "stale", "utf-8");

      const childScript = `
        import { writeFileSync } from "node:fs";
        import { atomicWriteFileSync, trackForCleanup } from ${JSON.stringify(HELPER_PATH)};
        const target = process.argv[2];
        // Register the path so exit handler will scan its dir.
        trackForCleanup(target);
        atomicWriteFileSync(target, "ok");
        // Normal exit — process.on("exit") fires.
      `;
      const scriptPath = join(dir, "child-cleanup.mjs");
      writeFileSync(scriptPath, childScript, "utf-8");

      await new Promise<void>((resolveP, rejectP) => {
        const child = fork(scriptPath, [target], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
        let stderr = "";
        child.stderr?.on("data", (b) => (stderr += b.toString()));
        child.on("error", rejectP);
        child.on("exit", (code) => {
          if (code !== 0) rejectP(new Error(`child exited ${code}; stderr=${stderr}`));
          else resolveP();
        });
      });

      // Final file written.
      expect(readFileSync(target, "utf-8")).toBe("ok");
      // Stale tmp cleaned by exit handler.
      expect(existsSync(stale)).toBe(false);
      // And no new tmp leftovers.
      const leftover = readdirSync(dir).filter((n) => n.startsWith(".tmp."));
      expect(leftover).toEqual([]);
    },
    15_000,
  );

  test("trackForCleanup is idempotent and safe to call repeatedly", () => {
    // Just exercises the registration codepath without spawning.
    const dir = makeTmp();
    const target = join(dir, "x.json");
    expect(() => {
      trackForCleanup(target);
      trackForCleanup(target);
    }).not.toThrow();
  });
});
