/**
 * Pure routing logic for PreToolUse hooks.
 * Returns NORMALIZED decision objects (NOT platform-specific format).
 *
 * Decision types:
 * - { action: "deny", reason: string }
 * - { action: "ask" }
 * - { action: "modify", updatedInput: object }
 * - { action: "context", additionalContext: string }
 * - null (passthrough)
 */

import {
  ROUTING_BLOCK, READ_GUIDANCE, GREP_GUIDANCE, BASH_GUIDANCE,
  createRoutingBlock, createReadGuidance, createGrepGuidance, createBashGuidance,
} from "../routing-block.mjs";
import { createToolNamer } from "./tool-naming.mjs";
import { isMCPReady } from "./mcp-ready.mjs";
import { existsSync, mkdirSync, rmSync, rmdirSync, readdirSync, unlinkSync, openSync, closeSync, constants as fsConstants } from "node:fs";

/**
 * Guard for actions that redirect to MCP tools (#230).
 * If MCP server isn't ready, returns null (passthrough) instead of the
 * redirect action — prevents agent from getting stuck when MCP tools
 * are unavailable. Applies to deny and modify actions that mention MCP alternatives.
 */
function mcpRedirect(result) {
  if (!isMCPReady()) return null;
  return result;
}
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Guidance throttle: show each advisory type at most once per session.
// Hybrid approach:
//   - In-memory Set for same-process (OpenCode ts-plugin, vitest)
//   - File-based markers with O_EXCL for cross-process atomicity
//     (Claude Code, Gemini, Cursor, VS Code Copilot)
//
// Session identity is resolved in this order:
//   1. sessionId passed in by the caller (stable across hook invocations)
//   2. process.ppid fallback (works on macOS/Linux — host PID is stable)
//
// The ppid fallback is unreliable on Windows + Git Bash, where each hook
// invocation spawns a fresh bash.exe with a different PID (#298). Callers
// that have a stable session identifier (e.g. from the hook payload) should
// pass it to routePreToolUse so the marker directory stays consistent across
// invocations of the same logical session.
const _guidanceShown = new Set();

function defaultGuidanceId() {
  return process.env.VITEST_WORKER_ID
    ? `${process.ppid}-w${process.env.VITEST_WORKER_ID}`
    : String(process.ppid);
}

function guidanceDirFor(sessionId) {
  const id = sessionId ? `s-${sessionId}` : defaultGuidanceId();
  return resolve(tmpdir(), `context-mode-guidance-${id}`);
}

function guidanceOnce(type, content, sessionId) {
  // Fast path: in-memory (same process)
  if (_guidanceShown.has(type)) return null;

  // Resolve marker directory for this session (stable even on Windows/Git Bash
  // where process.ppid shifts every invocation — see #298).
  const dir = guidanceDirFor(sessionId);
  try { mkdirSync(dir, { recursive: true }); } catch {}

  // Atomic create-or-fail: O_CREAT | O_EXCL | O_WRONLY
  // First process to create the file wins; others get EEXIST.
  const marker = resolve(dir, type);
  try {
    const fd = openSync(marker, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    closeSync(fd);
  } catch {
    // EEXIST = another process already created it, or we did in-memory
    _guidanceShown.add(type);
    return null;
  }

  _guidanceShown.add(type);
  return { action: "context", additionalContext: content };
}

/**
 * Robust recursive delete. On Windows, `fs.rmSync` on directories under a
 * tmpdir whose path contains non-ASCII characters (e.g. a Chinese / Japanese /
 * Korean username) silently no-ops without throwing — see #454. Fall back to a
 * manual unlink + rmdir walk so the marker dir actually goes away.
 */
function rmSyncRobust(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  if (!existsSync(dir)) return;
  // Manual fallback for Windows + non-ASCII tmpdir paths
  try {
    for (const name of readdirSync(dir)) {
      try { unlinkSync(resolve(dir, name)); } catch {}
    }
    rmdirSync(dir);
  } catch {}
}

export function resetGuidanceThrottle(sessionId) {
  _guidanceShown.clear();
  // Clear ppid-based dir (legacy / fallback callers) and the sessionId dir if given
  rmSyncRobust(guidanceDirFor());
  if (sessionId) {
    rmSyncRobust(guidanceDirFor(sessionId));
  }
}

/**
 * Strip heredoc content from a shell command.
 * Handles: <<EOF, <<"EOF", <<'EOF', <<-EOF (indented), with optional spaces.
 */
function stripHeredocs(cmd) {
  return cmd.replace(/<<-?\s*["']?(\w+)["']?[\s\S]*?\n\s*\1/g, "");
}

/**
 * Strip ALL quoted content from a shell command so regex only matches command tokens.
 * Removes heredocs, single-quoted strings, and double-quoted strings.
 * This prevents false positives like: gh issue edit --body "text with curl in it"
 */
function stripQuotedContent(cmd) {
  return stripHeredocs(cmd)
    .replace(/'[^']*'/g, "''")                    // single-quoted strings
    .replace(/"[^"]*"/g, '""');                   // double-quoted strings
}

/**
 * Built-in allowlist of structurally-bounded Bash commands (#463).
 *
 * The PreToolUse Bash nudge ("May produce large output. Use ctx_…") is
 * tuned for unbounded commands like `find /` or `cat large-file`. On
 * commands whose stdout is structurally bounded (system probes, version
 * checks, simple git read subcommands), the nudge is pure noise — a
 * recurring ~85 tokens that trains the agent to ignore the warning.
 *
 * isStructurallyBounded() returns true ONLY when the command:
 *   1. Has no shell control operators (pipe, redirect, command
 *      substitution, &&, ||, ;) — any of those can compose with an
 *      unbounded command and re-introduce flooding.
 *   2. Matches one of the conservative patterns below.
 *
 * Unknown commands are treated as unbounded (false) — fail-safe default.
 */
const SAFE_COMMAND_PATTERNS = [
  // System probes (no stdout, or one short line)
  /^pwd$/,
  /^whoami$/,
  /^hostname(?:\s+-[a-zA-Z]+)?$/,
  /^date(?:\s+.+)?$/,
  /^echo\s/,
  /^printf\s/,
  /^which\s+\S+(?:\s+\S+)*$/,
  /^type\s+\S+(?:\s+\S+)*$/,
  /^command\s+-v\s+\S+(?:\s+\S+)*$/,
  /^readlink(?:\s+.+)?$/,
  /^basename(?:\s+.+)?$/,
  /^dirname(?:\s+.+)?$/,
  // Filesystem ops (silent on success, errors on stderr only).
  // For cp / mv / rm we explicitly refuse `-v` / `--verbose`: verbose
  // mode prints one line per file and can flood on big trees
  // (recursive copy of /etc, mass rename, etc.). The "silent on
  // success" invariant only holds without -v.
  /^cd(?:\s+.+)?$/,
  /^mkdir(?:\s+.+)?$/,
  /^touch\s+.+$/,
  /^mv(?!\s+-[a-zA-Z]*v\b)(?!\s+--verbose\b)\s+.+$/,
  /^cp(?!\s+-[a-zA-Z]*v\b)(?!\s+--verbose\b)\s+.+$/,
  /^rm(?!\s+-[a-zA-Z]*v\b)(?!\s+--verbose\b)\s+.+$/,
  // ls — refuse recursive (-R / --recursive) to keep output bounded.
  /^ls(?!\s+-[a-zA-Z]*R)(?!\s+--recursive)(?:\s+.+)?$/,
  // git read-only / status subcommands
  /^git\s+status(?:\s+.+)?$/,
  /^git\s+rev-parse(?:\s+.+)?$/,
  /^git\s+remote(?:\s+-v|\s+show\s+\S+)?$/,
  /^git\s+branch(?:\s+.+)?$/,
  /^git\s+config\s+--get(?:\s+.+)?$/,
  /^git\s+diff\s+--stat(?:\s+.+)?$/,
  /^git\s+diff\s+--name-only(?:\s+.+)?$/,
  /^git\s+stash\s+list$/,
  /^git\s+tag(?:\s+-l(?:\s+.+)?)?$/,
  // git log only when explicitly bounded by -<N> with N up to two digits
  /^git\s+log\s+-\d{1,2}(?:\s+.+)?$/,
  // Version probes (--version anywhere, or `cmd -V`)
  /(?:^|\s)--version(?:\s|$)/,
  /^\S+\s+-V(?:\s|$)/,
];

// Bash shell control operators that can compose a safe command with an
// unbounded sink. Any match disqualifies the command from the allowlist.
//
// Note `&` (single — background + sequence): listed BEFORE `&&` in the
// alternation so the regex engine doesn't accidentally short-match `&&`
// when `&` is itself a separator (`date & cat huge.log`). Without this,
// `^date(?:\s+.+)?$` would match the whole string and bypass the gate.
const SHELL_CONTROL_OPERATORS = /[|`]|\$\(|>>|>|<(?!<)|&(?!&)|&&|\|\||;/;

/**
 * @param {string} command Raw Bash command string from the hook payload.
 * @returns {boolean} true when the command's output is bounded enough that
 *   the routing nudge would be noise. Conservative — unknown commands
 *   return false.
 */
export function isStructurallyBounded(command) {
  if (!command) return false;
  const trimmed = command.trim();
  if (SHELL_CONTROL_OPERATORS.test(trimmed)) return false;
  return SAFE_COMMAND_PATTERNS.some(rx => rx.test(trimmed));
}

// Try to import security module — may not exist
let security = null;
let securityInitFailed = false;

/**
 * @returns {boolean} true if security module loaded successfully.
 *
 * Loud fail: if `build/security.js` is missing or fails to import, log a
 * clear stderr warning instead of swallowing the error silently. Without
 * this, user-configured `permissions.deny` patterns (#466) become no-ops
 * with no indication that policy enforcement is disabled — a fail-open
 * security regression.
 */
export async function initSecurity(buildDir) {
  try {
    const { existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const secPath = resolve(buildDir, "security.js");
    if (!existsSync(secPath)) {
      if (!securityInitFailed && !process.env.CONTEXT_MODE_SUPPRESS_SECURITY_WARNING) {
        process.stderr.write(
          `[context-mode] WARNING: ${secPath} not found — security deny patterns will NOT be enforced. ` +
            `Run \`npm run build\` to generate it. Set CONTEXT_MODE_SUPPRESS_SECURITY_WARNING=1 to silence.\n`,
        );
      }
      securityInitFailed = true;
      return false;
    }
    security = await import(pathToFileURL(secPath).href);
    return true;
  } catch (err) {
    if (!securityInitFailed && !process.env.CONTEXT_MODE_SUPPRESS_SECURITY_WARNING) {
      process.stderr.write(
        `[context-mode] WARNING: failed to load security module — deny patterns NOT enforced: ${err?.message ?? err}\n`,
      );
    }
    securityInitFailed = true;
    return false;
  }
}

/** @returns {boolean} true if a previous initSecurity() call failed to load the module. */
export function isSecurityInitFailed() {
  return securityInitFailed;
}

/**
 * Normalize platform-specific tool names to canonical (Claude Code) names.
 *
 * Evidence:
 * - Gemini CLI: https://github.com/google-gemini/gemini-cli (run_shell_command, read_file, grep_search, web_fetch, activate_skill)
 * - OpenCode:   https://github.com/opencode-ai/opencode (bash, view, grep, fetch, agent)
 * - Codex CLI:  https://github.com/openai/codex (shell, read_file, grep_files, container.exec)
 * - VS Code Copilot: run_in_terminal (command field), read_file, run_vs_code_task
 */
const TOOL_ALIASES = {
  // Gemini CLI / Qwen Code (share native tool names — Qwen is Gemini fork:
  // refs/platforms/qwen-code/packages/core/src/tools/tool-names.ts)
  "run_shell_command": "Bash",
  "read_file": "Read",
  "read_many_files": "Read",
  "grep_search": "Grep",
  "search_file_content": "Grep",
  "web_fetch": "WebFetch",
  // Qwen Code additional tool names (no routing branch yet but normalized
  // so future routing logic works without per-platform fallback):
  "write_file": "Write",
  "edit": "Edit",
  "glob": "Glob",
  "todo_write": "TodoWrite",
  "ask_user_question": "AskUserQuestion",
  "list_directory": "LS",
  "save_memory": "Memory",
  "skill": "Skill",
  "exit_plan_mode": "ExitPlanMode",
  // OpenCode
  "bash": "Bash",
  "view": "Read",
  "grep": "Grep",
  "fetch": "WebFetch",
  "agent": "Agent",
  // Codex CLI
  "shell": "Bash",
  "shell_command": "Bash",
  "exec_command": "Bash",
  "container.exec": "Bash",
  "local_shell": "Bash",
  "grep_files": "Grep",
  // OpenClaw native tools
  "exec": "Bash",
  "read": "Read",
  "grep": "Grep",
  "search": "Grep",
  // Cursor
  "mcp_web_fetch": "WebFetch",
  "mcp_fetch_tool": "WebFetch",
  "Shell": "Bash",
  // VS Code Copilot
  "run_in_terminal": "Bash",
  // Kiro CLI (https://kiro.dev/docs/cli/hooks/)
  "fs_read": "Read",
  "fs_write": "Write",
  "execute_bash": "Bash",
};

function toolLeafName(toolName) {
  const raw = String(toolName ?? "");
  const withoutMcpPrefix = raw.startsWith("MCP:") ? raw.slice(4) : raw;
  const parts = withoutMcpPrefix.split(/__|\//).filter(Boolean);
  return parts.at(-1) ?? withoutMcpPrefix;
}

function matchesContextModeTool(toolName, ctxName, legacyName) {
  const raw = String(toolName ?? "");
  const leaf = toolLeafName(raw);
  if (leaf === ctxName) return true;
  if (raw.startsWith("MCP:") && leaf === legacyName) return true;
  return raw.includes("context-mode") && leaf === legacyName;
}

/**
 * Route a PreToolUse event. Returns normalized decision object or null for passthrough.
 *
 * @param {string} toolName - The tool name as reported by the platform
 * @param {object} toolInput - The tool input/parameters
 * @param {string} [projectDir] - Project directory for security policy lookup
 * @param {string} [platform="claude-code"] - Platform ID for tool name formatting
 * @param {string} [sessionId] - Stable session identifier from hook payload. When
 *   provided, the guidance throttle uses it to scope marker files across hook
 *   invocations even when process.ppid shifts (Windows/Git Bash — see #298).
 */
export function routePreToolUse(toolName, toolInput, projectDir, platform, sessionId) {
  // Build platform-specific tool namer (defaults to claude-code for backward compat)
  const t = createToolNamer(platform || "claude-code");

  // Build platform-specific guidance/routing content
  const routingBlock = platform ? createRoutingBlock(t) : ROUTING_BLOCK;
  const readGuidance = platform ? createReadGuidance(t) : READ_GUIDANCE;
  const grepGuidance = platform ? createGrepGuidance(t) : GREP_GUIDANCE;
  const bashGuidance = platform ? createBashGuidance(t) : BASH_GUIDANCE;

  // Normalize platform-specific tool name to canonical
  const canonical = TOOL_ALIASES[toolName] ?? toolName;

  // ─── Bash: Stage 1 security check, then Stage 2 routing ───
  if (canonical === "Bash") {
    const command = toolInput.command ?? "";

    // Stage 1: Security check against user's deny/allow patterns.
    // Only act when an explicit pattern matched. When no pattern matches,
    // evaluateCommand returns { decision: "ask" } with no matchedPattern —
    // in that case fall through so other hooks and the platform's native engine can decide.
    if (security) {
      const policies = security.readBashPolicies(projectDir);
      if (policies.length > 0) {
        const result = security.evaluateCommand(command, policies);
        if (result.decision === "deny") {
          return { action: "deny", reason: `Blocked by security policy: matches deny pattern ${result.matchedPattern}` };
        }
        if (result.decision === "ask" && result.matchedPattern) {
          return { action: "ask" };
        }
        // "allow" or no match → fall through to Stage 2
      }
    }

    // Stage 2: Context-mode routing (existing behavior)

    // curl/wget detection: strip quoted content first to avoid false positives
    // like `gh issue edit --body "text with curl in it"` (Issue #63).
    const stripped = stripQuotedContent(command);

    // curl/wget — allow silent file-output downloads, block stdout floods (#166).
    // Algorithm: split chained commands, evaluate each segment independently.
    if (/(^|\s|&&|\||\;)(curl|wget)\s/i.test(stripped)) {
      // Split on chain operators (&&, ||, ;) to evaluate each segment
      const segments = stripped.split(/\s*(?:&&|\|\||;)\s*/);
      const hasDangerousSegment = segments.some(seg => {
        const s = seg.trim();
        // Only evaluate segments that contain curl or wget
        if (!/(^|\s)(curl|wget)\s/i.test(s)) return false;

        const isCurl = /\bcurl\b/i.test(s);
        const isWget = /\bwget\b/i.test(s);

        // Check for file output flags
        const hasFileOutput = isCurl
          ? /\s(-o|--output)\s/.test(s) || /\s*>\s*/.test(s) || /\s*>>\s*/.test(s)
          : /\s(-O|--output-document)\s/.test(s) || /\s*>\s*/.test(s) || /\s*>>\s*/.test(s);

        if (!hasFileOutput) return true; // no file output → dangerous

        // Stdout aliases: -o -, -o /dev/stdout, -O -
        if (isCurl && /\s(-o|--output)\s+(-|\/dev\/stdout)(\s|$)/.test(s)) return true;
        if (isWget && /\s(-O|--output-document)\s+(-|\/dev\/stdout)(\s|$)/.test(s)) return true;

        // Verbose/trace flags flood stderr → context
        if (/\s(-v|--verbose|--trace|-D\s+-)\b/.test(s)) return true;

        // Must be silent (curl: -s/--silent, wget: -q/--quiet) to prevent progress bar stderr flood
        const isSilent = isCurl
          ? /\s-[a-zA-Z]*s|--silent/.test(s)
          : /\s-[a-zA-Z]*q|--quiet/.test(s);
        if (!isSilent) return true;

        return false; // safe: silent + file output + no verbose + no stdout alias
      });

      if (hasDangerousSegment) {
        return mcpRedirect({
          action: "modify",
          updatedInput: {
            command: `echo "context-mode: curl/wget blocked. Think in Code — use ${t("ctx_execute")}(language, code) to write code that fetches, processes, and prints only the answer. Or use ${t("ctx_fetch_and_index")}(url, source) to fetch and index. Write pure JS with try/catch, no npm deps. Do NOT retry with curl/wget."`,
          },
        });
      }
      // All segments safe → allow through
      return null;
    }

    // Inline HTTP detection: strip only heredocs (not quotes) so that
    // code passed via -e/-c flags is still visible to the regex, while
    // heredoc content (e.g. cat << EOF ... requests.get ... EOF) is removed.
    // These patterns are specific enough that false positives in quoted
    // text are rare, unlike single-word "curl"/"wget" (Issue #63).
    const noHeredoc = stripHeredocs(command);
    if (
      /fetch\s*\(\s*['"](https?:\/\/|http)/i.test(noHeredoc) ||
      /requests\.(get|post|put)\s*\(/i.test(noHeredoc) ||
      /http\.(get|request)\s*\(/i.test(noHeredoc)
    ) {
      return mcpRedirect({
        action: "modify",
        updatedInput: {
          command: `echo "context-mode: Inline HTTP blocked. Think in Code — use ${t("ctx_execute")}(language, code) to write code that fetches, processes, and console.log() only the result. Write robust pure JS with try/catch, no npm deps. Do NOT retry with Bash."`,
        },
      });
    }

    // Build tools (gradle, maven, sbt) → redirect to execute sandbox (Issue #38, #406).
    // These produce extremely verbose output that should stay in sandbox.
    // Word-boundary guard prevents matching `gradle-wrapper-config`, `mvnDocker`, etc.
    if (/(^|\s|&&|\||\;)(\.\/gradlew|gradlew|gradle|\.\/mvnw|mvnw|mvn|\.\/sbt|sbt)(\s|$)/i.test(stripped)) {
      const safeCmd = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return mcpRedirect({
        action: "modify",
        updatedInput: {
          command: `echo "context-mode: Build tool redirected. Think in Code — use ${t("ctx_execute")}(language: \\"shell\\", code: \\"${safeCmd} 2>&1 | tail -30\\") to run and print only errors/summary. Do NOT retry with Bash."`,
        },
      });
    }

    // Skip the routing nudge for commands whose output is structurally
    // bounded (#463) — pwd, whoami, git status, --version probes, etc.
    // Conservative: any pipe/redirect/chain disqualifies, unknown commands
    // still get the nudge.
    if (isStructurallyBounded(command)) {
      return null;
    }

    // allow all other Bash commands, but inject routing nudge (once per session)
    return guidanceOnce("bash", bashGuidance, sessionId);
  }

  // ─── Read: nudge toward execute_file (once per session) ───
  if (canonical === "Read") {
    return guidanceOnce("read", readGuidance, sessionId);
  }

  // ─── Grep: nudge toward execute (once per session) ───
  if (canonical === "Grep") {
    return guidanceOnce("grep", grepGuidance, sessionId);
  }

  // ─── WebFetch: deny + redirect to sandbox ───
  if (canonical === "WebFetch") {
    const url = toolInput.url ?? "";
    return mcpRedirect({
      action: "deny",
      reason: `context-mode: WebFetch blocked. Think in Code — use ${t("ctx_fetch_and_index")}(url: "${url}", source: "...") to fetch and index, then ${t("ctx_search")}(queries: [...]) to query. Or use ${t("ctx_execute")}(language, code) to fetch, process, and console.log() only what you need. Write pure JS, no npm deps. Do NOT use curl, wget, or WebFetch.`,
    });
  }

  // ─── Agent: inject context-mode routing into subagent prompts ───
  // Subagents cannot use ctx commands (stats/doctor/upgrade/purge) — omit that section (#233)
  if (canonical === "Agent") {
    const subagentType = toolInput.subagent_type ?? "";
    // Detect the correct field name for the prompt/request/objective/question/query
    const fieldName = ["prompt", "request", "objective", "question", "query", "task"].find(f => f in toolInput) ?? "prompt";
    const prompt = toolInput[fieldName] ?? "";

    const subagentBlock = createRoutingBlock(t, { includeCommands: false });

    const updatedInput =
      subagentType === "Bash"
        ? { ...toolInput, [fieldName]: prompt + subagentBlock, subagent_type: "general-purpose" }
        : { ...toolInput, [fieldName]: prompt + subagentBlock };

    return { action: "modify", updatedInput };
  }

  // ─── MCP execute: security check for shell commands ───
  // Match bare, generic MCP, and legacy context-mode execute tool names.
  if (matchesContextModeTool(toolName, "ctx_execute", "execute")) {
    if (security && toolInput.language === "shell") {
      const code = toolInput.code ?? "";
      const policies = security.readBashPolicies(projectDir);
      if (policies.length > 0) {
        const result = security.evaluateCommand(code, policies);
        if (result.decision === "deny") {
          return { action: "deny", reason: `Blocked by security policy: shell code matches deny pattern ${result.matchedPattern}` };
        }
        if (result.decision === "ask" && result.matchedPattern) {
          return { action: "ask" };
        }
      }
    }
    return null;
  }

  // ─── MCP execute_file: check file path + code against deny patterns ───
  if (matchesContextModeTool(toolName, "ctx_execute_file", "execute_file")) {
    if (security) {
      // Check file path against Read deny patterns
      const filePath = toolInput.path ?? "";
      const denyGlobs = security.readToolDenyPatterns("Read", projectDir);
      const evalResult = security.evaluateFilePath(filePath, denyGlobs);
      if (evalResult.denied) {
        return { action: "deny", reason: `Blocked by security policy: file path matches Read deny pattern ${evalResult.matchedPattern}` };
      }

      // Check code parameter against Bash deny patterns (same as execute)
      const lang = toolInput.language ?? "";
      const code = toolInput.code ?? "";
      if (lang === "shell") {
        const policies = security.readBashPolicies(projectDir);
        if (policies.length > 0) {
          const result = security.evaluateCommand(code, policies);
          if (result.decision === "deny") {
            return { action: "deny", reason: `Blocked by security policy: shell code matches deny pattern ${result.matchedPattern}` };
          }
          if (result.decision === "ask" && result.matchedPattern) {
            return { action: "ask" };
          }
        }
      }
    }
    return null;
  }

  // ─── MCP batch_execute: check each command individually ───
  if (matchesContextModeTool(toolName, "ctx_batch_execute", "batch_execute")) {
    if (security) {
      const commands = toolInput.commands ?? [];
      const policies = security.readBashPolicies(projectDir);
      if (policies.length > 0) {
        for (const entry of commands) {
          const cmd = entry.command ?? "";
          const result = security.evaluateCommand(cmd, policies);
          if (result.decision === "deny") {
            return { action: "deny", reason: `Blocked by security policy: batch command "${entry.label ?? cmd}" matches deny pattern ${result.matchedPattern}` };
          }
          if (result.decision === "ask" && result.matchedPattern) {
            return { action: "ask" };
          }
        }
      }
    }
    return null;
  }

  // Unknown tool — pass through
  return null;
}
