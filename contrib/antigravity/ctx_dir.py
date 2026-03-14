#!/usr/bin/env python3
"""ctx_dir.py — Context-efficient directory listing for Antigravity.

Returns a compact tree with file sizes and key file identification.
Much smaller output than list_dir for large directories.

Usage:
    python ctx_dir.py <directory> [--depth N] [--filter "*.py"] [--stats]

Examples:
    python ctx_dir.py src/ --depth 2
    python ctx_dir.py . --filter "*.ts" --stats
    python ctx_dir.py project/ --depth 3
"""

import argparse
import fnmatch
import os
import sys
from pathlib import Path


def human_size(size_bytes: int) -> str:
    """Convert bytes to human-readable size."""
    if size_bytes < 1024:
        return f"{size_bytes}B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f}KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f}MB"


def count_lines(path: Path) -> int:
    """Count lines in a text file (best-effort)."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return sum(1 for _ in f)
    except Exception:
        return 0


def scan_directory(
    root: Path, depth: int, max_depth: int, pattern: str = None, show_stats: bool = False
) -> list:
    """Recursively scan directory and build compact tree."""
    entries = []
    try:
        items = sorted(root.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError:
        return [("  " * depth + "⛔ (permission denied)", None)]

    dirs = []
    files = []

    for item in items:
        # Skip hidden/generated
        if item.name.startswith(".") and item.name not in (".env", ".gitignore"):
            continue
        if item.name in ("node_modules", "__pycache__", ".git", ".ruff_cache", ".pytest_cache", "venv", ".venv"):
            continue

        if item.is_dir():
            dirs.append(item)
        elif item.is_file():
            if pattern and not fnmatch.fnmatch(item.name, pattern):
                continue
            files.append(item)

    # Format directories
    for d in dirs:
        child_count = sum(1 for _ in d.iterdir()) if d.exists() else 0
        prefix = "  " * depth
        entries.append(f"{prefix}📁 {d.name}/ ({child_count} items)")
        if depth < max_depth:
            entries.extend(scan_directory(d, depth + 1, max_depth, pattern, show_stats))

    # Format files
    for f in files:
        size = f.stat().st_size
        prefix = "  " * depth
        size_str = human_size(size)
        if show_stats and f.suffix in (".py", ".ts", ".js", ".tsx", ".jsx", ".md", ".rs", ".go"):
            lines = count_lines(f)
            entries.append(f"{prefix}📄 {f.name} ({size_str}, {lines}L)")
        else:
            entries.append(f"{prefix}📄 {f.name} ({size_str})")

    return entries


def main():
    parser = argparse.ArgumentParser(description="Context-efficient directory listing")
    parser.add_argument("directory", help="Directory path to scan")
    parser.add_argument("--depth", "-d", type=int, default=2, help="Max depth (default: 2)")
    parser.add_argument("--filter", "-f", help="Glob pattern filter (e.g. '*.py')")
    parser.add_argument("--stats", "-s", action="store_true", help="Show line counts for code files")
    args = parser.parse_args()

    root = Path(args.directory)
    if not root.exists():
        print(f"ERROR: Directory not found: {root}", file=sys.stderr)
        sys.exit(1)

    print(f"=== {root.resolve().name}/ ===")

    # Summary stats
    total_files = sum(1 for _ in root.rglob("*") if _.is_file() and not any(
        p in str(_) for p in ("node_modules", "__pycache__", ".git")
    ))
    total_dirs = sum(1 for _ in root.rglob("*") if _.is_dir() and not any(
        p in str(_) for p in ("node_modules", "__pycache__", ".git")
    ))
    total_size = sum(
        _.stat().st_size for _ in root.rglob("*")
        if _.is_file() and not any(p in str(_) for p in ("node_modules", "__pycache__", ".git"))
    )

    print(f"  {total_files} files, {total_dirs} dirs, {human_size(total_size)} total\n")

    tree = scan_directory(root, 0, args.depth, args.filter, args.stats)
    for line in tree:
        print(line)


if __name__ == "__main__":
    main()
