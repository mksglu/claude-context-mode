import { describe, it, expect } from "vitest";
import { extractWorkspace, WorkspaceRouter } from "../../src/openclaw/workspace-router.js";

describe("extractWorkspace", () => {
  it("extracts workspace from exec command path", () => {
    expect(extractWorkspace({ command: "cat /openclaw/workspace-trainer/notes.md" }))
      .toBe("/openclaw/workspace-trainer");
  });

  it("extracts workspace from file_path param", () => {
    expect(extractWorkspace({ file_path: "/openclaw/workspace-divorce/docs/memo.md" }))
      .toBe("/openclaw/workspace-divorce");
  });

  it("extracts workspace from cwd param", () => {
    expect(extractWorkspace({ cwd: "/openclaw/workspace-locadora" }))
      .toBe("/openclaw/workspace-locadora");
  });

  it("returns null for non-workspace paths", () => {
    expect(extractWorkspace({ command: "echo hello" })).toBeNull();
  });

  it("returns null for base /openclaw/workspace (no agent suffix)", () => {
    expect(extractWorkspace({ command: "ls /openclaw/workspace/scripts" }))
      .toBeNull();
  });

  it("handles multiple workspace refs — returns first match", () => {
    expect(extractWorkspace({ command: "cp /openclaw/workspace-trainer/a /openclaw/workspace-divorce/b" }))
      .toBe("/openclaw/workspace-trainer");
  });
});

describe("WorkspaceRouter", () => {
  it("maps sessionKey to workspace and resolves sessionId", () => {
    const router = new WorkspaceRouter();
    router.registerSession("agent:trainer:main", "sid-trainer");
    expect(router.resolveSessionId({ command: "cat /openclaw/workspace-trainer/x" }))
      .toBe("sid-trainer");
  });

  it("returns null for unknown workspace", () => {
    const router = new WorkspaceRouter();
    expect(router.resolveSessionId({ command: "cat /openclaw/workspace-unknown/x" }))
      .toBeNull();
  });

  it("updates sessionId on re-registration", () => {
    const router = new WorkspaceRouter();
    router.registerSession("agent:trainer:main", "sid-old");
    router.registerSession("agent:trainer:main", "sid-new");
    expect(router.resolveSessionId({ command: "cat /openclaw/workspace-trainer/x" }))
      .toBe("sid-new");
  });

  it("handles sessionKey without agent: prefix gracefully", () => {
    const router = new WorkspaceRouter();
    router.registerSession("custom-key", "sid-custom");
    // No workspace derivable — should not crash
    expect(router.resolveSessionId({ command: "cat /openclaw/workspace-trainer/x" }))
      .toBeNull();
  });
});
