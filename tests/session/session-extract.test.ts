import { strict as assert } from "node:assert";
import { describe, test } from "vitest";
import { extractEvents, extractUserEvents } from "../../src/session/extract.js";

// ════════════════════════════════════════════
// SLICE 1: FILE EVENT EXTRACTION
// ════════════════════════════════════════════

describe("File Events", () => {
  test("extracts file event from Edit tool call", () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: "/project/src/server.ts",
        old_string: 'const VERSION = "0.9.21"',
        new_string: 'const VERSION = "0.9.22"',
      },
      tool_response: "File edited successfully",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "file");
    assert.equal(events[0].category, "file");
    assert.equal(events[0].data, "/project/src/server.ts");
    assert.equal(events[0].priority, 1);
  });

  test("extracts file event from Write tool call", () => {
    const input = {
      tool_name: "Write",
      tool_input: { file_path: "/project/tests/new.test.ts", content: "..." },
      tool_response: "File written",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "file_write");
    assert.equal(events[0].category, "file");
    assert.equal(events[0].priority, 1);
  });

  test("extracts file event from Read of source files", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "/project/src/store.ts" },
      tool_response: "file contents...",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "file_read");
    assert.equal(events[0].category, "file");
    assert.equal(events[0].priority, 1);
  });
});

// ════════════════════════════════════════════
// SLICE 2: RULE EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Rule Events", () => {
  test("extracts rule event when CLAUDE.md is read", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "/project/CLAUDE.md" },
      tool_response: "# Rules\n- Never push without approval\n- Always use TypeScript",
    };

    const events = extractEvents(input);
    const ruleEvents = events.filter(e => e.type === "rule");
    assert.equal(ruleEvents.length, 1);
    assert.equal(ruleEvents[0].priority, 1);
    assert.ok(ruleEvents[0].data.includes("CLAUDE.md"));
  });

  test("extracts rule event for .claude/ config files", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "/home/user/.claude/settings.json" },
      tool_response: "{ ... }",
    };

    const events = extractEvents(input);
    const ruleEvents = events.filter(e => e.type === "rule");
    assert.equal(ruleEvents.length, 1);
  });

  test("CLAUDE.md read yields both rule AND file events", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "/project/CLAUDE.md" },
      tool_response: "rules...",
    };

    const events = extractEvents(input);
    const types = events.map(e => e.type);
    assert.ok(types.includes("rule"), "should include rule event");
    assert.ok(types.includes("file_read"), "should include file_read event");
  });
});

// ════════════════════════════════════════════
// SLICE 3: CWD EVENT EXTRACTION
// ════════════════════════════════════════════

describe("CWD Events", () => {
  test("extracts cwd event from cd command", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "cd /project/subdir && ls" },
      tool_response: "file1.ts\nfile2.ts",
    };

    const events = extractEvents(input);
    const cwdEvents = events.filter(e => e.type === "cwd");
    assert.equal(cwdEvents.length, 1);
    assert.equal(cwdEvents[0].data, "/project/subdir");
    assert.equal(cwdEvents[0].priority, 2);
  });

  test("extracts cwd from cd with double-quoted path", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: 'cd "/path with spaces/dir"' },
      tool_response: "",
    };

    const events = extractEvents(input);
    const cwdEvents = events.filter(e => e.type === "cwd");
    assert.equal(cwdEvents.length, 1);
    assert.equal(cwdEvents[0].data, "/path with spaces/dir");
  });

  test("extracts cwd from cd with single-quoted path", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "cd '/path with spaces/dir'" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const cwdEvents = events.filter(e => e.type === "cwd");
    assert.equal(cwdEvents.length, 1);
    assert.equal(cwdEvents[0].data, "/path with spaces/dir");
  });

  test("does not extract cwd from non-cd bash commands", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_response: "...",
    };

    const events = extractEvents(input);
    const cwdEvents = events.filter(e => e.type === "cwd");
    assert.equal(cwdEvents.length, 0);
  });
});

// ════════════════════════════════════════════
// SLICE 4: ERROR EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Error Events", () => {
  test("extracts error event from failed bash command", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "FAIL src/store.test.ts\nError: expected 3 but got 5\nexit code 1",
    };

    const events = extractEvents(input);
    const errorEvents = events.filter(e => e.type === "error_tool");
    assert.equal(errorEvents.length, 1);
    assert.equal(errorEvents[0].priority, 2);
    assert.ok(errorEvents[0].data.includes("FAIL"));
  });

  test("extracts error from isError: true response", () => {
    const input = {
      tool_name: "Edit",
      tool_input: { file_path: "/x.ts", old_string: "foo", new_string: "bar" },
      tool_response: "old_string not found in file",
      tool_output: { isError: true },
    };

    const events = extractEvents(input);
    const errorEvents = events.filter(e => e.type === "error_tool");
    assert.equal(errorEvents.length, 1);
  });

  test("does not extract error from successful bash command", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: "hello",
    };

    const events = extractEvents(input);
    const errorEvents = events.filter(e => e.type === "error_tool");
    assert.equal(errorEvents.length, 0);
  });
});

// ════════════════════════════════════════════
// SLICE 5: GIT EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Git Events", () => {
  test("extracts git event from checkout command", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b feature/session-continuity" },
      tool_response: "Switched to a new branch 'feature/session-continuity'",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.type === "git");
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].data, "branch");
    assert.equal(gitEvents[0].priority, 2);
  });

  test("extracts git event from commit command", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "feat: add session continuity"' },
      tool_response: "[next abc1234] feat: add session continuity",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.type === "git");
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].data, "commit");
  });

  test("extracts git event from push command", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
      tool_response: "Branch pushed",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.type === "git");
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].data, "push");
  });

  test("does not extract git event from non-git commands", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "npm install" },
      tool_response: "installed",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.type === "git");
    assert.equal(gitEvents.length, 0);
  });
});

// ════════════════════════════════════════════
// SLICE 6: TASK EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Task Events", () => {
  test("extracts task event from TodoWrite", () => {
    const input = {
      tool_name: "TodoWrite",
      tool_input: { todos: [{ id: "1", content: "Write tests", status: "in_progress" }] },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const taskEvents = events.filter(e => e.type === "task");
    assert.equal(taskEvents.length, 1);
    assert.equal(taskEvents[0].priority, 1);
  });

  test("extracts task event from TaskCreate", () => {
    const input = {
      tool_name: "TaskCreate",
      tool_input: { subject: "Implement session DB", status: "pending" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const taskEvents = events.filter(e => e.type === "task");
    assert.equal(taskEvents.length, 1);
    assert.equal(taskEvents[0].priority, 1);
  });

  test("extracts task event from TaskUpdate", () => {
    const input = {
      tool_name: "TaskUpdate",
      tool_input: { taskId: "1", status: "done" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const taskEvents = events.filter(e => e.type === "task");
    assert.equal(taskEvents.length, 1);
  });
});

// ════════════════════════════════════════════
// SLICE 7: DECISION EVENT EXTRACTION (user messages)
// ════════════════════════════════════════════

describe("Decision Events", () => {
  test("extracts decision from user correction", () => {
    const events = extractUserEvents("no, use ctx- prefix instead of cm-");
    const decisionEvents = events.filter(e => e.type === "decision");
    assert.equal(decisionEvents.length, 1);
    assert.ok(decisionEvents[0].data.includes("ctx-"));
  });

  test("extracts decision from 'always/never' directives", () => {
    const events = extractUserEvents("never push to main without asking me first");
    const decisionEvents = events.filter(e => e.type === "decision");
    assert.equal(decisionEvents.length, 1);
  });

  test("extracts decision from Turkish corrections", () => {
    const events = extractUserEvents("hayır, böyle değil, yerine ctx- kullan");
    const decisionEvents = events.filter(e => e.type === "decision");
    assert.equal(decisionEvents.length, 1);
  });

  test("does not extract decision from regular messages", () => {
    const events = extractUserEvents("Can you read the server.ts file?");
    const decisionEvents = events.filter(e => e.type === "decision");
    assert.equal(decisionEvents.length, 0);
  });
});

// ════════════════════════════════════════════
// SLICE 8: RULE EVENT EXTRACTION (user messages)
// ════════════════════════════════════════════

describe("Role Events", () => {
  test("extracts role from persona directive", () => {
    const events = extractUserEvents("Act as a senior staff engineer for this review");
    const roleEvents = events.filter(e => e.type === "role");
    assert.equal(roleEvents.length, 1);
    assert.ok(roleEvents[0].data.includes("senior staff engineer"));
  });

  test("extracts role from 'you are' pattern", () => {
    const events = extractUserEvents("You are a principal architect. Review this design.");
    const roleEvents = events.filter(e => e.type === "role");
    assert.equal(roleEvents.length, 1);
  });
});

// ════════════════════════════════════════════
// SLICE 9: ENV EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Env Events", () => {
  test("extracts env event from venv activation", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "source .venv/bin/activate" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 1);
    assert.equal(envEvents[0].priority, 2);
  });

  test("extracts env event from nvm use", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "nvm use 20" },
      tool_response: "Now using node v20.0.0",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 1);
  });

  test("extracts env event from export command", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "export API_KEY=sk-test" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 1);
  });

  test("does not extract env from regular bash commands", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_response: "files...",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 0);
  });
});

// ════════════════════════════════════════════
// SLICE 10: SKILL EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Skill Events", () => {
  test("extracts skill event from Skill tool call", () => {
    const input = {
      tool_name: "Skill",
      tool_input: { skill: "tdd", args: "session tests" },
      tool_response: "Loaded TDD skill",
    };

    const events = extractEvents(input);
    const skillEvents = events.filter(e => e.type === "skill");
    assert.equal(skillEvents.length, 1);
    assert.equal(skillEvents[0].data, "tdd");
    assert.equal(skillEvents[0].priority, 3);
  });

  test("extracts skill event without args", () => {
    const input = {
      tool_name: "Skill",
      tool_input: { skill: "commit" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const skillEvents = events.filter(e => e.type === "skill");
    assert.equal(skillEvents.length, 1);
    assert.equal(skillEvents[0].data, "commit");
  });
});

// ════════════════════════════════════════════
// SLICE 11: SUBAGENT EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Subagent Events", () => {
  test("extracts subagent event from Agent tool call", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Research the best approach for session continuity", description: "Research agent" },
      tool_response: "Agent completed. Found 3 approaches.",
    };

    const events = extractEvents(input);
    const subagentEvents = events.filter(e => e.category === "subagent");
    assert.equal(subagentEvents.length, 1);
    // Has tool_response → completed → priority 2
    assert.equal(subagentEvents[0].priority, 2);
  });

  // ── Bug fix: Agent completion results must be captured ──

  test("captures tool_response in subagent event when Agent completes", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Research Cursor env vars" },
      tool_response: "Found CURSOR_TRACE_DIR and CURSOR_CHANNEL env vars. Cursor also sets VSCODE_PID.",
    };

    const events = extractEvents(input);
    const subagentEvents = events.filter(e => e.category === "subagent");
    assert.equal(subagentEvents.length, 1);
    // The event data MUST include the response, not just the prompt
    assert.ok(
      subagentEvents[0].data.includes("CURSOR_TRACE_DIR") || subagentEvents[0].data.includes("Found"),
      `subagent event data should include tool_response content, got: "${subagentEvents[0].data}"`,
    );
  });

  test("distinguishes completed agents from launched-only agents", () => {
    const completedInput = {
      tool_name: "Agent",
      tool_input: { prompt: "Research VS Code env vars" },
      tool_response: "VSCODE_PID is set by VS Code for all child processes.",
    };

    const launchedInput = {
      tool_name: "Agent",
      tool_input: { prompt: "Research Codex CLI env vars" },
      // No tool_response — agent was launched but hasn't completed
    };

    const completedEvents = extractEvents(completedInput);
    const launchedEvents = extractEvents(launchedInput);

    const completed = completedEvents.filter(e => e.category === "subagent");
    const launched = launchedEvents.filter(e => e.category === "subagent");

    assert.equal(completed.length, 1);
    assert.equal(launched.length, 1);

    // Completed agents should have higher priority (P2) than launched (P3)
    assert.ok(
      completed[0].priority < launched[0].priority,
      `completed priority (${completed[0].priority}) should be lower (=higher importance) than launched (${launched[0].priority})`,
    );
  });

  test("completed agent event type indicates completion status", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Audit all adapter env vars" },
      tool_response: "Completed audit. Gemini CLI sets GEMINI_PROJECT_DIR. Codex has no env detection.",
    };

    const events = extractEvents(input);
    const subagentEvents = events.filter(e => e.category === "subagent");
    assert.equal(subagentEvents.length, 1);

    // Event type must distinguish completed from launched
    assert.ok(
      subagentEvents[0].type.includes("completed") || subagentEvents[0].type.includes("complete"),
      `completed agent event type should indicate completion, got: "${subagentEvents[0].type}"`,
    );
  });
});

// ════════════════════════════════════════════
// SLICE 12: INTENT EVENT EXTRACTION (user messages)
// ════════════════════════════════════════════

describe("Intent Events", () => {
  test("extracts investigation intent", () => {
    const events = extractUserEvents("Why is the test failing? Can you debug this?");
    const intentEvents = events.filter(e => e.type === "intent");
    assert.equal(intentEvents.length, 1);
    assert.equal(intentEvents[0].data, "investigate");
  });

  test("extracts implementation intent", () => {
    const events = extractUserEvents("Create a new PostToolUse hook for event extraction");
    const intentEvents = events.filter(e => e.type === "intent");
    assert.equal(intentEvents.length, 1);
    assert.equal(intentEvents[0].data, "implement");
  });

  test("extracts review intent", () => {
    const events = extractUserEvents("Review this code and check for security issues");
    const intentEvents = events.filter(e => e.type === "intent");
    assert.equal(intentEvents.length, 1);
    assert.equal(intentEvents[0].data, "review");
  });

  test("extracts discussion intent", () => {
    const events = extractUserEvents("Think about the pros and cons of this approach");
    const intentEvents = events.filter(e => e.type === "intent");
    assert.equal(intentEvents.length, 1);
    assert.equal(intentEvents[0].data, "discuss");
  });
});

// ════════════════════════════════════════════
// SLICE 13: DATA EVENT EXTRACTION (user messages)
// ════════════════════════════════════════════

describe("Data Events", () => {
  test("extracts data event from large user message", () => {
    const largeMessage = "Here is the config:\n" + "x".repeat(2000);
    const events = extractUserEvents(largeMessage);
    const dataEvents = events.filter(e => e.type === "data");
    assert.equal(dataEvents.length, 1);
    assert.equal(dataEvents[0].priority, 4);
    // data field is the preview, truncated to 300 chars
    assert.ok(dataEvents[0].data.length <= 300);
  });

  test("does not extract data event from short message", () => {
    const events = extractUserEvents("Fix the bug please");
    const dataEvents = events.filter(e => e.type === "data");
    assert.equal(dataEvents.length, 0);
  });
});

// ════════════════════════════════════════════
// CROSS-PLATFORM (Windows paths)
// ════════════════════════════════════════════

describe("Cross-Platform (Windows)", () => {
  test("extracts rule event for Windows .claude\\ path", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "C:\\Users\\dev\\.claude\\settings.json" },
      tool_response: "{ ... }",
    };

    const events = extractEvents(input);
    const ruleEvents = events.filter(e => e.type === "rule");
    assert.equal(ruleEvents.length, 1);
    assert.ok(ruleEvents[0].data.includes(".claude\\"));
  });

  test("extracts rule event for Windows CLAUDE.md", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "C:\\Users\\dev\\project\\CLAUDE.md" },
      tool_response: "rules...",
    };

    const events = extractEvents(input);
    const ruleEvents = events.filter(e => e.type === "rule");
    assert.equal(ruleEvents.length, 1);
  });

  test("extracts file event from Windows Edit path", () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: "C:\\Users\\dev\\project\\src\\server.ts",
        old_string: "a",
        new_string: "b",
      },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "file");
    assert.ok(events[0].data.includes("server.ts"));
  });

  test("extracts cwd from cd with Windows path", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: 'cd "C:\\Users\\dev\\project"' },
      tool_response: "",
    };

    const events = extractEvents(input);
    const cwdEvents = events.filter(e => e.type === "cwd");
    assert.equal(cwdEvents.length, 1);
    assert.equal(cwdEvents[0].data, "C:\\Users\\dev\\project");
  });

  test("extracts cwd from cd with Windows UNC path", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: 'cd "\\\\server\\share\\project"' },
      tool_response: "",
    };

    const events = extractEvents(input);
    const cwdEvents = events.filter(e => e.type === "cwd");
    assert.equal(cwdEvents.length, 1);
    assert.equal(cwdEvents[0].data, "\\\\server\\share\\project");
  });
});

// ════════════════════════════════════════════
// MULTI-EVENT & EDGE CASES
// ════════════════════════════════════════════

describe("Multi-Event & Edge Cases", () => {
  test("extracts multiple events from a single tool call (cd + git)", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "cd /project && git checkout main" },
      tool_response: "Switched to branch 'main'",
    };

    const events = extractEvents(input);
    assert.ok(events.length >= 2, `Expected >=2 events, got ${events.length}`);
    const types = events.map(e => e.type);
    assert.ok(types.includes("cwd"), "should include cwd");
    assert.ok(types.includes("git"), "should include git");
  });

  test("does not extract events from no-op tool calls", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: "hello",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 0);
  });

  test("returns empty array for unknown tool names", () => {
    const input = {
      tool_name: "UnknownTool",
      tool_input: {},
      tool_response: "something",
    };

    const events = extractEvents(input);
    assert.ok(Array.isArray(events));
    assert.equal(events.length, 0);
  });

  test("handles missing/undefined fields gracefully", () => {
    const input = {
      tool_name: "Bash",
      tool_input: {},
      tool_response: undefined,
    };

    // Should not throw
    const events = extractEvents(input as any);
    assert.ok(Array.isArray(events));
  });
});

// ════════════════════════════════════════════
// TRUNCATION & SAFETY
// ════════════════════════════════════════════

describe("Truncation & Safety", () => {
  test("truncates long tool responses in error events", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "Error: " + "x".repeat(10000),
    };

    const events = extractEvents(input);
    const errorEvents = events.filter(e => e.type === "error_tool");
    assert.equal(errorEvents.length, 1);
    assert.ok(errorEvents[0].data.length <= 300, `data.length = ${errorEvents[0].data.length}`);
  });

  test("data field is always a string of max 300 chars", () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: "/project/src/" + "a".repeat(500) + ".ts",
        old_string: "x",
        new_string: "y",
      },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    for (const event of events) {
      assert.equal(typeof event.data, "string", `event.type=${event.type} data should be string`);
      assert.ok(event.data.length <= 300, `event.type=${event.type} data.length=${event.data.length} exceeds 300`);
    }
  });
});

// ════════════════════════════════════════════
// GLOB EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Glob Events", () => {
  test("extracts file_glob event from Glob tool call", () => {
    const input = {
      tool_name: "Glob",
      tool_input: { pattern: "src/**/*.ts" },
      tool_response: JSON.stringify({ filenames: ["src/server.ts", "src/runtime.ts"] }),
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "file_glob");
    assert.equal(events[0].category, "file");
    assert.equal(events[0].data, "src/**/*.ts");
    assert.equal(events[0].priority, 3);
  });

  test("extracts file_glob with path filter", () => {
    const input = {
      tool_name: "Glob",
      tool_input: { pattern: "*.test.ts", path: "/project/tests" },
      tool_response: "[]",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].data, "*.test.ts");
  });
});

// ════════════════════════════════════════════
// GREP EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Grep Events", () => {
  test("extracts file_search event from Grep tool call", () => {
    const input = {
      tool_name: "Grep",
      tool_input: { pattern: "extractEvents", path: "/project/src" },
      tool_response: JSON.stringify(["src/extract.ts", "src/hook.ts"]),
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "file_search");
    assert.equal(events[0].category, "file");
    assert.equal(events[0].data, "extractEvents in /project/src");
    assert.equal(events[0].priority, 3);
  });

  test("extracts file_search without path", () => {
    const input = {
      tool_name: "Grep",
      tool_input: { pattern: "TODO" },
      tool_response: "...",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].data, "TODO in ");
  });
});

// ════════════════════════════════════════════
// EXPANDED GIT PATTERNS
// ════════════════════════════════════════════

describe("Expanded Git Patterns", () => {
  test("extracts git log event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -5" },
      tool_response: "abc123 fix: something",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.type === "git");
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].data, "log");
  });

  test("extracts git diff event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git diff HEAD~1" },
      tool_response: "diff --git...",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.type === "git");
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].data, "diff");
  });

  test("extracts git status event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git status" },
      tool_response: "On branch main",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.type === "git");
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].data, "status");
  });

  test("extracts git pull event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git pull origin main" },
      tool_response: "Already up to date.",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.type === "git");
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].data, "pull");
  });
});

// ════════════════════════════════════════════
// EXPANDED ENV PATTERNS (dependency install)
// ════════════════════════════════════════════

describe("Dependency Install Events", () => {
  test("extracts env event from npm install", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "npm install vitest --save-dev" },
      tool_response: "added 50 packages",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 1);
  });

  test("extracts env event from pip install", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "pip install requests" },
      tool_response: "Successfully installed",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 1);
  });

  test("extracts env event from bun install", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "bun install" },
      tool_response: "installed dependencies",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 1);
  });

  test("extracts env event from yarn add", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "yarn add lodash" },
      tool_response: "success",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 1);
  });
});
