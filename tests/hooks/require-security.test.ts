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

// ─────────────────────────────────────────────────────────
// Helper: missing-bundle env override.
//
// Bundle-first resolution (#558) means simulating "security can't load"
// now requires BOTH the bundle path and the build path to point at
// non-existent files. CONTEXT_MODE_SECURITY_BUNDLE_PATH is the test seam.
// All fail-closed tests below opt-in via this helper.
// ─────────────────────────────────────────────────────────
function missingBundlePath(label: string): string {
  return join(tmpdir(), `ctx-${label}-missing-bundle-${Date.now()}.bundle.mjs`);
}

describe("CONTEXT_MODE_REQUIRE_SECURITY=1 fail-closed (#468 follow-up)", () => {
  test("env unset + security init fails → routing passes through (default fail-OPEN preserved)", () => {
    const missingBuildDir = join(tmpdir(), `ctx-require-sec-unset-${Date.now()}`);
    const r = runChild(
      snippet(missingBuildDir, "Bash", { command: "ls" }),
      // Suppress the loud stderr warning — orthogonal to this test.
      {
        CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "1",
        CONTEXT_MODE_REQUIRE_SECURITY: "",
        // #558 — neutralize the real hooks/security.bundle.mjs so the test
        // observes the "no security artifact present" path deterministically.
        CONTEXT_MODE_SECURITY_BUNDLE_PATH: missingBundlePath("require-sec-unset"),
      },
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
      {
        CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "1",
        CONTEXT_MODE_REQUIRE_SECURITY: "1",
        CONTEXT_MODE_SECURITY_BUNDLE_PATH: missingBundlePath("require-sec-on"),
      },
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
      {
        CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "1",
        CONTEXT_MODE_REQUIRE_SECURITY: "1",
        CONTEXT_MODE_SECURITY_BUNDLE_PATH: missingBundlePath("require-sec-read"),
      },
    );
    assert.equal(r.status, 0, `subprocess failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.decision?.action, "deny", `expected deny for Read too, got: ${JSON.stringify(parsed.decision)}`);
  });
});

// ─────────────────────────────────────────────────────────
// Bundle-first resolution (#558 — marketplace install fail-open regression)
// ─────────────────────────────────────────────────────────
//
// Marketplace installs (Claude Code plugins) ship via `git clone`, which
// honors .gitignore — so `build/security.js` (a tsc artifact) is NEVER
// materialized at the install path. For ~71 days × 121 releases the
// `permissions.deny` enforcement was silently fail-open on every
// marketplace install. Fix: ship security as `hooks/security.bundle.mjs`
// (esbuild output, marketplace-safe via CI's `git add -f`), and have
// `initSecurity()` try the bundle FIRST, falling back to `build/security.js`
// only when the bundle is absent.
//
// The CONTEXT_MODE_SECURITY_BUNDLE_PATH env var is the test seam — it lets
// the subprocess point initSecurity() at a staged bundle in a temp dir
// instead of the real `hooks/security.bundle.mjs` (which would pollute the
// repo and create a chicken-and-egg with the bundle generation step).

describe("initSecurity — bundle-first resolution (#558)", () => {
  test("loads security from CONTEXT_MODE_SECURITY_BUNDLE_PATH when build/security.js is missing (marketplace scenario)", () => {
    // Stage a valid security bundle in tmpdir. Build dir does NOT exist
    // (mirroring marketplace installs where .gitignore excludes build/).
    const bundleDir = mkdtempSync(join(tmpdir(), "ctx-sec-bundle-"));
    const bundlePath = join(bundleDir, "security.bundle.mjs");
    const missingBuildDir = join(tmpdir(), `ctx-sec-bundle-build-missing-${Date.now()}`);
    try {
      writeFileSync(
        bundlePath,
        // Minimal stub matching the API used by routing.mjs.
        `export function readBashPolicies(_projectDir) { return []; }
         export function evaluateCommand(_cmd, _policies) { return { decision: "allow" }; }`,
      );
      const r = runChild(
        snippet(missingBuildDir, "Bash", { command: "ls" }),
        {
          CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "1",
          CONTEXT_MODE_REQUIRE_SECURITY: "",
          CONTEXT_MODE_SECURITY_BUNDLE_PATH: bundlePath,
        },
      );
      assert.equal(r.status, 0, `subprocess failed: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      // Bundle path resolved — security loaded — fail-open regression closed.
      assert.equal(parsed.ok, true, `initSecurity should succeed via bundle (build missing). stderr=${r.stderr}`);
      assert.equal(parsed.failed, false, "isSecurityInitFailed() should be false when bundle loaded");
    } finally {
      try { rmSync(bundleDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  test("fail-open warning still fires when BOTH bundle and build/security.js are missing", () => {
    // Pre-existing fail-open contract MUST be preserved when neither artifact
    // is available — a missing bundle should not silently break initSecurity().
    const missingBundlePath = join(tmpdir(), `ctx-sec-bundle-none-${Date.now()}.bundle.mjs`);
    const missingBuildDir = join(tmpdir(), `ctx-sec-build-none-${Date.now()}`);
    const r = runChild(
      snippet(missingBuildDir, "Bash", { command: "ls" }),
      {
        // Do NOT suppress — we want to assert the warning string contains
        // bundle-aware fix guidance (so users on marketplace installs are
        // pointed at the right remediation, not just `npm run build`).
        CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "",
        CONTEXT_MODE_REQUIRE_SECURITY: "",
        CONTEXT_MODE_SECURITY_BUNDLE_PATH: missingBundlePath,
      },
    );
    assert.equal(r.status, 0, `subprocess failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false, "initSecurity must fail when both artifacts absent");
    assert.equal(parsed.failed, true, "isSecurityInitFailed() must be true");
    // The stderr warning must mention BOTH the bundle and the build/ paths
    // so users on either install path can self-diagnose.
    assert.match(
      r.stderr,
      /security/i,
      `stderr should mention security: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /bundle|hooks\/security\.bundle\.mjs/i,
      `stderr should mention the bundle path: ${r.stderr}`,
    );
  });

  test("bundle-first preference: bundle wins when both bundle and build/security.js exist", () => {
    // If both artifacts are present, bundle takes precedence. The bundle
    // exports a sentinel decision shape so the test can prove which file
    // was actually loaded (build's stub returns "allow"; bundle returns
    // a custom marker via SecurityPolicy violation — but here we use a
    // simpler check: the bundle is bare-minimum like the build stub, and
    // we assert no fallback warning is emitted when the bundle resolves).
    const bundleDir = mkdtempSync(join(tmpdir(), "ctx-sec-bundle-priority-"));
    const bundlePath = join(bundleDir, "security.bundle.mjs");
    const buildDir = mkdtempSync(join(tmpdir(), "ctx-sec-build-priority-"));
    try {
      writeFileSync(
        bundlePath,
        `export function readBashPolicies(_projectDir) { return []; }
         export function evaluateCommand(_cmd, _policies) { return { decision: "allow" }; }`,
      );
      writeFileSync(
        join(buildDir, "security.js"),
        // Build stub throws on import — proves it's never loaded when bundle wins.
        `throw new Error("BUILD_STUB_LOADED — bundle preference broken");`,
      );
      const r = runChild(
        snippet(buildDir, "Bash", { command: "ls" }),
        {
          CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "1",
          CONTEXT_MODE_REQUIRE_SECURITY: "",
          CONTEXT_MODE_SECURITY_BUNDLE_PATH: bundlePath,
        },
      );
      assert.equal(r.status, 0, `subprocess failed: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, true, `bundle should win over build/. stderr=${r.stderr}`);
      assert.equal(parsed.failed, false, "isSecurityInitFailed() must be false");
      // The throwing stub must not have run.
      assert.doesNotMatch(
        r.stderr,
        /BUILD_STUB_LOADED/,
        `build/security.js was loaded — bundle preference is broken: ${r.stderr}`,
      );
    } finally {
      try { rmSync(bundleDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { rmSync(buildDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});
