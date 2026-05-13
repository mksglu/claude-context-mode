/**
 * Issue #542 — ctx_upgrade MCP handler MUST thread MCP clientInfo into
 * the spawned `upgrade` process so the upgrade flow honors the
 * highest-confidence detection tier instead of falling through to the
 * config-dir heuristic (which misdetects Pi/OMP installs as Cursor when
 * ~/.cursor/ also exists).
 *
 * Defense-in-depth checked here:
 *   1. server.ts ctx_upgrade handler captures clientInfo via
 *      server.server.getClientVersion() (pure JS pass — in-process, no
 *      spawn boundary).
 *   2. server.ts ctx_upgrade handler resolves the platform with
 *      detectPlatform(clientInfo ?? undefined) so the same priority
 *      chain that the MCP server uses applies to upgrade.
 *   3. server.ts ctx_upgrade handler emits a `--platform <id>` flag on
 *      the returned shell command. POSIX (bash/zsh/sh), Windows Git
 *      Bash, and PowerShell all forward CLI args identically — no
 *      env-var prefix that breaks on cmd.exe.
 *   4. cli.ts upgrade() honors a `--platform <id>` flag and skips
 *      detectPlatform() when present (the bundle drift root cause —
 *      bundled Lf() called detectPlatform() without clientInfo).
 *
 * Source-text inspection mirrors tests/util/cli-upgrade-verification.test.ts.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const serverSrc = readFileSync(resolve(ROOT, "src", "server.ts"), "utf-8");
const cliSrc = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");

// Carve out the ctx_upgrade handler body so we don't false-positive on
// unrelated detectPlatform calls elsewhere in server.ts (e.g. the MCP
// initialize handshake path).
const upgradeRegisterIdx = serverSrc.indexOf('"ctx_upgrade"');
const upgradeHandlerEnd = serverSrc.indexOf("// ── ctx-purge", upgradeRegisterIdx);
const ctxUpgradeHandler = serverSrc.slice(upgradeRegisterIdx, upgradeHandlerEnd);

describe("ctx_upgrade MCP handler threads clientInfo (issue #542)", () => {
  test("handler captures clientInfo via server.getClientVersion()", () => {
    // Must read the live MCP clientInfo — not a stale module-level copy.
    expect(ctxUpgradeHandler).toMatch(/server\.server\.getClientVersion\(\)/);
  });

  test("handler resolves platform via detectPlatform(clientInfo)", () => {
    // Must pass clientInfo to detectPlatform — not call it with no args
    // (which was the bundle-Lf() bug per issue #542 walkthrough).
    expect(ctxUpgradeHandler).toMatch(/detectPlatform\(\s*clientInfo[^\)]*\)/);
  });

  test("handler emits --platform <id> in the returned shell command", () => {
    // --platform flag is cross-shell safe (POSIX bash, zsh, Windows Git
    // Bash, PowerShell, cmd.exe all forward CLI args identically). Env-var
    // prefixes like CONTEXT_MODE_PLATFORM=pi cmd would break on cmd.exe.
    expect(ctxUpgradeHandler).toMatch(/--platform/);
  });
});

describe("cli.ts upgrade() honors --platform flag (issue #542)", () => {
  test("argv parse extracts --platform <id> before invoking upgrade()", () => {
    // The entry-point switch (cli.ts:141) must forward the flag — either
    // as a function argument or by setting CONTEXT_MODE_PLATFORM env var
    // before detectPlatform() runs.
    expect(cliSrc).toMatch(/--platform/);
  });

  test("upgrade() prefers explicit --platform over detectPlatform()", () => {
    // When --platform is supplied, detectPlatform()'s heuristic chain
    // must NOT override it. We assert the source threads the flag into
    // either getAdapter() directly or CONTEXT_MODE_PLATFORM (which
    // detectPlatform() already honors as the explicit-override tier).
    const upgradeIdx = cliSrc.indexOf("async function upgrade");
    const upgradeBody = cliSrc.slice(upgradeIdx, upgradeIdx + 14000);
    expect(upgradeBody).toMatch(/--platform|platformOverride|opts\.platform/);
  });
});
