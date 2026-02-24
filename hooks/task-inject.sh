#!/bin/bash
# PreToolUse hook for Task tool — injects context-mode routing instructions
# into subagent prompts when they're missing.
# Preserves ALL original tool_input fields via jq merge.

LOG="/tmp/context-mode-hook.log"
INPUT=$(cat /dev/stdin)

PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // ""')

# If prompt already contains context-mode references, pass through
if echo "$PROMPT" | grep -q 'mcp__context-mode'; then
  echo "$(date '+%H:%M:%S') PASSTHROUGH" >> "$LOG"
  exit 0
fi

ROUTING_BLOCK='

---
TOOL ROUTING: You have context-mode MCP tools. Use these instead of Bash/WebFetch/Read for large outputs:
- mcp__context-mode__execute (language, code, intent) — instead of Bash for ANY command producing >5 lines
- mcp__context-mode__fetch_and_index (url, source) — instead of WebFetch for web pages
- mcp__context-mode__search (query, source) — to search indexed content
- mcp__context-mode__execute_file (path, language, code) — instead of Read for large file analysis
Do NOT use Bash, curl, cat, Read, or WebFetch for large outputs.
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
