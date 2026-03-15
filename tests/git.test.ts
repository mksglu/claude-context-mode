import { describe, it, expect, vi } from "vitest";
import { getWorktreeSuffix } from "../src/git.js";

describe("getWorktreeSuffix", () => {
  it("returns empty string in main worktree", () => {
    vi.stubEnv("CONTEXT_MODE_SESSION_SUFFIX", undefined);
    // Assumes test runs in main worktree
    const suffix = getWorktreeSuffix();
    expect(suffix).toBe(""); // or __<basename> if in a worktree
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
