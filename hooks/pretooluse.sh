#!/bin/bash
# Unified PreToolUse hook for context-mode
# Redirects data-fetching tools to context-mode MCP tools

INPUT=$(cat /dev/stdin)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""')

# ─── Bash: redirect data-fetching commands via updatedInput ───
if [ "$TOOL" = "Bash" ]; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

  # curl/wget → replace with echo redirect
  if echo "$COMMAND" | grep -qiE '(^|\s|&&|\||\;)(curl|wget)\s'; then
    jq -n '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "updatedInput": {
          "command": "echo \"context-mode: curl/wget blocked. You MUST use mcp__context-mode__fetch_and_index(url, source) to fetch URLs, or mcp__context-mode__execute(language, code) to run HTTP calls in sandbox. Do NOT retry with curl/wget.\""
        }
      }
    }'
    exit 0
  fi

  # inline fetch (node -e, python -c, etc.) → replace with echo redirect
  if echo "$COMMAND" | grep -qiE 'fetch\s*\(\s*['"'"'"](https?://|http)' || \
     echo "$COMMAND" | grep -qiE 'requests\.(get|post|put)\s*\(' || \
     echo "$COMMAND" | grep -qiE 'http\.(get|request)\s*\('; then
    jq -n '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "updatedInput": {
          "command": "echo \"context-mode: Inline HTTP blocked. Use mcp__context-mode__execute(language, code) to run HTTP calls in sandbox, or mcp__context-mode__fetch_and_index(url, source) for web pages. Do NOT retry with Bash.\""
        }
      }
    }'
    exit 0
  fi

  # allow all other Bash commands
  exit 0
fi

# ─── Read: nudge toward execute_file ───
if [ "$TOOL" = "Read" ]; then
  jq -n '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "additionalContext": "CONTEXT TIP: If this file is large (>50 lines), prefer mcp__context-mode__execute_file(path, language, code) — processes in sandbox, only stdout enters context."
    }
  }'
  exit 0
fi

# ─── Grep: nudge toward execute ───
if [ "$TOOL" = "Grep" ]; then
  jq -n '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "additionalContext": "CONTEXT TIP: If results may be large, prefer mcp__context-mode__execute(language: \"shell\", code: \"grep ...\") — runs in sandbox, only stdout enters context."
    }
  }'
  exit 0
fi

# ─── Glob: passthrough ───
if [ "$TOOL" = "Glob" ]; then
  exit 0
fi

# ─── WebFetch: deny + redirect to sandbox ───
if [ "$TOOL" = "WebFetch" ]; then
  ORIGINAL_URL=$(echo "$INPUT" | jq -r '.tool_input.url // ""')
  jq -n --arg url "$ORIGINAL_URL" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "reason": ("context-mode: WebFetch blocked. Use mcp__context-mode__fetch_and_index(url: \"" + $url + "\", source: \"...\") to fetch this URL in sandbox. Then use mcp__context-mode__search(queries: [...]) to query results. Do NOT use curl/wget — they are also blocked.")
    }
  }'
  exit 0
fi

# ─── WebSearch: passthrough ───
if [ "$TOOL" = "WebSearch" ]; then
  exit 0
fi

# ─── Task: inject context-mode routing into subagent prompts ───
if [ "$TOOL" = "Task" ]; then
  SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // ""')
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

  if [ "$SUBAGENT_TYPE" = "Bash" ]; then
    # Bash subagents only have the Bash tool — upgrade to general-purpose for MCP access
    echo "$INPUT" | jq --arg routing "$ROUTING_BLOCK" '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "updatedInput": (.tool_input + { "prompt": (.tool_input.prompt + $routing), "subagent_type": "general-purpose" })
      }
    }'
  else
    echo "$INPUT" | jq --arg routing "$ROUTING_BLOCK" '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "updatedInput": (.tool_input + { "prompt": (.tool_input.prompt + $routing) })
      }
    }'
  fi
  exit 0
fi

# Unknown tool — pass through
exit 0
