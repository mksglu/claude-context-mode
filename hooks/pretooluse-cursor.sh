#!/bin/bash
# Cursor-native PreToolUse hook for context-mode
# Compatible with Cursor's hook format: {"decision": "allow/deny", "reason": "..."}
# See: https://cursor.com/docs/agent/third-party-hooks

INPUT=$(cat /dev/stdin)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""')

# ─── Shell: block curl/wget and inline HTTP, redirect to context-mode ───
if [ "$TOOL" = "Shell" ] || [ "$TOOL" = "Bash" ]; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

  if echo "$COMMAND" | grep -qiE '(^|\s|&&|\||\;)(curl|wget)\s'; then
    echo '{"decision": "deny", "reason": "context-mode: curl/wget blocked. Use mcp__context-mode__fetch_and_index(url, source) to fetch URLs, or mcp__context-mode__execute(language, code) to run HTTP calls in sandbox. Do NOT retry with curl/wget."}'
    exit 2
  fi

  if echo "$COMMAND" | grep -qiE 'fetch\s*\(\s*['"'"'"](https?://|http)' || \
     echo "$COMMAND" | grep -qiE 'requests\.(get|post|put)\s*\(' || \
     echo "$COMMAND" | grep -qiE 'http\.(get|request)\s*\('; then
    echo '{"decision": "deny", "reason": "context-mode: Inline HTTP blocked. Use mcp__context-mode__execute(language, code) to run HTTP calls in sandbox, or mcp__context-mode__fetch_and_index(url, source) for web pages. Do NOT retry with Shell."}'
    exit 2
  fi

  echo '{"decision": "allow"}'
  exit 0
fi

# ─── Read: allow (additionalContext not supported in Cursor hooks) ───
if [ "$TOOL" = "Read" ]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# ─── Grep: allow ───
if [ "$TOOL" = "Grep" ]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# ─── Task: allow (updatedInput/prompt injection not supported in Cursor hooks) ───
if [ "$TOOL" = "Task" ]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# ─── WebFetch: block and redirect to context-mode ───
if [ "$TOOL" = "WebFetch" ]; then
  ORIGINAL_URL=$(echo "$INPUT" | jq -r '.tool_input.url // ""')
  echo "{\"decision\": \"deny\", \"reason\": \"context-mode: WebFetch blocked. Use mcp__context-mode__fetch_and_index(url: \\\"${ORIGINAL_URL}\\\", source: \\\"...\\\") to fetch this URL in sandbox. Then use mcp__context-mode__search(queries: [...]) to query results.\"}"
  exit 2
fi

# Unknown tool — allow
echo '{"decision": "allow"}'
exit 0
