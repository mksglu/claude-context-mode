#!/usr/bin/env node
/**
 * context-mode status line — Claude Code statusLine integration.
 *
 * Reads stats DIRECTLY from SessionDB (`session_events` + `session_resume`),
 * mirroring the `ctx_stats` MCP handler at src/server.ts:2807-2891 so the
 * statusline and ctx_stats never drift. The legacy per-PID sidecar JSON
 * (`stats-pid-*.json`) is no longer the source of truth — sidecars were
 * eventually-consistent (500ms+30s throttles) and PID-scoped (multiple
 * Claude sessions colliding on the same shell ppid).
 *
 * Discipline (Datadog / Stripe / Vercel pattern):
 *   - "context-mode" full brand label, never abbreviated
 *   - ONE chromatic accent (status dot ●), everything else monochrome
 *   - Bold for KPI numbers ($, %), dim for context
 *   - No counts (calls / tokens / events) — only $ and % pass the
 *     value-per-pixel test
 *
 * Wire it up in ~/.claude/settings.json:
 *   {
 *     "statusLine": {
 *       "type": "command",
 *       "command": "context-mode statusline"
 *     }
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

// ── Analytics import — resolved relative to this script ─────────────────
// statusline.mjs ships in `bin/`; the compiled analytics module lives in
// `build/session/analytics.js`. Import lazily so a missing build doesn't
// crash the renderer — degrade to the substantiated headline instead.
//
// The dynamic import target MUST be a `file://` URL on Windows. Node's
// ESM loader rejects absolute drive-letter paths (`C:\...`) with
// ERR_UNSUPPORTED_ESM_URL_SCHEME — which the catch below silently
// swallows, leaving `_analytics = null` and rendering the empty-state
// headline forever. Convert to a file URL so Windows accepts it.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ANALYTICS_PATH = resolve(__dirname, "..", "build", "session", "analytics.js");
const ANALYTICS_URL = pathToFileURL(ANALYTICS_PATH).href;

let _analytics = null;
async function loadAnalytics() {
  if (_analytics) return _analytics;
  try {
    _analytics = await import(ANALYTICS_URL);
  } catch {
    _analytics = null;
  }
  return _analytics;
}

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

// ── Stdin drain ─────────────────────────────────────────────────────────
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
 * shell ppid and collide on per-PID stats lookup.
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

// ── Formatters ───────────────────────────────────────────────────────────
function fmtUsd(n) {
  const safe = Number.isFinite(n) && n >= 0 ? n : 0;
  if (safe >= 100) return `$${safe.toFixed(0)}`;
  return `$${safe.toFixed(2)}`;
}

// ── Status dot — the ONE accent ──────────────────────────────────────────
function statusDot(pct) {
  if (pct >= 50) return green("●");
  if (pct >= 1) return yellow("●");
  return green("●");
}

// ── Main render ──────────────────────────────────────────────────────────
async function main() {
  readStdinJson(); // drain stdin even if unused, keeps Claude Code happy
  const sessionsDir = resolveSessionDir();
  const sessionId = resolveSessionId();

  const analytics = await loadAnalytics();

  // BRAND-NEW / build missing — substantiated headline only
  if (!analytics) {
    process.stdout.write(
      `${brand("context-mode")}  ${green("●")}  ${dim("saves ~98% of context window")}`,
    );
    return;
  }

  const {
    getRealBytesStats,
    getMultiAdapterLifetimeStats,
    kb,
  } = analytics;

  // Sessions dir doesn't exist yet — first ever launch
  if (!existsSync(sessionsDir)) {
    process.stdout.write(
      `${brand("context-mode")}  ${green("●")}  ${dim("saves ~98% of context window")}`,
    );
    return;
  }

  // Lifetime real-bytes across this adapter's sessions dir.
  // Mirrors src/server.ts:2860 — the same call ctx_stats uses.
  let lifetime;
  try {
    lifetime = getRealBytesStats({ sessionsDir });
  } catch {
    lifetime = null;
  }

  // Per-conversation real-bytes for the session $ KPI.
  // Statusline doesn't know the worktree hash, so scan every db in the
  // dir and let getRealBytesStats filter by sessionId.
  let conversation;
  try {
    conversation = getRealBytesStats({ sessionsDir, sessionId });
  } catch {
    conversation = null;
  }

  // Cross-adapter lifetime — drives the "across N tools" headline when
  // 2+ real adapters are present. Mirrors src/server.ts:2840.
  let multi;
  try {
    multi = getMultiAdapterLifetimeStats();
  } catch {
    multi = null;
  }

  // v1.0.118: drop the $ math — ctx_stats's narrative renderer is the source
  // of truth and uses byte-based metrics. Statusline mirrors the same
  // formulas so the two displays never diverge again.
  //
  // Lifetime bytes — multi-adapter aggregate when present, else local-DB
  // real bytes. Mirrors src/session/analytics.ts:1684 narrative renderer.
  const lifetimeBytes = (multi?.totalBytes && multi.totalBytes > 0)
    ? multi.totalBytes
    : (lifetime?.totalSavedTokens ?? 0) * 4;

  // This-chat bytes — real bytes accounting (data + bytes-avoided + snapshot).
  const sessionBytes = conversation
    ? ((conversation.eventDataBytes ?? 0)
       + (conversation.bytesAvoided ?? 0)
       + (conversation.snapshotBytes ?? 0))
    : 0;

  // Per-day average — same lifetime-day computation ctx_stats opener uses.
  const sinceMs = lifetime?.firstEventMs ?? multi?.perAdapter?.[0]?.firstMs ?? 0;
  const lifetimeDays = sinceMs > 0
    ? Math.max(1, Math.round((Date.now() - sinceMs) / 86_400_000))
    : 0;
  const perDayBytes = lifetimeDays > 0 ? lifetimeBytes / lifetimeDays : 0;

  // Reduction % — same as before (bytes-avoided + snapshot vs returned).
  const totalReturned = lifetime?.bytesReturned ?? 0;
  const totalKept =
    (lifetime?.bytesAvoided ?? 0)
    + (lifetime?.snapshotBytes ?? 0)
    + (lifetime?.eventDataBytes ?? 0);
  const totalProcessed = totalKept + totalReturned;
  const pct = totalProcessed > 0
    ? Math.round((totalKept / totalProcessed) * 100)
    : 0;

  const dot = statusDot(pct);

  // Cross-tool count — used in the headline when 2+ real adapters detected.
  const realAdapters = (multi?.perAdapter ?? []).filter((a) => a?.isReal);
  const showMultiAdapter = realAdapters.length >= 2;

  // BRAND-NEW: no data at all → marketing headline.
  if (lifetimeBytes === 0 && sessionBytes === 0) {
    process.stdout.write(
      `${brand("context-mode")}  ${green("●")}  ${dim("saves ~98% of context window")}`,
    );
    return;
  }

  // FRESH session, no this-chat data yet — lead with lifetime number.
  if (sessionBytes === 0 && lifetimeBytes > 0) {
    const blocks = [`${bold(kb(lifetimeBytes))} ${dim("kept out")}`];
    if (perDayBytes > 0) {
      blocks.push(`${bold(kb(perDayBytes) + "/day")}`);
    }
    if (showMultiAdapter) {
      blocks.push(`${dim(`across ${realAdapters.length} tools`)}`);
    }
    blocks.push(dim("preserved across compact, restart & upgrade"));
    process.stdout.write(
      `${brand("context-mode")}  ${dot}  ${blocks.join(`  ${SEP}  `)}`,
    );
    return;
  }

  // ACTIVE: this-chat · lifetime · [N tools] · % efficient
  const valueBlocks = [
    `${bold(kb(sessionBytes))} ${dim("this chat")}`,
  ];
  if (lifetimeBytes > 0) {
    valueBlocks.push(`${bold(kb(lifetimeBytes))} ${dim("lifetime")}`);
  }
  if (showMultiAdapter) {
    valueBlocks.push(`${dim(`across ${realAdapters.length} tools`)}`);
  }
  if (pct > 0) {
    valueBlocks.push(`${bold(`${pct}%`)} ${dim("kept out")}`);
  }

  const head = `${brand("context-mode")}  ${dot}  `;
  const tail = valueBlocks.join(`  ${SEP}  `);
  process.stdout.write(head + tail);
}

main().catch(() => {
  // Last-resort fallback — a thrown error must never produce a blank statusline.
  try {
    process.stdout.write(
      `${brand("context-mode")}  ${green("●")}  ${dim("saves ~98% of context window")}`,
    );
  } catch { /* ignore */ }
});
