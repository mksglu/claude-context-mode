import { describe, test, expect } from "vitest";

describe("Package exports", () => {
  test("default export exposes ContextModePlugin factory", async () => {
    const mod = await import("../src/opencode-plugin.js");
    expect(mod.ContextModePlugin).toBeDefined();
    expect(typeof mod.ContextModePlugin).toBe("function");
  });

  test("default export does not leak CLI internals", async () => {
    const mod = (await import("../src/opencode-plugin.js")) as any;
    expect(mod.toUnixPath).toBeUndefined();
    expect(mod.doctor).toBeUndefined();
    expect(mod.upgrade).toBeUndefined();
  });
});
