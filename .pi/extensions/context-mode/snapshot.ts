/**
 * Snapshot builder — converts stored SessionEvents into an XML resume snapshot.
 *
 * Pure functions only. No database access, no file system, no side effects.
 * The output XML is injected into pi's context after a compact event.
 */

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
  maxBytes?: number;
  compactCount?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 2048;
const MAX_ACTIVE_FILES = 10;

const P1_CATEGORIES = new Set(["file", "task", "rule"]);
const P2_CATEGORIES = new Set(["cwd", "error", "decision", "env", "git"]);

// ── XML helpers ─────────────────────────────────────────────────────────────

function escapeXML(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncateString(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

// ── Section renderers ────────────────────────────────────────────────────────

/**
 * Render <active_files> from file events.
 */
export function renderActiveFiles(fileEvents: StoredEvent[]): string {
  if (fileEvents.length === 0) return "";

  const fileMap = new Map<string, { ops: Map<string, number>; last: string }>();

  for (const ev of fileEvents) {
    const path = ev.data;
    let entry = fileMap.get(path);
    if (!entry) {
      entry = { ops: new Map(), last: "" };
      fileMap.set(path, entry);
    }

    let op: string;
    if (ev.type === "file_write") op = "write";
    else if (ev.type === "file_read") op = "read";
    else if (ev.type === "file_edit") op = "edit";
    else op = ev.type;

    entry.ops.set(op, (entry.ops.get(op) ?? 0) + 1);
    entry.last = op;
  }

  const entries = Array.from(fileMap.entries());
  const limited = entries.slice(-MAX_ACTIVE_FILES);

  const lines: string[] = ["  <active_files>"];
  for (const [path, { ops, last }] of limited) {
    const opsStr = Array.from(ops.entries())
      .map(([k, v]) => `${k}:${v}`)
      .join(",");
    lines.push(`    <file path="${escapeXML(path)}" ops="${escapeXML(opsStr)}" last="${escapeXML(last)}" />`);
  }
  lines.push("  </active_files>");
  return lines.join("\n");
}

/**
 * Render <task_state> from task events.
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
  const sortedIds = Object.keys(updates).sort((a, b) => Number(a) - Number(b));

  const pending: string[] = [];
  for (let i = 0; i < creates.length; i++) {
    const matchedId = sortedIds[i];
    const status = matchedId ? (updates[matchedId] ?? "pending") : "pending";
    if (!DONE.has(status)) {
      pending.push(creates[i]);
    }
  }

  if (pending.length === 0) return "";

  const lines: string[] = ["  <task_state>"];
  for (const task of pending) {
    lines.push(`    - ${escapeXML(truncateString(task, 100))}`);
  }
  lines.push("  </task_state>");
  return lines.join("\n");
}

/**
 * Render <rules> from rule events.
 */
export function renderRules(ruleEvents: StoredEvent[]): string {
  if (ruleEvents.length === 0) return "";

  const seen = new Set<string>();
  const lines: string[] = ["  <rules>"];

  for (const ev of ruleEvents) {
    const key = ev.data;
    if (seen.has(key)) continue;
    seen.add(key);

    if (ev.type === "rule_content") {
      lines.push(`    <rule_content>${escapeXML(truncateString(ev.data, 400))}</rule_content>`);
    } else {
      lines.push(`    - ${escapeXML(truncateString(ev.data, 200))}`);
    }
  }

  lines.push("  </rules>");
  return lines.join("\n");
}

/**
 * Render <decisions> from decision events.
 */
export function renderDecisions(decisionEvents: StoredEvent[]): string {
  if (decisionEvents.length === 0) return "";

  const seen = new Set<string>();
  const lines: string[] = ["  <decisions>"];

  for (const ev of decisionEvents) {
    const key = ev.data;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`    - ${escapeXML(truncateString(ev.data, 200))}`);
  }

  lines.push("  </decisions>");
  return lines.join("\n");
}

/**
 * Render <environment> from cwd, env, and git events.
 */
export function renderEnvironment(
  cwdEvent: StoredEvent | undefined,
  envEvents: StoredEvent[],
  gitEvent: StoredEvent | undefined,
): string {
  const parts: string[] = [];

  if (!cwdEvent && envEvents.length === 0 && !gitEvent) return "";

  parts.push("  <environment>");

  if (cwdEvent) {
    parts.push(`    <cwd>${escapeXML(cwdEvent.data)}</cwd>`);
  }

  if (gitEvent) {
    parts.push(`    <git op="${escapeXML(gitEvent.data)}" />`);
  }

  for (const env of envEvents) {
    parts.push(`    <env>${escapeXML(truncateString(env.data, 150))}</env>`);
  }

  parts.push("  </environment>");
  return parts.join("\n");
}

/**
 * Render <errors_encountered> from error events.
 */
export function renderErrors(errorEvents: StoredEvent[]): string {
  if (errorEvents.length === 0) return "";

  const lines: string[] = ["  <errors_encountered>"];

  for (const ev of errorEvents) {
    lines.push(`    - ${escapeXML(truncateString(ev.data, 150))}`);
  }

  lines.push("  </errors_encountered>");
  return lines.join("\n");
}

/**
 * Render <intent> from the most recent intent event.
 */
export function renderIntent(intentEvent: StoredEvent): string {
  return `  <intent mode="${escapeXML(intentEvent.data)}">${escapeXML(truncateString(intentEvent.data, 100))}</intent>`;
}

/**
 * Render <subagents> from subagent events.
 */
export function renderSubagents(subagentEvents: StoredEvent[]): string {
  if (subagentEvents.length === 0) return "";

  const lines: string[] = ["  <subagents>"];
  for (const ev of subagentEvents) {
    const status = ev.type === "subagent_completed" ? "completed"
      : ev.type === "subagent_launched" ? "launched"
      : "unknown";
    lines.push(`    <agent status="${status}">${escapeXML(truncateString(ev.data, 200))}</agent>`);
  }
  lines.push("  </subagents>");
  return lines.join("\n");
}

/**
 * Render <mcp_tools> from MCP tool call events.
 */
export function renderMcpTools(mcpEvents: StoredEvent[]): string {
  if (mcpEvents.length === 0) return "";

  const toolCounts = new Map<string, number>();
  for (const ev of mcpEvents) {
    const tool = ev.data.split(":")[0].trim();
    toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
  }

  const lines: string[] = ["  <mcp_tools>"];
  for (const [tool, count] of toolCounts) {
    lines.push(`    <tool name="${escapeXML(tool)}" calls="${count}" />`);
  }
  lines.push("  </mcp_tools>");
  return lines.join("\n");
}

// ── Main builder ─────────────────────────────────────────────────────────────

/**
 * Build a resume snapshot XML string from stored session events.
 */
export function buildResumeSnapshot(
  events: StoredEvent[],
  opts?: BuildSnapshotOpts,
): string {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const compactCount = opts?.compactCount ?? 1;
  const now = new Date().toISOString();

  // Group events by category
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
  const mcpEvents: StoredEvent[] = [];
  const planEvents: StoredEvent[] = [];

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
      case "mcp": mcpEvents.push(ev); break;
      case "plan": planEvents.push(ev); break;
    }
  }

  // P1 sections (50% budget): active_files, task_state, rules
  const p1Sections: string[] = [];
  const activeFiles = renderActiveFiles(fileEvents);
  if (activeFiles) p1Sections.push(activeFiles);
  const taskState = renderTaskState(taskEvents);
  if (taskState) p1Sections.push(taskState);
  const rules = renderRules(ruleEvents);
  if (rules) p1Sections.push(rules);

  // P2 sections (35% budget): decisions, environment, errors, completed subagents
  const p2Sections: string[] = [];
  const decisions = renderDecisions(decisionEvents);
  if (decisions) p2Sections.push(decisions);
  const lastCwd = cwdEvents.length > 0 ? cwdEvents[cwdEvents.length - 1] : undefined;
  const lastGit = gitEvents.length > 0 ? gitEvents[gitEvents.length - 1] : undefined;
  const environment = renderEnvironment(lastCwd, envEvents, lastGit);
  if (environment) p2Sections.push(environment);
  const errors = renderErrors(errorEvents);
  if (errors) p2Sections.push(errors);
  const completedSubagents = subagentEvents.filter(e => e.type === "subagent_completed");
  const subagentsP2 = renderSubagents(completedSubagents);
  if (subagentsP2) p2Sections.push(subagentsP2);
  if (planEvents.length > 0) {
    const lastPlan = planEvents[planEvents.length - 1];
    if (lastPlan.type === "plan_enter") {
      p2Sections.push(`  <plan_mode status="active" />`);
    }
  }

  // P3-P4 sections (15% budget): intent, mcp_tools, launched subagents
  const p3Sections: string[] = [];
  if (intentEvents.length > 0) {
    const lastIntent = intentEvents[intentEvents.length - 1];
    p3Sections.push(renderIntent(lastIntent));
  }
  const mcpTools = renderMcpTools(mcpEvents);
  if (mcpTools) p3Sections.push(mcpTools);
  const launchedSubagents = subagentEvents.filter(e => e.type === "subagent_launched");
  const subagentsP3 = renderSubagents(launchedSubagents);
  if (subagentsP3) p3Sections.push(subagentsP3);

  // Assemble with budget trimming
  const header = `<session_resume compact_count="${compactCount}" events_captured="${events.length}" generated_at="${now}">`;
  const footer = `</session_resume>`;

  const tiers = [p1Sections, p2Sections, p3Sections];

  for (let dropFrom = tiers.length; dropFrom >= 0; dropFrom--) {
    const activeTiers = tiers.slice(0, dropFrom);
    const body = activeTiers.flat().join("\n");

    let xml: string;
    if (body) {
      xml = `${header}\n${body}\n${footer}`;
    } else {
      xml = `${header}\n${footer}`;
    }

    if (Buffer.byteLength(xml) <= maxBytes) {
      return xml;
    }
  }

  return `${header}\n${footer}`;
}
