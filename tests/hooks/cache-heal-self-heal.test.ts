/**
 * cache-heal — consolidated test suite for the Brew node upgrade fix.
 *
 * Combines three previously-separate slices of the cache-heal hook system:
 *
 *   Slice 1 — extractNodePath / isStaleNodePath: detection primitives that
 *     find a node path inside a hook command and check if it still exists.
 *
 *   Slice 2 — buildHookCommand: emits the appropriate hook command shape:
 *       Unix    → bare script path (relies on shebang + chmod +x)
 *       Windows → '"<nodePath>" "<scriptPath>"' (no shebang support)
 *     Plus an integration check that a Unix shebang script + chmod +x is
 *     actually spawnable using just its bare path.
 *
 *   Slice 3 — selfHealCacheHealHook: end-to-end reconciliation that reads
 *     settings.json, detects stale node paths, rewrites them via
 *     buildHookCommand(), and ensures the script is shebang+exec-bit ready.
 *
 * Bug being fixed: After Brew upgrades Node, ~/.claude/settings.json contains
 * a hook command pointing at a versioned Cellar path that no longer exists:
 *
 *   "/opt/homebrew/Cellar/node/25.9.0_2/bin/node" "/Users/x/.claude/hooks/context-mode-cache-heal.mjs"
 *
 * Fix layer A (new installs, Unix): write hook script with shebang +
 *   chmod +x, register hook command as bare script path. `env` resolves
 *   node from PATH at runtime — survives any Node upgrade.
 * Fix layer B (self-heal): on every MCP boot, check if existing hook
 *   command references a node path that no longer exists. If stale,
 *   rewrite using the layer-A pattern.
 */

import { describe, test, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  statSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractNodePath,
  isStaleNodePath,
  buildHookCommand,
  selfHealCacheHealHook,
} from "../../hooks/cache-heal-utils.mjs";

// ─────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
});

/** Create a tracked temp directory; auto-cleaned in afterEach. */
function makeTmp(prefix = "ctx-cache-heal-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

/** Pretty-write JSON with trailing newline (matches settings.json convention). */
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

// ─────────────────────────────────────────────────────────
// Slice 1 — extractNodePath: pull leading executable path out of a hook command string
// ─────────────────────────────────────────────────────────

describe("extractNodePath", () => {
  test("extracts a quoted node path from the start of the command", () => {
    const cmd =
      '"/opt/homebrew/Cellar/node/25.9.0_2/bin/node" "/Users/vigo/.claude/hooks/context-mode-cache-heal.mjs"';
    expect(extractNodePath(cmd)).toBe(
      "/opt/homebrew/Cellar/node/25.9.0_2/bin/node",
    );
  });

  test("extracts a Windows-style quoted node path", () => {
    const cmd =
      '"C:/Program Files/nodejs/node.exe" "C:/Users/me/hook.mjs"';
    expect(extractNodePath(cmd)).toBe("C:/Program Files/nodejs/node.exe");
  });

  test("returns null when command is shebang-style (no node prefix)", () => {
    // Layer A registration: bare script path, shebang inside script handles node.
    const cmd = '"/Users/vigo/.claude/hooks/context-mode-cache-heal.mjs"';
    expect(extractNodePath(cmd)).toBeNull();
  });

  test("returns null for empty / non-string input", () => {
    expect(extractNodePath("")).toBeNull();
    // @ts-expect-error — runtime guard
    expect(extractNodePath(undefined)).toBeNull();
    // @ts-expect-error — runtime guard
    expect(extractNodePath(null)).toBeNull();
  });

  test("returns null when leading path doesn't look like a node executable", () => {
    const cmd = '"/usr/bin/python3" "/Users/x/script.py"';
    expect(extractNodePath(cmd)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// Slice 1 — isStaleNodePath: does the hook command reference a missing node binary?
// ─────────────────────────────────────────────────────────

describe("isStaleNodePath", () => {
  test("returns true when extracted node path doesn't exist on disk", () => {
    const cmd =
      '"/opt/homebrew/Cellar/node/99.0.0_999/bin/node" "/tmp/whatever.mjs"';
    expect(isStaleNodePath(cmd)).toBe(true);
  });

  test("returns false when extracted node path exists on disk", () => {
    const dir = makeTmp();
    const fakeNode = join(dir, "node");
    writeFileSync(fakeNode, "#!/bin/sh\necho fake\n");
    chmodSync(fakeNode, 0o755);
    const cmd = `"${fakeNode}" "/tmp/whatever.mjs"`;
    expect(isStaleNodePath(cmd)).toBe(false);
  });

  test("returns false when command has no node path (shebang style)", () => {
    // Bare script path — `env` resolves node, nothing to validate here.
    const cmd = '"/Users/vigo/.claude/hooks/context-mode-cache-heal.mjs"';
    expect(isStaleNodePath(cmd)).toBe(false);
  });

  test("returns false for empty input", () => {
    expect(isStaleNodePath("")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// Slice 2 — buildHookCommand: emit the right hook command shape per platform
// ─────────────────────────────────────────────────────────

describe("buildHookCommand", () => {
  test("Unix: produces just the script path (shebang-based)", () => {
    const out = buildHookCommand({
      scriptPath: "/Users/x/.claude/hooks/context-mode-cache-heal.mjs",
      platform: "darwin",
      nodePath: "/opt/homebrew/Cellar/node/25.9.0_2/bin/node",
    });
    expect(out).toBe(
      '"/Users/x/.claude/hooks/context-mode-cache-heal.mjs"',
    );
    expect(out).not.toContain("node");
  });

  test("Linux: same as darwin (any non-win32 platform)", () => {
    const out = buildHookCommand({
      scriptPath: "/home/x/.claude/hooks/context-mode-cache-heal.mjs",
      platform: "linux",
      nodePath: "/usr/bin/node",
    });
    expect(out).toBe(
      '"/home/x/.claude/hooks/context-mode-cache-heal.mjs"',
    );
  });

  test("Windows: produces nodePath + scriptPath, both quoted, forward slashes", () => {
    const out = buildHookCommand({
      scriptPath: "C:\\Users\\me\\.claude\\hooks\\context-mode-cache-heal.mjs",
      platform: "win32",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
    });
    expect(out).toBe(
      '"C:/Program Files/nodejs/node.exe" "C:/Users/me/.claude/hooks/context-mode-cache-heal.mjs"',
    );
  });

  test("Windows: throws when nodePath is missing", () => {
    expect(() =>
      buildHookCommand({
        scriptPath: "C:/x.mjs",
        platform: "win32",
      }),
    ).toThrow();
  });

  test("missing scriptPath throws", () => {
    expect(() =>
      buildHookCommand({ platform: "linux", nodePath: "/usr/bin/node" }),
    ).toThrow();
  });

  test.skipIf(process.platform === "win32")(
    "Unix: returned bare-script command can actually execute (shebang + chmod +x)",
    () => {
      const dir = makeTmp("ctx-cache-heal-build-");
      const scriptPath = join(dir, "context-mode-cache-heal.mjs");
      writeFileSync(
        scriptPath,
        '#!/usr/bin/env node\nprocess.stdout.write("OK");\n',
      );
      chmodSync(scriptPath, 0o755);

      const cmd = buildHookCommand({
        scriptPath,
        platform: process.platform,
        nodePath: process.execPath,
      });

      // The shell would just run this command directly — simulate that.
      // cmd is e.g. '"/tmp/xxx/context-mode-cache-heal.mjs"'.
      const unquoted = cmd.replace(/^"|"$/g, "");
      const r = spawnSync(unquoted, [], { encoding: "utf-8" });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("OK");
    },
  );
});

// ─────────────────────────────────────────────────────────
// Slice 3 — selfHealCacheHealHook: end-to-end reconciliation against settings.json
// ─────────────────────────────────────────────────────────

describe("selfHealCacheHealHook", () => {
  test("returns 'missing-settings' when settings.json doesn't exist", () => {
    const dir = makeTmp("ctx-cache-heal-self-");
    const settingsPath = join(dir, "settings.json");
    const result = selfHealCacheHealHook({
      settingsPath,
      scriptPath: "/whatever/script.mjs",
      platform: "linux",
      nodePath: "/usr/bin/node",
    });
    expect(result).toBe("missing-settings");
  });

  test("no-op when no cache-heal hook is registered", () => {
    const dir = makeTmp("ctx-cache-heal-self-");
    const settingsPath = join(dir, "settings.json");
    const original = {
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: "command", command: "/usr/bin/echo hello" }],
          },
        ],
      },
    };
    writeJson(settingsPath, original);
    const before = readFileSync(settingsPath, "utf-8");

    const result = selfHealCacheHealHook({
      settingsPath,
      scriptPath: "/whatever/script.mjs",
      platform: "linux",
      nodePath: "/usr/bin/node",
    });

    expect(result).toBe("noop");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  test("no-op when the cache-heal hook command is shebang-form (no node path)", () => {
    const dir = makeTmp("ctx-cache-heal-self-");
    const settingsPath = join(dir, "settings.json");
    const scriptPath = join(dir, "context-mode-cache-heal.mjs");
    // Doesn't matter that the script doesn't exist — the command alone is
    // shebang form which means there's no node path to validate.
    writeJson(settingsPath, {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: `"${scriptPath}"` },
            ],
          },
        ],
      },
    });
    const before = readFileSync(settingsPath, "utf-8");

    const result = selfHealCacheHealHook({
      settingsPath,
      scriptPath,
      platform: "linux",
      nodePath: "/usr/bin/node",
    });

    expect(result).toBe("noop");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  test("no-op when the cache-heal hook command's node path exists", () => {
    const dir = makeTmp("ctx-cache-heal-self-");
    const settingsPath = join(dir, "settings.json");
    const scriptPath = join(dir, "context-mode-cache-heal.mjs");
    const fakeNode = join(dir, "node");
    writeFileSync(fakeNode, "#!/bin/sh\n");
    chmodSync(fakeNode, 0o755);

    writeJson(settingsPath, {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `"${fakeNode}" "${scriptPath}"`,
              },
            ],
          },
        ],
      },
    });
    const before = readFileSync(settingsPath, "utf-8");

    const result = selfHealCacheHealHook({
      settingsPath,
      scriptPath,
      platform: "linux",
      nodePath: fakeNode,
    });

    expect(result).toBe("noop");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  test("Unix: rewrites command when node path is stale", () => {
    const dir = makeTmp("ctx-cache-heal-self-");
    const settingsPath = join(dir, "settings.json");
    const scriptPath = join(dir, "context-mode-cache-heal.mjs");
    // Pretend an old script exists (we simulate the upgrade case where the
    // script was already on disk before Brew nuked the node binary).
    writeFileSync(scriptPath, "console.log('heal')\n");

    const stalePath = join(dir, "totally-gone", "bin", "node");
    writeJson(settingsPath, {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `"${stalePath}" "${scriptPath}"`,
              },
            ],
          },
        ],
      },
    });

    const result = selfHealCacheHealHook({
      settingsPath,
      scriptPath,
      platform: "linux",
      nodePath: "/usr/bin/node",
    });

    expect(result).toBe("healed");
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const cmd = after.hooks.SessionStart[0].hooks[0].command;
    // Unix-form: just the script path, quoted, no node prefix.
    // buildHookCommand normalizes backslashes → forward slashes for cross-platform safety.
    expect(cmd).toBe(`"${scriptPath.replace(/\\/g, "/")}"`);
    expect(cmd).not.toContain("/totally-gone/");

    // Script should now have shebang + exec bit.
    const content = readFileSync(scriptPath, "utf-8");
    expect(content.startsWith("#!/usr/bin/env node\n")).toBe(true);
    // Exec bit only meaningful on POSIX hosts — NTFS ignores chmod 0o755.
    if (process.platform !== "win32") {
      const mode = statSync(scriptPath).mode & 0o777;
      expect(mode).toBe(0o755);
    }
  });

  test("Windows: rewrites stale command using execPath form", () => {
    const dir = makeTmp("ctx-cache-heal-self-");
    const settingsPath = join(dir, "settings.json");
    const scriptPath = join(dir, "context-mode-cache-heal.mjs");
    writeFileSync(scriptPath, "console.log('heal')\n");

    const stalePath = join(dir, "old-cellar", "node");
    writeJson(settingsPath, {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `"${stalePath}" "${scriptPath}"`,
              },
            ],
          },
        ],
      },
    });

    const winNode = "C:\\Program Files\\nodejs\\node.exe";
    const result = selfHealCacheHealHook({
      settingsPath,
      scriptPath,
      platform: "win32",
      nodePath: winNode,
    });

    expect(result).toBe("healed");
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const cmd = after.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain('"C:/Program Files/nodejs/node.exe"');
    expect(cmd).toContain(scriptPath.replace(/\\/g, "/"));
    expect(cmd).not.toContain("/old-cellar/");
  });

  test("preserves other hooks unchanged", () => {
    const dir = makeTmp("ctx-cache-heal-self-");
    const settingsPath = join(dir, "settings.json");
    const scriptPath = join(dir, "context-mode-cache-heal.mjs");
    writeFileSync(scriptPath, "console.log('heal')\n");
    const stalePath = join(dir, "totally-gone", "bin", "node");

    writeJson(settingsPath, {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: '"/usr/bin/echo" "unrelated hook"',
              },
            ],
          },
          {
            hooks: [
              {
                type: "command",
                command: `"${stalePath}" "${scriptPath}"`,
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              { type: "command", command: '"/usr/local/bin/other-tool"' },
            ],
          },
        ],
      },
    });

    const result = selfHealCacheHealHook({
      settingsPath,
      scriptPath,
      platform: "linux",
      nodePath: "/usr/bin/node",
    });

    expect(result).toBe("healed");
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.hooks.SessionStart[0].hooks[0].command).toBe(
      '"/usr/bin/echo" "unrelated hook"',
    );
    // buildHookCommand normalizes backslashes → forward slashes for cross-platform safety.
    expect(after.hooks.SessionStart[1].hooks[0].command).toBe(
      `"${scriptPath.replace(/\\/g, "/")}"`,
    );
    expect(after.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      '"/usr/local/bin/other-tool"',
    );
  });

  test("does not touch settings.json when nothing needs healing", () => {
    const dir = makeTmp("ctx-cache-heal-self-");
    const settingsPath = join(dir, "settings.json");
    writeJson(settingsPath, { hooks: {} });
    const beforeMtime = statSync(settingsPath).mtimeMs;

    selfHealCacheHealHook({
      settingsPath,
      scriptPath: "/whatever",
      platform: "linux",
      nodePath: "/usr/bin/node",
    });

    // mtime should be unchanged — we never wrote.
    expect(statSync(settingsPath).mtimeMs).toBe(beforeMtime);
  });

  test("survives malformed settings.json without throwing", () => {
    const dir = makeTmp("ctx-cache-heal-self-");
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, "{not json", "utf-8");
    expect(() =>
      selfHealCacheHealHook({
        settingsPath,
        scriptPath: "/whatever",
        platform: "linux",
        nodePath: "/usr/bin/node",
      }),
    ).not.toThrow();
    // file untouched
    expect(readFileSync(settingsPath, "utf-8")).toBe("{not json");
    // existsSync sanity — still there
    expect(existsSync(settingsPath)).toBe(true);
  });
});
