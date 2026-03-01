# Context Mode for opencode

Complete integration guide for using Context Mode with opencode AI agent.

## Overview

Context Mode is an MCP server that compresses tool outputs to save context window space. When integrated with opencode, it provides:

- **98% context reduction** - Tool outputs stay in sandbox, only summaries enter context
- **Sandboxed execution** - Code runs in isolated subprocesses (11 languages supported)
- **Knowledge base** - FTS5 full-text search with BM25 ranking
- **Batch operations** - Execute multiple commands and search in one call

## Installation

### Option 1: npm Package (Recommended)

Add to your project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "context-mode": {
      "type": "local",
      "command": ["npx", "-y", "github:mksglu/claude-context-mode"],
      "enabled": true,
      "timeout": 15000
    }
  }
}
```

**Pros:**
- No setup required
- Automatically updates
- Works in any project

**Cons:**
- Slight startup delay (npx resolution)

### Option 2: Global Install

Install globally for faster startup:

```bash
npm install -g context-mode
```

Then configure in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "context-mode": {
      "type": "local",
      "command": ["npx", "-y", "github:mksglu/claude-context-mode"],
      "enabled": true,
      "timeout": 15000
    }
  }
}
```

### Option 3: Local Development

Clone and run from source:

```bash
git clone https://github.com/mksglu/claude-context-mode.git
cd claude-context-mode
npm install
npm run build
```

Configure in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "context-mode": {
      "type": "local",
      "command": ["node", "/absolute/path/to/claude-context-mode/build/server.js"],
      "enabled": true,
      "timeout": 10000,
      "environment": {
        "NODE_ENV": "development"
      }
    }
  }
}
```

## Configuration Reference

### Required Fields

```json
{
  "type": "local",
      "command": ["npx", "-y", "github:mksglu/claude-context-mode"]
}
```

- `type`: Must be `"local"` for local MCP servers
- `command`: Array of command and arguments to start the server

### Optional Fields

```json
{
  "enabled": true,
  "timeout": 10000,
  "environment": {
    "CUSTOM_VAR": "value"
  }
}
```

- `enabled`: Enable/disable the server (default: `true`)
- `timeout`: Startup timeout in milliseconds (default: `5000`, recommended: `10000`)
- `environment`: Environment variables to pass to the server

### Environment Variables

Context Mode automatically detects opencode and sets:

- `OPENCODE_PROJECT_DIR`: Project root directory (set by opencode)
- `CLAUDE_PROJECT_DIR`: Aliased from OPENCODE_PROJECT_DIR for compatibility
- `PROJECT_DIR`: Normalized project directory

You can override these in the `environment` field if needed.

## Tools

After installation, Context Mode tools are available with the `context-mode_` prefix:

### context-mode_execute

Run code in a sandboxed subprocess. Only stdout enters context.

**Parameters:**
- `language`: Runtime language (`javascript`, `typescript`, `python`, `shell`, `ruby`, `go`, `rust`, `php`, `perl`, `r`, `elixir`)
- `code`: Source code to execute
- `timeout`: Max execution time in ms (default: 30000)
- `intent`: What you're looking for in the output (triggers intent-driven filtering)

**Example:**
```txt
Use context-mode_execute with language=python to fetch the top 20 Hacker News stories and group by domain.
```

### context-mode_execute_file

Read and process a file without loading raw content into context.

**Parameters:**
- `path`: File path (absolute or relative to project root)
- `language`: Runtime language for processing code
- `code`: Code to process FILE_CONTENT variable
- `timeout`: Max execution time in ms (default: 30000)
- `intent`: What you're looking for in the output

**Example:**
```txt
Use context-mode_execute_file with path=logs/app.log to find all HTTP 500 errors with timestamps.
```

### context-mode_batch_execute

Execute multiple commands and search queries in ONE call. **This is the primary tool for research tasks.**

**Parameters:**
- `commands`: Array of `{ label: string, command: string }`
- `queries`: Array of search queries (5-8 recommended)
- `timeout`: Max execution time in ms (default: 60000)

**Example:**
```txt
Use context-mode_batch_execute to:
1. Run `git log --oneline -200`
2. Run `cat package.json`
3. Run `find src -name "*.ts" | head -50`
Then search for: "recent commits", "dependencies", "source files", "test files", "configuration"
```

**Output includes:**
- Section inventory with sizes
- Search results with full content around matches
- Searchable terms for follow-up queries

### context-mode_index

Index markdown content into FTS5 knowledge base with BM25 ranking.

**Parameters:**
- `content`: Raw text/markdown to index (OR `path`)
- `path`: File path to read and index (OR `content`)
- `source`: Label for the indexed content

**Example:**
```txt
Use context-mode_index with the React docs you just fetched, source="React useEffect docs".
```

### context-mode_search

Search indexed content with multiple queries.

**Parameters:**
- `queries`: Array of search queries (batch all questions in one call)
- `limit`: Results per query (default: 3)
- `source`: Filter to specific indexed source (optional)

**Example:**
```txt
Use context-mode_search with queries=["useEffect cleanup", "memory leak prevention", "return function"].
```

**Features:**
- Three-layer fallback: Porter stemming → Trigram → Fuzzy correction
- Smart snippets: Returns windows around matches, not arbitrary truncation
- Progressive throttling: Encourages batching to prevent context flooding

### context-mode_fetch_and_index

Fetch URL, convert HTML to markdown, index into knowledge base.

**Parameters:**
- `url`: URL to fetch
- `source`: Label for the indexed content (optional, defaults to URL)

**Example:**
```txt
Use context-mode_fetch_and_index with url=https://react.dev/reference/react/useEffect, source="React useEffect".
```

**Output includes:**
- Section count and total KB
- ~3KB preview for immediate use
- Full content indexed for search

### context-mode_stats

Show context consumption statistics for the current session.

**Parameters:** None

**Output includes:**
- Session duration and tool call count
- Total data processed vs. entered context
- Context savings ratio and percentage
- Per-tool breakdown with bytes and tokens

**Example:**
```txt
Use context-mode_stats to show how much context we've saved.
```

## Usage Patterns

### Pattern 1: Deep Repository Research

**Goal:** Understand a codebase without flooding context.

```txt
Use context-mode_batch_execute to research this repository:

Commands:
1. `cat README.md`
2. `cat package.json`
3. `find src -type f -name "*.ts" | head -30`
4. `git log --oneline -100`
5. `ls -la`

Queries:
- "project purpose and description"
- "main dependencies and versions"
- "source file structure and organization"
- "recent commit patterns and contributors"
- "configuration files and setup"
```

**Result:** ~60KB context instead of ~1MB raw output.

### Pattern 2: Log File Analysis

**Goal:** Find specific errors in large log files.

```txt
Use context-mode_execute_file with path=logs/production.log:

language: python
code: |
  import re
  from collections import Counter
  
  errors = re.findall(r'ERROR.*?(?=ERROR|$)', FILE_CONTENT, re.DOTALL)
  print(f"Found {len(errors)} errors")
  
  # Group by error type
  types = Counter(re.search(r'ERROR\s+(\w+)', e).group(1) for e in errors if re.search(r'ERROR\s+(\w+)', e))
  print("\nTop error types:")
  for t, c in types.most_common(10):
      print(f"  {t}: {c}")
  
  intent: "error types and frequencies"
```

**Result:** Summary enters context, raw logs stay in sandbox.

### Pattern 3: Documentation Search

**Goal:** Find specific patterns in framework docs.

```txt
Use context-mode_fetch_and_index:
url: https://react.dev/reference/react/useEffect
source: "React useEffect docs"

Then use context-mode_search:
queries:
  - "cleanup function return"
  - "memory leak prevention"
  - "event listener removal"
  - "fetch abort controller"
  - "interval clear example"
```

**Result:** Precise code examples without loading entire docs.

### Pattern 4: API Data Processing

**Goal:** Fetch and analyze large API responses.

```txt
Use context-mode_execute with language=typescript:

const resp = await fetch("https://api.github.com/repos/facebook/react/issues?state=open&per_page=100");
const issues = await resp.json();

console.log(`Fetched ${issues.length} issues`);

// Group by labels
const byLabel = new Map();
for (const issue of issues) {
  for (const label of issue.labels || []) {
    const name = label.name || "uncategorized";
    if (!byLabel.has(name)) byLabel.set(name, []);
    byLabel.get(name).push(issue);
  }
}

console.log("\nIssues by label:");
for (const [label, list] of byLabel.entries()) {
  console.log(`  ${label}: ${list.length}`);
}

intent: "issue categories and counts"
```

**Result:** Categorized summary, raw JSON stays in sandbox.

## Best Practices

### DO:

1. **Use `batch_execute` for research** - One call replaces 30+ individual calls
2. **Provide specific `intent`** - Triggers intelligent filtering for large outputs
3. **Batch search queries** - `search(queries: ["q1", "q2", "q3"])` not individual calls
4. **Use `execute_file` for large files** - Never cat/read files >20 lines directly
5. **Check `stats` regularly** - Monitor context consumption

### DON'T:

1. **Don't make individual `search` calls** - Progressive throttling will block after 8 calls
2. **Don't use bash for data fetching** - Use `execute` for any command with large output
3. **Don't read files directly** - Use `execute_file` to process in sandbox
4. **Don't fetch URLs manually** - Use `fetch_and_index` for automatic processing

## Troubleshooting

### Server Not Starting

**Error:** `MCP server failed to start`

**Solutions:**
1. Increase timeout: `"timeout": 15000`
2. Check Node.js version: `node --version` (requires 18+)
3. Install dependencies: `npm install` in context-mode directory
4. Check logs: Look for stderr output in opencode console

### Tools Not Appearing

**Problem:** Context Mode installed but tools not available

**Solutions:**
1. Restart opencode completely
2. Check opencode.json syntax (use JSONC for comments)
3. Verify MCP status: Check opencode's MCP server list
4. Try npx manually: `npx -y context-mode` to test

### Context Still Flooding

**Problem:** Tool outputs still entering context raw

**Solutions:**
1. **You're not using Context Mode tools** - Explicitly call `context-mode_execute` etc.
2. **Output is small** - Context Mode only filters outputs >5KB with intent
3. **Intent not provided** - Add `intent` parameter for large outputs
4. **Using bash instead of execute** - Switch to `context-mode_execute`

### Search Not Finding Results

**Problem:** `search` returns no results for indexed content

**Solutions:**
1. **Check source name** - Use exact `source` field value
2. **Try different queries** - Use technical terms from the content
3. **Check indexed sections** - Look at section inventory in batch_execute output
4. **Use searchable terms** - batch_execute returns vocabulary for follow-up

## Performance Tips

### Execution Speed

- **Bun detected**: JS/TS runs 3-5x faster
- **Install Bun**: `curl -fsSL https://bun.sh/install | bash`
- **Timeout tuning**: Set appropriate timeout per task (30s default)

### Context Efficiency

- **batch_execute**: 986KB → 62KB (94% saved)
- **execute**: 56KB → 299B (99% saved)
- **fetch_and_index**: 60KB → 40B + searchable (99% saved)

### Memory Usage

- **Hard cap**: 100MB max output per execution
- **Smart truncation**: Head (60%) + tail (40%) preserves context and errors
- **Process cleanup**: Subprocesses killed on timeout/exit

## Comparison: Claude Code vs opencode

| Feature | Claude Code | opencode |
|---------|-------------|----------|
| Installation | Plugin marketplace | opencode.json config |
| Hooks | PreToolUse auto-routing | Manual tool selection |
| Slash commands | `/context-mode:stats` | `context-mode_stats` tool |
| Environment | `CLAUDE_PROJECT_DIR` | `OPENCODE_PROJECT_DIR` |
| MCP config | `.mcp.json` | `opencode.json` |

## Advanced Configuration

### Custom Environment Variables

```json
{
  "mcp": {
    "context-mode": {
      "type": "local",
      "command": ["npx", "-y", "github:mksglu/claude-context-mode"]
      "environment": {
        "CUSTOM_API_KEY": "your-key-here",
        "DEBUG": "context-mode:*"
      }
      "timeout": 15000
  }
}
```

### Multiple MCP Servers

```json
{
  "mcp": {
    "context-mode": {
      "type": "local",
      "command": ["npx", "-y", "github:mksglu/claude-context-mode"]
      "enabled": true
      "timeout": 15000
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "enabled": true
    }
  }
}
```

### Per-Agent Tool Access

```json
{
  "mcp": {
    "context-mode": {
      "type": "local",
      "command": ["npx", "-y", "github:mksglu/claude-context-mode"]
      "enabled": true
      "timeout": 15000
  },
  "tools": {
    "context-mode_*": false
  },
  "agent": {
    "researcher": {
      "tools": {
        "context-mode_*": true
      }
    }
  }
}
```

## Support

- **GitHub Issues**: https://github.com/mksglu/claude-context-mode/issues
- **npm Package**: https://www.npmjs.com/package/context-mode
- **Documentation**: https://github.com/mksglu/claude-context-mode#readme

## License

MIT License - See LICENSE file for details.
