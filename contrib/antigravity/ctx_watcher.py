"""
ctx_watcher.py — Conversation Log Watcher for Antigravity

Monitors the Antigravity conversation protobuf file for changes.
When the file grows (new turns/tool calls), triggers event extraction
from the daemon log.

This is the closest thing to PostToolUse hooks we can get without
Antigravity exposing a hook API.

Usage:
  python ctx_watcher.py --watch         # Watch current conversation
  python ctx_watcher.py --scan-daemon   # Scan daemon log for events
  python ctx_watcher.py --report        # One-shot report on conversation files
"""

import os
import sys
import json
import time
import re
import argparse
from pathlib import Path
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from session_db import SessionDB
from event_extract import SessionEvent


# ── Constants ────────────────────────────────────────────────────────────────

CONVERSATIONS_DIR = Path.home() / ".gemini" / "antigravity" / "conversations"
DAEMON_DIR = Path.home() / ".gemini" / "antigravity" / "daemon"
DEFAULT_PROJECT = r"."


# ── Daemon log parser ────────────────────────────────────────────────────────

# Patterns extracted from the daemon log format:
# I0225 23:05:52.329695 247684 server.go:1130] Starting language server process with pid 247684
# E0225 23:07:54.079546 247684 log.go:380] failed to check terminal shell support
# I0225 23:25:34.816539 247684 planner_generator.go:288] Requesting planner with 253 chat messages

LOG_PATTERNS = {
    "planner_request": re.compile(
        r"planner_generator\.go:\d+\] Requesting planner with (\d+) chat messages "
        r"at model retry attempt (\d+) and API retry attempt (\d+)"
    ),
    "api_trace": re.compile(
        r"http_helpers\.go:\d+\] URL: (\S+) Trace: (\S+)"
    ),
    "error": re.compile(
        r"^[EW]\d+ [\d:.]+\s+\d+\s+\S+\] (.+)",
    ),
    "cascade_error": re.compile(
        r"error executing cascade step: (\S+): (.+)"
    ),
    "unavailable": re.compile(
        r"UNAVAILABLE.*No capacity available for model (\S+)"
    ),
    "code_edit_ack": re.compile(
        r"AcknowledgeCascadeCodeEdit.*file:///(.+)"
    ),
    "compact_detected": re.compile(
        r"Requesting planner with (\d+) chat messages.*after.*(\d+) chat messages"
    ),
}


def parse_daemon_log(log_path: str, since_line: int = 0) -> list[dict]:
    """
    Parse the Antigravity daemon log for interesting events.
    Returns a list of extracted event dicts.
    """
    events = []

    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except Exception:
        return events

    prev_msg_count = None

    for i, line in enumerate(lines[since_line:], start=since_line):
        line = line.strip()
        if not line:
            continue

        # Planner requests — track message count changes
        m = LOG_PATTERNS["planner_request"].search(line)
        if m:
            msg_count = int(m.group(1))
            retry_model = int(m.group(2))
            retry_api = int(m.group(3))

            # Detect compaction (message count drops significantly)
            if prev_msg_count and msg_count < prev_msg_count - 10:
                events.append({
                    "type": "compaction",
                    "category": "env",
                    "data": f"Compacted: {prev_msg_count} → {msg_count} messages",
                    "priority": 1,
                    "line": i,
                })

            # Detect API retries
            if retry_api > 1:
                events.append({
                    "type": "api_retry",
                    "category": "error",
                    "data": f"API retry #{retry_api} at {msg_count} messages",
                    "priority": 2,
                    "line": i,
                })

            prev_msg_count = msg_count
            continue

        # Model unavailable
        m = LOG_PATTERNS["unavailable"].search(line)
        if m:
            model = m.group(1)
            events.append({
                "type": "model_unavailable",
                "category": "error",
                "data": f"No capacity: {model}",
                "priority": 2,
                "line": i,
            })
            continue

        # Code edit acknowledgment
        m = LOG_PATTERNS["code_edit_ack"].search(line)
        if m:
            filepath = m.group(1)
            events.append({
                "type": "file_edit",
                "category": "file",
                "data": filepath,
                "priority": 1,
                "line": i,
            })
            continue

        # Cascade errors
        m = LOG_PATTERNS["cascade_error"].search(line)
        if m:
            step_type = m.group(1)
            detail = m.group(2)[:200]
            events.append({
                "type": "error_cascade",
                "category": "error",
                "data": f"{step_type}: {detail}",
                "priority": 2,
                "line": i,
            })
            continue

    return events


def scan_daemon_log(project: str = DEFAULT_PROJECT, since_line: int = 0):
    """Scan daemon log and persist events to SessionDB."""
    log_files = list(DAEMON_DIR.glob("*.log"))
    if not log_files:
        print("No daemon log files found.")
        return

    latest_log = max(log_files, key=lambda f: f.stat().st_mtime)
    print(f"Scanning: {latest_log.name}")

    events = parse_daemon_log(str(latest_log), since_line)

    if not events:
        print("No new events found in daemon log.")
        return

    db = SessionDB(project)
    inserted = 0
    for ev in events:
        if db.add_event(ev["type"], ev["category"], ev["data"], ev["priority"]):
            inserted += 1

    print(f"Found {len(events)} events, {inserted} new (deduplicated)")

    # Show summary
    categories = {}
    for ev in events:
        cat = ev["category"]
        categories[cat] = categories.get(cat, 0) + 1

    for cat, count in sorted(categories.items(), key=lambda x: -x[1]):
        print(f"  {cat}: {count}")

    db.close()


# ── Conversation file monitor ────────────────────────────────────────────────

def get_conversation_report():
    """Generate a report on conversation files — sizes and recent changes."""
    if not CONVERSATIONS_DIR.exists():
        print("Conversations directory not found.")
        return

    pb_files = sorted(CONVERSATIONS_DIR.glob("*.pb"),
                      key=lambda f: f.stat().st_mtime, reverse=True)

    print(f"\n{'ID':>38s}  {'Size':>10s}  {'Modified':>20s}")
    print("─" * 72)

    total_size = 0
    for f in pb_files[:10]:  # Show latest 10
        size = f.stat().st_size
        mtime = datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
        conv_id = f.stem
        size_str = f"{size / 1024:.1f}KB" if size < 1048576 else f"{size / 1048576:.1f}MB"
        total_size += size
        print(f"  {conv_id}  {size_str:>10s}  {mtime}")

    print("─" * 72)
    print(f"  Total: {len(pb_files)} conversations, {total_size / 1048576:.1f}MB")
    print(f"  Largest: {max(pb_files, key=lambda f: f.stat().st_size).stem} "
          f"({max(f.stat().st_size for f in pb_files) / 1048576:.1f}MB)")


def watch_conversation(conversation_id: str = None, interval: float = 5.0):
    """
    Watch a conversation file for changes.
    Reports file size growth as an indicator of new tool calls.
    """
    if conversation_id:
        target = CONVERSATIONS_DIR / f"{conversation_id}.pb"
    else:
        # Find most recently modified
        pb_files = sorted(CONVERSATIONS_DIR.glob("*.pb"),
                         key=lambda f: f.stat().st_mtime, reverse=True)
        if not pb_files:
            print("No conversation files found.")
            return
        target = pb_files[0]

    print(f"Watching: {target.stem}")
    print(f"Initial size: {target.stat().st_size / 1024:.1f}KB")
    print(f"Polling every {interval}s (Ctrl+C to stop)\n")

    prev_size = target.stat().st_size
    prev_mtime = target.stat().st_mtime

    try:
        while True:
            time.sleep(interval)

            if not target.exists():
                print("⚠️  Conversation file deleted!")
                break

            stat = target.stat()
            if stat.st_mtime != prev_mtime:
                delta = stat.st_size - prev_size
                now = datetime.now().strftime("%H:%M:%S")

                if delta > 0:
                    print(f"  [{now}] +{delta / 1024:.1f}KB → {stat.st_size / 1024:.1f}KB total")
                elif delta < 0:
                    print(f"  [{now}] ⚠️  SHRUNK by {abs(delta) / 1024:.1f}KB → "
                          f"{stat.st_size / 1024:.1f}KB (compaction?)")

                prev_size = stat.st_size
                prev_mtime = stat.st_mtime

    except KeyboardInterrupt:
        print("\nStopped.")


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Antigravity Conversation Watcher")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--watch", nargs="?", const="auto", metavar="CONV_ID",
                      help="Watch a conversation file for changes")
    group.add_argument("--scan-daemon", action="store_true",
                      help="Scan daemon log for events")
    group.add_argument("--report", action="store_true",
                      help="Report on conversation files")

    parser.add_argument("--project", default=DEFAULT_PROJECT)
    parser.add_argument("--interval", type=float, default=5.0,
                       help="Watch poll interval in seconds")
    parser.add_argument("--since-line", type=int, default=0,
                       help="Start scanning daemon log from this line")

    args = parser.parse_args()

    if args.watch:
        conv_id = None if args.watch == "auto" else args.watch
        watch_conversation(conv_id, args.interval)
    elif args.scan_daemon:
        scan_daemon_log(args.project, args.since_line)
    elif args.report:
        get_conversation_report()


if __name__ == "__main__":
    main()
