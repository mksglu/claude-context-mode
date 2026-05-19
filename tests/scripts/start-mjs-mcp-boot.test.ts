/**
 * start.mjs MCP-boot non-blocking contract — closes #634.
 *
 * Before #634, `start.mjs` invoked `execSync("npm install …")` synchronously
 * for the three pure-JS runtime deps consumed only by `ctx_fetch_and_index`
 * (`turndown`, `turndown-plugin-gfm`, `@mixmark-io/domino`). Plugin
 * distributions that bypass `npm install` — most notably codex's marketplace,
 * which git-clones into `~/.codex/plugins/cache/<pkg>/` with no
 * `node_modules/` — paid the full cold-install cost on every MCP boot
 * (~15–25s end-to-end). Codex enforces a 30s `startup_timeout_sec` per MCP
 * server (codex-rs/config/src/mcp_types.rs RawMcpServerConfig), so any host
 * where prewarm + DNS already eats a few seconds tipped over and the MCP
 * child was dropped with:
 *
 *   MCP client for `context-mode` timed out after 30 seconds.
 *
 * The fix detaches those installs so they run in the background while the
 * MCP `initialize` handshake proceeds. This test pins both halves of the
 * contract so a future revert can't silently re-introduce the timeout.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const START_MJS = readFileSync(resolve(REPO_ROOT, "start.mjs"), "utf8");

describe("start.mjs MCP boot path", () => {
  it("does NOT synchronously `execSync(\"npm install …\")` the fetch-and-index deps on the MCP boot path", () => {
    // The three packages are referenced by `ctx_fetch_and_index`'s
    // sandboxed subprocess via `require.resolve()` and are NOT needed for
    // the MCP `initialize` handshake. Pin the boot path: the slice of
    // start.mjs from `./hooks/ensure-deps.mjs` (last sync step the boot
    // is allowed to block on) through the `server.bundle.mjs` import (point
    // where MCP can answer `initialize`) must not contain any synchronous
    // `execSync(... npm install ...)`. The dev-mode fallback block lower
    // in the file (only reachable when `server.bundle.mjs` is missing — a
    // condition that never holds for shipped/marketplace plugin installs)
    // is excluded from this scope.
    const bootStart = START_MJS.indexOf('./hooks/ensure-deps.mjs');
    const bootEnd = START_MJS.indexOf('"./server.bundle.mjs"');
    expect(bootStart, "boot anchor (`./hooks/ensure-deps.mjs`) missing").toBeGreaterThan(0);
    expect(bootEnd, "boot anchor (`./server.bundle.mjs`) missing").toBeGreaterThan(bootStart);
    // Strip line + block comments so this assertion can't be tripped by
    // documentation that legitimately mentions the old `execSync("npm
    // install …")` pattern in a comment explaining the fix.
    const stripped = START_MJS
      .slice(bootStart, bootEnd)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    expect(
      stripped,
      "start.mjs must not call `execSync(\"npm install\")` between ensure-deps and server.bundle import — see #634",
    ).not.toMatch(/execSync\([^)]{0,200}npm\s+install/);
  });

  it("installs the fetch-and-index deps in the background via `spawn(..., { detached, unref })`", () => {
    // Positive assertion — the detached spawn path is what keeps boot
    // fast for codex marketplace installs (no `node_modules/`).
    expect(START_MJS).toMatch(/spawn\(\s*NPM_BIN/);
    expect(START_MJS).toMatch(/detached:\s*true/);
    expect(START_MJS).toMatch(/\.unref\(\)/);

    // The three packages must still be enumerated — dropping one would
    // mean `ctx_fetch_and_index` silently breaks on codex/marketplace
    // installs with no recovery path.
    for (const pkg of ["turndown", "turndown-plugin-gfm", "@mixmark-io/domino"]) {
      expect(
        START_MJS,
        `start.mjs must still kick off a background \`npm install ${pkg}\``,
      ).toContain(`"${pkg}"`);
    }
  });
});
