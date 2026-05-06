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
       - After resume, check prior context before asking user.
    1. GATHER: ${t("ctx_batch_execute")}(commands, queries)
       - Primary research tool. Runs commands, auto-indexes, searches. ONE call replaces many steps.
       - Each command: {label: "section header", command: "shell command"}
       - label becomes FTS5 chunk title — descriptive labels improve search.
    2. FOLLOW-UP: ${t("ctx_search")}(queries: ["q1", "q2", ...])
       - All follow-up questions. ONE call, many queries (default relevance mode).
    3. PROCESSING: ${t("ctx_execute")}(language, code) | ${t("ctx_execute_file")}(path, language, code)
       - API calls, log analysis, data processing.
  </tool_selection_hierarchy>

  <forbidden_actions>
    - NO Bash for commands producing >20 lines output.
    - NO Read for analysis — use ${t("ctx_execute_file")}. Read IS correct for files you intend to Edit.
    - NO WebFetch — use ${t("ctx_fetch_and_index")}.
    - Bash ONLY for git/mkdir/rm/mv/navigation.
    - NO ${t("ctx_execute")} or ${t("ctx_execute_file")} for file creation/modification.
      ${t("ctx_execute")} is for analysis, processing, computation only.
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
      Auto-expand for: security warnings, irreversible actions, user confusion.
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
    Skills, roles, and decisions set during this session remain active until the user revokes them.
    Do not drop behavioral directives as context grows.
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
    → Call purge MCP tool with confirm: true. Warn: irreversible.

    After /clear or /compact: knowledge base preserved. Tell user: "context-mode knowledge base preserved. Use \`ctx purge\` to start fresh."
  </ctx_commands>
` : ''}
</context_window_protection>`;
}

export function createReadGuidance(t) {
  return '<context_guidance>\n  <tip>\n    Reading to Edit? Read is correct — Edit needs content in context.\n    Reading to analyze/explore? Use ' + t("ctx_execute_file") + '(path, language, code) — only printed summary enters context.\n  </tip>\n</context_guidance>';
}

export function createGrepGuidance(t) {
  return '<context_guidance>\n  <tip>\n    May flood context. Use ' + t("ctx_execute") + '(language: "shell", code: "...") to run searches in sandbox. Only printed summary enters context.\n  </tip>\n</context_guidance>';
}

export function createBashGuidance(t) {
  return '<context_guidance>\n  <tip>\n    May produce large output. Use ' + t("ctx_batch_execute") + '(commands, queries) for multiple commands, ' + t("ctx_execute") + '(language: "shell", code: "...") for single. Only printed summary enters context. Bash only for: git, mkdir, rm, mv, navigation.\n  </tip>\n</context_guidance>';
}

// ── Backward compat: static exports defaulting to claude-code ──

const _t = createToolNamer("claude-code");
export const ROUTING_BLOCK = createRoutingBlock(_t);
export const READ_GUIDANCE = createReadGuidance(_t);
export const GREP_GUIDANCE = createGrepGuidance(_t);
export const BASH_GUIDANCE = createBashGuidance(_t);
