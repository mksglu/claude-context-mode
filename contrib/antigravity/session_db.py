"""
session_db.py — SQLite Event Store for Antigravity Context-Mode

Persistent session event storage with WAL mode and priority tiers.
Adapted from context-mode's session/db.ts for Antigravity's architecture.

Storage location: ~/.antigravity/context-mode/sessions/<project_hash>.db
"""

import sqlite3
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Optional


# ── Schema ─────────────────────────────────────────────────────────────────

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT    NOT NULL,
    type       TEXT    NOT NULL,
    category   TEXT    NOT NULL,
    data       TEXT    NOT NULL,
    priority   INTEGER NOT NULL DEFAULT 3,
    data_hash  TEXT,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_events_session  ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_priority ON events(priority);
CREATE INDEX IF NOT EXISTS idx_events_hash     ON events(data_hash);

CREATE TABLE IF NOT EXISTS session_resume (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT    NOT NULL,
    snapshot   TEXT    NOT NULL,
    compact_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS session_meta (
    session_id    TEXT PRIMARY KEY,
    project_dir   TEXT,
    started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_event_at TEXT,
    event_count   INTEGER NOT NULL DEFAULT 0
);
"""


def _project_hash(project_dir: str) -> str:
    """Hash a project directory path to create a stable DB filename."""
    return hashlib.sha256(project_dir.encode()).hexdigest()[:16]


def _db_path(project_dir: str) -> Path:
    """Get the database path for a project."""
    base = Path.home() / ".antigravity" / "context-mode" / "sessions"
    base.mkdir(parents=True, exist_ok=True)
    return base / f"{_project_hash(project_dir)}.db"


class SessionDB:
    """Persistent session event store using SQLite with WAL mode."""

    def __init__(self, project_dir: str, session_id: Optional[str] = None):
        self.project_dir = project_dir
        self.session_id = session_id or hashlib.sha256(
            f"{project_dir}:{time.time()}".encode()
        ).hexdigest()[:12]
        self.db_path = _db_path(project_dir)
        self._conn: Optional[sqlite3.Connection] = None
        self._init_db()

    def _init_db(self):
        """Initialize database with WAL mode and schema."""
        self._conn = sqlite3.connect(str(self.db_path), timeout=10)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.executescript(SCHEMA_SQL)

        # Ensure session meta record exists
        self._conn.execute(
            """INSERT OR IGNORE INTO session_meta (session_id, project_dir)
               VALUES (?, ?)""",
            (self.session_id, self.project_dir),
        )
        self._conn.commit()

    # ── Event insertion ─────────────────────────────────────────────────

    def add_event(
        self,
        event_type: str,
        category: str,
        data: str,
        priority: int = 3,
        dedup: bool = True,
    ) -> bool:
        """
        Insert a session event. Returns True if inserted, False if deduped.

        Args:
            event_type: e.g. "file_read", "file_write", "error_tool"
            category: e.g. "file", "error", "git", "decision"
            data: event payload (truncated to 300 chars)
            priority: 1=critical ... 5=low
            dedup: if True, skip insert if same data_hash exists in session
        """
        data = data[:300] if len(data) > 300 else data
        data_hash = hashlib.sha256(
            f"{self.session_id}:{category}:{data}".encode()
        ).hexdigest()[:16]

        if dedup:
            existing = self._conn.execute(
                "SELECT 1 FROM events WHERE session_id=? AND data_hash=?",
                (self.session_id, data_hash),
            ).fetchone()
            if existing:
                return False

        self._conn.execute(
            """INSERT INTO events (session_id, type, category, data, priority, data_hash)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (self.session_id, event_type, category, data, priority, data_hash),
        )

        # Update session meta
        self._conn.execute(
            """UPDATE session_meta
               SET last_event_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   event_count = event_count + 1
               WHERE session_id = ?""",
            (self.session_id,),
        )
        self._conn.commit()
        return True

    def add_events(self, events: list[dict]) -> int:
        """
        Bulk insert events. Each dict should have keys:
        type, category, data, priority (optional).
        Returns count of actually inserted events.
        """
        inserted = 0
        for ev in events:
            if self.add_event(
                event_type=ev["type"],
                category=ev["category"],
                data=ev["data"],
                priority=ev.get("priority", 3),
            ):
                inserted += 1
        return inserted

    # ── Event retrieval ─────────────────────────────────────────────────

    def get_events(
        self,
        session_id: Optional[str] = None,
        category: Optional[str] = None,
        min_priority: Optional[int] = None,
        limit: int = 500,
    ) -> list[dict]:
        """Retrieve events with optional filtering."""
        sid = session_id or self.session_id
        query = "SELECT type, category, data, priority, created_at FROM events WHERE session_id=?"
        params: list = [sid]

        if category:
            query += " AND category=?"
            params.append(category)
        if min_priority is not None:
            query += " AND priority<=?"
            params.append(min_priority)

        query += " ORDER BY id ASC LIMIT ?"
        params.append(limit)

        rows = self._conn.execute(query, params).fetchall()
        return [
            {
                "type": r[0],
                "category": r[1],
                "data": r[2],
                "priority": r[3],
                "created_at": r[4],
            }
            for r in rows
        ]

    def get_latest_events(self, n: int = 50) -> list[dict]:
        """Get the N most recent events for the current session."""
        rows = self._conn.execute(
            """SELECT type, category, data, priority, created_at
               FROM events WHERE session_id=?
               ORDER BY id DESC LIMIT ?""",
            (self.session_id, n),
        ).fetchall()
        return [
            {
                "type": r[0],
                "category": r[1],
                "data": r[2],
                "priority": r[3],
                "created_at": r[4],
            }
            for r in reversed(rows)  # Return in chronological order
        ]

    # ── Snapshot operations ────────────────────────────────────────────

    def save_snapshot(self, snapshot: str, compact_count: int = 1):
        """Save a resume snapshot for the current session."""
        self._conn.execute(
            """INSERT INTO session_resume (session_id, snapshot, compact_count)
               VALUES (?, ?, ?)""",
            (self.session_id, snapshot, compact_count),
        )
        self._conn.commit()

    def get_latest_snapshot(self) -> Optional[dict]:
        """Get the most recent snapshot for the current session."""
        row = self._conn.execute(
            """SELECT snapshot, compact_count, created_at
               FROM session_resume WHERE session_id=?
               ORDER BY id DESC LIMIT 1""",
            (self.session_id,),
        ).fetchone()
        if not row:
            return None
        return {
            "snapshot": row[0],
            "compact_count": row[1],
            "created_at": row[2],
        }

    # ── Stats ──────────────────────────────────────────────────────────

    def get_stats(self) -> dict:
        """Get session statistics."""
        meta = self._conn.execute(
            "SELECT * FROM session_meta WHERE session_id=?",
            (self.session_id,),
        ).fetchone()

        categories = self._conn.execute(
            """SELECT category, COUNT(*) FROM events
               WHERE session_id=? GROUP BY category ORDER BY COUNT(*) DESC""",
            (self.session_id,),
        ).fetchall()

        return {
            "session_id": self.session_id,
            "project_dir": self.project_dir,
            "db_path": str(self.db_path),
            "event_count": meta[4] if meta else 0,
            "started_at": meta[2] if meta else None,
            "last_event_at": meta[3] if meta else None,
            "categories": {r[0]: r[1] for r in categories},
        }

    # ── Cleanup ────────────────────────────────────────────────────────

    def close(self):
        if self._conn:
            self._conn.close()
            self._conn = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


# ── CLI ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Antigravity Context-Mode Session DB")
    parser.add_argument("project_dir", help="Project directory path")
    parser.add_argument("--session-id", help="Session ID (auto-generated if omitted)")
    parser.add_argument("--stats", action="store_true", help="Show session stats")
    parser.add_argument("--events", action="store_true", help="Show recent events")
    parser.add_argument("--events-count", type=int, default=20, help="Number of events to show")
    parser.add_argument("--snapshot", action="store_true", help="Show latest snapshot")
    parser.add_argument("--add-event", nargs=4, metavar=("TYPE", "CATEGORY", "DATA", "PRIORITY"),
                        help="Add a test event")
    args = parser.parse_args()

    with SessionDB(args.project_dir, args.session_id) as db:
        if args.add_event:
            etype, cat, data, pri = args.add_event
            inserted = db.add_event(etype, cat, data, int(pri))
            print(f"{'Inserted' if inserted else 'Deduped'}: {etype}/{cat}")

        if args.stats:
            stats = db.get_stats()
            print(json.dumps(stats, indent=2))

        if args.events:
            events = db.get_latest_events(args.events_count)
            for ev in events:
                print(f"  [{ev['priority']}] {ev['type']:20s} {ev['category']:10s} {ev['data'][:80]}")

        if args.snapshot:
            snap = db.get_latest_snapshot()
            if snap:
                print(snap["snapshot"])
            else:
                print("No snapshot found.")

        if not any([args.stats, args.events, args.snapshot, args.add_event]):
            # Default: show stats
            stats = db.get_stats()
            print(json.dumps(stats, indent=2))
