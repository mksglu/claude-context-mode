import "../setup-home";
/**
 * Pi extension — short-circuit guard for `pi --help` / `pi --version` (#534).
 *
 * Problem: `piExtension(pi)` runs during Pi's extension-discovery phase, BEFORE
 * Pi's `run()` decides whether the invocation is a short-circuit (help/version)
 * or a real session. Before this fix, `bootstrapMCPTools()` always spawned the
 * `server.bundle.mjs` child. On `pi --help`, Pi prints help and exits ~50 ms
 * later; the MCP child gets reparented to PID 1 with a half-closed stdin and
 * the SDK's stdio transport CPU-spins until the 30 s lifecycle poll catches it
 * (or until `kill -9`). Issue #534 reports multi-hour orphan accumulation.
 *
 * These tests pin the contract:
 *
 *   1. `isPiShortCircuitArgv(argv)` recognises exactly the tokens Pi's
 *      packages/coding-agent/src/cli.ts:runCli recognises:
 *        `--help`, `-h`, `--version`, `-v`, `help`.
 *      Verified against refs/platforms/oh-my-pi/packages/coding-agent/src/cli.ts.
 *
 *   2. `piExtension(pi)` MUST NOT call `bootstrapMCPTools()` when argv
 *      indicates a short-circuit. The rest of the extension wiring
 *      (event handlers, slash commands) still installs — those are
 *      cheap and harmless under help/version because the corresponding
 *      events never fire.
 *
 *   3. Under normal argv (e.g. `pi launch`), bootstrap still runs.
 *      Regression guard so slice-1 does not break the happy path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let scratch: string;
let originalArgv: string[];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ctx-pi-help-"));
  originalArgv = process.argv;
  // Reset module cache between tests so module-level singletons are pristine.
  vi.resetModules();
});

afterEach(() => {
  process.argv = originalArgv;
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  delete process.env.PI_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
});

// ── Mock Pi API ──────────────────────────────────────────────
function createMockPi() {
  return {
    on: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
  };
}

// ── Slice 1.a — pure helper ─────────────────────────────────
describe("isPiShortCircuitArgv — recognise Pi's runCli short-circuit tokens (#534)", () => {
  it("recognises --help, -h, --version, -v, help (exact set from Pi runCli)", async () => {
    const mod = await import("../../src/adapters/pi/extension.js");
    const { isPiShortCircuitArgv } = mod as unknown as {
      isPiShortCircuitArgv: (argv: readonly string[]) => boolean;
    };
    expect(typeof isPiShortCircuitArgv).toBe("function");

    for (const token of ["--help", "-h", "--version", "-v", "help"]) {
      expect(isPiShortCircuitArgv([token])).toBe(true);
    }
  });

  it("returns false for normal subcommands (launch, stats, commit)", async () => {
    const { isPiShortCircuitArgv } = (await import(
      "../../src/adapters/pi/extension.js"
    )) as unknown as { isPiShortCircuitArgv: (argv: readonly string[]) => boolean };

    expect(isPiShortCircuitArgv(["launch"])).toBe(false);
    expect(isPiShortCircuitArgv(["stats"])).toBe(false);
    expect(isPiShortCircuitArgv(["commit"])).toBe(false);
    expect(isPiShortCircuitArgv([])).toBe(false);
  });

  it("only matches argv[0] (first token), per Pi's runCli", async () => {
    // Pi's runCli checks only argv[0]. `pi stats --help` is a stats subcommand
    // with its own help — not a top-level short-circuit. The extension still
    // loads in that case (stats runs as a normal subcommand session).
    const { isPiShortCircuitArgv } = (await import(
      "../../src/adapters/pi/extension.js"
    )) as unknown as { isPiShortCircuitArgv: (argv: readonly string[]) => boolean };

    expect(isPiShortCircuitArgv(["stats", "--help"])).toBe(false);
    expect(isPiShortCircuitArgv(["launch", "-h"])).toBe(false);
  });

  it("rejects unrelated short flags (e.g. -V uppercase, --no-help)", async () => {
    // Pi uses lowercase `-v` for version, NOT `-V`. Documented in
    // refs/platforms/oh-my-pi/packages/coding-agent/src/cli.ts:runCli.
    const { isPiShortCircuitArgv } = (await import(
      "../../src/adapters/pi/extension.js"
    )) as unknown as { isPiShortCircuitArgv: (argv: readonly string[]) => boolean };

    expect(isPiShortCircuitArgv(["-V"])).toBe(false);
    expect(isPiShortCircuitArgv(["--no-help"])).toBe(false);
  });
});

// ── Slice 1.b — piExtension skips bootstrap on short-circuit ──
describe("piExtension — skip MCP bootstrap on Pi short-circuit invocations (#534)", () => {
  function withFakeBundle(): string {
    // The bootstrap path is gated by `existsSync(serverBundle)`. Drop a
    // sentinel file at the location piExtension resolves so we exercise the
    // branch that USED to call bootstrapMCPTools.
    const buildDir = resolve(__dirname, "../../build/adapters/pi");
    // Plugin root: three levels up from the built extension file. We point
    // PI_PROJECT_DIR at scratch; pluginRoot is derived from import.meta.url
    // inside extension.ts. Tests run the source TS via vitest, so
    // pluginRoot evaluates to the source repo root. Write the sentinel there.
    const repoRoot = resolve(__dirname, "../..");
    const bundlePath = join(repoRoot, "server.bundle.mjs");
    // Bundle already exists from the build step; we don't overwrite it.
    return bundlePath;
  }

  it("does NOT call bootstrapMCPTools when argv is `pi --help`", async () => {
    process.argv = ["/usr/bin/pi", "pi-coding-agent", "--help"];
    process.env.PI_PROJECT_DIR = scratch;
    process.env.CLAUDE_PROJECT_DIR = scratch;
    withFakeBundle();

    const bridgeMod = await import("../../src/adapters/pi/mcp-bridge.js");
    const spy = vi.spyOn(bridgeMod, "bootstrapMCPTools");

    const extMod = await import("../../src/adapters/pi/extension.js");
    const pi = createMockPi();
    extMod.default(pi);
    await extMod._mcpBridgeReady;

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does NOT call bootstrapMCPTools when argv is `pi -v`", async () => {
    process.argv = ["/usr/bin/pi", "pi-coding-agent", "-v"];
    process.env.PI_PROJECT_DIR = scratch;
    process.env.CLAUDE_PROJECT_DIR = scratch;

    const bridgeMod = await import("../../src/adapters/pi/mcp-bridge.js");
    const spy = vi.spyOn(bridgeMod, "bootstrapMCPTools");

    const extMod = await import("../../src/adapters/pi/extension.js");
    const pi = createMockPi();
    extMod.default(pi);
    await extMod._mcpBridgeReady;

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("DOES call bootstrapMCPTools on normal `pi launch` argv (regression guard)", async () => {
    process.argv = ["/usr/bin/pi", "pi-coding-agent", "launch"];
    process.env.PI_PROJECT_DIR = scratch;
    process.env.CLAUDE_PROJECT_DIR = scratch;

    // Stub bootstrapMCPTools so we don't actually spawn a child. The spy
    // confirms the call happens; the returned no-op handle keeps the rest
    // of the extension wiring happy.
    const bridgeMod = await import("../../src/adapters/pi/mcp-bridge.js");
    const spy = vi
      .spyOn(bridgeMod, "bootstrapMCPTools")
      .mockResolvedValue({
        tools: [],
        shutdown: () => {},
        client: { _spawnEnv: null } as unknown as InstanceType<
          typeof bridgeMod.MCPStdioClient
        >,
      });

    const extMod = await import("../../src/adapters/pi/extension.js");
    const pi = createMockPi();
    extMod.default(pi);
    await extMod._mcpBridgeReady;

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
