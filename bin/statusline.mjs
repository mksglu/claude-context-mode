#!/usr/bin/env node
/**
 * context-mode status line — Claude Code statusLine integration.
 *
 * Reads JSON session data from stdin (provided by Claude Code), looks up the
 * persisted stats file written by the MCP server, and prints a single-line
 * status string showing live token savings.
 *
 * Wire it up in ~/.claude/settings.json:
 *   {
 *     "statusLine": {
 *       "type": "command",
 *       "command": "node /absolute/path/to/context-mode/bin/statusline.mjs"
 *     }
 *   }
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const NO_COLOR = process.env.NO_COLOR || !process.stdout.isTTY;
const c = (code, text) => (NO_COLOR ? text : `[${code}m${text}[0m`);
const dim = (t) => c("2", t);
const green = (t) => c("32", t);
const yellow = (t) => c("33", t);
const cyan = (t) => c("36", t);
const red = (t) => c("31", t);

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolveSessionDir() {
  if (process.env.CONTEXT_MODE_SESSION_DIR) {
    return process.env.CONTEXT_MODE_SESSION_DIR;
  }
  return join(homedir(), ".claude", "context-mode", "sessions");
}

/**
 * Walk up the parent process chain to find the Claude Code PID.
 *
 * Claude Code spawns the status line through a shell, so process.ppid is
 * the intermediate shell, not Claude Code itself. We follow `PPid:` in
 * /proc/<pid>/status until we find a `claude` process.
 *
 * Falls back to process.ppid when /proc isn't available (non-Linux) or
 * when no claude ancestor is found.
 */
function findClaudePid() {
  if (process.platform !== "linux") return process.ppid;
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid && pid > 1; i++) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf-8");
      const nameMatch = status.match(/^Name:\s+(.+)$/m);
      const ppidMatch = status.match(/^PPid:\s+(\d+)/m);
      const name = nameMatch?.[1]?.trim() ?? "";
      if (/claude/i.test(name)) return pid;
      pid = ppidMatch ? Number(ppidMatch[1]) : 0;
    } catch {
      return process.ppid;
    }
  }
  return process.ppid;
}

function resolveSessionId() {
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  return `pid-${findClaudePid()}`;
}

/**
 * Locate a stats file. First try the exact session id, then fall back to
 * the most recently modified `stats-*.json` in the session dir — that
 * covers the common case of one active session per machine without
 * requiring extra coordination.
 */
function findStatsFile(sessionDir, sessionId) {
  const direct = join(sessionDir, `stats-${sessionId}.json`);
  if (existsSync(direct)) return direct;

  try {
    const candidates = readdirSync(sessionDir)
      .filter((f) => f.startsWith("stats-") && f.endsWith(".json"))
      .map((f) => {
        const full = join(sessionDir, f);
        try {
          return { full, mtime: statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    // Only fall back to a file modified within the last 30 minutes —
    // older files almost always belong to a stopped MCP server.
    const fresh = candidates.find(
      (c) => Date.now() - c.mtime < 30 * 60 * 1000,
    );
    if (fresh) return fresh.full;
  } catch { /* ignore — sessionDir might not exist yet */ }

  return null;
}

function loadStats(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function fmtBytes(b) {
  if (!b || b < 1024) return `${Math.round(b || 0)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function fmtNumber(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtUptime(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h${remMin}m` : `${hr}h`;
}

function ratioColor(pct) {
  if (pct >= 70) return green;
  if (pct >= 30) return yellow;
  if (pct > 0) return cyan;
  return dim;
}

function main() {
  readStdinJson(); // drain stdin even if unused, keeps Claude Code happy
  const sessionDir = resolveSessionDir();
  const sessionId = resolveSessionId();
  const statsFile = findStatsFile(sessionDir, sessionId);

  if (!statsFile) {
    process.stdout.write(dim("[CTX] idle"));
    return;
  }

  const stats = loadStats(statsFile);
  if (!stats) {
    process.stdout.write(dim("[CTX] no data"));
    return;
  }

  const calls = stats.total_calls || 0;
  const pct = stats.reduction_pct || 0;
  const tokensSaved = stats.tokens_saved || 0;
  const keptOut = stats.kept_out || 0;
  const uptime = fmtUptime(stats.uptime_ms || 0);
  const colorize = ratioColor(pct);

  // Stale sentinel: stats file older than 30 min — likely a stopped MCP.
  const ageMs = Date.now() - (stats.updated_at || 0);
  const stale = ageMs > 30 * 60 * 1000;
  const tag = stale ? red("[CTX]") : cyan("[CTX]");

  if (calls === 0) {
    process.stdout.write(`${tag} ${dim("0 calls")} ${dim("·")} ${dim(uptime)}`);
    return;
  }

  const parts = [
    tag,
    `${fmtNumber(calls)} calls`,
    colorize(`${pct}% saved`),
    `${fmtNumber(tokensSaved)} tok`,
    fmtBytes(keptOut),
    dim(uptime),
  ];

  process.stdout.write(parts.join(dim(" · ")));
}

main();
