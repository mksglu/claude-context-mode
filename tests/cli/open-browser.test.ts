/**
 * openInBrowser — shell-injection regression test
 *
 * Original implementation used `execSync(`open "${url}"`)` which shell-
 * interpolates the URL.  A URL like `http://localhost:1234?x=$(touch /tmp/pwned)`
 * would execute the embedded command on darwin/linux.  This test asserts
 * the URL is passed as a SINGLE argv element to `execFile` (no shell),
 * and that no side-effect file is created when the function runs.
 */

import { describe, test, expect, afterAll } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import from src — function must be exported (RED until implemented).
import { openInBrowser } from "../../src/cli.js";

// Sentinel file the malicious URL would create if shell-interpolated.
const PWNED = join(tmpdir(), `ctx-pwned-${process.pid}-${Date.now()}.flag`);

afterAll(() => {
  try { if (existsSync(PWNED)) unlinkSync(PWNED); } catch {}
});

describe("openInBrowser — shell injection hardening", () => {
  test("darwin: passes URL as single argv element, no shell interpolation", () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const fakeExecFile = (file: string, args: readonly string[], _opts?: unknown) => {
      calls.push({ file, args: [...args] });
    };

    const evilUrl = `http://localhost:1234?x=$(touch ${PWNED})`;
    openInBrowser(evilUrl, "darwin", fakeExecFile as never);

    expect(calls.length).toBe(1);
    expect(calls[0].file).toBe("open");
    // URL must appear as a single, untouched argv element — not split,
    // not shell-interpreted.
    expect(calls[0].args).toEqual([evilUrl]);
    // The malicious payload must NOT have been executed by a shell.
    expect(existsSync(PWNED)).toBe(false);
  });

  test("linux: passes URL as single argv element to xdg-open", () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const fakeExecFile = (file: string, args: readonly string[], _opts?: unknown) => {
      calls.push({ file, args: [...args] });
    };

    const evilUrl = "http://localhost:1234?x=$(rm -rf /tmp/foo)`whoami`;ls;";
    openInBrowser(evilUrl, "linux", fakeExecFile as never);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(["xdg-open", "sensible-browser"]).toContain(calls[0].file);
    expect(calls[0].args).toEqual([evilUrl]);
  });

  test("win32: passes URL as a separate argv element with empty title", () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const fakeExecFile = (file: string, args: readonly string[], _opts?: unknown) => {
      calls.push({ file, args: [...args] });
    };

    const evilUrl = "http://localhost:1234?x=&calc.exe&";
    openInBrowser(evilUrl, "win32", fakeExecFile as never);

    expect(calls.length).toBe(1);
    expect(calls[0].file).toBe("cmd");
    // `start` requires an empty title arg first, then the URL as its own arg.
    expect(calls[0].args).toEqual(["/c", "start", "", evilUrl]);
  });

  test("does not throw when execFile fails (best-effort open)", () => {
    const failingExecFile = () => { throw new Error("ENOENT"); };
    expect(() =>
      openInBrowser("http://localhost:1234", "darwin", failingExecFile as never),
    ).not.toThrow();
  });
});
