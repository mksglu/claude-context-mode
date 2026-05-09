/**
 * Shared routing block for context-mode hooks.
 * Single source of truth — imported by pretooluse.mjs and sessionstart.mjs.
 *
 * Factory functions accept a tool namer `t(bareTool) => platformSpecificName`
 * so each platform gets correct tool names in guidance messages.
 *
 * Backward compat: static exports (ROUTING_BLOCK, READ_GUIDANCE, etc.)
 * default to claude-code naming convention.
 */

import { createToolNamer } from "./core/tool-naming.mjs";

// ── Factory functions ─────────────────────────────────────

export function createRoutingBlock(t, options = {}) {
  const { includeCommands = true } = options;
  return `
<context_window_protection>
  <priority_instructions>
    Raw tool output floods context window. MUST use context-mode MCP tools. Keep raw data in sandbox.
  </priority_instructions>

  <tool_selection_hierarchy>
    0. MEMORY: ${t("ctx_search")}(sort: "timeline")
       - Use after /clear, process restart, or when user signals a prior session existed.
         Check prior context before asking the user anything.

    1. GATHER: ${t("ctx_batch_execute")}(commands, queries)
       - Use when the task requires running shell commands, querying APIs, or building an index.
         ONE call replaces many steps. Do NOT use Bash or ${t("ctx_execute")} for this.
       - Each command: { label: "section header", command: "shell command" }
       - label becomes FTS5 chunk title — descriptive labels improve search.

    2. FOLLOW-UP: ${t("ctx_search")}(queries: ["q1", "q2", ...])
       - Use when data is already indexed and the user is asking questions about it.
         ONE call, all queries together. Never one call per question.

    3. PROCESSING: ${t("ctx_execute")}(language, code) | ${t("ctx_execute_file")}(path, language, code)
       - Use for: API calls, log analysis, data aggregation, computation on sandbox data.
         File reads for analysis go here — NOT to the Read tool.
       - NEVER use ${t("ctx_execute")} or ${t("ctx_execute_file")} to write or modify files.
  </tool_selection_hierarchy>

  <forbidden_actions>
    <!-- MAINTENANCE NOTE: some entries below intentionally duplicate rules in
         tool_selection_hierarchy for reinforcement. If a rule changes, update both. -->
    - NO Bash except for: git, mkdir, rm, mv, cd. No other commands. No exceptions.
    - NO Read for analysis or exploration — use ${t("ctx_execute_file")} instead.
    - NO WebFetch — use ${t("ctx_fetch_and_index")} for all URL fetching.
    - NO ${t("ctx_execute")} or ${t("ctx_execute_file")} for file creation or modification.
  </forbidden_actions>

  <file_writing_policy>
    ALWAYS use native Write/Edit tools for file creation/modification.
    NEVER use ${t("ctx_execute")}, ${t("ctx_execute_file")}, or Bash to write files.
    Applies to all file types: code, configs, plans, specs, YAML, JSON, markdown.
  </file_writing_policy>

  <output_constraints>
    <communication_style>
      Terse like caveman. Technical substance exact. Only fluff die.
      Use fragments when clear. Short synonyms (fix not "implement a solution for").
      Technical terms exact. Code blocks unchanged.
      Expand to full prose only for:
        - Security warnings
        - Irreversible actions
        - User signals confusion: repeated questions or explicit "I don't understand".
          "Confusion" is not license to pad — expand only the unclear part.
    </communication_style>
    <artifact_policy>
      Write artifacts (code, configs, PRDs) to FILES. NEVER inline.
      Return only: file path + 1-line description.
    </artifact_policy>
    <response_format>
      Concise summary:
      - Actions taken (2-3 bullets)
      - File paths created/modified
      - Key findings
    </response_format>
  </output_constraints>

  <session_continuity>
    Behavioral directives (roles, style preferences, decisions) set during this session
    remain active until the user explicitly revokes them.
    Do not drop directives as context grows.
  </session_continuity>
${includeCommands ? `
  <ctx_commands>
    "ctx stats" | "ctx-stats" | "/ctx-stats" | context savings question
    → Call stats MCP tool, display full output verbatim.

    "ctx doctor" | "ctx-doctor" | "/ctx-doctor" | diagnose context-mode
    → Call doctor MCP tool, run returned shell command, display as checklist.

    "ctx upgrade" | "ctx-upgrade" | "/ctx-upgrade" | update context-mode
    → Call upgrade MCP tool, run returned shell command, display as checklist.

    "ctx purge" | "ctx-purge" | "/ctx-purge" | wipe/reset knowledge base
    → Warn user this is irreversible, then call purge MCP tool with confirm: true.

    After /clear or /compact: knowledge base preserved. Tell user: "context-mode knowledge base preserved. Use \`ctx purge\` to start fresh."
  </ctx_commands>
` : ''}
</context_window_protection>`;
}

// ── Per-tool guidance blocks ──────────────────────────────
//
// Injected at point of tool use to catch wrong-tool choices before they happen.

export function createReadGuidance(t) {
  return `<context_guidance>
  <tip>
    Reading to Edit? Read is correct — Edit needs content in context.
    Reading to analyze/explore? Use ${t("ctx_execute_file")}(path, language, code) instead —
    only the printed summary enters context, not the raw file.
  </tip>
</context_guidance>`;
}

export function createGrepGuidance(t) {
  return `<context_guidance>
  <tip>
    Grep output can flood context. Run searches in the sandbox instead:
    ${t("ctx_execute")}(language: "shell", code: "your grep command")
    Only the printed summary enters context.
  </tip>
</context_guidance>`;
}

export function createBashGuidance(t) {
  return `<context_guidance>
  <tip>
    Bash is permitted only for: git, mkdir, rm, mv, cd.
    For everything else:
      - Multiple commands or data gathering → ${t("ctx_batch_execute")}(commands, queries)
      - Single analysis command            → ${t("ctx_execute")}(language: "shell", code: "...")
    Only the printed summary enters context.
  </tip>
</context_guidance>`;
}

// ── Backward compat: static exports defaulting to claude-code ──

const _t = createToolNamer("claude-code");
export const ROUTING_BLOCK = createRoutingBlock(_t);
export const READ_GUIDANCE = createReadGuidance(_t);
export const GREP_GUIDANCE = createGrepGuidance(_t);
export const BASH_GUIDANCE = createBashGuidance(_t);
