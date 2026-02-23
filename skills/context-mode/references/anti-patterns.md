# Anti-Patterns: Common Mistakes with execute / execute_file

Avoid these pitfalls when using context-mode tools.

---

## 1. Using execute for Small Outputs (< 20 Lines)

**Problem:** `execute` adds overhead (LLM summarization call). For small outputs, Bash is faster and cheaper.

```
BAD — wasteful use of execute:
  Tool: execute
  code: "echo $(node --version)"
  language: shell

GOOD — just use Bash:
  Tool: Bash
  command: node --version
```

**Rule:** If the output fits comfortably in your context window (under ~20 lines), use Bash directly. Reserve `execute` for outputs that would bloat context or need intelligent summarization.

More examples of "just use Bash":
- `git status` — usually 5-10 lines
- `ls -la` — directory listing
- `cat .env.example` — small config file
- `pwd`, `whoami`, `which node`
- `wc -l src/index.ts` — single line output

---

## 2. Forgetting to Print Output

**Problem:** `execute` captures stdout. If your code doesn't print anything, the summary will be empty or meaningless.

```javascript
// BAD — no output:
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const deps = Object.keys(data.dependencies);
// Nothing printed! The LLM sees empty stdout.

// GOOD — explicit output:
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const deps = Object.keys(data.dependencies);
console.log(`Dependencies (${deps.length}):`);
deps.forEach(d => console.log(`  ${d}: ${data.dependencies[d]}`));
```

```python
# BAD — computes but never prints:
with open('data.json') as f:
    data = json.load(f)
result = [x for x in data if x['status'] == 'error']
# result is lost — never printed

# GOOD — always print results:
with open('data.json') as f:
    data = json.load(f)
result = [x for x in data if x['status'] == 'error']
print(f"Found {len(result)} errors:")
for r in result:
    print(f"  {r['id']}: {r['message']}")
```

**Rule:** Every `execute` script must end with print/console.log of the results you want summarized.

---

## 3. Using Bash When JS/Python Would Be Cleaner

**Problem:** Complex data processing in Bash quickly becomes unreadable and error-prone.

```shell
# BAD — parsing JSON in Bash is fragile:
cat data.json | python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data:
    if item['status'] == 'error':
        print(item['id'], item['message'])
"
# If you're already using Python inline, just use language: python
```

```javascript
// GOOD — use the right language for the job:
// language: javascript
const data = require('./data.json');
data.filter(x => x.status === 'error')
    .forEach(x => console.log(`${x.id}: ${x.message}`));
```

**Rule:** If your Bash script contains inline Python/Node or complex `jq`/`awk` chains, switch to `language: python` or `language: javascript` instead.

Signs you should switch from shell:
- Using `python3 -c` or `node -e` inside the shell script
- More than 3 pipes chained together
- Using `jq` for complex JSON transformations
- Nested loops in Bash
- String manipulation beyond simple `cut`/`sed`

---

## 4. Loading Entire Files into Context Then Processing

**Problem:** Reading a 10,000-line file with `Read` tool, then asking about it, wastes your entire context window. Use `execute` to process the file and return only the summary.

```
BAD workflow:
  1. Read tool: read 'server.log' (10,000 lines loaded into context)
  2. "Find all errors in this log"
  → 10,000 lines consumed context for a question that needs ~20 lines of output

GOOD workflow:
  1. execute with language: python
     code: |
       with open('server.log') as f:
           errors = [l for l in f if 'ERROR' in l]
       print(f"Total errors: {len(errors)}")
       for e in errors[-20:]:
           print(e.strip())
     summary_prompt: "Categorize errors and report frequency"
  → Only the summary enters context
```

```
BAD workflow:
  1. Read tool: read 'package-lock.json' (20,000 lines)
  2. "What version of lodash is installed?"

GOOD workflow:
  1. execute with language: javascript
     code: |
       const lock = require('./package-lock.json');
       const find = (deps, name) => {
         if (deps[name]) return deps[name].version;
         for (const [, dep] of Object.entries(deps)) {
           if (dep.dependencies) {
             const v = find(dep.dependencies, name);
             if (v) return v;
           }
         }
       };
       console.log(`lodash: ${find(lock.dependencies, 'lodash') || 'not found'}`);
     summary_prompt: "Report the installed version of lodash"
```

**Rule:** If a file is over 200 lines and you only need specific data from it, use `execute` to extract what you need rather than reading the whole file into context.

---

## 5. Not Using JSON.stringify for Structured Output

**Problem:** Printing objects without serialization gives `[object Object]` in JavaScript.

```javascript
// BAD — prints [object Object]:
const pkg = require('./package.json');
console.log(pkg.dependencies);
// Output: [object Object]

// GOOD — serialize properly:
const pkg = require('./package.json');
console.log(JSON.stringify(pkg.dependencies, null, 2));
// Output: { "react": "^18.2.0", "next": "^14.0.0", ... }
```

```javascript
// BAD — loses structure in arrays:
const items = [{name: 'a', value: 1}, {name: 'b', value: 2}];
console.log(items);
// May print unhelpfully

// GOOD — format as table:
const items = [{name: 'a', value: 1}, {name: 'b', value: 2}];
console.log('Name  | Value');
console.log('------|------');
items.forEach(i => console.log(`${i.name.padEnd(5)} | ${i.value}`));
// Or use JSON.stringify:
console.log(JSON.stringify(items, null, 2));
```

**Rule:** Always use `JSON.stringify(data, null, 2)` for objects/arrays in JavaScript, or format as a readable table. In Python, use `json.dumps(data, indent=2)` or `pprint.pprint(data)`.

---

## 6. Timeout Too Short for Network Operations

**Problem:** Default timeout may be too short for API calls, builds, or test suites.

```
BAD — will timeout on API calls:
  Tool: execute
  code: |
    const resp = await fetch('https://api.slow-service.com/data');
    console.log(await resp.json());
  language: javascript
  timeout_ms: 5000  ← API may take 10+ seconds

GOOD — generous timeout for network:
  Tool: execute
  code: |
    const resp = await fetch('https://api.slow-service.com/data');
    console.log(JSON.stringify(await resp.json(), null, 2));
  language: javascript
  timeout_ms: 30000  ← 30 seconds for network calls
```

**Recommended timeouts:**
| Operation | timeout_ms |
|-----------|-----------|
| File reading/parsing | 5000 - 10000 |
| Local computation | 10000 |
| Single API request | 15000 - 30000 |
| Paginated API calls | 30000 - 60000 |
| npm install / build | 120000 |
| Full test suite | 120000 - 300000 |

**Rule:** Always consider what your script does and set `timeout_ms` accordingly. Network calls and builds need significantly more time than file operations.

---

## 7. Not Using summary_prompt Effectively

**Problem:** Without a good `summary_prompt`, the LLM summarization may focus on irrelevant details.

```
BAD — vague or missing summary_prompt:
  summary_prompt: "Summarize this"
  → May focus on the wrong aspects

GOOD — specific and actionable:
  summary_prompt: "Report the count of failing tests, list each failure with its file path and error message, and identify any patterns in the failures"
```

**Tips for effective summary_prompt:**
- Be specific about what data points you need
- Ask for counts and metrics, not just descriptions
- Request actionable insights ("suggest fixes", "identify patterns")
- Mention the format you want ("list as bullet points", "group by category")

---

## Summary Checklist

Before using `execute`, verify:

- [ ] Output will be > 20 lines (otherwise use Bash)
- [ ] Script prints all results to stdout
- [ ] Objects are serialized with JSON.stringify / json.dumps
- [ ] Timeout matches the operation type
- [ ] Language matches the task (JS for JSON/API, Python for data, Shell for pipes)
- [ ] summary_prompt is specific and actionable
- [ ] Not loading a file into context that could be processed inside execute
