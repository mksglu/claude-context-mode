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
  test("no-op when platform is not win32 or linux (e.g. darwin)", () => {
    const dir = makeTmp();
    const hooksPath = join(dir, "hooks", "hooks.json");
    mkdirSync(join(dir, "hooks"), { recursive: true });
    const original =
      '{"hooks":{"X":[{"hooks":[{"command":"node \\"${CLAUDE_PLUGIN_ROOT}/x.mjs\\""}]}]}}';
    writeFileSync(hooksPath, original);

    normalizeHooksOnStartup({
      pluginRoot: dir,
      nodePath: "/usr/bin/node",
      platform: "darwin",
    });

    expect(readFileSync(hooksPath, "utf-8")).toBe(original);
  });

  test("normalizes hooks.json on Linux (bare node not in PATH for /bin/sh)", () => {
    const dir = makeTmp();
    const hooksPath = join(dir, "hooks", "hooks.json");
    mkdirSync(join(dir, "hooks"), { recursive: true });
    const original =
      '{"hooks":{"X":[{"hooks":[{"command":"node \\"${CLAUDE_PLUGIN_ROOT}/x.mjs\\""}]}]}}';
    writeFileSync(hooksPath, original);

    normalizeHooksOnStartup({
      pluginRoot: dir,
      nodePath: "/home/user/.bun/bin/bun",
      platform: "linux",
    });

    const updated = readFileSync(hooksPath, "utf-8");
    expect(updated).not.toBe(original);
    expect(updated).toContain("/home/user/.bun/bin/bun");
    expect(updated).not.toContain("${CLAUDE_PLUGIN_ROOT}");
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

// ─────────────────────────────────────────────────────────
// Slice 5: version-bump regression (#604)
//
// Claude Code's native plugin manager auto-update carries the previous
// version's *already-normalized* hooks.json forward into the new version
// directory. The placeholder is gone, so normalize-hooks short-circuits
// and the stale `…/<old-version>/hooks/<file>.mjs` command paths persist.
// The old version dir has been cleaned up → every hook fires MODULE_NOT_FOUND.
// `ctx-doctor` stays green because it only checks the current dir exists
// and that hooks are *configured*, not that command paths point at it.
//
// Fix: detection + rewrite must also handle stale absolute paths whose
// `context-mode/context-mode/<version>` segment differs from the current
// pluginRoot. See `hooks/cache-heal-utils.mjs` `isStaleNodePath` for the
// precedent on stale-absolute-path repair.
// ─────────────────────────────────────────────────────────

describe("normalize-hooks survives a version bump (#604)", () => {
  const NODE = "/usr/bin/node";
  const ROOT_V135 = "/cache/context-mode/context-mode/1.0.135";
  const ROOT_V136 = "/cache/context-mode/context-mode/1.0.136";
  const PLACEHOLDER_SOURCE = JSON.stringify({
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

  test("re-points an already-normalized hooks.json to the new version (#604)", () => {
    // v135 boot: placeholder → absolute 1.0.135 path
    const v135 = normalizeHooksJson(PLACEHOLDER_SOURCE, NODE, ROOT_V135);
    expect(v135).toContain("/1.0.135/");

    // Auto-update carries v135's normalized hooks.json into the 1.0.136 dir;
    // the 1.0.136 MCP server boots and normalize runs again with the new root.
    const v136 = normalizeHooksJson(v135, NODE, ROOT_V136);

    // After the fix: stale `/1.0.135/` segment must be re-pointed to `/1.0.136/`.
    // Pre-fix this fails because needsHookNormalization(v135) === false
    // (placeholder gone) → normalizeHooksJson short-circuits → v136 === v135.
    expect(v136).toContain("/1.0.136/");
    expect(v136).not.toContain("/1.0.135/");
  });

  test("needsHookNormalization detects stale cache-root version segment", () => {
    // Already-normalized content with the OLD version segment must still be
    // flagged for normalization when the current pluginRoot has a NEW segment.
    const v135 = normalizeHooksJson(PLACEHOLDER_SOURCE, NODE, ROOT_V135);
    expect(needsHookNormalization(v135, ROOT_V136)).toBe(true);

    // Same content + same pluginRoot → no work needed.
    expect(needsHookNormalization(v135, ROOT_V135)).toBe(false);

    // Placeholder always wins.
    expect(needsHookNormalization(PLACEHOLDER_SOURCE, ROOT_V136)).toBe(true);
  });

  test("normalizeHooksOnStartup self-heals stale hooks.json on next boot (end-to-end)", () => {
    const cacheBase = makeTmp();
    const v135Dir = join(cacheBase, "context-mode", "context-mode", "1.0.135");
    const v136Dir = join(cacheBase, "context-mode", "context-mode", "1.0.136");
    mkdirSync(join(v135Dir, "hooks"), { recursive: true });
    mkdirSync(join(v136Dir, "hooks"), { recursive: true });

    // v135 boot: write fresh placeholder hooks.json + normalize.
    writeFileSync(join(v135Dir, "hooks", "hooks.json"), PLACEHOLDER_SOURCE);
    normalizeHooksOnStartup({
      pluginRoot: v135Dir,
      nodePath: NODE,
      platform: "linux",
    });
    const normalizedV135 = readFileSync(
      join(v135Dir, "hooks", "hooks.json"),
      "utf-8",
    );
    expect(normalizedV135).toContain("/1.0.135/");

    // Claude Code's native auto-update: copy v135's normalized hooks.json
    // forward into v136 dir, then clean up v135.
    writeFileSync(join(v136Dir, "hooks", "hooks.json"), normalizedV135);
    rmSync(v135Dir, { recursive: true, force: true });

    // v136 boot: normalize must re-point the stale absolute paths.
    normalizeHooksOnStartup({
      pluginRoot: v136Dir,
      nodePath: NODE,
      platform: "linux",
    });
    const healedV136 = readFileSync(
      join(v136Dir, "hooks", "hooks.json"),
      "utf-8",
    );
    expect(healedV136).toContain("/1.0.136/");
    expect(healedV136).not.toContain("/1.0.135/");
  });
});
