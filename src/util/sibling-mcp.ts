/**
 * sibling-mcp — discover & terminate previous-version MCP servers.
 *
 * Issue #559: `/ctx-upgrade` historically left the running MCP server
 * alive after copying new files in-place + updating npm global. The next
 * Claude Code launch spawned a fresh process from the new version, but
 * the old one kept its open stdio + DB handles. Across enough upgrades
 * users observed 5+ context-mode `start.mjs` processes pinned to RAM.
 *
 * This module provides two pure helpers:
 *
 *   1. `discoverSiblingMcpPids({ ownPid, ownPpid, platform, runCommand })`
 *      — enumerates node processes whose argv mentions the plugin
 *      `start.mjs` path under `~/.claude/plugins/{cache,marketplaces}/`.
 *      Excludes the caller's own pid + parent pid (Claude Code or the
 *      shell that spawned `/ctx-upgrade`). Cross-platform: POSIX uses
 *      `pgrep -f`, Windows uses PowerShell + Get-CimInstance.
 *
 *   2. `killSiblingMcpServers({ pids, ... })` — sends SIGTERM, polls
 *      liveness, escalates to SIGKILL after `timeoutMs` (default 1500
 *      ms) on stragglers. Returns a kill report so callers can surface
 *      a concise summary without leaking PIDs to user-facing logs.
 *
 * Both helpers accept dependency-injected `runCommand`, `isAlive`, and
 * `sendSignal` parameters so tests can exercise the full behavior tree
 * cross-platform without spawning real processes.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Inject `child_process.execFileSync` for tests. Must return stdout as utf-8. */
export type RunCommand = (cmd: string, args: readonly string[]) => string;

/** Inject `process.kill(pid, 0)` for tests. */
export type IsAlive = (pid: number) => boolean;

/** Inject `process.kill(pid, signal)` for tests. */
export type SendSignal = (pid: number, signal: NodeJS.Signals) => void;

export interface DiscoverOptions {
  ownPid: number;
  ownPpid: number;
  /** `process.platform` injection. Defaults to live process.platform. */
  platform?: NodeJS.Platform;
  /** Test injection point — defaults to `child_process.execFileSync`. */
  runCommand?: RunCommand;
  /**
   * When true, only return pids whose parent (ppid) is the SAME as the
   * caller's own ppid (i.e. siblings under the same host process).
   *
   * Used by the startup sweep (#565) so an opencode-spawned MCP child
   * only reaps OTHER opencode-spawned MCP children, never the children
   * of a different opencode/Claude host running in parallel.
   *
   * Requires a way to read each pid's ppid. Defaults to a `ps -o ppid=`
   * probe on POSIX and PowerShell `Get-CimInstance` on Windows. Set
   * `readPpid` to inject in tests.
   */
  sameParentOnly?: boolean;
  /**
   * In startup sweep mode, also return already-orphaned MCP servers
   * (PPID 0/1). They no longer have a live MCP client, but a stale
   * readiness sentinel can still make hooks believe the server is usable.
   */
  includeOrphans?: boolean;
  /** Test injection — read ppid for a given pid. Defaults to platform probe. */
  readPpid?: (pid: number) => number;
}

export interface KillOptions {
  pids: readonly number[];
  /** Time to wait for SIGTERM to take effect before escalating. */
  timeoutMs?: number;
  /** Poll interval while waiting for SIGTERM. */
  pollIntervalMs?: number;
  isAlive?: IsAlive;
  sendSignal?: SendSignal;
}

export interface KillReport {
  /** PIDs that died after SIGTERM within `timeoutMs`. */
  terminatedBySigterm: number;
  /** PIDs that required SIGKILL escalation. */
  terminatedBySigkill: number;
  /** Sum of the two — used by the cli summary line. */
  totalKilled: number;
}

export interface CodexHostDetectionOptions {
  /** `process.platform` injection. Defaults to live process.platform. */
  platform?: NodeJS.Platform;
  /** Parent process id to inspect. Defaults to live process.ppid. */
  ppid?: number;
  /** Test injection point — defaults to `child_process.execFileSync`. */
  runCommand?: RunCommand;
  /** Test injection for `.codex/tmp/arg0`. Defaults to `fs.readFileSync`. */
  readFile?: (path: string) => string;
  /** Extra explicit arg0 marker path for tests or alternate hosts. */
  arg0Path?: string;
}

// Match every shape an installed context-mode MCP server can take in argv:
//
//   1. `~/.claude/plugins/cache/context-mode/context-mode/<v>/start.mjs`
//      and `~/.claude/plugins/marketplaces/context-mode/start.mjs` — Claude
//      Code plugin shapes (original #559 case).
//   2. `<prefix>/node_modules/context-mode/start.mjs` or `.../server.bundle.mjs`
//      — npm-global, marketplace, manual installs.
//   3. `<prefix>/bin/context-mode` — npm-global bin shim. This is the argv
//      OpenCode + KiloCode see when they spawn `mcp.command = ["context-mode"]`.
//      Without this entry, sibling discovery missed the 26-child / 1.6 GB
//      RSS accumulation reported in #565.
//   4. `bun .../context-mode/server.bundle.mjs` — Pi/Bun hosts.
//
// All four can be alive concurrently — VERDICT R1 dump confirmed multi-version
// coexistence on real macOS, and #565 confirmed concurrent OpenCode children
// alongside Claude Code children on Linux.
const POSIX_PGREP_PATTERN =
  "(node|bun).*(plugins/(cache|marketplaces)/.*context-mode.*start\\.mjs" +
  "|context-mode/start\\.mjs" +
  "|context-mode/server\\.bundle\\.mjs" +
  "|bin/context-mode($|[^a-zA-Z0-9_-]))";

// Windows: PowerShell + Get-CimInstance (wmic deprecated since Win11 22H2).
// Filter includes both node.exe and bun.exe (Pi/Bun hosts). CommandLine
// matching covers the same four install shapes as POSIX_PGREP_PATTERN.
const WIN_PS_SCRIPT =
  "Get-CimInstance Win32_Process " +
  "-Filter \"Name='node.exe' OR Name='bun.exe'\" | " +
  "Where-Object { $_.CommandLine -match " +
  "'plugins[\\\\/](cache|marketplaces)[\\\\/].*context-mode.*start\\.mjs" +
  "|context-mode[\\\\/]start\\.mjs" +
  "|context-mode[\\\\/]server\\.bundle\\.mjs" +
  "|bin[\\\\/]context-mode($|[^a-zA-Z0-9_-])' } | " +
  "Select-Object -ExpandProperty ProcessId";

/** POSIX ppid probe — empty / NaN on failure. */
function readPpidPosix(pid: number): number {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : NaN;
  } catch {
    return NaN;
  }
}

/** Windows ppid probe — empty / NaN on failure. */
function readPpidWin32(pid: number): number {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
      ],
      { encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : NaN;
  } catch {
    return NaN;
  }
}

function defaultReadPpid(pid: number): number {
  return process.platform === "win32" ? readPpidWin32(pid) : readPpidPosix(pid);
}

const defaultRun: RunCommand = (cmd, args) =>
  execFileSync(cmd, [...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });

const defaultReadFile = (path: string): string => readFileSync(path, "utf-8");

const defaultIsAlive: IsAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const defaultSendSignal: SendSignal = (pid, sig) => {
  // Throws ESRCH if the process is already dead — callers must swallow.
  process.kill(pid, sig);
};

function isTruthyEnv(value: string | undefined): boolean {
  const raw = String(value ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function isFalsyEnv(value: string | undefined): boolean {
  const raw = String(value ?? "").toLowerCase();
  return raw === "0" || raw === "false" || raw === "no";
}

function looksLikeCodexHost(value: string | undefined): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  const normalized = raw.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("@openai/codex")) return true;
  if (normalized.includes("codex.system")) return true;
  if (normalized.includes("/.codex/tmp/arg0")) return true;
  return /(^|[\s/])codex($|[\s/.-])/.test(normalized);
}

function readProcessCommandLine(
  pid: number,
  platform: NodeJS.Platform,
  run: RunCommand,
): string {
  try {
    if (!Number.isFinite(pid) || pid <= 0) return "";
    if (platform === "win32") {
      return run("powershell", [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ]);
    }
    return run("ps", ["-o", "command=", "-p", String(pid)]);
  } catch {
    return "";
  }
}

function codexArg0Paths(env: NodeJS.ProcessEnv, explicit?: string): string[] {
  const paths = new Set<string>();
  if (explicit) paths.add(explicit);
  if (env.CODEX_HOME) paths.add(join(env.CODEX_HOME, "tmp", "arg0"));
  if (env.HOME) paths.add(join(env.HOME, ".codex", "tmp", "arg0"));
  if (env.USERPROFILE) paths.add(join(env.USERPROFILE, ".codex", "tmp", "arg0"));
  return [...paths];
}

export function isCodexFixedTransportHost(
  env: NodeJS.ProcessEnv = process.env,
  opts: CodexHostDetectionOptions = {},
): boolean {
  if (String(env.CONTEXT_MODE_PLATFORM ?? "").toLowerCase() === "codex") return true;
  if (env.CODEX_THREAD_ID || env.CODEX_CI) return true;

  const platform = opts.platform ?? process.platform;
  const run = opts.runCommand ?? defaultRun;
  const ppid = opts.ppid ?? process.ppid;
  if (looksLikeCodexHost(readProcessCommandLine(ppid, platform, run))) return true;

  const readFile = opts.readFile ?? defaultReadFile;
  for (const arg0Path of codexArg0Paths(env, opts.arg0Path)) {
    try {
      if (looksLikeCodexHost(readFile(arg0Path))) return true;
      if (looksLikeCodexHost(arg0Path)) return true;
    } catch {
      // Missing/unreadable arg0 marker is normal outside Codex.
    }
  }
  return false;
}

/**
 * Parse newline-separated PID output. Tolerates header rows
 * (`ProcessId`, `----------`), surrounding whitespace, and empty lines.
 * Returns deduplicated, validated integers only.
 */
function parsePidList(stdout: string): number[] {
  const seen = new Set<number>();
  for (const raw of stdout.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!/^\d+$/.test(trimmed)) continue;
    const n = Number.parseInt(trimmed, 10);
    if (Number.isFinite(n) && n > 0) seen.add(n);
  }
  return [...seen];
}

/**
 * Enumerate node MCP-server processes spawned from this plugin's
 * start.mjs. Always returns an empty array on tool absence — never
 * throws — so an upgrade is never blocked by a missing pgrep/PowerShell.
 */
export function discoverSiblingMcpPids(opts: DiscoverOptions): number[] {
  const platform = opts.platform ?? process.platform;
  const run = opts.runCommand ?? defaultRun;

  let stdout = "";
  try {
    if (platform === "win32") {
      stdout = run("powershell", ["-NoProfile", "-Command", WIN_PS_SCRIPT]);
    } else {
      // pgrep exits 1 when no matches; execFileSync throws on non-zero.
      // Treat that as "no siblings" rather than an error.
      stdout = run("pgrep", ["-f", POSIX_PGREP_PATTERN]);
    }
  } catch {
    return [];
  }

  const candidates = parsePidList(stdout).filter(
    (pid) => pid !== opts.ownPid && pid !== opts.ownPpid,
  );

  if (!opts.sameParentOnly) return candidates;

  // Startup-sweep mode (#565): only reap siblings sharing OUR ppid. This
  // prevents an opencode-spawned MCP child from killing a Claude Code MCP
  // child (or another concurrent opencode host's children) when both are
  // present on the same machine. With includeOrphans, also reap PPID 0/1
  // processes: a stdio MCP server with no parent cannot have a live client.
  const readPpid = opts.readPpid ?? defaultReadPpid;
  return candidates.filter((pid) => {
    const ppid = readPpid(pid);
    return Number.isFinite(ppid) &&
      (ppid === opts.ownPpid || (opts.includeOrphans === true && ppid <= 1));
  });
}

/** Sleep helper — Promise-based for use inside the kill polling loop. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Send SIGTERM to each PID, then poll for liveness. PIDs still alive
 * after `timeoutMs` receive SIGKILL. Returns a per-signal report.
 *
 * Algorithm:
 *   1. Fire SIGTERM at every pid (swallow ESRCH — already dead).
 *   2. Poll every `pollIntervalMs` until either all pids are dead
 *      OR `timeoutMs` elapses.
 *   3. For survivors: SIGKILL (swallow ESRCH).
 *   4. Count via "died-while-we-watched": only PIDs that were observed
 *      alive at any point and then died are reported. PIDs that were
 *      already dead before SIGTERM (ESRCH on first send) are not
 *      counted — they were not ours to kill.
 */
export async function killSiblingMcpServers(
  opts: KillOptions,
): Promise<KillReport> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const sendSignal = opts.sendSignal ?? defaultSendSignal;

  const empty: KillReport = { terminatedBySigterm: 0, terminatedBySigkill: 0, totalKilled: 0 };
  if (opts.pids.length === 0) return empty;

  // Track which PIDs we observed alive — we only count those.
  const observedAlive = new Set<number>();
  const pendingTerm = new Set<number>();

  // Phase 1 — SIGTERM fan-out.
  for (const pid of opts.pids) {
    if (isAlive(pid)) {
      observedAlive.add(pid);
      pendingTerm.add(pid);
    }
    try {
      sendSignal(pid, "SIGTERM");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ESRCH") {
        // Permission errors etc. — drop from pending; cannot kill.
        pendingTerm.delete(pid);
      }
    }
  }

  // Phase 2 — poll until either all dead or timeout.
  const deadline = Date.now() + timeoutMs;
  let terminatedBySigterm = 0;
  while (pendingTerm.size > 0 && Date.now() < deadline) {
    await delay(pollIntervalMs);
    for (const pid of [...pendingTerm]) {
      if (!isAlive(pid)) {
        pendingTerm.delete(pid);
        terminatedBySigterm++;
      }
    }
  }

  // Phase 3 — SIGKILL survivors.
  let terminatedBySigkill = 0;
  for (const pid of pendingTerm) {
    try {
      sendSignal(pid, "SIGKILL");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ESRCH") {
        // Died between the last poll and SIGKILL — count as SIGTERM win.
        terminatedBySigterm++;
        continue;
      }
      // Other error: skip — best-effort.
      continue;
    }
    if (observedAlive.has(pid)) terminatedBySigkill++;
  }

  return {
    terminatedBySigterm,
    terminatedBySigkill,
    totalKilled: terminatedBySigterm + terminatedBySigkill,
  };
}

/**
 * Startup-time sibling sweep (#565).
 *
 * Discovers any context-mode MCP server pids that share OUR parent process
 * (i.e. other MCP children of the same host like `opencode serve`) and
 * terminates them. The intent is "exactly one MCP child per host" — when a
 * new MCP client spawns inside an opencode host that already has 25 stale
 * idle siblings, this sweep reclaims them at boot rather than waiting for
 * the idle timeout to fire on each one independently.
 *
 * Gated by env (default-on but easy to disable):
 *
 *   CONTEXT_MODE_STARTUP_SWEEP=0         → disabled
 *   CONTEXT_MODE_STARTUP_SWEEP=1         → enabled for non-Codex hosts
 *   CONTEXT_MODE_STARTUP_SWEEP_FORCE=1   → enabled even for Codex
 *
 * Safety:
 *   - Codex default: disabled because Codex keeps a fixed MCP transport per
 *     thread; if another same-parent thread kills it, later calls fail with
 *     "Transport closed" instead of spawning a replacement.
 *   - `sameParentOnly: true` — never touches MCP children of a different host.
 *   - Orphans (PPID 0/1) are safe to reap: their stdio client is gone.
 *   - Best-effort throughout: failures never block server startup.
 *   - Composes with the idle-timeout path: if a sibling is actively in use
 *     by another session, the parent process will simply spawn a new MCP
 *     child on its next request. The cost is one cold-start (~1–3 s) for
 *     that session, which is identical to opencode's existing behaviour
 *     of spawning a fresh MCP child per session anyway.
 */
export async function startupSiblingSweep(
  env: NodeJS.ProcessEnv = process.env,
): Promise<KillReport> {
  const empty: KillReport = { terminatedBySigterm: 0, terminatedBySigkill: 0, totalKilled: 0 };
  if (!shouldRunStartupSiblingSweep(env)) return empty;

  try {
    const pids = discoverSiblingMcpPids({
      ownPid: process.pid,
      ownPpid: process.ppid,
      sameParentOnly: true,
      includeOrphans: true,
    });
    if (pids.length === 0) return empty;
    return await killSiblingMcpServers({ pids });
  } catch {
    return empty;
  }
}

export function shouldRunStartupSiblingSweep(
  env: NodeJS.ProcessEnv = process.env,
  opts: CodexHostDetectionOptions = {},
): boolean {
  if (isTruthyEnv(env.CONTEXT_MODE_STARTUP_SWEEP_FORCE)) return true;

  // Codex keeps a fixed stdio transport for the thread. Killing a same-parent
  // sibling from another Codex thread leaves that thread with Transport closed
  // instead of forcing Codex to spawn a replacement. Native Codex env markers
  // and parent-process markers are available before MCP clientInfo can be read.
  if (isCodexFixedTransportHost(env, opts)) return false;

  if (isFalsyEnv(env.CONTEXT_MODE_STARTUP_SWEEP)) return false;
  if (isTruthyEnv(env.CONTEXT_MODE_STARTUP_SWEEP)) return true;
  return true;
}
