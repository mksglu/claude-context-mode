/**
 * lifecycle — Process lifecycle guard for MCP server.
 *
 * Detects parent process death (ppid polling) and OS signals to prevent
 * orphaned MCP server processes consuming 100% CPU (issue #103).
 *
 * Stdin close is NOT used as a shutdown signal — the MCP stdio transport
 * owns stdin and transient pipe events cause spurious -32000 errors (#236).
 *
 * Cross-platform: macOS, Linux, Windows.
 */

import { execFileSync } from "node:child_process";

export interface LifecycleGuardOptions {
  /** Interval in ms to check parent liveness. Default: 30_000 */
  checkIntervalMs?: number;
  /** Called when parent death or OS signal is detected. */
  onShutdown: () => void;
  /** Injectable parent-alive check (for testing). Default: ppid-based check. */
  isParentAlive?: () => boolean;
}

/** Read grandparent PID via `ps -o ppid= -p $PPID`. Returns NaN on failure or Windows. */
function readGrandparentPpidImpl(): number {
  if (process.platform === "win32") return NaN;
  const ppid = process.ppid;
  if (!ppid || ppid <= 1) return NaN;
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(ppid)], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : NaN;
  } catch {
    return NaN;
  }
}

/** Injectable dependencies for {@link makeDefaultIsParentAlive}. */
export interface IsParentAliveDeps {
  /** Read the current ppid. Default: `() => process.ppid`. */
  getPpid?: () => number;
  /** Read the grandparent ppid. Default: ps-based POSIX probe, NaN on Windows. */
  readGrandparentPpid?: () => number;
}

/**
 * Build a parent-liveness check that handles the npm-exec wrapper case (#311).
 *
 * A plain ppid comparison misses Claude Code sessions launched via
 * `start.mjs → npm exec → context-mode server`: when Claude Code dies,
 * `start.mjs` reparents to init but `npm exec` stays alive, so the server's
 * direct ppid never changes. We additionally check whether the grandparent
 * process has been reparented to init (PID 1). When the original grandparent
 * was already 1 (daemonized startup) the check is skipped, and on Windows
 * where there's no cheap `ps` equivalent we also skip — so this change is
 * strictly additive to the previous behavior.
 *
 * Exported for unit-testing with injected readers. Production code uses
 * {@link defaultIsParentAlive} (captured once at module load).
 */
export function makeDefaultIsParentAlive(deps: IsParentAliveDeps = {}): () => boolean {
  const getPpid = deps.getPpid ?? (() => process.ppid);
  const readGp = deps.readGrandparentPpid ?? readGrandparentPpidImpl;
  const originalPpid = getPpid();
  const originalGrandparentPpid = readGp();

  return () => {
    const ppid = getPpid();
    if (ppid !== originalPpid) return false;
    if (ppid === 0 || ppid === 1) return false;

    // Grandparent orphan check (#311): npm-exec wrappers stay alive past the
    // session owner. If our grandparent is now PID 1 but wasn't at startup,
    // the wrapping chain is orphaned and we should shut down.
    if (!Number.isNaN(originalGrandparentPpid) && originalGrandparentPpid > 1) {
      if (readGp() === 1) return false;
    }

    return true;
  };
}

const defaultIsParentAlive = makeDefaultIsParentAlive();

/**
 * Start the lifecycle guard. Returns a cleanup function.
 * Skipped automatically when stdin is a TTY (e.g. OpenCode ts-plugin).
 */
export function startLifecycleGuard(opts: LifecycleGuardOptions): () => void {
  const interval = opts.checkIntervalMs ?? 30_000;
  const check = opts.isParentAlive ?? defaultIsParentAlive;
  let stopped = false;

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    opts.onShutdown();
  };

  // P0: Periodic parent liveness check
  const timer = setInterval(() => {
    if (!check()) shutdown();
  }, interval);
  timer.unref();

  // P0: OS signals — terminal close, kill, ctrl+c
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  if (process.platform !== "win32") signals.push("SIGHUP");
  for (const sig of signals) process.on(sig, shutdown);

  return () => {
    stopped = true;
    clearInterval(timer);
    for (const sig of signals) process.removeListener(sig, shutdown);
  };
}
