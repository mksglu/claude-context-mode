#!/usr/bin/env python3
"""ctx_read.py — Context-efficient file reader for Antigravity.

Reads a file and returns a compressed summary instead of the full content.
Only the summary enters the LLM's context window.

Usage:
    python ctx_read.py <file_path> [--intent "what to look for"] [--lines N] [--structure]

Examples:
    python ctx_read.py src/server.ts --structure
    python ctx_read.py src/server.ts --intent "security checks"
    python ctx_read.py README.md --intent "installation"
    python ctx_read.py build.log --lines 50
"""

import argparse
import os
import re
import sys
from pathlib import Path


def get_file_metadata(path: Path) -> dict:
    """Get basic file metadata."""
    stat = path.stat()
    return {
        "name": path.name,
        "extension": path.suffix,
        "size_bytes": stat.st_size,
        "size_human": f"{stat.st_size / 1024:.1f}KB" if stat.st_size > 1024 else f"{stat.st_size}B",
        "lines": sum(1 for _ in open(path, "r", encoding="utf-8", errors="replace")),
    }


def extract_structure(content: str, ext: str) -> str:
    """Extract code structure (classes, functions, imports) from source files."""
    lines = content.split("\n")
    structure = []

    if ext in (".py",):
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            if stripped.startswith(("class ", "def ", "async def ")):
                indent = len(line) - len(line.lstrip())
                structure.append(f"  L{i:4d} {'  ' * (indent // 4)}{stripped.split('(')[0]}(...)")
            elif stripped.startswith(("import ", "from ")):
                structure.append(f"  L{i:4d} {stripped}")

    elif ext in (".ts", ".tsx", ".js", ".jsx"):
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            if re.match(r"^(export\s+)?(async\s+)?function\s+", stripped):
                name = re.search(r"function\s+(\w+)", stripped)
                structure.append(f"  L{i:4d} fn {name.group(1) if name else '?'}()")
            elif re.match(r"^(export\s+)?(default\s+)?class\s+", stripped):
                name = re.search(r"class\s+(\w+)", stripped)
                structure.append(f"  L{i:4d} class {name.group(1) if name else '?'}")
            elif re.match(r"^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(", stripped):
                name = re.search(r"(const|let|var)\s+(\w+)", stripped)
                structure.append(f"  L{i:4d} const {name.group(2) if name else '?'}()")
            elif stripped.startswith(("import ", "export {")):
                structure.append(f"  L{i:4d} {stripped[:80]}")
            elif "registerTool(" in stripped or "server.tool(" in stripped:
                name = re.search(r'["\'](\w+)["\']', stripped)
                structure.append(f"  L{i:4d} TOOL: {name.group(1) if name else '?'}")

    elif ext in (".md",):
        for i, line in enumerate(lines, 1):
            if line.startswith("#"):
                level = len(line) - len(line.lstrip("#"))
                heading = line.lstrip("#").strip()
                structure.append(f"  L{i:4d} {'  ' * (level - 1)}{heading}")

    elif ext in (".json",):
        # Just show top-level keys
        import json
        try:
            data = json.loads(content)
            if isinstance(data, dict):
                for key in list(data.keys())[:20]:
                    val = data[key]
                    vtype = type(val).__name__
                    if isinstance(val, list):
                        structure.append(f"  {key}: [{len(val)} items]")
                    elif isinstance(val, dict):
                        structure.append(f"  {key}: {{{len(val)} keys}}")
                    elif isinstance(val, str) and len(val) > 60:
                        structure.append(f"  {key}: \"{val[:57]}...\"")
                    else:
                        structure.append(f"  {key}: {val}")
        except json.JSONDecodeError:
            structure.append("  (invalid JSON)")

    return "\n".join(structure) if structure else "(no structure extracted)"


def filter_by_intent(content: str, intent: str, context_lines: int = 3) -> str:
    """Return only lines matching the intent query, with surrounding context."""
    lines = content.split("\n")
    terms = intent.lower().split()
    matches = set()

    for i, line in enumerate(lines):
        lower = line.lower()
        if any(term in lower for term in terms):
            for j in range(max(0, i - context_lines), min(len(lines), i + context_lines + 1)):
                matches.add(j)

    if not matches:
        return f"(no lines matched intent: {intent})"

    result = []
    sorted_matches = sorted(matches)
    prev = -2
    for idx in sorted_matches:
        if idx > prev + 1:
            if result:
                result.append("  ...")
        result.append(f"  L{idx + 1:4d} {lines[idx]}")
        prev = idx

    return f"Found {len([i for i, l in enumerate(lines) if any(t in l.lower() for t in terms)])} matching lines:\n" + "\n".join(result)


def smart_truncate(content: str, max_lines: int = 50) -> str:
    """Head + tail truncation preserving first 60% and last 40%."""
    lines = content.split("\n")
    if len(lines) <= max_lines:
        return content

    head_count = int(max_lines * 0.6)
    tail_count = max_lines - head_count
    skipped = len(lines) - head_count - tail_count

    head = "\n".join(f"  L{i + 1:4d} {l}" for i, l in enumerate(lines[:head_count]))
    tail = "\n".join(
        f"  L{len(lines) - tail_count + i + 1:4d} {l}"
        for i, l in enumerate(lines[-tail_count:])
    )

    return f"{head}\n  ... [{skipped} lines truncated] ...\n{tail}"


def main():
    parser = argparse.ArgumentParser(description="Context-efficient file reader")
    parser.add_argument("file", help="File path to read")
    parser.add_argument("--intent", "-i", help="What to look for (filters output)")
    parser.add_argument("--lines", "-n", type=int, default=50, help="Max lines to return (default: 50)")
    parser.add_argument("--structure", "-s", action="store_true", help="Show code structure only")
    parser.add_argument("--range", "-r", help="Line range, e.g. '10-50'")
    args = parser.parse_args()

    path = Path(args.file)
    if not path.exists():
        print(f"ERROR: File not found: {path}", file=sys.stderr)
        sys.exit(1)

    meta = get_file_metadata(path)
    content = path.read_text(encoding="utf-8", errors="replace")

    # Header
    print(f"=== {meta['name']} ({meta['size_human']}, {meta['lines']} lines) ===")

    if args.structure:
        print("\nSTRUCTURE:")
        print(extract_structure(content, meta["extension"]))
        return

    if args.range:
        start, end = map(int, args.range.split("-"))
        lines = content.split("\n")
        for i in range(max(0, start - 1), min(len(lines), end)):
            print(f"  L{i + 1:4d} {lines[i]}")
        return

    if args.intent:
        print(f"\nINTENT: \"{args.intent}\"")
        print(filter_by_intent(content, args.intent))
        if meta["lines"] > 20:
            print(f"\nSTRUCTURE:")
            print(extract_structure(content, meta["extension"]))
        return

    # Default: structure + truncated content
    if meta["lines"] > args.lines:
        print(f"\nSTRUCTURE:")
        print(extract_structure(content, meta["extension"]))
        print(f"\nCONTENT (truncated to {args.lines} lines):")
        print(smart_truncate(content, args.lines))
    else:
        print(f"\nCONTENT:")
        print(content)


if __name__ == "__main__":
    main()
