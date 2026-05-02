/**
 * cache-heal-build-command — Slice 2 of Brew node upgrade fix.
 *
 * buildHookCommand({ scriptPath, platform, nodePath }):
 *   - Unix: emit just the script path (relies on shebang + chmod +x).
 *   - Windows: emit '"<nodePath>" "<scriptPath>"' (no shebang support).
 *
 * Plus an integration check: a Unix shebang script + chmod +x is actually
 * spawnable using just its bare path.
 */

import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildHookCommand } from "../../hooks/cache-heal-utils.mjs";

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
  const dir = mkdtempSync(join(tmpdir(), "ctx-cache-heal-build-"));
  cleanups.push(dir);
  return dir;
}

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
      const dir = makeTmp();
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
