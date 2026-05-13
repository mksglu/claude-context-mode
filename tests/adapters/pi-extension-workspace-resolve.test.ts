/**
 * Issue #545 — Pi extension workspace resolver.
 *
 * The Pi extension MUST NOT root sessions under ~/.pi/ (the Pi config dir).
 * `resolvePiWorkspaceDir` is the dedicated helper that picks the user's
 * actual project directory using:
 *   1. PI_WORKSPACE_DIR (extension-set, freshest)
 *   2. PI_PROJECT_DIR (user/legacy override)
 *   3. PWD (shell-set)
 *   4. cwd (last resort)
 *
 * It NEVER returns a path equal to or under `~/.pi/` — even if PI_CONFIG_DIR
 * is set, since that's the config dir, not the workspace.
 */

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePiWorkspaceDir } from "../../src/adapters/pi/extension.js";

const PI_CONFIG_DIR = join(homedir(), ".pi");

describe("resolvePiWorkspaceDir — issue #545 (project dir, not config dir)", () => {
  it("PI_WORKSPACE_DIR wins (extension-set, freshest)", () => {
    const result = resolvePiWorkspaceDir({
      env: {
        PI_WORKSPACE_DIR: "/Users/x/freshest",
        PI_PROJECT_DIR: "/Users/x/legacy",
        PI_CONFIG_DIR: PI_CONFIG_DIR,
      },
      pwd: "/Users/x/somewhere",
      cwd: "/some/cwd",
    });
    expect(result).toBe("/Users/x/freshest");
  });

  it("PI_PROJECT_DIR wins when PI_WORKSPACE_DIR unset", () => {
    const result = resolvePiWorkspaceDir({
      env: {
        PI_PROJECT_DIR: "/Users/x/own-project",
        PI_CONFIG_DIR: PI_CONFIG_DIR,
      },
      pwd: "/Users/x/somewhere",
      cwd: "/some/cwd",
    });
    expect(result).toBe("/Users/x/own-project");
  });

  it("PWD wins when PI_WORKSPACE_DIR / PI_PROJECT_DIR unset", () => {
    const result = resolvePiWorkspaceDir({
      env: { PI_CONFIG_DIR: PI_CONFIG_DIR },
      pwd: "/Users/x/from-shell",
      cwd: "/some/chdir",
    });
    expect(result).toBe("/Users/x/from-shell");
  });

  it("cwd is the final fallback", () => {
    const result = resolvePiWorkspaceDir({
      env: {},
      pwd: undefined,
      cwd: "/Users/x/cwd-fallback",
    });
    expect(result).toBe("/Users/x/cwd-fallback");
  });

  it("never returns the Pi config dir even if the cascade somehow lands there", () => {
    // Adversarial: every input points at ~/.pi/. The function must reject
    // and walk through to a safe final state — caller's cwd is the worst-
    // case anchor; if even that is ~/.pi/, fall back to homedir.
    const result = resolvePiWorkspaceDir({
      env: {
        PI_WORKSPACE_DIR: PI_CONFIG_DIR,
        PI_PROJECT_DIR: join(PI_CONFIG_DIR, "subdir"),
      },
      pwd: PI_CONFIG_DIR,
      cwd: PI_CONFIG_DIR,
    });
    // We cannot return "" or throw — caller wants a usable string.
    // Implementation contract: return homedir() as a non-config safe anchor.
    expect(result).not.toBe(PI_CONFIG_DIR);
    expect(result.startsWith(PI_CONFIG_DIR + "/")).toBe(false);
    expect(result.startsWith(PI_CONFIG_DIR)).toBe(false);
  });

  it("never returns a path UNDER ~/.pi/ from PI_WORKSPACE_DIR", () => {
    // PI_WORKSPACE_DIR somehow set to a child of the config dir — reject.
    const result = resolvePiWorkspaceDir({
      env: {
        PI_WORKSPACE_DIR: join(PI_CONFIG_DIR, "sessions", "abc"),
        PI_PROJECT_DIR: "/Users/x/safe-project",
      },
      pwd: undefined,
      cwd: "/anywhere",
    });
    expect(result).toBe("/Users/x/safe-project");
  });
});
