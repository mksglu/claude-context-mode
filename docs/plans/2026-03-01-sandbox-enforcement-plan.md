# Sandbox Enforcement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wrap all commands spawned by `PolyglotExecutor` in Anthropic's `@anthropic-ai/sandbox-runtime` so that `execute`/`batch_execute` get the same OS-level filesystem and network isolation as Claude Code's native Bash tool.

**Architecture:** `SandboxManager` from `@anthropic-ai/sandbox-runtime` is initialized once at MCP server startup. `PolyglotExecutor` receives a `wrapCommand` callback that calls `SandboxManager.wrapWithSandbox()`. Every spawned process runs inside `sandbox-exec` (macOS) or `bubblewrap` (Linux). Network traffic routes through the library's proxy servers with a domain allow list mirrored from Claude Code's settings.

**Tech Stack:** TypeScript, `@anthropic-ai/sandbox-runtime`, Node.js `child_process`

**Design doc:** `docs/plans/2026-03-01-sandbox-enforcement-design.md`

---

### Task 1: Add dependency and verify it loads

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json` (if needed for types)

**Step 1: Install the dependency**

Run: `npm install @anthropic-ai/sandbox-runtime`

**Step 2: Verify it imports**

Run: `node -e "const m = await import('@anthropic-ai/sandbox-runtime'); console.log(Object.keys(m))"`
Expected: Array including `SandboxManager`, `SandboxViolationStore`, etc.

**Step 3: Add to esbuild externals**

In `package.json`, the `bundle` script uses `--external:better-sqlite3`. Add
`--external:@anthropic-ai/sandbox-runtime` so the native dependency isn't
bundled:

```json
"bundle": "esbuild src/server.ts --bundle --platform=node --target=node18 --format=esm --outfile=server.bundle.mjs --external:better-sqlite3 --external:turndown --external:turndown-plugin-gfm --external:@mixmark-io/domino --external:@anthropic-ai/sandbox-runtime --minify"
```

**Step 4: Verify build**

Run: `npm run build`
Expected: No errors

**Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "build: add @anthropic-ai/sandbox-runtime dependency"
```

---

### Task 2: Create `src/sandbox.ts` — config builder and initialization

**Files:**
- Create: `src/sandbox.ts`
- Test: `tests/sandbox.test.ts`

**Step 1: Write the failing test**

Create `tests/sandbox.test.ts`:

```typescript
import { strict as assert } from "node:assert";
import { buildSandboxConfig, type SandboxConfig } from "../src/sandbox.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
  }
}

async function main() {
  console.log("\nSandbox Config Tests\n");

  await test("builds config with projectRoot in allowWrite", () => {
    const config = buildSandboxConfig("/home/user/project");
    assert.ok(config.filesystem.allowWrite.includes("/home/user/project"));
    assert.ok(config.filesystem.allowWrite.includes("/tmp"));
  });

  await test("denies read to sensitive paths", () => {
    const config = buildSandboxConfig("/home/user/project");
    assert.ok(config.filesystem.denyRead.includes("~/.ssh"));
    assert.ok(config.filesystem.denyRead.includes("~/.gnupg"));
  });

  await test("denies write to .env within project", () => {
    const config = buildSandboxConfig("/home/user/project");
    assert.ok(config.filesystem.denyWrite.includes(".env"));
  });

  await test("respects CONTEXT_MODE_NO_SANDBOX=1", () => {
    process.env.CONTEXT_MODE_NO_SANDBOX = "1";
    const config = buildSandboxConfig("/home/user/project");
    assert.equal(config.disabled, true);
    delete process.env.CONTEXT_MODE_NO_SANDBOX;
  });

  await test("respects CONTEXT_MODE_ALLOWED_DOMAINS override", () => {
    process.env.CONTEXT_MODE_ALLOWED_DOMAINS = "example.com,api.test.io";
    const config = buildSandboxConfig("/home/user/project");
    assert.deepEqual(config.network.allowedDomains, [
      "example.com",
      "api.test.io",
    ]);
    delete process.env.CONTEXT_MODE_ALLOWED_DOMAINS;
  });

  await test("uses default domains when no Claude Code config found", () => {
    const config = buildSandboxConfig("/home/user/project");
    assert.ok(config.network.allowedDomains.length > 0);
    assert.ok(config.network.allowedDomains.includes("github.com"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
```

**Step 2: Run test to verify it fails**

Run: `npx tsx tests/sandbox.test.ts`
Expected: FAIL — module `../src/sandbox.js` not found

**Step 3: Write minimal implementation**

Create `src/sandbox.ts`:

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// ==============================================================================
// Sandbox Configuration
// ==============================================================================
//
// Builds a SandboxRuntimeConfig for @anthropic-ai/sandbox-runtime that mirrors
// Claude Code's own Bash sandbox: filesystem confinement to the project
// directory, network isolation via proxy, and deny lists for sensitive paths.

export interface SandboxConfig {
  disabled: boolean;
  filesystem: {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
  };
}

/** Sensitive paths that should never be readable by sandboxed code. */
const SENSITIVE_READ_PATHS = [
  "~/.ssh",
  "~/.gnupg",
  "~/.aws/credentials",
];

/** Patterns denied for writes even within allowed directories. */
const SENSITIVE_WRITE_PATTERNS = [".env"];

/** Conservative default domains for dev tool network access. */
const DEFAULT_ALLOWED_DOMAINS = [
  "github.com",
  "api.github.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "rubygems.org",
  "proxy.golang.org",
  "crates.io",
  "static.crates.io",
];

// ==============================================================================
// Claude Code Config Discovery
// ==============================================================================

/**
 * Attempt to read Claude Code's sandbox network settings from
 * ~/.claude/settings.json. Returns the allowed domains list, or null
 * if the file doesn't exist or doesn't contain sandbox network config.
 */
function readClaudeCodeAllowedDomains(): string[] | null {
  try {
    const settingsPath = resolve(homedir(), ".claude", "settings.json");
    const raw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);

    // Claude Code stores sandbox config under various possible paths —
    // try the most likely ones.
    const domains =
      settings?.sandbox?.network?.allowedDomains ??
      settings?.sandboxNetwork?.allowedDomains ??
      null;

    if (Array.isArray(domains) && domains.length > 0) {
      return domains.filter((d: unknown) => typeof d === "string");
    }
  } catch {
    // File doesn't exist or isn't valid JSON — expected on first run
  }
  return null;
}

// ==============================================================================
// Public API
// ==============================================================================

export function buildSandboxConfig(projectRoot: string): SandboxConfig {
  // Escape hatch: user explicitly opts out
  if (process.env.CONTEXT_MODE_NO_SANDBOX === "1") {
    return {
      disabled: true,
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: [] },
    };
  }

  // Network: env override > Claude Code config > defaults
  let allowedDomains: string[];
  const envDomains = process.env.CONTEXT_MODE_ALLOWED_DOMAINS;
  if (envDomains) {
    allowedDomains = envDomains
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
  } else {
    allowedDomains =
      readClaudeCodeAllowedDomains() ?? [...DEFAULT_ALLOWED_DOMAINS];
  }

  return {
    disabled: false,
    filesystem: {
      denyRead: [...SENSITIVE_READ_PATHS],
      allowWrite: [projectRoot, "/tmp"],
      denyWrite: [...SENSITIVE_WRITE_PATTERNS],
    },
    network: {
      allowedDomains,
      deniedDomains: [],
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx tsx tests/sandbox.test.ts`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add src/sandbox.ts tests/sandbox.test.ts
git commit -m "feat(sandbox): add config builder with Claude Code settings discovery

Reads Claude Code's allowed domains from ~/.claude/settings.json,
falls back to conservative defaults (github.com, npmjs, pypi, etc.).

Supports CONTEXT_MODE_NO_SANDBOX=1 escape hatch and
CONTEXT_MODE_ALLOWED_DOMAINS override."
```

---

### Task 3: Create `initSandbox()` — lifecycle manager

This task adds the function that initializes `SandboxManager` at startup and
returns a `wrapCommand` callback for the executor.

**Files:**
- Modify: `src/sandbox.ts`
- Test: `tests/sandbox.test.ts`

**Step 1: Write the failing test**

Add to `tests/sandbox.test.ts`:

```typescript
import { initSandbox } from "../src/sandbox.js";

// ... in main():

await test("initSandbox returns wrapCommand function", async () => {
  const result = await initSandbox("/tmp/test-project");
  assert.equal(typeof result.wrapCommand, "function");
  assert.equal(typeof result.cleanup, "function");
  assert.equal(typeof result.sandboxed, "boolean");
  await result.cleanup();
});

await test("initSandbox with NO_SANDBOX returns passthrough wrapper", async () => {
  process.env.CONTEXT_MODE_NO_SANDBOX = "1";
  const result = await initSandbox("/tmp/test-project");
  assert.equal(result.sandboxed, false);
  // Passthrough: returns the command unchanged
  const wrapped = await result.wrapCommand("echo hello");
  assert.equal(wrapped, "echo hello");
  await result.cleanup();
  delete process.env.CONTEXT_MODE_NO_SANDBOX;
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx tests/sandbox.test.ts`
Expected: FAIL — `initSandbox` not exported

**Step 3: Write minimal implementation**

Add to `src/sandbox.ts`:

```typescript
// At top of file, add import:
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export interface SandboxHandle {
  /** Whether OS-level sandboxing is active. */
  sandboxed: boolean;
  /** Wraps a shell command string with sandbox restrictions. */
  wrapCommand: (cmd: string) => Promise<string>;
  /** Cleans up proxy servers and sandbox state. */
  cleanup: () => Promise<void>;
}

/**
 * Initialize the sandbox runtime. Call once at MCP server startup.
 *
 * Returns a handle with a `wrapCommand` function that wraps shell commands
 * in OS-level sandbox restrictions, and a `cleanup` function for shutdown.
 *
 * If the sandbox runtime is unavailable (missing bubblewrap on Linux,
 * unsupported platform, or user opt-out), returns a passthrough wrapper
 * that leaves commands unchanged.
 */
export async function initSandbox(projectRoot: string): Promise<SandboxHandle> {
  const config = buildSandboxConfig(projectRoot);

  if (config.disabled) {
    console.error("[context-mode] Sandbox disabled via CONTEXT_MODE_NO_SANDBOX=1");
    return {
      sandboxed: false,
      wrapCommand: async (cmd) => cmd,
      cleanup: async () => {},
    };
  }

  try {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");

    const runtimeConfig: SandboxRuntimeConfig = {
      filesystem: {
        denyRead: config.filesystem.denyRead,
        allowWrite: config.filesystem.allowWrite,
        denyWrite: config.filesystem.denyWrite,
      },
      network: {
        allowedDomains: config.network.allowedDomains,
        deniedDomains: config.network.deniedDomains,
      },
    };

    await SandboxManager.initialize(runtimeConfig);
    console.error("[context-mode] OS sandbox initialized (filesystem + network isolation active)");

    return {
      sandboxed: true,
      wrapCommand: (cmd) => SandboxManager.wrapWithSandbox(cmd),
      cleanup: () => SandboxManager.reset(),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[context-mode] Sandbox unavailable: ${msg}`);
    console.error("[context-mode] Running without OS sandbox — install @anthropic-ai/sandbox-runtime for full protection");

    return {
      sandboxed: false,
      wrapCommand: async (cmd) => cmd,
      cleanup: async () => {},
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx tsx tests/sandbox.test.ts`
Expected: All tests PASS (the `initSandbox` test may show "Sandbox unavailable"
on stderr if sandbox-runtime can't initialize in the test env — that's fine,
it should still return the passthrough wrapper)

**Step 5: Commit**

```bash
git add src/sandbox.ts tests/sandbox.test.ts
git commit -m "feat(sandbox): add initSandbox() lifecycle manager

Initializes SandboxManager once at startup, returns a wrapCommand
callback for the executor. Gracefully degrades to passthrough if the
sandbox runtime is unavailable."
```

---

### Task 4: Integrate sandbox into `PolyglotExecutor`

**Files:**
- Modify: `src/executor.ts:42-58` (constructor) and `src/executor.ts:208-222` (`#spawn`)
- Test: `tests/executor.test.ts`

**Step 1: Write the failing test**

Add to `tests/executor.test.ts`, inside `main()` before the summary section:

```typescript
// ===== SANDBOX INTEGRATION =====
console.log("\n--- Sandbox Integration ---\n");

await test("accepts wrapCommand option", async () => {
  let wrappedCmd = "";
  const sandboxedExecutor = new PolyglotExecutor({
    runtimes,
    wrapCommand: async (cmd: string) => {
      wrappedCmd = cmd;
      return cmd; // passthrough — just record what was passed
    },
  });
  const r = await sandboxedExecutor.execute({
    language: "shell",
    code: 'echo "sandboxed"',
  });
  assert.equal(r.exitCode, 0);
  assert.ok(r.stdout.includes("sandboxed"));
  assert.ok(wrappedCmd.length > 0, "wrapCommand should have been called");
  assert.ok(wrappedCmd.includes("script.sh"), `Expected script path in: ${wrappedCmd}`);
});

await test("wrapCommand not called when not provided", async () => {
  // Default executor (no wrapCommand) should still work fine
  const r = await executor.execute({
    language: "shell",
    code: 'echo "no sandbox"',
  });
  assert.equal(r.exitCode, 0);
  assert.ok(r.stdout.includes("no sandbox"));
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx tests/executor.test.ts`
Expected: FAIL — `wrapCommand` not a recognized option

**Step 3: Write minimal implementation**

Modify `src/executor.ts`:

1. Add `wrapCommand` to the constructor options and store it:

```typescript
// In the class declaration, add the field (line ~46):
#wrapCommand: ((cmd: string) => Promise<string>) | null;

// In the constructor (line ~48-58), add the option:
constructor(opts?: {
  maxOutputBytes?: number;
  hardCapBytes?: number;
  projectRoot?: string;
  runtimes?: RuntimeMap;
  wrapCommand?: (cmd: string) => Promise<string>;
}) {
  this.#maxOutputBytes = opts?.maxOutputBytes ?? 102_400;
  this.#hardCapBytes = opts?.hardCapBytes ?? 100 * 1024 * 1024;
  this.#projectRoot = opts?.projectRoot ?? process.cwd();
  this.#runtimes = opts?.runtimes ?? detectRuntimes();
  this.#wrapCommand = opts?.wrapCommand ?? null;
}
```

2. Modify `#spawn` (line ~208-222) to use `wrapCommand` when available:

```typescript
async #spawn(
  cmd: string[],
  cwd: string,
  timeout: number,
): Promise<ExecResult> {
  return new Promise(async (res) => {
    // When a sandbox wrapper is provided, join the command into a shell
    // string, wrap it, and spawn via shell. Otherwise, spawn directly.
    let proc: ReturnType<typeof spawn>;
    if (this.#wrapCommand) {
      const shellCmd = cmd.map(c => `'${c.replace(/'/g, "'\\''")}'`).join(" ");
      const wrapped = await this.#wrapCommand(shellCmd);
      proc = spawn(wrapped, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: this.#buildSafeEnv(cwd),
        shell: true,
      });
    } else {
      const needsShell = isWin && ["tsx", "ts-node", "elixir"].includes(cmd[0]);
      proc = spawn(cmd[0], cmd.slice(1), {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: this.#buildSafeEnv(cwd),
        shell: needsShell,
      });
    }

    // ... rest of #spawn unchanged (timeout, stdout/stderr collection, etc.)
```

Note: The `return new Promise((res) => {` becomes `return new Promise(async (res) => {`
since we need to `await this.#wrapCommand(...)`.

3. Also wrap `#compileAndRun` — the Rust compile step also needs sandboxing.
   The `execSync` call at line 144 runs `rustc` unsandboxed. For now, add a
   TODO comment since Rust compilation genuinely needs write access to the
   tmpDir (which is already in `/tmp`, an allowed write path):

```typescript
// TODO: Rust compile via execSync is not sandboxed. It writes to /tmp
// which is in the allowWrite list, so the risk is limited. Consider
// converting to async spawn with wrapCommand in a follow-up.
```

**Step 4: Run test to verify it passes**

Run: `npx tsx tests/executor.test.ts`
Expected: All existing tests PASS + 2 new sandbox integration tests PASS

**Step 5: Run full test suite to verify no regressions**

Run: `npm run test:all`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/executor.ts tests/executor.test.ts
git commit -m "feat(sandbox): integrate wrapCommand into PolyglotExecutor

PolyglotExecutor accepts an optional wrapCommand callback. When
provided, #spawn joins the command array into a shell string, passes
it through wrapCommand (which adds sandbox-exec/bwrap prefix), and
spawns with shell: true.

Existing behavior is unchanged when wrapCommand is not provided.
Rust compilation via execSync is not yet sandboxed (TODO)."
```

---

### Task 5: Wire sandbox into MCP server startup

**Files:**
- Modify: `src/server.ts:1-26` (imports + executor creation) and `src/server.ts:1161-1191` (`main()`)

**Step 1: Modify imports and executor creation**

At the top of `src/server.ts`, add:

```typescript
import { initSandbox, type SandboxHandle } from "./sandbox.js";
```

Replace the synchronous executor creation (lines 23-26):

```typescript
// Old:
const executor = new PolyglotExecutor({
  runtimes,
  projectRoot: process.env.CLAUDE_PROJECT_DIR,
});

// New — executor is created inside main() after async sandbox init:
let executor: PolyglotExecutor;
```

**Step 2: Modify `main()` to initialize sandbox first**

In the `main()` function (line ~1161), add sandbox init before transport
connection:

```typescript
async function main() {
  const cleaned = cleanupStaleDBs();
  if (cleaned > 0) {
    console.error(`Cleaned up ${cleaned} stale DB file(s) from previous sessions`);
  }

  // Initialize OS-level sandbox before creating the executor
  const projectRoot = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const sandbox = await initSandbox(projectRoot);

  executor = new PolyglotExecutor({
    runtimes,
    projectRoot,
    wrapCommand: sandbox.sandboxed ? sandbox.wrapCommand : undefined,
  });

  // Clean up sandbox + DB on shutdown
  const shutdown = async () => {
    await sandbox.cleanup();
    if (_store) _store.cleanup();
  };
  process.on("exit", () => { shutdown(); });
  process.on("SIGINT", () => { shutdown().then(() => process.exit(0)); });
  process.on("SIGTERM", () => { shutdown().then(() => process.exit(0)); });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const sandboxStatus = sandbox.sandboxed
    ? "OS sandbox active"
    : "WARNING: running without OS sandbox";
  console.error(`Context Mode MCP server v${VERSION} running on stdio (${sandboxStatus})`);
  console.error(`Detected runtimes:\n${getRuntimeSummary(runtimes)}`);
  if (!hasBunRuntime()) {
    console.error("\nPerformance tip: Install Bun for 3-5x faster JS/TS execution");
    console.error("  curl -fsSL https://bun.sh/install | bash");
  }
}
```

**Step 3: Verify build**

Run: `npm run build`
Expected: No errors

**Step 4: Verify server starts**

Run: `npx tsx src/server.ts 2>&1 | head -5`
Expected: Startup message including sandbox status (either "OS sandbox active"
or "running without OS sandbox")

**Step 5: Run full test suite**

Run: `npm run test:all`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat(sandbox): wire sandbox into MCP server startup

SandboxManager is initialized once in main() before creating the
executor. The wrapCommand callback is passed to PolyglotExecutor only
when the sandbox successfully initialized. Sandbox cleanup runs on
SIGINT/SIGTERM/exit alongside DB cleanup.

Startup log now reports sandbox status."
```

---

### Task 6: Update esbuild bundle config

**Files:**
- Modify: `package.json` (the `bundle` script)

**Step 1: Add external**

The bundle script in `package.json` needs `@anthropic-ai/sandbox-runtime` as
an external (it has native dependencies that can't be bundled):

```json
"bundle": "esbuild src/server.ts --bundle --platform=node --target=node18 --format=esm --outfile=server.bundle.mjs --external:better-sqlite3 --external:turndown --external:turndown-plugin-gfm --external:@mixmark-io/domino --external:@anthropic-ai/sandbox-runtime --minify"
```

**Step 2: Verify bundle builds**

Run: `npm run bundle`
Expected: Bundle created without errors

**Step 3: Commit**

```bash
git add package.json
git commit -m "build: add sandbox-runtime to esbuild externals

The native sandbox-runtime dependency cannot be bundled by esbuild."
```

---

### Task 7: Integration test — verify sandbox blocks writes outside project

This is the critical verification that the sandbox actually works.

**Files:**
- Create: `tests/sandbox-integration.test.ts`

**Step 1: Write the integration test**

```typescript
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { PolyglotExecutor } from "../src/executor.js";
import { initSandbox } from "../src/sandbox.js";
import { detectRuntimes } from "../src/runtime.js";

let passed = 0;
let failed = 0;
let skipped = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
  }
}

function skip(name: string, reason: string) {
  skipped++;
  console.log(`  - ${name} (SKIP: ${reason})`);
}

async function main() {
  console.log("\nSandbox Integration Tests\n");

  const runtimes = detectRuntimes();
  const projectDir = mkdtempSync(join(tmpdir(), "ctx-sandbox-test-"));
  const sandbox = await initSandbox(projectDir);

  if (!sandbox.sandboxed) {
    console.log("Sandbox not available on this system — skipping integration tests");
    console.log("(This is expected if bubblewrap is not installed on Linux)");
    rmSync(projectDir, { recursive: true, force: true });
    process.exit(0);
  }

  const executor = new PolyglotExecutor({
    runtimes,
    projectRoot: projectDir,
    wrapCommand: sandbox.wrapCommand,
  });

  // ── Filesystem: writes within project should succeed ──

  await test("allows write within project directory", async () => {
    const r = await executor.execute({
      language: "shell",
      code: `echo "hello" > "${projectDir}/test-output.txt" && cat "${projectDir}/test-output.txt"`,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello"));
  });

  // ── Filesystem: writes outside project should fail ──

  await test("blocks write to home directory", async () => {
    const targetFile = join(homedir(), ".sandbox-test-canary-" + Date.now());
    const r = await executor.execute({
      language: "shell",
      code: `echo "should not appear" > "${targetFile}"`,
    });
    // The sandbox should either make the command fail or silently prevent the write
    assert.ok(
      r.exitCode !== 0 || !existsSync(targetFile),
      "Write to home directory should have been blocked",
    );
    // Clean up just in case (if sandbox failed to block)
    try { rmSync(targetFile, { force: true }); } catch {}
  });

  // ── Filesystem: reads of sensitive paths should fail ──

  await test("blocks read of ~/.ssh", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'ls ~/.ssh 2>&1',
    });
    // Either the command fails or the output indicates permission denied
    assert.ok(
      r.exitCode !== 0 || r.stdout.includes("denied") || r.stderr.includes("denied") || r.stdout.includes("Operation not permitted"),
      "Read of ~/.ssh should have been blocked or denied",
    );
  });

  // ── Network: outbound connections should be filtered ──

  await test("blocks network to non-allowlisted domain", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'curl -s --connect-timeout 3 https://example.com 2>&1',
      timeout: 10_000,
    });
    // Should fail — example.com is not in the allowed domains list
    assert.ok(
      r.exitCode !== 0 || r.stdout.includes("denied") || r.stderr.includes("denied") || r.stdout === "",
      "Network request to non-allowlisted domain should have been blocked",
    );
  });

  // ── Cleanup ──

  await sandbox.cleanup();
  rmSync(projectDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
```

**Step 2: Run the integration test**

Run: `npx tsx tests/sandbox-integration.test.ts`
Expected: If sandbox-runtime is available and working on the current platform,
all tests PASS. If unavailable, test exits 0 with a skip message.

**Step 3: Add test script to package.json**

```json
"test:sandbox": "npx tsx tests/sandbox-integration.test.ts"
```

**Step 4: Commit**

```bash
git add tests/sandbox-integration.test.ts package.json
git commit -m "test(sandbox): add integration tests for filesystem and network isolation

Verifies that sandboxed execute:
- allows writes within the project directory
- blocks writes to home directory
- blocks reads of ~/.ssh
- blocks network to non-allowlisted domains

Tests skip gracefully when sandbox-runtime is not available."
```

---

### Task 8: Final verification and cleanup

**Step 1: Run full test suite**

Run: `npm run test:all`
Expected: All tests PASS

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Verify bundle**

Run: `npm run bundle`
Expected: Bundle creates successfully

**Step 4: Manual smoke test — start the MCP server**

Run: `npx tsx src/server.ts 2>&1 | head -10`
Expected: See sandbox status in startup log

**Step 5: Commit any final cleanup**

If any adjustments were needed, commit them.

**Step 6: Final commit message for the branch**

After all tasks are complete, the branch `feat/sandbox-enforcement` should
contain these commits:

1. `build: add @anthropic-ai/sandbox-runtime dependency`
2. `feat(sandbox): add config builder with Claude Code settings discovery`
3. `feat(sandbox): add initSandbox() lifecycle manager`
4. `feat(sandbox): integrate wrapCommand into PolyglotExecutor`
5. `feat(sandbox): wire sandbox into MCP server startup`
6. `build: add sandbox-runtime to esbuild externals`
7. `test(sandbox): add integration tests for filesystem and network isolation`
