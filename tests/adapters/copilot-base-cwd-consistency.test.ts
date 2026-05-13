/**
 * Issue #539 follow-up — copilot-base `getSettingsPath()` returned a
 * CWD-relative path (`resolve(".github", "hooks", "context-mode.json")`).
 * Two callers — `doctor` and `upgrade` — could legitimately run from
 * different working directories (e.g. CLI invoked from a subdir vs MCP
 * server running with cwd=projectDir), so they each saw a DIFFERENT
 * "settings path" and the diagnostic/repair loop never converged.
 *
 * Fix: `getSettingsPath(projectDir?: string)` now anchors on the supplied
 * projectDir (falling back to `process.cwd()` only when the caller does
 * not know). When the SAME projectDir is supplied from any working
 * directory, the resulting path MUST be identical.
 *
 * The spec for this slice originally said "anchor on pluginRoot, not
 * process.cwd()" — but pluginRoot is the plugin's install cache
 * (`~/.claude/plugins/cache/context-mode/<version>`), which is the wrong
 * directory for a project-scoped `.github/hooks/context-mode.json`. The
 * architecturally correct anchor is the user's projectDir, which mirrors
 * the existing `getConfigDir(projectDir?: string)` signature in
 * vscode-copilot/index.ts:93. Documented in commit body.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { VSCodeCopilotAdapter } from "../../src/adapters/vscode-copilot/index.js";

describe("copilot-base — getSettingsPath() CWD consistency (issue #539)", () => {
  let savedCwd: string;
  let adapter: VSCodeCopilotAdapter;

  beforeEach(() => {
    savedCwd = process.cwd();
    adapter = new VSCodeCopilotAdapter();
  });

  afterEach(() => {
    process.chdir(savedCwd);
  });

  it("returns the SAME path regardless of process.cwd() when projectDir is passed", () => {
    const projectDir = resolve(homedir(), "some-repo");

    // Use cross-platform dirs that exist on every CI runner. Earlier the
    // test chdir'd to "/tmp" which is POSIX-only — Windows runners hit
    // ENOENT (CI run 25740169321). homedir() + tmpdir() are guaranteed-
    // present, drive-aware, and distinct on every platform — which is all
    // we need to exercise the CWD-invariance contract.
    process.chdir(homedir());
    const fromHome = adapter.getSettingsPath(projectDir);

    process.chdir(tmpdir());
    const fromTmp = adapter.getSettingsPath(projectDir);

    expect(fromHome).toBe(fromTmp);
    expect(fromHome).toBe(resolve(projectDir, ".github", "hooks", "context-mode.json"));
  });

  it("falls back to process.cwd() when no projectDir is passed (backwards compatible)", () => {
    const path = adapter.getSettingsPath();
    expect(path).toBe(resolve(process.cwd(), ".github", "hooks", "context-mode.json"));
  });
});
