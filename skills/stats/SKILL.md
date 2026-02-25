---
name: stats
description: |
  Show how much context window context-mode saved this session.
  Displays token consumption, context savings ratio, and per-tool breakdown.
  Trigger: /context-mode:stats
user_invocable: true
---

# Context Mode Stats

Show context savings for the current session.

## Instructions

1. Call the `mcp__context-mode__stats` MCP tool (no parameters needed).
2. **CRITICAL**: You MUST copy-paste the ENTIRE tool output as markdown text directly into your response message. Do NOT summarize, do NOT collapse, do NOT paraphrase. The user must see the full tables without pressing ctrl+o. Copy every line exactly as returned by the tool.
3. After the full output, add ONE sentence highlighting the key savings metric, e.g.:
   - "context-mode saved **12.4x** — 92% of data stayed in sandbox."
   - If no data yet: "No context-mode calls yet this session."
