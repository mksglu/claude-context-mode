# PRD: WSL2 Process Tree Breaks PPID-Based Sentinel (#347)

## Problem

The MCP readiness sentinel uses `process.ppid` as session scope key:

- **MCP server** (server.ts:2384): `join(tmpdir(), \`context-mode-mcp-ready-${process.ppid}\`)`
- **Hook** (mcp-ready.mjs:15): `resolve(tmpdir(), \`context-mode-mcp-ready-${process.ppid}\`)`

Both assume `process.ppid` = Claude Code PID. This breaks on WSL2/Linux.

## Cross-Platform Process Tree Analysis

### macOS (works today)

```
Claude Code (PID 1000)
├── node server.mjs          → process.ppid = 1000 ✅
└── bash -c "node hook.mjs"  → bash execs into node → process.ppid = 1000 ✅
```

**Why it works**: macOS `/bin/bash` (and zsh) performs **exec-optimization** for single commands. `bash -c "node hook.mjs"` replaces the bash process with node, so the hook's PID **becomes** the bash PID, and ppid remains the Claude Code PID.

### Linux/WSL2 (BROKEN)

```
Claude Code (PID 1208183)
├── node server.mjs          → process.ppid = 1208183 ✅
└── dash (PID 1208633)       → intermediary shell
    └── node hook.mjs        → process.ppid = 1208633 ❌ (dash PID, not Claude Code)
```

**Why it breaks**: On most Linux distros, `/bin/sh` is **dash**, which does NOT exec-optimize. `spawn(cmd, [], { shell: true })` creates `sh -c "node hook.mjs"`, dash forks a child for node, and `process.ppid` in the hook = dash PID, not Claude Code PID. The MCP server's ppid is still correct (1208183), so the sentinel file name doesn't match.

**Note**: Even if `/bin/sh` is bash on some Linux distros, bash in POSIX mode (invoked as `sh`) may or may not exec-optimize depending on version and compile flags. This is NOT a reliable assumption.

### Windows (partial concern)

```
Claude Code (PID 5000)
├── node server.mjs          → process.ppid = 5000 ✅
└── cmd.exe (PID 5100)       → { shell: true } uses cmd.exe
    └── node hook.mjs        → process.ppid = 5100 ❌ (cmd.exe PID)
```

**Windows behavior**: `spawn(cmd, [], { shell: true })` uses `cmd.exe` by default. cmd.exe does NOT exec-optimize. Same problem as Linux. However, context-mode's own executor uses `shell: true` only on Windows (cli.ts:147), so this is a known pattern.

**Exception**: If Claude Code spawns hooks without `{ shell: true }` on Windows (using compiled binary), ppid would be correct. But the Claude Code hook docs indicate `shell: true` is used universally.

## TMPDIR Mismatch (Secondary Issue)

A WSL2 user reported hooks receiving `TMPDIR=/tmp/.ctx-mode-Uc34jU` (set by context-mode's own sandbox) while the MCP server uses the default `/tmp/`. This means `tmpdir()` returns different values in hook vs server contexts.

**Root cause**: If any parent process (or context-mode itself via `ctx_execute`) sets `TMPDIR` env var, `os.tmpdir()` follows it. The MCP server runs in its own stdio transport — it inherits Claude Code's env, not the hook sandbox env. But if Claude Code itself doesn't set TMPDIR, both should agree.

**Risk**: Low for normal usage. Only affects users who manually set TMPDIR or have unusual shell rc files that modify it.

## Recommended Approach: Directory-Scan Sentinel

Replace PPID-keyed sentinel with a **glob-scan** approach that's immune to process tree depth.

### Design

**MCP Server** writes sentinel as today, but includes the Claude Code PID inside the file:
```
Filename: context-mode-mcp-ready-<MCP_SERVER_PID>
Contents: <MCP_SERVER_PID>
```

**Hook** (`isMCPReady`) scans for ANY sentinel file matching the glob pattern:
```javascript
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const SENTINEL_PREFIX = "context-mode-mcp-ready-";

export function isMCPReady() {
  try {
    const dir = tmpdir();
    const files = readdirSync(dir).filter(f => f.startsWith(SENTINEL_PREFIX));
    for (const f of files) {
      try {
        const pid = parseInt(readFileSync(resolve(dir, f), "utf8"), 10);
        process.kill(pid, 0); // throws if dead
        return true;
      } catch {
        // Stale sentinel — PID is dead. Could clean up here.
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}
```

### Cross-Platform Compatibility

| Aspect | macOS | Linux/WSL2 | Windows |
|--------|-------|------------|---------|
| `os.tmpdir()` | `/tmp` or `$TMPDIR` | `/tmp` or `$TMPDIR` | `C:\Users\X\AppData\Local\Temp` |
| `readdirSync` | Works | Works | Works |
| `process.kill(pid, 0)` | Works (ESRCH if dead) | Works (ESRCH if dead) | Works (throws if dead) |
| Glob prefix match | `filter(startsWith)` | Same | Same |

### Scoping Concern: Multiple Claude Code Instances

The glob approach finds ANY live sentinel, not just "our" session's. This is actually **desirable** — if any MCP server is alive, the redirect is valid. But if a user runs two Claude Code instances with different projects:

- Instance A has context-mode MCP, Instance B does not
- Hook in Instance B finds Instance A's sentinel → incorrectly redirects

**Mitigation options** (choose one):
1. **Accept it** — edge case, and the hook's redirect just adds guidance text; if MCP tools aren't available the agent retries with native tools.
2. **Scope by project dir** — encode project dir hash in sentinel filename. Both server and hooks have `CLAUDE_PROJECT_DIR`.
3. **Walk the process tree** — use `/proc/<pid>/status` (Linux) or `sysctl` (macOS) to find the real ancestor. Fragile, platform-specific.

**Recommendation**: Option 2 (project dir hash) provides correct scoping without platform-specific syscalls.

### Refined Design with Project Scoping

```
Filename: context-mode-mcp-ready-<PROJECT_HASH_6>-<MCP_PID>
Contents: <MCP_PID>
```

Where `PROJECT_HASH_6` = first 6 chars of SHA-256 of `CLAUDE_PROJECT_DIR` (or "global" if unset).

**MCP Server (server.ts)**:
```javascript
import { createHash } from "node:crypto";
const projectHash = createHash("sha256")
  .update(process.env.CLAUDE_PROJECT_DIR || "global")
  .digest("hex")
  .slice(0, 6);
const mcpSentinel = join(tmpdir(), `context-mode-mcp-ready-${projectHash}-${process.pid}`);
```

**Hook (mcp-ready.mjs)**:
```javascript
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export function isMCPReady() {
  try {
    const projectHash = createHash("sha256")
      .update(process.env.CLAUDE_PROJECT_DIR || "global")
      .digest("hex")
      .slice(0, 6);
    const prefix = `context-mode-mcp-ready-${projectHash}-`;
    const dir = tmpdir();
    const files = readdirSync(dir).filter(f => f.startsWith(prefix));
    for (const f of files) {
      try {
        const pid = parseInt(readFileSync(resolve(dir, f), "utf8"), 10);
        process.kill(pid, 0);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}
```

### TMPDIR Mismatch Fix

Both server and hooks should resolve tmpdir consistently. Options:
1. **Hardcode `/tmp` on Unix, `os.tmpdir()` on Windows** — simplest, avoids TMPDIR env var interference
2. **Use a fixed path like `~/.context-mode/run/`** — home dir is consistent across processes
3. **Both read the same env var** — e.g. `CONTEXT_MODE_TMPDIR` with fallback to `os.tmpdir()`

**Recommendation**: Option 1 for simplicity. On Unix, `/tmp` is universal. On Windows, `os.tmpdir()` is stable (doesn't get overridden by shells).

```javascript
import { platform } from "node:os";
function sentinelDir() {
  return platform() === "win32" ? tmpdir() : "/tmp";
}
```

## Performance Impact

- `readdirSync("/tmp")` on a typical system: ~1ms (thousands of files)
- Filtering by prefix is O(n) string comparison
- Reading 1-2 small files: negligible
- Total: <5ms added latency to hook execution (vs ~0.5ms for current single-file read)

Acceptable for a hook that already does I/O.

## Migration Plan

1. Server writes NEW format sentinel (`context-mode-mcp-ready-<hash>-<pid>`)
2. Hook checks NEW format first, falls back to OLD format (`context-mode-mcp-ready-<ppid>`)
3. After 2 releases, remove OLD format fallback
4. Update all tests to use new sentinel naming

## Files to Modify

| File | Change |
|------|--------|
| `hooks/core/mcp-ready.mjs` | Replace `sentinelPath()` + `isMCPReady()` with glob-scan approach |
| `src/server.ts` | Update sentinel filename to include project hash |
| `tests/hooks/core-routing.test.ts` | Update sentinel setup/teardown |
| `tests/hooks/integration.test.ts` | Update sentinel setup/teardown |
| `tests/hooks/vscode-hooks.test.ts` | Update sentinel setup/teardown |
| `tests/hooks/tool-naming.test.ts` | Update sentinel setup/teardown |
| `tests/hooks/jetbrains-hooks.test.ts` | Update sentinel setup/teardown |
| `tests/hooks/cursor-hooks.test.ts` | Update sentinel setup/teardown |
| `tests/hooks/kiro-hooks.test.ts` | Update sentinel setup/teardown |
| `tests/hooks/hook-latency.test.ts` | Update sentinel setup/teardown |
| `tests/guidance-throttle.test.ts` | Update sentinel setup/teardown |
| `tests/opencode-plugin.test.ts` | Update sentinel setup/teardown |
| `tests/plugins/openclaw.test.ts` | Update sentinel setup/teardown |

## Test Plan

- [ ] Unit test: isMCPReady returns true when valid sentinel exists (new format)
- [ ] Unit test: isMCPReady returns false when no sentinel exists
- [ ] Unit test: isMCPReady returns false when sentinel PID is dead (stale)
- [ ] Unit test: isMCPReady cleans up stale sentinels
- [ ] Unit test: Multiple sentinels for same project, one alive → true
- [ ] Unit test: Sentinel for different project → false (scoping)
- [ ] Integration: Hook subprocess on Linux (dash as /bin/sh) finds sentinel
- [ ] Integration: TMPDIR override doesn't break sentinel discovery
- [ ] Migration: Old format sentinel still detected during transition period
