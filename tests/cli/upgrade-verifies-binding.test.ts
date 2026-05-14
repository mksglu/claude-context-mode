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

  // ─────────────────────────────────────────────────────────
  // Slices 3 + 4 (#559): /ctx-upgrade kills sibling MCP servers
  // before npm install so previous-version processes are not left
  // running in the background. Verified at the SOURCE level — we
  // assert the upgrade() body imports the helpers and calls them
  // with process.pid/ppid, before the "Installing dependencies &
  // building" spinner that introduces the install region.
  // ─────────────────────────────────────────────────────────
  it("upgrade() kills sibling MCP servers BEFORE npm install (#559)", () => {
    const body = getUpgradeBody();
    // Helper imports — must reference the new util by name so static
    // bundling picks it up.
    expect(body).toMatch(/discoverSiblingMcpPids/);
    expect(body).toMatch(/killSiblingMcpServers/);
    // Discover must pass own pid + ppid so we don't terminate ourselves
    // or our parent (Claude Code / the spawning shell).
    expect(body).toMatch(/discoverSiblingMcpPids\s*\(\s*\{[\s\S]*?ownPid\s*:\s*process\.pid[\s\S]*?ownPpid\s*:\s*process\.ppid/);
    // Kill must happen BEFORE the install spinner — assert by
    // character offset within the upgrade body.
    const killIdx = body.indexOf("killSiblingMcpServers");
    const installIdx = body.indexOf('s.start("Installing dependencies & building")');
    expect(killIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(killIdx).toBeLessThan(installIdx);
  });

  it("upgrade() suppresses the kill summary when no siblings were terminated (#559)", () => {
    const body = getUpgradeBody();
    // Anchor on the helper call.
    const callIdx = body.indexOf("killSiblingMcpServers");
    expect(callIdx).toBeGreaterThan(-1);
    const region = body.slice(callIdx, callIdx + 1200);
    // Summary literal must reference "sibling MCP server" so user
    // feedback is unambiguous and not generic "killed N processes".
    expect(region).toMatch(/sibling MCP server/);
    // Suppression: must guard the log on `> 0` (or equivalent) so a
    // zero-kill upgrade stays quiet — no log noise on the common path.
    expect(region).toMatch(/totalKilled\s*[>!]/);
  });

  it("upgrade() never lets sibling discovery block the install (#559)", () => {
    const body = getUpgradeBody();
    const callIdx = body.indexOf("discoverSiblingMcpPids");
    expect(callIdx).toBeGreaterThan(-1);
    // The discover/kill block must be wrapped in try/catch — pgrep
    // missing on a stripped Linux distro / PowerShell unavailable on a
    // weird Windows must NOT block /ctx-upgrade.
    const region = body.slice(Math.max(0, callIdx - 200), callIdx + 1500);
    expect(region).toMatch(/try\s*\{[\s\S]*?discoverSiblingMcpPids[\s\S]*?\}\s*catch/);
  });
});
