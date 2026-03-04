/**
 * Shared routing block for context-mode hooks.
 * Single source of truth — imported by pretooluse.mjs and sessionstart.mjs.
 */

export const ROUTING_BLOCK = `
<context_window_protection>
  <priority_instructions>
    Raw tool output floods your context window. You MUST use context-mode MCP tools to keep raw data in the sandbox.
  </priority_instructions>

  <tool_selection_hierarchy>
    1. GATHER: mcp__plugin_context-mode_context-mode__batch_execute(commands, queries)
       - Primary tool for research. Runs all commands, auto-indexes, and searches.
       - ONE call replaces many individual steps.
    2. FOLLOW-UP: mcp__plugin_context-mode_context-mode__search(queries: ["q1", "q2", ...])
       - Use for all follow-up questions. ONE call, many queries.
    3. PROCESSING: mcp__plugin_context-mode_context-mode__execute(language, code) | mcp__plugin_context-mode_context-mode__execute_file(path, language, code)
       - Use for API calls, log analysis, and data processing.
  </tool_selection_hierarchy>

  <forbidden_actions>
    - DO NOT use Bash for commands producing >20 lines of output.
    - DO NOT use Read for analysis (use execute_file). Read IS correct for files you intend to Edit.
    - DO NOT use WebFetch (use mcp__plugin_context-mode_context-mode__fetch_and_index instead).
    - Bash is ONLY for git/mkdir/rm/mv/navigation.
  </forbidden_actions>

  <output_constraints>
    <word_limit>Keep your final response under 500 words.</word_limit>
    <artifact_policy>
      Write artifacts (code, configs, PRDs) to FILES. NEVER return them as inline text.
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
</context_window_protection>`;

export const READ_GUIDANCE = '<context_guidance>\n  <tip>\n    If you are reading this file to Edit it, Read is the correct tool — Edit needs file content in context.\n    If you are reading to analyze or explore, use mcp__plugin_context-mode_context-mode__execute_file(path, language, code) instead — only your printed summary will enter the context.\n  </tip>\n</context_guidance>';

export const GREP_GUIDANCE = '<context_guidance>\n  <tip>\n    This operation may flood your context window. To stay efficient:\n    - Use mcp__plugin_context-mode_context-mode__execute(language: "shell", code: "...") to run searches in the sandbox.\n    - Only your final printed summary will enter the context.\n  </tip>\n</context_guidance>';
