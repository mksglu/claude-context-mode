---
name: context-mode
description: |
  Use context-mode tools (execute, execute_file) instead of Bash/cat when processing
  large outputs. Trigger phrases: "analyze logs", "summarize output", "process data",
  "parse JSON", "filter results", "extract errors", "check build output",
  "analyze dependencies", "process API response", "large file analysis".
---

# Context Mode: execute & execute_file

## When to Use (Decision Tree)

```
Will the command output > 20 lines?
├── YES → Will you process/filter/summarize that output?
│   ├── YES → Use execute or execute_file
│   └── NO  → Use Bash (you need raw output)
└── NO  → Use Bash (small output fits in context)
```

**Rule of thumb:** If you would pipe Bash output through grep/awk/jq to reduce it,
use `execute` or `execute_file` instead — the LLM summary is better.

## Quick Reference

| Tool | Purpose | Key Parameters |
|------|---------|---------------|
| `execute` | Run inline code, get LLM summary | `code`, `language`, `timeout_ms`, `summary_prompt` |
| `execute_file` | Run a script file, get LLM summary | `file_path`, `args`, `timeout_ms`, `summary_prompt` |

Both tools execute code and return an **LLM-generated summary** instead of raw stdout.
The raw output never enters your context window — only the summary does.

## Language Selection Guide

| Scenario | Language | Why |
|----------|----------|-----|
| HTTP requests, JSON APIs | `javascript` | Native fetch, JSON.parse |
| Data analysis, CSV, math | `python` | pandas, csv module, statistics |
| Piping commands, grep, find | `shell` | Native OS tools |
| TypeScript project analysis | `javascript` | Can require/import project files |
| Log file filtering | `shell` | grep/awk are purpose-built |
| File comparison | `python` | difflib is excellent |

## Usage Pattern

### execute — inline code

```
Tool: execute
Parameters:
  code: |
    const data = require('fs').readFileSync('package.json', 'utf8');
    const pkg = JSON.parse(data);
    console.log(`Name: ${pkg.name}`);
    console.log(`Dependencies: ${Object.keys(pkg.dependencies || {}).length}`);
    console.log(`DevDependencies: ${Object.keys(pkg.devDependencies || {}).length}`);
    Object.entries(pkg.dependencies || {}).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  language: javascript
  timeout_ms: 10000
  summary_prompt: "List the package name, dependency count, and any outdated patterns"
```

### execute_file — run existing script

```
Tool: execute_file
Parameters:
  file_path: ./scripts/analyze-bundle.js
  args: ["--format", "summary"]
  timeout_ms: 30000
  summary_prompt: "Report bundle size changes and any chunks exceeding 500KB"
```

## Critical Rules

1. **Always print/log output.** The tool captures stdout. No output = empty summary.
2. **Use `summary_prompt`** to guide what the LLM extracts from the output.
3. **Set appropriate `timeout_ms`** — network calls need 15000+, file ops need 5000+.
4. **Print structured data** — JSON.stringify or formatted tables summarize better.
5. **Don't use for < 20 lines** — Bash is simpler and wastes no LLM call.

## Examples by Language

### JavaScript: API response analysis
```javascript
const resp = await fetch('https://api.example.com/status');
const data = await resp.json();
console.log(JSON.stringify(data, null, 2));
```
> summary_prompt: "Report service health, any degraded components, and error rates"

### Python: Log analysis
```python
import re
with open('/var/log/app.log') as f:
    errors = [l for l in f if 'ERROR' in l]
for e in errors[-50:]:
    print(e.strip())
print(f"\nTotal errors: {len(errors)}")
```
> summary_prompt: "Categorize errors by type and report frequency of each"

### Shell: Build output filtering
```shell
npm run build 2>&1
echo "EXIT_CODE=$?"
```
> summary_prompt: "Report success/failure, list any errors or warnings with file locations"

## Anti-Patterns (Avoid These)

- Using `execute` for `git status` (small output — use Bash)
- Forgetting `console.log()` / `print()` (produces empty summary)
- Setting `timeout_ms: 5000` for network requests (will timeout)
- Loading a 10K-line file into context then asking to summarize (use execute instead)

## Reference Files

- [JavaScript/TypeScript Patterns](./references/patterns-javascript.md)
- [Python Patterns](./references/patterns-python.md)
- [Shell Patterns](./references/patterns-shell.md)
- [Anti-Patterns & Common Mistakes](./references/anti-patterns.md)
