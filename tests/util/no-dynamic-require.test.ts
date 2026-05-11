/**
 * Anti-regression guard for issue #511: "Dynamic require of \"node:fs\" is not supported".
 *
 * Background: package.json declares "type": "module", and esbuild bundles
 * src/cli.ts and src/server.ts as ESM. Any inline `require("node:...")` in
 * the call graph is rewritten by esbuild to a `__require` shim that throws
 * `Dynamic require of "node:..." is not supported` at runtime under both
 * Node ESM and Bun.
 *
 * The fix pattern is `createRequire(import.meta.url)` (see src/server.ts:4,
 * src/db-base.ts:11, src/util/claude-config.ts:26 for the established
 * pattern). PR #513 already fixed src/util/project-dir.ts; this suite covers
 * the remaining sites.
 *
 * Tests assert the SOURCE pattern (cheap, deterministic, runs without
 * rebuilding bundles). Bundle integrity itself is enforced by the build
 * pipeline (`npm run build` regenerates bundles before `npm test` runs via
 * the `pretest` script).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");

function readSrc(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf-8");
}

/**
 * Match top-level (non-string-literal) inline `require("node:...")` calls.
 *
 * The lookbehind `(?<![`'])` excludes occurrences inside template strings
 * or quoted strings (e.g. subprocess CJS code returned by
 * src/server.ts::buildFetchCode), which are spawned as separate Node CJS
 * processes and never bundled.
 */
const INLINE_NODE_REQUIRE = /(?<!\/\/[^\n]*)require\(["']node:[^"']+["']\)/g;

function findInlineNodeRequires(src: string): string[] {
  const hits: string[] = [];
  // Strip backtick template literals so embedded `require('node:dns')` in
  // child-process source strings (server.ts buildFetchCode) is ignored.
  const stripped = src.replace(/`[\s\S]*?`/g, "``");
  for (const m of stripped.matchAll(INLINE_NODE_REQUIRE)) {
    hits.push(m[0]);
  }
  return hits;
}

describe("issue #511 — no inline require('node:...') in ESM-bundled sources", () => {
  it("src/cli.ts contains no inline require('node:...')", () => {
    const src = readSrc("src/cli.ts");
    expect(findInlineNodeRequires(src)).toEqual([]);
  });

  it("src/cli.ts uses createRequire(import.meta.url) when require is needed", () => {
    const src = readSrc("src/cli.ts");
    // Either no `require(` calls at all, or every one is preceded by a
    // createRequire binding. We assert the import is present whenever the
    // file mentions `require(` in non-template context.
    const stripped = src.replace(/`[\s\S]*?`/g, "``");
    if (/\brequire\(/.test(stripped)) {
      expect(src).toMatch(/createRequire\s*\(\s*import\.meta\.url\s*\)/);
    }
  });

  it("src/adapters/qwen-code/index.ts contains no inline require('node:...')", () => {
    const src = readSrc("src/adapters/qwen-code/index.ts");
    expect(findInlineNodeRequires(src)).toEqual([]);
  });
});
