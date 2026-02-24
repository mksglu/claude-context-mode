#!/bin/bash
# PreToolUse hook for Task tool — injects context-mode routing instructions
# into subagent prompts when they're missing.
# Preserves ALL original tool_input fields via jq merge.

LOG="/tmp/context-mode-hook.log"
INPUT=$(cat /dev/stdin)

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

# Merge: take ALL original tool_input fields, only override prompt
echo "$INPUT" | jq --arg routing "$ROUTING_BLOCK" '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "updatedInput": (.tool_input + { "prompt": (.tool_input.prompt + $routing) })
  }
}'

echo "$(date '+%H:%M:%S') INJECTED (preserved all fields)" >> "$LOG"
exit 0
