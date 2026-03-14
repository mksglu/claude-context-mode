#!/usr/bin/env python3
"""ctx_summary.py — Pipe-friendly text summarizer for Antigravity.

Reads text from stdin or a file and returns a compressed version.
Used to reduce command output before it enters the LLM context window.

Usage:
    some_command | python ctx_summary.py [--max-lines N] [--intent "query"]
    python ctx_summary.py input.txt --max-lines 30

Examples:
    git log -n 100 --oneline | python ctx_summary.py --max-lines 20
    npm test 2>&1 | python ctx_summary.py --intent "failures"
    cat big_output.log | python ctx_summary.py --max-lines 40
"""

import argparse
import re
import sys
from collections import Counter


def smart_truncate(lines: list, max_lines: int) -> str:
    """Head 60% + tail 40% truncation."""
    if len(lines) <= max_lines:
        return "\n".join(lines)

    head_n = int(max_lines * 0.6)
    tail_n = max_lines - head_n
    skipped = len(lines) - head_n - tail_n

    head = "\n".join(lines[:head_n])
    tail = "\n".join(lines[-tail_n:])
    return f"{head}\n\n... [{skipped} lines truncated] ...\n\n{tail}"


def filter_by_intent(lines: list, intent: str, context: int = 2) -> list:
    """Return lines matching intent with surrounding context."""
    terms = intent.lower().split()
    matches = set()

    for i, line in enumerate(lines):
        lower = line.lower()
        if any(term in lower for term in terms):
            for j in range(max(0, i - context), min(len(lines), i + context + 1)):
                matches.add(j)

    if not matches:
        return [f"(no lines matched intent: {intent})"]

    result = []
    sorted_matches = sorted(matches)
    prev = -2
    for idx in sorted_matches:
        if idx > prev + 1 and result:
            result.append("...")
        result.append(lines[idx])
        prev = idx

    return result


def extract_key_patterns(lines: list) -> dict:
    """Extract notable patterns from output."""
    stats = {
        "errors": [],
        "warnings": [],
        "passed": 0,
        "failed": 0,
    }

    for line in lines:
        lower = line.lower().strip()
        if re.search(r'\b(error|err|fatal|exception|traceback)\b', lower, re.IGNORECASE):
            if len(stats["errors"]) < 10:
                stats["errors"].append(line.strip()[:120])
        elif re.search(r'\b(warn|warning)\b', lower, re.IGNORECASE):
            if len(stats["warnings"]) < 5:
                stats["warnings"].append(line.strip()[:120])
        elif re.search(r'\bpass(ed)?\b', lower):
            stats["passed"] += 1
        elif re.search(r'\bfail(ed)?\b', lower):
            stats["failed"] += 1

    return stats


def main():
    parser = argparse.ArgumentParser(description="Pipe-friendly text summarizer")
    parser.add_argument("file", nargs="?", help="Input file (reads stdin if omitted)")
    parser.add_argument("--max-lines", "-n", type=int, default=40, help="Max output lines (default: 40)")
    parser.add_argument("--intent", "-i", help="Filter for specific content")
    parser.add_argument("--stats-only", action="store_true", help="Show only extracted stats")
    args = parser.parse_args()

    if args.file:
        with open(args.file, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    else:
        text = sys.stdin.read()

    lines = text.split("\n")
    total = len(lines)
    total_bytes = len(text.encode("utf-8"))

    print(f"=== Input: {total} lines, {total_bytes / 1024:.1f}KB ===")

    # Extract patterns
    patterns = extract_key_patterns(lines)
    if patterns["errors"]:
        print(f"\n🔴 ERRORS ({len(patterns['errors'])}):")
        for e in patterns["errors"][:5]:
            print(f"  {e}")
    if patterns["warnings"]:
        print(f"\n🟡 WARNINGS ({len(patterns['warnings'])}):")
        for w in patterns["warnings"][:3]:
            print(f"  {w}")
    if patterns["passed"] or patterns["failed"]:
        print(f"\n📊 Tests: {patterns['passed']} passed, {patterns['failed']} failed")

    if args.stats_only:
        return

    # Apply intent filter or truncation
    if args.intent:
        print(f"\nFILTERED by \"{args.intent}\":")
        filtered = filter_by_intent(lines, args.intent)
        print("\n".join(filtered[:args.max_lines]))
    else:
        print(f"\nCONTENT:")
        print(smart_truncate(lines, args.max_lines))

    # Footer
    if total > args.max_lines:
        savings = ((total - args.max_lines) / total) * 100
        print(f"\n--- {savings:.0f}% context saved ({total} → {min(total, args.max_lines)} lines) ---")


if __name__ == "__main__":
    main()
