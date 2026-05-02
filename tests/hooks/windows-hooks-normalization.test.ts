/**
 * windows-hooks-normalization — TDD tests for #378
 *
 * On Windows + Claude Code, the committed hooks/hooks.json and
 * .claude-plugin/plugin.json use `${CLAUDE_PLUGIN_ROOT}` placeholder + bare
 * `node` command. This causes runtime loader failures (cjs/loader:1479)
 * because:
 *   1. bare `node` may not resolve via PATH (Git Bash, see #369)
 *   2. `${CLAUDE_PLUGIN_ROOT}` resolution can hit MSYS path mangling (#372)
 *   3. backslash paths get corrupted in shell quoting
 *
 * Fix: start.mjs detects placeholder pattern on every MCP boot and rewrites
 * with absolute paths using `process.execPath` and forward slashes.
 */

import { describe, test, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  needsHookNormalization,
  normalizeHooksJson,
  normalizePluginJson,
  normalizeHooksOnStartup,
} from "../../hooks/normalize-hooks.mjs";

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
  const dir = mkdtempSync(join(tmpdir(), "ctx-378-"));
  cleanups.push(dir);
  return dir;
}

// ─────────────────────────────────────────────────────────
// Slice 1: detection
// ─────────────────────────────────────────────────────────

describe("needsHookNormalization", () => {
  test("returns true when content contains ${CLAUDE_PLUGIN_ROOT} placeholder", () => {
    const content = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs"',
              },
            ],
          },
        ],
      },
    });
    expect(needsHookNormalization(content)).toBe(true);
  });

  test("returns false when content already has absolute paths", () => {
    const content = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command:
                  '"C:/Program Files/nodejs/node.exe" "C:/Users/me/plugin/hooks/sessionstart.mjs"',
              },
            ],
          },
        ],
      },
    });
    expect(needsHookNormalization(content)).toBe(false);
  });

  test("returns false for empty/invalid content", () => {
    expect(needsHookNormalization("")).toBe(false);
    expect(needsHookNormalization("{}")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// Slice 2: rewrite hooks.json
// ─────────────────────────────────────────────────────────

describe("normalizeHooksJson", () => {
  test("replaces placeholder + bare node with execPath + forward-slash absolute paths", () => {
    const input = JSON.stringify(
      {
        hooks: {
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command:
                    'node "${CLAUDE_PLUGIN_ROOT}/hooks/posttooluse.mjs"',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    );

    const fakeNode = "C:\\Program Files\\nodejs\\node.exe";
    const fakeRoot = "D:\\plugins\\context-mode\\1.0.103";

    const out = normalizeHooksJson(input, fakeNode, fakeRoot);
    const parsed = JSON.parse(out);
    const cmd = parsed.hooks.PostToolUse[0].hooks[0].command;

    // forward slashes
    expect(cmd).not.toMatch(/\\/);
    // execPath used (quoted)
    expect(cmd).toContain('"C:/Program Files/nodejs/node.exe"');
    // root resolved (quoted)
    expect(cmd).toContain(
      '"D:/plugins/context-mode/1.0.103/hooks/posttooluse.mjs"',
    );
    // no leftover placeholder
    expect(cmd).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    // no bare 'node' at start
    expect(cmd).not.toMatch(/^node\s/);
  });

  test("is idempotent — already-normalized content unchanged", () => {
    const input = JSON.stringify(
      {
        hooks: {
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command:
                    '"C:/Program Files/nodejs/node.exe" "D:/plugins/x/hooks/posttooluse.mjs"',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    );

    const out = normalizeHooksJson(
      input,
      "C:\\Program Files\\nodejs\\node.exe",
      "D:\\plugins\\x",
    );
    expect(out).toBe(input);
  });
});

// ─────────────────────────────────────────────────────────
// Slice 4: rewrite plugin.json mcpServers args
// ─────────────────────────────────────────────────────────

describe("normalizePluginJson", () => {
  test("replaces ${CLAUDE_PLUGIN_ROOT} in mcpServers args + sets command to execPath", () => {
    const input = JSON.stringify(
      {
        name: "context-mode",
        mcpServers: {
          "context-mode": {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/start.mjs"],
          },
        },
      },
      null,
      2,
    );

    const fakeNode = "C:\\Program Files\\nodejs\\node.exe";
    const fakeRoot = "D:\\plugins\\context-mode\\1.0.103";

    const out = normalizePluginJson(input, fakeNode, fakeRoot);
    const parsed = JSON.parse(out);

    expect(parsed.mcpServers["context-mode"].command).toBe(
      "C:/Program Files/nodejs/node.exe",
    );
    expect(parsed.mcpServers["context-mode"].args).toEqual([
      "D:/plugins/context-mode/1.0.103/start.mjs",
    ]);
  });

  test("is idempotent for already-normalized plugin.json", () => {
    const input = JSON.stringify(
      {
        name: "context-mode",
        mcpServers: {
          "context-mode": {
            command: "C:/Program Files/nodejs/node.exe",
            args: ["D:/plugins/x/start.mjs"],
          },
        },
      },
      null,
      2,
    );

    const out = normalizePluginJson(
      input,
      "C:\\Program Files\\nodejs\\node.exe",
      "D:\\plugins\\x",
    );
    expect(out).toBe(input);
  });
});

// ─────────────────────────────────────────────────────────
// Slice 3: apply on startup
// ─────────────────────────────────────────────────────────

describe("normalizeHooksOnStartup", () => {
  test("no-op when platform is not win32", () => {
    const dir = makeTmp();
    const hooksPath = join(dir, "hooks", "hooks.json");
    mkdirSync(join(dir, "hooks"), { recursive: true });
    const original =
      '{"hooks":{"X":[{"hooks":[{"command":"node \\"${CLAUDE_PLUGIN_ROOT}/x.mjs\\""}]}]}}';
    writeFileSync(hooksPath, original);

    normalizeHooksOnStartup({
      pluginRoot: dir,
      nodePath: "/usr/bin/node",
      platform: "linux",
    });

    expect(readFileSync(hooksPath, "utf-8")).toBe(original);
  });

  test("rewrites hooks.json on Windows when placeholder present", () => {
    const dir = makeTmp();
    mkdirSync(join(dir, "hooks"), { recursive: true });
    const hooksPath = join(dir, "hooks", "hooks.json");
    const original = JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              matcher: "",
              hooks: [
                {
                  type: "command",
                  command:
                    'node "${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs"',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    );
    writeFileSync(hooksPath, original);

    normalizeHooksOnStartup({
      pluginRoot: dir,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    const after = readFileSync(hooksPath, "utf-8");
    expect(after).not.toBe(original);
    expect(after).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(after).toContain("C:/Program Files/nodejs/node.exe");
  });

  test("rewrites plugin.json on Windows when placeholder present", () => {
    const dir = makeTmp();
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    const pluginPath = join(dir, ".claude-plugin", "plugin.json");
    const original = JSON.stringify(
      {
        name: "context-mode",
        mcpServers: {
          "context-mode": {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/start.mjs"],
          },
        },
      },
      null,
      2,
    );
    writeFileSync(pluginPath, original);

    normalizeHooksOnStartup({
      pluginRoot: dir,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    const after = readFileSync(pluginPath, "utf-8");
    expect(after).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    const parsed = JSON.parse(after);
    expect(parsed.mcpServers["context-mode"].command).toBe(
      "C:/Program Files/nodejs/node.exe",
    );
  });

  test("idempotent — second call leaves file unchanged on Windows", () => {
    const dir = makeTmp();
    mkdirSync(join(dir, "hooks"), { recursive: true });
    const hooksPath = join(dir, "hooks", "hooks.json");
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "",
              hooks: [
                {
                  type: "command",
                  command:
                    'node "${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs"',
                },
              ],
            },
          ],
        },
      }),
    );

    normalizeHooksOnStartup({
      pluginRoot: dir,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });
    const firstPass = readFileSync(hooksPath, "utf-8");

    normalizeHooksOnStartup({
      pluginRoot: dir,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });
    const secondPass = readFileSync(hooksPath, "utf-8");

    expect(secondPass).toBe(firstPass);
  });

  test("does not throw when files are missing", () => {
    const dir = makeTmp();
    expect(() =>
      normalizeHooksOnStartup({
        pluginRoot: dir,
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        platform: "win32",
      }),
    ).not.toThrow();
  });
});
