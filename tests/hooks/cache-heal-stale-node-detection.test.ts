/**
 * cache-heal-stale-node-detection — TDD tests for Brew node upgrade bug
 *
 * Bug: After Brew upgrades Node, ~/.claude/settings.json contains a hook
 * command pointing at a versioned Cellar path that no longer exists:
 *
 *   "/opt/homebrew/Cellar/node/25.9.0_2/bin/node" "/Users/x/.claude/hooks/context-mode-cache-heal.mjs"
 *
 * Fix layer A (new installs, Unix): write hook script with shebang +
 *   chmod +x, register hook command as bare script path. `env` resolves
 *   node from PATH at runtime — survives any Node upgrade.
 * Fix layer B (self-heal): on every MCP boot, check if existing hook
 *   command references a node path that no longer exists. If stale,
 *   rewrite using the layer-A pattern.
 *
 * Slice 1: detection primitives — extractNodePath + isStaleNodePath.
 */

import { describe, test, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractNodePath,
  isStaleNodePath,
} from "../../hooks/cache-heal-utils.mjs";

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
  const dir = mkdtempSync(join(tmpdir(), "ctx-cache-heal-"));
  cleanups.push(dir);
  return dir;
}

// ─────────────────────────────────────────────────────────
// extractNodePath: pull leading executable path out of a hook command string
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
// isStaleNodePath: does the hook command reference a missing node binary?
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
