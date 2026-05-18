import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("OpenCode/Kilo idle shutdown config (#592)", () => {
  it("OpenCode explicitly opts into MCP idle shutdown", () => {
    const cfg = readJson("configs/opencode/opencode.json") as any;
    expect(cfg.mcp?.["context-mode"]?.environment?.CONTEXT_MODE_IDLE_TIMEOUT_MS).toBe("900000");
  });

  it("KiloCode explicitly opts into MCP idle shutdown", () => {
    const cfg = readJson("configs/kilo/kilo.json") as any;
    expect(cfg.mcp?.["context-mode"]?.environment?.CONTEXT_MODE_IDLE_TIMEOUT_MS).toBe("900000");
  });
});
