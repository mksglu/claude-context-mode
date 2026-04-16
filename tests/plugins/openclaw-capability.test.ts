import { describe, expect, it } from "vitest";
import {
  classifySessionCapability,
  createCapabilitySignals,
  observeCapabilitySignal,
} from "../../src/openclaw/capability.js";

describe("openclaw capability contract", () => {
  it("reports full only when db_persisted is observed", () => {
    const current = observeCapabilitySignal(createCapabilitySignals("s1"), "db_persisted");
    expect(classifySessionCapability(current)).toMatchObject({
      state: "full",
      reason: "db_persistence_observed",
      evidence: "db_persisted",
      tokenSavingsActive: true,
    });
  });

  it("reports degraded for typed tool hooks without db proof", () => {
    const current = observeCapabilitySignal(createCapabilitySignals("s2"), "typed_tool_hook_observed");
    expect(classifySessionCapability(current)).toMatchObject({
      state: "degraded",
      reason: "typed_tool_hooks_observed",
    });
  });

  it("reports degraded for persistence hooks without db proof", () => {
    const current = observeCapabilitySignal(createCapabilitySignals("s3"), "persistence_hook_observed");
    expect(classifySessionCapability(current)).toMatchObject({
      state: "degraded",
      reason: "persistence_hooks_observed",
    });
  });

  it("reports unsupported for prompt hooks only", () => {
    const current = observeCapabilitySignal(createCapabilitySignals("s4"), "prompt_hook_observed");
    expect(classifySessionCapability(current)).toMatchObject({
      state: "unsupported",
      reason: "prompt_hooks_only",
    });
  });

  it("transitions monotonically from unsupported to degraded to full", () => {
    let current = createCapabilitySignals("s5");
    expect(classifySessionCapability(current).state).toBe("unsupported");

    current = observeCapabilitySignal(current, "prompt_hook_observed");
    expect(classifySessionCapability(current).state).toBe("unsupported");

    current = observeCapabilitySignal(current, "typed_tool_hook_observed");
    expect(classifySessionCapability(current).state).toBe("degraded");

    current = observeCapabilitySignal(current, "db_persisted");
    expect(classifySessionCapability(current).state).toBe("full");
  });
});
