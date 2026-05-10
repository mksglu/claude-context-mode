/**
 * Codex Continuous Memory Governor.
 *
 * Experimental Codex-first continuity path: curate a bounded working-state
 * capsule from SessionDB events on Stop, then let SessionStart restore that
 * capsule when no PreCompact resume snapshot is available.
 */

const DEFAULT_MAX_BYTES = 5000;

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cleanText(value, max = 280) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function uniqueLatest(items, max) {
  const seen = new Set();
  const out = [];
  for (let i = items.length - 1; i >= 0 && out.length < max; i--) {
    const item = String(items[i] ?? "").trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.unshift(item);
  }
  return out;
}

function latestEvent(events, predicate) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (predicate(events[i])) return events[i];
  }
  return null;
}

function fileLabel(data) {
  const text = String(data ?? "").trim();
  const path = text.includes(" in ") ? text.split(" in ").pop() : text;
  return path?.trim() ?? text;
}

function renderTasks(events) {
  const creates = [];
  const updates = {};
  for (const ev of events) {
    try {
      const parsed = JSON.parse(String(ev.data ?? ""));
      if (typeof parsed.subject === "string") creates.push(parsed.subject);
      else if (typeof parsed.taskId === "string" && typeof parsed.status === "string") {
        updates[parsed.taskId] = parsed.status;
      }
    } catch {
      if (String(ev.data ?? "").trim()) creates.push(String(ev.data));
    }
  }

  const done = new Set(["completed", "deleted", "failed"]);
  const sortedIds = Object.keys(updates).sort((a, b) => Number(a) - Number(b));
  const pending = [];
  for (let i = 0; i < creates.length; i++) {
    const matchedId = sortedIds[i];
    const status = matchedId ? updates[matchedId] ?? "pending" : "pending";
    if (!done.has(status)) pending.push(creates[i]);
  }
  return uniqueLatest(pending, 5);
}

function section(tag, values) {
  if (!values || values.length === 0) return "";
  const body = values.map((value) => `    <item>${escapeXml(cleanText(value))}</item>`).join("\n");
  return `  <${tag}>\n${body}\n  </${tag}>`;
}

function buildRecallSection(searchTool, queries) {
  const uniqueQueries = uniqueLatest(queries.map((q) => cleanText(q, 120)), 4);
  if (uniqueQueries.length === 0) return "";
  const queryItems = uniqueQueries
    .map((query) => `    <query>${escapeXml(query)}</query>`)
    .join("\n");
  return [
    `  <recall_handles tool="${escapeXml(searchTool)}" source="session-events">`,
    queryItems,
    "  </recall_handles>",
  ].join("\n");
}

function capSections(header, sections, footer, maxBytes) {
  const out = [header];
  for (const part of sections) {
    if (!part) continue;
    const candidate = `${out.join("\n\n")}\n\n${part}\n\n${footer}`;
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) continue;
    out.push(part);
  }
  out.push(footer);
  return out.join("\n\n");
}

export function buildContinuousMemoryCapsule(events, opts = {}) {
  const source = opts.source ?? "stop";
  const searchTool = opts.searchTool ?? "ctx_search";
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const usefulEvents = events.filter(
    (ev) => !(ev?.category === "memory-governor" && ev?.type === "working_state_capsule"),
  );

  const goal = latestEvent(
    usefulEvents,
    (ev) => ev.type === "current_goal" || ev.type === "user_prompt" || ev.category === "user-prompt",
  );
  const files = uniqueLatest(
    usefulEvents
      .filter((ev) => ev.category === "file")
      .map((ev) => fileLabel(ev.data)),
    8,
  );
  const tasks = renderTasks(usefulEvents.filter((ev) => ev.category === "task"));
  const decisions = uniqueLatest(
    usefulEvents.filter((ev) => ev.category === "decision").map((ev) => ev.data),
    5,
  );
  const errors = uniqueLatest(
    usefulEvents.filter((ev) => ev.category === "error").map((ev) => ev.data),
    3,
  );
  const cwd = latestEvent(usefulEvents, (ev) => ev.category === "cwd");
  const intent = latestEvent(usefulEvents, (ev) => ev.category === "intent");

  const recallQueries = [
    goal?.data,
    ...files,
    ...tasks,
    ...decisions,
    ...errors,
  ].filter(Boolean);

  const sections = [
    goal ? `  <current_goal>${escapeXml(cleanText(goal.data, 420))}</current_goal>` : "",
    intent ? `  <intent>${escapeXml(cleanText(intent.data, 120))}</intent>` : "",
    section("active_files", files),
    section("pending_tasks", tasks),
    section("decisions", decisions),
    section("errors", errors),
    cwd ? `  <cwd>${escapeXml(cleanText(cwd.data, 260))}</cwd>` : "",
    buildRecallSection(searchTool, recallQueries),
  ];

  if (sections.every((part) => !part)) return "";

  const header = [
    `<continuous_memory source="${escapeXml(source)}">`,
    "  <instruction>Use this as the current working-state capsule. Search recall handles before asking the user to repeat prior work.</instruction>",
  ].join("\n");
  const footer = "</continuous_memory>";
  return capSections(header, sections, footer, maxBytes);
}

export function getLatestContinuousMemoryCapsule(events) {
  const latest = latestEvent(
    events,
    (ev) => ev.category === "memory-governor"
      && ev.type === "working_state_capsule"
      && String(ev.data ?? "").includes("<continuous_memory"),
  );
  return latest ? String(latest.data) : "";
}
