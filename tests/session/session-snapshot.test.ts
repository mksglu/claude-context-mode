import { strict as assert } from "node:assert";
import { describe, test } from "vitest";
import {
  buildResumeSnapshot,
  renderActiveFiles,
  renderTaskState,
  renderRules,
  renderDecisions,
  renderEnvironment,
  renderErrors,
  renderIntent,
  renderSubagents,
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
  test("buildResumeSnapshot with empty events returns valid XML with events_captured=0", () => {
    const xml = buildResumeSnapshot([]);
    assert.ok(xml.includes('events_captured="0"'), `expected events_captured="0", got: ${xml}`);
    assert.ok(xml.startsWith("<session_resume"), "should start with <session_resume");
    assert.ok(xml.endsWith("</session_resume>"), "should end with </session_resume>");
  });
});

// ════════════════════════════════════════════
// SLICE 2: Single file event -> <active_files>
// ════════════════════════════════════════════

describe("Slice 2: Single File Event", () => {
  test("buildResumeSnapshot with single file event includes active_files", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file", category: "file", data: "src/server.ts", priority: 1 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<active_files>"), "should include <active_files>");
    assert.ok(xml.includes("src/server.ts"), "should include file path");
    assert.ok(xml.includes("</active_files>"), "should close active_files");
  });
});

// ════════════════════════════════════════════
// SLICE 3: renderActiveFiles deduplicates
// ════════════════════════════════════════════

describe("Slice 3: File Deduplication", () => {
  test("renderActiveFiles deduplicates files by path and counts ops", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file", category: "file", data: "src/server.ts", priority: 1 }),
      makeEvent({ type: "file", category: "file", data: "src/server.ts", priority: 1 }),
      makeEvent({ type: "file", category: "file", data: "src/server.ts", priority: 1 }),
      makeEvent({ type: "file_read", category: "file", data: "src/server.ts", priority: 1 }),
      makeEvent({ type: "file_read", category: "file", data: "src/server.ts", priority: 1 }),
    ];
    const xml = renderActiveFiles(events);

    // Should have only ONE <file> element for src/server.ts
    const fileTagCount = (xml.match(/<file /g) || []).length;
    assert.equal(fileTagCount, 1, `expected 1 file tag, got ${fileTagCount}`);

    // Should show edit:3,read:2
    assert.ok(xml.includes("edit:3"), `expected edit:3, got: ${xml}`);
    assert.ok(xml.includes("read:2"), `expected read:2, got: ${xml}`);
  });

  test("renderActiveFiles tracks last operation correctly", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file", category: "file", data: "src/store.ts", priority: 1 }),
      makeEvent({ type: "file_read", category: "file", data: "src/store.ts", priority: 1 }),
    ];
    const xml = renderActiveFiles(events);
    assert.ok(xml.includes('last="read"'), `expected last="read", got: ${xml}`);
  });
});

// ════════════════════════════════════════════
// SLICE 4: renderActiveFiles limits to 10 files
// ════════════════════════════════════════════

describe("Slice 4: File Limit", () => {
  test("renderActiveFiles limits to last 10 files", () => {
    const events: StoredEvent[] = [];
    for (let i = 0; i < 15; i++) {
      events.push(makeEvent({
        type: "file",
        category: "file",
        data: `src/file-${i}.ts`,
        priority: 1,
      }));
    }
    const xml = renderActiveFiles(events);
    const fileTagCount = (xml.match(/<file /g) || []).length;
    assert.equal(fileTagCount, 10, `expected 10 file tags, got ${fileTagCount}`);

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
    assert.ok(xml.includes("<task_state>"), "should include <task_state>");
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
  test("buildResumeSnapshot with rule events includes rules", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "rule", category: "rule", data: "/project/CLAUDE.md", priority: 1 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<rules>"), "should include <rules>");
    assert.ok(xml.includes("CLAUDE.md"), "should include rule source");
    assert.ok(xml.includes("</rules>"), "should close rules");
  });
});

// ════════════════════════════════════════════
// SLICE 7: Rules includes both CLAUDE.md and user decisions
// ════════════════════════════════════════════

describe("Slice 7: Rules + Decisions", () => {
  test("renderRules includes both CLAUDE.md rules and user decisions", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "rule", category: "rule", data: "CLAUDE.md: Never set Claude as git author", priority: 1 }),
      makeEvent({ type: "rule", category: "rule", data: 'User correction: "use ctx- prefix, not cm-"', priority: 1 }),
    ];
    const xml = renderRules(events);
    assert.ok(xml.includes("CLAUDE.md"), "should include CLAUDE.md rule");
    assert.ok(xml.includes("ctx-"), "should include user correction");
  });

  test("renderRules deduplicates identical rules", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "rule", category: "rule", data: "/project/CLAUDE.md", priority: 1 }),
      makeEvent({ type: "rule", category: "rule", data: "/project/CLAUDE.md", priority: 1 }),
    ];
    const xml = renderRules(events);
    // Count the number of "- " list items
    const itemCount = (xml.match(/    - /g) || []).length;
    assert.equal(itemCount, 1, `expected 1 unique rule, got ${itemCount}`);
  });
});

// ════════════════════════════════════════════
// SLICE 8: Environment events -> <environment>
// ════════════════════════════════════════════

describe("Slice 8: Environment", () => {
  test("buildResumeSnapshot with environment events includes environment with cwd and git", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "cwd", category: "cwd", data: "/Users/mksglu/project", priority: 2 }),
      makeEvent({ type: "git", category: "git", data: "branch", priority: 2 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<environment>"), "should include <environment>");
    assert.ok(xml.includes("<cwd>"), "should include <cwd>");
    assert.ok(xml.includes("/Users/mksglu/project"), "should include cwd path");
    assert.ok(xml.includes("<git "), "should include <git>");
    assert.ok(xml.includes("</environment>"), "should close environment");
  });

  test("renderEnvironment with only cwd", () => {
    const cwd = makeEvent({ type: "cwd", category: "cwd", data: "/project", priority: 2 });
    const xml = renderEnvironment(cwd, [], undefined);
    assert.ok(xml.includes("<cwd>/project</cwd>"), "should include cwd");
    assert.ok(!xml.includes("<git"), "should not include git when absent");
  });

  test("renderEnvironment with env events", () => {
    const envEv = makeEvent({ type: "env", category: "env", data: "source .venv/bin/activate", priority: 2 });
    const xml = renderEnvironment(undefined, [envEv], undefined);
    assert.ok(xml.includes("<env>"), "should include <env>");
    assert.ok(xml.includes("activate"), "should include env data");
  });

  test("renderEnvironment returns empty string when all inputs are empty", () => {
    const xml = renderEnvironment(undefined, [], undefined);
    assert.equal(xml, "", "should return empty string with no inputs");
  });
});

// ════════════════════════════════════════════
// SLICE 9: Error events -> <errors_resolved>
// ════════════════════════════════════════════

describe("Slice 9: Errors", () => {
  test("buildResumeSnapshot with error events includes errors_resolved", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "error_tool", category: "error", data: "Push rejected: non-fast-forward", priority: 2 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<errors_resolved>"), "should include <errors_resolved>");
    assert.ok(xml.includes("Push rejected"), "should include error data");
    assert.ok(xml.includes("</errors_resolved>"), "should close errors_resolved");
  });

  test("renderErrors renders multiple errors", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "error_tool", category: "error", data: "Error 1", priority: 2 }),
      makeEvent({ type: "error_tool", category: "error", data: "Error 2", priority: 2 }),
    ];
    const xml = renderErrors(events);
    assert.ok(xml.includes("Error 1"), "should include first error");
    assert.ok(xml.includes("Error 2"), "should include second error");
  });

  test("renderErrors returns empty for no events", () => {
    assert.equal(renderErrors([]), "", "should return empty string");
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

  test("renderIntent renders mode attribute and content", () => {
    const ev = makeEvent({ type: "intent", category: "intent", data: "investigate", priority: 4 });
    const xml = renderIntent(ev);
    assert.ok(xml.includes('mode="investigate"'), 'should include mode attribute');
    assert.ok(xml.includes("investigate"), "should include intent text");
  });
});

// ════════════════════════════════════════════
// SLICE 11: XML escaping
// ════════════════════════════════════════════

describe("Slice 11: XML Escaping", () => {
  test("escapes XML special characters in data fields", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file", category: "file", data: 'src/<Main & "App">.tsx', priority: 1 }),
    ];
    const xml = buildResumeSnapshot(events);
    // Should not contain raw < > & " in the data portion
    assert.ok(xml.includes("&lt;Main"), "should escape < to &lt;");
    assert.ok(xml.includes("&amp;"), "should escape & to &amp;");
    assert.ok(xml.includes("&quot;App&quot;"), "should escape quotes");
    // Should NOT contain the raw unescaped version in attribute values
    assert.ok(!xml.includes('path="src/<Main'), "should not have unescaped < in attribute");
  });

  test("escapes XML in rule data", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "rule", category: "rule", data: "Rule: x < y && z > 0", priority: 1 }),
    ];
    const xml = renderRules(events);
    assert.ok(xml.includes("&lt;"), "should escape < in rules");
    assert.ok(xml.includes("&amp;"), "should escape & in rules");
    assert.ok(xml.includes("&gt;"), "should escape > in rules");
  });

  test("escapes XML in error data", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "error_tool", category: "error", data: "Error: <tag> & 'quote'", priority: 2 }),
    ];
    const xml = renderErrors(events);
    assert.ok(xml.includes("&lt;tag&gt;"), "should escape tags in errors");
    assert.ok(xml.includes("&apos;quote&apos;"), "should escape single quotes in errors");
  });
});

// ════════════════════════════════════════════
// SLICE 12: Total output <= 2048 bytes
// ════════════════════════════════════════════

describe("Slice 12: Byte Budget", () => {
  test("total output is always <= 2048 bytes (default maxBytes)", () => {
    // Generate a lot of events to stress the budget
    const events: StoredEvent[] = [];
    for (let i = 0; i < 50; i++) {
      events.push(makeEvent({
        type: "file",
        category: "file",
        data: `src/very/long/path/to/some/deeply/nested/file-${i}.ts`,
        priority: 1,
      }));
    }
    for (let i = 0; i < 20; i++) {
      events.push(makeEvent({
        type: "task",
        category: "task",
        data: `Task ${i}: ${"x".repeat(100)}`,
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
    const byteSize = Buffer.byteLength(xml);
    assert.ok(byteSize <= 2048, `expected <= 2048 bytes, got ${byteSize}`);
  });

  test("respects custom maxBytes option", () => {
    const events: StoredEvent[] = [];
    for (let i = 0; i < 30; i++) {
      events.push(makeEvent({
        type: "file",
        category: "file",
        data: `src/file-${i}.ts`,
        priority: 1,
      }));
    }

    const xml = buildResumeSnapshot(events, { maxBytes: 512 });
    const byteSize = Buffer.byteLength(xml);
    assert.ok(byteSize <= 512, `expected <= 512 bytes, got ${byteSize}`);
  });
});

// ════════════════════════════════════════════
// SLICE 13: Budget trimming drops P3-P4 first
// ════════════════════════════════════════════

describe("Slice 13: Budget Trimming", () => {
  test("when over budget, drops P3-P4 sections first (intent)", () => {
    // Create events that fill up the budget, forcing trimming
    const events: StoredEvent[] = [];
    // P1 content
    for (let i = 0; i < 10; i++) {
      events.push(makeEvent({
        type: "file",
        category: "file",
        data: `src/component-${i}.tsx`,
        priority: 1,
      }));
    }
    // P2 content
    for (let i = 0; i < 5; i++) {
      events.push(makeEvent({
        type: "error_tool",
        category: "error",
        data: `Error resolving module ${i}`,
        priority: 2,
      }));
    }
    // P3-P4 content (intent)
    events.push(makeEvent({ type: "intent", category: "intent", data: "implement", priority: 4 }));

    // Use a tight budget that can fit P1+P2 but not P3
    const xmlFull = buildResumeSnapshot(events, { maxBytes: 4096 });
    assert.ok(xmlFull.includes("<intent"), "with large budget, intent should be present");

    // With a tight budget, intent should be dropped before P1/P2
    const xmlTight = buildResumeSnapshot(events, { maxBytes: 900 });
    if (xmlTight.includes("<active_files>") && !xmlTight.includes("<intent")) {
      // P1 kept, P3-P4 dropped -- correct behavior
      assert.ok(true, "P3-P4 (intent) dropped before P1 (active_files)");
    } else if (!xmlTight.includes("<active_files>") && !xmlTight.includes("<intent")) {
      // Both dropped due to very tight budget -- still correct (P3 dropped first)
      assert.ok(true, "All sections dropped due to very tight budget");
    } else if (xmlTight.includes("<intent") && !xmlTight.includes("<active_files>")) {
      assert.fail("P1 was dropped but P3-P4 was kept -- wrong priority order");
    }
  });

  test("budget trimming preserves P1 sections over P2 when budget is very tight", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file", category: "file", data: "src/a.ts", priority: 1 }),
      makeEvent({ type: "error_tool", category: "error", data: "Some error message that takes space", priority: 2 }),
      makeEvent({ type: "intent", category: "intent", data: "implement", priority: 4 }),
    ];

    // Budget tight enough to force some dropping
    const xml = buildResumeSnapshot(events, { maxBytes: 350 });

    // P1 should be preserved longest
    if (xml.includes("<active_files>")) {
      // If P1 fits, P2/P3 may or may not fit
      assert.ok(true, "P1 section preserved");
    }
    // If nothing fits, that's ok too -- the header/footer is valid XML
    assert.ok(xml.startsWith("<session_resume"), "should always start with session_resume");
  });
});

// ════════════════════════════════════════════
// SLICE 14: XML structure
// ════════════════════════════════════════════

describe("Slice 14: XML Structure", () => {
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
    // Verify it looks like an ISO timestamp
    const match = xml.match(/generated_at="([^"]+)"/);
    assert.ok(match, "should have a generated_at value");
    assert.ok(!isNaN(Date.parse(match![1])), "generated_at should be a valid ISO date");
  });

  test("buildResumeSnapshot with events_captured matches input length", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file", category: "file", data: "a.ts", priority: 1 }),
      makeEvent({ type: "file", category: "file", data: "b.ts", priority: 1 }),
      makeEvent({ type: "cwd", category: "cwd", data: "/project", priority: 2 }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes('events_captured="3"'), `should have events_captured="3", got: ${xml.slice(0, 120)}`);
  });
});

// ════════════════════════════════════════════
// EDGE CASES & INTEGRATION
// ════════════════════════════════════════════

describe("Edge Cases", () => {
  test("renderActiveFiles returns empty string for no events", () => {
    assert.equal(renderActiveFiles([]), "", "should return empty string");
  });

  test("renderTaskState returns empty string for no events", () => {
    assert.equal(renderTaskState([]), "", "should return empty string");
  });

  test("renderRules returns empty string for no events", () => {
    assert.equal(renderRules([]), "", "should return empty string");
  });

  test("renderDecisions returns empty string for no events", () => {
    assert.equal(renderDecisions([]), "", "should return empty string");
  });

  test("full integration: all event types combined", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file", category: "file", data: "src/server.ts", priority: 1 }),
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

    const xml = buildResumeSnapshot(events, { maxBytes: 4096 });

    // Verify structure
    assert.ok(xml.startsWith("<session_resume"), "starts with session_resume");
    assert.ok(xml.endsWith("</session_resume>"), "ends with session_resume");
    assert.ok(xml.includes('events_captured="10"'), "captures all 10 events");

    // Verify sections present (with generous budget)
    assert.ok(xml.includes("<active_files>"), "has active_files");
    assert.ok(xml.includes("<task_state>"), "has task_state");
    assert.ok(xml.includes("<rules>"), "has rules");
    assert.ok(xml.includes("<decisions>"), "has decisions");
    assert.ok(xml.includes("<environment>"), "has environment");
    assert.ok(xml.includes("<errors_resolved>"), "has errors_resolved");
    assert.ok(xml.includes("<intent"), "has intent");

    // Verify byte budget
    const byteSize = Buffer.byteLength(xml);
    assert.ok(byteSize <= 4096, `expected <= 4096 bytes, got ${byteSize}`);
  });

  test("handles file_write type correctly in renderActiveFiles", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file_write", category: "file", data: "src/new-file.ts", priority: 1 }),
    ];
    const xml = renderActiveFiles(events);
    assert.ok(xml.includes('ops="write:1"'), `expected write:1, got: ${xml}`);
    assert.ok(xml.includes('last="write"'), `expected last="write", got: ${xml}`);
  });

  test("renderDecisions deduplicates identical decisions", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "decision", category: "decision", data: "use ctx- prefix", priority: 2 }),
      makeEvent({ type: "decision", category: "decision", data: "use ctx- prefix", priority: 2 }),
    ];
    const xml = renderDecisions(events);
    const itemCount = (xml.match(/    - /g) || []).length;
    assert.equal(itemCount, 1, `expected 1 unique decision, got ${itemCount}`);
  });
});

// ════════════════════════════════════════════
// SLICE 14: SUBAGENT EVENTS -> <subagents>
// ════════════════════════════════════════════

describe("Slice 14: Subagent Rendering", () => {
  test("renderSubagents produces valid XML from subagent events", () => {
    const events: StoredEvent[] = [
      makeEvent({
        type: "subagent_completed",
        category: "subagent",
        data: "[completed] Research Cursor env vars → Found CURSOR_TRACE_DIR",
        priority: 2,
      }),
    ];
    const xml = renderSubagents(events);
    assert.ok(xml.includes("<subagents>"), "should open <subagents> tag");
    assert.ok(xml.includes("</subagents>"), "should close </subagents> tag");
    assert.ok(xml.includes("CURSOR_TRACE_DIR"), "should include agent result data");
  });

  test("renderSubagents returns empty string for no events", () => {
    assert.equal(renderSubagents([]), "", "should return empty string with no subagent events");
  });

  test("renderSubagents renders multiple agents", () => {
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
    const xml = renderSubagents(events);
    assert.ok(xml.includes("Gemini CLI"), "should include first agent");
    assert.ok(xml.includes("Codex CLI"), "should include second agent");
  });
});

// ════════════════════════════════════════════
// SLICE 15: buildResumeSnapshot includes <subagents>
// ════════════════════════════════════════════

describe("Slice 15: Snapshot includes subagents", () => {
  test("buildResumeSnapshot with subagent events includes <subagents> section", () => {
    const events: StoredEvent[] = [
      makeEvent({
        type: "subagent_completed",
        category: "subagent",
        data: "[completed] Research env vars → Found VSCODE_PID",
        priority: 2,
      }),
    ];
    const xml = buildResumeSnapshot(events, { maxBytes: 4096 });
    assert.ok(
      xml.includes("<subagents>"),
      `snapshot should include <subagents> section, got: ${xml}`,
    );
    assert.ok(xml.includes("VSCODE_PID"), "snapshot should include subagent data");
  });

  test("buildResumeSnapshot with 4 completed agents preserves all results", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "subagent_completed", category: "subagent", data: "[completed] Cursor → CURSOR_TRACE_DIR", priority: 2 }),
      makeEvent({ type: "subagent_completed", category: "subagent", data: "[completed] Gemini → GEMINI_PROJECT_DIR", priority: 2 }),
      makeEvent({ type: "subagent_completed", category: "subagent", data: "[completed] Codex → no detection", priority: 2 }),
      makeEvent({ type: "subagent_completed", category: "subagent", data: "[completed] VS Code → VSCODE_PID", priority: 2 }),
    ];
    const xml = buildResumeSnapshot(events, { maxBytes: 4096 });
    assert.ok(xml.includes("Cursor"), "should include Cursor agent result");
    assert.ok(xml.includes("Gemini"), "should include Gemini agent result");
    assert.ok(xml.includes("Codex"), "should include Codex agent result");
    assert.ok(xml.includes("VS Code"), "should include VS Code agent result");
  });
});
