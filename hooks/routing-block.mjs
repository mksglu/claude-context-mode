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

export function createRoutingBlock(t) {
  return `
<context_window_protection>
  <priority_instructions>
    Raw tool output floods your context window. You MUST use context-mode MCP tools to keep raw data in the sandbox.
  </priority_instructions>

  <tool_selection_hierarchy>
    1. GATHER: ${t("ctx_batch_execute")}(commands, queries)
       - Primary tool for research. Runs all commands, auto-indexes, and searches.
       - ONE call replaces many individual steps.
    2. FOLLOW-UP: ${t("ctx_search")}(queries: ["q1", "q2", ...])
       - Use for all follow-up questions. ONE call, many queries.
    3. PROCESSING: ${t("ctx_execute")}(language, code) | ${t("ctx_execute_file")}(path, language, code)
       - Use for API calls, log analysis, and data processing.
  </tool_selection_hierarchy>

  <forbidden_actions>
    - DO NOT use Bash for commands producing >20 lines of output.
    - DO NOT use Read for analysis (use execute_file). Read IS correct for files you intend to Edit.
    - DO NOT use WebFetch (use ${t("ctx_fetch_and_index")} instead).
    - Bash is ONLY for git/mkdir/rm/mv/navigation.
    - DO NOT use ${t("ctx_execute")} or ${t("ctx_execute_file")} to create, modify, or overwrite files.
      ctx_execute is for data analysis, log processing, and computation only.
  </forbidden_actions>

  <file_writing_policy>
    ALWAYS use the native Write tool to create files and Edit tool to modify files.
    NEVER use ${t("ctx_execute")}, ${t("ctx_execute_file")}, or Bash to write file content.
    This applies to all file types: code, configs, plans, specs, YAML, JSON, markdown.
  </file_writing_policy>

  <output_constraints>
    <word_limit>Keep your final response under 500 words.</word_limit>
    <artifact_policy>
      Write artifacts (code, configs, PRDs) to FILES using the native Write tool. NEVER return them as inline text.
      Use Edit tool for modifications to existing files.
      Return only: file path + 1-line description.
    </artifact_policy>
    <response_format>
      Your response must be a concise summary:
      - Actions taken (2-3 bullets)
      - File paths created/modified
      - Knowledge base source labels (so parent can search)
      - Key findings
    </response_format>
  </output_constraints>

  <ctx_commands>
    When the user says "ctx stats", "ctx-stats", "/ctx-stats", or asks about context savings:
    → Call the stats MCP tool and display the full output verbatim.

    When the user says "ctx doctor", "ctx-doctor", "/ctx-doctor", or asks to diagnose context-mode:
    → Call the doctor MCP tool, execute the returned shell command, display results as a checklist.

    When the user says "ctx upgrade", "ctx-upgrade", "/ctx-upgrade", or asks to update context-mode:
    → Call the upgrade MCP tool, execute the returned shell command, display results as a checklist.

    After /clear: call ${t("ctx_stats")}(reset: true) to reset session stats and search index.
  </ctx_commands>
</context_window_protection>`;
}

export function createReadGuidance(t) {
  return '<context_guidance>\n  <tip>\n    If you are reading this file to Edit it, Read is the correct tool — Edit needs file content in context.\n    If you are reading to analyze or explore, use ' + t("ctx_execute_file") + '(path, language, code) instead — only your printed summary will enter the context.\n  </tip>\n</context_guidance>';
}

export function createGrepGuidance(t) {
  return '<context_guidance>\n  <tip>\n    This operation may flood your context window. To stay efficient:\n    - Use ' + t("ctx_execute") + '(language: "shell", code: "...") to run searches in the sandbox.\n    - Only your final printed summary will enter the context.\n  </tip>\n</context_guidance>';
}

export function createBashGuidance(t) {
  return '<context_guidance>\n  <tip>\n    This Bash command may produce large output. To stay efficient:\n    - Use ' + t("ctx_batch_execute") + '(commands, queries) for multiple commands\n    - Use ' + t("ctx_execute") + '(language: "shell", code: "...") to run in sandbox\n    - Only your final printed summary will enter the context.\n    - Bash is best for: git, mkdir, rm, mv, navigation, and short-output commands only.\n  </tip>\n</context_guidance>';
}

// ── Backward compat: static exports defaulting to claude-code ──

const _t = createToolNamer("claude-code");
export const ROUTING_BLOCK = createRoutingBlock(_t);
export const READ_GUIDANCE = createReadGuidance(_t);
export const GREP_GUIDANCE = createGrepGuidance(_t);
export const BASH_GUIDANCE = createBashGuidance(_t);
