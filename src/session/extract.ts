/**
 * Session event extraction — pure functions, zero side effects.
 * Extracts structured events from Claude Code tool calls and user messages.
 *
 * All 13 event categories as specified in PRD Section 3.
 */

// ── Public interfaces ──────────────────────────────────────────────────────

export interface SessionEvent {
  /** e.g. "file_read", "file_write", "cwd", "error_tool", "git", "task",
   *  "decision", "rule", "env", "role", "skill", "subagent", "data", "intent" */
  type: string;
  /** e.g. "file", "cwd", "error", "git", "task", "decision",
   *  "rule", "env", "role", "skill", "subagent", "data", "intent" */
  category: string;
  /** Extracted payload — full data, no truncation */
  data: string;
  /** 1=critical (rules, files, tasks) … 5=low */
  priority: number;
}

export interface ToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse?: string;
  isError?: boolean;
}

/**
 * Hook input shape as received from Claude Code PostToolUse hook stdin.
 * Uses snake_case to match the raw hook JSON.
 */
export interface HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: string;
  /** Optional structured output from the tool (may carry isError) */
  tool_output?: { isError?: boolean };
}

// ── Internal helpers ───────────────────────────────────────────────────────

/** Null-safe string coercion — no truncation, preserves full data. */
function safeString(value: string | null | undefined): string {
  if (value == null) return "";
  return String(value);
}

/** Serialise an unknown value to a string — no truncation. */
function safeStringAny(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

// ── Category extractors ────────────────────────────────────────────────────

/**
 * Category 1 & 2: rule + file
 *
 * CLAUDE.md / .claude/ reads → emit both a "rule" event (priority 1) AND a
 * "file_read" event (priority 1) because the file is being actively accessed.
 *
 * Other Edit/Write/Read tool calls → emit a file_edit / file_write / file_read
 * event (priority 1).
 */
function extractFileAndRule(input: HookInput): SessionEvent[] {
  const { tool_name, tool_input, tool_response } = input;
  const events: SessionEvent[] = [];

  if (tool_name === "Read") {
    const filePath = String(tool_input["file_path"] ?? "");

    // Rule detection: CLAUDE.md or anything inside a .claude/ directory
    const isRuleFile = /CLAUDE\.md$|\.claude[\\/]/i.test(filePath);
    if (isRuleFile) {
      events.push({
        type: "rule",
        category: "rule",
        data: safeString(filePath),
        priority: 1,
      });

      // Capture rule content so it survives context compaction
      if (tool_response && tool_response.length > 0) {
        events.push({
          type: "rule_content",
          category: "rule",
          data: safeString(tool_response),
          priority: 1,
        });
      }
    }

    // Always emit file_read for any Read call
    events.push({
      type: "file_read",
      category: "file",
      data: safeString(filePath),
      priority: 1,
    });

    return events;
  }

  if (tool_name === "Edit") {
    const filePath = String(tool_input["file_path"] ?? "");
    events.push({
      type: "file_edit",
      category: "file",
      data: safeString(filePath),
      priority: 1,
    });
    return events;
  }

  if (tool_name === "NotebookEdit") {
    const notebookPath = String(tool_input["notebook_path"] ?? "");
    events.push({
      type: "file_edit",
      category: "file",
      data: safeString(notebookPath),
      priority: 1,
    });
    return events;
  }

  if (tool_name === "Write") {
    const filePath = String(tool_input["file_path"] ?? "");
    events.push({
      type: "file_write",
      category: "file",
      data: safeString(filePath),
      priority: 1,
    });
    return events;
  }

  // Glob — file pattern exploration
  if (tool_name === "Glob") {
    const pattern = String(tool_input["pattern"] ?? "");
    events.push({
      type: "file_glob",
      category: "file",
      data: safeString(pattern),
      priority: 3,
    });
    return events;
  }

  // Grep — code search
  if (tool_name === "Grep") {
    const searchPattern = String(tool_input["pattern"] ?? "");
    const searchPath = String(tool_input["path"] ?? "");
    events.push({
      type: "file_search",
      category: "file",
      data: safeString(`${searchPattern} in ${searchPath}`),
      priority: 3,
    });
    return events;
  }

  return events;
}

/**
 * Category 4: cwd
 * Matches the first `cd <path>` in a Bash command (handles quoted paths).
 */
function extractCwd(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Bash") return [];

  const cmd = String(input.tool_input["command"] ?? "");
  // Match: cd "path" | cd 'path' | cd path
  const cdMatch = cmd.match(/\bcd\s+("([^"]+)"|'([^']+)'|(\S+))/);
  if (!cdMatch) return [];

  const dir = cdMatch[2] ?? cdMatch[3] ?? cdMatch[4] ?? "";
  return [{
    type: "cwd",
    category: "cwd",
    data: safeString(dir),
    priority: 2,
  }];
}

/**
 * Category 5: error
 * Detects failures from bash exit codes / error patterns, or an explicit
 * isError flag in tool_output.
 */
function extractError(input: HookInput): SessionEvent[] {
  const { tool_name, tool_input, tool_response, tool_output } = input;

  const response = String(tool_response ?? "");
  const isErrorFlag = tool_output?.isError === true;

  const isBashError =
    tool_name === "Bash" &&
    /exit code [1-9]|error:|Error:|FAIL|failed/i.test(response);

  if (!isBashError && !isErrorFlag) return [];

  return [{
    type: "error_tool",
    category: "error",
    data: safeString(response),
    priority: 2,
  }];
}

/**
 * Category 11: git
 * Matches common git operations from Bash commands.
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
  if (input.tool_name !== "Bash") return [];

  const cmd = String(input.tool_input["command"] ?? "");
  const match = GIT_PATTERNS.find(p => p.pattern.test(cmd));
  if (!match) return [];

  return [{
    type: "git",
    category: "git",
    data: safeString(match.operation),
    priority: 2,
  }];
}

/**
 * Category 3: task
 * TodoWrite / TaskCreate / TaskUpdate tool calls.
 */
function extractTask(input: HookInput): SessionEvent[] {
  const TASK_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);
  if (!TASK_TOOLS.has(input.tool_name)) return [];

  // Store tool name as type so create vs update can be reliably distinguished
  const type = input.tool_name === "TaskUpdate" ? "task_update"
    : input.tool_name === "TaskCreate" ? "task_create"
    : "task"; // TodoWrite fallback

  return [{
    type,
    category: "task",
    data: safeString(JSON.stringify(input.tool_input)),
    priority: 1,
  }];
}

/**
 * Category 15: plan
 * Tracks the full plan mode lifecycle:
 * - EnterPlanMode → plan_enter
 * - Write/Edit to ~/.claude/plans/ → plan_file_write
 * - ExitPlanMode → plan_exit (with allowedPrompts)
 * - ExitPlanMode tool_response → plan_approved / plan_rejected
 *
 * Note: Shift+Tab and /plan command do NOT fire PostToolUse hooks
 * (Claude Code bug #15660). Only programmatic EnterPlanMode is tracked.
 */
function extractPlan(input: HookInput): SessionEvent[] {
  if (input.tool_name === "EnterPlanMode") {
    return [{
      type: "plan_enter",
      category: "plan",
      data: "entered plan mode",
      priority: 2,
    }];
  }

  if (input.tool_name === "ExitPlanMode") {
    const events: SessionEvent[] = [];

    // Plan exit event with allowedPrompts detail
    const prompts = input.tool_input["allowedPrompts"];
    const detail = Array.isArray(prompts) && prompts.length > 0
      ? `exited plan mode (allowed: ${safeStringAny(prompts.map((p: unknown) => {
          if (typeof p === "object" && p !== null && "prompt" in p) return String((p as Record<string, unknown>).prompt);
          return String(p);
        }).join(", "))})`
      : "exited plan mode";
    events.push({
      type: "plan_exit",
      category: "plan",
      data: safeString(detail),
      priority: 2,
    });

    // Detect approval/rejection from tool_response
    const response = String(input.tool_response ?? "").toLowerCase();
    if (response.includes("approved") || response.includes("approve")) {
      events.push({
        type: "plan_approved",
        category: "plan",
        data: "plan approved by user",
        priority: 1,
      });
    } else if (response.includes("rejected") || response.includes("decline") || response.includes("denied")) {
      events.push({
        type: "plan_rejected",
        category: "plan",
        data: safeString(`plan rejected: ${input.tool_response ?? ""}`),
        priority: 2,
      });
    }

    return events;
  }

  // Detect plan file writes (Write/Edit to ~/.claude/plans/)
  if (input.tool_name === "Write" || input.tool_name === "Edit") {
    const filePath = String(input.tool_input["file_path"] ?? "");
    if (/[/\\]\.claude[/\\]plans[/\\]/.test(filePath)) {
      return [{
        type: "plan_file_write",
        category: "plan",
        data: safeString(`plan file: ${filePath.split(/[/\\]/).pop() ?? filePath}`),
        priority: 2,
      }];
    }
  }

  return [];
}

/**
 * Category 8: env
 * Environment setup commands in Bash: venv, export, nvm, pyenv, conda, rbenv.
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
  if (input.tool_name !== "Bash") return [];

  const cmd = String(input.tool_input["command"] ?? "");
  const isEnvCmd = ENV_PATTERNS.some(p => p.test(cmd));
  if (!isEnvCmd) return [];

  // Sanitize export commands to prevent secret leakage
  const sanitized = cmd.replace(/\bexport\s+(\w+)=\S*/g, "export $1=***");

  return [{
    type: "env",
    category: "env",
    data: safeString(sanitized),
    priority: 2,
  }];
}

/**
 * Category 10: skill
 * Skill tool invocations.
 */
function extractSkill(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Skill") return [];

  const skillName = String(input.tool_input["skill"] ?? "");
  return [{
    type: "skill",
    category: "skill",
    data: safeString(skillName),
    priority: 3,
  }];
}

/**
 * Category 9: subagent
 * Agent tool calls — tracks both launch and completion.
 * When tool_response is present, the agent has completed and the result
 * is captured at higher priority (P2) so it survives budget trimming.
 */
function extractSubagent(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Agent") return [];

  const prompt = safeString(String(input.tool_input["prompt"] ?? input.tool_input["description"] ?? ""));
  const response = input.tool_response ? safeString(String(input.tool_response)) : "";
  const isCompleted = response.length > 0;

  return [{
    type: isCompleted ? "subagent_completed" : "subagent_launched",
    category: "subagent",
    data: isCompleted
      ? safeString(`[completed] ${prompt} → ${response}`)
      : safeString(`[launched] ${prompt}`),
    priority: isCompleted ? 2 : 3,
  }];
}

/**
 * Category 14: mcp
 * MCP tool calls (context7, playwright, claude-mem, ctx-stats, etc.).
 */
function extractMcp(input: HookInput): SessionEvent[] {
  const { tool_name, tool_input, tool_response } = input;
  if (!tool_name.startsWith("mcp__")) return [];

  // Extract readable tool name: last segment after __
  const parts = tool_name.split("__");
  const toolShort = parts[parts.length - 1] || tool_name;

  // Extract first string argument for context
  const firstArg = Object.values(tool_input).find((v): v is string => typeof v === "string");
  const argStr = firstArg ? `: ${safeString(String(firstArg))}` : "";

  // Append tool_response so ctx_search can find what the MCP returned — not
  // just the call shape. Without this, bodies from external MCPs (jira tickets,
  // grafana loki lines, sentry issues, context7 docs) are invisible to search.
  // No truncation: matches the rule_content precedent above — SQLite TEXT is
  // unbounded and large responses are the ones a cache most wants to preserve.
  const responseStr = tool_response && tool_response.length > 0
    ? `\nresponse: ${safeString(tool_response)}`
    : "";

  return [{
    type: "mcp",
    category: "mcp",
    data: safeString(`${toolShort}${argStr}${responseStr}`),
    priority: 3,
  }];
}

/**
 * Category 6 (tool-based): decision
 * AskUserQuestion tool — tracks questions posed to user and their answers.
 */
function extractDecision(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "AskUserQuestion") return [];

  const questions = input.tool_input["questions"];
  const questionText = Array.isArray(questions) && questions.length > 0
    ? String((questions[0] as Record<string, unknown>)["question"] ?? "")
    : "";

  const answer = safeString(String(input.tool_response ?? ""));
  const summary = questionText
    ? `Q: ${safeString(questionText)} → A: ${answer}`
    : `answer: ${answer}`;

  return [{
    type: "decision_question",
    category: "decision",
    data: safeString(summary),
    priority: 2,
  }];
}

/**
 * Category 8: env (worktree)
 * EnterWorktree tool — tracks worktree creation.
 */
function extractWorktree(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "EnterWorktree") return [];

  const name = String(input.tool_input["name"] ?? "unnamed");
  return [{
    type: "worktree",
    category: "env",
    data: safeString(`entered worktree: ${name}`),
    priority: 2,
  }];
}

// ── User-message extractors ────────────────────────────────────────────────

/**
 * Category 6: decision
 * User corrections / approach selections.
 */

const DECISION_PATTERNS: RegExp[] = [
  /\b(don'?t|do not|never|always|instead|rather|prefer)\b/i,
  /\b(use|switch to|go with|pick|choose)\s+\w+\s+(instead|over|not)\b/i,
  /\b(no,?\s+(use|do|try|make))\b/i,
  // Turkish patterns
  /\b(hayır|hayir|evet|böyle|boyle|degil|değil|yerine|kullan)\b/i,
];

function extractUserDecision(message: string): SessionEvent[] {
  const isDecision = DECISION_PATTERNS.some(p => p.test(message));
  if (!isDecision) return [];

  return [{
    type: "decision",
    category: "decision",
    data: safeString(message),
    priority: 2,
  }];
}

/**
 * Category 7: role
 * Persona / behavioral directive patterns.
 */

const ROLE_PATTERNS: RegExp[] = [
  /\b(act as|you are|behave like|pretend|role of|persona)\b/i,
  /\b(senior|staff|principal|lead)\s+(engineer|developer|architect)\b/i,
  // Turkish patterns
  /\b(gibi davran|rolünde|olarak çalış)\b/i,
];

function extractRole(message: string): SessionEvent[] {
  const isRole = ROLE_PATTERNS.some(p => p.test(message));
  if (!isRole) return [];

  return [{
    type: "role",
    category: "role",
    data: safeString(message),
    priority: 3,
  }];
}

/**
 * Category 13: intent
 * Session mode classification from user messages.
 */

const INTENT_PATTERNS: Array<{ mode: string; pattern: RegExp }> = [
  { mode: "investigate", pattern: /\b(why|how does|explain|understand|what is|analyze|debug|look into)\b/i },
  { mode: "implement",   pattern: /\b(create|add|build|implement|write|make|develop|fix)\b/i },
  { mode: "discuss",     pattern: /\b(think about|consider|should we|what if|pros and cons|opinion)\b/i },
  { mode: "review",      pattern: /\b(review|check|audit|verify|test|validate)\b/i },
];

function extractIntent(message: string): SessionEvent[] {
  const match = INTENT_PATTERNS.find(({ pattern }) => pattern.test(message));
  if (!match) return [];

  return [{
    type: "intent",
    category: "intent",
    data: safeString(match.mode),
    priority: 4,
  }];
}

/**
 * Category 12: data
 * Large user-pasted data references (message > 1KB).
 */
function extractData(message: string): SessionEvent[] {
  if (message.length <= 1024) return [];

  return [{
    type: "data",
    category: "data",
    data: safeString(message),
    priority: 4,
  }];
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Extract session events from a PostToolUse hook input.
 *
 * Accepts the raw hook JSON shape (snake_case keys) as received from stdin.
 * Returns an array of zero or more SessionEvents. Never throws.
 */
export function extractEvents(input: HookInput): SessionEvent[] {
  try {
    const events: SessionEvent[] = [];

    // File + Rule (handles Read/Edit/Write)
    events.push(...extractFileAndRule(input));

    // Bash-based extractors (may overlap on the same command)
    events.push(...extractCwd(input));
    events.push(...extractError(input));
    events.push(...extractGit(input));
    events.push(...extractEnv(input));

    // Tool-specific extractors
    events.push(...extractTask(input));
    events.push(...extractPlan(input));
    events.push(...extractSkill(input));
    events.push(...extractSubagent(input));
    events.push(...extractMcp(input));
    events.push(...extractDecision(input));
    events.push(...extractWorktree(input));

    return events;
  } catch {
    // Graceful degradation: if extraction fails, session continues normally
    return [];
  }
}

/**
 * Extract session events from a UserPromptSubmit hook input (user message text).
 *
 * Handles: decision, role, intent, data categories.
 * Returns an array of zero or more SessionEvents. Never throws.
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
