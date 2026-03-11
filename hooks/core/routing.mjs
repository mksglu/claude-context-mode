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

import { ROUTING_BLOCK, READ_GUIDANCE, GREP_GUIDANCE, BASH_GUIDANCE } from "../routing-block.mjs";

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

// Try to import security module — may not exist
let security = null;

export async function initSecurity(buildDir) {
  try {
    const { pathToFileURL } = await import("node:url");
    const secPath = (await import("node:path")).resolve(buildDir, "security.js");
    security = await import(pathToFileURL(secPath).href);
  } catch { /* not available */ }
}

/**
 * Normalize platform-specific tool names to canonical (Claude Code) names.
 *
 * Evidence:
 * - Gemini CLI: https://github.com/google-gemini/gemini-cli (run_shell_command, read_file, grep_search, web_fetch, activate_skill)
 * - OpenCode:   https://github.com/opencode-ai/opencode (bash, view, grep, fetch, agent)
 * - Codex CLI:  https://github.com/openai/codex (shell, read_file, grep_files, container.exec)
 * - VS Code Copilot: tool names TBD — uses empty matcher until confirmed
 */
const TOOL_ALIASES = {
  // Gemini CLI
  "run_shell_command": "Bash",
  "read_file": "Read",
  "read_many_files": "Read",
  "grep_search": "Grep",
  "search_file_content": "Grep",
  "web_fetch": "WebFetch",
  "activate_skill": "Agent",
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
};

/**
 * Route a PreToolUse event. Returns normalized decision object or null for passthrough.
 */
export function routePreToolUse(toolName, toolInput, projectDir) {
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

    // curl/wget → replace with echo redirect
    if (/(^|\s|&&|\||\;)(curl|wget)\s/i.test(stripped)) {
      return {
        action: "modify",
        updatedInput: {
          command: 'echo "context-mode: curl/wget blocked. You MUST use mcp__plugin_context-mode_context-mode__ctx_fetch_and_index(url, source) to fetch URLs, or mcp__plugin_context-mode_context-mode__ctx_execute(language, code) to run HTTP calls in sandbox. Do NOT retry with curl/wget."',
        },
      };
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
      return {
        action: "modify",
        updatedInput: {
          command: 'echo "context-mode: Inline HTTP blocked. Use mcp__plugin_context-mode_context-mode__ctx_execute(language, code) to run HTTP calls in sandbox, or mcp__plugin_context-mode_context-mode__ctx_fetch_and_index(url, source) for web pages. Do NOT retry with Bash."',
        },
      };
    }

    // Build tools (gradle, maven) → redirect to execute sandbox (Issue #38).
    // These produce extremely verbose output that should stay in sandbox.
    if (/(^|\s|&&|\||\;)(\.\/gradlew|gradlew|gradle|\.\/mvnw|mvnw|mvn)\s/i.test(stripped)) {
      const safeCmd = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return {
        action: "modify",
        updatedInput: {
          command: `echo "context-mode: Build tool redirected to sandbox. Use mcp__plugin_context-mode_context-mode__ctx_execute(language: \\"shell\\", code: \\"${safeCmd}\\") to run this command. Do NOT retry with Bash."`,
        },
      };
    }

    // Verbose command patterns → redirect to ctx_execute sandbox.
    // These commands typically produce >20 lines of output that floods context.
    const VERBOSE_CMD_PATTERNS = [
      // Test runners
      /(^|\s|&&|\||\;)(npm\s+test|npm\s+run\s+test|npx\s+(jest|vitest|mocha|playwright|cypress))/i,
      /(^|\s|&&|\||\;)(pytest|python\s+-m\s+(pytest|unittest)|cargo\s+test|go\s+test)/i,
      /(^|\s|&&|\||\;)(jest|vitest|mocha|ava)\b/i,
      // Build commands
      /(^|\s|&&|\||\;)(npm\s+run\s+build|npm\s+run\s+dev|npx\s+tsc|npx\s+next)/i,
      /(^|\s|&&|\||\;)(cargo\s+build|go\s+build|make\b(?!\s+-q))/i,
      // Package managers (install/audit)
      /(^|\s|&&|\||\;)(npm\s+(install|ci|audit|ls|outdated)|yarn\s+(install|add)|pnpm\s+(install|add))/i,
      /(^|\s|&&|\||\;)(pip\s+install|pip\s+list|pip\s+freeze|poetry\s+install)/i,
      // Docker/k8s
      /(^|\s|&&|\||\;)(docker\s+(build|logs|ps|images)|kubectl\s+(logs|describe|get))/i,
      // Analysis commands that dump large output
      /(^|\s|&&|\||\;)(find\s+\S+|tree\s|du\s|df\s|ps\s+aux|top\s|wc\s+-l\s+\S+\s+\S+)/i,
      // Linters/formatters with full output
      /(^|\s|&&|\||\;)(eslint|prettier\s+--check|pylint|flake8|rubocop|clippy)\b/i,
      // cat/head/tail piped or on multiple files (likely large output)
      /(^|\s|&&|\||\;)(cat|head|tail)\s+\S+\s*\|/i,
      /(^|\s|&&|\||\;)(cat|head|tail)\s+\S+\s+\S+/i,
    ];

    if (VERBOSE_CMD_PATTERNS.some(p => p.test(stripped))) {
      const safeCmd = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return {
        action: "modify",
        updatedInput: {
          command: `echo "context-mode: This command typically produces verbose output. Use mcp__plugin_context-mode_context-mode__ctx_execute(language: \\"shell\\", code: \\"${safeCmd}\\") to run in sandbox. Do NOT retry with Bash."`,
        },
      };
    }

    // allow all other Bash commands, but inject routing nudge
    return { action: "context", additionalContext: BASH_GUIDANCE };
  }

  // ─── Read: nudge toward execute_file ───
  if (canonical === "Read") {
    return { action: "context", additionalContext: READ_GUIDANCE };
  }

  // ─── Grep: nudge toward execute ───
  if (canonical === "Grep") {
    return { action: "context", additionalContext: GREP_GUIDANCE };
  }

  // ─── WebFetch: deny + redirect to sandbox ───
  if (canonical === "WebFetch") {
    const url = toolInput.url ?? "";
    return {
      action: "deny",
      reason: `context-mode: WebFetch blocked. Use mcp__plugin_context-mode_context-mode__ctx_fetch_and_index(url: "${url}", source: "...") to fetch this URL in sandbox. Then use mcp__plugin_context-mode_context-mode__ctx_search(queries: [...]) to query results. Do NOT use curl/wget — they are also blocked.`,
    };
  }

  // ─── Agent/Task: inject context-mode routing into subagent prompts ───
  if (canonical === "Agent" || canonical === "Task") {
    const subagentType = toolInput.subagent_type ?? "";
    const prompt = toolInput.prompt ?? "";

    const updatedInput =
      subagentType === "Bash"
        ? { ...toolInput, prompt: prompt + ROUTING_BLOCK, subagent_type: "general-purpose" }
        : { ...toolInput, prompt: prompt + ROUTING_BLOCK };

    return { action: "modify", updatedInput };
  }

  // ─── MCP execute: security check for shell commands ───
  // Match both __execute and __ctx_execute (prefixed tool names)
  if (toolName.includes("context-mode") && /__(ctx_)?execute$/.test(toolName)) {
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
  if (toolName.includes("context-mode") && /__(ctx_)?execute_file$/.test(toolName)) {
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
  if (toolName.includes("context-mode") && /__(ctx_)?batch_execute$/.test(toolName)) {
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
