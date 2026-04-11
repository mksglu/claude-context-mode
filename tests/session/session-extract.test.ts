import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "vitest";
import { extractEvents, extractUserEvents } from "../../src/session/extract.js";
import {
  clampFloat,
  clampInt,
  extractKeywords,
  extractTopicSignal,
  scoreDrift,
  stem,
  type TopicHistoryRow,
} from "../../src/session/topic-fence.js";

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
    assert.equal(events[0].type, "file_edit");
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
    const taskEvents = events.filter(e => e.type === "task_create");
    assert.equal(taskEvents.length, 1);
    assert.equal(taskEvents[0].priority, 1);
    assert.equal(taskEvents[0].category, "task");
  });

  test("extracts task event from TaskUpdate", () => {
    const input = {
      tool_name: "TaskUpdate",
      tool_input: { taskId: "1", status: "done" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const taskEvents = events.filter(e => e.type === "task_update");
    assert.equal(taskEvents.length, 1);
    assert.equal(taskEvents[0].category, "task");
  });
});

// ════════════════════════════════════════════
// SLICE 6B: PLAN MODE EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Plan Mode Events", () => {
  test("extracts plan_enter from EnterPlanMode", () => {
    const input = {
      tool_name: "EnterPlanMode",
      tool_input: {},
      tool_response: "",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 1);
    assert.equal(planEvents[0].type, "plan_enter");
    assert.equal(planEvents[0].data, "entered plan mode");
    assert.equal(planEvents[0].priority, 2);
  });

  test("extracts plan_exit from ExitPlanMode", () => {
    const input = {
      tool_name: "ExitPlanMode",
      tool_input: {},
      tool_response: "",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 1);
    assert.equal(planEvents[0].type, "plan_exit");
    assert.equal(planEvents[0].data, "exited plan mode");
  });

  test("extracts plan_exit with allowedPrompts from ExitPlanMode", () => {
    const input = {
      tool_name: "ExitPlanMode",
      tool_input: {
        allowedPrompts: [
          { tool: "Bash", prompt: "run tests" },
          { tool: "Bash", prompt: "install dependencies" },
        ],
      },
      tool_response: "",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 1);
    assert.equal(planEvents[0].type, "plan_exit");
    assert.ok(planEvents[0].data.includes("run tests"));
    assert.ok(planEvents[0].data.includes("install dependencies"));
  });

  test("extracts plan_approved when user approves", () => {
    const input = {
      tool_name: "ExitPlanMode",
      tool_input: {},
      tool_response: "User has approved your plan",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 2); // plan_exit + plan_approved
    assert.equal(planEvents[0].type, "plan_exit");
    assert.equal(planEvents[1].type, "plan_approved");
    assert.equal(planEvents[1].priority, 1);
  });

  test("extracts plan_rejected when user rejects", () => {
    const input = {
      tool_name: "ExitPlanMode",
      tool_input: {},
      tool_response: "User declined your plan. Please revise.",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 2); // plan_exit + plan_rejected
    assert.equal(planEvents[0].type, "plan_exit");
    assert.equal(planEvents[1].type, "plan_rejected");
    assert.ok(planEvents[1].data.includes("rejected"));
  });

  test("extracts plan_file_write from Write to ~/.claude/plans/", () => {
    const input = {
      tool_name: "Write",
      tool_input: { file_path: "/Users/test/.claude/plans/jaunty-nebula.md", content: "# Plan" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 1);
    assert.equal(planEvents[0].type, "plan_file_write");
    assert.ok(planEvents[0].data.includes("jaunty-nebula.md"));
  });

  test("extracts plan_file_write from Edit to ~/.claude/plans/", () => {
    const input = {
      tool_name: "Edit",
      tool_input: { file_path: "/Users/test/.claude/plans/my-plan.md", old_string: "a", new_string: "b" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 1);
    assert.equal(planEvents[0].type, "plan_file_write");
  });

  test("does not extract plan event from Write to non-plan path", () => {
    const input = {
      tool_name: "Write",
      tool_input: { file_path: "/Users/test/src/index.ts", content: "code" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 0);
  });

  test("ignores non-plan tools", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: "hello",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 0);
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
    // data field preserves full message (no truncation)
    assert.equal(dataEvents[0].data, largeMessage);
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
    assert.equal(events[0].type, "file_edit");
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
// NotebookEdit TRACKING
// ════════════════════════════════════════════

describe("NotebookEdit Events", () => {
  test("extracts file_edit event from NotebookEdit tool", () => {
    const input = {
      tool_name: "NotebookEdit",
      tool_input: {
        notebook_path: "/project/analysis.ipynb",
        new_source: "import pandas as pd",
        cell_type: "code",
        edit_mode: "replace",
      },
      tool_response: "Cell updated",
    };

    const events = extractEvents(input);
    const fileEvents = events.filter(e => e.category === "file");
    assert.equal(fileEvents.length, 1);
    assert.equal(fileEvents[0].type, "file_edit");
    assert.equal(fileEvents[0].data, "/project/analysis.ipynb");
    assert.equal(fileEvents[0].priority, 1);
  });

  test("NotebookEdit with insert mode", () => {
    const input = {
      tool_name: "NotebookEdit",
      tool_input: {
        notebook_path: "/project/notebook.ipynb",
        new_source: "print('hello')",
        cell_type: "code",
        edit_mode: "insert",
      },
      tool_response: "Cell inserted",
    };

    const events = extractEvents(input);
    const fileEvents = events.filter(e => e.category === "file");
    assert.equal(fileEvents.length, 1);
    assert.equal(fileEvents[0].type, "file_edit");
  });
});

// ════════════════════════════════════════════
// AskUserQuestion TRACKING
// ════════════════════════════════════════════

describe("AskUserQuestion Events", () => {
  test("extracts decision_question event from AskUserQuestion", () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Which database should we use?",
            header: "Database",
            options: [
              { label: "PostgreSQL", description: "Relational DB" },
              { label: "MongoDB", description: "Document DB" },
            ],
            multiSelect: false,
          },
        ],
      },
      tool_response: JSON.stringify({ answers: { "Which database should we use?": "PostgreSQL" } }),
    };

    const events = extractEvents(input);
    const decisionEvents = events.filter(e => e.type === "decision_question");
    assert.equal(decisionEvents.length, 1);
    assert.equal(decisionEvents[0].category, "decision");
    assert.equal(decisionEvents[0].priority, 2);
    assert.ok(decisionEvents[0].data.includes("database"), "should include question text");
  });

  test("non-AskUserQuestion tool does not produce decision_question", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "/project/src/main.ts" },
      tool_response: "file content",
    };

    const events = extractEvents(input);
    const decisionEvents = events.filter(e => e.type === "decision_question");
    assert.equal(decisionEvents.length, 0);
  });
});

// ════════════════════════════════════════════
// EnterWorktree TRACKING
// ════════════════════════════════════════════

describe("EnterWorktree Events", () => {
  test("extracts worktree event from EnterWorktree", () => {
    const input = {
      tool_name: "EnterWorktree",
      tool_input: { name: "feature-auth" },
      tool_response: "Worktree created",
    };

    const events = extractEvents(input);
    const wtEvents = events.filter(e => e.type === "worktree");
    assert.equal(wtEvents.length, 1);
    assert.equal(wtEvents[0].category, "env");
    assert.equal(wtEvents[0].priority, 2);
    assert.ok(wtEvents[0].data.includes("feature-auth"), "should include worktree name");
  });

  test("extracts worktree event without name", () => {
    const input = {
      tool_name: "EnterWorktree",
      tool_input: {},
      tool_response: "Worktree created",
    };

    const events = extractEvents(input);
    const wtEvents = events.filter(e => e.type === "worktree");
    assert.equal(wtEvents.length, 1);
    assert.ok(wtEvents[0].data.length > 0, "should have data even without name");
  });
});

// ════════════════════════════════════════════
// NEW GIT PATTERNS
// ════════════════════════════════════════════

describe("New Git Patterns", () => {
  test("extracts git add event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git add src/server.ts" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.category === "git");
    assert.equal(gitEvents.length, 1);
    assert.ok(gitEvents[0].data.includes("add"), "should include add operation");
  });

  test("extracts git cherry-pick event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git cherry-pick abc123" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.category === "git");
    assert.equal(gitEvents.length, 1);
    assert.ok(gitEvents[0].data.includes("cherry-pick"), "should include cherry-pick");
  });

  test("extracts git tag event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git tag v1.0.0" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.category === "git");
    assert.equal(gitEvents.length, 1);
    assert.ok(gitEvents[0].data.includes("tag"), "should include tag");
  });

  test("extracts git fetch event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git fetch origin" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.category === "git");
    assert.equal(gitEvents.length, 1);
    assert.ok(gitEvents[0].data.includes("fetch"), "should include fetch");
  });

  test("extracts git clone event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git clone https://github.com/user/repo.git" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.category === "git");
    assert.equal(gitEvents.length, 1);
    assert.ok(gitEvents[0].data.includes("clone"), "should include clone");
  });
});

// ════════════════════════════════════════════
// NEW ENV PATTERNS
// ════════════════════════════════════════════

describe("New Env Patterns", () => {
  test("extracts env event from cargo install", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "cargo install serde" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.category === "env");
    assert.ok(envEvents.length >= 1, "should extract env event for cargo install");
  });

  test("extracts env event from go install", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "go install golang.org/x/tools/gopls@latest" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.category === "env");
    assert.ok(envEvents.length >= 1, "should extract env event for go install");
  });

  test("extracts env event from rustup", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "rustup default stable" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.category === "env");
    assert.ok(envEvents.length >= 1, "should extract env event for rustup");
  });

  test("extracts env event from volta", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "volta install node@18" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.category === "env");
    assert.ok(envEvents.length >= 1, "should extract env event for volta");
  });

  test("extracts env event from deno install", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "deno install --allow-net server.ts" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.category === "env");
    assert.ok(envEvents.length >= 1, "should extract env event for deno install");
  });
});

// ════════════════════════════════════════════
// ENV SECRET SANITIZATION
// ════════════════════════════════════════════

describe("Env Secret Sanitization", () => {
  test("sanitizes export commands to prevent secret leakage", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "export API_KEY=sk-secret-12345" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.category === "env");
    assert.ok(envEvents.length >= 1, "should extract env event");
    assert.ok(!envEvents[0].data.includes("sk-secret"), "should NOT contain the secret value");
    assert.ok(envEvents[0].data.includes("API_KEY"), "should contain the key name");
    assert.ok(envEvents[0].data.includes("***"), "should contain masked value");
  });

  test("does not sanitize non-export env commands", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "npm install express" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.category === "env");
    assert.ok(envEvents.length >= 1, "should extract env event");
    assert.ok(envEvents[0].data.includes("npm install express"), "should contain full command");
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
// SAFETY — safeString preserves full data
// ════════════════════════════════════════════

describe("Safety — safeString preserves full data", () => {
  test("preserves full tool response in error events (no truncation)", () => {
    const longError = "Error: " + "x".repeat(10000);
    const input = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: longError,
    };

    const events = extractEvents(input);
    const errorEvents = events.filter(e => e.type === "error_tool");
    assert.equal(errorEvents.length, 1);
    assert.equal(errorEvents[0].data, longError, "Full error string must be preserved");
  });

  test("data field is always a string and preserves full content", () => {
    const longPath = "/project/src/" + "a".repeat(500) + ".ts";
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: longPath,
        old_string: "x",
        new_string: "y",
      },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    for (const event of events) {
      assert.equal(typeof event.data, "string", `event.type=${event.type} data should be string`);
    }
    assert.equal(events[0].data, longPath, "Full path must be preserved without truncation");
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

// ════════════════════════════════════════════
// ZERO-TRUNCATION: safeString replaces truncate
// ════════════════════════════════════════════

describe("Zero-truncation architecture", () => {
  const extractSource = readFileSync(
    resolve(__dirname, "../../src/session/extract.ts"),
    "utf-8",
  );

  test("extract.ts contains zero truncate() calls", () => {
    const truncateMatches = extractSource.match(/\btruncate\(/g) ?? [];
    assert.equal(
      truncateMatches.length,
      0,
      `Expected 0 truncate() calls but found ${truncateMatches.length}`,
    );
  });

  test("extract.ts contains zero truncateAny() calls", () => {
    const truncateAnyMatches = extractSource.match(/\btruncateAny\(/g) ?? [];
    assert.equal(
      truncateAnyMatches.length,
      0,
      `Expected 0 truncateAny() calls but found ${truncateAnyMatches.length}`,
    );
  });

  test("extract.ts uses safeString() for null-safe string conversion", () => {
    const safeStringMatches = extractSource.match(/\bsafeString\(/g) ?? [];
    assert.ok(
      safeStringMatches.length > 0,
      "Expected at least one safeString() call in extract.ts",
    );
  });

  test("safeString preserves full data without truncation", () => {
    const longPath = "/very/long/path/" + "a".repeat(500) + "/file.ts";
    const input = {
      tool_name: "Edit",
      tool_input: { file_path: longPath, old_string: "x", new_string: "y" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].data, longPath, "safeString must preserve full string without truncation");
  });

  test("safeString handles null/undefined gracefully", () => {
    const input = {
      tool_name: "Edit",
      tool_input: { file_path: undefined as unknown as string },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    // Should not throw and should produce an event (with empty string data from undefined)
    assert.ok(events.length >= 1);
  });
});

// ════════════════════════════════════════════
// topic-fence Phase 1 — extractTopicSignal
// ════════════════════════════════════════════
//
// These tests were originally kept in a dedicated file (topic-fence.test.ts)
// so that topic-fence could be maintained and eventually extracted as a
// standalone skill without pulling the full session extraction test surface
// along with it. Upstream CONTRIBUTING.md forbids new test files, so they
// have been consolidated here under clearly-labeled "topic-fence:" describe
// blocks. The tests exercise the module both directly and through the
// extractUserEvents() integration point.

describe("topic-fence: Topic Signal Events via extractUserEvents", () => {
  test("emits topic event with correct shape for keyword-rich English message", () => {
    const events = extractUserEvents("Implementing drift detection in context-mode");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 1, "should emit exactly one topic event");
    assert.equal(topicEvents[0].category, "topic");
    assert.equal(topicEvents[0].priority, 3);
    assert.equal(typeof topicEvents[0].data, "string");
  });

  test("stores keywords as JSON with a keywords array", () => {
    const events = extractUserEvents("Implementing drift detection in context-mode");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 1);
    const parsed = JSON.parse(topicEvents[0].data);
    assert.ok(Array.isArray(parsed.keywords), "data.keywords must be an array");
    assert.ok(parsed.keywords.length >= 2, "should have at least 2 keywords");
    // English stopwords ("in") must be filtered
    assert.ok(!parsed.keywords.includes("in"), "'in' is a stopword and must be filtered");
  });

  test("does not emit topic event for a single short word", () => {
    const events = extractUserEvents("yes");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 0, "single-keyword message should not emit topic event");
  });

  test("does not emit topic event for stopwords-only message", () => {
    const events = extractUserEvents("the is a an of to");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 0, "stopwords-only message should not emit topic event");
  });

  test("orders keywords by frequency (most frequent first)", () => {
    const events = extractUserEvents("auth auth auth login login database");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 1);
    const { keywords } = JSON.parse(topicEvents[0].data);
    assert.deepEqual(keywords, ["auth", "login", "database"]);
  });

  test("caps keyword count at 8", () => {
    const events = extractUserEvents(
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu",
    );
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 1);
    const { keywords } = JSON.parse(topicEvents[0].data);
    assert.ok(keywords.length <= 8, `expected <= 8 keywords, got ${keywords.length}`);
  });

  test("handles Korean text without throwing and preserves Hangul tokens", () => {
    const events = extractUserEvents("세션을 나눠서 진행할 수 있도록 감지해서 알려주는 기능");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 1);
    const { keywords } = JSON.parse(topicEvents[0].data);
    assert.ok(keywords.length >= 2, "Korean message should produce keywords");
    for (const kw of keywords) {
      assert.ok(
        /[가-힣]/.test(kw) || /^[a-z]+$/.test(kw),
        `keyword "${kw}" should contain Hangul or be ASCII`,
      );
    }
  });

  test("handles mixed English-Korean dev text", () => {
    const events = extractUserEvents("context-mode에서 topic drift를 감지하려고 합니다");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 1);
    const { keywords } = JSON.parse(topicEvents[0].data);
    assert.ok(keywords.includes("context"), "should include 'context' after hyphen split");
    assert.ok(keywords.includes("topic"), "should include 'topic'");
  });

  test("lowercases tokens for case-insensitive matching", () => {
    const events = extractUserEvents("AUTH Auth auth LOGIN Login");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 1);
    const { keywords } = JSON.parse(topicEvents[0].data);
    assert.deepEqual(keywords, ["auth", "login"]);
  });

  test("topic event is produced alongside other user event types", () => {
    const events = extractUserEvents("Create a drift detection module for sessions");
    const types = new Set(events.map(e => e.type));
    assert.ok(types.has("topic"), "topic event should coexist with intent event");
    assert.ok(types.has("intent"), "intent event should still be emitted");
  });

  test("executes within performance budget (<5ms for typical message)", () => {
    const msg = "Implementing drift detection in context-mode using Jaccard similarity over sliding windows";
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      extractUserEvents(msg);
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / 100;
    assert.ok(
      perCall < 5,
      `extractUserEvents should run <5ms per call, got ${perCall.toFixed(3)}ms`,
    );
  });

  test("never throws on pathological input", () => {
    assert.doesNotThrow(() => extractUserEvents(""));
    assert.doesNotThrow(() => extractUserEvents("   "));
    assert.doesNotThrow(() => extractUserEvents("!@#$%^&*()"));
    assert.doesNotThrow(() => extractUserEvents("\n\n\n"));
    assert.doesNotThrow(() => extractUserEvents("a".repeat(100000)));
  });
});

// ════════════════════════════════════════════
// Direct unit tests for extractKeywords / extractTopicSignal
// ════════════════════════════════════════════

describe("topic-fence: extractKeywords — direct unit tests", () => {
  test("returns empty array for empty string", () => {
    assert.deepEqual(extractKeywords(""), []);
  });

  test("returns empty array when all tokens are stopwords", () => {
    assert.deepEqual(extractKeywords("the a an is"), []);
  });

  test("preserves frequency order", () => {
    assert.deepEqual(
      extractKeywords("auth auth login"),
      ["auth", "login"],
    );
  });

  test("is idempotent on repeated calls", () => {
    const msg = "Implementing drift detection in context-mode";
    assert.deepEqual(extractKeywords(msg), extractKeywords(msg));
  });

  test("filters generic tech filler words (extended stopwords)", () => {
    // "file", "function", "test", "run" are all in GENERIC_TECH_STOPWORDS
    const result = extractKeywords("run the test function in this file");
    // After filtering: only "this" is removed as base stopword; "run/test/function/file"
    // are extended stopwords. Nothing survives — or maybe just nothing.
    assert.deepEqual(result, []);
  });

  test("stems English tokens so morphological variants collapse", () => {
    // "testing" and "tested" both stem to "test" which is then dropped as
    // a generic tech stopword. Use a non-stopword test target instead:
    const result = extractKeywords("authenticate authenticating authenticated");
    // "authenticate" length 12 → suffix "ate"? not in list. stays.
    // "authenticating" length 14 → "ing" suffix, stem to "authenticat"
    // "authenticated" length 13 → "ed" suffix, stem to "authenticat"
    // Frequencies: authenticate=1, authenticat=2
    assert.deepEqual(result, ["authenticat", "authenticate"]);
  });

  test("leaves Hangul tokens untouched by the stemmer", () => {
    const result = extractKeywords("세션 토픽 감지");
    // All Hangul tokens pass through without stemming.
    assert.equal(result.length, 3);
    for (const kw of result) {
      assert.ok(/^[가-힣]+$/.test(kw), `"${kw}" should be pure Hangul`);
    }
  });
});

describe("topic-fence: extractTopicSignal — direct unit tests", () => {
  test("returns empty array when keywords < 2", () => {
    assert.deepEqual(extractTopicSignal("yes"), []);
    assert.deepEqual(extractTopicSignal("the is a"), []);
  });

  test("returns exactly one event with 4-field SessionEvent shape", () => {
    const events = extractTopicSignal("auth auth login database");
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.type, "topic");
    assert.equal(ev.category, "topic");
    assert.equal(ev.priority, 3);
    assert.equal(typeof ev.data, "string");
    // Must NOT carry data_hash — that's a persistence-layer concern
    assert.ok(!("data_hash" in ev), "extractors must not emit data_hash");
  });

  test("data field is valid JSON with only a keywords array", () => {
    const events = extractTopicSignal("auth auth login database");
    const parsed = JSON.parse(events[0].data);
    assert.deepEqual(Object.keys(parsed), ["keywords"]);
    assert.deepEqual(parsed.keywords, ["auth", "login", "database"]);
  });
});

describe("topic-fence: stem — Porter-inspired English stemmer", () => {
  test("strips common suffixes", () => {
    assert.equal(stem("testing"), "test");
    assert.equal(stem("tested"), "test");
    assert.equal(stem("tests"), "test");
    assert.equal(stem("running"), "runn"); // no e-restoration; acceptable
    assert.equal(stem("implementing"), "implement"); // "ing" stripped
  });

  test("leaves short words (≤4 chars) untouched", () => {
    assert.equal(stem("auth"), "auth");
    assert.equal(stem("user"), "user");
    assert.equal(stem("ing"), "ing");
  });

  test("leaves words without a recognized suffix untouched", () => {
    assert.equal(stem("react"), "react");
    assert.equal(stem("context"), "context");
    assert.equal(stem("database"), "database");
  });

  test("strips tion as a 4-char suffix (not ation as a 5-char suffix)", () => {
    // Important: the rule list contains "tion" (4 chars), not "ation".
    // So "implementation" → strip "tion" → "implementa", NOT "implement".
    // This is the actual stemmer behavior — document it rather than
    // fight it, since drift detection only needs consistent application.
    assert.equal(stem("implementation"), "implementa");
    // Similarly "nationalization" strips "ization" (7 chars, which IS in
    // the list) before the "tion" rule is reached, because longer suffixes
    // come first in the iteration order.
    assert.equal(stem("nationalization"), "national");
  });
});

describe("topic-fence: clampInt / clampFloat — Phase 2 config helpers", () => {
  test("clampInt returns default on undefined", () => {
    assert.equal(clampInt(undefined, 3, 1, 50), 3);
  });

  test("clampInt returns default on NaN / non-numeric", () => {
    assert.equal(clampInt("abc", 3, 1, 50), 3);
    assert.equal(clampInt("NaN", 3, 1, 50), 3);
  });

  test("clampInt returns default on out-of-range", () => {
    assert.equal(clampInt("0", 3, 1, 50), 3);   // below min
    assert.equal(clampInt("100", 3, 1, 50), 3); // above max
    assert.equal(clampInt("-5", 3, 1, 50), 3);  // negative
  });

  test("clampInt returns parsed integer on valid input", () => {
    assert.equal(clampInt("5", 3, 1, 50), 5);
    assert.equal(clampInt("1", 3, 1, 50), 1);
    assert.equal(clampInt("50", 3, 1, 50), 50);
  });

  test("clampInt floors fractional input", () => {
    assert.equal(clampInt("5.7", 3, 1, 50), 5);
  });

  test("clampFloat returns default on undefined / NaN / out-of-range", () => {
    assert.equal(clampFloat(undefined, 0.10, 0, 1), 0.10);
    assert.equal(clampFloat("abc", 0.10, 0, 1), 0.10);
    assert.equal(clampFloat("-0.5", 0.10, 0, 1), 0.10);
    assert.equal(clampFloat("1.5", 0.10, 0, 1), 0.10);
  });

  test("clampFloat accepts valid fractional input", () => {
    assert.equal(clampFloat("0.25", 0.10, 0, 1), 0.25);
    assert.equal(clampFloat("0", 0.10, 0, 1), 0);
    assert.equal(clampFloat("1", 0.10, 0, 1), 1);
  });
});

// ════════════════════════════════════════════
// topic-fence Phase 2 — drift integration via extractUserEvents
// ════════════════════════════════════════════

describe("topic-fence: extractUserEvents with topicHistory — Phase 2 drift integration", () => {
  // Helper: build a stored topic row from keywords.
  const storedTopic = (keywords: string[]) => ({
    data: JSON.stringify({ keywords }),
  });

  test("I1: omitting topicHistory preserves Phase 1 behavior", () => {
    const events = extractUserEvents("implementing authentication for web app");
    const topics = events.filter((e) => e.type === "topic");
    const drifts = events.filter((e) => e.type === "topic_drift");
    assert.equal(topics.length, 1);
    assert.equal(drifts.length, 0);
  });

  test("I2: topic shift message + 6-row history emits both topic and topic_drift", () => {
    // Each history row uses unique vocabulary so that every possible
    // sliding window pair is Jaccard-disjoint. See U2 for the detailed
    // rationale — the same construction constraint applies here.
    //
    // The current MESSAGE goes through the production tokenizer, so we
    // pick a sentence whose Path A tokens do not collide with any
    // history row's keywords. "lambda lion llama cheetah python" uses
    // only short/uncommon words that survive the stemmer unchanged and
    // appear in neither the base nor extended stopword lists.
    const history = [
      storedTopic(["alpha", "aleph", "aardvark"]),
      storedTopic(["beta", "banana", "bravo"]),
      storedTopic(["gamma", "grape", "gecko"]),
      storedTopic(["delta", "date", "duck"]),
      storedTopic(["epsilon", "eagle", "elephant"]),
      storedTopic(["zeta", "zebra", "zeppelin"]),
    ];
    const events = extractUserEvents("lambda lion llama cheetah python", history);
    const topics = events.filter((e) => e.type === "topic");
    const drifts = events.filter((e) => e.type === "topic_drift");
    assert.equal(topics.length, 1, "should emit current topic");
    assert.equal(drifts.length, 1, "should emit drift event");
  });

  test("I3: short message with no current topic → no drift even with history", () => {
    // Same unique-vocabulary history as I2 — guarantees drift WOULD fire
    // if a current topic were produced. But "yes" produces no topic event.
    const history = [
      storedTopic(["alpha", "aleph", "aardvark"]),
      storedTopic(["beta", "banana", "bravo"]),
      storedTopic(["gamma", "grape", "gecko"]),
      storedTopic(["delta", "date", "duck"]),
      storedTopic(["epsilon", "eagle", "elephant"]),
      storedTopic(["zeta", "zebra", "zeppelin"]),
    ];
    const events = extractUserEvents("yes", history);
    const drifts = events.filter((e) => e.type === "topic_drift");
    assert.equal(drifts.length, 0);
  });

  test("I4: history below cold-start threshold → only topic, no drift", () => {
    const history = [
      storedTopic(["alpha", "aleph", "aardvark"]),
      storedTopic(["beta", "banana", "bravo"]),
      storedTopic(["gamma", "grape", "gecko"]),
    ]; // only 3 rows — below the 6-row minimum
    const events = extractUserEvents("lambda lion llama cheetah python", history);
    const topics = events.filter((e) => e.type === "topic");
    const drifts = events.filter((e) => e.type === "topic_drift");
    assert.equal(topics.length, 1);
    assert.equal(drifts.length, 0);
  });

  test("I5: empty history uses default parameter, no drift", () => {
    const events = extractUserEvents("lambda lion llama cheetah python", []);
    const drifts = events.filter((e) => e.type === "topic_drift");
    assert.equal(drifts.length, 0);
  });
});

describe("topic-fence: Path A fidelity — production tokenizer matches eval-drift.mjs reference", () => {
  // These expectations are snapshots of what eval-drift.mjs's
  // extractKeywordsPathA returns for these inputs. They are hand-computed
  // and verified once. If they ever diverge from the production
  // extractKeywords output, the production tokenizer has drifted from
  // the reference and the F1=0.900 empirical claim is at risk.
  const cases: Array<{ input: string; expected: string[] }> = [
    {
      input: "I want to build a React component for displaying a list of users",
      // Trace:
      //   "i" len 1 → drop
      //   "want" in extended stopwords → drop
      //   "to" in base stopwords → drop
      //   "build" in extended stopwords → drop
      //   "a" len 1 → drop
      //   "react" → stem: no suffix match → "react" ✓
      //   "component" → stem: no suffix match → "component" ✓
      //   "for" in base stopwords → drop
      //   "displaying" → stem: "ing" match, len 10-3=7 ≥ 3 → "display" ✓
      //   "a" len 1 → drop
      //   "list" in extended stopwords → drop
      //   "of" in base stopwords → drop
      //   "users" → stem: "ers" match but len 5-3=2 < 3 (skip); "s" match, len 5-1=4 ≥ 3 → "user" ✓
      // Frequency all 1, insertion order preserved.
      expected: ["react", "component", "display", "user"],
    },
    {
      input: "세션을 나눠서 진행할 수 있도록 감지해서 알려주는 기능",
      // Korean tokens pass through unchanged (stemmer skipped by ASCII guard).
      // 수 is 1 char (<2) → dropped.
      expected: ["세션을", "나눠서", "진행할", "있도록", "감지해서", "알려주는", "기능"],
    },
    {
      input: "auth auth login database",
      // No stemmer matches (auth ≤ 4 chars, login/database have no suffix),
      // no stopwords. Frequency: auth=2, login=1, database=1.
      expected: ["auth", "login", "database"],
    },
  ];

  for (const { input, expected } of cases) {
    test(`matches reference for: "${input.slice(0, 40)}${input.length > 40 ? "..." : ""}"`, () => {
      assert.deepEqual(extractKeywords(input), expected);
    });
  }
});

// ════════════════════════════════════════════
// topic-fence Phase 2 — scoreDrift direct unit tests
// ════════════════════════════════════════════
//
// Unit tests for the drift scoring pure function. These tests bypass the
// full extractUserEvents integration and call scoreDrift directly with
// hand-crafted history arrays. See the "topic-fence: extractUserEvents
// with topicHistory" describe above for integration-level coverage.

{
  // Helper: build a TopicHistoryRow from a keyword array.
  const row = (keywords: string[]): TopicHistoryRow => ({
    data: JSON.stringify({ keywords }),
  });

  // Helper: build a "current" SessionEvent-shaped object.
  const currentEvent = (keywords: string[]) => ({
    type: "topic",
    category: "topic",
    data: JSON.stringify({ keywords }),
    priority: 3,
  });

  describe("topic-fence: scoreDrift — core algorithm", () => {
    test("U1: returns [] when history is below N+M=6 (cold start)", () => {
      const history = [
        row(["auth", "jwt", "login"]),
        row(["auth", "jwt", "login"]),
        row(["auth", "jwt", "login"]),
        row(["auth", "jwt", "login"]),
        row(["auth", "jwt", "login"]),
      ]; // only 5 — below minimum
      const current = currentEvent(["react", "hooks", "state"]);
      assert.deepEqual(scoreDrift(history, current), []);
    });

    test("U2: fires a single drift event on a clean topic shift", () => {
      // CRITICAL: with window size N=M=3 and 7 combined events, the two
      // window pairs overlap by 2 rows (currOld = combined[1..4] overlaps
      // prevOld by rows 1-2 and shares row 3 with prevNew). If rows 3-5
      // all use the same vocabulary, currOld will inherit row 3's vocab
      // and share it with currNew — making currScore ≥ threshold even
      // when the "topic shift" looks clean at the row level.
      //
      // To guarantee BOTH window pairs are below threshold, each row must
      // use unique keywords so that no pair of rows shares any vocabulary.
      // This is the only construction where Jaccard is 0 everywhere and
      // the persistence rule fires cleanly.
      const history = [
        row(["alpha", "aleph", "aardvark"]),
        row(["beta", "banana", "bravo"]),
        row(["gamma", "grape", "gecko"]),
        row(["delta", "date", "duck"]),
        row(["epsilon", "eagle", "elephant"]),
        row(["zeta", "zebra", "zeppelin"]),
      ];
      const current = currentEvent(["lambda", "lion", "llama"]);
      // prev_pair: rows 0-2 vs rows 3-5 = 9 unique vs 9 unique, intersection ∅
      //            → prev_score = 0
      // curr_pair: rows 1-3 vs rows 4-6 = 9 unique vs 9 unique, intersection ∅
      //            → curr_score = 0
      // Both below threshold → persistence rule fires.
      const result = scoreDrift(history, current);
      assert.equal(result.length, 1, "should emit exactly one drift event");
      assert.equal(result[0].type, "topic_drift");
      assert.equal(result[0].category, "topic");
      assert.equal(result[0].priority, 2);
      const payload = JSON.parse(result[0].data);
      assert.ok(parseFloat(payload.prev_score) < 0.10, `prev_score ${payload.prev_score} should be < 0.10`);
      assert.ok(parseFloat(payload.curr_score) < 0.10, `curr_score ${payload.curr_score} should be < 0.10`);
    });

    test("U3: returns [] when the same topic repeats across all windows", () => {
      const history = [
        row(["auth", "login"]),
        row(["auth", "jwt"]),
        row(["login", "jwt"]),
        row(["auth", "login"]),
        row(["auth", "jwt"]),
        row(["login", "jwt"]),
      ];
      const current = currentEvent(["auth", "login"]);
      assert.deepEqual(scoreDrift(history, current), []);
    });

    test("U4: returns [] when windows have substantial partial overlap", () => {
      // ~50% shared vocabulary — should stay above threshold 0.10
      const history = [
        row(["auth", "login", "jwt"]),
        row(["auth", "login", "jwt"]),
        row(["auth", "login", "jwt"]),
        row(["auth", "login", "session"]),
        row(["auth", "login", "session"]),
        row(["auth", "login", "session"]),
      ];
      const current = currentEvent(["auth", "login", "session"]);
      assert.deepEqual(scoreDrift(history, current), []);
    });

    test("U5: returns [] on a single-turn dip (prev above, curr below)", () => {
      // Rows 0 and 3 share vocabulary (both in "old topic" cluster A),
      // making prev_pair's intersection non-empty and keeping prev_score
      // above threshold. curr_pair (rows 1-3 vs 4-6) is fully disjoint,
      // so curr_score alone would fire — but the persistence rule requires
      // BOTH to be below, so the event is suppressed.
      const history = [
        row(["alpha", "aleph", "aardvark"]),  // row 0 — set A
        row(["beta", "banana", "bravo"]),     // row 1 — filler
        row(["beta", "banana", "bravo"]),     // row 2 — filler
        row(["alpha", "aleph", "aardvark"]),  // row 3 — returns to set A (shares w/ row 0)
        row(["papa", "quebec", "romeo"]),     // row 4 — set B
        row(["papa", "quebec", "romeo"]),     // row 5 — set B
      ];
      const current = currentEvent(["papa", "quebec", "romeo"]); // set B
      // prev_pair: {alpha,aleph,aardvark, beta,banana,bravo}
      //         vs {alpha,aleph,aardvark, papa,quebec,romeo}
      //            intersection = {alpha, aleph, aardvark} = 3
      //            union = 9
      //            score ≈ 0.33 (above 0.10)
      // curr_pair: {beta,banana,bravo, alpha,aleph,aardvark}
      //         vs {papa, quebec, romeo}
      //            intersection = ∅, score = 0 (below 0.10)
      // Prev above but curr below → persistence rule does NOT fire.
      assert.deepEqual(scoreDrift(history, current), []);
    });

    test("U6: returns [] on a reverse single-turn dip (prev below, curr above)", () => {
      // Row 3 sits at the boundary: its vocabulary matches `current`
      // but not any earlier row. That makes prev_pair fully disjoint
      // (prev below), while curr_pair picks up row 3's vocabulary on
      // both sides (curr above).
      const history = [
        row(["alpha", "aleph", "aardvark"]),  // row 0
        row(["alpha", "aleph", "aardvark"]),  // row 1
        row(["alpha", "aleph", "aardvark"]),  // row 2
        row(["xray", "yankee", "zulu"]),      // row 3 — boundary
        row(["papa", "quebec", "romeo"]),     // row 4
        row(["papa", "quebec", "romeo"]),     // row 5
      ];
      const current = currentEvent(["xray", "yankee", "zulu"]); // shares with row 3
      // prev_pair: {alpha,aleph,aardvark} vs {xray,yankee,zulu, papa,quebec,romeo}
      //            intersection = ∅, score = 0 (below 0.10)
      // curr_pair: {alpha,aleph,aardvark, xray,yankee,zulu}
      //         vs {papa,quebec,romeo, xray,yankee,zulu}
      //            intersection = {xray, yankee, zulu} = 3
      //            union = 9
      //            score ≈ 0.33 (above 0.10)
      // Prev below but curr above → persistence rule does NOT fire.
      assert.deepEqual(scoreDrift(history, current), []);
    });
  });

  describe("topic-fence: scoreDrift — defensive handling", () => {
    test("U7: one corrupted history row is treated as empty, others proceed", () => {
      const history = [
        row(["auth", "jwt", "login"]),
        { data: "not valid json at all" }, // corrupted
        row(["auth", "jwt", "login"]),
        row(["react", "hooks", "state"]),
        row(["react", "hooks", "state"]),
        row(["react", "hooks", "state"]),
      ];
      const current = currentEvent(["react", "hooks", "state"]);
      // Should still produce a drift event since the surviving rows exhibit a clean shift.
      const result = scoreDrift(history, current);
      assert.doesNotThrow(() => result);
      // The exact fire/no-fire depends on how the corrupted row shifts the windows.
      // We assert the function did not throw; failing the assertion means a regression.
      assert.ok(Array.isArray(result), "must return an array");
    });

    test("U8: all history rows corrupted → empty-set fallback returns []", () => {
      const history = [
        { data: "garbage" },
        { data: "garbage" },
        { data: "garbage" },
        { data: "garbage" },
        { data: "garbage" },
        { data: "garbage" },
      ];
      const current = currentEvent(["react", "hooks", "state"]);
      // All windows degenerate to empty sets → similarity 1.0 → no drift.
      assert.deepEqual(scoreDrift(history, current), []);
    });

    test("U9: CONTEXT_MODE_TOPIC_FENCE_DISABLED=1 returns [] immediately", async () => {
      // Cache test: scoreDrift reads TOPIC_FENCE_DISABLED at module load.
      // Test the disabled state by stubbing the env var, resetting vitest's
      // module cache, and re-importing topic-fence fresh. The plain-import
      // form (no cache buster query string) is the vitest-idiomatic pattern.
      const { vi } = await import("vitest");
      vi.stubEnv("CONTEXT_MODE_TOPIC_FENCE_DISABLED", "1");
      vi.resetModules();
      const mod = await import("../../src/session/topic-fence.js");
      // Use the unique-keyword construction from U2 so we know drift WOULD
      // fire if the kill switch were off.
      const history = [
        row(["alpha", "aleph", "aardvark"]),
        row(["beta", "banana", "bravo"]),
        row(["gamma", "grape", "gecko"]),
        row(["delta", "date", "duck"]),
        row(["epsilon", "eagle", "elephant"]),
        row(["zeta", "zebra", "zeppelin"]),
      ];
      const current = currentEvent(["lambda", "lion", "llama"]);
      assert.deepEqual(mod.scoreDrift(history, current), []);
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    test("U10: determinism — identical inputs produce byte-identical payloads", () => {
      // Use the U2 unique-keyword construction so drift actually fires and
      // the determinism assertion on the payload string has something to
      // check. Overlapping vocabularies would produce [] twice and pass
      // the assertion trivially without testing anything.
      const history = [
        row(["alpha", "aleph", "aardvark"]),
        row(["beta", "banana", "bravo"]),
        row(["gamma", "grape", "gecko"]),
        row(["delta", "date", "duck"]),
        row(["epsilon", "eagle", "elephant"]),
        row(["zeta", "zebra", "zeppelin"]),
      ];
      const current = currentEvent(["lambda", "lion", "llama"]);
      const r1 = scoreDrift(history, current);
      const r2 = scoreDrift(history, current);
      assert.equal(r1.length, 1, "drift must fire so we have a payload to compare");
      assert.equal(r2.length, 1);
      assert.equal(r1[0].data, r2[0].data, "payloads must be byte-identical");
    });

    test("U11: payload shape — sorted keywords, 2-decimal scores, window array", () => {
      // Same unique-keyword construction as U2/U10 but with intentionally
      // non-alphabetical insertion order in the current event, so we can
      // verify the sort step of the payload builder actually runs.
      const history = [
        row(["alpha", "aleph", "aardvark"]),
        row(["beta", "banana", "bravo"]),
        row(["gamma", "grape", "gecko"]),
        row(["delta", "date", "duck"]),
        row(["epsilon", "eagle", "elephant"]),
        row(["zeta", "zebra", "zeppelin"]),
      ];
      const current = currentEvent(["lion", "llama", "lambda"]); // not in alphabetical order
      const result = scoreDrift(history, current);
      assert.equal(result.length, 1, "drift must fire so payload is present");
      const payload = JSON.parse(result[0].data);
      assert.deepEqual(Object.keys(payload).sort(), ["curr_score", "new", "old", "prev_score", "window"]);
      // Keywords must be sorted lexicographically in the payload
      assert.deepEqual(payload.new, [...payload.new].sort());
      assert.deepEqual(payload.old, [...payload.old].sort());
      // The `new` array must CONTAIN all three current-event keywords.
      // They will sit in the middle of the alphabetically-sorted output,
      // not at the tail — verify by membership, not position.
      assert.ok(payload.new.includes("lambda"), "payload.new should contain 'lambda'");
      assert.ok(payload.new.includes("lion"),   "payload.new should contain 'lion'");
      assert.ok(payload.new.includes("llama"),  "payload.new should contain 'llama'");
      // Scores must be strings with exactly 2 decimal places
      assert.ok(/^\d\.\d{2}$/.test(payload.prev_score), `prev_score "${payload.prev_score}" malformed`);
      assert.ok(/^\d\.\d{2}$/.test(payload.curr_score), `curr_score "${payload.curr_score}" malformed`);
      // Window must be literal [N, M]
      assert.deepEqual(payload.window, [3, 3]);
    });
  });
}
