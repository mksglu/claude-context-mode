/**
 * cache-heal-self-heal — Slice 3 of Brew node upgrade fix.
 *
 * selfHealCacheHealHook({ settingsPath, scriptPath, platform, nodePath }):
 *   - no-op when no cache-heal hook is registered
 *   - no-op when the hook command is valid (node path exists or shebang form)
 *   - rewrites the command using buildHookCommand() when node path is stale
 *   - preserves other hooks unchanged
 *   - on Unix, ensures the script has shebang + chmod +x after a heal
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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selfHealCacheHealHook } from "../../hooks/cache-heal-utils.mjs";

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

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctx-cache-heal-self-"));
  cleanups.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

describe("selfHealCacheHealHook", () => {
  test("returns 'missing-settings' when settings.json doesn't exist", () => {
    const dir = makeTmp();
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
    const dir = makeTmp();
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
    const dir = makeTmp();
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
    const dir = makeTmp();
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
    const dir = makeTmp();
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
    const mode = statSync(scriptPath).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  test("Windows: rewrites stale command using execPath form", () => {
    const dir = makeTmp();
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
    const dir = makeTmp();
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
    expect(after.hooks.SessionStart[1].hooks[0].command).toBe(
      `"${scriptPath}"`,
    );
    expect(after.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      '"/usr/local/bin/other-tool"',
    );
  });

  test("does not touch settings.json when nothing needs healing", () => {
    const dir = makeTmp();
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
    const dir = makeTmp();
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
