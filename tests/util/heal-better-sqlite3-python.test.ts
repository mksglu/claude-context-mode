/**
 * heal-better-sqlite3.mjs — conda PYTHON override tests (#533).
 *
 * When a user has Anaconda / Miniconda's `python3` first on PATH (a
 * common macOS / Linux data-science setup), node-gyp picks it up via
 * its `python3` PATH fallback. Conda's Python ships an environment
 * marker that breaks better-sqlite3's node-gyp build on Node 26
 * (arm64). The heal script must defend against this by:
 *
 *   1. Detecting a "safe" Python (system `/usr/bin/python3` on darwin,
 *      anything not under conda prefixes on linux).
 *   2. Passing that Python via the documented node-gyp override env
 *      vars (PYTHON + npm_config_python) when shelling out to npm.
 *   3. Stripping CONDA_* keys from the child env so subprocesses do
 *      not inherit the conda activation that re-shims python3.
 *   4. Naming the chosen interpreter in a stderr breadcrumb so users
 *      know what happened.
 *
 * Node-gyp resolution order (verified against
 *   https://github.com/nodejs/node-gyp/blob/main/lib/find-python.js
 * — see `const checks = [...]`):
 *   1. --python CLI flag
 *   2. env.PYTHON          ← we set this
 *   3. `python3` on PATH   ← conda hijacks this slot
 *   4. `python`  on PATH
 *
 * @see https://github.com/mksglu/context-mode/issues/533
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HEAL_SRC = readFileSync(
  resolve(import.meta.dirname, "../../scripts/heal-better-sqlite3.mjs"),
  "utf-8",
);

describe("heal-better-sqlite3.mjs — conda PYTHON override (#533)", () => {
  // ── Slice 1: resolveSafePython() helper ────────────────────────────
  it("declares resolveSafePython() that probes /usr/bin/python3 on darwin", async () => {
    // The helper must exist as a named export (testable in isolation)
    // and on darwin must prefer `/usr/bin/python3` — the Apple-shipped
    // system Python that node-gyp can drive without conda noise.
    const mod = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    expect(typeof mod.resolveSafePython).toBe("function");
  });

  it("returns /usr/bin/python3 on darwin when only conda python is on PATH", async () => {
    const { resolveSafePython } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    // Simulate: PATH only has a conda shim, but /usr/bin/python3 exists
    // on disk (true on every macOS install since 10.15).
    const result = resolveSafePython({
      platform: "darwin",
      env: {
        PATH: "/opt/anaconda3/bin:/usr/local/bin",
        CONDA_PREFIX: "/opt/anaconda3",
        CONDA_DEFAULT_ENV: "base",
      },
      existsSync: (p) => p === "/usr/bin/python3",
    });
    expect(result).toBe("/usr/bin/python3");
  });

  it("filters conda paths (/opt/anaconda*, /opt/miniconda*, */conda/*)", async () => {
    const { resolveSafePython } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    // None of these should ever be picked as a "safe" python.
    const condaCandidates = [
      "/opt/anaconda3/bin/python3",
      "/opt/miniconda3/bin/python3",
      "/Users/x/miniforge3/bin/python3",
      "/Users/x/.conda/envs/myenv/bin/python3",
    ];
    for (const candidate of condaCandidates) {
      const result = resolveSafePython({
        platform: "darwin",
        env: { PATH: `${candidate.replace(/\/python3$/, "")}` },
        // Pretend /usr/bin/python3 is gone — only the conda candidate
        // exists. The helper must still refuse it and return null.
        existsSync: (p) => p === candidate,
      });
      expect(result).toBe(null);
    }
  });

  it("returns null on darwin when /usr/bin/python3 is absent and PATH only has conda", async () => {
    const { resolveSafePython } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    const result = resolveSafePython({
      platform: "darwin",
      env: { PATH: "/opt/anaconda3/bin", CONDA_PREFIX: "/opt/anaconda3" },
      existsSync: () => false,
    });
    expect(result).toBe(null);
  });

  // ── Slice 2: package-missing branch env override ───────────────────
  it("package-missing branch sets PYTHON and npm_config_python in child env", () => {
    // The execFileSync call (npm install better-sqlite3 …) must pass
    // an `env` object that pins PYTHON. Without this the npm child
    // picks up process.env.PATH-ordered python3 (conda) and dies on
    // Node 26 arm64. We assert two things:
    //   1. The module defines PYTHON + npm_config_python overrides
    //      somewhere (the safe-env builder).
    //   2. The execFileSync call passes `env:` — not the default
    //      (inherit) — meaning it threads the safe env through.
    expect(HEAL_SRC).toMatch(/PYTHON\b/);
    expect(HEAL_SRC).toMatch(/npm_config_python/);
    // Locate the execFileSync(npmBin, [...]) call site (skip the
    // import statement) and verify its options object includes an
    // `env:` key.
    const execIdx = HEAL_SRC.indexOf("execFileSync(\n");
    expect(execIdx).toBeGreaterThan(-1);
    const execRegion = HEAL_SRC.slice(execIdx, execIdx + 800);
    expect(execRegion).toMatch(/env:\s*\w/);
    // And the env passed MUST NOT be a bare process.env spread — that
    // was the #533 bug.
    expect(execRegion).not.toMatch(/env:\s*\{\s*\.\.\.process\.env\s*\}/);
  });

  it("package-missing branch strips CONDA_* keys from child env", () => {
    // CONDA_PREFIX in the child env re-activates conda even after we
    // set PYTHON, because npm scripts source activation hooks. Wipe
    // every CONDA_* key so the subprocess starts clean.
    expect(HEAL_SRC).toMatch(/CONDA_PREFIX/);
    expect(HEAL_SRC).toMatch(/CONDA_DEFAULT_ENV/);
    expect(HEAL_SRC).toMatch(/CONDA_EXE/);
    expect(HEAL_SRC).toMatch(/CONDA_SHLVL/);
  });

  it("package-missing branch prepends /usr/bin to PATH on darwin", () => {
    // Belt-and-suspenders: even with PYTHON pinned, node-gyp may shell
    // out to `python3` from a sub-script. Putting /usr/bin first
    // ensures the system Python wins any PATH-based lookup.
    expect(HEAL_SRC).toMatch(/\/usr\/bin/);
    // The prepend must be conditional on darwin (don't disturb linux
    // distros that put python in /usr/bin already, and don't touch
    // windows where /usr/bin is meaningless).
    expect(HEAL_SRC).toMatch(/darwin/);
  });

  // ── Slice 3: Layer A spawnSync also gets the safe-python override ─
  it("Layer A spawnSync env clone includes PYTHON when safe python resolved", () => {
    // Layer A is the prebuild-install fast path (lines ~118-122). It
    // currently does `env: { ...process.env }` with no PYTHON pin —
    // same conda bug surface as the package-missing branch. The fix
    // must thread the same safe-python env through Layer A too.
    const layerAIdx = HEAL_SRC.indexOf("prebuildBin");
    expect(layerAIdx).toBeGreaterThan(-1);
    // Find the spawnSync call after prebuildBin.
    const spawnIdx = HEAL_SRC.indexOf("spawnSync", layerAIdx);
    expect(spawnIdx).toBeGreaterThan(-1);
    const region = HEAL_SRC.slice(spawnIdx, spawnIdx + 600);
    // The env object passed to spawnSync must reference the safe
    // python helper output (either inline PYTHON: or a captured var
    // like `safePython`/`pythonEnv`/`childEnv`). Critically, it must
    // NOT be a bare `{ ...process.env }` spread — that was the bug.
    expect(region).toMatch(/PYTHON|safePython|pythonEnv|childEnv/);
    expect(region).not.toMatch(/env:\s*\{\s*\.\.\.process\.env\s*\}/);
  });

  // ── Slice 4: stderr breadcrumb ─────────────────────────────────────
  it("writes a stderr breadcrumb naming the chosen PYTHON when conda detected", () => {
    // When the heal had to override conda's python3, the user should
    // see WHY in stderr. This is the single most useful diagnostic
    // signal — it tells the user "we noticed conda, we used
    // /usr/bin/python3 instead" without requiring DEBUG=1.
    expect(HEAL_SRC).toMatch(/conda/i);
    // The breadcrumb must mention either "using" or "override" and the
    // python path so support requests are self-diagnosing.
    expect(HEAL_SRC).toMatch(/process\.stderr\.write[\s\S]{0,400}python/i);
  });

  // ── Slice 5: python-conda-blocked reason code ──────────────────────
  it("returns reason 'python-conda-blocked' when conda detected and no safe python available", () => {
    // If the user's PATH has conda first AND /usr/bin/python3 is also
    // missing (rare but possible: stripped-down Docker images, custom
    // Linux distros), the heal cannot succeed. Surface a distinct
    // reason code so /ctx-upgrade can render targeted next-steps.
    expect(HEAL_SRC).toMatch(/python-conda-blocked/);
  });
});
