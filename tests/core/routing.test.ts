import { describe, it, expect, beforeEach } from "vitest";
import {
  routePreToolUse,
  resetGuidanceThrottle,
  isStructurallyBounded,
} from "../../hooks/core/routing.mjs";
import { createRoutingBlock } from "../../hooks/routing-block.mjs";
import { createToolNamer } from "../../hooks/core/tool-naming.mjs";

// Subagent routing uses createRoutingBlock(t, { includeCommands: false })
const _t = createToolNamer("claude-code");
const SUBAGENT_BLOCK = createRoutingBlock(_t, { includeCommands: false });

describe("Routing: Subagents (Agent only — Task removed per #241)", () => {
  it("Agent tool injects routing block into prompt field", () => {
    const fields = ["prompt", "request", "objective", "question", "query", "task"];

    for (const field of fields) {
      const toolInput = { [field]: "hello" };
      const decision = routePreToolUse("Agent", toolInput, "/test");

      expect(decision.action).toBe("modify");
      expect(decision.updatedInput[field]).toBe("hello" + SUBAGENT_BLOCK);
    }
  });

  it("Agent falls back to 'prompt' field if no known field is present", () => {
    const toolInput = { unknown_field: "content" };
    const decision = routePreToolUse("Agent", toolInput, "/test");

    expect(decision.action).toBe("modify");
    expect(decision.updatedInput.prompt).toBe(SUBAGENT_BLOCK);
  });

  it("Agent converts subagent_type='Bash' to 'general-purpose'", () => {
    const toolInput = {
      prompt: "do something",
      subagent_type: "Bash"
    };
    const decision = routePreToolUse("Agent", toolInput, "/test");

    expect(decision.action).toBe("modify");
    expect(decision.updatedInput.prompt).toBe("do something" + SUBAGENT_BLOCK);
    expect(decision.updatedInput.subagent_type).toBe("general-purpose");
  });

  it("Agent preserves other fields when modifying", () => {
    const toolInput = {
      request: "analyze this",
      other_param: 123,
      nested: { a: 1 }
    };
    const decision = routePreToolUse("Agent", toolInput, "/test");

    expect(decision.action).toBe("modify");
    expect(decision.updatedInput.request).toBe("analyze this" + SUBAGENT_BLOCK);
    expect(decision.updatedInput.other_param).toBe(123);
    expect(decision.updatedInput.nested).toEqual({ a: 1 });
  });

  it("Agent routing block contains label guidance for batch_execute (#256)", () => {
    const decision = routePreToolUse("Agent", { prompt: "test" }, "/test");
    const prompt = decision.updatedInput.prompt;
    expect(prompt).toContain("label");
    expect(prompt).toContain("descriptive");
    expect(prompt).toContain("FTS5 chunk title");
  });

  it("Task tool is NOT routed — returns null (passthrough) (#241)", () => {
    const toolInput = { prompt: "create a task" };
    const decision = routePreToolUse("Task", toolInput, "/test");

    // Task should not be intercepted — it matches TaskCreate/TaskUpdate via substring
    expect(decision).toBeNull();
  });

  it("TaskCreate is NOT routed — returns null (passthrough)", () => {
    const decision = routePreToolUse("TaskCreate", { title: "my task" }, "/test");
    expect(decision).toBeNull();
  });

  it("TaskUpdate is NOT routed — returns null (passthrough)", () => {
    const decision = routePreToolUse("TaskUpdate", { id: "123", status: "done" }, "/test");
    expect(decision).toBeNull();
  });
});

describe("Bash structurally-bounded allowlist (#463)", () => {
  // Each test resets the guidance throttle so the per-session marker doesn't
  // bleed across tests. The throttle is global to the routing module — without
  // the reset, only the first bash test in the file would observe the nudge.
  const SID = "issue-463-tests";
  beforeEach(() => resetGuidanceThrottle(SID));

  it("pwd / whoami / hostname / date — no nudge", () => {
    for (const command of ["pwd", "whoami", "hostname", "hostname -f", "date", "date -Iseconds"]) {
      resetGuidanceThrottle(SID);
      const decision = routePreToolUse("Bash", { command }, "/test", "claude-code", SID);
      expect(decision, `expected null for ${command}`).toBeNull();
    }
  });

  it("echo / printf / which / type / command -v — no nudge", () => {
    for (const command of [
      "echo hello",
      "printf '%s' x",
      "which node",
      "type git",
      "command -v gh",
    ]) {
      resetGuidanceThrottle(SID);
      const decision = routePreToolUse("Bash", { command }, "/test", "claude-code", SID);
      expect(decision, `expected null for ${command}`).toBeNull();
    }
  });

  it("git read-only subcommands — no nudge", () => {
    for (const command of [
      "git status",
      "git status --short",
      "git rev-parse HEAD",
      "git remote -v",
      "git remote show origin",
      "git branch",
      "git branch -vv",
      "git config --get user.email",
      "git diff --stat",
      "git diff --name-only",
      "git stash list",
      "git tag",
      "git tag -l 'v1.*'",
      "git log -5",
      "git log -10 --oneline",
    ]) {
      resetGuidanceThrottle(SID);
      const decision = routePreToolUse("Bash", { command }, "/test", "claude-code", SID);
      expect(decision, `expected null for ${command}`).toBeNull();
    }
  });

  it("--version / -V probes — no nudge", () => {
    for (const command of [
      "node --version",
      "npm --version",
      "git --version",
      "node -V",
    ]) {
      resetGuidanceThrottle(SID);
      const decision = routePreToolUse("Bash", { command }, "/test", "claude-code", SID);
      expect(decision, `expected null for ${command}`).toBeNull();
    }
  });

  it("ls without -R is bounded; ls -R is unbounded", () => {
    resetGuidanceThrottle(SID);
    expect(routePreToolUse("Bash", { command: "ls" }, "/test", "claude-code", SID)).toBeNull();
    resetGuidanceThrottle(SID);
    expect(routePreToolUse("Bash", { command: "ls -la /etc" }, "/test", "claude-code", SID)).toBeNull();
    resetGuidanceThrottle(SID);
    // ls -R could flood — must still nudge
    const lsR = routePreToolUse("Bash", { command: "ls -R /" }, "/test", "claude-code", SID);
    expect(lsR?.action).toBe("context");
    resetGuidanceThrottle(SID);
    const lsLong = routePreToolUse("Bash", { command: "ls --recursive" }, "/test", "claude-code", SID);
    expect(lsLong?.action).toBe("context");
  });

  it("unbounded commands still get the nudge", () => {
    for (const command of [
      "find /",
      "cat /var/log/syslog",
      "grep -r foo /etc",
      "ps aux",
      "git log",      // no -<N> bound
      "git diff",     // raw diff can be huge
    ]) {
      resetGuidanceThrottle(SID);
      const decision = routePreToolUse("Bash", { command }, "/test", "claude-code", SID);
      expect(decision?.action, `expected nudge for ${command}`).toBe("context");
    }
  });

  it("safe command + shell control operator → still nudged (composition risk)", () => {
    // A pipe, redirect, command substitution, or chain can attach an
    // unbounded sink to an otherwise-safe command. The allowlist must
    // refuse to short-circuit these — otherwise users can wrap floods
    // behind a `pwd && cat huge`.
    const cases = [
      "pwd | xargs cat",
      "pwd > /tmp/out",
      "pwd >> /tmp/out",
      "echo $(find /)",
      "echo `find /`",
      "git status && cat huge.log",
      "git status || tail -F /var/log/syslog",
      "whoami; find /",
      // Single `&` (background + sequence) — distinct from `&&` and easy to
      // miss in the operator regex. `date & cat huge.log` runs date in the
      // background and immediately tails the unbounded sink.
      "date & cat /var/log/syslog",
      "whoami & find /",
      "pwd & tail -F huge.log",
    ];
    for (const command of cases) {
      resetGuidanceThrottle(SID);
      const decision = routePreToolUse("Bash", { command }, "/test", "claude-code", SID);
      expect(decision?.action, `expected nudge for ${command}`).toBe("context");
    }
  });

  it("cp / mv / rm with -v / --verbose → still nudged (verbose floods on big trees)", () => {
    // The "silent on success" invariant of cp/mv/rm only holds without -v.
    // Verbose flag prints one line per file, which can flood on big trees
    // (recursive copy of /etc, mass rename, etc.).
    const cases = [
      "cp -v /a /b",
      "cp -rv /a /b",
      "cp -v -r /etc /tmp",
      "cp --verbose /a /b",
      "mv -v /a /b",
      "mv --verbose /a /b",
      "rm -v /tmp/foo",
      "rm -rv /tmp/foo",
      "rm --verbose /tmp/foo",
    ];
    for (const command of cases) {
      resetGuidanceThrottle(SID);
      const decision = routePreToolUse("Bash", { command }, "/test", "claude-code", SID);
      expect(decision?.action, `expected nudge for ${command}`).toBe("context");
    }
  });

  it("cp / mv / rm without -v → still allowlisted", () => {
    // Sanity: the verbose carve-out must not regress the silent-success
    // case, which is the whole reason these are in the allowlist.
    for (const command of [
      "cp /a /b",
      "cp -r /a /b",
      "mv /a /b",
      "rm /tmp/foo",
      "rm -rf /tmp/foo",
    ]) {
      resetGuidanceThrottle(SID);
      const decision = routePreToolUse("Bash", { command }, "/test", "claude-code", SID);
      expect(decision, `expected null for ${command}`).toBeNull();
    }
  });

  it("isStructurallyBounded — direct unit checks", () => {
    expect(isStructurallyBounded("pwd")).toBe(true);
    expect(isStructurallyBounded("git status")).toBe(true);
    expect(isStructurallyBounded("node --version")).toBe(true);
    expect(isStructurallyBounded("ls")).toBe(true);
    expect(isStructurallyBounded("ls -R")).toBe(false);
    expect(isStructurallyBounded("find /")).toBe(false);
    expect(isStructurallyBounded("git log")).toBe(false);
    expect(isStructurallyBounded("git log -5")).toBe(true);
    expect(isStructurallyBounded("pwd | cat")).toBe(false);
    expect(isStructurallyBounded("")).toBe(false);
    expect(isStructurallyBounded(undefined as unknown as string)).toBe(false);
  });
});

describe("Bash structurally-bounded allowlist: newline injection (#470)", () => {
  // Bash treats newline as a statement separator (equivalent to `;`). A safe
  // first line followed by an unbounded sink on line 2 must NOT be allowlisted —
  // otherwise the nudge is suppressed and the flood hits context.
  //
  // Same defect class for `\r\n` (Windows clipboard pastes — see #470).
  const SID = "issue-470-tests";
  beforeEach(() => resetGuidanceThrottle(SID));

  it("LF newline injection — allowlisted line 1 + unbounded line 2 must nudge", () => {
    const cases = [
      "git status\nfind /",
      "echo ok\nfind /",
      "echo ok\nrm -rf /",
      "pwd\ncat /var/log/syslog",
      "whoami\ngrep -r foo /etc",
    ];
    for (const command of cases) {
      resetGuidanceThrottle(SID);
      const decision = routePreToolUse("Bash", { command }, "/test", "claude-code", SID);
      expect(decision?.action, `expected nudge for ${JSON.stringify(command)}`).toBe("context");
    }
  });

  it("CRLF newline injection (Windows clipboard) must nudge", () => {
    const cases = [
      "git status\r\nfind /",
      "echo ok\r\nrm -rf /",
      "pwd\r\ncat /var/log/syslog",
    ];
    for (const command of cases) {
      resetGuidanceThrottle(SID);
      const decision = routePreToolUse("Bash", { command }, "/test", "claude-code", SID);
      expect(decision?.action, `expected nudge for ${JSON.stringify(command)}`).toBe("context");
    }
  });

  it("control: single-line allowlisted command still bounded (no regression)", () => {
    // Sanity: the newline guard must not regress the single-line case.
    expect(routePreToolUse("Bash", { command: "git status" }, "/test", "claude-code", SID)).toBeNull();
    resetGuidanceThrottle(SID);
    expect(routePreToolUse("Bash", { command: "pwd" }, "/test", "claude-code", SID)).toBeNull();
    resetGuidanceThrottle(SID);
    expect(routePreToolUse("Bash", { command: "echo ok" }, "/test", "claude-code", SID)).toBeNull();
  });

  it("isStructurallyBounded — newline-injected payloads are NOT bounded", () => {
    expect(isStructurallyBounded("git status\nfind /")).toBe(false);
    expect(isStructurallyBounded("git status\r\nfind /")).toBe(false);
    expect(isStructurallyBounded("echo ok\nrm -rf /")).toBe(false);
    expect(isStructurallyBounded("pwd\ncat huge.log")).toBe(false);
    // Sanity: bare CR alone (very rare but bash treats it as part of the line)
    // still must not bypass — a CR followed by a sink is a separator-like exploit.
    expect(isStructurallyBounded("git status\rfind /")).toBe(false);
  });
});
