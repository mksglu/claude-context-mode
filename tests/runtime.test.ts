import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeMap } from "../src/runtime.js";

describe("runtime version reporting", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:child_process");
  });

  test("uses 'go version' for Go while preserving '--version' for other runtimes", async () => {
    const execFileSync = vi.fn((cmd: string, args: string[]) => {
      if (cmd === "go" && args.length === 1 && args[0] === "version") {
        return "go version go1.26.2 darwin/arm64\n";
      }
      if (cmd === "node" && args.length === 1 && args[0] === "--version") {
        return "v25.9.0\n";
      }
      throw new Error(`unexpected version probe: ${cmd} ${args.join(" ")}`);
    });

    vi.doMock("node:child_process", () => ({
      execFileSync,
      execSync: vi.fn(),
    }));

    const { getRuntimeSummary } = await import("../src/runtime.js");
    const runtimes: RuntimeMap = {
      javascript: "node",
      typescript: null,
      python: null,
      shell: "node",
      ruby: null,
      go: "go",
      rust: null,
      php: null,
      perl: null,
      r: null,
      elixir: null,
    };

    const summary = getRuntimeSummary(runtimes);

    expect(execFileSync).toHaveBeenCalledWith(
      "go",
      ["version"],
      expect.objectContaining({ shell: process.platform === "win32" }),
    );
    expect(execFileSync).not.toHaveBeenCalledWith(
      "go",
      ["--version"],
      expect.anything(),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "node",
      ["--version"],
      expect.anything(),
    );
    expect(summary).toContain("Go:         go (go version go1.26.2 darwin/arm64)");
    expect(summary).not.toContain("Go:         go (unknown)");
  });
});

describe("SHELL env var override", () => {
  let tmpDir: string;
  let allowlistedShell: string;
  let nonAllowlistedShell: string;
  const originalShell = process.env.SHELL;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ctx-shell-"));
    // Allowlisted basename — matches isAllowlistedShell regex
    allowlistedShell = join(tmpDir, "bash");
    writeFileSync(allowlistedShell, "#!/bin/sh\necho fake\n", { mode: 0o755 });
    // Non-allowlisted basename — exists but rejected by allowlist
    nonAllowlistedShell = join(tmpDir, "python");
    writeFileSync(nonAllowlistedShell, "#!/bin/sh\necho python\n", { mode: 0o755 });
  });

  afterEach(() => {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    vi.resetModules();
  });

  test("SHELL env var overrides shell when path exists AND basename is allowlisted", async () => {
    process.env.SHELL = allowlistedShell;
    const { detectRuntimes } = await import("../src/runtime.js");
    const r = detectRuntimes();
    expect(r.shell).toBe(allowlistedShell);
  });

  test("SHELL env var REJECTED when basename not in allowlist (security)", async () => {
    // PR #401 ops review: SHELL=/usr/bin/python (or any non-shell binary) must
    // NOT be honored. Otherwise an attacker who controls a profile script can
    // redirect the executor to an arbitrary binary.
    process.env.SHELL = nonAllowlistedShell;
    const { detectRuntimes } = await import("../src/runtime.js");
    const r = detectRuntimes();
    expect(r.shell).not.toBe(nonAllowlistedShell);
    expect(r.shell.length).toBeGreaterThan(0); // falls back to platform detection
  });

  test("isAllowlistedShell accepts bash/sh/zsh/dash/pwsh/powershell/cmd", async () => {
    const { isAllowlistedShell } = await import("../src/runtime.js");
    expect(isAllowlistedShell("/bin/bash")).toBe(true);
    expect(isAllowlistedShell("/bin/sh")).toBe(true);
    expect(isAllowlistedShell("/usr/local/bin/zsh")).toBe(true);
    expect(isAllowlistedShell("/bin/dash")).toBe(true);
    expect(isAllowlistedShell("/usr/bin/pwsh")).toBe(true);
    expect(isAllowlistedShell("C:\\Windows\\System32\\cmd.exe")).toBe(true);
    expect(isAllowlistedShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(true);
  });

  test("isAllowlistedShell rejects non-shell binaries", async () => {
    const { isAllowlistedShell } = await import("../src/runtime.js");
    expect(isAllowlistedShell("/usr/bin/python")).toBe(false);
    expect(isAllowlistedShell("/usr/bin/node")).toBe(false);
    expect(isAllowlistedShell("/usr/bin/curl")).toBe(false);
    expect(isAllowlistedShell("/tmp/evil-script")).toBe(false);
    expect(isAllowlistedShell("/bin/bash-with-suffix")).toBe(false);
  });

  test("SHELL env var ignored when path does not exist", async () => {
    process.env.SHELL = join(tmpDir, "does-not-exist-shell");
    const { detectRuntimes } = await import("../src/runtime.js");
    const r = detectRuntimes();
    expect(r.shell).not.toBe(process.env.SHELL);
    expect(r.shell.length).toBeGreaterThan(0);
  });

  test("no SHELL env var falls through to platform-specific detection", async () => {
    delete process.env.SHELL;
    const { detectRuntimes } = await import("../src/runtime.js");
    const r = detectRuntimes();
    // Should resolve to a non-empty shell from platform detection
    expect(r.shell.length).toBeGreaterThan(0);
    // On Unix, expect bash or sh; on Windows, expect bash.exe / sh / powershell / cmd
    if (process.platform === "win32") {
      const lower = r.shell.toLowerCase();
      expect(
        lower.includes("bash") ||
          lower.includes("sh") ||
          lower.includes("powershell") ||
          lower.includes("cmd"),
      ).toBe(true);
    } else {
      expect(["bash", "sh"]).toContain(r.shell);
    }
  });
});

describe("buildCommand shell variants", () => {
  function makeRuntimes(shell: string): RuntimeMap {
    return {
      javascript: "node",
      typescript: null,
      python: null,
      shell,
      ruby: null,
      go: null,
      rust: null,
      php: null,
      perl: null,
      r: null,
      elixir: null,
    };
  }

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.doUnmock("node:process");
  });

  async function importWithPlatform(platform: NodeJS.Platform) {
    vi.resetModules();
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    return await import("../src/runtime.js");
  }

  test("Windows bash gets bash -c source pattern", async () => {
    const original = process.platform;
    try {
      const { buildCommand } = await importWithPlatform("win32");
      const cmd = buildCommand(
        makeRuntimes("C:\\Program Files\\Git\\usr\\bin\\bash.exe"),
        "shell",
        "D:\\tmp\\script",
      );
      expect(cmd[0]).toBe("C:\\Program Files\\Git\\usr\\bin\\bash.exe");
      expect(cmd[1]).toBe("-c");
      expect(cmd[2]).toBe("source 'D:\\tmp\\script'");
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
      vi.resetModules();
    }
  });

  test("Windows powershell gets -File pattern", async () => {
    const original = process.platform;
    try {
      const { buildCommand } = await importWithPlatform("win32");
      const cmd = buildCommand(
        makeRuntimes("powershell"),
        "shell",
        "C:\\tmp\\script.ps1",
      );
      expect(cmd[0]).toBe("powershell");
      expect(cmd[1]).toBe("-File");
      expect(cmd[2]).toBe("C:\\tmp\\script.ps1");
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
      vi.resetModules();
    }
  });

  test("Windows cmd gets direct file pattern", async () => {
    const original = process.platform;
    try {
      const { buildCommand } = await importWithPlatform("win32");
      const cmd = buildCommand(
        makeRuntimes("cmd.exe"),
        "shell",
        "C:\\tmp\\script.cmd",
      );
      expect(cmd[0]).toBe("cmd.exe");
      expect(cmd[1]).toBe("C:\\tmp\\script.cmd");
      expect(cmd.length).toBe(2);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
      vi.resetModules();
    }
  });

  test("Unix bash gets direct file path (unchanged)", async () => {
    const original = process.platform;
    try {
      const { buildCommand } = await importWithPlatform("linux");
      const cmd = buildCommand(makeRuntimes("bash"), "shell", "/tmp/script");
      expect(cmd[0]).toBe("bash");
      expect(cmd[1]).toBe("/tmp/script");
      expect(cmd.length).toBe(2);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
      vi.resetModules();
    }
  });

  test("buildCommand on Windows escapes single-quotes in path safely", async () => {
    const original = process.platform;
    try {
      const { buildCommand } = await importWithPlatform("win32");
      const cmd = buildCommand(
        makeRuntimes("C:\\bash.exe"),
        "shell",
        "D:\\path\\with'quote\\script",
      );
      // Single quote escaped via '\'' technique → source 'D:\path\with'\''quote\script'
      expect(cmd[2]).toBe("source 'D:\\path\\with'\\''quote\\script'");
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
      vi.resetModules();
    }
  });
});
