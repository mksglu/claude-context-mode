"""
ctx_instrument.py — Self-Instrumentation Wrapper for Antigravity

Since Antigravity has no hook infrastructure, this script provides
"manual hooks" that the agent can call to log its own tool usage.

Usage patterns:
  1. BEFORE a tool call:  python ctx_instrument.py pre <tool_name> <json_input>
  2. AFTER a tool call:   python ctx_instrument.py post <tool_name> <json_input> [--output-size N]
  3. SESSION STATS:       python ctx_instrument.py stats
  4. BUILD SNAPSHOT:      python ctx_instrument.py snapshot
  5. DASHBOARD:           python ctx_instrument.py dash

This enables the agent to self-instrument without any external hooks.
The agent calls this script via run_command at key moments in its workflow.
"""

import sys
import os
import json
import time
import argparse

# Add this directory to path for local imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from session_db import SessionDB
from event_extract import extract_events, extract_user_events
from snapshot_builder import build_snapshot, build_session_guide
from ctx_stats import ContextTracker


# ── Globals ──────────────────────────────────────────────────────────────────

# Default project directory
DEFAULT_PROJECT = r"."

# Session ID file — persists across invocations
SESSION_FILE = os.path.join(
    os.path.expanduser("~"), ".antigravity", "context-mode", "current_session.json"
)


def _get_session() -> dict:
    """Get or create a persistent session ID."""
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE) as f:
                data = json.load(f)
            # Reuse if < 4 hours old
            if time.time() - data.get("started", 0) < 4 * 3600:
                return data
        except Exception:
            pass

    # Create new session
    import hashlib
    session_id = hashlib.sha256(f"{time.time()}".encode()).hexdigest()[:12]
    data = {
        "session_id": session_id,
        "started": time.time(),
        "project": DEFAULT_PROJECT,
    }
    os.makedirs(os.path.dirname(SESSION_FILE), exist_ok=True)
    with open(SESSION_FILE, "w") as f:
        json.dump(data, f)
    return data


def _get_db(project: str = None) -> SessionDB:
    """Get a SessionDB with persistent session ID."""
    session = _get_session()
    return SessionDB(
        project or session.get("project", DEFAULT_PROJECT),
        session_id=session["session_id"],
    )


# ── Commands ─────────────────────────────────────────────────────────────────

def cmd_pre(args):
    """Log a pre-tool-use event. Used before making a tool call."""
    tool_name = args.tool
    try:
        tool_input = json.loads(args.input) if args.input else {}
    except json.JSONDecodeError:
        tool_input = {"raw": args.input}

    db = _get_db(args.project)
    events = extract_events(tool_name, tool_input)

    inserted = 0
    for ev in events:
        if db.add_event(ev.type, ev.category, ev.data, ev.priority):
            inserted += 1

    print(f"pre:{tool_name} → {inserted} events recorded")
    db.close()


def cmd_post(args):
    """Log a post-tool-use event. Used after a tool call completes."""
    tool_name = args.tool
    try:
        tool_input = json.loads(args.input) if args.input else {}
    except json.JSONDecodeError:
        tool_input = {"raw": args.input}

    output_snippet = args.output_snippet or ""

    db = _get_db(args.project)
    events = extract_events(tool_name, tool_input, output_snippet)

    inserted = 0
    for ev in events:
        if db.add_event(ev.type, ev.category, ev.data, ev.priority):
            inserted += 1

    # Track context savings if output_size provided
    if args.output_size and args.context_size:
        raw = int(args.output_size)
        ctx = int(args.context_size)
        saved_pct = round((1 - ctx / max(raw, 1)) * 100, 1)
        print(f"post:{tool_name} → {inserted} events, saved {saved_pct}% ({raw}→{ctx} bytes)")
    else:
        print(f"post:{tool_name} → {inserted} events recorded")

    db.close()


def cmd_user(args):
    """Log a user message event."""
    message = args.message
    db = _get_db(args.project)
    events = extract_user_events(message)

    inserted = 0
    for ev in events:
        if db.add_event(ev.type, ev.category, ev.data, ev.priority):
            inserted += 1

    print(f"user → {inserted} events recorded")
    db.close()


def cmd_stats(args):
    """Show session statistics."""
    db = _get_db(args.project)
    stats = db.get_stats()
    print(json.dumps(stats, indent=2))
    db.close()


def cmd_snapshot(args):
    """Build and display a session snapshot."""
    db = _get_db(args.project)
    events = db.get_events()

    if not events:
        print("No events recorded in this session.")
        db.close()
        return

    if args.full:
        guide = build_session_guide(events)
        print(guide)
    else:
        snapshot = build_snapshot(events, max_bytes=args.max_bytes)
        print(snapshot)
        print(f"\n({len(snapshot.encode())} bytes, {len(events)} events)")

    # Optionally save to DB
    if args.save:
        snapshot = build_snapshot(events)
        db.save_snapshot(snapshot)
        print("Snapshot saved to DB.")

    db.close()


def cmd_dash(args):
    """Show a compact dashboard of the current session."""
    db = _get_db(args.project)
    stats = db.get_stats()
    events = db.get_latest_events(10)

    print("╔════════════════════════════════════════╗")
    print("║   Antigravity Context-Mode Dashboard   ║")
    print("╠════════════════════════════════════════╣")
    print(f"║ Session: {stats['session_id']:>28s}  ║")
    print(f"║ Events:  {stats['event_count']:>28d}  ║")
    print(f"║ Started: {(stats.get('started_at') or 'N/A'):>28s}  ║")
    print("╠════════════════════════════════════════╣")

    cats = stats.get("categories", {})
    if cats:
        print("║ Categories:                            ║")
        for cat, count in sorted(cats.items(), key=lambda x: -x[1]):
            bar = "█" * min(count, 20)
            print(f"║   {cat:12s} {count:>3d} {bar:<20s}   ║")

    print("╠════════════════════════════════════════╣")
    print("║ Recent Events:                         ║")
    for ev in events[-5:]:
        tp = ev['type'][:15]
        data = ev['data'][:20]
        print(f"║   [{ev['priority']}] {tp:15s} {data:20s}  ║")

    print("╚════════════════════════════════════════╝")
    db.close()


def cmd_reset(args):
    """Reset the current session (start fresh)."""
    if os.path.exists(SESSION_FILE):
        os.remove(SESSION_FILE)
    print("Session reset. A new session will start on next invocation.")


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Antigravity Context-Mode Self-Instrumentation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--project", default=DEFAULT_PROJECT, help="Project directory")

    sub = parser.add_subparsers(dest="command", help="Commands")

    # pre
    p_pre = sub.add_parser("pre", help="Log pre-tool-use event")
    p_pre.add_argument("tool", help="Tool name (e.g., view_file)")
    p_pre.add_argument("input", nargs="?", default="{}", help="Tool input as JSON")

    # post
    p_post = sub.add_parser("post", help="Log post-tool-use event")
    p_post.add_argument("tool", help="Tool name")
    p_post.add_argument("input", nargs="?", default="{}", help="Tool input as JSON")
    p_post.add_argument("--output-snippet", help="First 300 chars of tool output")
    p_post.add_argument("--output-size", type=int, help="Raw output size in bytes")
    p_post.add_argument("--context-size", type=int, help="Context-consumed size in bytes")

    # user
    p_user = sub.add_parser("user", help="Log user message event")
    p_user.add_argument("message", help="User message text")

    # stats
    sub.add_parser("stats", help="Show session statistics")

    # snapshot
    p_snap = sub.add_parser("snapshot", help="Build session snapshot")
    p_snap.add_argument("--full", action="store_true", help="Full session guide (not budget-constrained)")
    p_snap.add_argument("--save", action="store_true", help="Save snapshot to DB")
    p_snap.add_argument("--max-bytes", type=int, default=2048, help="Snapshot budget")

    # dash
    sub.add_parser("dash", help="Show session dashboard")

    # reset
    sub.add_parser("reset", help="Reset session (start fresh)")

    args = parser.parse_args()

    if args.command == "pre":
        cmd_pre(args)
    elif args.command == "post":
        cmd_post(args)
    elif args.command == "user":
        cmd_user(args)
    elif args.command == "stats":
        cmd_stats(args)
    elif args.command == "snapshot":
        cmd_snapshot(args)
    elif args.command == "dash":
        cmd_dash(args)
    elif args.command == "reset":
        cmd_reset(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
