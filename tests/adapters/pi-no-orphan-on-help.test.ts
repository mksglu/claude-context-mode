import "../setup-home";
/**
 * Integration — `pi --help` leaves no orphan MCP child (#534).
 *
 * End-to-end harness: simulates the conditions of `pi --help` by importing
 * the Pi extension with `process.argv = ["pi", "--help"]` and observes that
 * no MCP child gets spawned. The companion contract is that, even if a child
 * had been spawned by an earlier code path, the bridge-child lifecycle
 * guard (slice 2) catches a dead parent within ~1 s and the stdin-EOF assist
 * (slice 3) collapses the window further.
 *
 * Mechanism under test:
 *   - `piExtension(pi)` is import-time-invoked by Pi's extension loader.
 *   - For `pi --help`, Pi's `runCli` short-circuits BEFORE the session
 *     starts; `bootstrapMCPTools()` MUST NOT have been called.
 *   - Therefore: zero `MCPStdioClient` instances are constructed, zero
 *     server.bundle.mjs spawns, zero orphan candidates exist.
 *
 * Note: we don't actually exec a real Pi binary here (slow, platform-coupled,
 * not in CI). The "no orphan" claim is enforced by asserting no child spawn
 * happened, which is the precondition for an orphan to exist.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let scratch: string;
let originalArgv: string[];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ctx-pi-orphan-"));
  originalArgv = process.argv;
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

function createMockPi() {
  return {
    on: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
  };
}

describe("Integration — pi --help leaves zero orphan candidates (#534)", () => {
  it("no MCPStdioClient is constructed when piExtension runs under `pi --help`", async () => {
    process.argv = ["/usr/bin/pi", "pi-coding-agent", "--help"];
    process.env.PI_PROJECT_DIR = scratch;
    process.env.CLAUDE_PROJECT_DIR = scratch;

    const bridgeMod = await import("../../src/adapters/pi/mcp-bridge.js");
    // Spy on the class constructor's `start()` — that's where `spawn()` happens.
    const startSpy = vi.spyOn(bridgeMod.MCPStdioClient.prototype, "start");
    const bootstrapSpy = vi.spyOn(bridgeMod, "bootstrapMCPTools");

    const extMod = await import("../../src/adapters/pi/extension.js");
    const pi = createMockPi();
    extMod.default(pi);
    await extMod._mcpBridgeReady;

    expect(bootstrapSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();

    startSpy.mockRestore();
    bootstrapSpy.mockRestore();
  });

  it("no MCPStdioClient is constructed under `pi --version`", async () => {
    process.argv = ["/usr/bin/pi", "pi-coding-agent", "--version"];
    process.env.PI_PROJECT_DIR = scratch;
    process.env.CLAUDE_PROJECT_DIR = scratch;

    const bridgeMod = await import("../../src/adapters/pi/mcp-bridge.js");
    const startSpy = vi.spyOn(bridgeMod.MCPStdioClient.prototype, "start");

    const extMod = await import("../../src/adapters/pi/extension.js");
    const pi = createMockPi();
    extMod.default(pi);
    await extMod._mcpBridgeReady;

    expect(startSpy).not.toHaveBeenCalled();
    startSpy.mockRestore();
  });

  it("no MCPStdioClient is constructed under `pi help` (Pi's `help` subcommand)", async () => {
    process.argv = ["/usr/bin/pi", "pi-coding-agent", "help"];
    process.env.PI_PROJECT_DIR = scratch;
    process.env.CLAUDE_PROJECT_DIR = scratch;

    const bridgeMod = await import("../../src/adapters/pi/mcp-bridge.js");
    const startSpy = vi.spyOn(bridgeMod.MCPStdioClient.prototype, "start");

    const extMod = await import("../../src/adapters/pi/extension.js");
    const pi = createMockPi();
    extMod.default(pi);
    await extMod._mcpBridgeReady;

    expect(startSpy).not.toHaveBeenCalled();
    startSpy.mockRestore();
  });
});
