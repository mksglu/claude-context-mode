import { afterEach, describe, it, expect, vi } from "vitest";
import { getWorktreeSuffix } from "../src/git.js";

describe("getWorktreeSuffix", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a valid suffix (empty or __<8-hex>) when no env var is set", () => {
    // No stub — uses git detection. In the main worktree (CI) this will be "".
    // In a secondary worktree it will be "__<8-hex-chars>".
    const suffix = getWorktreeSuffix();
    expect(suffix).toMatch(/^(__[a-f0-9]{8})?$/);
  });

  it("returns empty string when CONTEXT_MODE_SESSION_SUFFIX is empty", () => {
    vi.stubEnv("CONTEXT_MODE_SESSION_SUFFIX", "");
    expect(getWorktreeSuffix()).toBe("");
  });

  it("returns __suffix when CONTEXT_MODE_SESSION_SUFFIX is set", () => {
    vi.stubEnv("CONTEXT_MODE_SESSION_SUFFIX", "my-worktree");
    expect(getWorktreeSuffix()).toBe("__my-worktree");
  });
});
