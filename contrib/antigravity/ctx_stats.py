"""
ctx_stats.py — Context Usage Statistics Tracker

Tracks raw bytes vs. compressed bytes for each tool call,
calculates savings, and reports session-level statistics.
"""

import json
import time
from pathlib import Path
from typing import Optional


class ContextTracker:
    """Tracks context usage and savings across a session."""

    def __init__(self):
        self.calls: list[dict] = []
        self.session_start = time.time()

    def record(self, tool_name: str, raw_bytes: int, context_bytes: int,
               description: str = ""):
        """Record a tool call's context usage."""
        self.calls.append({
            "tool": tool_name,
            "raw_bytes": raw_bytes,
            "context_bytes": context_bytes,
            "saved_bytes": raw_bytes - context_bytes,
            "savings_pct": round((1 - context_bytes / max(raw_bytes, 1)) * 100, 1),
            "description": description,
            "timestamp": time.time(),
        })

    def get_stats(self) -> dict:
        """Get aggregate statistics."""
        if not self.calls:
            return {
                "total_calls": 0,
                "total_raw_bytes": 0,
                "total_context_bytes": 0,
                "total_saved_bytes": 0,
                "overall_savings_pct": 0,
                "session_duration_min": 0,
                "by_tool": {},
            }

        total_raw = sum(c["raw_bytes"] for c in self.calls)
        total_ctx = sum(c["context_bytes"] for c in self.calls)
        total_saved = total_raw - total_ctx

        # Per-tool breakdown
        by_tool: dict[str, dict] = {}
        for c in self.calls:
            tool = c["tool"]
            if tool not in by_tool:
                by_tool[tool] = {"calls": 0, "raw_bytes": 0, "context_bytes": 0}
            by_tool[tool]["calls"] += 1
            by_tool[tool]["raw_bytes"] += c["raw_bytes"]
            by_tool[tool]["context_bytes"] += c["context_bytes"]

        for tool in by_tool:
            raw = by_tool[tool]["raw_bytes"]
            ctx = by_tool[tool]["context_bytes"]
            by_tool[tool]["saved_bytes"] = raw - ctx
            by_tool[tool]["savings_pct"] = round((1 - ctx / max(raw, 1)) * 100, 1)

        duration = (time.time() - self.session_start) / 60

        return {
            "total_calls": len(self.calls),
            "total_raw_bytes": total_raw,
            "total_context_bytes": total_ctx,
            "total_saved_bytes": total_saved,
            "overall_savings_pct": round((1 - total_ctx / max(total_raw, 1)) * 100, 1),
            "session_duration_min": round(duration, 1),
            "total_raw_kb": round(total_raw / 1024, 1),
            "total_context_kb": round(total_ctx / 1024, 1),
            "total_saved_kb": round(total_saved / 1024, 1),
            "by_tool": by_tool,
        }

    def format_report(self) -> str:
        """Generate a human-readable report."""
        stats = self.get_stats()

        lines = [
            "=== Context Usage Report ===",
            f"Session duration: {stats['session_duration_min']} min",
            f"Total tool calls: {stats['total_calls']}",
            f"",
            f"  Raw data:     {stats.get('total_raw_kb', 0):>8.1f} KB",
            f"  In context:   {stats.get('total_context_kb', 0):>8.1f} KB",
            f"  Saved:        {stats.get('total_saved_kb', 0):>8.1f} KB ({stats['overall_savings_pct']}%)",
            f"",
            f"--- Per-Tool Breakdown ---",
        ]

        for tool, data in sorted(stats["by_tool"].items(), key=lambda x: -x[1]["saved_bytes"]):
            raw_kb = data["raw_bytes"] / 1024
            ctx_kb = data["context_bytes"] / 1024
            lines.append(
                f"  {tool:30s} {data['calls']:>3d} calls  "
                f"{raw_kb:>7.1f}KB → {ctx_kb:>7.1f}KB  ({data['savings_pct']}% saved)"
            )

        # Top 5 biggest saves
        if self.calls:
            sorted_calls = sorted(self.calls, key=lambda c: -c["saved_bytes"])[:5]
            lines.append(f"\n--- Top Saves ---")
            for c in sorted_calls:
                if c["saved_bytes"] > 0:
                    lines.append(
                        f"  {c['tool']:20s} {c['raw_bytes']/1024:.1f}KB → "
                        f"{c['context_bytes']/1024:.1f}KB  "
                        f"({c['savings_pct']}%) {c['description'][:40]}"
                    )

        return "\n".join(lines)


# ── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Demo
    tracker = ContextTracker()

    # Simulate a session
    tracker.record("view_file", 15360, 2048, "server.ts via ctx_read --structure")
    tracker.record("view_file", 8192, 8192, "small config file (raw)")
    tracker.record("view_file", 66560, 6800, "server.ts via ctx_read --intent security")
    tracker.record("list_dir", 4096, 1400, "src/ via ctx_dir --depth 2")
    tracker.record("run_command", 25600, 1500, "npm test via ctx_summary")
    tracker.record("run_command", 2048, 2048, "small command (raw)")
    tracker.record("read_url_content", 56200, 300, "playwright snapshot summarized")
    tracker.record("grep_search", 3072, 3072, "grep results (raw)")

    print(tracker.format_report())
