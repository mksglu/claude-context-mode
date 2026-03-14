---
name: context-mode-antigravity
description: Context-efficient working mode for Antigravity — reduces context burn by 50-90% through pre-processing scripts and disciplined tool usage patterns.
---

# Context Mode for Antigravity

## Overview

This skill provides context-saving tools adapted from [context-mode](https://github.com/mksglu/context-mode) for use within Antigravity (Google DeepMind's agentic IDE). Since Antigravity lacks MCP hook support, enforcement is manual — the agent must actively choose to use these tools instead of raw tool calls.

## Tools

### ctx_read.py — Smart File Reading

Reads a file and returns a compressed summary instead of the full content.

```bash
# Show code structure only (classes, functions, imports)
python ctx_read.py <file_path> --structure

# Filter by intent — returns only matching lines with context
python ctx_read.py <file_path> --intent "security checks"

# Read a specific line range
python ctx_read.py <file_path> --range "100-150"

# Truncated view (default 50 lines, head 60% + tail 40%)
python ctx_read.py <file_path> --lines 30
```

### ctx_dir.py — Compact Directory Listing

Returns a compact tree with file sizes and optional line counts.

```bash
# Compact tree with depth limit
python ctx_dir.py <directory> --depth 2

# Filter by file type + show line counts
python ctx_dir.py <directory> --filter "*.ts" --stats
```

### ctx_summary.py — Pipe-Friendly Summarizer

Reads text from stdin or a file and returns a compressed version with key pattern extraction (errors, warnings, test results).

```bash
# Pipe any command output
npm test 2>&1 | python ctx_summary.py --max-lines 30

# Filter for specific content
git log -n 200 | python ctx_summary.py --intent "merge"

# Stats only (error/warning counts, test pass/fail)
cat build.log | python ctx_summary.py --stats-only
```

## Usage Rules

1. **NEVER** read a full file with `view_file` unless it's the first read AND < 200 lines
2. **ALWAYS** use `StartLine/EndLine` on `view_file` for targeted ranges
3. **PREFER** `grep_search` first to find line numbers, then `view_file` with ranges
4. **FOR LARGE FILES** (> 200 lines): Use `ctx_read.py --structure` first
5. **FOR LARGE OUTPUT**: Pipe through `ctx_summary.py`
6. **AVOID RE-READS**: If content is already in conversation, don't read again

## Phase 2: Hook System Components

### session_db.py — SQLite Event Store

Persistent session event storage with WAL mode, dedup by content hash, and priority tiers.

```python
from session_db import SessionDB

db = SessionDB("/path/to/project", session_id="my-session")
db.add_event("file_read", "file", "src/server.ts", priority=1)
stats = db.get_stats()  # Returns event counts, categories
db.close()
```

### event_extract.py — Tool Call Event Extractors

Maps Antigravity tool calls to context-mode's 13 event categories.

```python
from event_extract import extract_events, extract_user_events

# Extract from tool call
events = extract_events("run_command", {"CommandLine": "git commit -m fix"}, "")
# Returns: [SessionEvent("git", "git", "commit", priority=2)]

# Extract from user message
events = extract_user_events("don't use pandas, prefer polars")
# Returns: [SessionEvent("decision", "decision", "don't use...", priority=2)]
```

### snapshot_builder.py — Priority-Tiered Snapshots

Builds budget-constrained (2KB) session snapshots for continuity.

```python
from snapshot_builder import build_snapshot, build_session_guide

events = db.get_events()
snapshot = build_snapshot(events, max_bytes=2048)  # Compact version
guide = build_session_guide(events)                 # Full version for KI
```

### ctx_stats.py — Context Usage Tracker

Tracks raw bytes vs. compressed bytes and generates savings reports.

```python
from ctx_stats import ContextTracker

tracker = ContextTracker()
tracker.record("view_file", raw_bytes=66000, context_bytes=6800, description="via ctx_read")
print(tracker.format_report())  # Shows per-tool savings
```

## File Locations

All scripts are in this directory:
- `ctx_read.py` — Smart file reading (Phase 1)
- `ctx_dir.py` — Compact directory listing (Phase 1)
- `ctx_summary.py` — Pipe-friendly summarizer (Phase 1)
- `session_db.py` — SQLite event store (Phase 2)
- `event_extract.py` — Tool call event extractors (Phase 2)
- `snapshot_builder.py` — Priority-tiered snapshot builder (Phase 2)
- `ctx_stats.py` — Context usage tracker (Phase 2)

## Database Location

- `~/.antigravity/context-mode/sessions/<project_hash>.db`
- `~/.antigravity/context-mode/current_session.json`

## Phase 3: Automatic Enforcement Components

### ctx_instrument.py — Self-Instrumentation Wrapper

Manual PreToolUse/PostToolUse hooks. The agent calls this via `run_command`.

```bash
# Log before a tool call
python ctx_instrument.py pre view_file '{"AbsolutePath":"src/server.ts"}'

# Log after a tool call (with savings tracking)
python ctx_instrument.py post run_command '{"CommandLine":"npm test"}' --output-size 15000 --context-size 1500

# Show session dashboard
python ctx_instrument.py dash

# Build snapshot
python ctx_instrument.py snapshot

# Reset session
python ctx_instrument.py reset
```

### ctx_doctor.py — Health Diagnostics

Checks all components: Python, SQLite, scripts, database, workflow, daemon, conversation storage.

```bash
python ctx_doctor.py           # Run all 11 checks
python ctx_doctor.py --json     # JSON output
```

### ctx_watcher.py — Conversation Log Watcher

Monitors Antigravity's daemon log and conversation files.

```bash
# Scan daemon log for events (compaction, errors, file edits)
python ctx_watcher.py --scan-daemon

# Report on conversation files (sizes, recent activity)
python ctx_watcher.py --report

# Live-watch a conversation file for changes
python ctx_watcher.py --watch
```

## Phase 4: Session Continuity Components

### ctx_session.py — Session Continuity Manager

Manages session snapshots, compaction recovery, KI generation, and handoffs.

```bash
# Save current session snapshot
python ctx_session.py save

# Restore from latest snapshot
python ctx_session.py restore

# Detect if conversation was compacted
python ctx_session.py detect-compact

# Generate KI artifact from session events
python ctx_session.py generate-ki

# Generate handoff document for new conversations
python ctx_session.py handoff
```

### AGENTS.md Optimization

Compressed from 4,424 bytes to 2,930 bytes by removing the Multi-Model Architecture section
that Antigravity cannot act on. **Saves ~1,494 bytes per turn.**
