/**
 * Shared session directive builder for all platform adaptors.
 *
 * Contains: groupEvents, writeSessionEventsFile, buildSessionDirective, getSessionEvents, getLatestSessionEvents.
 * Each adaptor imports these instead of duplicating the logic.
 */

import { writeFileSync } from "node:fs";

// ── Group events by category and extract metadata ──
export function groupEvents(events) {
  const grouped = {};
  let lastPrompt = "";
  for (const ev of events) {
    if (ev.category === "prompt") {
      lastPrompt = ev.data;
      continue;
    }
    if (!grouped[ev.category]) grouped[ev.category] = [];
    grouped[ev.category].push(ev);
  }
  const fileNames = new Set();
  for (const ev of (grouped.file || [])) {
    const path = ev.data.includes(" in ") ? ev.data.split(" in ").pop() : ev.data;
    const base = path?.split(/[/\\]/).pop()?.trim();
    if (base && !base.includes("*")) fileNames.add(base);
  }
  return { grouped, lastPrompt, fileNames };
}

// ── Write session events as markdown for FTS5 auto-indexing ──
// Structured with H2 headings per category — optimal for FTS5 chunking.
export function writeSessionEventsFile(events, eventsPath) {
  const { grouped, lastPrompt, fileNames } = groupEvents(events);

  const lines = [];
  lines.push("# Session Resume");
  lines.push("");
  lines.push(`Events: ${events.length} | Timestamp: ${new Date().toISOString()}`);
  lines.push("");

  if (fileNames.size > 0) {
    lines.push("## Active Files");
    lines.push("");
    for (const name of fileNames) lines.push(`- ${name}`);
    lines.push("");
  }

  if (grouped.rule?.length > 0) {
    lines.push("## Project Rules");
    lines.push("");
    for (const ev of grouped.rule) {
      if (ev.type === "rule_content") {
        const downgraded = ev.data.replace(/^(#{1,3}) /gm, (_, hashes) => "#".repeat(hashes.length + 3) + " ");
        lines.push(downgraded);
        lines.push("");
      } else {
        lines.push(`- ${ev.data}`);
      }
    }
    lines.push("");
  }

  if (grouped.task?.length > 0) {
    const creates = [];
    const updates = {};
    for (const ev of grouped.task) {
      try {
        const parsed = JSON.parse(ev.data);
        if (parsed.subject) {
          creates.push(parsed.subject);
        } else if (parsed.taskId && parsed.status) {
          updates[parsed.taskId] = parsed.status;
        }
      } catch { /* not JSON — dump as-is */
        creates.push(ev.data);
      }
    }
    const DONE = new Set(["completed", "deleted", "failed"]);
    const sortedIds = Object.keys(updates).sort((a, b) => Number(a) - Number(b));
    const pending = [];
    const completed = [];
    for (let i = 0; i < creates.length; i++) {
      const matchedId = sortedIds[i];
      const status = matchedId ? (updates[matchedId] || "pending") : "pending";
      if (DONE.has(status)) {
        completed.push(creates[i]);
      } else {
        pending.push(creates[i]);
      }
    }
    if (pending.length > 0) {
      lines.push("## Tasks In Progress");
      lines.push("");
      for (const task of pending) lines.push(`- ${task}`);
      lines.push("");
    }
    if (completed.length > 0) {
      lines.push("## Tasks Completed");
      lines.push("");
      for (const task of completed) lines.push(`- ${task}`);
      lines.push("");
    }
  }

  if (grouped.decision?.length > 0) {
    lines.push("## User Decisions");
    lines.push("");
    for (const ev of grouped.decision) lines.push(`- ${ev.data}`);
    lines.push("");
  }

  if (grouped.git?.length > 0) {
    lines.push("## Git Operations");
    lines.push("");
    for (const ev of grouped.git) lines.push(`- ${ev.data}`);
    lines.push("");
  }

  if (grouped.env?.length > 0 || grouped.cwd?.length > 0) {
    lines.push("## Environment");
    lines.push("");
    if (grouped.cwd?.length > 0) {
      lines.push(`- cwd: ${grouped.cwd[grouped.cwd.length - 1].data}`);
    }
    for (const ev of (grouped.env || [])) lines.push(`- ${ev.data}`);
    lines.push("");
  }

  if (grouped.error?.length > 0) {
    lines.push("## Errors Encountered");
    lines.push("");
    for (const ev of grouped.error) lines.push(`- ${ev.data}`);
    lines.push("");
  }

  if (grouped.mcp?.length > 0) {
    const toolCounts = {};
    for (const ev of grouped.mcp) {
      const tool = ev.data.split(":")[0].trim();
      toolCounts[tool] = (toolCounts[tool] || 0) + 1;
    }
    lines.push("## MCP Tool Usage");
    lines.push("");
    for (const [tool, count] of Object.entries(toolCounts)) {
      lines.push(`- ${tool}: ${count} calls`);
    }
    lines.push("");
  }

  if (grouped.subagent?.length > 0) {
    lines.push("## Subagent Tasks");
    lines.push("");
    for (const ev of grouped.subagent) lines.push(`- ${ev.data}`);
    lines.push("");
  }

  if (grouped.skill?.length > 0) {
    const uniqueSkills = new Set(grouped.skill.map(e => e.data));
    lines.push("## Active Skills");
    lines.push("");
    lines.push(`- ${[...uniqueSkills].join(", ")}`);
    lines.push("");
  }

  if (grouped.intent?.length > 0) {
    lines.push("## Session Intent");
    lines.push("");
    lines.push(`- ${grouped.intent[grouped.intent.length - 1].data}`);
    lines.push("");
  }

  if (grouped.role?.length > 0) {
    lines.push("## User Role");
    lines.push("");
    lines.push(`- ${grouped.role[grouped.role.length - 1].data}`);
    lines.push("");
  }

  if (grouped.data?.length > 0) {
    lines.push("## Data References");
    lines.push("");
    for (const ev of grouped.data) lines.push(`- ${ev.data}`);
    lines.push("");
  }

  if (grouped.plan?.length > 0) {
    const hasApproved = grouped.plan.some(e => e.type === "plan_approved");
    const hasRejected = grouped.plan.some(e => e.type === "plan_rejected");
    const lastPlan = grouped.plan[grouped.plan.length - 1];
    const isActive = lastPlan.type === "plan_enter" || lastPlan.type === "plan_file_write";
    lines.push("## Plan Mode");
    lines.push("");
    if (hasApproved) lines.push("- Status: APPROVED AND EXECUTED");
    else if (hasRejected) lines.push("- Status: REJECTED BY USER");
    else if (isActive) lines.push("- Status: ACTIVE (in planning)");
    else lines.push("- Status: COMPLETED");
    for (const ev of grouped.plan) lines.push(`- ${ev.data}`);
    lines.push("");
  }

  if (lastPrompt) {
    lines.push("## Last User Prompt");
    lines.push("");
    lines.push(lastPrompt);
    lines.push("");
  }

  writeFileSync(eventsPath, lines.join("\n"), "utf-8");
  return { grouped, lastPrompt, fileNames };
}

// ── Build session guide — actionable narrative for LLM to continue from ──
export function buildSessionDirective(source, eventMeta, toolNamer) {
  const { grouped, lastPrompt, fileNames } = eventMeta;
  const isCompact = source === "compact";

  let block = `\n<session_knowledge source="${isCompact ? "compact" : "continue"}">`;
  block += `\n<session_guide>`;

  // 1. Last request — most critical for continuation
  if (lastPrompt) {
    // Truncate overly long prompts — keep first 300 chars as summary
    const displayPrompt = lastPrompt.length > 300
      ? lastPrompt.substring(0, 297) + "..."
      : lastPrompt;
    block += `\n## Last Request`;
    block += `\n${displayPrompt}`;
    block += `\n`;
  }

  // 2. Tasks — parsed into readable format, only pending/in-progress shown
  // TaskCreate events have {subject} but no taskId.
  // TaskUpdate events have {taskId, status} but no subject.
  // Match by chronological order: creates[0] → lowest taskId from updates.
  // Completed tasks are excluded — the model should not re-work them.
  if (grouped.task?.length > 0) {
    const creates = [];
    const updates = {};

    for (const ev of grouped.task) {
      try {
        const parsed = JSON.parse(ev.data);
        if (parsed.subject) {
          creates.push(parsed.subject);
        } else if (parsed.taskId && parsed.status) {
          updates[parsed.taskId] = parsed.status;
        }
      } catch { /* not JSON */ }
    }

    if (creates.length > 0) {
      const DONE = new Set(["completed", "deleted", "failed"]);
      const sortedIds = Object.keys(updates).sort((a, b) => Number(a) - Number(b));
      const pending = [];
      for (let i = 0; i < creates.length; i++) {
        const matchedId = sortedIds[i];
        const status = matchedId ? (updates[matchedId] || "pending") : "pending";
        if (!DONE.has(status)) {
          pending.push(creates[i]);
        }
      }
      if (pending.length > 0) {
        block += `\n## Pending Tasks`;
        for (const task of pending) {
          block += `\n- ${task}`;
        }
        block += `\n`;
      }
    }
  }

  // 3. Key decisions
  if (grouped.decision?.length > 0) {
    block += `\n## Key Decisions`;
    for (const ev of grouped.decision) {
      const text = ev.data.length > 150 ? ev.data.substring(0, 147) + "..." : ev.data;
      block += `\n- ${text}`;
    }
    block += `\n`;
  }

  // 4. Files modified
  if (fileNames.size > 0) {
    block += `\n## Files Modified`;
    block += `\n${[...fileNames].join(", ")}`;
    block += `\n`;
  }

  // 5. Errors
  if (grouped.error?.length > 0) {
    block += `\n## Unresolved Errors`;
    for (const ev of grouped.error) {
      const text = ev.data.length > 150 ? ev.data.substring(0, 147) + "..." : ev.data;
      block += `\n- ${text}`;
    }
    block += `\n`;
  }

  // 6. Git state
  if (grouped.git?.length > 0) {
    const uniqueOps = [...new Set(grouped.git.map(e => e.data))];
    block += `\n## Git`;
    block += `\n${uniqueOps.join(", ")}`;
    block += `\n`;
  }

  // 7. Project rules (paths only)
  if (grouped.rule?.length > 0) {
    const rPaths = grouped.rule
      .filter(e => e.type !== "rule_content")
      .map(e => {
        const parts = e.data.split(/[/\\]/);
        return parts.slice(-2).join("/");
      });
    const uniquePaths = [...new Set(rPaths)];
    if (uniquePaths.length > 0) {
      block += `\n## Project Rules`;
      block += `\n${uniquePaths.join(", ")}`;
      block += `\n`;
    }
  }

  // 8. MCP tools used
  if (grouped.mcp?.length > 0) {
    const toolCounts = {};
    for (const ev of grouped.mcp) {
      const tool = ev.data.split(":")[0].trim();
      toolCounts[tool] = (toolCounts[tool] || 0) + 1;
    }
    block += `\n## MCP Tools Used`;
    block += `\n${Object.entries(toolCounts).map(([t, c]) => `${t}(${c})`).join(", ")}`;
    block += `\n`;
  }

  // 9. Subagent tasks
  if (grouped.subagent?.length > 0) {
    block += `\n## Subagent Tasks`;
    for (const ev of grouped.subagent) {
      const text = ev.data.length > 120 ? ev.data.substring(0, 117) + "..." : ev.data;
      block += `\n- ${text}`;
    }
    block += `\n`;
  }

  // 10. Skills invoked
  if (grouped.skill?.length > 0) {
    const uniqueSkills = [...new Set(grouped.skill.map(e => e.data))];
    block += `\n## Skills Used`;
    block += `\n${uniqueSkills.join(", ")}`;
    block += `\n`;
  }

  // 11. Environment
  if (grouped.env?.length > 0 || grouped.cwd?.length > 0) {
    block += `\n## Environment`;
    if (grouped.cwd?.length > 0) {
      block += `\ncwd: ${grouped.cwd[grouped.cwd.length - 1].data}`;
    }
    for (const ev of (grouped.env || [])) {
      block += `\n${ev.data}`;
    }
    block += `\n`;
  }

  // 12. Data references
  if (grouped.data?.length > 0) {
    block += `\n## Data References`;
    for (const ev of grouped.data) {
      const text = ev.data.length > 150 ? ev.data.substring(0, 147) + "..." : ev.data;
      block += `\n- ${text}`;
    }
    block += `\n`;
  }

  // 13. Intent / Role (if set)
  if (grouped.intent?.length > 0) {
    block += `\n## Session Intent`;
    block += `\n${grouped.intent[grouped.intent.length - 1].data}`;
    block += `\n`;
  }
  if (grouped.role?.length > 0) {
    block += `\n## User Role`;
    block += `\n${grouped.role[grouped.role.length - 1].data}`;
    block += `\n`;
  }

  // 14. Plan mode state — critical for preventing stale plan restoration
  if (grouped.plan?.length > 0) {
    const hasApproved = grouped.plan.some(e => e.type === "plan_approved");
    const hasRejected = grouped.plan.some(e => e.type === "plan_rejected");
    const hasFileWrite = grouped.plan.some(e => e.type === "plan_file_write");
    const lastPlan = grouped.plan[grouped.plan.length - 1];
    const isActive = lastPlan.type === "plan_enter" || lastPlan.type === "plan_file_write";

    block += `\n## Plan Mode`;
    if (hasApproved) {
      block += `\n- Status: APPROVED AND EXECUTED`;
      block += `\n- The plan was approved and executed. Do NOT re-enter plan mode or re-propose the same plan.`;
    } else if (hasRejected) {
      block += `\n- Status: REJECTED BY USER`;
      block += `\n- The user rejected the previous plan. Ask what they want changed before re-planning.`;
    } else if (isActive) {
      block += `\n- Status: ACTIVE (in planning phase)`;
      if (hasFileWrite) {
        block += `\n- Plan file has been written. Awaiting user approval via ExitPlanMode.`;
      }
    } else {
      block += `\n- Status: COMPLETED`;
      block += `\n- The plan has been executed. Do NOT re-enter plan mode or re-propose the same plan.`;
    }
    block += `\n`;
  }

  block += `\n</session_guide>`;

  // Search on demand — detailed data lives in FTS5
  block += `\n<session_search>`;
  block += `\nDetailed session data is indexed in context-mode FTS5 (source: "session-events").`;
  const searchTool = toolNamer ? toolNamer("ctx_search") : "ctx_search";
  block += `\nUse ${searchTool}(queries: [...], source: "session-events") when you need specifics.`;
  block += `\nDo NOT call ctx_index() — data is already indexed.`;
  block += `\n</session_search>`;

  // Continue instruction
  if (lastPrompt && isCompact) {
    block += `\n<continue_from>Continue working on the last request. Do NOT ask the user to repeat themselves.</continue_from>`;
  }

  block += `\n</session_knowledge>`;
  return block;
}

// ── Get events for a specific session (used by compact) ──
export function getSessionEvents(db, sessionId) {
  return db.db.prepare(
    `SELECT session_id, type, category, priority, data, source_hook, created_at
     FROM session_events WHERE session_id = ? ORDER BY created_at ASC`
  ).all(sessionId);
}

// ── Get events from the most recent session that has events (used by resume) ──
export function getLatestSessionEvents(db) {
  const latest = db.db.prepare(
    `SELECT m.session_id FROM session_meta m
     JOIN session_events e ON m.session_id = e.session_id
     GROUP BY m.session_id
     ORDER BY m.started_at DESC LIMIT 1`
  ).get();
  if (!latest) return [];
  return getSessionEvents(db, latest.session_id);
}
