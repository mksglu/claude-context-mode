/**
 * heal-installed-plugins — shared HEAL 3 + HEAL 4 logic.
 *
 * v1.0.113's /ctx-upgrade poisoned ~/.claude/plugins/installed_plugins.json by
 * (a) writing a stale per-entry `version` and (b) emptying `enabledPlugins`.
 * Claude Code's plugin loader then refuses to load context-mode and the user
 * loses MCP entirely — including the /ctx-upgrade escape hatch. This module
 * is the single source of truth used by BOTH `start.mjs` (runtime) and
 * `scripts/postinstall.mjs` (npm install) to repair the registry.
 *
 *   HEAL 3: per-plugin entry.version <- cache dir's plugin.json version
 *   HEAL 4: top-level enabledPlugins[pluginKey] <- the synced version
 *
 * MUST stay in sync between start.mjs and scripts/postinstall.mjs callers.
 * Both import from this module.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  healInstalledPlugins,
  // @ts-expect-error — JS module, no TS declarations
  healSettingsEnabledPlugins,
  // @ts-expect-error — JS module, no TS declarations
  healPluginJsonMcpServers,
} from "../../scripts/heal-installed-plugins.mjs";

// ─────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────

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

function makeTmp(prefix = "ctx-heal-ip-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

interface FakeRegistry {
  registryPath: string;
  cacheRoot: string;
  cacheDir: string;
}

/**
 * Build a fake `~/.claude/plugins/` layout under `root`:
 *   <root>/installed_plugins.json
 *   <root>/cache/<owner>/<plugin>/<version>/.claude-plugin/plugin.json
 *
 * Returns paths the heal module needs.
 */
function buildFakeRegistry(opts: {
  registryVersionField?: number;
  entryVersion: string;        // what installed_plugins.json says
  cacheVersion: string;        // actual cache dir name + plugin.json version
  enabledPlugins?: unknown;    // top-level enabledPlugins to seed
  ownerSlug?: string;
  pluginSlug?: string;
}): FakeRegistry {
  const root = makeTmp();
  const owner = opts.ownerSlug ?? "context-mode";
  const plugin = opts.pluginSlug ?? "context-mode";
  const cacheRoot = resolve(root, "cache");
  const cacheDir = resolve(cacheRoot, owner, plugin, opts.cacheVersion);
  const claudePluginDir = resolve(cacheDir, ".claude-plugin");
  mkdirSync(claudePluginDir, { recursive: true });
  writeFileSync(
    resolve(claudePluginDir, "plugin.json"),
    JSON.stringify({ name: "context-mode", version: opts.cacheVersion }, null, 2),
  );
  const registry: Record<string, unknown> = {
    version: opts.registryVersionField ?? 2,
    plugins: {
      [`${plugin}@${owner}`]: [
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
  if (opts.enabledPlugins !== undefined) {
    registry.enabledPlugins = opts.enabledPlugins;
  }
  const registryPath = resolve(root, "installed_plugins.json");
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
  return { registryPath, cacheRoot, cacheDir };
}

function readRegistry(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf-8"));
}

const KEY = "context-mode@context-mode";

// ─────────────────────────────────────────────────────────────────────────
// Slice 1 — HEAL 3: per-plugin entry.version syncs from cache plugin.json
// ─────────────────────────────────────────────────────────────────────────

describe("healInstalledPlugins — HEAL 3 (entry.version sync)", () => {
  it("rewrites entry.version when it disagrees with cache plugin.json", () => {
    const fake = buildFakeRegistry({
      entryVersion: "1.0.99",   // poisoned/stale
      cacheVersion: "1.0.113",  // actual
    });

    const result = healInstalledPlugins({
      registryPath: fake.registryPath,
      pluginCacheRoot: fake.cacheRoot,
      pluginKey: KEY,
    });

    expect(result.skipped).toBeUndefined();
    expect(result.healed).toContain("entry-version");

    const after = readRegistry(fake.registryPath) as {
      plugins: Record<string, Array<{ version: string }>>;
    };
    expect(after.plugins[KEY][0].version).toBe("1.0.113");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 2 — HEAL 4: top-level enabledPlugins[key] is set to synced version
// ─────────────────────────────────────────────────────────────────────────

describe("healInstalledPlugins — HEAL 4 (enabledPlugins)", () => {
  it("creates enabledPlugins[key] when missing entirely", () => {
    const fake = buildFakeRegistry({
      entryVersion: "1.0.113",
      cacheVersion: "1.0.113",
      // enabledPlugins omitted entirely (the user's actual broken state)
    });

    const result = healInstalledPlugins({
      registryPath: fake.registryPath,
      pluginCacheRoot: fake.cacheRoot,
      pluginKey: KEY,
    });

    expect(result.healed).toContain("enabled-plugins");
    const after = readRegistry(fake.registryPath) as {
      enabledPlugins?: Record<string, unknown>;
    };
    expect(after.enabledPlugins).toBeDefined();
    expect(after.enabledPlugins?.[KEY]).toBeDefined();
  });

  it("rewrites enabledPlugins[key] when present but emptied", () => {
    const fake = buildFakeRegistry({
      entryVersion: "1.0.113",
      cacheVersion: "1.0.113",
      enabledPlugins: {}, // /ctx-upgrade poisoned shape
    });

    const result = healInstalledPlugins({
      registryPath: fake.registryPath,
      pluginCacheRoot: fake.cacheRoot,
      pluginKey: KEY,
    });

    expect(result.healed).toContain("enabled-plugins");
    const after = readRegistry(fake.registryPath) as {
      enabledPlugins?: Record<string, unknown>;
    };
    expect(after.enabledPlugins?.[KEY]).toBeDefined();
  });

  it("leaves enabledPlugins untouched when already set", () => {
    const fake = buildFakeRegistry({
      entryVersion: "1.0.113",
      cacheVersion: "1.0.113",
      enabledPlugins: { [KEY]: true, "other@vendor": true },
    });

    const result = healInstalledPlugins({
      registryPath: fake.registryPath,
      pluginCacheRoot: fake.cacheRoot,
      pluginKey: KEY,
    });

    expect(result.healed).not.toContain("enabled-plugins");
    const after = readRegistry(fake.registryPath) as {
      enabledPlugins: Record<string, unknown>;
    };
    expect(after.enabledPlugins["other@vendor"]).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 3 — defensive: no-registry, no-entry, idempotent healthy
// ─────────────────────────────────────────────────────────────────────────

describe("healInstalledPlugins — defensive paths", () => {
  it("returns skipped:'no-registry' when registry file is missing", () => {
    const root = makeTmp();
    const result = healInstalledPlugins({
      registryPath: resolve(root, "does-not-exist.json"),
      pluginCacheRoot: resolve(root, "cache"),
      pluginKey: KEY,
    });
    expect(result.healed).toEqual([]);
    expect(result.skipped).toBe("no-registry");
    expect(result.error).toBeUndefined();
  });

  it("returns healed:[] (no-op) when registry already healthy", () => {
    const fake = buildFakeRegistry({
      entryVersion: "1.0.113",
      cacheVersion: "1.0.113",
      enabledPlugins: { [KEY]: true },
    });

    const before = readFileSync(fake.registryPath, "utf-8");
    const result = healInstalledPlugins({
      registryPath: fake.registryPath,
      pluginCacheRoot: fake.cacheRoot,
      pluginKey: KEY,
    });

    expect(result.healed).toEqual([]);
    // Idempotent: bytes on disk are unchanged.
    expect(readFileSync(fake.registryPath, "utf-8")).toBe(before);
  });

  it("ignores entries whose installPath escapes pluginCacheRoot", () => {
    const fake = buildFakeRegistry({
      entryVersion: "1.0.99",
      cacheVersion: "1.0.113",
    });
    // Tamper: point registry at /tmp/<rand> outside the declared cacheRoot.
    const ip = readRegistry(fake.registryPath) as {
      plugins: Record<string, Array<{ installPath: string }>>;
    };
    ip.plugins[KEY][0].installPath = makeTmp("ctx-escape-");
    writeFileSync(fake.registryPath, JSON.stringify(ip, null, 2) + "\n");

    const result = healInstalledPlugins({
      registryPath: fake.registryPath,
      pluginCacheRoot: fake.cacheRoot,
      pluginKey: KEY,
    });
    // The install path was outside the cache root → skipped silently;
    // entry version stays "1.0.99" because we never trusted the foreign dir.
    expect(result.healed).not.toContain("entry-version");
  });

  it("uses native path separators (no hardcoded '/' or '\\\\')", async () => {
    // Static guard: the module must rely on `node:path` for separators so
    // Windows installs work. Read its source and assert it doesn't bake in
    // a single hardcoded separator for path traversal.
    const src = readFileSync(
      resolve(__dirname, "../../scripts/heal-installed-plugins.mjs"),
      "utf-8",
    );
    expect(src).toMatch(/from "node:path"/);
    expect(src).toMatch(/\bsep\b/);
  });

  it("is shipped in package.json `files` (so npm postinstall can find it)", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "../../package.json"), "utf-8"),
    ) as { files: string[] };
    expect(pkg.files).toContain("scripts/heal-installed-plugins.mjs");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// healSettingsEnabledPlugins — v1.0.116 hotfix
// Claude Code's plugin loader reads ~/.claude/settings.json.enabledPlugins
// (NOT installed_plugins.json). v1.0.114's heal targeted the wrong file —
// users still saw "Plugin enabled: WARN — No enabledPlugins section found"
// after every /ctx-upgrade. This adds the parallel heal for settings.json.
// ─────────────────────────────────────────────────────────────────────────

describe("healSettingsEnabledPlugins (v1.0.116)", () => {
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "ctx-settings-heal-"));
    cleanups.push(d);
    return d;
  }

  it("creates enabledPlugins section + adds key when settings.json is missing the section", () => {
    const dir = tmp();
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }, null, 2));

    const result = healSettingsEnabledPlugins({
      settingsPath,
      pluginKey: "context-mode@context-mode",
    });

    expect(result.healed).toContain("enabled-plugins");
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.theme).toBe("dark"); // unrelated state preserved
    expect(after.enabledPlugins).toEqual({ "context-mode@context-mode": true });
  });

  it("adds the key when section exists but ours is missing", () => {
    const dir = tmp();
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { "other@other": true } }, null, 2));

    const result = healSettingsEnabledPlugins({
      settingsPath,
      pluginKey: "context-mode@context-mode",
    });

    expect(result.healed).toContain("enabled-plugins");
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.enabledPlugins).toEqual({
      "other@other": true,
      "context-mode@context-mode": true,
    });
  });

  it("idempotent — does not rewrite or report healed when key already true", () => {
    const dir = tmp();
    const settingsPath = join(dir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ enabledPlugins: { "context-mode@context-mode": true } }, null, 2),
    );
    const before = readFileSync(settingsPath, "utf-8");

    const result = healSettingsEnabledPlugins({
      settingsPath,
      pluginKey: "context-mode@context-mode",
    });

    expect(result.healed).toEqual([]);
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("respects explicit user opt-out — does NOT flip false to true", () => {
    const dir = tmp();
    const settingsPath = join(dir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ enabledPlugins: { "context-mode@context-mode": false } }, null, 2),
    );

    const result = healSettingsEnabledPlugins({
      settingsPath,
      pluginKey: "context-mode@context-mode",
    });

    expect(result.healed).toEqual([]);
    expect(result.skipped).toBe("explicit-opt-out");
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.enabledPlugins["context-mode@context-mode"]).toBe(false);
  });

  it("returns silent skip when settings.json does not exist (user not on Claude Code)", () => {
    const result = healSettingsEnabledPlugins({
      settingsPath: "/nonexistent/path/settings.json",
      pluginKey: "context-mode@context-mode",
    });
    expect(result.healed).toEqual([]);
    expect(result.skipped).toBe("no-settings");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// healPluginJsonMcpServers — Issue #523 (v1.0.119)
// /ctx-upgrade in v1.0.118 left ~/.claude/plugins/cache/.../.claude-plugin/
// plugin.json with mcpServers["context-mode"].args[0] pointing at the
// upgrade tmpdir (e.g. /var/folders/.../T/context-mode-upgrade-1747000000000/
// start.mjs). After the temp dir is reaped, MCP fails to spawn with ENOENT
// and the user has no /ctx-upgrade escape hatch. Sibling of #411 (which
// fixed .mcp.json only).
//
// Layer 5 heal: detect the tmpdir-prefixed args[0] and rewrite it back to
// the literal `${CLAUDE_PLUGIN_ROOT}/start.mjs` placeholder that survives
// across upgrades.
// ─────────────────────────────────────────────────────────────────────────

describe("healPluginJsonMcpServers (Issue #523)", () => {
  function buildPoisonedPluginJson(opts: {
    pluginRoot: string;
    args0: string;
    extraServers?: Record<string, unknown>;
  }): string {
    mkdirSync(resolve(opts.pluginRoot, ".claude-plugin"), { recursive: true });
    const path = resolve(opts.pluginRoot, ".claude-plugin", "plugin.json");
    const content = {
      name: "context-mode",
      version: "1.0.118",
      mcpServers: {
        "context-mode": {
          command: "node",
          args: [opts.args0],
        },
        ...(opts.extraServers ?? {}),
      },
      skills: "./skills/",
    };
    writeFileSync(path, JSON.stringify(content, null, 2) + "\n");
    return path;
  }

  // Slice 1
  it("rewrites tmpdir-prefixed args[0] to ${CLAUDE_PLUGIN_ROOT}/start.mjs", () => {
    const cacheRoot = makeTmp("ctx-issue523-cache-");
    const pluginRoot = resolve(
      cacheRoot,
      "context-mode",
      "context-mode",
      "1.0.118",
    );
    mkdirSync(pluginRoot, { recursive: true });
    const poisonedTmp =
      "/var/folders/xx/yyy/T/context-mode-upgrade-1747000000000";
    const pluginJsonPath = buildPoisonedPluginJson({
      pluginRoot,
      args0: `${poisonedTmp}/start.mjs`,
    });

    const result = healPluginJsonMcpServers({
      pluginRoot,
      pluginCacheRoot: cacheRoot,
      pluginKey: "context-mode@context-mode",
    });

    expect(result.healed).toContain("plugin-json-args");
    const after = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
    expect(after.mcpServers["context-mode"].args).toEqual([
      "${CLAUDE_PLUGIN_ROOT}/start.mjs",
    ]);
  });

  // Slice 2 — epoch-pattern detection works even if the tmpdir still exists.
  it("rewrites context-mode-upgrade-<digits> path even if currently exists", () => {
    const cacheRoot = makeTmp("ctx-issue523-cache-");
    const pluginRoot = resolve(
      cacheRoot,
      "context-mode",
      "context-mode",
      "1.0.118",
    );
    mkdirSync(pluginRoot, { recursive: true });
    // Faithfully reproduce cli.ts's `context-mode-upgrade-${Date.now()}` —
    // pure-numeric epoch suffix that mkdtempSync would never produce.
    const epochTmp = join(
      tmpdir(),
      `context-mode-upgrade-${Date.now()}`,
    );
    mkdirSync(epochTmp, { recursive: true });
    cleanups.push(epochTmp);
    const fakeStart = join(epochTmp, "start.mjs");
    writeFileSync(fakeStart, "// fake\n");
    const pluginJsonPath = buildPoisonedPluginJson({
      pluginRoot,
      args0: fakeStart,
    });

    const result = healPluginJsonMcpServers({
      pluginRoot,
      pluginCacheRoot: cacheRoot,
      pluginKey: "context-mode@context-mode",
    });

    expect(result.healed).toContain("plugin-json-args");
    const after = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
    expect(after.mcpServers["context-mode"].args[0]).toBe(
      "${CLAUDE_PLUGIN_ROOT}/start.mjs",
    );
  });

  // Slice 3 — idempotent: leave correct placeholder untouched.
  it("idempotent — leaves correct ${CLAUDE_PLUGIN_ROOT} placeholder untouched", () => {
    const cacheRoot = makeTmp("ctx-issue523-cache-");
    const pluginRoot = resolve(
      cacheRoot,
      "context-mode",
      "context-mode",
      "1.0.118",
    );
    mkdirSync(pluginRoot, { recursive: true });
    const pluginJsonPath = buildPoisonedPluginJson({
      pluginRoot,
      args0: "${CLAUDE_PLUGIN_ROOT}/start.mjs",
    });
    const before = readFileSync(pluginJsonPath, "utf-8");

    const result = healPluginJsonMcpServers({
      pluginRoot,
      pluginCacheRoot: cacheRoot,
      pluginKey: "context-mode@context-mode",
    });

    expect(result.healed).toEqual([]);
    // Bytes on disk are unchanged.
    expect(readFileSync(pluginJsonPath, "utf-8")).toBe(before);
  });

  // Slice 4 — traversal guard.
  it("traversal guard — refuses to write outside ~/.claude/plugins/cache", () => {
    const cacheRoot = makeTmp("ctx-issue523-cache-");
    // pluginRoot OUTSIDE the declared cache root → must refuse.
    const escapedRoot = makeTmp("ctx-issue523-escape-");
    mkdirSync(resolve(escapedRoot, ".claude-plugin"), { recursive: true });
    const pluginJsonPath = buildPoisonedPluginJson({
      pluginRoot: escapedRoot,
      args0: "/var/folders/x/T/context-mode-upgrade-1747000000000/start.mjs",
    });
    const before = readFileSync(pluginJsonPath, "utf-8");

    const result = healPluginJsonMcpServers({
      pluginRoot: escapedRoot,
      pluginCacheRoot: cacheRoot,
      pluginKey: "context-mode@context-mode",
    });

    expect(result.healed).toEqual([]);
    expect(result.skipped).toBe("outside-cache-root");
    // File is untouched.
    expect(readFileSync(pluginJsonPath, "utf-8")).toBe(before);
  });

  // Slice 5 — preserves unrelated mcpServers entries.
  it("preserves unrelated mcpServers entries", () => {
    const cacheRoot = makeTmp("ctx-issue523-cache-");
    const pluginRoot = resolve(
      cacheRoot,
      "context-mode",
      "context-mode",
      "1.0.118",
    );
    mkdirSync(pluginRoot, { recursive: true });
    const pluginJsonPath = buildPoisonedPluginJson({
      pluginRoot,
      args0: "/tmp/context-mode-upgrade-1747000000000/start.mjs",
      extraServers: {
        "user-other-mcp": {
          command: "python",
          args: ["/usr/local/bin/other-mcp.py", "--flag"],
        },
      },
    });

    const result = healPluginJsonMcpServers({
      pluginRoot,
      pluginCacheRoot: cacheRoot,
      pluginKey: "context-mode@context-mode",
    });

    expect(result.healed).toContain("plugin-json-args");
    const after = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
    // Our entry healed.
    expect(after.mcpServers["context-mode"].args[0]).toBe(
      "${CLAUDE_PLUGIN_ROOT}/start.mjs",
    );
    // Sibling untouched (we don't own it).
    expect(after.mcpServers["user-other-mcp"]).toEqual({
      command: "python",
      args: ["/usr/local/bin/other-mcp.py", "--flag"],
    });
  });

  // Slice 6 — Windows path: handles AppData\Local\Temp\ prefix.
  it("Windows path: handles AppData\\Local\\Temp\\ prefix", () => {
    const cacheRoot = makeTmp("ctx-issue523-cache-");
    const pluginRoot = resolve(
      cacheRoot,
      "context-mode",
      "context-mode",
      "1.0.118",
    );
    mkdirSync(pluginRoot, { recursive: true });
    const winPoisoned =
      "C:\\Users\\Mert\\AppData\\Local\\Temp\\context-mode-upgrade-1747000000000\\start.mjs";
    const pluginJsonPath = buildPoisonedPluginJson({
      pluginRoot,
      args0: winPoisoned,
    });

    const result = healPluginJsonMcpServers({
      pluginRoot,
      pluginCacheRoot: cacheRoot,
      pluginKey: "context-mode@context-mode",
    });

    expect(result.healed).toContain("plugin-json-args");
    const after = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
    expect(after.mcpServers["context-mode"].args[0]).toBe(
      "${CLAUDE_PLUGIN_ROOT}/start.mjs",
    );
  });
});
