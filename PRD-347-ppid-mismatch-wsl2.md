# PRD: Issue #347 — PPID Mismatch Breaks mcpRedirect on WSL2

## Complete Flow Map

### Writer: `src/server.ts` (lines 2383-2413)
```
const mcpSentinel = join(tmpdir(), `context-mode-mcp-ready-${process.ppid}`);
// ...
writeFileSync(mcpSentinel, String(process.pid));
```
- MCP server is spawned by Claude Code as a child process
- `process.ppid` = Claude Code PID (the parent that spawned the MCP server)
- Sentinel file CONTAINS `process.pid` (the MCP server's own PID) as text content
- On shutdown: `unlinkSync(mcpSentinel)` removes it

### Reader: `hooks/core/mcp-ready.mjs` (lines 14-31)
```
export function sentinelPath() {
  return resolve(tmpdir(), `context-mode-mcp-ready-${process.ppid}`);
}
export function isMCPReady() {
  const pid = parseInt(readFileSync(sentinelPath(), "utf8"), 10);
  process.kill(pid, 0); // throws if dead
  return true;
}
```
- Hook process is ALSO spawned by Claude Code
- `process.ppid` SHOULD = Claude Code PID (same as the MCP server's ppid)
- Reads the PID from sentinel file content, probes with `kill(pid, 0)`

### Consumer: `hooks/core/routing.mjs` (line 27-30)
```
function mcpRedirect(result) {
  if (!isMCPReady()) return null;  // passthrough if MCP not ready
  return result;                   // enforce redirect if MCP alive
}
```
Used at lines 257, 279, 291, 316 — wraps every deny/modify that redirects to MCP tools (Bash→ctx_execute, Read→ctx_execute_file, WebFetch→ctx_fetch_and_index, curl/wget blocks).

### The Mismatch (WSL2)

Normal (macOS/Linux):
```
Claude Code (PID 1000)
  ├─ MCP server (ppid=1000) → writes /tmp/context-mode-mcp-ready-1000
  └─ hook process (ppid=1000) → reads /tmp/context-mode-mcp-ready-1000 ✓
```

WSL2:
```
Claude Code (PID 1000)
  ├─ MCP server (ppid=1000) → writes /tmp/context-mode-mcp-ready-1000
  └─ bash -c "node hooks/pretooluse.mjs" (PID 2000)
       └─ node hooks/pretooluse.mjs (ppid=2000) → reads /tmp/context-mode-mcp-ready-2000 ✗ NOT FOUND
```

Claude Code on WSL2 spawns hooks via `bash -c "node ..."` — the intermediate bash process becomes the parent. Hook's `process.ppid` = transient bash PID, not Claude Code PID. The sentinel file keyed to Claude Code's PID is never found.

Result: `isMCPReady()` always returns `false` → `mcpRedirect()` returns `null` → all redirections bypassed → raw tool output floods context window.

## Evaluation of Proposed Fix: Directory Scan + PID Liveness

### Proposed Algorithm
```js
export function isMCPReady() {
  const prefix = resolve(tmpdir(), 'context-mode-mcp-ready-');
  const files = readdirSync(tmpdir()).filter(f => f.startsWith('context-mode-mcp-ready-'));
  for (const f of files) {
    const pid = parseInt(readFileSync(resolve(tmpdir(), f), 'utf8'), 10);
    try { process.kill(pid, 0); return true; } catch { /* dead, skip */ }
  }
  return false;
}
```

### Concern Analysis

| Concern | Assessment | Mitigation |
|---------|-----------|------------|
| **Cross-session false positives** | MEDIUM RISK. If user runs two Claude Code sessions simultaneously, hook from session A could find session B's sentinel and redirect to wrong MCP server. | Accept: both sessions have MCP running, so the redirect instruction is valid regardless. The hook just needs to know "some MCP is available" — it doesn't call MCP directly, it just decides whether to deny/passthrough. |
| **Performance** | LOW RISK. `readdirSync(tmpdir())` + filter prefix is O(n) on tmpdir entries. Typically <1ms. `kill(pid, 0)` is a syscall, ~0.01ms. Max 2-3 sentinel files. | Cache result in-memory for the process lifetime (hooks are short-lived anyway). |
| **Stale sentinel cleanup** | ALREADY HANDLED. Current `isMCPReady()` already does `kill(pid, 0)` probe. Dead PIDs are skipped. Stale files only waste a few bytes. | Add cleanup in scan: if PID is dead, `unlinkSync` the stale sentinel. |
| **Windows compatibility** | MEDIUM RISK. Windows has no `kill(pid, 0)` POSIX semantics. Node.js `process.kill(pid, 0)` on Windows throws `EPERM` for alive processes and `ESRCH` for dead ones — same behavior! | Works correctly on Windows. Node abstracts the platform difference. BUT: `tmpdir()` on Windows = `C:\Users\...\Temp` vs WSL tmpdir = `/tmp`. MCP server (running in WSL) and hooks (also WSL) share `/tmp`, so this is fine. |

### Verdict: GOOD FIX, with refinements

## Recommended Implementation

### Approach: Glob scan with liveness probe + opportunistic cleanup

**File: `hooks/core/mcp-ready.mjs`** — Replace both functions:

```js
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const SENTINEL_PREFIX = "context-mode-mcp-ready-";

/**
 * Check if ANY MCP server is alive by scanning sentinel files.
 * Fixes #347: ppid mismatch on WSL2 where intermediate bash process
 * changes the parent PID seen by hook subprocess.
 *
 * Strategy: scan all sentinel files, probe each PID, clean up dead ones.
 * Performance: <1ms typical (1-3 files in tmpdir filter + syscall per file).
 */
export function isMCPReady() {
  try {
    const tmp = tmpdir();
    const files = readdirSync(tmp).filter(f => f.startsWith(SENTINEL_PREFIX));
    for (const f of files) {
      try {
        const content = readFileSync(resolve(tmp, f), "utf8");
        const pid = parseInt(content, 10);
        if (isNaN(pid)) { unlinkSync(resolve(tmp, f)); continue; }
        process.kill(pid, 0); // throws if dead
        return true;
      } catch {
        // PID dead or file unreadable — clean up stale sentinel
        try { unlinkSync(resolve(tmp, f)); } catch { /* race: already removed */ }
      }
    }
    return false;
  } catch {
    return false; // tmpdir unreadable — safe fallback
  }
}

/** @deprecated — kept for backward compat. No longer used by isMCPReady. */
export function sentinelPath() {
  return resolve(tmpdir(), `${SENTINEL_PREFIX}${process.ppid}`);
}
```

**File: `src/server.ts`** — No changes needed. Server still writes sentinel keyed to `process.ppid` (Claude Code PID). The new scan-based reader will find it regardless of which PID the hook sees as its parent.

### Files Requiring Changes

| File | Line(s) | Change |
|------|---------|--------|
| `hooks/core/mcp-ready.mjs` | 1-31 (full file) | Replace with glob scan + liveness probe |
| Tests (8 files) | Various | Update sentinel setup — tests already write to `process.ppid`, which works since test IS the parent. No test changes needed for the core logic. Add a NEW test for the scan behavior. |

### Test Files Using Sentinel (for awareness, NOT necessarily needing changes)
- `tests/hooks/core-routing.test.ts:38`
- `tests/hooks/hook-latency.test.ts:44`
- `tests/hooks/tool-naming.test.ts:52`
- `tests/hooks/cursor-hooks.test.ts:62`
- `tests/hooks/kiro-hooks.test.ts:64`
- `tests/hooks/vscode-hooks.test.ts:116`
- `tests/plugins/openclaw.test.ts:22`
- `tests/opencode-plugin.test.ts:35`
- `tests/guidance-throttle.test.ts:10`

### New Test Needed
```
describe("isMCPReady() — glob scan (#347)", () => {
  it("finds sentinel written by different parent PID");
  it("returns false when all sentinels have dead PIDs");
  it("cleans up stale sentinel files");
  it("returns false when no sentinel files exist");
});
```

## Why NOT Alternative Approaches

| Alternative | Why Rejected |
|-------------|-------------|
| Pass CLAUDE_PID as env var to hooks | Claude Code doesn't set this env var. Would require Claude Code changes (upstream dependency). |
| Walk process tree to find Claude ancestor | Expensive, platform-dependent, fragile. `/proc` doesn't exist on macOS. |
| Use session ID instead of PID | Session ID isn't available in all hook contexts; would require refactoring both writer and all readers. |
| Named pipe / unix socket | Over-engineered for a boolean "is it alive?" check. |
