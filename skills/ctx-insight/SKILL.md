---
name: ctx-insight
description: |
  Open the context-mode Insight analytics dashboard in the browser.
  Shows personal metrics: session activity, tool usage, error rate,
  parallel work patterns, project focus, and actionable insights.
  First run installs dependencies (~30s). Subsequent runs open instantly.
  Trigger: /context-mode:ctx-insight
user-invocable: true
---

# Context Mode Insight

Open the personal analytics dashboard in the browser.

## Instructions

1. Call the `ctx_insight` MCP tool (no parameters needed, or pass `port: 4747` to customize).
2. The tool will:
   - Copy source files to cache (first run only)
   - Install dependencies (first run only, ~30s)
   - Build the dashboard (~1s)
   - Start a local server
   - Open the browser
3. Display the tool's output to the user — it contains progress steps and the dashboard URL.
4. Tell the user:
   - "Dashboard is running at http://localhost:4747"
   - "Refresh the page to see updated metrics"
   - "Dashboard stops automatically when Claude exits. To stop sooner: kill the PID shown above."
