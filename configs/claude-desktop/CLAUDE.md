# context-mode — MANDATORY routing rules

context-mode MCP tools available. Rules protect context window from flooding.
One unrouted command dumps 56 KB into context. Claude Desktop has NO hooks —
these instructions are the ONLY enforcement. Follow strictly.

## Think in Code — MANDATORY

Analyze/count/filter/compare/search/parse/transform data: write code via
`ctx_execute(language, code)`, `console.log()` only the answer. Do NOT read
raw data into context. PROGRAM the analysis, not COMPUTE it. Pure JavaScript —
Node.js built-ins only (`fs`, `path`, `child_process`). `try/catch`, handle
`null`/`undefined`. One script replaces ten tool calls.

```js
// Before: 47 × Read() = 700 KB.  After: 1 × ctx_execute() = 3.6 KB.
ctx_execute("javascript", `
  const files = fs.readdirSync('src').filter(f => f.endsWith('.ts'));
  files.forEach(f => console.log(f + ': ' + fs.readFileSync('src/'+f,'utf8').split('\\n').length + ' lines'));
`);
```

## BLOCKED — do NOT use

- WebFetch — use `ctx_fetch_and_index` instead
- `curl` / `wget` in shell — use `ctx_execute` or `ctx_fetch_and_index`
- Any tool that produces >20 lines of output without going through `ctx_*`

## REDIRECTED — use sandbox

| Don't | Use instead |
|---|---|
| Shell (>20 lines)        | `ctx_execute(language: "shell", code)` |
| File reading for analysis | `ctx_execute_file(path, language, code)` |
| Search across many files | `ctx_batch_execute(commands, queries)` |
| Web fetch                | `ctx_fetch_and_index(url)` then `ctx_search` |

`Read` is correct for files you intend to `Edit`. Don't use it to "look at" a
file you'll only analyze.

## Tool selection (in order)

1. **GATHER** → `ctx_batch_execute(commands, queries)` — primary research tool.
   Runs all commands, auto-indexes output, searches with provided queries.
   ONE call replaces many steps.
2. **FOLLOW-UP** → `ctx_search(queries: ["q1", "q2", ...])` — multi-query in
   ONE call. Don't make many `ctx_search` calls; batch them.
3. **PROCESSING** → `ctx_execute` / `ctx_execute_file` — sandbox execution,
   only stdout enters context.
4. **WEB** → `ctx_fetch_and_index(url)` then `ctx_search` — never dump raw HTML.

## Output

Terse like caveman. Technical substance exact. Only fluff die.
Drop articles, filler (just/really/basically), pleasantries, hedging.
Fragments OK. Short synonyms. Code unchanged.
Pattern: [thing] [action] [reason]. [next step].
Auto-expand for: security warnings, irreversible actions, user confusion.

## ctx commands (type these in chat — model invokes the MCP tool)

| Type this | Calls |
|---|---|
| `ctx stats`   | `ctx_stats` — context savings breakdown |
| `ctx doctor`  | `ctx_doctor` — diagnostics, run returned shell command |
| `ctx upgrade` | `ctx_upgrade` — pull latest, rebuild |
| `ctx purge`   | `ctx_purge` — wipe knowledge base (irreversible — confirm first) |

> Claude Desktop has no slash commands like `/context-mode:ctx-stats`.
> Type the natural-language phrase — the model picks up the request and calls
> the MCP tool.

## Setup note

This file must be pasted into a Claude Desktop **Project's Custom Instructions**
field, or pasted as the first message of each conversation. Claude Desktop has
no SessionStart hook to auto-load it. Without these instructions in context,
the model falls back to raw `Bash`/`Read` for ~40% of operations.
