import { describe, it, expect } from "vitest";
import { routePreToolUse } from "../../hooks/core/routing.mjs";
import { ROUTING_BLOCK } from "../../hooks/routing-block.mjs";

describe("Routing: Subagents (Agent/Task)", () => {
  it("detects prompt in different field names (request, objective, etc.)", () => {
    const fields = ["prompt", "request", "objective", "question", "query", "task"];

    for (const field of fields) {
      const toolInput = { [field]: "hello" };
      const decision = routePreToolUse("Agent", toolInput, "/test");
      
      expect(decision.action).toBe("modify");
      expect(decision.updatedInput[field]).toBe("hello" + ROUTING_BLOCK);
    }
  });

  it("falls back to 'prompt' field if no known field is present", () => {
    const toolInput = { unknown_field: "content" };
    const decision = routePreToolUse("Agent", toolInput, "/test");
    
    expect(decision.action).toBe("modify");
    expect(decision.updatedInput.prompt).toBe(ROUTING_BLOCK);
  });

  it("converts subagent_type='Bash' to 'general-purpose' and injects routing", () => {
    const toolInput = { 
      prompt: "do something",
      subagent_type: "Bash"
    };
    const decision = routePreToolUse("Agent", toolInput, "/test");
    
    expect(decision.action).toBe("modify");
    expect(decision.updatedInput.prompt).toBe("do something" + ROUTING_BLOCK);
    expect(decision.updatedInput.subagent_type).toBe("general-purpose");
  });

  it("preserves other fields when modifying", () => {
    const toolInput = { 
      request: "analyze this",
      other_param: 123,
      nested: { a: 1 }
    };
    const decision = routePreToolUse("Task", toolInput, "/test");
    
    expect(decision.action).toBe("modify");
    expect(decision.updatedInput.request).toBe("analyze this" + ROUTING_BLOCK);
    expect(decision.updatedInput.other_param).toBe(123);
    expect(decision.updatedInput.nested).toEqual({ a: 1 });
  });
});
