/**
 * CONTEXT_MODE_REQUIRE_SECURITY=1 fail-closed mode tests (#468 follow-up)
 *
 * When the security module fails to load (e.g. build/security.js missing or
 * corrupt), the default behavior is fail-OPEN — a stderr warning is emitted
 * but routing continues. Security-conscious users can opt in to fail-CLOSED
 * by setting CONTEXT_MODE_REQUIRE_SECURITY=1, in which case every PreToolUse
 * event is denied with a clear reason until the security module loads cleanly.
 *
 * These tests exercise routePreToolUse() directly via a subprocess so the
 * module-level securityInitFailed flag can be controlled deterministically.
 */
import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTING_PATH = join(__dirname, "..", "..", "hooks", "core", "routing.mjs");
const ROUTING_URL = pathToFileURL(ROUTING_PATH).href;

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a small ESM snippet in a child node process. Routing module state
 * (securityInitFailed, guidance throttles) is module-scoped, so a fresh
 * subprocess per test guarantees clean state.
 */
function runChild(code: string, env: Record<string, string> = {}): ChildResult {
  const r = spawnSync("node", ["--input-type=module", "-e", code], {
    encoding: "utf-8",
    timeout: 15_000,
    env: { ...process.env, ...env },
  });
  return {
    status: r.status,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

/**
 * Build a snippet that:
 *   1. imports routePreToolUse + initSecurity from routing.mjs
 *   2. calls initSecurity against the given build dir (controls success/fail)
 *   3. invokes routePreToolUse with a Bash command
 *   4. prints the JSON-serialized decision to stdout
 */
function snippet(buildDir: string, toolName: string, toolInput: Record<string, unknown>): string {
  return `
    import { routePreToolUse, initSecurity, isSecurityInitFailed } from ${JSON.stringify(ROUTING_URL)};
    const ok = await initSecurity(${JSON.stringify(buildDir)});
    const decision = routePreToolUse(${JSON.stringify(toolName)}, ${JSON.stringify(toolInput)});
    process.stdout.write(JSON.stringify({ ok, failed: isSecurityInitFailed(), decision }));
  `;
}

describe("CONTEXT_MODE_REQUIRE_SECURITY=1 fail-closed (#468 follow-up)", () => {
  test("env unset + security init fails → routing passes through (default fail-OPEN preserved)", () => {
    const missingBuildDir = join(tmpdir(), `ctx-require-sec-unset-${Date.now()}`);
    const r = runChild(
      snippet(missingBuildDir, "Bash", { command: "ls" }),
      // Suppress the loud stderr warning — orthogonal to this test.
      { CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "1", CONTEXT_MODE_REQUIRE_SECURITY: "" },
    );
    assert.equal(r.status, 0, `subprocess failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false, "security init should report failure");
    assert.equal(parsed.failed, true, "isSecurityInitFailed() should be true");
    // Default behavior: routing returns null (passthrough) for `ls` (structurally bounded).
    // Critical assertion — the env-unset path must NOT emit a deny.
    assert.notEqual(
      parsed.decision?.action,
      "deny",
      `expected non-deny when env unset, got: ${JSON.stringify(parsed.decision)}`,
    );
  });

  test("env=1 + security init fails → routing returns deny with helpful reason", () => {
    const missingBuildDir = join(tmpdir(), `ctx-require-sec-on-${Date.now()}`);
    const r = runChild(
      snippet(missingBuildDir, "Bash", { command: "ls" }),
      { CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "1", CONTEXT_MODE_REQUIRE_SECURITY: "1" },
    );
    assert.equal(r.status, 0, `subprocess failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.failed, true, "isSecurityInitFailed() should be true");
    assert.ok(parsed.decision, "expected non-null decision when fail-closed engaged");
    assert.equal(parsed.decision.action, "deny", `expected action=deny, got: ${JSON.stringify(parsed.decision)}`);
    assert.ok(
      typeof parsed.decision.reason === "string" && parsed.decision.reason.length > 0,
      "deny decision must include a reason string",
    );
    // Reason must mention the security module is unavailable.
    assert.match(
      parsed.decision.reason,
      /security/i,
      `reason should mention security: ${parsed.decision.reason}`,
    );
    // Reason must include a bypass hint so users aren't stuck.
    assert.ok(
      parsed.decision.reason.includes("CONTEXT_MODE_REQUIRE_SECURITY"),
      `reason should mention the env var to disable: ${parsed.decision.reason}`,
    );
  });

  test("env=1 + security init succeeds → normal passthrough preserved", () => {
    // Stage a temp buildDir containing a minimal valid security.js so initSecurity succeeds.
    const buildDir = mkdtempSync(join(tmpdir(), "ctx-require-sec-ok-"));
    try {
      writeFileSync(
        join(buildDir, "security.js"),
        // Minimal stub matching the API used by routing.mjs.
        // readBashPolicies returns empty array → routing falls through; behavior must be unchanged.
        `export function readBashPolicies(_projectDir) { return []; }
         export function evaluateCommand(_cmd, _policies) { return { decision: "allow" }; }`,
      );
      const r = runChild(
        // `ls` is structurally bounded → routePreToolUse returns null (passthrough).
        snippet(buildDir, "Bash", { command: "ls" }),
        { CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "1", CONTEXT_MODE_REQUIRE_SECURITY: "1" },
      );
      assert.equal(r.status, 0, `subprocess failed: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, true, "security init should succeed when security.js exists");
      assert.equal(parsed.failed, false, "isSecurityInitFailed() should be false on success");
      // No deny — passthrough (null) for structurally-bounded `ls`.
      assert.equal(
        parsed.decision,
        null,
        `expected null passthrough decision, got: ${JSON.stringify(parsed.decision)}`,
      );
    } finally {
      try { rmSync(buildDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  test("env=1 + security init fails + non-Bash tool (Read) → still denied (universal gate)", () => {
    // Fail-closed must be universal: any PreToolUse event, not just Bash. Otherwise
    // a Read tool with secrets in path could leak before security loads.
    const missingBuildDir = join(tmpdir(), `ctx-require-sec-read-${Date.now()}`);
    const r = runChild(
      snippet(missingBuildDir, "Read", { file_path: "/etc/passwd" }),
      { CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "1", CONTEXT_MODE_REQUIRE_SECURITY: "1" },
    );
    assert.equal(r.status, 0, `subprocess failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.decision?.action, "deny", `expected deny for Read too, got: ${JSON.stringify(parsed.decision)}`);
  });
});
