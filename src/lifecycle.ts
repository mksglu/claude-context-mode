/**
 * lifecycle — Process lifecycle guard for MCP server.
 *
 * Detects parent process death (ppid polling) and OS signals to prevent
 * orphaned MCP server processes consuming 100% CPU (issue #103).
 *
 * Stdin close is NOT used as a *standalone* shutdown signal — the MCP stdio
 * transport owns stdin and transient pipe events cause spurious -32000
 * errors (#236). We do, however, treat stdin EOF as a hint to re-run the
 * parent-liveness probe immediately (instead of waiting up to 30 s for the
 * next poll tick), which closes the multi-day CPU-spin window seen in
 * #311/#388 without reintroducing the false-positive shutdowns of #236.
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
  /**
   * Idle shutdown threshold in ms (#565). When the server has handled no
   * MCP activity for this long, `onShutdown` fires. `0` disables.
   * Default: env `CONTEXT_MODE_IDLE_TIMEOUT_MS`, else 0 (disabled).
   * Skipped on TTY stdin (interactive dev / OpenCode ts-plugin standalone).
   *
   * Pair with the returned `recordActivity()` callback — call it on every
   * MCP request the server handles so genuinely busy servers never trip.
   */
  idleTimeoutMs?: number;
  /** Test injection — defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Hybrid return type: callable like the original `() => void` cleanup (kept
 * for backwards compatibility with #103/#236/#311/#388/#534 test suites),
 * and additionally exposes `recordActivity` for the idle-timeout path (#565)
 * and `stop` as an explicit alias.
 */
export interface LifecycleGuardHandle {
  /** Stop the guard. Calling the handle directly is equivalent. */
  (): void;
  /** Bumps the "last activity" timestamp so the idle timer doesn't fire. */
  recordActivity: () => void;
  /** Stop the guard. Alias for invoking the handle. */
  stop: () => void;
}

/**
 * Resolve the idle-shutdown threshold (#565).
 *
 * Idle shutdown is OFF by default (#592) because most hosts (Claude
 * Code, Codex, editor MCP clients) keep registered tool handles after a
 * clean MCP child exit and do NOT transparently respawn on the next call.
 * The global 15 min default introduced in #568 solved OpenCode's child
 * accumulation, but stranded ctx_* tools in Claude Code/Codex-style
 * hosts once the MCP server exited cleanly while the editor stayed alive.
 *
 * Hosts that are known to benefit from idle shutdown MUST opt in via
 * CONTEXT_MODE_IDLE_TIMEOUT_MS in their MCP config. Today that is
 * OpenCode/KiloCode (their configs set 900000 = 15 min). Users and test
 * harnesses can also opt in explicitly with any positive integer.
 *
 * Missing or malformed env = 0 (disabled, safe default). Set env to
 * `0` to disable explicitly.
 *
 * Exported for unit-testing.
 */
export function idleTimeoutForEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.CONTEXT_MODE_IDLE_TIMEOUT_MS;
  if (raw === undefined) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
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
 * Resolve the parent-liveness poll interval based on context (#534).
 *
 * When this process is the MCP bridge child spawned by the Pi adapter
 * (`bootstrapMCPTools` in `src/adapters/pi/mcp-bridge.ts` sets
 * `CONTEXT_MODE_BRIDGE_DEPTH=1` in the child env), we tighten the poll to
 * 1 s. The Pi parent can disappear in under 50 ms (`pi --help` prints
 * usage and returns), so the default 30 s window leaves a long-lived
 * CPU-spinning orphan. For top-level MCP servers (depth 0 / absent) we
 * keep the original 30 s cadence — the existing #311/#388 ppid + stdin
 * recovery paths already cover Claude Code style hosts.
 *
 * Exported for unit-testing.
 */
export function lifecycleGuardIntervalForEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.CONTEXT_MODE_BRIDGE_DEPTH;
  if (raw === undefined) return 30_000;
  const depth = Number.parseInt(raw, 10);
  if (!Number.isFinite(depth) || depth <= 0) return 30_000;
  return 1000;
}

/**
 * Start the lifecycle guard. Returns a handle with `recordActivity` (call
 * on every MCP request to keep idle timer from firing) and `stop`.
 *
 * Skipped automatically when stdin is a TTY (e.g. OpenCode ts-plugin).
 */
export function startLifecycleGuard(opts: LifecycleGuardOptions): LifecycleGuardHandle {
  const interval = opts.checkIntervalMs ?? lifecycleGuardIntervalForEnv();
  const check = opts.isParentAlive ?? defaultIsParentAlive;
  const idleTimeoutMs = opts.idleTimeoutMs ?? idleTimeoutForEnv();
  const now = opts.now ?? Date.now;
  let stopped = false;
  let lastActivity = now();

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    opts.onShutdown();
  };

  const recordActivity = () => {
    lastActivity = now();
  };

  // P0: Periodic parent liveness check.
  const timer = setInterval(() => {
    if (!check()) shutdown();
  }, interval);
  timer.unref();

  // P0+: Idle shutdown (#565). Runs on its OWN tick — distinct from the
  // 30 s parent-liveness poll — so a 15 min idle timeout actually reacts
  // close to 15 min instead of "next 30 s tick after 15 min". Pick the
  // tick as min(idleTimeoutMs / 6, 30 s) so a short timeout (e.g. 3 s in
  // e2e tests, 60 s in dev) reacts within ~16 % of its window while a
  // production 15 min timeout still polls every 30 s (cheap).
  //
  // Skipped on TTY because interactive dev sessions are expected to
  // sit idle between commands, and also when idleTimeoutMs is 0 (env
  // opt-out via CONTEXT_MODE_IDLE_TIMEOUT_MS=0).
  let idleTimer: NodeJS.Timeout | null = null;
  if (idleTimeoutMs > 0 && !process.stdin.isTTY) {
    const idleTick = Math.max(50, Math.min(Math.floor(idleTimeoutMs / 6), 30_000));
    idleTimer = setInterval(() => {
      if (now() - lastActivity > idleTimeoutMs) shutdown();
    }, idleTick);
    idleTimer.unref();
  }

  // P0: OS signals — terminal close, kill, ctrl+c
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  if (process.platform !== "win32") signals.push("SIGHUP");
  for (const sig of signals) process.on(sig, shutdown);

  // P0: Stdin-EOF assist (#311/#388). The vendored MCP SDK's
  // StdioServerTransport only registers 'data' / 'error' listeners — not
  // 'end' — so when the parent (e.g. Claude Code) dies abruptly without
  // sending SIGTERM, the server keeps reading from a half-closed pipe and
  // CPU-spins until the 30 s ppid poll catches up. Observed in #388 with
  // single processes accumulating ~80 h of CPU time before SIGKILL.
  //
  // We deliberately DO NOT call shutdown() unconditionally on 'end' — that
  // is exactly the false-positive behavior #236 tore out. Instead we run
  // the same isParentAlive() check the periodic timer uses, just earlier.
  // If the parent is alive, this is a no-op and the existing #236
  // regression test still passes; if the parent is gone, we collapse the
  // 30 s detection window to ~0.
  //
  // Skipped on TTY (OpenCode ts-plugin) where stdin is not the MCP channel.
  const onStdinEnd = () => {
    if (!check()) shutdown();
  };
  if (!process.stdin.isTTY) {
    process.stdin.on("end", onStdinEnd);
  }

  const cleanup = () => {
    stopped = true;
    clearInterval(timer);
    if (idleTimer) clearInterval(idleTimer);
    for (const sig of signals) process.removeListener(sig, shutdown);
    process.stdin.removeListener("end", onStdinEnd);
  };

  // Hybrid: callable for legacy `const cleanup = startLifecycleGuard(...)`
  // sites, with `.recordActivity` / `.stop` properties for the new contract.
  const handle = cleanup as LifecycleGuardHandle;
  handle.recordActivity = recordActivity;
  handle.stop = cleanup;
  return handle;
}
