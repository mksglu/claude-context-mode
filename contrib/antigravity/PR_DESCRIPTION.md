# feat: add Antigravity support via self-instrumentation

## Type of Change
- [x] New feature (non-breaking change which adds functionality)
- [x] Documentation update

## Description
This PR introduces support for **Antigravity** (Google DeepMind's agentic IDE) to the `context-mode` ecosystem.

### The Challenge
Antigravity is a standalone Electron-based environment that currently lacks a public plugin API or MCP hook infrastructure. Traditional automatic hooks (PostToolUse, PreCompact, etc.) cannot be injected into the daemon process.

### The Solution: Self-Instrumentation
We've implemented a **"Manual Hook"** architecture where the AI agent proactively instruments itself. The agent calls a set of Python-based utility scripts via its native `run_command` tool to:
1.  **Summarize context** before tool usage (e.g., smart file reading, directory listing).
2.  **Log structured events** to a persistent SQLite SessionDB (WAL mode).
3.  **Perform compaction recovery** by detecting daemon-level message count drops and restoring state from snapshots.

### New Components (in `contrib/antigravity`)
- `ctx_read.py` / `ctx_dir.py` / `ctx_summary.py`: Context-efficient pre-processors.
- `session_db.py` / `event_extract.py`: SQLite event store and tool-to-category mapping.
- `snapshot_builder.py` / `ctx_session.py`: Continuity management and snapshot generation.
- `ctx_instrument.py`: The unified entry point for "manual hooks".
- `ctx_doctor.py`: Comprehensive healthy-check utility.
- `SKILL.md`: Documentation for the agent on how to use these tools.

## Testing
- Tested in Antigravity version 1.19.4.
- Verified 11/11 health checks pass.
- Measured 50-90% context savings for large file reads and command outputs.
- Verified session continuity after conversation compaction.

## Checklist
- [x] I have scrubbed all local absolute paths and sensitive data.
- [x] I have followed the architectural patterns of `context-mode`.
- [x] Documentation has been updated.
- [x] All Python scripts are compatible with Python 3.10+.
