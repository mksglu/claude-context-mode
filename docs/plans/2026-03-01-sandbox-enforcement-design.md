# Sandbox Enforcement for execute/batch_execute

## Problem

context-mode's PreToolUse hook redirects Claude Code's Bash tool calls to
MCP tools (`execute`, `batch_execute`). Claude Code's native Bash tool runs
inside OS-level sandboxing (`sandbox-exec` on macOS, `bubblewrap` on Linux)
that enforces filesystem confinement and network isolation. The MCP tools
bypass this entirely — `PolyglotExecutor` spawns raw `child_process` with
full user permissions, unrestricted filesystem write access, and
unrestricted network access.

This means a prompt-injected or misbehaving Claude can exfiltrate data,
modify files outside the project, or make arbitrary network calls through
`execute`/`batch_execute` without any OS-level protection.

## Solution

Integrate Anthropic's [`@anthropic-ai/sandbox-runtime`][sandbox-runtime]
library — the same one Claude Code uses — to wrap every command spawned by
`PolyglotExecutor` in OS-level sandboxing.

[sandbox-runtime]: https://github.com/anthropic-experimental/sandbox-runtime

## Architecture

```
Claude invokes execute(language: "shell", code: "...")
  -> PolyglotExecutor writes script to tmpDir
  -> PolyglotExecutor builds command: ["bash", "/tmp/ctx-mode-xxx/script.sh"]
  -> SandboxManager.wrapWithSandbox("bash /tmp/ctx-mode-xxx/script.sh")
      -> Returns sandboxed command string (sandbox-exec/bwrap wrapper)
  -> spawn(sandboxedCommand, { shell: true })
  -> Process runs with OS-level filesystem + network restrictions
```

### Sandbox Configuration

```typescript
const config: SandboxRuntimeConfig = {
  filesystem: {
    denyRead: ['~/.ssh', '~/.gnupg', '~/.aws/credentials'],
    allowWrite: [projectRoot, '/tmp'],
    denyWrite: ['.env'],
  },
  network: {
    allowedDomains: [...claudeCodeAllowedDomains],
    deniedDomains: [],
  },
}
```

- **Filesystem:** Write access confined to the project directory and `/tmp`.
  Sensitive paths (`~/.ssh`, `~/.gnupg`, `~/.aws/credentials`) denied for
  reads. `.env` files denied for writes even within the project.
- **Network:** Mirrors Claude Code's own sandbox network config (allowed
  domains read from `~/.claude/settings.json` at startup). Falls back to a
  conservative default if the config is not found.

## Network Policy

context-mode's `execute` is used for CLI tools that need network access
(`gh`, `aws`, `npm`, `curl`-in-sandbox). Blocking all network would break
real workflows.

The sandbox-runtime library routes all traffic through proxy servers
(HTTP proxy + SOCKS5) that enforce an allow/deny domain list. This matches
Claude Code's own behavior.

**Config resolution order:**

1. Read Claude Code's sandbox settings from `~/.claude/settings.json`
   (extract `allowedDomains`)
2. If not found, fall back to a conservative default: common dev tool
   domains (`github.com`, `api.github.com`, `registry.npmjs.org`,
   `pypi.org`)
3. User can override via `CONTEXT_MODE_ALLOWED_DOMAINS` env var
   (comma-separated)

## Sandbox Lifecycle

```
MCP server startup (server.ts)
  +-- SandboxManager.initialize(config)    <- one-time, starts proxy servers
  +-- PolyglotExecutor receives SandboxManager reference

Per execute()/batch_execute() call:
  +-- SandboxManager.wrapWithSandbox(cmd)  <- lightweight string transform
  +-- spawn(wrappedCmd, ...)               <- same as before, just wrapped

MCP server shutdown:
  +-- SandboxManager.reset()               <- cleanup proxy servers
```

`SandboxManager.initialize()` is called once at startup.
`wrapWithSandbox()` is a cheap string operation per call — no per-call
proxy or sandbox overhead beyond what the OS sandbox setup itself costs
(which is what Claude Code's Bash tool also pays).

## Error Handling & Degradation

Three modes:

1. **Sandbox available:** Always used. No opt-out needed.
2. **Sandbox unavailable** (missing `bubblewrap`, unsupported platform like
   Windows): Log warning to stderr, run unsandboxed, include warning in
   tool response.
3. **User explicitly opts out:** `CONTEXT_MODE_NO_SANDBOX=1` env var
   disables enforcement. Tool responses include a note that sandbox is
   disabled.

When a sandboxed command fails due to a sandbox violation:

- Error reported clearly: e.g., `"Sandbox denied write to /etc/hosts —
  this path is outside the project directory"`
- Claude sees the error and falls back to native Bash (which has its own
  sandbox + user permission prompt)
- No `dangerouslyDisableSandbox` parameter on the MCP tools — the escape
  path is always through Claude Code's native Bash tool.

## Files Changed

| File | Change |
|------|--------|
| `package.json` | Add `@anthropic-ai/sandbox-runtime` dependency |
| `src/sandbox.ts` (new) | Config builder: reads Claude Code settings, builds `SandboxRuntimeConfig`, handles escape hatch |
| `src/executor.ts` | Accept optional `SandboxManager`, use `wrapWithSandbox()` in `#spawn` |
| `src/server.ts` | Initialize `SandboxManager` at startup, pass to `PolyglotExecutor` |

### `src/sandbox.ts` Responsibilities

- Locate Claude Code's sandbox config (`~/.claude/settings.json`)
- Extract network `allowedDomains`
- Build `SandboxRuntimeConfig` with filesystem restrictions based on
  `projectRoot`
- Handle `CONTEXT_MODE_NO_SANDBOX=1` escape hatch
- Handle `CONTEXT_MODE_ALLOWED_DOMAINS` override
- Export an `initSandbox(projectRoot: string)` function for `server.ts`

### `src/executor.ts` Change

The `#spawn` method currently does:

```typescript
const proc = spawn(cmd[0], cmd.slice(1), { cwd, ... });
```

It becomes:

```typescript
if (this.#sandboxManager) {
  const wrapped = await SandboxManager.wrapWithSandbox(cmd.join(' '));
  const proc = spawn(wrapped, { shell: true, cwd, ... });
} else {
  // Unsandboxed fallback (missing bubblewrap, Windows, or opt-out)
  const proc = spawn(cmd[0], cmd.slice(1), { cwd, ... });
}
```

### `src/server.ts` Change

At startup, before registering tools:

```typescript
import { initSandbox } from './sandbox.js';

const sandboxManager = await initSandbox(
  process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
);

const executor = new PolyglotExecutor({
  runtimes,
  projectRoot: process.env.CLAUDE_PROJECT_DIR,
  sandboxManager,  // new optional parameter
});
```

## Platform Support

| Platform | Mechanism | Dependency |
|----------|-----------|------------|
| macOS | `sandbox-exec` (Seatbelt) | None (built-in) |
| Linux | `bubblewrap` (bwrap) | `bubblewrap` package |
| Windows | Unsandboxed fallback + warning | None |

## Security Properties Achieved

After this change, `execute`/`batch_execute` provide the same guarantees
as Claude Code's native Bash tool:

- **Filesystem confinement:** Write access only to project directory and
  `/tmp`. Read access denied for sensitive paths.
- **Network isolation:** All traffic routed through proxy with domain
  allow list. Matches Claude Code's own network policy.
- **OS-level enforcement:** Restrictions apply to the entire process tree
  — not just the direct child, but any scripts, subprocesses, or
  subagents it spawns.
- **No bypass from MCP tools:** The only way to escape the sandbox is
  through Claude Code's native Bash tool, which has its own sandbox +
  user permission prompt.
