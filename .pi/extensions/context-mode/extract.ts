/**
 * Session event extraction — pure functions, zero side effects.
 * Extracts structured events from pi tool calls and user messages.
 */

// ── Public interfaces ──────────────────────────────────────────────────────

export interface SessionEvent {
  type: string;
  category: string;
  data: string;
  priority: number;
}

export interface ToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse?: string;
  isError?: boolean;
}

/**
 * Hook input shape as received from tool_result events.
 */
export interface HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: string;
  tool_output?: { isError?: boolean };
}

// ── Internal helpers ───────────────────────────────────────────────────────

function truncate(value: string | null | undefined, max = 300): string {
  if (value == null) return "";
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function truncateAny(value: unknown, max = 300): string {
  if (value == null) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return truncate(str, max);
}

// ── Category extractors ────────────────────────────────────────────────────

/**
 * Category 1 & 2: rule + file
 */
function extractFileAndRule(input: HookInput): SessionEvent[] {
  const { tool_name, tool_input, tool_response } = input;
  const events: SessionEvent[] = [];

  if (tool_name === "Read") {
    const filePath = String(tool_input["path"] ?? tool_input["file_path"] ?? "");

    // Rule detection: CLAUDE.md, SKILL.md, .claude/, .pi/ directories
    const isRuleFile = /CLAUDE\.md$|SKILL\.md$|\.claude[\\/]|\.pi[\\/]/i.test(filePath);
    if (isRuleFile) {
      events.push({
        type: "rule",
        category: "rule",
        data: truncate(filePath),
        priority: 1,
      });

      if (tool_response && tool_response.length > 0) {
        events.push({
          type: "rule_content",
          category: "rule",
          data: truncate(tool_response, 5000),
          priority: 1,
        });
      }
    }

    events.push({
      type: "file_read",
      category: "file",
      data: truncate(filePath),
      priority: 1,
    });

    return events;
  }

  if (tool_name === "Edit") {
    const filePath = String(tool_input["path"] ?? tool_input["file_path"] ?? "");
    events.push({
      type: "file_edit",
      category: "file",
      data: truncate(filePath),
      priority: 1,
    });
    return events;
  }

  if (tool_name === "Write") {
    const filePath = String(tool_input["path"] ?? tool_input["file_path"] ?? "");
    events.push({
      type: "file_write",
      category: "file",
      data: truncate(filePath),
      priority: 1,
    });
    return events;
  }

  // Glob/Find — file pattern exploration
  if (tool_name === "Glob" || tool_name === "find" || tool_name === "ls") {
    const pattern = String(tool_input["pattern"] ?? tool_input["path"] ?? "");
    events.push({
      type: "file_glob",
      category: "file",
      data: truncate(pattern),
      priority: 3,
    });
    return events;
  }

  // Grep — code search
  if (tool_name === "Grep" || tool_name === "grep") {
    const searchPattern = String(tool_input["pattern"] ?? "");
    const searchPath = String(tool_input["path"] ?? "");
    events.push({
      type: "file_search",
      category: "file",
      data: truncate(`${searchPattern} in ${searchPath}`),
      priority: 3,
    });
    return events;
  }

  return events;
}

/**
 * Category 4: cwd
 */
function extractCwd(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Bash" && input.tool_name !== "bash") return [];

  const cmd = String(input.tool_input["command"] ?? "");
  const cdMatch = cmd.match(/\bcd\s+("([^"]+)"|'([^']+)'|(\S+))/);
  if (!cdMatch) return [];

  const dir = cdMatch[2] ?? cdMatch[3] ?? cdMatch[4] ?? "";
  return [{
    type: "cwd",
    category: "cwd",
    data: truncate(dir),
    priority: 2,
  }];
}

/**
 * Category 5: error
 */
function extractError(input: HookInput): SessionEvent[] {
  const { tool_name, tool_response, tool_output } = input;

  const response = String(tool_response ?? "");
  const isErrorFlag = tool_output?.isError === true;

  const isBashError =
    (tool_name === "Bash" || tool_name === "bash") &&
    /exit code [1-9]|error:|Error:|FAIL|failed/i.test(response);

  if (!isBashError && !isErrorFlag) return [];

  return [{
    type: "error_tool",
    category: "error",
    data: truncate(response, 300),
    priority: 2,
  }];
}

/**
 * Category 11: git
 */
const GIT_PATTERNS: Array<{ pattern: RegExp; operation: string }> = [
  { pattern: /\bgit\s+checkout\b/, operation: "branch" },
  { pattern: /\bgit\s+commit\b/, operation: "commit" },
  { pattern: /\bgit\s+merge\s+\S+/, operation: "merge" },
  { pattern: /\bgit\s+rebase\b/, operation: "rebase" },
  { pattern: /\bgit\s+stash\b/, operation: "stash" },
  { pattern: /\bgit\s+push\b/, operation: "push" },
  { pattern: /\bgit\s+pull\b/, operation: "pull" },
  { pattern: /\bgit\s+log\b/, operation: "log" },
  { pattern: /\bgit\s+diff\b/, operation: "diff" },
  { pattern: /\bgit\s+status\b/, operation: "status" },
  { pattern: /\bgit\s+branch\b/, operation: "branch" },
  { pattern: /\bgit\s+reset\b/, operation: "reset" },
  { pattern: /\bgit\s+add\b/, operation: "add" },
  { pattern: /\bgit\s+cherry-pick\b/, operation: "cherry-pick" },
  { pattern: /\bgit\s+tag\b/, operation: "tag" },
  { pattern: /\bgit\s+fetch\b/, operation: "fetch" },
  { pattern: /\bgit\s+clone\b/, operation: "clone" },
  { pattern: /\bgit\s+worktree\b/, operation: "worktree" },
];

function extractGit(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Bash" && input.tool_name !== "bash") return [];

  const cmd = String(input.tool_input["command"] ?? "");
  const match = GIT_PATTERNS.find(p => p.pattern.test(cmd));
  if (!match) return [];

  return [{
    type: "git",
    category: "git",
    data: truncate(match.operation),
    priority: 2,
  }];
}

/**
 * Category 3: task
 */
function extractTask(input: HookInput): SessionEvent[] {
  const TASK_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "subagent"]);
  if (!TASK_TOOLS.has(input.tool_name) && !input.tool_name.includes("subagent")) return [];

  const type = input.tool_name === "TaskUpdate" ? "task_update"
    : input.tool_name === "TaskCreate" ? "task_create"
    : input.tool_name.includes("subagent") ? "subagent_task"
    : "task";

  return [{
    type,
    category: "task",
    data: truncate(JSON.stringify(input.tool_input), 300),
    priority: 1,
  }];
}

/**
 * Category 8: env
 */
const ENV_PATTERNS: RegExp[] = [
  /\bsource\s+\S*activate\b/,
  /\bexport\s+\w+=/,
  /\bnvm\s+use\b/,
  /\bpyenv\s+(shell|local|global)\b/,
  /\bconda\s+activate\b/,
  /\brbenv\s+(shell|local|global)\b/,
  /\bnpm\s+install\b/,
  /\bnpm\s+ci\b/,
  /\bpip\s+install\b/,
  /\bbun\s+install\b/,
  /\byarn\s+(add|install)\b/,
  /\bpnpm\s+(add|install)\b/,
  /\bcargo\s+(install|add)\b/,
  /\bgo\s+(install|get)\b/,
  /\brustup\b/,
  /\basdf\b/,
  /\bvolta\b/,
  /\bdeno\s+install\b/,
];

function extractEnv(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Bash" && input.tool_name !== "bash") return [];

  const cmd = String(input.tool_input["command"] ?? "");
  const isEnvCmd = ENV_PATTERNS.some(p => p.test(cmd));
  if (!isEnvCmd) return [];

  const sanitized = cmd.replace(/\bexport\s+(\w+)=\S*/g, "export $1=***");

  return [{
    type: "env",
    category: "env",
    data: truncate(sanitized),
    priority: 2,
  }];
}

/**
 * Category 9: subagent
 */
function extractSubagent(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "subagent" && !input.tool_name.includes("subagent")) return [];

  const prompt = truncate(String(input.tool_input["task"] ?? input.tool_input["prompt"] ?? input.tool_input["description"] ?? ""), 200);
  const response = input.tool_response ? truncate(String(input.tool_response), 300) : "";
  const isCompleted = response.length > 0;

  return [{
    type: isCompleted ? "subagent_completed" : "subagent_launched",
    category: "subagent",
    data: isCompleted
      ? truncate(`[completed] ${prompt} → ${response}`, 300)
      : truncate(`[launched] ${prompt}`, 300),
    priority: isCompleted ? 2 : 3,
  }];
}

/**
 * Category 14: mcp
 */
function extractMcp(input: HookInput): SessionEvent[] {
  const { tool_name, tool_input } = input;
  if (!tool_name.startsWith("mcp__") && !tool_name.startsWith("mcp")) return [];

  const parts = tool_name.split("__");
  const toolShort = parts[parts.length - 1] || tool_name;

  const firstArg = Object.values(tool_input).find((v): v is string => typeof v === "string");
  const argStr = firstArg ? `: ${truncate(String(firstArg), 100)}` : "";

  return [{
    type: "mcp",
    category: "mcp",
    data: truncate(`${toolShort}${argStr}`),
    priority: 3,
  }];
}

/**
 * Category 6: decision
 */
function extractDecision(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "ralphi_ask_user_question" && !input.tool_name.includes("question")) return [];

  const questions = input.tool_input["questions"];
  const questionText = Array.isArray(questions) && questions.length > 0
    ? String((questions[0] as Record<string, unknown>)["prompt"] ?? (questions[0] as Record<string, unknown>)["question"] ?? "")
    : "";

  const answer = truncate(String(input.tool_response ?? ""), 150);
  const summary = questionText
    ? `Q: ${truncate(questionText, 120)} → A: ${answer}`
    : `answer: ${answer}`;

  return [{
    type: "decision_question",
    category: "decision",
    data: truncate(summary),
    priority: 2,
  }];
}

// ── User-message extractors ────────────────────────────────────────────────

const DECISION_PATTERNS: RegExp[] = [
  /\b(don'?t|do not|never|always|instead|rather|prefer)\b/i,
  /\b(use|switch to|go with|pick|choose)\s+\w+\s+(instead|over|not)\b/i,
  /\b(no,?\s+(use|do|try|make))\b/i,
];

function extractUserDecision(message: string): SessionEvent[] {
  const isDecision = DECISION_PATTERNS.some(p => p.test(message));
  if (!isDecision) return [];

  return [{
    type: "decision",
    category: "decision",
    data: truncate(message, 300),
    priority: 2,
  }];
}

const ROLE_PATTERNS: RegExp[] = [
  /\b(act as|you are|behave like|pretend|role of|persona)\b/i,
  /\b(senior|staff|principal|lead)\s+(engineer|developer|architect)\b/i,
];

function extractRole(message: string): SessionEvent[] {
  const isRole = ROLE_PATTERNS.some(p => p.test(message));
  if (!isRole) return [];

  return [{
    type: "role",
    category: "role",
    data: truncate(message, 300),
    priority: 3,
  }];
}

const INTENT_PATTERNS: Array<{ mode: string; pattern: RegExp }> = [
  { mode: "investigate", pattern: /\b(why|how does|explain|understand|what is|analyze|debug|look into)\b/i },
  { mode: "implement", pattern: /\b(create|add|build|implement|write|make|develop|fix)\b/i },
  { mode: "discuss", pattern: /\b(think about|consider|should we|what if|pros and cons|opinion)\b/i },
  { mode: "review", pattern: /\b(review|check|audit|verify|test|validate)\b/i },
];

function extractIntent(message: string): SessionEvent[] {
  const match = INTENT_PATTERNS.find(({ pattern }) => pattern.test(message));
  if (!match) return [];

  return [{
    type: "intent",
    category: "intent",
    data: truncate(match.mode),
    priority: 4,
  }];
}

function extractData(message: string): SessionEvent[] {
  if (message.length <= 1024) return [];

  return [{
    type: "data",
    category: "data",
    data: truncate(message, 200),
    priority: 4,
  }];
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Extract session events from a tool_result event.
 */
export function extractEvents(input: HookInput): SessionEvent[] {
  try {
    const events: SessionEvent[] = [];

    events.push(...extractFileAndRule(input));
    events.push(...extractCwd(input));
    events.push(...extractError(input));
    events.push(...extractGit(input));
    events.push(...extractEnv(input));
    events.push(...extractTask(input));
    events.push(...extractSubagent(input));
    events.push(...extractMcp(input));
    events.push(...extractDecision(input));

    return events;
  } catch {
    return [];
  }
}

/**
 * Extract session events from a user message.
 */
export function extractUserEvents(message: string): SessionEvent[] {
  try {
    const events: SessionEvent[] = [];

    events.push(...extractUserDecision(message));
    events.push(...extractRole(message));
    events.push(...extractIntent(message));
    events.push(...extractData(message));

    return events;
  } catch {
    return [];
  }
}
