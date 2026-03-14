"""
ctx_session.py — Session Continuity Manager for Antigravity

Provides session restore, compaction recovery, and KI auto-generation.
This is the bridge between the event tracking system and Antigravity's
native KI/artifact storage.

Usage:
  python ctx_session.py restore          # Restore from latest snapshot
  python ctx_session.py save             # Save current session snapshot
  python ctx_session.py generate-ki      # Generate a KI artifact from session
  python ctx_session.py detect-compact   # Check if compaction occurred
  python ctx_session.py handoff          # Generate a handoff document for new conversations
"""

import os
import sys
import json
import time
import hashlib
import argparse
from pathlib import Path
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from session_db import SessionDB
from snapshot_builder import build_snapshot, build_session_guide


# ── Constants ────────────────────────────────────────────────────────────────

DEFAULT_PROJECT = r"."
CONVERSATIONS_DIR = Path.home() / ".gemini" / "antigravity" / "conversations"
BRAIN_DIR = Path.home() / ".gemini" / "antigravity" / "brain"
SESSION_FILE = Path.home() / ".antigravity" / "context-mode" / "current_session.json"


def _get_session() -> dict:
    """Get current session info."""
    if SESSION_FILE.exists():
        try:
            with open(SESSION_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {"session_id": "unknown", "started": 0, "project": DEFAULT_PROJECT}


def _get_db(project: str = None) -> SessionDB:
    """Get SessionDB with current session."""
    session = _get_session()
    return SessionDB(
        project or session.get("project", DEFAULT_PROJECT),
        session_id=session["session_id"],
    )


# ── Compaction Detection ─────────────────────────────────────────────────────

def detect_compaction(conversation_id: str = None) -> dict:
    """
    Detect if a conversation was compacted by checking:
    1. Conversation .pb file size decreased
    2. Daemon log shows message count drop
    
    Returns dict with detection results.
    """
    result = {
        "compacted": False,
        "conversation_id": conversation_id,
        "evidence": [],
    }

    if not conversation_id:
        # Find most recently modified conversation
        pb_files = sorted(CONVERSATIONS_DIR.glob("*.pb"),
                         key=lambda f: f.stat().st_mtime, reverse=True)
        if pb_files:
            conversation_id = pb_files[0].stem
            result["conversation_id"] = conversation_id

    if not conversation_id:
        result["evidence"].append("No conversation files found")
        return result

    # Check conversation file
    pb_path = CONVERSATIONS_DIR / f"{conversation_id}.pb"
    if pb_path.exists():
        size_kb = pb_path.stat().st_size / 1024
        result["current_size_kb"] = round(size_kb, 1)

    # Check daemon log for compaction events
    daemon_dir = Path.home() / ".gemini" / "antigravity" / "daemon"
    log_files = list(daemon_dir.glob("*.log"))
    if log_files:
        import re
        latest_log = max(log_files, key=lambda f: f.stat().st_mtime)
        try:
            with open(latest_log, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()

            # Look for message count drops
            pattern = re.compile(
                r"planner_generator\.go:\d+\] Requesting planner with (\d+) chat messages"
            )
            msg_counts = []
            for line in lines[-200:]:  # Check last 200 lines
                m = pattern.search(line)
                if m:
                    msg_counts.append(int(m.group(1)))

            if len(msg_counts) >= 2:
                for i in range(1, len(msg_counts)):
                    if msg_counts[i] < msg_counts[i-1] - 10:
                        result["compacted"] = True
                        result["evidence"].append(
                            f"Message count dropped: {msg_counts[i-1]} → {msg_counts[i]}"
                        )
        except Exception as e:
            result["evidence"].append(f"Log parse error: {e}")

    # Check session DB for stored compaction events
    db = _get_db()
    events = db.get_events(category="env")
    for ev in events:
        if "compacted" in ev["data"].lower() or "compact" in ev["data"].lower():
            result["compacted"] = True
            result["evidence"].append(f"DB event: {ev['data']}")
    db.close()

    return result


# ── Session Restore ──────────────────────────────────────────────────────────

def restore_session(project: str = DEFAULT_PROJECT) -> str:
    """
    Restore the last session state.
    Returns the restore content (snapshot or session guide).
    """
    db = _get_db(project)

    # Try stored snapshot first
    snapshot = db.get_latest_snapshot()
    if snapshot:
        db.close()
        return snapshot["snapshot"]

    # Fall back to building from events
    events = db.get_events()
    if events:
        guide = build_session_guide(events)
        db.close()
        return guide

    db.close()
    return "No session data found. Starting fresh."


def save_session(project: str = DEFAULT_PROJECT) -> str:
    """Save current session snapshot to DB."""
    db = _get_db(project)
    events = db.get_events()

    if not events:
        db.close()
        return "No events to save."

    # Build and save snapshot
    snapshot = build_snapshot(events)
    compact_count = 1

    # Check if there's a previous snapshot
    prev = db.get_latest_snapshot()
    if prev:
        compact_count = prev["compact_count"] + 1

    db.save_snapshot(snapshot, compact_count)
    db.close()

    return f"Snapshot saved (compact #{compact_count}, {len(events)} events, {len(snapshot)} bytes)"


# ── KI Generation ────────────────────────────────────────────────────────────

def generate_session_ki(
    project: str = DEFAULT_PROJECT,
    conversation_id: str = None,
    output_dir: str = None,
) -> str:
    """
    Generate a session KI artifact from the current session's events.
    
    This creates a markdown file that can be used as a KI artifact
    for cross-conversation memory.
    """
    db = _get_db(project)
    events = db.get_events()
    stats = db.get_stats()

    if not events:
        db.close()
        return "No events to generate KI from."

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    session_id = stats["session_id"]

    # Build the full session guide
    guide = build_session_guide(events)

    # Add KI-specific metadata header
    ki_content = f"""---
title: "Session: {session_id}"
type: session_ki
generated: "{now}"
conversation_id: "{conversation_id or 'unknown'}"
project: "{project}"
event_count: {len(events)}
categories: {json.dumps(stats.get('categories', {}))}
---

{guide}

---

## Session Statistics

| Metric | Value |
|--------|-------|
| Session ID | `{session_id}` |
| Events | {len(events)} |
| Started | {stats.get('started_at', 'N/A')} |
| Last Event | {stats.get('last_event_at', 'N/A')} |

### Category Breakdown
"""

    for cat, count in sorted(
        stats.get("categories", {}).items(),
        key=lambda x: -x[1]
    ):
        ki_content += f"- **{cat}**: {count} events\n"

    # Determine output path
    if output_dir:
        out_dir = Path(output_dir)
    elif conversation_id:
        out_dir = BRAIN_DIR / conversation_id
    else:
        out_dir = Path(project) / "antigravity" / "skills" / "context_mode"

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"session_ki_{session_id}.md"

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(ki_content)

    db.close()
    return f"KI generated: {out_path} ({len(ki_content)} bytes, {len(events)} events)"


# ── Handoff Document ─────────────────────────────────────────────────────────

def generate_handoff(project: str = DEFAULT_PROJECT) -> str:
    """
    Generate a handoff document for continuing work in a new conversation.
    This is optimized for pasting into a new Antigravity session.
    
    Returns the handoff content as a string.
    """
    db = _get_db(project)
    events = db.get_events()
    stats = db.get_stats()

    if not events:
        db.close()
        return "No session data for handoff."

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Build compact snapshot
    snapshot = build_snapshot(events, max_bytes=1500)

    # Build handoff
    handoff = f"""# Session Handoff ({now})

## Quick Context
{snapshot}

## What to Do Next
1. Read the session snapshot above for context on files, decisions, and errors
2. Check `ctx_doctor.py` if anything seems broken
3. Use `ctx_instrument.py dash` to see the current session state
4. Continue from where we left off

## Key Commands
```bash
# Check system health
python .\\antigravity\\skills\\context_mode\\ctx_doctor.py

# View session state
python .\\antigravity\\skills\\context_mode\\ctx_instrument.py dash

# Build fresh snapshot
python .\\antigravity\\skills\\context_mode\\ctx_instrument.py snapshot --full

# Scan daemon log for events
python .\\antigravity\\skills\\context_mode\\ctx_watcher.py --scan-daemon
```
"""

    db.close()
    return handoff


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Antigravity Session Continuity Manager")
    parser.add_argument("--project", default=DEFAULT_PROJECT)

    sub = parser.add_subparsers(dest="command", help="Commands")

    # restore
    sub.add_parser("restore", help="Restore from latest snapshot")

    # save
    sub.add_parser("save", help="Save current session snapshot")

    # generate-ki
    p_ki = sub.add_parser("generate-ki", help="Generate session KI artifact")
    p_ki.add_argument("--conversation-id", help="Conversation ID")
    p_ki.add_argument("--output-dir", help="Output directory for KI file")

    # detect-compact
    p_compact = sub.add_parser("detect-compact", help="Detect compaction")
    p_compact.add_argument("--conversation-id", help="Conversation ID to check")

    # handoff
    sub.add_parser("handoff", help="Generate handoff document for new conversations")

    args = parser.parse_args()

    if args.command == "restore":
        content = restore_session(args.project)
        print(content)

    elif args.command == "save":
        result = save_session(args.project)
        print(result)

    elif args.command == "generate-ki":
        result = generate_session_ki(
            args.project,
            getattr(args, "conversation_id", None),
            getattr(args, "output_dir", None),
        )
        print(result)

    elif args.command == "detect-compact":
        result = detect_compaction(getattr(args, "conversation_id", None))
        print(json.dumps(result, indent=2))

    elif args.command == "handoff":
        content = generate_handoff(args.project)
        print(content)

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
