---
description: Context-efficient workflow — reduces Antigravity context burn by 50-90%
---

# Context-Efficient Working Mode

// turbo-all

## Principle
Every byte that enters the context window costs Claude Opus tokens. Run analysis in subprocesses, return only summaries.

## Rules for Context Efficiency

### 1. File Reading
- **NEVER** read a full file with `view_file` unless it's the first read AND the file is < 200 lines
- **ALWAYS** use `StartLine/EndLine` on `view_file` to read targeted ranges
- **PREFER** `grep_search` first to find relevant line numbers, then `view_file` with ranges
- **FOR LARGE FILES** (> 200 lines): Use `python scripts/ctx_read.py <path> --structure` first to get an outline, then read targeted sections

### 2. Directory Listings
- **FOR SMALL DIRS** (< 20 items): Use `list_dir` normally
- **FOR LARGE DIRS**: Use `python scripts/ctx_dir.py <path> --depth 2` for compact output

### 3. Command Output
- **FOR EXPECTED LARGE OUTPUT**: Pipe through `python scripts/ctx_summary.py --max-lines 30`
  - Example: `npm test 2>&1 | python .\antigravity\skills\context_mode\ctx_summary.py -n 30`
- **FOR TARGETED OUTPUT**: Use `--intent` flag
  - Example: `git log -n 200 | python .\antigravity\skills\context_mode\ctx_summary.py -i "merge"`

### 4. Search Before Read
- Always `grep_search` before `view_file` to locate exact lines
- Use the grep results to determine `StartLine/EndLine` for the minimum necessary read
- This avoids reading 800 lines when you only need 20

### 5. Avoid Re-reads
- If a file's content is already in the conversation from a previous tool call, do NOT read it again
- Reference the existing content instead

### 6. Batch Operations
- When examining multiple aspects of the same file, use ONE `run_command` with `ctx_read.py` instead of multiple `view_file` calls
- Example: `python scripts/ctx_read.py src/server.ts --intent "security"` returns only security-related code

## Tool Selection Priority

| Need | Use This | NOT This |
|------|----------|----------|
| Find a function | `grep_search` | `view_file` (full file) |
| Understand file structure | `ctx_read.py --structure` | `view_file` (full file) |
| Read specific code section | `view_file` with StartLine/EndLine | `view_file` (no range) |
| Scan directory | `ctx_dir.py --depth 2` (large dirs) | `list_dir` (large dirs) |
| Check test results | `ctx_summary.py --intent "fail"` | Raw `run_command` output |
| Read log files | `ctx_read.py --intent "error"` | `view_file` (full file) |

## Script Locations
```
.\antigravity\skills\context_mode\ctx_read.py     -- Smart file reading
.\antigravity\skills\context_mode\ctx_dir.py      -- Compact directory listing
.\antigravity\skills\context_mode\ctx_summary.py  -- Pipe-friendly summarizer
```
