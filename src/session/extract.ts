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

    // Rule detection — covers every supported platform's instruction
    // file convention plus per-user memory directories. Hardcoding here
    // (instead of dispatching through the adapter) keeps extract.ts
    // pure / sync / hot-path-safe — the tradeoff is that adding a new
    // platform requires updating this regex.
    //
    //   Filenames: CLAUDE.md, AGENTS.md, AGENTS.override.md, GEMINI.md,
    //              QWEN.md, KIRO.md, copilot-instructions.md,
    //              context-mode.mdc
    //   Directories: .claude/, .codex/memories/, .qwen/memory/,
    //                .gemini/memory/, .config/<plat>/memory/, .cursor/memory/,
    //                .github/memory/, .kiro/memory/, etc.
    const isRuleFile =
      /(?:CLAUDE|AGENTS(?:\.override)?|GEMINI|QWEN|KIRO)\.md$/i.test(filePath)
      || /\/copilot-instructions\.md$/i.test(filePath)
      || /\/context-mode\.mdc$/i.test(filePath)
      || /\.claude[\\/]/i.test(filePath)
      || /[\\/]memor(?:y|ies)[\\/][^\\/]+\.md$/i.test(filePath);
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
    priority: 2,
  }];
}

/**
 * Category 16: constraint
 * Constraints discovered through error events — tool failures reveal
 * platform/environment limitations worth remembering.
 */
function extractConstraint(input: HookInput): SessionEvent[] {
  // Only fire on error events — constraints are discovered through failures
  if (!input.tool_response?.includes("Error") && !input.tool_output?.isError) return [];

  const response = String(input.tool_response || "");
  const patterns = [/not supported/i, /cannot/i, /does not support/i, /FAIL/i, /refused/i, /permission denied/i, /incompatible/i];

  for (const pattern of patterns) {
    const match = response.match(pattern);
    if (match) {
      // Extract context around the match
      const idx = response.toLowerCase().indexOf(match[0].toLowerCase());
      const context = response.slice(Math.max(0, idx - 50), Math.min(response.length, idx + 200)).trim();
      return [{
        type: "constraint_discovered",
        category: "constraint",
        data: safeString(context),
        priority: 2,
      }];
    }
  }
  return [];
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
 * Category 22: agent-finding
 * When the Agent tool completes (subagent returns), capture a structured
 * summary of its findings (first 500 chars of tool_response).
 */
function extractAgentFinding(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Agent") return [];
  if (!input.tool_response || input.tool_response.length === 0) return [];

  const summary = input.tool_response.length > 500
    ? input.tool_response.slice(0, 500)
    : input.tool_response;

  return [{
    type: "agent_finding",
    category: "agent-finding",
    data: safeString(summary),
    priority: 2,
  }];
}

/**
 * Category 24: external-ref
 * Scan tool_input and tool_response for external URLs, GitHub issues, and PRs.
 * Deduplicates found refs and skips internal URLs (localhost, 127.0.0.1).
 */
function extractExternalRef(input: HookInput): SessionEvent[] {
  const haystack = [
    safeStringAny(input.tool_input),
    safeString(input.tool_response),
  ].join(" ");

  if (haystack.length === 0) return [];

  const refs = new Set<string>();

  // URLs — skip localhost / 127.0.0.1
  const urlMatches = haystack.match(/https?:\/\/[^\s)]+/g);
  if (urlMatches) {
    for (let url of urlMatches) {
      // Strip trailing punctuation that gets captured from JSON/prose
      url = url.replace(/["'})\],;.]+$/, "");
      if (!/localhost|127\.0\.0\.1/i.test(url)) {
        refs.add(url);
      }
    }
  }

  // Full GitHub issue/PR URLs are already captured above.
  // Shorthand GitHub issue refs: #123 (only bare, not inside a URL)
  const issueMatches = haystack.match(/(?<!\w)#(\d+)/g);
  if (issueMatches) {
    for (const m of issueMatches) {
      refs.add(m);
    }
  }

  if (refs.size === 0) return [];

  return [{
    type: "external_ref",
    category: "external-ref",
    data: safeString(Array.from(refs).join(", ")),
    priority: 3,
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
 * Category 25: blocked-on
 * Detect when work is blocked on something, or when a blocker is resolved.
 */

const BLOCKER_PATTERNS: RegExp[] = [
  /\bblocked on\b/i,
  /\bwaiting for\b/i,
  /\bneed\s+\S+\s+before\b/i,
  /\bcan'?t proceed until\b/i,
  /\bdepends on\b/i,
  /\bblocked\b/i,
  // Turkish patterns
  /\bbekliyor\b/i,
  /\bbekliyorum\b/i,
];

const BLOCKER_RESOLVED_PATTERNS: RegExp[] = [
  /\bunblocked\b/i,
  /\bresolved\b/i,
  /\bgot the\s+\S+/i,
  /\bis ready now\b/i,
  /\bcan proceed\b/i,
];

function extractBlocker(message: string): SessionEvent[] {
  const events: SessionEvent[] = [];

  // Check resolution first — if both match, resolution takes priority
  const isResolved = BLOCKER_RESOLVED_PATTERNS.some(p => p.test(message));
  if (isResolved) {
    events.push({
      type: "blocker_resolved",
      category: "blocked-on",
      data: safeString(message),
      priority: 2,
    });
    return events;
  }

  const isBlocked = BLOCKER_PATTERNS.some(p => p.test(message));
  if (isBlocked) {
    events.push({
      type: "blocker",
      category: "blocked-on",
      data: safeString(message),
      priority: 2,
    });
  }

  return events;
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

// ── Cross-event stateful extractors ───────────────────────────────────────

/**
 * Category 23: error-resolution
 * Detects when an error is followed by a successful fix (cross-event state).
 */

let lastError: { tool: string; error: string; callsSince: number } | null = null;

function extractErrorResolution(input: HookInput): SessionEvent[] {
  const { tool_name, tool_response, tool_output } = input;
  const response = String(tool_response ?? "");
  const isErrorFlag = tool_output?.isError === true;
  const isBashError =
    tool_name === "Bash" &&
    /exit code [1-9]|error:|Error:|FAIL|failed/i.test(response);

  // If this call is an error, store it and return
  if (isBashError || isErrorFlag) {
    lastError = { tool: tool_name, error: response.slice(0, 200), callsSince: 0 };
    return [];
  }

  // No pending error → nothing to resolve
  if (!lastError) return [];

  // Increment staleness counter
  lastError.callsSince++;

  // Timeout: clear after 10 calls without resolution
  if (lastError.callsSince > 10) {
    lastError = null;
    return [];
  }

  // Check if this is a resolution: same tool, or Edit/Write after a Read error
  const sameTool = tool_name === lastError.tool;
  const editAfterReadError =
    lastError.tool === "Read" && (tool_name === "Edit" || tool_name === "Write");

  if (sameTool || editAfterReadError) {
    const event: SessionEvent = {
      type: "error_resolved",
      category: "error-resolution",
      data: safeString(`Error in ${lastError.tool}: ${lastError.error} → Fixed`),
      priority: 2,
    };
    lastError = null;
    return [event];
  }

  return [];
}

/** Reset error-resolution state (for testing). */
export function resetErrorResolutionState(): void {
  lastError = null;
}

/**
 * Category 26: iteration-loop
 * Detects when the same tool is called repeatedly with similar input (stuck loop).
 */

const callHistory: Array<{ tool: string; inputHash: string }> = [];

function simpleHash(str: string): string {
  return `${str.length}:${str.slice(0, 20)}`;
}

function extractIterationLoop(input: HookInput): SessionEvent[] {
  const { tool_name, tool_input } = input;
  const inputHash = simpleHash(JSON.stringify(tool_input).slice(0, 200));

  callHistory.push({ tool: tool_name, inputHash });

  // Keep history bounded
  if (callHistory.length > 50) {
    callHistory.splice(0, callHistory.length - 50);
  }

  // Check last N entries for repeated pattern (minimum 3)
  if (callHistory.length < 3) return [];

  let count = 0;
  for (let i = callHistory.length - 1; i >= 0; i--) {
    if (callHistory[i].tool === tool_name && callHistory[i].inputHash === inputHash) {
      count++;
    } else {
      break;
    }
  }

  if (count >= 3) {
    // Reset the matching tail to avoid duplicate emissions
    callHistory.splice(callHistory.length - count);
    return [{
      type: "retry_detected",
      category: "iteration-loop",
      data: safeString(`${tool_name} called ${count} times with similar input`),
      priority: 2,
    }];
  }

  return [];
}

/** Reset iteration-loop state (for testing). */
export function resetIterationLoopState(): void {
  callHistory.length = 0;
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
    events.push(...extractConstraint(input));
    events.push(...extractWorktree(input));
    events.push(...extractAgentFinding(input));
    events.push(...extractExternalRef(input));

    // Cross-event stateful extractors
    events.push(...extractErrorResolution(input));
    events.push(...extractIterationLoop(input));

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
    events.push(...extractBlocker(message));
    events.push(...extractData(message));

    return events;
  } catch {
    return [];
  }
}
