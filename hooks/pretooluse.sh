#!/bin/bash
# Unified PreToolUse hook for context-mode
# - Bash: blocks data-fetching commands (curl, wget, inline fetch)
# - Task: injects context-mode routing into subagent prompts

INPUT=$(cat /dev/stdin)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""')

# ─── Bash: block data-fetching commands ───
if [ "$TOOL" = "Bash" ]; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

  # curl/wget
  if echo "$COMMAND" | grep -qiE '(^|\s|&&|\||\;)(curl|wget)\s'; then
    cat <<'EOF'
{
  "decision": "block",
  "reason": "BLOCKED: curl/wget floods context window. Use context-mode execute instead.\n\nExample:\nmcp__context-mode__execute(language: \"javascript\", code: \"const resp = await fetch('http://...'); const data = await resp.json(); console.log(JSON.stringify(data, null, 2));\")\n\nThis runs in sandbox — only stdout enters context."
}
EOF
    exit 0
  fi

  # inline fetch (node -e, python -c, etc.)
  if echo "$COMMAND" | grep -qiE 'fetch\s*\(\s*['"'"'"](https?://|http)' || \
     echo "$COMMAND" | grep -qiE 'requests\.(get|post|put)\s*\(' || \
     echo "$COMMAND" | grep -qiE 'http\.(get|request)\s*\('; then
    cat <<'EOF'
{
  "decision": "block",
  "reason": "BLOCKED: Inline HTTP fetch via Bash floods context window. Use context-mode execute instead.\n\nExample:\nmcp__context-mode__execute(language: \"javascript\", code: \"const resp = await fetch('http://...'); const data = await resp.json(); console.log(JSON.stringify(data, null, 2));\")\n\nThis runs in sandbox — only stdout enters context."
}
EOF
    exit 0
  fi

  # allow all other Bash commands
  exit 0
fi

# ─── Task: inject context-mode routing into subagent prompts ───
if [ "$TOOL" = "Task" ]; then
  ROUTING_BLOCK='

---
CONTEXT WINDOW PROTECTION — USE CONTEXT-MODE MCP TOOLS

Raw Bash/Read/WebFetch output floods your context. You have context-mode tools that keep data in sandbox.

STEP 1 — GATHER: mcp__context-mode__batch_execute(commands, queries)
  commands: [{label: "Name", command: "shell cmd"}, ...]
  queries: ["query1", "query2", ...] — put 5-8 queries covering everything you need.
  Runs all commands, indexes output, returns search results. ONE call, no follow-ups.

STEP 2 — FOLLOW-UP: mcp__context-mode__search(queries: ["q1", "q2", "q3", ...])
  Pass ALL follow-up questions as queries array. ONE call, not separate calls.

OTHER: execute(language, code) | execute_file(path, language, code) | fetch_and_index(url) + search

FORBIDDEN: Bash for output, Read for files, WebFetch. Bash is ONLY for git/mkdir/rm/mv.
---'

  echo "$INPUT" | jq --arg routing "$ROUTING_BLOCK" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "updatedInput": (.tool_input + { "prompt": (.tool_input.prompt + $routing) })
    }
  }'
  exit 0
fi

# Unknown tool — pass through
exit 0
