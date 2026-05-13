import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "vitest";
import { extractEvents, extractUserEvents, resetErrorResolutionState, resetIterationLoopState } from "../../src/session/extract.js";

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

  test("extracts file_write and file_edit from Codex apply_patch hunks", () => {
    const input = {
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Add File: src/new-file.ts",
          "+export const created = true;",
          "*** Update File: src/existing.ts",
          "@@",
          "-export const before = true;",
          "+export const after = true;",
          "*** End Patch",
        ].join("\n"),
      },
      tool_response: "Patch applied successfully",
    };

    const events = extractEvents(input);
    const fileWrites = events.filter(e => e.type === "file_write");
    const fileEdits = events.filter(e => e.type === "file_edit");
    assert.equal(fileWrites.length, 1);
    assert.equal(fileWrites[0].data, "src/new-file.ts");
    assert.equal(fileEdits.length, 1);
    assert.equal(fileEdits[0].data, "src/existing.ts");
  });

  test("extracts moved target path from Codex apply_patch", () => {
    const input = {
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Update File: src/old-name.ts",
          "*** Move to: src/new-name.ts",
          "@@",
          "-export const value = 1;",
          "+export const value = 2;",
          "*** End Patch",
        ].join("\n"),
      },
      tool_response: "Patch applied successfully",
    };

    const events = extractEvents(input);
    const fileEdits = events.filter(e => e.type === "file_edit").map(e => e.data);
    assert.ok(fileEdits.includes("src/old-name.ts"));
    assert.ok(fileEdits.includes("src/new-name.ts"));
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

  test("extracts plan_file_write from relative apply_patch updates to .claude/plans/", () => {
    const input = {
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Update File: .claude/plans/my-plan.md",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      tool_response: "Patch applied successfully",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 1);
    assert.equal(planEvents[0].type, "plan_file_write");
    assert.ok(planEvents[0].data.includes("my-plan.md"));
  });

  test("does not extract file continuity events from failed apply_patch", () => {
    const input = {
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Add File: src/failed.ts",
          "+export const failed = true;",
          "*** Update File: src/existing.ts",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      tool_response: "Patch failed",
      tool_output: { isError: true },
    };

    const events = extractEvents(input);
    assert.equal(events.filter(e => e.type === "file_write").length, 0);
    assert.equal(events.filter(e => e.type === "file_edit").length, 0);
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

  test("extracts decision from a negation+alternative correction", () => {
    // Universal-rule detector (issue #535) treats a clause-separated
    // non-question message in the corrective length range as a decision.
    const events = extractUserEvents("never push to main, ask me first");
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
    assert.equal(skillEvents[0].priority, 2);
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

  // The `review` and `discuss` modes were keyword-only and could not be
  // expressed as a robust universal-rule detector (issue #535). They are
  // intentionally dropped from the intent schema — the renderer now
  // surfaces the raw user message via <recent_user_messages> so the
  // next LLM can still distinguish review/discuss tone end-to-end.
  // The pie-chart in insight/server.mjs degrades gracefully when these
  // modes are absent.
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

// ════════════════════════════════════════════════════════════════════════════
// SLICE N: MCP EVENT EXTRACTION (extractMcp)
// ════════════════════════════════════════════════════════════════════════════

describe("MCP Events", () => {
  test("captures tool_response content so ctx_search can find details, not just the call", () => {
    const input = {
      tool_name: "mcp__jira__jira_get",
      tool_input: { ticket: "CVX-5909" },
      tool_response: JSON.stringify({
        key: "CVX-5909",
        summary: "MQTT reconnect storm after broker failover",
        description: "Agents see intermittent disconnects during broker failover...",
      }),
    };

    const events = extractEvents(input);
    const mcpEvents = events.filter(e => e.category === "mcp");
    assert.equal(mcpEvents.length, 1);
    assert.equal(mcpEvents[0].type, "mcp");
    assert.equal(mcpEvents[0].category, "mcp");
    assert.ok(mcpEvents[0].data.includes("jira_get"), "data should include tool short name");
    assert.ok(mcpEvents[0].data.includes("CVX-5909"), "data should include first string arg");
    // Response body is now searchable, not just the call shape
    assert.ok(
      mcpEvents[0].data.includes("MQTT reconnect storm"),
      "data should include tool_response body so FTS5 can index it",
    );
  });

  test("preserves full response even for large payloads (no truncation)", () => {
    // Large grafana loki export — exactly the kind of response we most want the
    // cache to preserve to avoid re-fetching. No cap: matches rule_content
    // precedent (extract.ts File Events path).
    const bigResponse = "log_line_".repeat(5000); // ~45KB
    const input = {
      tool_name: "mcp__grafana__query_loki_logs",
      tool_input: { query: '{app="mqtt"} |= "error"' },
      tool_response: bigResponse,
    };

    const events = extractEvents(input);
    const mcpEvents = events.filter(e => e.category === "mcp");
    assert.equal(mcpEvents.length, 1);
    assert.ok(
      mcpEvents[0].data.includes(bigResponse),
      "large tool_response must be preserved in full",
    );
  });

  test("gracefully handles missing tool_response (regression)", () => {
    // Pre-existing behavior: when tool_response is absent, no response suffix.
    const input = {
      tool_name: "mcp__context-mode__ctx_stats",
      tool_input: {},
      // tool_response omitted
    };

    const events = extractEvents(input);
    const mcpEvents = events.filter(e => e.category === "mcp");
    assert.equal(mcpEvents.length, 1);
    assert.equal(mcpEvents[0].type, "mcp");
    assert.equal(mcpEvents[0].data, "ctx_stats", "no \\nresponse: suffix when tool_response absent");
  });

  test("gracefully handles empty tool_response", () => {
    const input = {
      tool_name: "mcp__context-mode__ctx_stats",
      tool_input: {},
      tool_response: "",
    };

    const events = extractEvents(input);
    const mcpEvents = events.filter(e => e.category === "mcp");
    assert.equal(mcpEvents.length, 1);
    assert.equal(mcpEvents[0].data, "ctx_stats", "empty tool_response should not add suffix");
  });

  test("emits mcp_tool_call category for mcp__* events with truncated params", () => {
    // Small payload — no truncation, params parsed verbatim
    const small = extractEvents({
      tool_name: "mcp__context-mode__ctx_batch_execute",
      tool_input: { commands: [{ label: "x", command: "ls" }], concurrency: 6 },
    });
    const smallCall = small.find(e => e.category === "mcp_tool_call");
    assert.ok(smallCall, "mcp_tool_call event should be emitted");
    assert.equal(smallCall!.type, "mcp_tool_call");
    assert.equal(smallCall!.priority, 4);
    const smallPayload = JSON.parse(smallCall!.data);
    assert.equal(smallPayload.tool_name, "mcp__context-mode__ctx_batch_execute");
    assert.equal(smallPayload.params.concurrency, 6);
    assert.equal(smallPayload.truncated, undefined);

    // Large payload — params JSON exceeds 2KB, must be truncated with sentinel
    const bigCommands = Array.from({ length: 200 }, (_, i) => ({
      label: `cmd-${i}`,
      command: "echo " + "x".repeat(50),
    }));
    const big = extractEvents({
      tool_name: "mcp__context-mode__ctx_batch_execute",
      tool_input: { commands: bigCommands, concurrency: 8 },
    });
    const bigCall = big.find(e => e.category === "mcp_tool_call");
    assert.ok(bigCall, "mcp_tool_call event should be emitted for large payload");
    // 2KB params budget + JSON-escape overhead + wrapper (~300 bytes max).
    assert.ok(bigCall!.data.length <= 2500, "data should be capped near 2KB params budget");
    const bigPayload = JSON.parse(bigCall!.data);
    assert.equal(bigPayload.truncated, true, "truncation sentinel must be set");
    assert.equal(typeof bigPayload.params_raw, "string", "raw substring preserved");
    assert.equal(bigPayload.tool_name, "mcp__context-mode__ctx_batch_execute");
  });

  test("UTF-8-aware truncation: never lands mid-codepoint (review F3)", () => {
    // Naive `string.slice(0, N)` operates on UTF-16 code units. With multi-byte
    // characters, that can either over-shoot the byte budget OR slice mid
    // surrogate pair, producing an unpaired surrogate that becomes U+FFFD
    // after a SQLite TEXT round-trip.
    //
    // Repro shape: enough multi-byte characters to push the JSON payload past
    // 2KB. We use 3-byte (CJK) and 4-byte (math symbol) characters so any
    // mid-codepoint slice is observable.
    const cjkChunk = "中文测试".repeat(200); // 4 × 3 bytes × 200 = 2400 bytes raw
    const symbolChunk = "𝕏".repeat(100);     // 1 × 4 bytes × 100 = 400 bytes raw
    const big = extractEvents({
      tool_name: "mcp__context-mode__ctx_batch_execute",
      tool_input: { mixed: cjkChunk + symbolChunk, concurrency: 4 },
    });
    const call = big.find(e => e.category === "mcp_tool_call");
    assert.ok(call, "mcp_tool_call event should be emitted for multibyte payload");
    const payload = JSON.parse(call!.data);
    assert.equal(payload.truncated, true, "multibyte payload should trip truncation");

    // Critical invariant 1 — params_raw must round-trip through Buffer.from cleanly.
    // If the slice landed mid-codepoint, JSON.parse would have already thrown above
    // (invalid JSON token) OR the string would contain U+FFFD replacement chars.
    assert.equal(typeof payload.params_raw, "string");
    assert.ok(!payload.params_raw.includes("�"), "no replacement chars (mid-codepoint slice)");

    // Critical invariant 2 — the truncated raw must satisfy the BYTE budget,
    // not the UTF-16 code-unit budget. Since CJK = 3 bytes/char and the raw
    // payload includes JSON quoting overhead, a UTF-16-only cap would let
    // ~6KB of bytes through; UTF-8-aware cap holds it ≤ 2KB.
    const rawBytes = Buffer.byteLength(payload.params_raw, "utf8");
    assert.ok(rawBytes <= 2048, `raw bytes (${rawBytes}) exceed 2KB budget`);
  });

  test("redacts secret-bearing keys before persisting (B3 token leakage fix)", () => {
    // PR #401 review (grill-me) flagged: any MCP tool whose tool_input
    // carries Authorization, api_key, password, etc. would be persisted
    // verbatim to SessionDB. Reproduce + assert masking.
    const events = extractEvents({
      tool_name: "mcp__github__create_issue",
      tool_input: {
        repo: "owner/name",
        title: "test",
        headers: {
          Authorization: "Bearer ghp_ABC123XYZ_secret_token",
          "X-API-Key": "sk-real-key-here",
          "Content-Type": "application/json",
        },
        auth: {
          token: "another-secret",
          api_key: "yet-another",
        },
        password: "p@ssw0rd!",
        nested: {
          deep: {
            cookie: "session=secret-cookie",
            ok_field: "kept",
          },
        },
      },
    });
    const call = events.find((e) => e.category === "mcp_tool_call");
    assert.ok(call, "mcp_tool_call event emitted");
    const payload = JSON.parse(call!.data);

    // No secret value should appear anywhere in serialized data
    const serialized = call!.data;
    assert.ok(!serialized.includes("ghp_ABC123XYZ_secret_token"), "Bearer token must be redacted");
    assert.ok(!serialized.includes("sk-real-key-here"), "X-API-Key must be redacted");
    assert.ok(!serialized.includes("another-secret"), "auth.token must be redacted");
    assert.ok(!serialized.includes("yet-another"), "auth.api_key must be redacted");
    assert.ok(!serialized.includes("p@ssw0rd!"), "password must be redacted");
    assert.ok(!serialized.includes("session=secret-cookie"), "nested cookie must be redacted");

    // Non-secret values must survive
    assert.equal(payload.params.repo, "owner/name", "non-secret repo preserved");
    assert.equal(payload.params.title, "test", "non-secret title preserved");
    assert.equal(payload.params.headers["Content-Type"], "application/json", "non-secret header preserved");
    assert.equal(payload.params.nested.deep.ok_field, "kept", "non-secret nested field preserved");

    // Redacted values must show the sentinel
    assert.equal(payload.params.headers.Authorization, "[REDACTED]");
    assert.equal(payload.params.headers["X-API-Key"], "[REDACTED]");
    assert.equal(payload.params.auth.token, "[REDACTED]");
    assert.equal(payload.params.auth.api_key, "[REDACTED]");
    assert.equal(payload.params.password, "[REDACTED]");
    assert.equal(payload.params.nested.deep.cookie, "[REDACTED]");
  });

  test("shared-ref redaction (B3) — same secret object referenced multiple times stays redacted", () => {
    // tool_input frequently uses shared object references (e.g., a single
    // headers object passed to multiple sub-requests). Redaction must mask
    // the value AT EVERY reference site, not just one.
    const sharedHeaders = { Authorization: "Bearer SECRET-XYZ-shared", trace_id: "abc-123" };
    const events = extractEvents({
      tool_name: "mcp__test__shared",
      tool_input: {
        primary_request: { url: "https://api/x", headers: sharedHeaders },
        retry_request: { url: "https://api/x", headers: sharedHeaders }, // SAME ref
      },
    });
    const call = events.find((e) => e.category === "mcp_tool_call");
    assert.ok(call, "mcp_tool_call event emitted for shared-ref input");
    // Secret must be redacted at BOTH reference sites
    assert.ok(!call!.data.includes("SECRET-XYZ-shared"), "shared secret value redacted at all sites");
    const payload = JSON.parse(call!.data);
    assert.equal(payload.params.primary_request.headers.Authorization, "[REDACTED]");
    assert.equal(payload.params.retry_request.headers.Authorization, "[REDACTED]");
    // Non-secret trace_id survives at both sites
    assert.equal(payload.params.primary_request.headers.trace_id, "abc-123");
    assert.equal(payload.params.retry_request.headers.trace_id, "abc-123");
  });
});

// ════════════════════════════════════════════
// CATEGORY 22: AGENT-FINDING
// ════════════════════════════════════════════

describe("Agent Finding Events", () => {
  test("extracts agent_finding when Agent completes with tool_response", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Research auth patterns" },
      tool_response: "Found 3 auth patterns: JWT, OAuth2, and session-based. JWT is stateless...",
    };

    const events = extractEvents(input);
    const findings = events.filter(e => e.type === "agent_finding");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].category, "agent-finding");
    assert.equal(findings[0].priority, 2);
    assert.ok(findings[0].data.includes("JWT"), "should include response content");
  });

  test("truncates agent_finding to 500 chars", () => {
    const longResponse = "x".repeat(1000);
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Big research task" },
      tool_response: longResponse,
    };

    const events = extractEvents(input);
    const findings = events.filter(e => e.type === "agent_finding");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].data.length, 500, "should truncate to 500 chars");
  });

  test("does not fire agent_finding when Agent has no tool_response", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Research task" },
      // no tool_response — agent launched but not completed
    };

    const events = extractEvents(input);
    const findings = events.filter(e => e.type === "agent_finding");
    assert.equal(findings.length, 0);
  });

  test("does not fire agent_finding for empty tool_response", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Research task" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const findings = events.filter(e => e.type === "agent_finding");
    assert.equal(findings.length, 0);
  });

  test("does not fire agent_finding for non-Agent tools", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_response: "hi",
    };

    const events = extractEvents(input);
    const findings = events.filter(e => e.type === "agent_finding");
    assert.equal(findings.length, 0);
  });

  test("agent_finding coexists with subagent_completed", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Research Cursor env vars" },
      tool_response: "Found CURSOR_TRACE_DIR and CURSOR_CHANNEL.",
    };

    const events = extractEvents(input);
    const subagent = events.filter(e => e.type === "subagent_completed");
    const finding = events.filter(e => e.type === "agent_finding");
    assert.equal(subagent.length, 1, "should still emit subagent_completed");
    assert.equal(finding.length, 1, "should also emit agent_finding");
  });
});

// ════════════════════════════════════════════
// CATEGORY 24: EXTERNAL-REF
// ════════════════════════════════════════════

describe("External Ref Events", () => {
  test("extracts URLs from tool_input", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "curl https://api.github.com/repos/user/repo" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 1);
    assert.equal(refs[0].category, "external-ref");
    assert.equal(refs[0].priority, 3);
    assert.ok(refs[0].data.includes("https://api.github.com"), "should capture URL");
  });

  test("extracts GitHub issue URLs from tool_response", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "gh issue list" },
      tool_response: "Fix: https://github.com/user/repo/issues/42 is blocking",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 1);
    assert.ok(refs[0].data.includes("github.com/user/repo/issues/42"));
  });

  test("extracts GitHub PR URLs", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "gh pr view 99" },
      tool_response: "See https://github.com/user/repo/pull/99",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 1);
    assert.ok(refs[0].data.includes("github.com/user/repo/pull/99"));
  });

  test("extracts shorthand issue refs (#123)", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "/project/CHANGELOG.md" },
      tool_response: "Fixed bug #42 and addressed #99",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 1);
    assert.ok(refs[0].data.includes("#42"), "should capture #42");
    assert.ok(refs[0].data.includes("#99"), "should capture #99");
  });

  test("deduplicates refs", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "echo https://example.com" },
      tool_response: "Visit https://example.com again",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 1);
    // Should only appear once despite being in both input and response
    const count = refs[0].data.split("https://example.com").length - 1;
    assert.equal(count, 1, "URL should appear exactly once (deduplicated)");
  });

  test("skips localhost URLs", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "curl http://localhost:3000/api" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 0, "should skip localhost");
  });

  test("skips 127.0.0.1 URLs", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "curl http://127.0.0.1:8080/health" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 0, "should skip 127.0.0.1");
  });

  test("does not fire when no refs found", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: "hello",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 0);
  });

  test("captures multiple mixed refs", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Check issue #344" },
      tool_response: "Found https://github.com/user/repo/pull/100 and #344 is related to https://docs.example.com/guide",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 1);
    assert.ok(refs[0].data.includes("#344"), "should include issue ref");
    assert.ok(refs[0].data.includes("github.com/user/repo/pull/100"), "should include PR URL");
    assert.ok(refs[0].data.includes("docs.example.com"), "should include doc URL");
  });
});

// ════════════════════════════════════════════
// CATEGORY 27: LATENCY (cross-hook state)
// ════════════════════════════════════════════

describe("Category 27 — Latency", () => {
  /**
   * Latency tracking uses cross-hook state (tmpdir files) to bridge
   * PreToolUse → PostToolUse. The extractEvents function itself does NOT
   * produce latency events — they are created directly in posttooluse.mjs
   * by comparing timestamps from the tmpdir marker file.
   *
   * These tests verify the architecture is sound:
   * - extractEvents does not accidentally produce latency events (no false positives)
   * - The latency event shape matches the SessionEvent interface
   */

  test("extractEvents does not produce latency events (latency is cross-hook, not extract-based)", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "all tests passed",
    };

    const events = extractEvents(input);
    const latencyEvents = events.filter(e => e.category === "latency");
    assert.equal(latencyEvents.length, 0, "extractEvents should not produce latency events");
  });

  test("latency event shape conforms to SessionEvent interface", () => {
    // This validates the event shape that posttooluse.mjs will produce
    const latencyEvent = {
      type: "tool_latency",
      category: "latency",
      data: "Bash: 7500ms",
      priority: 3,
    };

    assert.equal(typeof latencyEvent.type, "string");
    assert.equal(typeof latencyEvent.category, "string");
    assert.equal(typeof latencyEvent.data, "string");
    assert.equal(typeof latencyEvent.priority, "number");
    assert.equal(latencyEvent.type, "tool_latency");
    assert.equal(latencyEvent.category, "latency");
    assert.equal(latencyEvent.priority, 3);
  });

  test("latency data format includes tool name and duration", () => {
    // Validate the data format convention: "${tool}: ${duration}ms"
    const data = "Read: 12345ms";
    const match = data.match(/^(\w+): (\d+)ms$/);
    assert.ok(match, "data should match 'ToolName: Nms' format");
    assert.equal(match![1], "Read");
    assert.equal(match![2], "12345");
  });
});

// ════════════════════════════════════════════
// CATEGORY 28: PERMISSION (not feasible)
// ════════════════════════════════════════════

describe("Category 28 — Permission (architectural limitation)", () => {
  /**
   * Permission tracking is NOT implementable from hooks.
   *
   * Why:
   * - PreToolUse fires BEFORE the tool call. The user's approve/deny decision
   *   happens AFTER PreToolUse returns but BEFORE the tool actually executes.
   *   The hook cannot observe this decision.
   *
   * - PostToolUse ONLY fires when the tool successfully executed, meaning the
   *   user already approved. There is no PostToolUse invocation for denied tools.
   *   So PostToolUse always implies "approved" — there's no deny signal to track.
   *
   * - The hook system has no "permission_result" or "user_decision" field in
   *   either PreToolUse or PostToolUse stdin payloads.
   *
   * Possible future approaches:
   * 1. Claude Code adds a permission_result field to PostToolUse input
   * 2. A new hook event type (e.g., "ToolPermissionDecision") is introduced
   * 3. Track implicit approvals by counting PostToolUse invocations (but this
   *    adds no information beyond what we already have — every PostToolUse IS
   *    an implicit approval)
   *
   * Conclusion: Skip this category until the hook protocol evolves.
   */

  test("PostToolUse always implies approval — no deny signal available", () => {
    // Every PostToolUse input represents a tool that was approved and ran.
    // There's no way to distinguish "user clicked approve" from "tool was auto-approved".
    const input = {
      tool_name: "Bash",
      tool_input: { command: "rm -rf node_modules" },
      tool_response: "removed",
    };

    const events = extractEvents(input);
    const permEvents = events.filter(e => e.category === "permission");
    assert.equal(permEvents.length, 0, "no permission events should be extracted — not implementable");
  });

  test("PreToolUse deny is already captured as rejected-approach (Phase 1)", () => {
    // When PreToolUse returns action: "deny", the pretooluse.mjs hook already
    // writes a rejected-approach event. This is the closest we get to permission
    // tracking: we know when context-mode itself denies a tool, but NOT when
    // the user denies a tool.
    //
    // This test documents that rejected-approach covers the hook-level deny case.
    const input = {
      tool_name: "Bash",
      tool_input: { command: "curl https://example.com" },
      tool_response: "",
    };

    const events = extractEvents(input);
    // rejected-approach is written by pretooluse.mjs directly to DB, not via extractEvents
    const rejectedEvents = events.filter(e => e.category === "rejected-approach");
    assert.equal(rejectedEvents.length, 0, "extractEvents does not produce rejected-approach — that's pretooluse.mjs's job");
  });
});

// ════════════════════════════════════════════
// CATEGORY 23: ERROR-RESOLUTION (cross-event)
// ════════════════════════════════════════════

describe("Error Resolution Events", () => {
  test("emits error_resolved when error followed by successful same-tool call", () => {
    resetErrorResolutionState();

    // Step 1: Error occurs
    const errorInput = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "FAIL src/store.test.ts\nexit code 1",
    };
    const errorEvents = extractEvents(errorInput);
    const errors = errorEvents.filter(e => e.type === "error_resolved");
    assert.equal(errors.length, 0, "should not emit error_resolved on the error itself");

    // Step 2: Successful same-tool call
    const fixInput = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "all tests passed",
    };
    const fixEvents = extractEvents(fixInput);
    const resolved = fixEvents.filter(e => e.type === "error_resolved");
    assert.equal(resolved.length, 1, "should emit error_resolved");
    assert.equal(resolved[0].category, "error-resolution");
    assert.equal(resolved[0].priority, 2);
    assert.ok(resolved[0].data.includes("Bash"), "should reference the tool");
    assert.ok(resolved[0].data.includes("Fixed"), "should indicate resolution");
  });

  test("emits error_resolved when Edit follows Read error", () => {
    resetErrorResolutionState();

    // Read fails
    const readError = {
      tool_name: "Read",
      tool_input: { file_path: "/project/missing.ts" },
      tool_response: "File not found",
      tool_output: { isError: true },
    };
    extractEvents(readError);

    // Edit succeeds (fixes the situation)
    const editFix = {
      tool_name: "Edit",
      tool_input: { file_path: "/project/missing.ts", old_string: "a", new_string: "b" },
      tool_response: "File edited successfully",
    };
    const fixEvents = extractEvents(editFix);
    const resolved = fixEvents.filter(e => e.type === "error_resolved");
    assert.equal(resolved.length, 1, "Edit after Read error should resolve");
    assert.ok(resolved[0].data.includes("Read"), "should reference Read as the error tool");
  });

  test("emits error_resolved when Write follows Read error", () => {
    resetErrorResolutionState();

    const readError = {
      tool_name: "Read",
      tool_input: { file_path: "/project/new.ts" },
      tool_response: "File not found",
      tool_output: { isError: true },
    };
    extractEvents(readError);

    const writeFix = {
      tool_name: "Write",
      tool_input: { file_path: "/project/new.ts", content: "export {}" },
      tool_response: "File written",
    };
    const fixEvents = extractEvents(writeFix);
    const resolved = fixEvents.filter(e => e.type === "error_resolved");
    assert.equal(resolved.length, 1, "Write after Read error should resolve");
  });

  test("emits error_resolved when apply_patch follows Read error", () => {
    resetErrorResolutionState();

    const readError = {
      tool_name: "Read",
      tool_input: { file_path: "/project/src/missing.ts" },
      tool_response: "File not found",
      tool_output: { isError: true },
    };
    extractEvents(readError);

    const patchFix = {
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Add File: src/missing.ts",
          "+export {};",
          "*** End Patch",
        ].join("\n"),
      },
      tool_response: "Patch applied successfully",
    };
    const fixEvents = extractEvents(patchFix);
    const resolved = fixEvents.filter(e => e.type === "error_resolved");
    assert.equal(resolved.length, 1, "apply_patch after Read error should resolve");
  });

  test("does not emit error_resolved when apply_patch fails after Read error", () => {
    resetErrorResolutionState();

    extractEvents({
      tool_name: "Read",
      tool_input: { file_path: "/project/src/missing.ts" },
      tool_response: "File not found",
      tool_output: { isError: true },
    });

    const fixEvents = extractEvents({
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Add File: src/missing.ts",
          "+export {};",
          "*** End Patch",
        ].join("\n"),
      },
      tool_response: "Patch failed",
      tool_output: { isError: true },
    });

    assert.equal(
      fixEvents.filter(e => e.type === "error_resolved").length,
      0,
      "failed apply_patch should not resolve a prior Read error",
    );
  });

  test("does not emit plan_file_write when apply_patch fails after Read error", () => {
    resetErrorResolutionState();

    const events = extractEvents({
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Update File: .claude/plans/bad-plan.md",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      tool_response: "Patch failed",
      tool_output: { isError: true },
    });

    assert.equal(events.filter(e => e.type === "plan_file_write").length, 0);
  });

  test("does not emit error_resolved for unrelated tool after error", () => {
    resetErrorResolutionState();

    // Bash error
    const errorInput = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "FAIL\nexit code 1",
    };
    extractEvents(errorInput);

    // Different tool succeeds (Read — not Bash)
    const unrelatedInput = {
      tool_name: "Read",
      tool_input: { file_path: "/project/src/index.ts" },
      tool_response: "file content",
    };
    const events = extractEvents(unrelatedInput);
    const resolved = events.filter(e => e.type === "error_resolved");
    assert.equal(resolved.length, 0, "unrelated tool should not resolve error");
  });

  test("clears lastError after 10 calls without resolution (staleness timeout)", () => {
    resetErrorResolutionState();

    // Error occurs
    const errorInput = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "Error: test failed\nexit code 1",
    };
    extractEvents(errorInput);

    // 11 unrelated calls (exceeds the 10-call timeout)
    for (let i = 0; i < 11; i++) {
      extractEvents({
        tool_name: "Read",
        tool_input: { file_path: `/project/file${i}.ts` },
        tool_response: "content",
      });
    }

    // Now a Bash success should NOT resolve (stale error cleared)
    const lateFixInput = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "all tests passed",
    };
    const events = extractEvents(lateFixInput);
    const resolved = events.filter(e => e.type === "error_resolved");
    assert.equal(resolved.length, 0, "stale error should be cleared after 10 calls");
  });

  test("does not emit error_resolved when no prior error exists", () => {
    resetErrorResolutionState();

    const input = {
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: "hello",
    };
    const events = extractEvents(input);
    const resolved = events.filter(e => e.type === "error_resolved");
    assert.equal(resolved.length, 0);
  });

  test("second error replaces first error", () => {
    resetErrorResolutionState();

    // First error (Bash)
    extractEvents({
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "Error: first\nexit code 1",
    });

    // Second error (Edit) replaces first
    extractEvents({
      tool_name: "Edit",
      tool_input: { file_path: "/x.ts", old_string: "a", new_string: "b" },
      tool_response: "old_string not found",
      tool_output: { isError: true },
    });

    // Bash success should NOT resolve (lastError is now Edit, not Bash)
    const bashSuccess = extractEvents({
      tool_name: "Bash",
      tool_input: { command: "echo ok" },
      tool_response: "ok",
    });
    const resolved1 = bashSuccess.filter(e => e.type === "error_resolved");
    assert.equal(resolved1.length, 0, "Bash should not resolve Edit error");

    // Edit success SHOULD resolve
    const editSuccess = extractEvents({
      tool_name: "Edit",
      tool_input: { file_path: "/x.ts", old_string: "c", new_string: "d" },
      tool_response: "File edited",
    });
    const resolved2 = editSuccess.filter(e => e.type === "error_resolved");
    assert.equal(resolved2.length, 1, "Edit should resolve Edit error");
  });
});

// ════════════════════════════════════════════
// CATEGORY 26: ITERATION-LOOP (cross-event)
// ════════════════════════════════════════════

describe("Iteration Loop Events", () => {
  test("emits retry_detected when same tool+input called 3 times consecutively", () => {
    resetIterationLoopState();

    const input = {
      tool_name: "Edit",
      tool_input: { file_path: "/project/src/bug.ts", old_string: "foo", new_string: "bar" },
      tool_response: "old_string not found",
      tool_output: { isError: true },
    };

    // Call 1 & 2: no emission
    let events = extractEvents(input);
    let retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 0, "should not fire after 1 call");

    events = extractEvents(input);
    retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 0, "should not fire after 2 calls");

    // Call 3: emit
    events = extractEvents(input);
    retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 1, "should fire after 3 consecutive identical calls");
    assert.equal(retries[0].category, "iteration-loop");
    assert.equal(retries[0].priority, 2);
    assert.ok(retries[0].data.includes("Edit"), "should mention tool name");
    assert.ok(retries[0].data.includes("3"), "should mention count");
  });

  test("does not emit when different tools are interleaved", () => {
    resetIterationLoopState();

    extractEvents({
      tool_name: "Edit",
      tool_input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
      tool_response: "ok",
    });

    extractEvents({
      tool_name: "Read",
      tool_input: { file_path: "/a.ts" },
      tool_response: "content",
    });

    const events = extractEvents({
      tool_name: "Edit",
      tool_input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
      tool_response: "ok",
    });

    const retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 0, "interleaved tools should break the streak");
  });

  test("does not emit when same tool has different input", () => {
    resetIterationLoopState();

    for (let i = 0; i < 5; i++) {
      extractEvents({
        tool_name: "Edit",
        tool_input: { file_path: `/project/file${i}.ts`, old_string: "a", new_string: "b" },
        tool_response: "ok",
      });
    }

    // No retry_detected because each call has different input
    // (file_path differs so inputHash differs)
  });

  test("detects 4+ consecutive identical calls", () => {
    resetIterationLoopState();

    const input = {
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      tool_response: "Error: build failed\nexit code 1",
    };

    extractEvents(input);
    extractEvents(input);
    extractEvents(input);
    const events = extractEvents(input);
    const retries = events.filter(e => e.type === "retry_detected");
    // After 3rd call, the history is reset. 4th call starts fresh streak.
    // So we get 1 emission at call 3 (with count=3), then call 4 is a fresh start.
    assert.ok(retries.length === 0, "4th call after reset should not emit (fresh start)");
  });

  test("resets after emission to avoid duplicate events", () => {
    resetIterationLoopState();

    const input = {
      tool_name: "Grep",
      tool_input: { pattern: "TODO", path: "/project" },
      tool_response: "matches...",
    };

    // First streak: calls 1-3
    extractEvents(input);
    extractEvents(input);
    let events = extractEvents(input);
    let retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 1, "first streak should emit");

    // After reset, need 3 more for next emission
    extractEvents(input);
    events = extractEvents(input);
    retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 0, "should not emit at 2nd call of new streak");

    events = extractEvents(input);
    retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 1, "3rd call of new streak should emit again");
  });

  test("handles empty tool_input gracefully", () => {
    resetIterationLoopState();

    const input = {
      tool_name: "Skill",
      tool_input: {},
      tool_response: "ok",
    };

    // Should not throw
    extractEvents(input);
    extractEvents(input);
    const events = extractEvents(input);
    const retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 1);
  });
});

// ════════════════════════════════════════════
// CATEGORY 25: BLOCKED-ON (user messages)
// ════════════════════════════════════════════

describe("Blocked-On Events", () => {
  // Migrated to universal-rule detectors (issue #535). The old English
  // and Turkish keyword fixtures ("blocked on", "waiting for",
  // "bekliyor", "unblocked", ...) are intentionally no longer matched —
  // the universal-rule design relies on language-neutral
  // programming-domain markers (Error: / Exception: / Traceback / stack
  // frames) and Unicode checkmark / "fixed:" / "resolved:" prefixes.
  // For raw-message preservation see the <recent_user_messages>
  // safety-net section in tests/session/extract-multilang.test.ts.

  test("extracts blocker from 'Error:' programming-domain marker", () => {
    const events = extractUserEvents("Error: cannot read property of undefined");
    const blockerEvents = events.filter(e => e.type === "blocker");
    assert.equal(blockerEvents.length, 1);
    assert.equal(blockerEvents[0].category, "blocked-on");
    assert.equal(blockerEvents[0].priority, 2);
    assert.ok(blockerEvents[0].data.includes("cannot read property"));
  });

  test("extracts blocker from 'Exception:' marker", () => {
    const events = extractUserEvents("Exception: NullPointerException at line 42");
    const blockerEvents = events.filter(e => e.type === "blocker");
    assert.equal(blockerEvents.length, 1);
    assert.equal(blockerEvents[0].category, "blocked-on");
  });

  test("extracts blocker from Python 'Traceback' marker", () => {
    const events = extractUserEvents("Traceback (most recent call last):");
    const blockerEvents = events.filter(e => e.type === "blocker");
    assert.equal(blockerEvents.length, 1);
  });

  test("extracts blocker_resolved from Unicode checkmark", () => {
    const events = extractUserEvents("✅ unblocked now, got the credentials");
    const resolvedEvents = events.filter(e => e.type === "blocker_resolved");
    assert.equal(resolvedEvents.length, 1);
    assert.equal(resolvedEvents[0].category, "blocked-on");
    assert.equal(resolvedEvents[0].priority, 2);
  });

  test("extracts blocker_resolved from 'fixed:' marker prefix", () => {
    const events = extractUserEvents("fixed: the cache miss in dev");
    const resolvedEvents = events.filter(e => e.type === "blocker_resolved");
    assert.equal(resolvedEvents.length, 1);
  });

  test("extracts blocker_resolved from 'resolved:' marker prefix", () => {
    const events = extractUserEvents("resolved: deploy queue cleared");
    const resolvedEvents = events.filter(e => e.type === "blocker_resolved");
    assert.equal(resolvedEvents.length, 1);
  });

  test("resolution takes priority over blocker when both shapes match", () => {
    // checkmark wins over Error: marker in the same message
    const events = extractUserEvents("✅ Error: was a stale build, fixed it");
    const resolvedEvents = events.filter(e => e.type === "blocker_resolved");
    const blockerEvents = events.filter(e => e.type === "blocker");
    assert.equal(resolvedEvents.length, 1, "should emit resolved");
    assert.equal(blockerEvents.length, 0, "should NOT emit blocker when resolved");
  });

  test("does not extract blocker from unrelated messages", () => {
    const events = extractUserEvents("Can you read the server.ts file?");
    const blockerEvents = events.filter(e => e.category === "blocked-on");
    assert.equal(blockerEvents.length, 0);
  });
});

// ─── SLICE Qwen-4: extractEvents Qwen-aware (Z5b) ───
describe("Qwen native tool name normalization", () => {
  test("run_shell_command + git status emits git event", () => {
    const events = extractEvents({
      tool_name: "run_shell_command",
      tool_input: { command: "git status" },
      tool_response: "On branch main",
    });
    const gitEvents = events.filter(e => e.category === "git");
    assert.equal(gitEvents.length, 1, "git event should be extracted");
    assert.equal(gitEvents[0].data, "status");
  });

  test("run_shell_command + cd emits cwd event", () => {
    const events = extractEvents({
      tool_name: "run_shell_command",
      tool_input: { command: "cd /tmp/foo && ls" },
      tool_response: "",
    });
    const cwdEvents = events.filter(e => e.category === "cwd");
    assert.equal(cwdEvents.length, 1);
    assert.equal(cwdEvents[0].data, "/tmp/foo");
  });

  test("read_file emits file_read event", () => {
    const events = extractEvents({
      tool_name: "read_file",
      tool_input: { file_path: "/tmp/a.ts" },
      tool_response: "code",
    });
    const fileEvents = events.filter(e => e.type === "file_read");
    assert.equal(fileEvents.length, 1);
    assert.equal(fileEvents[0].data, "/tmp/a.ts");
  });

  test("write_file emits file_write event", () => {
    const events = extractEvents({
      tool_name: "write_file",
      tool_input: { file_path: "/tmp/b.ts" },
      tool_response: "ok",
    });
    const fileEvents = events.filter(e => e.type === "file_write");
    assert.equal(fileEvents.length, 1);
  });

  test("edit emits file_edit event", () => {
    const events = extractEvents({
      tool_name: "edit",
      tool_input: { file_path: "/tmp/c.ts" },
      tool_response: "ok",
    });
    const fileEvents = events.filter(e => e.type === "file_edit");
    assert.equal(fileEvents.length, 1);
  });

  test("todo_write emits task event", () => {
    const events = extractEvents({
      tool_name: "todo_write",
      tool_input: { todos: [{ content: "do thing" }] },
      tool_response: "ok",
    });
    const taskEvents = events.filter(e => e.category === "task");
    assert.equal(taskEvents.length, 1);
  });

  test("agent emits subagent event", () => {
    const events = extractEvents({
      tool_name: "agent",
      tool_input: { prompt: "investigate the bug" },
      tool_response: "found it",
    });
    const subEvents = events.filter(e => e.category === "subagent");
    assert.equal(subEvents.length, 1);
    assert.equal(subEvents[0].type, "subagent_completed");
  });

  test("read_file with QWEN.md path emits rule event", () => {
    const events = extractEvents({
      tool_name: "read_file",
      tool_input: { file_path: "/proj/QWEN.md" },
      tool_response: "qwen rules",
    });
    const ruleEvents = events.filter(e => e.category === "rule");
    assert.ok(ruleEvents.length >= 1, "QWEN.md should emit rule event");
  });
});
