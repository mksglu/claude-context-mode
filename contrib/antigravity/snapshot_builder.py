"""
snapshot_builder.py — Priority-Tiered Resume Snapshot Builder

Converts stored session events into a compact markdown resume snapshot.
Adapted from context-mode's session/snapshot.ts for Antigravity.

Budget: 2048 bytes default, allocated by priority tier:
  P1 (files, tasks, rules):                50% = ~1024 bytes
  P2 (decisions, errors, env, git):        35% = ~716 bytes
  P3-P4 (intent, subagents, commands):     15% = ~308 bytes
"""

from typing import Optional
from collections import OrderedDict
from datetime import datetime, timezone


MAX_ACTIVE_FILES = 10
DEFAULT_MAX_BYTES = 2048


def _escape(text: str) -> str:
    """Minimal escaping for markdown/XML content."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _trunc(text: str, max_len: int = 200) -> str:
    if len(text) <= max_len:
        return text
    return text[:max_len - 3] + "..."


# ── Section renderers ─────────────────────────────────────────────────────────


def render_active_files(file_events: list[dict]) -> str:
    """Render active files section from file events."""
    if not file_events:
        return ""

    # Build per-file operation counts
    file_map: OrderedDict[str, dict] = OrderedDict()
    for ev in file_events:
        path = ev["data"]
        if path not in file_map:
            file_map[path] = {"ops": {}, "last": ""}

        op = ev["type"].replace("file_", "") if ev["type"].startswith("file_") else ev["type"]
        file_map[path]["ops"][op] = file_map[path]["ops"].get(op, 0) + 1
        file_map[path]["last"] = op

    # Keep only last N files
    entries = list(file_map.items())[-MAX_ACTIVE_FILES:]

    lines = ["## Active Files"]
    for path, info in entries:
        ops_str = ", ".join(f"{k}:{v}" for k, v in info["ops"].items())
        # Show just the filename to save bytes
        short_path = path.replace("\\", "/").split("/")[-1]
        lines.append(f"- `{short_path}` ({ops_str}, last: {info['last']})")

    return "\n".join(lines)


def render_tasks(task_events: list[dict]) -> str:
    """Render pending tasks from task events."""
    if not task_events:
        return ""

    lines = ["## Tasks"]
    for ev in task_events[-5:]:  # Keep last 5 tasks
        lines.append(f"- {_trunc(ev['data'], 100)}")
    return "\n".join(lines)


def render_rules(rule_events: list[dict]) -> str:
    """Render rules section."""
    if not rule_events:
        return ""

    seen = set()
    lines = ["## Rules Applied"]
    for ev in rule_events:
        key = ev["data"]
        if key in seen:
            continue
        seen.add(key)
        if ev["type"] == "rule_content":
            lines.append(f"- Content: {_trunc(ev['data'], 200)}")
        else:
            lines.append(f"- `{_trunc(ev['data'], 200)}`")
    return "\n".join(lines)


def render_decisions(decision_events: list[dict]) -> str:
    """Render user decisions."""
    if not decision_events:
        return ""

    seen = set()
    lines = ["## Decisions"]
    for ev in decision_events:
        key = ev["data"]
        if key in seen:
            continue
        seen.add(key)
        lines.append(f"- {_trunc(ev['data'], 150)}")
    return "\n".join(lines)


def render_errors(error_events: list[dict]) -> str:
    """Render encountered errors."""
    if not error_events:
        return ""

    lines = ["## Errors Encountered"]
    for ev in error_events[-5:]:  # Keep last 5 errors
        lines.append(f"- {_trunc(ev['data'], 150)}")
    return "\n".join(lines)


def render_environment(cwd_events: list[dict], env_events: list[dict],
                        git_events: list[dict]) -> str:
    """Render environment state."""
    parts = []

    if cwd_events:
        last_cwd = cwd_events[-1]["data"]
        parts.append(f"- CWD: `{_trunc(last_cwd, 100)}`")

    if git_events:
        last_git = git_events[-1]["data"]
        parts.append(f"- Git: `{last_git}`")

    for ev in env_events[-3:]:
        parts.append(f"- Env: {_trunc(ev['data'], 100)}")

    if not parts:
        return ""

    return "## Environment\n" + "\n".join(parts)


def render_subagents(subagent_events: list[dict]) -> str:
    """Render subagent activity."""
    if not subagent_events:
        return ""

    lines = ["## Subagents"]
    for ev in subagent_events[-3:]:
        status = "✅" if "completed" in ev["type"] else "🚀"
        lines.append(f"- {status} {_trunc(ev['data'], 150)}")
    return "\n".join(lines)


def render_intent(intent_events: list[dict]) -> str:
    """Render current intent/mode."""
    if not intent_events:
        return ""
    last = intent_events[-1]["data"]
    return f"## Intent: {last}"


# ── Main builder ──────────────────────────────────────────────────────────────


def build_snapshot(events: list[dict], max_bytes: int = DEFAULT_MAX_BYTES,
                   compact_count: int = 1) -> str:
    """
    Build a resume snapshot markdown string from stored session events.

    Algorithm:
    1. Group events by category
    2. Render each section
    3. Assemble by priority tier with budget trimming
    4. If over max_bytes, drop lowest priority sections first
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Group events by category
    groups: dict[str, list[dict]] = {}
    for ev in events:
        cat = ev.get("category", "unknown")
        groups.setdefault(cat, []).append(ev)

    # P1 sections (50% budget): files, tasks, rules
    p1 = []
    section = render_active_files(groups.get("file", []))
    if section:
        p1.append(section)
    section = render_tasks(groups.get("task", []))
    if section:
        p1.append(section)
    section = render_rules(groups.get("rule", []))
    if section:
        p1.append(section)

    # P2 sections (35% budget): decisions, errors, environment, subagents
    p2 = []
    section = render_decisions(groups.get("decision", []))
    if section:
        p2.append(section)
    section = render_errors(groups.get("error", []))
    if section:
        p2.append(section)
    section = render_environment(
        groups.get("cwd", []),
        groups.get("env", []),
        groups.get("git", []),
    )
    if section:
        p2.append(section)
    completed = [e for e in groups.get("subagent", []) if "completed" in e.get("type", "")]
    section = render_subagents(completed)
    if section:
        p2.append(section)

    # P3-P4 sections (15% budget): intent, launched subagents
    p3 = []
    section = render_intent(groups.get("intent", []))
    if section:
        p3.append(section)
    launched = [e for e in groups.get("subagent", []) if "launched" in e.get("type", "")]
    section = render_subagents(launched)
    if section:
        p3.append(section)

    # Assemble with budget trimming
    header = f"# Session Resume (compact #{compact_count}, {len(events)} events, {now})"
    tiers = [p1, p2, p3]

    # Try all tiers, then drop lowest priority first
    for drop_from in range(len(tiers), -1, -1):
        active = tiers[:drop_from]
        body = "\n\n".join(s for tier in active for s in tier)

        if body:
            snapshot = f"{header}\n\n{body}"
        else:
            snapshot = header

        if len(snapshot.encode()) <= max_bytes:
            return snapshot

    # If even header alone is over budget, return it anyway
    return header


def build_session_guide(events: list[dict], compact_count: int = 1) -> str:
    """
    Build a human-readable session guide for use as an Antigravity artifact.
    This is the expanded version (not budget-constrained) for KI storage.
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    groups: dict[str, list[dict]] = {}
    for ev in events:
        groups.setdefault(ev.get("category", "unknown"), []).append(ev)

    sections = [f"# Session Guide (generated {now})"]
    sections.append(f"> Compact #{compact_count} | {len(events)} events tracked")

    for renderer, cat_key, always_show in [
        (render_active_files, "file", True),
        (render_tasks, "task", False),
        (render_rules, "rule", False),
        (render_decisions, "decision", False),
        (render_errors, "error", False),
        (render_intent, "intent", False),
    ]:
        data = groups.get(cat_key, [])
        if data or always_show:
            section = renderer(data)
            if section:
                sections.append(section)

    # Environment (special: combines 3 categories)
    env_section = render_environment(
        groups.get("cwd", []),
        groups.get("env", []),
        groups.get("git", []),
    )
    if env_section:
        sections.append(env_section)

    # Subagents
    sub_section = render_subagents(groups.get("subagent", []))
    if sub_section:
        sections.append(sub_section)

    return "\n\n".join(sections)


# ── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import json

    # Demo with sample events
    sample_events = [
        {"type": "file_read", "category": "file", "data": "D:/project/src/server.ts", "priority": 1},
        {"type": "file_edit", "category": "file", "data": "D:/project/src/handler.py", "priority": 1},
        {"type": "file_write", "category": "file", "data": "D:/project/new_module.py", "priority": 1},
        {"type": "file_read", "category": "file", "data": "D:/project/AGENTS.md", "priority": 1},
        {"type": "rule", "category": "rule", "data": "D:/project/AGENTS.md", "priority": 1},
        {"type": "git", "category": "git", "data": "commit", "priority": 2},
        {"type": "git", "category": "git", "data": "push", "priority": 2},
        {"type": "error_tool", "category": "error", "data": "TypeError: cannot read property of null", "priority": 2},
        {"type": "cwd", "category": "cwd", "data": "D:/project/src", "priority": 2},
        {"type": "env", "category": "env", "data": "pip install requests", "priority": 2},
        {"type": "decision", "category": "decision", "data": "don't use pandas, use polars instead", "priority": 2},
        {"type": "intent", "category": "intent", "data": "implement", "priority": 4},
        {"type": "subagent_completed", "category": "subagent", "data": "[completed] Navigate to login page", "priority": 2},
    ]

    print("=== Compact Snapshot (2KB budget) ===")
    snapshot = build_snapshot(sample_events)
    print(snapshot)
    print(f"\n({len(snapshot.encode())} bytes)")

    print("\n=== Full Session Guide ===")
    guide = build_session_guide(sample_events)
    print(guide)
