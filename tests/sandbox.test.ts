/**
 * Sandbox Config Builder Tests
 *
 * Verifies buildSandboxConfig() produces correct filesystem and network
 * policies, including env var overrides and Claude Code settings discovery.
 */

import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSandboxConfig, initSandbox, type SandboxConfig } from "../src/sandbox.js";

let passed = 0;
let failed = 0;
const results: { name: string; status: "PASS" | "FAIL"; time: number; error?: string }[] = [];

async function test(name: string, fn: () => void | Promise<void>) {
  const start = performance.now();
  try {
    await fn();
    const time = performance.now() - start;
    passed++;
    results.push({ name, status: "PASS", time });
    console.log(`  ✓ ${name} (${time.toFixed(0)}ms)`);
  } catch (err: unknown) {
    const time = performance.now() - start;
    failed++;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, status: "FAIL", time, error: message });
    console.log(`  ✗ ${name} (${time.toFixed(0)}ms)`);
    console.log(`    ${message}`);
  }
}

// Save original env vars so tests can restore them.
const origNoSandbox = process.env.CONTEXT_MODE_NO_SANDBOX;
const origAllowedDomains = process.env.CONTEXT_MODE_ALLOWED_DOMAINS;

function cleanEnv() {
  delete process.env.CONTEXT_MODE_NO_SANDBOX;
  delete process.env.CONTEXT_MODE_ALLOWED_DOMAINS;
}

async function main() {
  console.log("\nContext Mode — Sandbox Config Builder Tests");
  console.log("=============================================\n");

  // ===== FILESYSTEM CONFIG =====
  console.log("--- Filesystem Config ---\n");

  await test("allowWrite includes projectRoot and /tmp", () => {
    cleanEnv();
    const config = buildSandboxConfig("/home/user/project");
    assert.ok(
      config.filesystem.allowWrite.includes("/home/user/project"),
      `Expected projectRoot in allowWrite, got: ${config.filesystem.allowWrite}`,
    );
    assert.ok(
      config.filesystem.allowWrite.includes("/tmp"),
      `Expected /tmp in allowWrite, got: ${config.filesystem.allowWrite}`,
    );
  });

  await test("denyRead includes sensitive paths", () => {
    cleanEnv();
    const config = buildSandboxConfig("/proj");
    const sensitive = ["~/.ssh", "~/.gnupg", "~/.aws/credentials"];
    for (const path of sensitive) {
      assert.ok(
        config.filesystem.denyRead.includes(path),
        `Expected '${path}' in denyRead, got: ${config.filesystem.denyRead}`,
      );
    }
  });

  await test("denyWrite includes .env", () => {
    cleanEnv();
    const config = buildSandboxConfig("/proj");
    assert.ok(
      config.filesystem.denyWrite.includes(".env"),
      `Expected '.env' in denyWrite, got: ${config.filesystem.denyWrite}`,
    );
  });

  // ===== DISABLED MODE =====
  console.log("\n--- Disabled Mode ---\n");

  await test("CONTEXT_MODE_NO_SANDBOX=1 returns disabled: true", () => {
    cleanEnv();
    process.env.CONTEXT_MODE_NO_SANDBOX = "1";
    const config = buildSandboxConfig("/proj");
    assert.equal(config.disabled, true, "Expected disabled to be true");
    // All arrays should be empty when disabled.
    assert.deepEqual(config.filesystem.denyRead, []);
    assert.deepEqual(config.filesystem.allowWrite, []);
    assert.deepEqual(config.filesystem.denyWrite, []);
    assert.deepEqual(config.network.allowedDomains, []);
    assert.deepEqual(config.network.deniedDomains, []);
  });

  await test("disabled is false when CONTEXT_MODE_NO_SANDBOX is unset", () => {
    cleanEnv();
    const config = buildSandboxConfig("/proj");
    assert.equal(config.disabled, false);
  });

  // ===== NETWORK CONFIG: ENV VAR OVERRIDE =====
  console.log("\n--- Network Config: Env Var Override ---\n");

  await test("CONTEXT_MODE_ALLOWED_DOMAINS override works", () => {
    cleanEnv();
    process.env.CONTEXT_MODE_ALLOWED_DOMAINS = "example.com,internal.corp";
    const config = buildSandboxConfig("/proj");
    assert.deepEqual(config.network.allowedDomains, ["example.com", "internal.corp"]);
  });

  await test("CONTEXT_MODE_ALLOWED_DOMAINS trims whitespace", () => {
    cleanEnv();
    process.env.CONTEXT_MODE_ALLOWED_DOMAINS = " foo.com , bar.com ";
    const config = buildSandboxConfig("/proj");
    assert.deepEqual(config.network.allowedDomains, ["foo.com", "bar.com"]);
  });

  // ===== NETWORK CONFIG: CLAUDE CODE SETTINGS =====
  console.log("\n--- Network Config: Claude Code Settings ---\n");

  await test("reads sandbox.network.allowedDomains from Claude Code settings", () => {
    cleanEnv();
    const fakeHome = join(tmpdir(), `sandbox-test-home-${Date.now()}`);
    const claudeDir = join(fakeHome, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        sandbox: { network: { allowedDomains: ["custom.example.com", "api.custom.com"] } },
      }),
    );

    const config = buildSandboxConfig("/proj", fakeHome);
    assert.deepEqual(config.network.allowedDomains, ["custom.example.com", "api.custom.com"]);

    rmSync(fakeHome, { recursive: true, force: true });
  });

  await test("reads sandboxNetwork.allowedDomains (flat key) from Claude Code settings", () => {
    cleanEnv();
    const fakeHome = join(tmpdir(), `sandbox-test-home-${Date.now()}`);
    const claudeDir = join(fakeHome, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        sandboxNetwork: { allowedDomains: ["flat.example.com"] },
      }),
    );

    const config = buildSandboxConfig("/proj", fakeHome);
    assert.deepEqual(config.network.allowedDomains, ["flat.example.com"]);

    rmSync(fakeHome, { recursive: true, force: true });
  });

  await test("env var override takes precedence over Claude Code settings", () => {
    cleanEnv();
    process.env.CONTEXT_MODE_ALLOWED_DOMAINS = "env.com";

    const fakeHome = join(tmpdir(), `sandbox-test-home-${Date.now()}`);
    const claudeDir = join(fakeHome, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        sandbox: { network: { allowedDomains: ["settings.com"] } },
      }),
    );

    const config = buildSandboxConfig("/proj", fakeHome);
    assert.deepEqual(
      config.network.allowedDomains,
      ["env.com"],
      "Env var should take precedence over Claude Code settings",
    );

    rmSync(fakeHome, { recursive: true, force: true });
  });

  // ===== NETWORK CONFIG: DEFAULTS =====
  console.log("\n--- Network Config: Defaults ---\n");

  await test("default domains include github.com when no override or settings", () => {
    cleanEnv();
    // Use a non-existent home dir so no settings file is found.
    const fakeHome = join(tmpdir(), `sandbox-test-nohome-${Date.now()}`);
    const config = buildSandboxConfig("/proj", fakeHome);
    assert.ok(
      config.network.allowedDomains.includes("github.com"),
      `Expected 'github.com' in defaults, got: ${config.network.allowedDomains}`,
    );
    assert.ok(
      config.network.allowedDomains.includes("api.github.com"),
      `Expected 'api.github.com' in defaults`,
    );
    assert.ok(
      config.network.allowedDomains.includes("registry.npmjs.org"),
      `Expected 'registry.npmjs.org' in defaults`,
    );
  });

  await test("deniedDomains is always empty", () => {
    cleanEnv();
    const fakeHome = join(tmpdir(), `sandbox-test-nohome-${Date.now()}`);
    const config = buildSandboxConfig("/proj", fakeHome);
    assert.deepEqual(config.network.deniedDomains, []);
  });

  // ===== TYPE SHAPE =====
  console.log("\n--- Type Shape ---\n");

  await test("returned config has all required keys", () => {
    cleanEnv();
    const config = buildSandboxConfig("/proj");
    assert.equal(typeof config.disabled, "boolean");
    assert.ok(Array.isArray(config.filesystem.denyRead));
    assert.ok(Array.isArray(config.filesystem.allowWrite));
    assert.ok(Array.isArray(config.filesystem.denyWrite));
    assert.ok(Array.isArray(config.network.allowedDomains));
    assert.ok(Array.isArray(config.network.deniedDomains));
  });

  // ===== initSandbox() LIFECYCLE =====
  console.log("\n--- initSandbox() Lifecycle ---\n");

  await test("initSandbox returns a SandboxHandle", async () => {
    cleanEnv();
    const result = await initSandbox("/tmp/test-project");
    assert.equal(typeof result.wrapCommand, "function");
    assert.equal(typeof result.cleanup, "function");
    assert.equal(typeof result.sandboxed, "boolean");
    await result.cleanup();
  });

  await test("initSandbox with NO_SANDBOX returns passthrough wrapper", async () => {
    cleanEnv();
    process.env.CONTEXT_MODE_NO_SANDBOX = "1";
    const result = await initSandbox("/tmp/test-project");
    assert.equal(result.sandboxed, false);
    const wrapped = await result.wrapCommand("echo hello");
    assert.equal(wrapped, "echo hello");
    await result.cleanup();
    delete process.env.CONTEXT_MODE_NO_SANDBOX;
  });

  // ===== CLEANUP & SUMMARY =====

  // Restore original env vars.
  if (origNoSandbox !== undefined) process.env.CONTEXT_MODE_NO_SANDBOX = origNoSandbox;
  else delete process.env.CONTEXT_MODE_NO_SANDBOX;
  if (origAllowedDomains !== undefined) process.env.CONTEXT_MODE_ALLOWED_DOMAINS = origAllowedDomains;
  else delete process.env.CONTEXT_MODE_ALLOWED_DOMAINS;

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log("=".repeat(60));

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => r.status === "FAIL")) {
      console.log(`  ✗ ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Sandbox test runner error:", err);
  process.exit(1);
});
