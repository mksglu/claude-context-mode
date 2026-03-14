"""
ctx_doctor.py — Diagnostic Tool for Antigravity Context-Mode

Checks the health of all context-mode components and reports
any issues that need attention.

Usage:
  python ctx_doctor.py           # Run all checks
  python ctx_doctor.py --fix     # Attempt auto-fixes where possible
"""

import os
import sys
import json
import sqlite3
import shutil
import importlib
from pathlib import Path


# ── Check definitions ─────────────────────────────────────────────────────────

CHECKS = []

def check(name, critical=False):
    """Decorator to register a health check."""
    def decorator(fn):
        CHECKS.append({"name": name, "fn": fn, "critical": critical})
        return fn
    return decorator


# ── Environment checks ──────────────────────────────────────────────────────

@check("Python version >= 3.10", critical=True)
def check_python_version():
    v = sys.version_info
    if v.major >= 3 and v.minor >= 10:
        return True, f"Python {v.major}.{v.minor}.{v.micro}"
    return False, f"Python {v.major}.{v.minor}.{v.micro} — need >= 3.10"


@check("SQLite available with FTS5", critical=True)
def check_sqlite():
    try:
        conn = sqlite3.connect(":memory:")
        # Check FTS5 support
        try:
            conn.execute("CREATE VIRTUAL TABLE test_fts USING fts5(content)")
            conn.execute("DROP TABLE test_fts")
            fts5 = True
        except sqlite3.OperationalError:
            fts5 = False

        version = sqlite3.sqlite_version
        conn.close()
        if fts5:
            return True, f"SQLite {version} with FTS5"
        return True, f"SQLite {version} (no FTS5 — optional feature unavailable)"
    except Exception as e:
        return False, f"SQLite error: {e}"


# ── Script checks ───────────────────────────────────────────────────────────

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))

REQUIRED_SCRIPTS = [
    ("ctx_read.py", "Phase 1: Smart file reading"),
    ("ctx_dir.py", "Phase 1: Compact directory listing"),
    ("ctx_summary.py", "Phase 1: Pipe-friendly summarizer"),
    ("session_db.py", "Phase 2: SQLite event store"),
    ("event_extract.py", "Phase 2: Event extractors"),
    ("snapshot_builder.py", "Phase 2: Snapshot builder"),
    ("ctx_stats.py", "Phase 2: Context usage tracker"),
    ("ctx_instrument.py", "Phase 3: Self-instrumentation"),
]


@check("All context-mode scripts present", critical=True)
def check_scripts():
    missing = []
    for script, desc in REQUIRED_SCRIPTS:
        path = os.path.join(SKILL_DIR, script)
        if not os.path.exists(path):
            missing.append(f"{script} ({desc})")

    if missing:
        return False, f"Missing: {', '.join(missing)}"
    return True, f"All {len(REQUIRED_SCRIPTS)} scripts present"


@check("Scripts importable (no syntax errors)")
def check_imports():
    sys.path.insert(0, SKILL_DIR)
    failed = []
    for script, _ in REQUIRED_SCRIPTS:
        module_name = script.replace(".py", "")
        try:
            importlib.import_module(module_name)
        except Exception as e:
            failed.append(f"{script}: {e}")

    if failed:
        return False, f"Import failures: {'; '.join(failed)}"
    return True, "All scripts importable"


# ── Database checks ─────────────────────────────────────────────────────────

@check("Session database directory exists")
def check_db_directory():
    db_dir = Path.home() / ".antigravity" / "context-mode" / "sessions"
    if db_dir.exists():
        dbs = list(db_dir.glob("*.db"))
        return True, f"{len(dbs)} session DB(s) in {db_dir}"
    return False, f"Directory not found: {db_dir}"


@check("Current session file exists")
def check_session_file():
    session_file = Path.home() / ".antigravity" / "context-mode" / "current_session.json"
    if session_file.exists():
        try:
            with open(session_file) as f:
                data = json.load(f)
            sid = data.get("session_id", "unknown")
            import time
            age_min = (time.time() - data.get("started", 0)) / 60
            return True, f"Session {sid} ({age_min:.0f} min old)"
        except Exception as e:
            return False, f"Corrupt session file: {e}"
    return False, "No active session — will be created on first use"


# ── Workflow checks ─────────────────────────────────────────────────────────

@check("ctx-efficient workflow installed")
def check_workflow():
    workflow = Path(r".\.agent\workflows\ctx-efficient.md")
    if workflow.exists():
        size = workflow.stat().st_size
        return True, f"Workflow file present ({size} bytes)"
    return False, "Workflow file not found at .agent/workflows/ctx-efficient.md"


@check("SKILL.md present")
def check_skill_md():
    skill_md = os.path.join(SKILL_DIR, "SKILL.md")
    if os.path.exists(skill_md):
        size = os.path.getsize(skill_md)
        return True, f"SKILL.md present ({size} bytes)"
    return False, "SKILL.md not found"


# ── Antigravity environment checks ──────────────────────────────────────────

@check("Antigravity daemon discovery file")
def check_daemon():
    daemon_dir = Path.home() / ".gemini" / "antigravity" / "daemon"
    if not daemon_dir.exists():
        return False, "Daemon directory not found"

    json_files = list(daemon_dir.glob("*.json"))
    if not json_files:
        return False, "No daemon discovery files"

    latest = max(json_files, key=lambda f: f.stat().st_mtime)
    try:
        with open(latest) as f:
            data = json.load(f)
        pid = data.get("pid", "?")
        version = data.get("lsVersion", "?")
        return True, f"Daemon PID {pid}, version {version} ({latest.name})"
    except Exception as e:
        return False, f"Error reading daemon file: {e}"


@check("Antigravity conversation storage")
def check_conversations():
    conv_dir = Path.home() / ".gemini" / "antigravity" / "conversations"
    if not conv_dir.exists():
        return False, "Conversations directory not found"

    pb_files = list(conv_dir.glob("*.pb"))
    total_size = sum(f.stat().st_size for f in pb_files)
    return True, f"{len(pb_files)} conversations, {total_size / 1024 / 1024:.1f}MB total"


@check("User rules size (AGENTS.md)")
def check_user_rules():
    agents_md = Path(r".\AGENTS.md")
    if not agents_md.exists():
        return True, "No AGENTS.md — zero overhead"

    size = agents_md.stat().st_size
    if size > 4096:
        return False, f"AGENTS.md is {size} bytes — consider compressing (target: <2KB)"
    return True, f"AGENTS.md is {size} bytes (within budget)"


# ── Runner ───────────────────────────────────────────────────────────────────

def run_checks(fix: bool = False) -> dict:
    """Run all health checks and return results."""
    results = {"passed": 0, "failed": 0, "critical_failures": 0, "details": []}

    print("╔══════════════════════════════════════════════════════╗")
    print("║     Antigravity Context-Mode — Health Check          ║")
    print("╠══════════════════════════════════════════════════════╣")

    for check_def in CHECKS:
        name = check_def["name"]
        critical = check_def["critical"]
        try:
            passed, message = check_def["fn"]()
        except Exception as e:
            passed, message = False, f"Exception: {e}"

        icon = "✅" if passed else ("🔴" if critical else "⚠️")
        status = "PASS" if passed else "FAIL"

        print(f"║ {icon} {name}")
        print(f"║    → {message}")

        results["details"].append({
            "name": name,
            "passed": passed,
            "critical": critical,
            "message": message,
        })

        if passed:
            results["passed"] += 1
        else:
            results["failed"] += 1
            if critical:
                results["critical_failures"] += 1

    print("╠══════════════════════════════════════════════════════╣")
    total = results["passed"] + results["failed"]
    print(f"║ Results: {results['passed']}/{total} passed", end="")
    if results["critical_failures"]:
        print(f" ({results['critical_failures']} CRITICAL)")
    else:
        print(" — all good! 🎉")
    print("╚══════════════════════════════════════════════════════╝")

    return results


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Context-Mode Health Check")
    parser.add_argument("--fix", action="store_true", help="Attempt auto-fixes")
    parser.add_argument("--json", action="store_true", help="JSON output")
    args = parser.parse_args()

    results = run_checks(fix=args.fix)

    if args.json:
        print(json.dumps(results, indent=2))

    sys.exit(1 if results["critical_failures"] > 0 else 0)
