/**
 * Sandbox Integration Tests
 *
 * Verifies that sandboxed execution actually enforces filesystem and network
 * restrictions at the OS level. These tests only run when the sandbox runtime
 * is available (macOS with sandbox-exec, or Linux with bubblewrap).
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { PolyglotExecutor } from "../src/executor.js";
import { initSandbox } from "../src/sandbox.js";
import { detectRuntimes } from "../src/runtime.js";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  const start = performance.now();
  try {
    await fn();
    const time = performance.now() - start;
    passed++;
    console.log(`  ✓ ${name} (${time.toFixed(0)}ms)`);
  } catch (err: any) {
    const time = performance.now() - start;
    failed++;
    console.log(`  ✗ ${name} (${time.toFixed(0)}ms)`);
    console.log(`    Error: ${err.message}`);
  }
}

async function main() {
  console.log("\nSandbox Integration Tests\n");

  const runtimes = detectRuntimes();
  const projectDir = mkdtempSync(join(tmpdir(), "ctx-sandbox-test-"));
  const sandbox = await initSandbox(projectDir);

  if (!sandbox.sandboxed) {
    console.log("Sandbox not available on this system — skipping integration tests");
    console.log("(This is expected if bubblewrap is not installed on Linux,");
    console.log(" or if sandbox-exec is unavailable)");
    rmSync(projectDir, { recursive: true, force: true });
    console.log("\n0 passed, 0 failed, 0 skipped (sandbox unavailable)");
    process.exit(0);
  }

  const executor = new PolyglotExecutor({
    runtimes,
    projectRoot: projectDir,
    wrapCommand: sandbox.wrapCommand,
  });

  console.log("--- Filesystem: Write Restrictions ---\n");

  await test("allows write within project directory", async () => {
    const r = await executor.execute({
      language: "shell",
      code: `echo "hello" > "${projectDir}/test-output.txt" && cat "${projectDir}/test-output.txt"`,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello"));
  });

  await test("allows write to sandbox TMPDIR (/tmp/claude)", async () => {
    // The seatbelt profile blocks direct writes to /tmp but allows writing
    // under /tmp/claude (the TMPDIR that wrapWithSandbox injects).
    const r = await executor.execute({
      language: "shell",
      code: `mkdir -p /tmp/claude && echo "tmpwrite" > /tmp/claude/sandbox-test.txt && cat /tmp/claude/sandbox-test.txt`,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("tmpwrite"));
  });

  await test("blocks write to home directory", async () => {
    const targetFile = join(homedir(), ".sandbox-test-canary-" + Date.now());
    const r = await executor.execute({
      language: "shell",
      code: `echo "should not appear" > "${targetFile}" 2>&1; echo "exit:$?"`,
    });
    // The sandbox should either make the command fail or silently prevent the write
    const writeBlocked = !existsSync(targetFile) || r.exitCode !== 0;
    assert.ok(writeBlocked, "Write to home directory should have been blocked");
    // Clean up just in case
    try { rmSync(targetFile, { force: true }); } catch {}
  });

  console.log("\n--- Filesystem: Read Restrictions ---\n");

  await test("blocks read of ~/.ssh", async () => {
    const r = await executor.execute({
      language: "shell",
      code: "ls ~/.ssh 2>&1",
    });
    // Either the command fails or output indicates permission denied
    const readBlocked =
      r.exitCode !== 0 ||
      /denied|not permitted|no such/i.test(r.stdout + r.stderr);
    assert.ok(readBlocked, "Read of ~/.ssh should have been blocked or denied");
  });

  console.log("\n--- Network: Domain Filtering ---\n");

  await test("blocks network to non-allowlisted domain", async () => {
    const r = await executor.execute({
      language: "shell",
      code: "curl -s --connect-timeout 3 https://example.com 2>&1",
      timeout: 10_000,
    });
    // Should fail — example.com is not in the allowed domains list
    const netBlocked =
      r.exitCode !== 0 ||
      r.stdout.trim() === "" ||
      /denied|refused|timed out|proxy/i.test(r.stdout + r.stderr);
    assert.ok(netBlocked, "Network to non-allowlisted domain should have been blocked");
  });

  // Cleanup
  await sandbox.cleanup();
  rmSync(projectDir, { recursive: true, force: true });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log("=".repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
