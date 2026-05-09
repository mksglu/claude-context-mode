# context-mode

> Save 98% of your context window. Sandboxed code execution in 11 languages, FTS5 knowledge base with BM25 ranking, and native Cursor v1.7+ hook routing for context protection.

## What it does

context-mode is an MCP server + hook bundle that keeps long-running Cursor agent sessions from blowing through their context window. Three pillars:

- **Sandboxed execution** — `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute` run code in 11 languages (Node, Python, Bun, Deno, Ruby, Go, Rust, Java, C, C++, Shell). Only `stdout` enters the agent's context, so analysing huge files no longer floods the window.
- **FTS5 knowledge base** — `ctx_index`, `ctx_search`, `ctx_fetch_and_index` store research, command output, and web content in SQLite FTS5 with BM25 ranking. The agent searches its own memory instead of re-reading files.
- **Native Cursor hooks** — registers `preToolUse`, `postToolUse`, `sessionStart`, `afterAgentResponse`, and `stop` so context-mode can intercept Shell / Read / Grep / WebFetch and redirect them to the sandbox before they pollute context.

## Install

After clicking **Install** in the Cursor Plugins panel, the plugin registers an MCP server that runs `npx -y context-mode`. The first invocation downloads the package from npm; subsequent invocations are cached.

If you prefer pinning a global install (faster cold start):

```bash
npm i -g context-mode
```

The plugin manifest will pick up the global binary automatically.

## Try it locally before Marketplace acceptance

While the plugin is awaiting Marketplace review, you can install it
directly from the repo. Cursor does **not** follow Windows
symlinks/junctions for plugin folders, so use a mirror copy on Windows
and a symlink elsewhere.

**Windows (PowerShell):**

```powershell
git clone https://github.com/mksglu/context-mode.git
cd context-mode
robocopy . "$env:USERPROFILE\.cursor\plugins\local\context-mode" /MIR `
  /XD node_modules .git build insight web tests scripts .vscode `
  /XF *.log .gitignore *.bundle.mjs.map
```

**macOS / Linux:**

```bash
git clone https://github.com/mksglu/context-mode.git
ln -s "$PWD/context-mode" ~/.cursor/plugins/local/context-mode
```

Restart Cursor and open **Settings → Plugins**. "Context Mode (Local)"
appears with 1 MCP server, 7 skills, and 5 hooks. To pull new commits,
re-run the same `robocopy` / `ln -s` line (`/MIR` handles updates).

## Verify

Run from a project shell:

```bash
npx context-mode doctor
```

Expected output includes:

- `Plugin install: pass`
- `MCP server registered: pass`
- `Hooks configured: 5/5`

If you previously installed context-mode manually (`.cursor/hooks.json` + `.cursor/mcp.json`), doctor will warn about duplicate hook registrations. Remove the matching entries from `.cursor/hooks.json` to silence the warning.

## Tools available to the agent

| Tool | Purpose |
|------|---------|
| `ctx_execute` | Run code in any of 11 languages, return only stdout |
| `ctx_execute_file` | Same, but read input from a workspace file path |
| `ctx_batch_execute` | Run multiple commands in one call, auto-index outputs |
| `ctx_index` | Store text in FTS5 with a label |
| `ctx_search` | BM25 search across the knowledge base |
| `ctx_fetch_and_index` | Fetch a URL, strip HTML, index the result |
| `ctx_stats` | Knowledge base size, hits, top sources |
| `ctx_doctor` | Diagnose runtime + hook health |
| `ctx_upgrade` | Apply pending fixes |
| `ctx_purge` | Clear knowledge base |
| `ctx_insight` | Dashboard server |

## Hooks

The plugin's `hooks/cursor/hooks.json` registers five events:

| Event | Behaviour |
|-------|-----------|
| `preToolUse` | Matches `Shell\|Read\|Grep\|WebFetch\|Task\|MCP:ctx_*` and emits routing guidance to keep heavy I/O in the sandbox |
| `postToolUse` | Persists tool input/output into the session DB for resume |
| `sessionStart` | Injects routing rules + resumes the prior session if `source=resume`/`compact` |
| `afterAgentResponse` | Captures the produced assistant text into session telemetry |
| `stop` | Records turn lifecycle (status, loop_count) |

Each event runs `npx -y context-mode hook cursor <event>`. Cold start is ~4-5s; trade-off for zero-install distribution.

## Known limitations

- **`additional_context` not surfaced** — Cursor's hook payload accepts `additional_context` but does not currently inject it into the model's context (forum [#155689](https://forum.cursor.com/t/native-posttooluse-hooks-accept-and-log-additional-context-successfully-but-the-injected-context-is-not-surfaced-to-the-model/155689), [#156157](https://forum.cursor.com/t/cursor-hooks-additional-context-not-injected-in-agent-context-in-posttooluse/156157)). The `.mdc` rule file is the primary routing channel until Cursor fixes this upstream.
- **No `${PLUGIN_ROOT}` env var** — Cursor manifests cannot reference the plugin install dir, so the MCP server still requires `npm` or `npx` on `PATH`. Documented in the project's [platform-support.md](https://github.com/mksglu/context-mode/blob/next/docs/platform-support.md).

## Links

- Project repo: <https://github.com/mksglu/context-mode>
- Full documentation: <https://github.com/mksglu/context-mode#readme>
- Issue tracker: <https://github.com/mksglu/context-mode/issues>
- License: Elastic-2.0
