"""
event_extract.py — Event Extractors for Antigravity Tool Calls

Extracts structured session events from Antigravity's tool calls.
Maps Antigravity tools (view_file, run_command, grep_search, etc.)
to context-mode's 13 event categories.

Adapted from context-mode's session/extract.ts for Antigravity's tool set.
"""

import re
from typing import Optional


# ── Public types ──────────────────────────────────────────────────────────────

class SessionEvent:
    """A structured session event extracted from a tool call."""
    __slots__ = ("type", "category", "data", "priority")

    def __init__(self, event_type: str, category: str, data: str, priority: int = 3):
        self.type = event_type
        self.category = category
        self.data = data[:300]
        self.priority = priority

    def to_dict(self) -> dict:
        return {
            "type": self.type,
            "category": self.category,
            "data": self.data,
            "priority": self.priority,
        }


# ── Internal helpers ──────────────────────────────────────────────────────────

def _truncate(value: Optional[str], max_len: int = 300) -> str:
    if not value:
        return ""
    return value[:max_len] if len(value) > max_len else value


# ── Git patterns ──────────────────────────────────────────────────────────────

GIT_PATTERNS = [
    (re.compile(r"\bgit\s+checkout\b"), "branch"),
    (re.compile(r"\bgit\s+commit\b"), "commit"),
    (re.compile(r"\bgit\s+merge\s+\S+"), "merge"),
    (re.compile(r"\bgit\s+rebase\b"), "rebase"),
    (re.compile(r"\bgit\s+stash\b"), "stash"),
    (re.compile(r"\bgit\s+push\b"), "push"),
    (re.compile(r"\bgit\s+pull\b"), "pull"),
    (re.compile(r"\bgit\s+log\b"), "log"),
    (re.compile(r"\bgit\s+diff\b"), "diff"),
    (re.compile(r"\bgit\s+status\b"), "status"),
    (re.compile(r"\bgit\s+branch\b"), "branch"),
    (re.compile(r"\bgit\s+reset\b"), "reset"),
    (re.compile(r"\bgit\s+add\b"), "add"),
    (re.compile(r"\bgit\s+cherry-pick\b"), "cherry-pick"),
    (re.compile(r"\bgit\s+tag\b"), "tag"),
    (re.compile(r"\bgit\s+fetch\b"), "fetch"),
    (re.compile(r"\bgit\s+clone\b"), "clone"),
]

# ── Environment patterns ─────────────────────────────────────────────────────

ENV_PATTERNS = [
    re.compile(r"\bsource\s+\S*activate\b"),
    re.compile(r"\bexport\s+\w+="),
    re.compile(r"\bnvm\s+use\b"),
    re.compile(r"\bpyenv\s+(shell|local|global)\b"),
    re.compile(r"\bconda\s+activate\b"),
    re.compile(r"\bnpm\s+(install|ci)\b"),
    re.compile(r"\bpip\s+install\b"),
    re.compile(r"\bbun\s+install\b"),
    re.compile(r"\byarn\s+(add|install)\b"),
    re.compile(r"\bpnpm\s+(add|install)\b"),
    re.compile(r"\bcargo\s+(install|add)\b"),
    re.compile(r"\brustup\b"),
]

# ── Error patterns ────────────────────────────────────────────────────────────

ERROR_PATTERN = re.compile(
    r"exit code [1-9]|error:|Error:|FAIL|failed|traceback|exception",
    re.IGNORECASE,
)


# ── Tool extractors ──────────────────────────────────────────────────────────

def extract_view_file(tool_input: dict, tool_output: str = "") -> list[SessionEvent]:
    """Extract events from view_file tool calls."""
    path = tool_input.get("AbsolutePath", "")
    events = [SessionEvent("file_read", "file", _truncate(path), priority=1)]

    # Detect rule files
    if re.search(r"AGENTS\.md|GEMINI\.md|CLAUDE\.md|\.gemini[\\/]|\.agent[\\/]", path, re.IGNORECASE):
        events.append(SessionEvent("rule", "rule", _truncate(path), priority=1))

    return events


def extract_write_to_file(tool_input: dict) -> list[SessionEvent]:
    """Extract events from write_to_file tool calls."""
    path = tool_input.get("TargetFile", "")
    return [SessionEvent("file_write", "file", _truncate(path), priority=1)]


def extract_replace_file(tool_input: dict) -> list[SessionEvent]:
    """Extract events from replace_file_content and multi_replace_file_content."""
    path = tool_input.get("TargetFile", "")
    return [SessionEvent("file_edit", "file", _truncate(path), priority=1)]


def extract_grep_search(tool_input: dict) -> list[SessionEvent]:
    """Extract events from grep_search tool calls."""
    query = tool_input.get("Query", "")
    search_path = tool_input.get("SearchPath", "")
    return [SessionEvent("file_search", "file", _truncate(f"{query} in {search_path}"), priority=3)]


def extract_find_by_name(tool_input: dict) -> list[SessionEvent]:
    """Extract events from find_by_name tool calls."""
    pattern = tool_input.get("Pattern", "")
    search_dir = tool_input.get("SearchDirectory", "")
    return [SessionEvent("file_glob", "file", _truncate(f"{pattern} in {search_dir}"), priority=3)]


def extract_list_dir(tool_input: dict) -> list[SessionEvent]:
    """Extract events from list_dir tool calls."""
    path = tool_input.get("DirectoryPath", "")
    return [SessionEvent("file_glob", "file", _truncate(path), priority=3)]


def extract_run_command(tool_input: dict, tool_output: str = "") -> list[SessionEvent]:
    """
    Extract events from run_command — the most complex extractor.
    A single command can produce file, cwd, error, git, and env events.
    """
    events = []
    cmd = tool_input.get("CommandLine", "")
    cwd = tool_input.get("Cwd", "")

    # Git detection
    for pattern, op in GIT_PATTERNS:
        if pattern.search(cmd):
            events.append(SessionEvent("git", "git", _truncate(op), priority=2))
            break  # Only first match

    # Environment detection
    for pattern in ENV_PATTERNS:
        if pattern.search(cmd):
            # Sanitize exports
            sanitized = re.sub(r"\bexport\s+(\w+)=\S*", r"export \1=***", cmd)
            events.append(SessionEvent("env", "env", _truncate(sanitized), priority=2))
            break

    # CWD detection
    cd_match = re.search(r'\bcd\s+("([^"]+)"|\'([^\']+)\'|(\S+))', cmd)
    if cd_match:
        cd_dir = cd_match.group(2) or cd_match.group(3) or cd_match.group(4) or ""
        events.append(SessionEvent("cwd", "cwd", _truncate(cd_dir), priority=2))

    # Error detection (from output)
    if tool_output and ERROR_PATTERN.search(tool_output):
        events.append(SessionEvent("error_tool", "error", _truncate(tool_output, 300), priority=2))

    # If nothing specific matched, record as generic command
    if not events:
        events.append(SessionEvent("command", "env", _truncate(cmd[:100]), priority=3))

    return events


def extract_browser_subagent(tool_input: dict, tool_output: str = "") -> list[SessionEvent]:
    """Extract events from browser_subagent tool calls."""
    task = tool_input.get("Task", tool_input.get("TaskSummary", ""))
    is_completed = bool(tool_output)

    return [
        SessionEvent(
            "subagent_completed" if is_completed else "subagent_launched",
            "subagent",
            _truncate(f"[{'completed' if is_completed else 'launched'}] {task}"),
            priority=2 if is_completed else 3,
        )
    ]


def extract_read_url(tool_input: dict) -> list[SessionEvent]:
    """Extract events from read_url_content tool calls."""
    url = tool_input.get("Url", "")
    return [SessionEvent("mcp", "mcp", _truncate(f"fetch: {url}"), priority=3)]


# ── Master extractor ──────────────────────────────────────────────────────────

# Map Antigravity tool names to their extractors
TOOL_EXTRACTORS = {
    "view_file": lambda inp, out: extract_view_file(inp, out),
    "write_to_file": lambda inp, out: extract_write_to_file(inp),
    "replace_file_content": lambda inp, out: extract_replace_file(inp),
    "multi_replace_file_content": lambda inp, out: extract_replace_file(inp),
    "grep_search": lambda inp, out: extract_grep_search(inp),
    "find_by_name": lambda inp, out: extract_find_by_name(inp),
    "list_dir": lambda inp, out: extract_list_dir(inp),
    "run_command": lambda inp, out: extract_run_command(inp, out),
    "browser_subagent": lambda inp, out: extract_browser_subagent(inp, out),
    "read_url_content": lambda inp, out: extract_read_url(inp),
}


def extract_events(tool_name: str, tool_input: dict, tool_output: str = "") -> list[SessionEvent]:
    """
    Extract session events from any Antigravity tool call.

    Args:
        tool_name: The Antigravity tool name (e.g., "view_file", "run_command")
        tool_input: The tool's input parameters as a dict
        tool_output: The tool's output (optional, for error detection)

    Returns:
        List of SessionEvent objects
    """
    try:
        extractor = TOOL_EXTRACTORS.get(tool_name)
        if extractor:
            return extractor(tool_input, tool_output)
        return []
    except Exception:
        # Graceful degradation: never crash the caller
        return []


# ── User message extractors ──────────────────────────────────────────────────

DECISION_PATTERNS = [
    re.compile(r"\b(don'?t|do not|never|always|instead|rather|prefer)\b", re.IGNORECASE),
    re.compile(r"\b(use|switch to|go with|pick|choose)\s+\w+\s+(instead|over|not)\b", re.IGNORECASE),
    re.compile(r"\b(no,?\s+(use|do|try|make))\b", re.IGNORECASE),
]

INTENT_PATTERNS = [
    ("investigate", re.compile(r"\b(why|how does|explain|understand|what is|analyze|debug|look into)\b", re.IGNORECASE)),
    ("implement", re.compile(r"\b(create|add|build|implement|write|make|develop|fix)\b", re.IGNORECASE)),
    ("discuss", re.compile(r"\b(think about|consider|should we|what if|pros and cons|opinion)\b", re.IGNORECASE)),
    ("review", re.compile(r"\b(review|check|audit|verify|test|validate)\b", re.IGNORECASE)),
]


def extract_user_events(message: str) -> list[SessionEvent]:
    """
    Extract session events from user messages.
    Handles: decision, intent, data categories.
    """
    events = []

    # Decision detection
    for pattern in DECISION_PATTERNS:
        if pattern.search(message):
            events.append(SessionEvent("decision", "decision", _truncate(message), priority=2))
            break

    # Intent classification
    for mode, pattern in INTENT_PATTERNS:
        if pattern.search(message):
            events.append(SessionEvent("intent", "intent", _truncate(mode), priority=4))
            break

    # Large data detection
    if len(message) > 1024:
        events.append(SessionEvent("data", "data", _truncate(message, 200), priority=4))

    return events


# ── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import json

    # Demo: extract events from example tool calls
    examples = [
        ("view_file", {"AbsolutePath": "/path/to/project/src/server.ts"}, ""),
        ("view_file", {"AbsolutePath": "/path/to/project/AGENTS.md"}, ""),
        ("write_to_file", {"TargetFile": "/path/to/project/new_file.py"}, ""),
        ("run_command", {"CommandLine": "git commit -m 'fix bug'", "Cwd": "/path/to/project"}, ""),
        ("run_command", {"CommandLine": "npm install express", "Cwd": "D:/dev"}, ""),
        ("run_command", {"CommandLine": "cd /tmp && ls", "Cwd": "D:/dev"}, ""),
        ("run_command", {"CommandLine": "python test.py", "Cwd": "D:/dev"}, "Error: test failed\nexit code 1"),
        ("grep_search", {"Query": "TODO", "SearchPath": "/path/to/project/src"}, ""),
        ("browser_subagent", {"Task": "Navigate to login page and screenshot"}, ""),
        ("read_url_content", {"Url": "https://docs.python.org/3/library/sqlite3.html"}, ""),
    ]

    for tool_name, tool_input, tool_output in examples:
        events = extract_events(tool_name, tool_input, tool_output)
        for ev in events:
            print(f"  [{ev.priority}] {ev.type:20s} {ev.category:10s} {ev.data[:60]}")

    print("\n--- User message examples ---")
    user_msgs = [
        "don't use that approach, use SQLite instead",
        "explain how the event extraction works",
        "create a new file for the snapshot builder",
    ]
    for msg in user_msgs:
        events = extract_user_events(msg)
        for ev in events:
            print(f"  [{ev.priority}] {ev.type:20s} {ev.category:10s} {ev.data[:60]}")
