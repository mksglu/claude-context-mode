import { afterEach, describe, expect, test, vi } from "vitest";
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
