/**
 * /ctx-upgrade must verify the better-sqlite3 binding is present (#514).
 *
 * The historical upgrade flow ran `npm install --production`, then
 * imported hooks/ensure-deps.mjs to repair the ABI, and declared success
 * if neither step threw. On Node 26 the install silently produced an
 * empty better-sqlite3 slot and ensure-deps no-op'd because the package
 * was already "satisfied" from the resolver's point of view. /ctx-upgrade
 * therefore reported "succeeded" even though the knowledge base could
 * not be opened.
 *
 * Fix: after the install + ensure-deps + heal pipeline runs, assert the
 * native binding exists. On absence, surface the failure loudly (stderr
 * + non-zero exit) so the user knows /ctx-upgrade did not recover them.
 *
 * @see https://github.com/mksglu/context-mode/issues/514
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CLI_SRC = readFileSync(
  resolve(import.meta.dirname, "../../src/cli.ts"),
  "utf-8",
);

// Extract just the upgrade() function body so assertions don't accidentally
// match unrelated occurrences elsewhere in the file.
function getUpgradeBody(): string {
  const start = CLI_SRC.indexOf("async function upgrade");
  if (start === -1) throw new Error("upgrade() function not found");
  // Walk forward until we find the next top-level function declaration.
  const after = CLI_SRC.indexOf("\nasync function ", start + 10);
  const altAfter = CLI_SRC.indexOf("\nfunction ", start + 10);
  const end = [after, altAfter].filter(i => i > -1).sort((a, b) => a - b)[0] ?? CLI_SRC.length;
  return CLI_SRC.slice(start, end);
}

describe("cli.ts upgrade() — better-sqlite3 binding verification (#514)", () => {
  it("upgrade() references the better-sqlite3 native binding path", () => {
    const body = getUpgradeBody();
    // The verifier must check the canonical binding location.
    expect(body).toMatch(/better-sqlite3.*better_sqlite3\.node|build.*Release.*better_sqlite3\.node/s);
  });

  it("upgrade() asserts binding existence with existsSync after deps install", () => {
    const body = getUpgradeBody();
    const depsIdx = body.indexOf('"install", "--production"');
    expect(depsIdx).toBeGreaterThan(-1);
    // After the production install, somewhere in the body there must be
    // an existsSync check against the binding path. Implementation may
    // store the path in a variable (e.g. bsqBindingPath); we match the
    // path-construction site OR the existsSync call against it.
    const afterDeps = body.slice(depsIdx);
    const hasBindingPathLiteral = /"better_sqlite3\.node"/.test(afterDeps);
    const hasExistsCheck = /existsSync\([^)]*[Bb]inding[Pp]ath[^)]*\)/.test(afterDeps) ||
      /existsSync\([^)]*better_sqlite3\.node[^)]*\)/.test(afterDeps);
    expect(hasBindingPathLiteral).toBe(true);
    expect(hasExistsCheck).toBe(true);
  });

  it("upgrade() exits non-zero (or sets a failure flag) when the binding is missing", () => {
    const body = getUpgradeBody();
    // Anchor on the path-construction site since the implementation
    // stores the binding path in a local variable rather than inlining
    // the literal inside the existsSync call.
    const anchor = body.indexOf('"better_sqlite3.node"');
    expect(anchor).toBeGreaterThan(-1);
    const block = body.slice(anchor, anchor + 1500);
    // Key contract: ctx-upgrade must NOT declare success silently when
    // the binding is absent. Accept any explicit failure signal.
    const failsLoud =
      /process\.exit\s*\(\s*[1-9]/.test(block) ||
      /process\.exitCode\s*=\s*[1-9]/.test(block) ||
      /throw\s+new\s+Error/.test(block) ||
      /p\.log\.error\b/.test(block);
    expect(failsLoud).toBe(true);
  });

  it("upgrade() error message names better-sqlite3 and points at a recovery step", () => {
    const body = getUpgradeBody();
    const anchor = body.indexOf('"better_sqlite3.node"');
    expect(anchor).toBeGreaterThan(-1);
    const block = body.slice(anchor, anchor + 1500);
    // The error message must give the user something actionable: name
    // the package and surface a remedy (ctx-doctor, npm install, or
    // similar command). We don't prescribe exact wording.
    expect(block).toMatch(/better-sqlite3/);
    expect(block).toMatch(/ctx-doctor|npm install better-sqlite3|npm rebuild/i);
  });
});
