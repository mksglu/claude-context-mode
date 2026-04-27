# context-mode

Raw tool output floods context window. Use context-mode MCP tools to keep raw data in sandbox.

## Think in Code — MANDATORY

Analyze/count/filter/compare/search/parse/transform data: **write code** via `ctx_execute(language, code)`, `console.log()` only the answer. Do NOT read raw data into context. PROGRAM the analysis, not COMPUTE it. Pure JavaScript — Node.js built-ins only (`fs`, `path`, `child_process`). `try/catch`, handle `null`/`undefined`. One script replaces ten tool calls.

## Tool Selection

1. **GATHER**: `ctx_batch_execute(commands, queries)` — runs all commands, auto-indexes, searches. ONE call replaces many steps.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — all follow-up questions, ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — sandbox, only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url)` then `ctx_search(queries)` — never dump raw HTML.

## Rules

- DO NOT use Bash for >20 lines output — use `ctx_execute` or `ctx_batch_execute`.
- DO NOT use Read for analysis — use `ctx_execute_file`. Read IS correct for Edit.
- DO NOT use WebFetch — use `ctx_fetch_and_index`.
- DO NOT use curl/wget in Bash — use `ctx_execute` or `ctx_fetch_and_index`.
- Bash ONLY for git, mkdir, rm, mv, navigation, short commands.

## Output

Terse like caveman. Technical substance exact. Only fluff die.
Drop: articles, filler (just/really/basically), pleasantries, hedging. Fragments OK. Short synonyms. Code unchanged.
Pattern: [thing] [action] [reason]. [next step]. Auto-expand for: security warnings, irreversible actions, user confusion.
Write artifacts to FILES — never inline. Return: file path + 1-line description.
