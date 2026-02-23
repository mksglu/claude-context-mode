---
name: context-mode
description: |
  Use context-mode tools (execute, execute_file, fetch_and_index, index, search) instead of
  Bash/curl/cat when processing large outputs. The cost of routing through context-mode is near zero,
  but flooding context with 50KB+ of raw data is catastrophic.

  Use when: user wants to "fetch documentation", "look up the docs", "fetch the docs",
  "check the API reference", "find examples in docs", "index documentation", "search docs",
  "analyze logs", "check the logs", "read access.log", "debug the 500s",
  "run tests", "run the test suite", "check if tests pass", "npm test", "vitest", "pytest",
  "git log", "show recent commits", "list commits", "what changed", "diff between branches",
  "analyze output", "summarize output", "process data", "parse JSON", "parse CSV",
  "filter results", "extract errors", "check build output", "analyze dependencies",
  "process API response", "large file analysis", "hit this endpoint", "call the API",
  "check the response", "list containers", "check pods", "outdated packages",
  "count lines", "find TODOs", "analyze codebase", "security audit",
  or ANY operation where output might exceed 20 lines.
  Also use when routing output from other MCP tools (Playwright snapshots, Context7 docs,
  GitHub API responses, Sentry data) through index → search to avoid context bloat.
---

# Context Mode: Default for All Large Output

## MANDATORY RULE

**Before using Bash, curl, cat, or any command that produces output, ask yourself:**

> "Could this output be more than 20 lines?"

If YES or UNCERTAIN → use `execute` or `execute_file`. Not Bash. Not curl. Not cat.

**This is not optional.** Every KB of unnecessary context reduces the quality and speed of the entire session.

## Decision Tree

```
About to run a command / read a file / call an API?
│
├── Output is GUARANTEED small (<20 lines)?
│   └── Use Bash (git status, pwd, ls, echo, etc.)
│
├── Output MIGHT be large or you're UNSURE?
│   └── Use context-mode execute or execute_file
│
├── Fetching web documentation or HTML page?
│   └── Use fetch_and_index → search
│
├── Processing output from another MCP tool (Playwright, Context7, etc.)?
│   └── Use index → search
│
└── Reading a file to analyze/summarize (not edit)?
    └── Use execute_file (file loads into FILE_CONTENT, not context)
```

## When to Use Each Tool

| Situation | Tool | Example |
|-----------|------|---------|
| Hit an API endpoint | `execute` | `fetch('http://localhost:3000/api/orders')` |
| Run CLI that returns data | `execute` | `gh pr list`, `aws s3 ls`, `kubectl get pods` |
| Run tests | `execute` | `npm test`, `pytest`, `go test ./...` |
| Git operations | `execute` | `git log --oneline -50`, `git diff HEAD~5` |
| Docker/K8s inspection | `execute` | `docker stats --no-stream`, `kubectl describe pod` |
| Read a log file | `execute_file` | Parse access.log, error.log, build output |
| Read a data file | `execute_file` | Analyze CSV, JSON, YAML, XML |
| Read source code to analyze | `execute_file` | Count functions, find patterns, extract metrics |
| Fetch web docs | `fetch_and_index` | Index React/Next.js/Zod docs, then search |
| Process large MCP output | `index` → `search` | Index Playwright snapshot, then query elements |

## Automatic Triggers

Use context-mode for ANY of these, without being asked:

- **API debugging**: "hit this endpoint", "call the API", "check the response", "find the bug in the response"
- **Log analysis**: "check the logs", "what errors", "read access.log", "debug the 500s"
- **Test runs**: "run the tests", "check if tests pass", "test suite output"
- **Git history**: "show recent commits", "git log", "what changed", "diff between branches"
- **Data inspection**: "look at the CSV", "parse the JSON", "analyze the config"
- **Infrastructure**: "list containers", "check pods", "S3 buckets", "show running services"
- **Dependency audit**: "check dependencies", "outdated packages", "security audit"
- **Build output**: "build the project", "check for warnings", "compile errors"
- **Code metrics**: "count lines", "find TODOs", "function count", "analyze codebase"
- **Web docs lookup**: "look up the docs", "check the API reference", "find examples"

## Language Selection

| Situation | Language | Why |
|-----------|----------|-----|
| HTTP/API calls, JSON | `javascript` | Native fetch, JSON.parse, async/await |
| Data analysis, CSV, stats | `python` | csv, statistics, collections, re |
| Shell commands with pipes | `shell` | grep, awk, jq, native tools |
| File pattern matching | `shell` | find, wc, sort, uniq |

## Search Query Strategy

- BM25 uses **OR semantics** — results matching more terms rank higher automatically
- Use 2-4 specific technical terms per query: `search("transform refine pipe")`
- **Always use `source` parameter** when multiple docs are indexed to avoid cross-source contamination
  - After `fetch_and_index` returns `source: "Zod API docs"`, use `search("refine", source: "Zod")`
  - Partial match works: `source: "Node"` matches `"Node.js v22 CHANGELOG"`
- Send multiple `search()` calls **in parallel** for different aspects of a topic
- Example: instead of one broad search, send 3 focused parallel queries:
  - `search("transform pipe", source: "Zod")` + `search("refine superRefine", source: "Zod")` + `search("coerce codec", source: "Zod")`

## External Documentation

- **Always use `fetch_and_index`** for external docs — NEVER `cat` or `execute` with local paths for packages you don't own
- For GitHub-hosted projects, use the raw URL: `https://raw.githubusercontent.com/org/repo/main/CHANGELOG.md`
- After indexing, use the `source` parameter in search to scope results to that specific document

## Critical Rules

1. **Always console.log/print your findings.** stdout is all that enters context. No output = wasted call.
2. **Write analysis code, not just data dumps.** Don't `console.log(JSON.stringify(data))` — analyze first, print findings.
3. **Be specific in output.** Print bug details with IDs, line numbers, exact values — not just counts.
4. **For files you need to EDIT**: Use the normal Read tool. context-mode is for analysis, not editing.
5. **For tiny outputs (<5 lines guaranteed)**: Use Bash. Don't over-engineer `git status` through context-mode.

## Examples

### Debug an API endpoint
```javascript
const resp = await fetch('http://localhost:3000/api/orders');
const { orders } = await resp.json();

const bugs = [];
const negQty = orders.filter(o => o.quantity < 0);
if (negQty.length) bugs.push(`Negative qty: ${negQty.map(o => o.id).join(', ')}`);

const nullFields = orders.filter(o => !o.product || !o.customer);
if (nullFields.length) bugs.push(`Null fields: ${nullFields.map(o => o.id).join(', ')}`);

console.log(`${orders.length} orders, ${bugs.length} bugs found:`);
bugs.forEach(b => console.log(`- ${b}`));
```

### Analyze test output
```shell
npm test 2>&1
echo "EXIT=$?"
```

### Check GitHub PRs
```shell
gh pr list --json number,title,state,reviewDecision --jq '.[] | "\(.number) [\(.state)] \(.title) — \(.reviewDecision // "no review")"'
```

### Read and analyze a large file
```python
# FILE_CONTENT is pre-loaded by execute_file
import json
data = json.loads(FILE_CONTENT)
print(f"Records: {len(data)}")
# ... analyze and print findings
```

## Anti-Patterns

- Using `curl http://api/endpoint` via Bash → 50KB floods context. Use `execute` with fetch instead.
- Using `cat large-file.json` via Bash → entire file in context. Use `execute_file` instead.
- Using `gh pr list` via Bash → raw JSON in context. Use `execute` with `--jq` filter instead.
- Piping Bash output through `| head -20` → you lose the rest. Use `execute` to analyze ALL data and print summary.
- Running `npm test` via Bash → full test output in context. Use `execute` to capture and summarize.

## Reference Files

- [JavaScript/TypeScript Patterns](./references/patterns-javascript.md)
- [Python Patterns](./references/patterns-python.md)
- [Shell Patterns](./references/patterns-shell.md)
- [Anti-Patterns & Common Mistakes](./references/anti-patterns.md)
