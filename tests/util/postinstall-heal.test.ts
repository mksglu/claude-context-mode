/**
 * scripts/postinstall.mjs — installed_plugins.json self-heal contract.
 *
 * v1.0.114 hotfix for users broken by v1.0.113's `/ctx-upgrade`. Their
 * Claude Code plugin loader rejects context-mode → MCP gone → they
 * can't run `/ctx-upgrade` to recover. The escape hatch is `npm install
 * -g context-mode@1.0.114` whose postinstall MUST repair their registry.
 *
 * These integration tests spawn `node scripts/postinstall.mjs` in a
 * subprocess with isolated HOME and assert end-to-end behavior:
 *   - Heals when run as a true `npm install -g` (npm_config_global=true).
 *   - Skips silently when run as a contributor's local `npm install`.
 *   - One-line stderr summary; no walls of text, no scary noise.
 *   - No-op when registry already healthy.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const REPO_POSTINSTALL = resolve(REPO_ROOT, "scripts", "postinstall.mjs");
const REPO_HEAL_IP = resolve(REPO_ROOT, "scripts", "heal-installed-plugins.mjs");
const REPO_HEAL_SQLITE3 = resolve(REPO_ROOT, "scripts", "heal-better-sqlite3.mjs");
const KEY = "context-mode@context-mode";

/**
 * Simulate an `npm install -g` package layout: copy postinstall + its
 * sibling helper modules into a tmpdir that has NO `.git` ancestor. The
 * `isGlobalInstall()` heuristic in postinstall.mjs walks up looking for
 * `.git` and skips heal if found — exactly what we want during contributor
 * `npm install` runs but exactly what we have to *bypass* in vitest, since
 * the test always lives inside a git checkout.
 */
function stagePostinstallPackage(): {
  scriptPath: string;
  packageDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ctx-postinstall-pkg-"));
  cleanups.push(root);
  const scriptsDir = join(root, "scripts");
  const hooksDir = join(root, "hooks");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  copyFileSync(REPO_POSTINSTALL, join(scriptsDir, "postinstall.mjs"));
  copyFileSync(REPO_HEAL_IP, join(scriptsDir, "heal-installed-plugins.mjs"));
  copyFileSync(REPO_HEAL_SQLITE3, join(scriptsDir, "heal-better-sqlite3.mjs"));
  // postinstall imports ../hooks/normalize-hooks.mjs — provide a no-op stub
  // so the import does not crash. Real postinstall wraps the import in
  // try/catch so even a missing file is fine, but copying a stub keeps the
  // test focused on the heal contract, not on Windows hook normalization.
  writeFileSync(
    join(hooksDir, "normalize-hooks.mjs"),
    "export function normalizeHooksOnStartup() {}\n",
  );
  return { scriptPath: join(scriptsDir, "postinstall.mjs"), packageDir: root };
}

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop();
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
});

function makeTmp(prefix = "ctx-postinstall-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

interface FakeHome {
  home: string;
  registryPath: string;
  cacheDir: string;
}

/**
 * Lay out a fake HOME with `~/.claude/plugins/installed_plugins.json`
 * + a context-mode cache dir whose plugin.json declares `cacheVersion`.
 */
function buildFakeHome(opts: {
  entryVersion: string;
  cacheVersion: string;
  enabledPlugins?: unknown;
}): FakeHome {
  const home = makeTmp("ctx-postinstall-home-");
  const pluginsRoot = resolve(home, ".claude", "plugins");
  const cacheDir = resolve(pluginsRoot, "cache", "context-mode", "context-mode", opts.cacheVersion);
  mkdirSync(resolve(cacheDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    resolve(cacheDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "context-mode", version: opts.cacheVersion }, null, 2),
  );
  const registry: Record<string, unknown> = {
    version: 2,
    plugins: {
      [KEY]: [
        {
          scope: "user",
          installPath: cacheDir,
          version: opts.entryVersion,
          installedAt: "2025-01-01T00:00:00.000Z",
          lastUpdated: "2025-01-01T00:00:00.000Z",
        },
      ],
    },
  };
  if (opts.enabledPlugins !== undefined) registry.enabledPlugins = opts.enabledPlugins;
  const registryPath = resolve(pluginsRoot, "installed_plugins.json");
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
  return { home, registryPath, cacheDir };
}

/**
 * Spawn a staged copy of postinstall (in a no-`.git` package layout) with
 * isolated HOME and chosen `npm_config_global` value. Returns
 * { stdout, stderr, status }.
 */
function runPostinstall(opts: {
  home: string;
  global: boolean;
}): { stdout: string; stderr: string; status: number | null } {
  const staged = stagePostinstallPackage();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: opts.home,
    USERPROFILE: opts.home,
  };
  if (opts.global) env.npm_config_global = "true";
  const r = spawnSync(process.execPath, [staged.scriptPath], {
    cwd: staged.packageDir,
    env,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

function readRegistry(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf-8"));
}

// ─────────────────────────────────────────────────────────────────────────
// Slice 5 — non-global install must NOT mutate registry
// ─────────────────────────────────────────────────────────────────────────

describe("postinstall — non-global install (contributor `npm install`)", () => {
  it("does NOT heal installed_plugins.json when npm_config_global is unset", { timeout: 90_000 }, () => {
    const fake = buildFakeHome({
      entryVersion: "1.0.99",      // poisoned
      cacheVersion: "1.0.113",     // would be healed if we ran
      enabledPlugins: {},
    });

    const before = readFileSync(fake.registryPath, "utf-8");
    const r = runPostinstall({ home: fake.home, global: false });
    // Best-effort posture — postinstall must never crash.
    expect(r.status === 0 || r.status === null).toBe(true);

    // Registry MUST be untouched.
    expect(readFileSync(fake.registryPath, "utf-8")).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 6 — global install with poisoned registry: heal happens
// ─────────────────────────────────────────────────────────────────────────

describe("postinstall — global install with poisoned registry", () => {
  // 90s budget — see L163/L246/L465 for the same precedent. Section 3 of
  // postinstall.mjs (heal-better-sqlite3) routinely takes 20-30s on cold
  // macOS GHA runners, blowing past vitest's default 30s. CI run
  // 25804274156 caught this gap.
  it("repairs entry.version + enabledPlugins and emits one stderr line", { timeout: 90_000 }, () => {
    const fake = buildFakeHome({
      entryVersion: "1.0.99",         // poisoned
      cacheVersion: "1.0.113",        // truth
      enabledPlugins: {},             // /ctx-upgrade emptied this
    });

    const r = runPostinstall({ home: fake.home, global: true });
    expect(r.status === 0 || r.status === null).toBe(true);

    const after = readRegistry(fake.registryPath) as {
      plugins: Record<string, Array<{ version: string }>>;
      enabledPlugins: Record<string, unknown>;
    };
    expect(after.plugins[KEY][0].version).toBe("1.0.113");
    expect(after.enabledPlugins[KEY]).toBeDefined();

    // Concise stderr summary: a single human-readable line mentioning
    // context-mode + heal verb. NOT a wall of text.
    const healLines = r.stderr
      .split(/\r?\n/)
      .filter((l) => /context-mode/i.test(l) && /heal|sync|repair/i.test(l));
    expect(healLines.length).toBe(1);
    // No emoji / ANSI noise — line should be plain ASCII summary.
    expect(healLines[0]).toMatch(/^context-mode:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 7 — global install but no Claude Code registry: silent OK
// ─────────────────────────────────────────────────────────────────────────

describe("postinstall — global install, user not on Claude Code", () => {
  // 90s budget for the same reason as siblings (L163/L185/L246/L465) —
  // heal-better-sqlite3 in section 3 of postinstall.mjs is the slow path
  // and shares this whole-process budget on every spawn.
  it("emits a single benign one-liner and never crashes", { timeout: 90_000 }, () => {
    const home = makeTmp("ctx-postinstall-home-bare-");
    const r = runPostinstall({ home, global: true });
    expect(r.status === 0 || r.status === null).toBe(true);

    // No "scary" stderr noise — no stack traces, no ENOENT, no JSON parse.
    expect(r.stderr).not.toMatch(/stack/i);
    expect(r.stderr).not.toMatch(/throw/i);
    expect(r.stderr).not.toMatch(/ENOENT/);
    expect(r.stderr).not.toMatch(/SyntaxError/);

    // Exactly one summary line that mentions context-mode.
    const ctxLines = r.stderr.split(/\r?\n/).filter((l) => /context-mode:/.test(l));
    expect(ctxLines.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 7b — running from an /ctx-upgrade tmpdir staging path MUST NOT
// normalize hooks.json. /ctx-upgrade clones the repo to
// `<tmpdir>/context-mode-upgrade-<epoch>/` and runs `npm install` there
// before `cpSync`-ing into the real pluginRoot. If postinstall normalized
// hooks.json here, the absolute tmpdir paths would get baked in and then
// copied to the real plugin dir — every subsequent hook fire would fail
// with MODULE_NOT_FOUND once the tmpdir is cleaned up.
// ─────────────────────────────────────────────────────────────────────────

describe("postinstall — /ctx-upgrade tmpdir staging guard", () => {
  it("does NOT mutate hooks.json when pkgRoot matches context-mode-upgrade-<digits>", { timeout: 90_000 }, () => {
    // Lay out a package dir with the exact name shape /ctx-upgrade uses.
    const parent = makeTmp("ctx-postinstall-tmproot-");
    const packageDir = join(parent, `context-mode-upgrade-${Date.now()}`);
    const scriptsDir = join(packageDir, "scripts");
    const hooksDir = join(packageDir, "hooks");
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });
    copyFileSync(REPO_POSTINSTALL, join(scriptsDir, "postinstall.mjs"));
    copyFileSync(REPO_HEAL_IP, join(scriptsDir, "heal-installed-plugins.mjs"));
    copyFileSync(REPO_HEAL_SQLITE3, join(scriptsDir, "heal-better-sqlite3.mjs"));
    // Use the REAL normalize-hooks.mjs so we can detect a (buggy) mutation.
    copyFileSync(
      resolve(REPO_ROOT, "hooks", "normalize-hooks.mjs"),
      join(hooksDir, "normalize-hooks.mjs"),
    );

    // Plant a hooks.json with the placeholder + bare `node`. If postinstall
    // failed to guard, the literal `${CLAUDE_PLUGIN_ROOT}` would be replaced
    // by the tmpdir packageDir path.
    const hooksJsonPath = join(hooksDir, "hooks.json");
    const placeholderHooks =
      `{\n  "hooks": {\n    "SessionStart": [{\n      "matcher": "",\n      "hooks": [{\n        "type": "command",\n        "command": "node \\"\${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs\\""\n      }]\n    }]\n  }\n}\n`;
    writeFileSync(hooksJsonPath, placeholderHooks, "utf-8");

    const home = makeTmp("ctx-postinstall-home-tmproot-");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
    };
    const r = spawnSync(process.execPath, [join(scriptsDir, "postinstall.mjs")], {
      cwd: packageDir,
      env,
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(r.status === 0 || r.status === null).toBe(true);

    // Placeholder MUST survive — the guard prevented mutation. Equivalently:
    // tmpdir absolute paths MUST NOT appear in the file.
    const after = readFileSync(hooksJsonPath, "utf-8");
    expect(after).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(after).not.toContain(packageDir.replace(/\\/g, "/"));
    expect(after).not.toContain(packageDir);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 7c — /ctx-upgrade post-cpSync re-normalize against the REAL plugin
// dir (issue #528 gap-fill).
//
// The postinstall guard above prevents tmpdir paths from being baked DURING
// `npm install` inside the tmpdir. But for the upgrade flow to actually work
// on Windows we ALSO need cli.ts to call normalizeHooksOnStartup AGAINST THE
// REAL plugin dir after the in-place cpSync. Without this:
//   - postinstall correctly skips → hooks.json keeps placeholders → ok
//   - cpSync from tmpdir copies the (now unhealed) placeholder file to real
//     plugin dir → ok
//   - But for Windows users on the FIRST hook fire after upgrade,
//     normalize-hooks.mjs's MCP-boot-time pass hasn't run yet, so the
//     placeholder is still literal `${CLAUDE_PLUGIN_ROOT}` — Claude Code's
//     hook runner cannot resolve it and the hook crashes.
// The cli.ts post-cpSync call closes this window so the FIRST hook fire
// after `/ctx-upgrade` works without waiting for the next MCP boot.
// ─────────────────────────────────────────────────────────────────────────

describe("normalize-hooks — /ctx-upgrade post-cpSync sequence (issue #528)", () => {
  it("rewrites placeholders to the REAL pluginRoot, not the tmpdir", async () => {
    const realPluginRoot = makeTmp("ctx-real-plugin-root-");
    const realHooksDir = join(realPluginRoot, "hooks");
    mkdirSync(realHooksDir, { recursive: true });
    copyFileSync(
      resolve(REPO_ROOT, "hooks", "normalize-hooks.mjs"),
      join(realHooksDir, "normalize-hooks.mjs"),
    );
    // Plant a clean placeholder hooks.json — this is what cpSync from the
    // tmpdir (with the postinstall guard active) deposits into the real
    // plugin dir.
    const hooksJsonPath = join(realHooksDir, "hooks.json");
    writeFileSync(
      hooksJsonPath,
      `{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node \\"\${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs\\""
      }]
    }]
  }
}
`,
      "utf-8",
    );

    // Drive normalizeHooksOnStartup as cli.ts does — but force platform:"win32"
    // so the Windows-only rewrite path fires on the macOS/Linux CI runner.
    const realNormalize = resolve(REPO_ROOT, "hooks", "normalize-hooks.mjs");
    const { normalizeHooksOnStartup } = await import(realNormalize);
    normalizeHooksOnStartup({
      pluginRoot: realPluginRoot,
      nodePath: "/usr/local/bin/node",
      platform: "win32",
    });

    const after = readFileSync(hooksJsonPath, "utf-8");
    // The REAL plugin dir path MUST be baked in.
    const realFwd = realPluginRoot.replace(/\\/g, "/");
    expect(after).toContain(realFwd);
    // Placeholder must be gone — the rewrite happened.
    expect(after).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    // No tmpdir-shaped poison sneaked in via the wrong pluginRoot.
    expect(after).not.toMatch(/[/\\]context-mode-upgrade-\d+[/\\]/);
  });

  it("self-heals a legacy-poisoned hooks.json by cpSync-overwrite then renormalize", async () => {
    // Two roots: simulate the cli.ts upgrade scenario where the tmpdir
    // staging area has a CLEAN placeholder hooks.json (postinstall guard
    // worked) and the real plugin dir has a POISONED hooks.json from an
    // older buggy upgrade.
    const tmpStageRoot = makeTmp("ctx-tmpdir-stage-");
    const tmpHooksDir = join(tmpStageRoot, "hooks");
    mkdirSync(tmpHooksDir, { recursive: true });
    const tmpHooksJson = join(tmpHooksDir, "hooks.json");
    writeFileSync(
      tmpHooksJson,
      `{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node \\"\${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs\\""
      }]
    }]
  }
}
`,
      "utf-8",
    );

    const realPluginRoot = makeTmp("ctx-real-plugin-root-poisoned-");
    const realHooksDir = join(realPluginRoot, "hooks");
    mkdirSync(realHooksDir, { recursive: true });
    copyFileSync(
      resolve(REPO_ROOT, "hooks", "normalize-hooks.mjs"),
      join(realHooksDir, "normalize-hooks.mjs"),
    );
    // Plant a LEGACY-POISONED hooks.json — left over from a v1.0.112-1.0.120
    // upgrade where postinstall's tmpdir normalize baked an old epoch path.
    const poisonedTmp = join(
      tmpdir(),
      "context-mode-upgrade-1700000000000",
    );
    const poisonedFwd = poisonedTmp.replace(/\\/g, "/");
    const hooksJsonPath = join(realHooksDir, "hooks.json");
    writeFileSync(
      hooksJsonPath,
      `{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "\\"/usr/local/bin/node\\" \\"${poisonedFwd}/hooks/sessionstart.mjs\\""
      }]
    }]
  }
}
`,
      "utf-8",
    );

    // Step 1: cpSync the clean placeholder file from tmpdir → real plugin
    // dir (this is exactly what cli.ts upgrade() does after npm install).
    copyFileSync(tmpHooksJson, hooksJsonPath);

    // After cpSync, the poisoned content is gone — replaced by the
    // placeholder version. Verify the intermediate state.
    const afterCp = readFileSync(hooksJsonPath, "utf-8");
    expect(afterCp).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(afterCp).not.toContain(poisonedFwd);

    // Step 2: normalize against the REAL pluginRoot — this is the cli.ts
    // post-cpSync call that PR #528 adds.
    const realNormalize = resolve(REPO_ROOT, "hooks", "normalize-hooks.mjs");
    const { normalizeHooksOnStartup } = await import(realNormalize);
    normalizeHooksOnStartup({
      pluginRoot: realPluginRoot,
      nodePath: "/usr/local/bin/node",
      platform: "win32",
    });

    const after = readFileSync(hooksJsonPath, "utf-8");
    // Real plugin dir path MUST be baked in.
    const realFwd = realPluginRoot.replace(/\\/g, "/");
    expect(after).toContain(realFwd);
    // Legacy poison MUST NOT survive — both the literal epoch path and
    // the generic tmpdir-upgrade shape.
    expect(after).not.toContain(poisonedFwd);
    expect(after).not.toMatch(/[/\\]context-mode-upgrade-1700000000000[/\\]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 8 — registry already healthy: "no heal needed" line
// ─────────────────────────────────────────────────────────────────────────

describe("postinstall — global install, registry already healthy", () => {
  // The vitest default test timeout is 30s; this test path runs the real
  // `heal-better-sqlite3.mjs` (section 3 of postinstall.mjs) which alone
  // can take 20-30s on cold CI runners. Sibling tests in this file
  // (L163, L246) already use 90_000 for the same reason. CI run
  // 25803559016 caught this gap — Ubuntu ran the whole file in 126s but
  // macOS hit the default 30s budget for this `it()` and killed the test
  // before spawn could return. 90s matches the precedent the rest of the
  // file established; widening just this `it()` is the minimum diff.
  it("emits 'no heal needed' and leaves registry bytes unchanged", { timeout: 90_000 }, () => {
    const fake = buildFakeHome({
      entryVersion: "1.0.114",
      cacheVersion: "1.0.114",
      enabledPlugins: { [KEY]: true },
    });
    const before = readFileSync(fake.registryPath, "utf-8");

    const r = runPostinstall({ home: fake.home, global: true });
    expect(r.status === 0 || r.status === null).toBe(true);
    expect(readFileSync(fake.registryPath, "utf-8")).toBe(before);

    const ctxLines = r.stderr.split(/\r?\n/).filter((l) => /context-mode:/.test(l));
    expect(ctxLines.length).toBe(1);
    expect(ctxLines[0]).toMatch(/no heal needed/i);
  });
});
