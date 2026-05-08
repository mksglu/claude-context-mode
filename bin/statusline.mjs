#!/usr/bin/env node
/**
 * context-mode status line — Claude Code statusLine integration.
 *
 * Reads the persisted stats file written by the MCP server and prints a
 * single-line, value-first status string designed for enterprise dev
 * surfaces (Loom demos, Slack screen shares, over-the-shoulder closes).
 *
 * Discipline (Datadog / Stripe / Vercel pattern):
 *   - "context-mode" full brand label, never abbreviated
 *   - ONE chromatic accent (status dot ●), everything else monochrome
 *   - Bold for KPI numbers ($, %), dim for context
 *   - No counts (calls / tokens / events) — only $ and % pass the
 *     value-per-pixel test
 *
 * Wire it up in ~/.claude/settings.json (path-free — uses the bundled CLI
 * forwarder so users don't have to know the absolute install path):
 *   {
 *     "statusLine": {
 *       "type": "command",
 *       "command": "context-mode statusline"
 *     }
 *   }
 *
 * Or, if you prefer to skip the CLI shim, point directly at this file:
 *     "command": "node /absolute/path/to/context-mode/bin/statusline.mjs"
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

// ── Schema versioning ───────────────────────────────────────────────────
// Bumped by the MCP writer (src/server.ts) when the persisted stats payload
// shape changes. Statusline reads `schemaVersion` from the payload:
//   - missing  → legacy v1.0.103 era, proceed with sensible defaults
//   - <= KNOWN → safe to render fully
//   - >  KNOWN → newer writer than this reader; warn once + render what we
//                still understand (graceful degrade rather than blank bar)
const KNOWN_SCHEMA_VERSION = 1;

// Test seams — keep production behaviour identical when env vars unset.
//   CTX_TEST_PLATFORM — override process.platform for cross-OS resolver tests
//   CTX_TEST_PROC_DIR — override /proc base dir for Linux PID-walk tests
const TEST_PLATFORM = process.env.CTX_TEST_PLATFORM;
const PROC_DIR = process.env.CTX_TEST_PROC_DIR || "/proc";
function platform() {
  return TEST_PLATFORM || process.platform;
}

// Single-shot stderr warning latch — keep noise out of Claude Code's
// statusline output even when our parent runs us repeatedly per session.
let __winWarned = false;
function warnOnce(key, msg) {
  if (key === "win" && __winWarned) return;
  if (key === "win") __winWarned = true;
  try { process.stderr.write(`context-mode statusline: ${msg}\n`); } catch { /* ignore */ }
}

// ── ANSI palette (single chromatic accent on the status dot) ────────────
const NO_COLOR = process.env.NO_COLOR || !process.stdout.isTTY;
const ansi = (code, text) => (NO_COLOR ? text : `\x1b[${code}m${text}\x1b[0m`);
const brand = (t) => ansi("1;36", t);   // bold cyan — brand presence
const bold = (t) => ansi("1", t);        // bold default fg — KPI numbers
const dim = (t) => ansi("2", t);         // dim default fg — context
const green = (t) => ansi("32", t);      // healthy dot
const yellow = (t) => ansi("33", t);     // degraded dot
const red = (t) => ansi("31", t);        // stale dot
const SEP = dim("·");

// ── Stats file lookup ────────────────────────────────────────────────────
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
 * the intermediate shell, not Claude Code itself. We walk up until we find
 * a process whose name matches /claude/i.
 *
 * Per-OS resolver:
 *   - linux: read PPid + Name from /proc/<pid>/status
 *   - darwin: ps -o ppid=,comm= -p <pid> (BSD ps; works without /proc)
 *   - win32: degraded — process.ppid only, with a one-shot stderr warning
 *
 * Without this walk, multiple concurrent Claude sessions all see the same
 * shell ppid and collide on the fuzzy mtime fallback in findStatsFile.
 */
function findClaudePid() {
  const plat = platform();
  if (plat === "linux") return findClaudePidLinux();
  if (plat === "darwin") return findClaudePidDarwin();
  if (plat === "win32") {
    warnOnce(
      "win",
      "Windows process-tree walk unsupported; multiple concurrent Claude sessions may collide. Set CLAUDE_SESSION_ID for deterministic resolution.",
    );
    return process.ppid;
  }
  return process.ppid;
}

function findClaudePidLinux() {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid && pid > 1; i++) {
    try {
      const status = readFileSync(`${PROC_DIR}/${pid}/status`, "utf-8");
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

function findClaudePidDarwin() {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid && pid > 1; i++) {
    try {
      // `ps -o ppid=,comm= -p <pid>` → "  12345 /path/to/claude"
      const out = execFileSync(
        "ps",
        ["-o", "ppid=,comm=", "-p", String(pid)],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (!out) return process.ppid;
      const m = out.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) return process.ppid;
      const parentPid = Number(m[1]);
      const comm = m[2].trim();
      // comm may be a path; check basename for claude
      const base = comm.split("/").pop() || comm;
      if (/claude/i.test(base)) return pid;
      pid = parentPid;
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
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object") {
      // schemaVersion is optional — legacy v1.0.103 payloads omit it.
      // Default to 0 so unknown-newer detection still has a clean compare.
      const version = Number.isFinite(parsed.schemaVersion)
        ? parsed.schemaVersion
        : 0;
      if (version > KNOWN_SCHEMA_VERSION) {
        try {
          process.stderr.write(
            `context-mode statusline: stats schemaVersion=${version} newer than known=${KNOWN_SCHEMA_VERSION}; rendering known fields only. Upgrade context-mode to suppress this warning.\n`,
          );
        } catch { /* ignore */ }
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

// ── Formatters ───────────────────────────────────────────────────────────
function fmtUsd(n) {
  const safe = Number.isFinite(n) && n >= 0 ? n : 0;
  if (safe >= 100) return `$${safe.toFixed(0)}`;
  if (safe >= 10) return `$${safe.toFixed(2)}`;
  return `$${safe.toFixed(2)}`;
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

// ── Status dot — the ONE accent ──────────────────────────────────────────
function statusDot(pct, isStale) {
  if (isStale) return red("●");
  if (pct >= 50) return green("●");
  if (pct >= 1) return yellow("●");
  return green("●");
}

// ── Main render ──────────────────────────────────────────────────────────
function main() {
  readStdinJson(); // drain stdin even if unused, keeps Claude Code happy
  const sessionDir = resolveSessionDir();
  const sessionId = resolveSessionId();
  const statsFile = findStatsFile(sessionDir, sessionId);

  // BRAND-NEW — no stats file. Use only the substantiated README headline
  // claim ("saves ~98% of context window"). No fabricated $/dev/month or
  // social-proof numbers we cannot back with data.
  if (!statsFile) {
    process.stdout.write(
      `${brand("context-mode")}  ${green("●")}  ${dim("saves ~98% of context window")}`,
    );
    return;
  }

  const stats = loadStats(statsFile);
  if (!stats) {
    process.stdout.write(
      `${brand("context-mode")}  ${green("●")}  ${dim("saves ~98% of context window")}`,
    );
    return;
  }

  // STALE — stats file >30min old, MCP likely stopped
  const ageMs = Date.now() - (stats.updated_at || 0);
  const stale = ageMs > 30 * 60 * 1000;
  if (stale) {
    process.stdout.write(
      `${brand("context-mode")}  ${red("●")}  ${dim("stale — restart to resume saving")}`,
    );
    return;
  }

  const sessionUsd = stats.dollars_saved_session ?? 0;
  const lifetimeUsd = stats.dollars_saved_lifetime ?? 0;
  const pct = stats.reduction_pct ?? 0;
  const uptime = fmtUptime(stats.uptime_ms ?? 0);
  const dot = statusDot(pct, false);

  // FRESH — no session $ yet, lead with persistence value
  if (sessionUsd === 0) {
    if (lifetimeUsd > 0) {
      // Lifetime $ exists — persistence as primary value, brand-poem echo
      process.stdout.write(
        `${brand("context-mode")}  ${dot}  ${bold(fmtUsd(lifetimeUsd))} ${dim("saved across sessions")}  ${SEP}  ${dim("preserved across compact, restart & upgrade")}`,
      );
    } else {
      // First-ever session, no lifetime data yet — substantiated headline only
      process.stdout.write(
        `${brand("context-mode")}  ${dot}  ${dim("ready — saves ~98% of context window")}`,
      );
    }
    return;
  }

  // ACTIVE / DEGRADED — session $ · [lifetime $ when present] · % efficient · uptime
  // Status dot color encodes degraded vs healthy via pct.
  // Lifetime block is conditional: persistStats omits dollars_saved_lifetime
  // when no analytics aggregator is available, so we degrade gracefully to
  // a session-only render rather than printing "$0.00 saved across sessions".
  const valueBlocks = [
    `${bold(fmtUsd(sessionUsd))} ${dim("saved this session")}`,
  ];
  if (lifetimeUsd > 0) {
    valueBlocks.push(`${bold(fmtUsd(lifetimeUsd))} ${dim("saved across sessions")}`);
  }
  valueBlocks.push(`${bold(`${pct}%`)} ${dim("efficient")}`);
  valueBlocks.push(dim(uptime));

  const head = `${brand("context-mode")}  ${dot}  `;
  const tail = valueBlocks.join(`  ${SEP}  `);
  process.stdout.write(head + tail);
}

main();
