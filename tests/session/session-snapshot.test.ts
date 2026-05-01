import { strict as assert } from "node:assert";
import { describe, test } from "vitest";
import {
  buildResumeSnapshot,
  renderTaskState,
  type StoredEvent,
} from "../../src/session/snapshot.js";

// ── Helpers ──
function makeEvent(overrides: Partial<StoredEvent> & Pick<StoredEvent, "type" | "category">): StoredEvent {
  return {
    type: overrides.type,
    category: overrides.category,
    data: overrides.data ?? "",
    priority: overrides.priority ?? 2,
    created_at: overrides.created_at ?? new Date().toISOString(),
  };
}

// ════════════════════════════════════════════
// SLICE 1: Empty events -> valid XML
// ════════════════════════════════════════════

describe("Slice 1: Empty Events", () => {
  test("buildResumeSnapshot with empty events returns valid XML with events=0", () => {
    const xml = buildResumeSnapshot([]);
    assert.ok(xml.includes('events="0"'), `expected events="0", got: ${xml}`);
    assert.ok(xml.startsWith("<session_resume"), "should start with <session_resume");
    assert.ok(xml.endsWith("</session_resume>"), "should end with </session_resume>");
  });
});

// ════════════════════════════════════════════
// SLICE 2: Single file event -> <files>
// ════════════════════════════════════════════

describe("Slice 2: Single File Event", () => {
  test("buildResumeSnapshot with single file event includes files section", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file_edit", category: "file", data: "src/server.ts", priority: 1 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<files"), "should include <files");
    assert.ok(xml.includes("server.ts"), "should include file name");
    assert.ok(xml.includes("</files>"), "should close files");
  });
});

// ════════════════════════════════════════════
// SLICE 3: File deduplication and op counting
// ════════════════════════════════════════════

describe("Slice 3: File Deduplication", () => {
  test("buildResumeSnapshot deduplicates files and counts ops", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file_edit", category: "file", data: "src/server.ts", priority: 1 }),
      makeEvent({ type: "file_edit", category: "file", data: "src/server.ts", priority: 1 }),
      makeEvent({ type: "file_edit", category: "file", data: "src/server.ts", priority: 1 }),
      makeEvent({ type: "file_read", category: "file", data: "src/server.ts", priority: 1 }),
      makeEvent({ type: "file_read", category: "file", data: "src/server.ts", priority: 1 }),
    ];
    const xml = buildResumeSnapshot(events);

    // Should show edit×3 and read×2 for server.ts
    assert.ok(xml.includes("edit×3"), `expected edit×3, got: ${xml}`);
    assert.ok(xml.includes("read×2"), `expected read×2, got: ${xml}`);
    // count should reflect 1 unique file
    assert.ok(xml.includes('count="1"'), `expected count="1" for files, got: ${xml}`);
  });
});

// ════════════════════════════════════════════
// SLICE 4: File limit to 10
// ════════════════════════════════════════════

describe("Slice 4: File Limit", () => {
  test("buildResumeSnapshot limits displayed files to last 10", () => {
    const events: StoredEvent[] = [];
    for (let i = 0; i < 15; i++) {
      events.push(makeEvent({
        type: "file_edit",
        category: "file",
        data: `src/file-${i}.ts`,
        priority: 1,
      }));
    }
    const xml = buildResumeSnapshot(events);

    // count attribute reflects total unique files
    assert.ok(xml.includes('count="15"'), `expected count="15", got: ${xml}`);

    // Should keep the LAST 10 files (file-5 through file-14)
    assert.ok(!xml.includes("file-0.ts"), "should NOT include file-0 (dropped)");
    assert.ok(!xml.includes("file-4.ts"), "should NOT include file-4 (dropped)");
    assert.ok(xml.includes("file-5.ts"), "should include file-5");
    assert.ok(xml.includes("file-14.ts"), "should include file-14");
  });
});

// ════════════════════════════════════════════
// SLICE 5: Task events -> <task_state>
// ════════════════════════════════════════════

describe("Slice 5: Task State", () => {
  test("buildResumeSnapshot with pending task events includes task_state", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "task", category: "task", data: JSON.stringify({ subject: "Write tests" }), priority: 1 }),
      makeEvent({ type: "task", category: "task", data: JSON.stringify({ taskId: "1", status: "in_progress" }), priority: 1 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<task_state"), "should include <task_state");
    assert.ok(xml.includes("Write tests"), "should include task content");
    assert.ok(xml.includes("</task_state>"), "should close task_state");
  });

  test("renderTaskState filters completed tasks and shows only pending", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "task", category: "task", data: JSON.stringify({ subject: "Old task" }), priority: 1 }),
      makeEvent({ type: "task", category: "task", data: JSON.stringify({ subject: "Current task" }), priority: 1 }),
      makeEvent({ type: "task", category: "task", data: JSON.stringify({ taskId: "1", status: "completed" }), priority: 1 }),
    ];
    const xml = renderTaskState(events);
    assert.ok(!xml.includes("Old task"), "should NOT show completed task");
    assert.ok(xml.includes("Current task"), "should show pending task");
  });

  test("renderTaskState returns empty when all tasks completed", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "task", category: "task", data: JSON.stringify({ subject: "Done task" }), priority: 1 }),
      makeEvent({ type: "task", category: "task", data: JSON.stringify({ taskId: "1", status: "completed" }), priority: 1 }),
    ];
    const xml = renderTaskState(events);
    assert.equal(xml, "", "should return empty when all tasks completed");
  });
});

// ════════════════════════════════════════════
// SLICE 6: Rule events -> <rules>
// ════════════════════════════════════════════

describe("Slice 6: Rules", () => {
  test("buildResumeSnapshot with rule events includes rules section", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "rule", category: "rule", data: "/project/CLAUDE.md", priority: 1 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<rules"), "should include <rules");
    assert.ok(xml.includes("CLAUDE.md"), "should include rule source");
    assert.ok(xml.includes("</rules>"), "should close rules");
  });
});

// ════════════════════════════════════════════
// SLICE 7: Rules deduplication
// ════════════════════════════════════════════

describe("Slice 7: Rules Deduplication", () => {
  test("buildResumeSnapshot deduplicates identical rules", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "rule", category: "rule", data: "/project/CLAUDE.md", priority: 1 }),
      makeEvent({ type: "rule", category: "rule", data: "/project/CLAUDE.md", priority: 1 }),
    ];
    const xml = buildResumeSnapshot(events);
    // Count should reflect 1 unique rule
    assert.ok(xml.includes('count="1"'), `expected count="1" for rules`);
  });
});

// ════════════════════════════════════════════
// SLICE 8: Environment events -> <environment>
// ════════════════════════════════════════════

describe("Slice 8: Environment", () => {
  test("buildResumeSnapshot with cwd event includes environment", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "cwd", category: "cwd", data: "/Users/mksglu/project", priority: 2 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<environment>"), "should include <environment>");
    assert.ok(xml.includes("cwd:"), "should include cwd label");
    assert.ok(xml.includes("/Users/mksglu/project"), "should include cwd path");
    assert.ok(xml.includes("</environment>"), "should close environment");
  });

  test("buildResumeSnapshot with env events includes environment", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "env", category: "env", data: "source .venv/bin/activate", priority: 2 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<environment>"), "should include <environment>");
    assert.ok(xml.includes("activate"), "should include env data");
    assert.ok(xml.includes("</environment>"), "should close environment");
  });

  test("buildResumeSnapshot with no cwd/env events omits environment", () => {
    const xml = buildResumeSnapshot([]);
    assert.ok(!xml.includes("<environment>"), "should not include <environment> with no events");
  });
});

// ════════════════════════════════════════════
// SLICE 9: Error events -> <errors>
// ════════════════════════════════════════════

describe("Slice 9: Errors", () => {
  test("buildResumeSnapshot with error events includes errors section", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "error_tool", category: "error", data: "Push rejected: non-fast-forward", priority: 2 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<errors"), "should include <errors");
    assert.ok(xml.includes("Push rejected"), "should include error data");
    assert.ok(xml.includes("</errors>"), "should close errors");
  });

  test("buildResumeSnapshot renders multiple errors", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "error_tool", category: "error", data: "Error 1", priority: 2 }),
      makeEvent({ type: "error_tool", category: "error", data: "Error 2", priority: 2 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("Error 1"), "should include first error");
    assert.ok(xml.includes("Error 2"), "should include second error");
  });

  test("buildResumeSnapshot with no error events omits errors section", () => {
    const xml = buildResumeSnapshot([]);
    assert.ok(!xml.includes("<errors"), "should not include errors with no events");
  });
});

// ════════════════════════════════════════════
// SLICE 10: Intent -> <intent>
// ════════════════════════════════════════════

describe("Slice 10: Intent", () => {
  test("buildResumeSnapshot with intent includes intent element", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "intent", category: "intent", data: "implement", priority: 4 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<intent"), "should include <intent>");
    assert.ok(xml.includes('mode="implement"'), 'should include mode="implement"');
  });
});

// ════════════════════════════════════════════
// SLICE 11: XML escaping
// ════════════════════════════════════════════

describe("Slice 11: XML Escaping", () => {
  test("escapes XML special characters in file data", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file_edit", category: "file", data: 'src/<Main & "App">.tsx', priority: 1 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("&lt;Main"), "should escape < to &lt;");
    assert.ok(xml.includes("&amp;"), "should escape & to &amp;");
    assert.ok(xml.includes("&quot;App&quot;"), "should escape quotes");
  });

  test("escapes XML in rule data", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "rule", category: "rule", data: "Rule: x < y && z > 0", priority: 1 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("&lt;"), "should escape < in rules");
    assert.ok(xml.includes("&amp;"), "should escape & in rules");
    assert.ok(xml.includes("&gt;"), "should escape > in rules");
  });

  test("escapes XML in error data", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "error_tool", category: "error", data: "Error: <tag> & 'quote'", priority: 2 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("&lt;tag&gt;"), "should escape tags in errors");
    assert.ok(xml.includes("&apos;quote&apos;"), "should escape single quotes in errors");
  });
});

// ════════════════════════════════════════════
// SLICE 12: No truncation — output contains no ellipsis
// ════════════════════════════════════════════

describe("Slice 12: No Truncation", () => {
  test("output contains no ellipsis — zero truncation artifacts", () => {
    const events: StoredEvent[] = [];
    for (let i = 0; i < 50; i++) {
      events.push(makeEvent({
        type: "file_edit",
        category: "file",
        data: `src/very/long/path/to/some/deeply/nested/file-${i}.ts`,
        priority: 1,
      }));
    }
    for (let i = 0; i < 20; i++) {
      events.push(makeEvent({
        type: "task",
        category: "task",
        data: JSON.stringify({ subject: `Task ${i}: ${"x".repeat(100)}` }),
        priority: 1,
      }));
    }
    for (let i = 0; i < 10; i++) {
      events.push(makeEvent({
        type: "rule",
        category: "rule",
        data: `Rule ${i}: ${"y".repeat(100)}`,
        priority: 1,
      }));
    }
    for (let i = 0; i < 10; i++) {
      events.push(makeEvent({
        type: "error_tool",
        category: "error",
        data: `Error ${i}: ${"z".repeat(100)}`,
        priority: 2,
      }));
    }
    events.push(makeEvent({ type: "intent", category: "intent", data: "implement", priority: 4 }));

    const xml = buildResumeSnapshot(events);
    // Must NOT contain truncation ellipsis
    assert.ok(!xml.includes("..."), `output should contain no ellipsis, but found "..." in output`);
  });
});

// ════════════════════════════════════════════
// SLICE 13: how_to_search instruction block is present
// ════════════════════════════════════════════

describe("Slice 13: how_to_search Instruction Block", () => {
  test("how_to_search instruction block is present in output", () => {
    const xml = buildResumeSnapshot([]);
    assert.ok(xml.includes("<how_to_search>"), "should include <how_to_search> tag");
    assert.ok(xml.includes("</how_to_search>"), "should include </how_to_search> tag");
    assert.ok(xml.includes("For FULL DETAILS"), "should include instruction text");
    assert.ok(xml.includes("Do NOT ask the user"), "should include user instruction");
  });

  test("how_to_search is present even with events", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file_edit", category: "file", data: "src/app.ts", priority: 1 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<how_to_search>"), "should include <how_to_search> with events");
  });
});

// ════════════════════════════════════════════
// SLICE 14: Each non-empty section contains a search tool call
// ════════════════════════════════════════════

describe("Slice 14: Search Tool Calls in Sections", () => {
  test("each non-empty section contains a search tool call with queries and source", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file_edit", category: "file", data: "src/server.ts", priority: 1 }),
      makeEvent({ type: "error_tool", category: "error", data: "Push rejected", priority: 2 }),
      makeEvent({ type: "decision", category: "decision", data: "use ctx- prefix", priority: 2 }),
      makeEvent({ type: "rule", category: "rule", data: "CLAUDE.md: git rules", priority: 1 }),
      makeEvent({ type: "git", category: "git", data: "commit: feat: add feature", priority: 2 }),
      makeEvent({ type: "task", category: "task", data: JSON.stringify({ subject: "Implement feature" }), priority: 1 }),
      makeEvent({ type: "cwd", category: "cwd", data: "/project", priority: 2 }),
      makeEvent({ type: "subagent_completed", category: "subagent", data: "Research complete", priority: 2 }),
    ];
    const xml = buildResumeSnapshot(events);

    // Each data-bearing section should have queries: and source: "session-events"
    assert.ok(xml.includes('queries:'), "should contain queries: in tool calls");
    assert.ok(xml.includes('source: "session-events"'), 'should contain source: "session-events" in tool calls');

    // Count occurrences of source: "session-events" — should match number of data sections
    const sourceMatches = (xml.match(/source: "session-events"/g) || []).length;
    // We have: files, errors, decisions, rules, git, task_state, environment, subagents = 8 sections
    assert.ok(sourceMatches >= 7, `expected at least 7 source references, got ${sourceMatches}`);
  });

  test("searchTool option customizes tool name", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file_edit", category: "file", data: "src/app.ts", priority: 1 }),
      makeEvent({ type: "error_tool", category: "error", data: "Error found", priority: 2 }),
    ];
    const xml = buildResumeSnapshot(events, { searchTool: "custom_search" });
    assert.ok(xml.includes("custom_search"), `should contain custom tool name, got: ${xml.slice(0, 500)}`);
    assert.ok(!xml.includes("ctx_search"), "should NOT contain default tool name when custom is set");
  });
});

// ════════════════════════════════════════════
// SLICE 15: XML structure
// ════════════════════════════════════════════

describe("Slice 15: XML Structure", () => {
  test("buildResumeSnapshot starts with <session_resume and ends with </session_resume>", () => {
    const xml = buildResumeSnapshot([]);
    assert.ok(xml.startsWith("<session_resume"), `should start with <session_resume, got: ${xml.slice(0, 30)}`);
    assert.ok(xml.endsWith("</session_resume>"), `should end with </session_resume>, got: ${xml.slice(-30)}`);
  });

  test("buildResumeSnapshot includes compact_count from options", () => {
    const xml = buildResumeSnapshot([], { compactCount: 3 });
    assert.ok(xml.includes('compact_count="3"'), 'should include compact_count="3"');
  });

  test("buildResumeSnapshot includes generated_at timestamp", () => {
    const xml = buildResumeSnapshot([]);
    assert.ok(xml.includes("generated_at="), "should include generated_at attribute");
    const match = xml.match(/generated_at="([^"]+)"/);
    assert.ok(match, "should have a generated_at value");
    assert.ok(!isNaN(Date.parse(match![1])), "generated_at should be a valid ISO date");
  });

  test("buildResumeSnapshot events attribute matches input length", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file_edit", category: "file", data: "a.ts", priority: 1 }),
      makeEvent({ type: "file_edit", category: "file", data: "b.ts", priority: 1 }),
      makeEvent({ type: "cwd", category: "cwd", data: "/project", priority: 2 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes('events="3"'), `should have events="3", got: ${xml.slice(0, 120)}`);
  });
});

// ════════════════════════════════════════════
// EDGE CASES & INTEGRATION
// ════════════════════════════════════════════

describe("Edge Cases", () => {
  test("renderTaskState returns empty string for no events", () => {
    assert.equal(renderTaskState([]), "", "should return empty string");
  });

  test("full integration: all event types combined", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file_edit", category: "file", data: "src/server.ts", priority: 1 }),
      makeEvent({ type: "file_read", category: "file", data: "src/store.ts", priority: 1 }),
      makeEvent({ type: "task", category: "task", data: JSON.stringify({ subject: "Implement session continuity" }), priority: 1 }),
      makeEvent({ type: "rule", category: "rule", data: "CLAUDE.md: Never set Claude as git author", priority: 1 }),
      makeEvent({ type: "decision", category: "decision", data: "use ctx- prefix, not cm-", priority: 2 }),
      makeEvent({ type: "cwd", category: "cwd", data: "/Users/mksglu/project", priority: 2 }),
      makeEvent({ type: "git", category: "git", data: "branch", priority: 2 }),
      makeEvent({ type: "env", category: "env", data: "nvm use 20", priority: 2 }),
      makeEvent({ type: "error_tool", category: "error", data: "Push rejected", priority: 2 }),
      makeEvent({ type: "intent", category: "intent", data: "implement", priority: 4 }),
    ];

    const xml = buildResumeSnapshot(events);

    // Verify structure
    assert.ok(xml.startsWith("<session_resume"), "starts with session_resume");
    assert.ok(xml.endsWith("</session_resume>"), "ends with session_resume");
    assert.ok(xml.includes('events="10"'), "captures all 10 events");

    // Verify sections present
    assert.ok(xml.includes("<files"), "has files");
    assert.ok(xml.includes("<task_state"), "has task_state");
    assert.ok(xml.includes("<rules"), "has rules");
    assert.ok(xml.includes("<decisions"), "has decisions");
    assert.ok(xml.includes("<environment>"), "has environment");
    assert.ok(xml.includes("<errors"), "has errors");
    assert.ok(xml.includes("<intent"), "has intent");

    // Verify how_to_search is present
    assert.ok(xml.includes("<how_to_search>"), "has how_to_search");

    // Verify search references present
    assert.ok(xml.includes('source: "session-events"'), 'has source: "session-events"');

    // No truncation artifacts
    assert.ok(!xml.includes("..."), "no ellipsis truncation artifacts");
  });

  test("handles file_write type correctly", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file_write", category: "file", data: "src/new-file.ts", priority: 1 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("write×1"), `expected write×1, got: ${xml}`);
  });

  test("decisions are deduplicated", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "decision", category: "decision", data: "use ctx- prefix", priority: 2 }),
      makeEvent({ type: "decision", category: "decision", data: "use ctx- prefix", priority: 2 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes('count="1"'), `expected count="1" for deduplicated decisions`);
  });
});

// ════════════════════════════════════════════
// SUBAGENT EVENTS -> <subagents>
// ════════════════════════════════════════════

describe("Subagent Rendering", () => {
  test("buildResumeSnapshot with subagent events includes subagents section", () => {
    const events: StoredEvent[] = [
      makeEvent({
        type: "subagent_completed",
        category: "subagent",
        data: "[completed] Research Cursor env vars → Found CURSOR_TRACE_DIR",
        priority: 2,
      }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<subagents"), "should include <subagents");
    assert.ok(xml.includes("</subagents>"), "should close </subagents>");
    assert.ok(xml.includes("CURSOR_TRACE_DIR"), "should include agent result data");
  });

  test("buildResumeSnapshot with no subagent events omits subagents section", () => {
    const xml = buildResumeSnapshot([]);
    assert.ok(!xml.includes("<subagents"), "should not include subagents with no events");
  });

  test("buildResumeSnapshot renders multiple subagents", () => {
    const events: StoredEvent[] = [
      makeEvent({
        type: "subagent_completed",
        category: "subagent",
        data: "[completed] Research Gemini CLI → GEMINI_PROJECT_DIR confirmed",
        priority: 2,
      }),
      makeEvent({
        type: "subagent_completed",
        category: "subagent",
        data: "[completed] Research Codex CLI → No env var detection exists",
        priority: 2,
      }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("Gemini CLI"), "should include first agent");
    assert.ok(xml.includes("Codex CLI"), "should include second agent");
  });

  test("buildResumeSnapshot with 4 completed agents preserves all results", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "subagent_completed", category: "subagent", data: "[completed] Cursor → CURSOR_TRACE_DIR", priority: 2 }),
      makeEvent({ type: "subagent_completed", category: "subagent", data: "[completed] Gemini → GEMINI_PROJECT_DIR", priority: 2 }),
      makeEvent({ type: "subagent_completed", category: "subagent", data: "[completed] Codex → no detection", priority: 2 }),
      makeEvent({ type: "subagent_completed", category: "subagent", data: "[completed] VS Code → VSCODE_PID", priority: 2 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("Cursor"), "should include Cursor agent result");
    assert.ok(xml.includes("Gemini"), "should include Gemini agent result");
    assert.ok(xml.includes("Codex"), "should include Codex agent result");
    assert.ok(xml.includes("VS Code"), "should include VS Code agent result");
  });
});

// ════════════════════════════════════════════
// ROLE EVENTS -> <roles>
// ════════════════════════════════════════════

describe("Role Events in Snapshot", () => {
  test("Role events survive snapshot building", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "role", category: "role", data: "Act as a senior staff engineer", priority: 3 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<roles"), "should include <roles");
    assert.ok(xml.includes("senior staff engineer"), "should include role data");
    assert.ok(xml.includes("</roles>"), "should close roles");
  });

  test("Role events are deduplicated in snapshot", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "role", category: "role", data: "Act as a senior staff engineer", priority: 3 }),
      makeEvent({ type: "role", category: "role", data: "Act as a senior staff engineer", priority: 3 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes('count="1"'), "should deduplicate identical roles");
  });

  test("Multiple distinct roles are preserved", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "role", category: "role", data: "Act as a senior staff engineer", priority: 3 }),
      makeEvent({ type: "role", category: "role", data: "You are a principal architect", priority: 3 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("senior staff engineer"), "should include first role");
    assert.ok(xml.includes("principal architect"), "should include second role");
    assert.ok(xml.includes('count="2"'), "should count 2 distinct roles");
  });

  test("Role events with no role data omit roles section", () => {
    const xml = buildResumeSnapshot([]);
    assert.ok(!xml.includes("<roles"), "should not include roles with no events");
  });
});
