import "../setup-home";
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * G3 — Post-build bundle invariant guardrail.
 *
 * Issue #511 class: esbuild rewrites bare `require("node:...")` calls into a
 * `__require` shim that throws `Dynamic require of "..." is not supported`
 * under Node ESM / Bun. The string `Dynamic require of` is the invariant
 * signature of the throwing shim and survives minification verbatim.
 *
 * `scripts/assert-bundle.mjs` is the post-build invariant check that fails
 * the build if any compiled bundle contains the throwing shim or pre-shim
 * source patterns that should never have reached the bundle.
 */

const SCRIPT = resolve(__dirname, "../../scripts/assert-bundle.mjs");

function runAssert(...files: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("node", [SCRIPT, ...files], { encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("assert-bundle script", () => {
  it("exits 1 when given a fixture bundle containing the 'Dynamic require of' shim", () => {
    const dir = mkdtempSync(join(tmpdir(), "assert-bundle-red-"));
    const polluted = join(dir, "polluted.bundle.mjs");
    writeFileSync(
      polluted,
      `// fixture\nvar X=(t=>typeof require<"u"?require:e)(function(t){throw Error('Dynamic require of "'+t+'" is not supported')});\nexport {};\n`,
      "utf-8",
    );
    try {
      const r = runAssert(polluted);
      expect(r.status).toBe(1);
      expect(`${r.stdout}\n${r.stderr}`).toMatch(/Dynamic require of/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is wired into package.json so the build chain runs it after bundle", () => {
    const pkgPath = resolve(__dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    // Must expose a dedicated `assert-bundle` script that targets every
    // produced bundle.
    expect(scripts["assert-bundle"]).toBeDefined();
    expect(scripts["assert-bundle"]).toMatch(/scripts\/assert-bundle\.mjs/);
    expect(scripts["assert-bundle"]).toMatch(/server\.bundle\.mjs/);
    expect(scripts["assert-bundle"]).toMatch(/cli\.bundle\.mjs/);
    expect(scripts["assert-bundle"]).toMatch(/hooks\/.*\.bundle\.mjs/);

    // The build chain must invoke it. Either `build` calls `assert-bundle`
    // directly, or a `postbundle` / `postbuild` script does so. Any of those
    // is acceptable — what matters is that `npm run build` ends with the
    // assertion.
    const wired =
      /assert-bundle/.test(scripts.build ?? "") ||
      /assert-bundle/.test(scripts.postbuild ?? "") ||
      /assert-bundle/.test(scripts.postbundle ?? "");
    expect(wired).toBe(true);
  });

  it("exits 0 on a clean fixture bundle that uses createRequire", () => {
    const dir = mkdtempSync(join(tmpdir(), "assert-bundle-green-"));
    const clean = join(dir, "clean.bundle.mjs");
    // Realistic clean ESM bundle: createRequire at module top, no shim,
    // no bare `require("node:...")` anywhere.
    writeFileSync(
      clean,
      `import { createRequire } from "node:module";\nconst require2 = createRequire(import.meta.url);\nconst sqlite = require2("better-sqlite3");\nexport { sqlite };\n`,
      "utf-8",
    );
    try {
      const r = runAssert(clean);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Slice 4 — regression guard against the current production bundles.
  //
  // EXPECTED RED until the Issue #511 ESM sweep agent merges its branch
  // with createRequire fixes for src/server.ts and src/cli.ts. Once both
  // bundles are rebuilt without the shim, this test goes green and
  // permanently locks the invariant.
  //
  // Do NOT skip this test — its red state is the *forcing function* that
  // makes the sweep agent's work load-bearing. Skipping it removes the
  // safety net that proves G3 is wired correctly to real bundles.
  it("current production bundles pass the assert-bundle clean check", () => {
    const repoRoot = resolve(__dirname, "../..");
    const bundles = [
      "server.bundle.mjs",
      "cli.bundle.mjs",
      "hooks/session-extract.bundle.mjs",
      "hooks/session-snapshot.bundle.mjs",
      "hooks/session-db.bundle.mjs",
    ].map((p) => join(repoRoot, p));

    const r = runAssert(...bundles);
    if (r.status !== 0) {
      // Surface the exact violations so the failing CI line is actionable.
      console.error(r.stdout);
      console.error(r.stderr);
    }
    expect(r.status).toBe(0);
  });
});
