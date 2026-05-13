/**
 * Snapshot builder — converts stored SessionEvents into a reference-based
 * XML resume snapshot.
 *
 * Pure functions only. No database access, no file system, no side effects.
 *
 * The output XML is injected into the LLM's context after a compact event to
 * restore session awareness. Instead of truncated inline data, each section
 * contains a natural summary plus a runnable search tool call that retrieves
 * full details from the indexed knowledge base on demand.
 *
 * Zero truncation. Zero information loss. Full data lives in SessionDB;
 * the snapshot is a table of contents.
 */

import { escapeXML } from "../truncate.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Stored event as read from SessionDB. */
export interface StoredEvent {
  type: string;
  category: string;
  data: string;
  priority: number;
  created_at?: string;
}

export interface BuildSnapshotOpts {
  maxBytes?: number;      // KEPT for backward compat but IGNORED
  compactCount?: number;
  searchTool?: string;    // platform-specific tool name, default "ctx_search"
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const MAX_ACTIVE_FILES = 10;

/**
 * Extract 2-4 keyword phrases from a list of strings for BM25 search queries.
 * Takes actual data values and picks representative terms.
 */
function buildQueries(items: string[], maxQueries = 4): string[] {
  const unique = [...new Set(items.filter(s => s.length > 0))];
  const selected = unique.slice(0, maxQueries);
  return selected.map(s => {
    // Take the first ~80 chars as a query — enough for BM25 matching
    const trimmed = s.length > 80 ? s.slice(0, 80) : s;
    return trimmed;
  });
}

/**
 * Format a runnable tool call block for a section.
 */
function toolCall(toolName: string, queries: string[]): string {
  if (queries.length === 0) return "";
  const escaped = queries.map(q => `"${escapeXML(q)}"`).join(", ");
  return `\n    For full details:\n    ${escapeXML(toolName)}(\n      queries: [${escaped}],\n      source: "session-events"\n    )`;
}

// ── Section builders ─────────────────────────────────────────────────────────

function buildFilesSection(fileEvents: StoredEvent[], searchTool: string): string {
  if (fileEvents.length === 0) return "";

  // Build per-file operation counts
  const fileMap = new Map<string, { ops: Map<string, number> }>();

  for (const ev of fileEvents) {
    const path = ev.data;
    let entry = fileMap.get(path);
    if (!entry) {
      entry = { ops: new Map() };
      fileMap.set(path, entry);
    }

    let op: string;
    if (ev.type === "file_write") op = "write";
    else if (ev.type === "file_read") op = "read";
    else if (ev.type === "file_edit") op = "edit";
    else op = ev.type;

    entry.ops.set(op, (entry.ops.get(op) ?? 0) + 1);
  }

  // Limit to last MAX_ACTIVE_FILES files (by insertion order = chronological)
  const entries = Array.from(fileMap.entries());
  const limited = entries.slice(-MAX_ACTIVE_FILES);

  const summaryLines: string[] = [];
  const queryTerms: string[] = [];

  for (const [path, { ops }] of limited) {
    const opsStr = Array.from(ops.entries())
      .map(([k, v]) => `${k}×${v}`)
      .join(", ");
    // Use just the filename for concise display
    const fileName = path.split("/").pop() ?? path;
    summaryLines.push(`    ${escapeXML(fileName)} (${escapeXML(opsStr)})`);
    queryTerms.push(`${fileName} ${Array.from(ops.keys()).join(" ")}`);
  }

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <files count="${fileMap.size}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </files>`,
  ];
  return lines.join("\n");
}

function buildErrorsSection(errorEvents: StoredEvent[], searchTool: string): string {
  if (errorEvents.length === 0) return "";

  const summaryLines: string[] = [];
  const queryTerms: string[] = [];

  for (const ev of errorEvents) {
    summaryLines.push(`    ${escapeXML(ev.data)}`);
    queryTerms.push(ev.data);
  }

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <errors count="${errorEvents.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </errors>`,
  ];
  return lines.join("\n");
}

function buildDecisionsSection(decisionEvents: StoredEvent[], searchTool: string): string {
  if (decisionEvents.length === 0) return "";

  const seen = new Set<string>();
  const summaryLines: string[] = [];
  const queryTerms: string[] = [];

  for (const ev of decisionEvents) {
    if (seen.has(ev.data)) continue;
    seen.add(ev.data);
    summaryLines.push(`    ${escapeXML(ev.data)}`);
    queryTerms.push(ev.data);
  }

  if (summaryLines.length === 0) return "";

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <decisions count="${summaryLines.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </decisions>`,
  ];
  return lines.join("\n");
}

function buildRulesSection(ruleEvents: StoredEvent[], searchTool: string): string {
  if (ruleEvents.length === 0) return "";

  const seen = new Set<string>();
  const summaryLines: string[] = [];
  const queryTerms: string[] = [];

  for (const ev of ruleEvents) {
    if (seen.has(ev.data)) continue;
    seen.add(ev.data);

    if (ev.type === "rule_content") {
      summaryLines.push(`    ${escapeXML(ev.data)}`);
    } else {
      summaryLines.push(`    ${escapeXML(ev.data)}`);
    }
    queryTerms.push(ev.data);
  }

  if (summaryLines.length === 0) return "";

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <rules count="${summaryLines.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </rules>`,
  ];
  return lines.join("\n");
}

function buildGitSection(gitEvents: StoredEvent[], searchTool: string): string {
  if (gitEvents.length === 0) return "";

  const summaryLines: string[] = [];
  const queryTerms: string[] = [];

  for (const ev of gitEvents) {
    summaryLines.push(`    ${escapeXML(ev.data)}`);
    queryTerms.push(ev.data);
  }

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <git count="${gitEvents.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </git>`,
  ];
  return lines.join("\n");
}

/**
 * Render <task_state> from task events.
 * Reconstructs the full task list from create/update events,
 * filters out completed tasks, and renders only pending/in-progress work.
 *
 * TaskCreate events have `{ subject }`, TaskUpdate events have `{ taskId, status }`.
 * Match by chronological order: creates[0] -> lowest taskId from updates.
 */
export function renderTaskState(taskEvents: StoredEvent[]): string {
  if (taskEvents.length === 0) return "";

  const creates: string[] = [];
  const updates: Record<string, string> = {};

  for (const ev of taskEvents) {
    try {
      const parsed = JSON.parse(ev.data) as Record<string, unknown>;
      if (typeof parsed.subject === "string") {
        creates.push(parsed.subject);
      } else if (typeof parsed.taskId === "string" && typeof parsed.status === "string") {
        updates[parsed.taskId] = parsed.status;
      }
    } catch { /* not JSON */ }
  }

  if (creates.length === 0) return "";

  const DONE = new Set(["completed", "deleted", "failed"]);

  // Match creates to updates positionally (creates[0] -> lowest taskId)
  const sortedIds = Object.keys(updates).sort((a, b) => Number(a) - Number(b));

  const pending: string[] = [];
  for (let i = 0; i < creates.length; i++) {
    const matchedId = sortedIds[i];
    const status = matchedId ? (updates[matchedId] ?? "pending") : "pending";
    if (!DONE.has(status)) {
      pending.push(creates[i]);
    }
  }

  // All tasks completed — nothing to render
  if (pending.length === 0) return "";

  const lines: string[] = [];
  for (const task of pending) {
    lines.push(`    [pending] ${escapeXML(task)}`);
  }
  return lines.join("\n");
}

function buildTaskSection(taskEvents: StoredEvent[], searchTool: string): string {
  const taskContent = renderTaskState(taskEvents);
  if (!taskContent) return "";

  const queryTerms: string[] = [];
  for (const ev of taskEvents) {
    try {
      const parsed = JSON.parse(ev.data) as Record<string, unknown>;
      if (typeof parsed.subject === "string") {
        queryTerms.push(parsed.subject);
      }
    } catch { /* not JSON */ }
  }

  const queries = buildQueries(queryTerms);
  const pendingCount = taskContent.split("\n").length;

  const lines = [
    `  <task_state count="${pendingCount}">`,
    taskContent,
    toolCall(searchTool, queries),
    `  </task_state>`,
  ];
  return lines.join("\n");
}

function buildEnvironmentSection(
  cwdEvents: StoredEvent[],
  envEvents: StoredEvent[],
  searchTool: string,
): string {
  if (cwdEvents.length === 0 && envEvents.length === 0) return "";

  const summaryLines: string[] = [];
  const queryTerms: string[] = [];

  if (cwdEvents.length > 0) {
    const lastCwd = cwdEvents[cwdEvents.length - 1];
    summaryLines.push(`    cwd: ${escapeXML(lastCwd.data)}`);
    queryTerms.push("working directory");
  }

  for (const env of envEvents) {
    summaryLines.push(`    ${escapeXML(env.data)}`);
    queryTerms.push(env.data);
  }

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <environment>`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </environment>`,
  ];
  return lines.join("\n");
}

function buildSubagentsSection(subagentEvents: StoredEvent[], searchTool: string): string {
  if (subagentEvents.length === 0) return "";

  const summaryLines: string[] = [];
  const queryTerms: string[] = [];

  for (const ev of subagentEvents) {
    const status = ev.type === "subagent_completed" ? "completed"
      : ev.type === "subagent_launched" ? "launched"
      : "unknown";
    summaryLines.push(`    [${status}] ${escapeXML(ev.data)}`);
    queryTerms.push(`subagent ${ev.data}`);
  }

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <subagents count="${subagentEvents.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </subagents>`,
  ];
  return lines.join("\n");
}

function buildSkillsSection(skillEvents: StoredEvent[], searchTool: string): string {
  if (skillEvents.length === 0) return "";

  // Count invocations per skill name
  const skillCounts = new Map<string, number>();
  for (const ev of skillEvents) {
    const name = ev.data.split(":")[0].trim();
    skillCounts.set(name, (skillCounts.get(name) ?? 0) + 1);
  }

  const summaryLines: string[] = [];
  const queryTerms: string[] = [];

  for (const [name, count] of skillCounts) {
    summaryLines.push(`    ${escapeXML(name)} (${count}×)`);
    queryTerms.push(`skill ${name} invocation`);
  }

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <skills count="${skillEvents.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </skills>`,
  ];
  return lines.join("\n");
}

function buildRolesSection(roleEvents: StoredEvent[], searchTool: string): string {
  if (roleEvents.length === 0) return "";

  const seen = new Set<string>();
  const summaryLines: string[] = [];
  const queryTerms: string[] = [];

  for (const ev of roleEvents) {
    if (seen.has(ev.data)) continue;
    seen.add(ev.data);
    summaryLines.push(`    ${escapeXML(ev.data)}`);
    queryTerms.push(ev.data);
  }

  if (summaryLines.length === 0) return "";

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <roles count="${summaryLines.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </roles>`,
  ];
  return lines.join("\n");
}

function buildIntentSection(intentEvents: StoredEvent[]): string {
  if (intentEvents.length === 0) return "";
  const lastIntent = intentEvents[intentEvents.length - 1];
  return `  <intent mode="${escapeXML(lastIntent.data)}"/>`;
}

/**
 * Raw-prompt safety net (issue #535):
 * Always surface the most recent user prompts verbatim so the next LLM
 * sees them even if every universal-rule detector misses. Bound per-prompt
 * payload to RECENT_MESSAGE_MAX_CHARS Unicode codepoints; bound the total
 * count to RECENT_MESSAGES_LIMIT to keep the resume block compact.
 */
const RECENT_MESSAGES_LIMIT = 3;
const RECENT_MESSAGE_MAX_CHARS = 400;

function truncateForSnapshot(value: string, max: number): string {
  const codepoints = [...value];
  if (codepoints.length <= max) return value;
  return codepoints.slice(0, max).join("");
}

function buildRecentMessagesSection(userPromptEvents: StoredEvent[]): string {
  if (userPromptEvents.length === 0) return "";

  // Last N in chronological order — newest at the bottom mirrors the
  // way the user reads their own scrollback.
  const recent = userPromptEvents.slice(-RECENT_MESSAGES_LIMIT);

  const items = recent
    .map(ev => {
      const body = truncateForSnapshot(ev.data ?? "", RECENT_MESSAGE_MAX_CHARS);
      if (!body) return "";
      return `    <message>${escapeXML(body)}</message>`;
    })
    .filter(Boolean);

  if (items.length === 0) return "";

  return [
    `  <recent_user_messages count="${items.length}">`,
    ...items,
    `  </recent_user_messages>`,
  ].join("\n");
}

// ── Main builder ─────────────────────────────────────────────────────────────

/**
 * Build a reference-based resume snapshot XML string from stored session events.
 *
 * Algorithm:
 * 1. Group events by category
 * 2. For each non-empty category, build a summary section with a runnable
 *    search tool call containing exact queries for full details
 * 3. Assemble ALL non-empty sections — no priority dropping, no byte budget
 */
export function buildResumeSnapshot(
  events: StoredEvent[],
  opts?: BuildSnapshotOpts,
): string {
  const compactCount = opts?.compactCount ?? 1;
  const searchTool = opts?.searchTool ?? "ctx_search";
  const now = new Date().toISOString();

  // ── Group events by category ──
  const fileEvents: StoredEvent[] = [];
  const taskEvents: StoredEvent[] = [];
  const ruleEvents: StoredEvent[] = [];
  const decisionEvents: StoredEvent[] = [];
  const cwdEvents: StoredEvent[] = [];
  const errorEvents: StoredEvent[] = [];
  const envEvents: StoredEvent[] = [];
  const gitEvents: StoredEvent[] = [];
  const subagentEvents: StoredEvent[] = [];
  const intentEvents: StoredEvent[] = [];
  const skillEvents: StoredEvent[] = [];
  const roleEvents: StoredEvent[] = [];
  const userPromptEvents: StoredEvent[] = [];

  for (const ev of events) {
    switch (ev.category) {
      case "file": fileEvents.push(ev); break;
      case "task": taskEvents.push(ev); break;
      case "rule": ruleEvents.push(ev); break;
      case "decision": decisionEvents.push(ev); break;
      case "cwd": cwdEvents.push(ev); break;
      case "error": errorEvents.push(ev); break;
      case "env": envEvents.push(ev); break;
      case "git": gitEvents.push(ev); break;
      case "subagent": subagentEvents.push(ev); break;
      case "intent": intentEvents.push(ev); break;
      case "skill": skillEvents.push(ev); break;
      case "role": roleEvents.push(ev); break;
      case "user-prompt": userPromptEvents.push(ev); break;
    }
  }

  // ── Build all sections ──
  const sections: string[] = [];

  // How-to-search instruction block (always present)
  sections.push(`  <how_to_search>
  Each section below contains a summary of prior work.
  For FULL DETAILS, run the exact tool call shown under each section.
  Do NOT ask the user to re-explain prior work. Search first.
  Do NOT invent your own queries — use the ones provided.
  </how_to_search>`);

  const files = buildFilesSection(fileEvents, searchTool);
  if (files) sections.push(files);

  const errors = buildErrorsSection(errorEvents, searchTool);
  if (errors) sections.push(errors);

  const decisions = buildDecisionsSection(decisionEvents, searchTool);
  if (decisions) sections.push(decisions);

  const rules = buildRulesSection(ruleEvents, searchTool);
  if (rules) sections.push(rules);

  const git = buildGitSection(gitEvents, searchTool);
  if (git) sections.push(git);

  const tasks = buildTaskSection(taskEvents, searchTool);
  if (tasks) sections.push(tasks);

  const environment = buildEnvironmentSection(cwdEvents, envEvents, searchTool);
  if (environment) sections.push(environment);

  const subagents = buildSubagentsSection(subagentEvents, searchTool);
  if (subagents) sections.push(subagents);

  const skills = buildSkillsSection(skillEvents, searchTool);
  if (skills) sections.push(skills);

  const roles = buildRolesSection(roleEvents, searchTool);
  if (roles) sections.push(roles);

  const intent = buildIntentSection(intentEvents);
  if (intent) sections.push(intent);

  // Raw-prompt safety net — always last so it stays adjacent to the next
  // LLM turn and is read after the structured sections.
  const recentMessages = buildRecentMessagesSection(userPromptEvents);
  if (recentMessages) sections.push(recentMessages);

  // ── Assemble ──
  const header = `<session_resume events="${events.length}" compact_count="${compactCount}" generated_at="${now}">`;
  const footer = `</session_resume>`;

  const body = sections.join("\n\n");
  if (body) {
    return `${header}\n\n${body}\n\n${footer}`;
  }
  return `${header}\n${footer}`;
}
