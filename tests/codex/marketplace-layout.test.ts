/**
 * Codex CLI marketplace discovery — layout contract.
 *
 * These tests pin what Codex CLI v0.130.0 actually does, not what we wish
 * it did. Every assertion mirrors a specific line in the Codex Rust source
 * under refs/platforms/codex/codex-rs/core-plugins/src/marketplace.rs.
 *
 * THE FAILURE MODE WE'RE PINNING (proven against Codex v0.130.0):
 *
 *   Before this fix, `codex plugin marketplace add <repo>` succeeded but
 *   the plugin never appeared in /plugin. Why? Codex deserializes our
 *   marketplace.json fine (any string is a valid Path variant), but
 *   `resolve_local_plugin_source_path` at marketplace.rs:502-518 does:
 *
 *     let Some(path) = path.strip_prefix("./") else { error };
 *     if path.is_empty() { error };  // ← rejects "./" with empty-string error
 *
 *   That error is then caught silently at marketplace.rs:446-452 via
 *   `warn!(... skipping marketplace plugin that failed to resolve)` and
 *   the plugin is dropped. Exit code stays 0, marketplace entry exists in
 *   ~/.codex/config.toml, but the plugins vec is empty.
 *
 *   So the contract Codex enforces is:
 *     1. marketplace.json MUST be at .agents/plugins/marketplace.json OR
 *        .claude-plugin/marketplace.json (MARKETPLACE_MANIFEST_RELATIVE_PATHS
 *        constant at marketplace.rs:21). Codex tries them in that order.
 *     2. Each plugin's `source` MUST resolve to a directory != marketplace root
 *        (the strip_prefix("./") + non-empty check).
 *     3. The resolved directory MUST contain `.codex-plugin/plugin.json`
 *        (otherwise load_plugin_manifest at line 401 returns None → plugin
 *        has no manifest → install fails downstream).
 *     4. `${CODEX_PLUGIN_ROOT}` placeholders are NOT interpolated — upstream
 *        openai/codex#19582 is OPEN. So our shipped manifests must work
 *        without any variable substitution.
 */

import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * The set of marketplace manifest paths Codex actually reads, in priority
 * order. Sourced verbatim from
 * `refs/platforms/codex/codex-rs/core-plugins/src/marketplace.rs:21`:
 *
 *   const MARKETPLACE_MANIFEST_RELATIVE_PATHS: &[&str] = &[
 *       ".agents/plugins/marketplace.json",
 *       ".claude-plugin/marketplace.json",
 *   ];
 *
 * `.codex-plugin/marketplace.json` is NOT in this list — Codex never reads it.
 */
const CODEX_MARKETPLACE_PATHS = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
] as const;

interface RawPluginSourceObject {
  source: "local" | "url" | "git-subdir";
  path?: string;
  url?: string;
}

interface RawPluginEntry {
  name: string;
  source: string | RawPluginSourceObject;
  policy?: Record<string, unknown>;
  category?: string;
}

interface RawMarketplaceManifest {
  name: string;
  interface?: { displayName?: string };
  plugins: RawPluginEntry[];
}

/**
 * Mirror of Codex's `resolve_local_plugin_source_path` at marketplace.rs:498-525.
 * Returns the resolved absolute path on success, or throws with the EXACT
 * error message Codex emits via `warn!()` for that input.
 */
function resolveLocalPluginSourcePath(
  marketplaceRoot: string,
  rawSourcePath: string,
): string {
  if (!rawSourcePath.startsWith("./")) {
    throw new Error("local plugin source path must start with `./`");
  }
  const stripped = rawSourcePath.slice(2);
  if (stripped.length === 0) {
    throw new Error("local plugin source path must not be empty");
  }
  // Codex also rejects path traversal: any component != Normal(_).
  if (stripped.split("/").some((c) => c === ".." || c === "" || c === ".")) {
    throw new Error("local plugin source path must stay within the marketplace root");
  }
  return join(marketplaceRoot, stripped);
}

/**
 * Mirror of Codex's `RawMarketplaceManifestPluginSource` deserialize at
 * marketplace.rs:735-744 (untagged enum: Path(String) | Object(...)).
 */
function extractSourcePath(source: string | RawPluginSourceObject): string {
  if (typeof source === "string") return source;
  if (source.source === "local" && typeof source.path === "string") {
    return source.path;
  }
  throw new Error(
    `unsupported plugin source shape: ${JSON.stringify(source)} — Codex would warn! and drop this plugin`,
  );
}

describe("Codex marketplace discovery contract — v0.130.0", () => {
  test("ships .agents/plugins/marketplace.json (Codex's primary read path)", () => {
    const agentsPath = join(REPO_ROOT, ".agents/plugins/marketplace.json");
    assert.ok(
      existsSync(agentsPath),
      `Missing ${agentsPath}. Codex tries MARKETPLACE_MANIFEST_RELATIVE_PATHS in order: ` +
        `[.agents/plugins/marketplace.json, .claude-plugin/marketplace.json]. ` +
        `Without the .agents/ file Codex falls back to .claude-plugin which has a different schema ` +
        `(source: "./" string) that fails its strip_prefix non-empty check.`,
    );
  });

  test("Codex-canonical marketplace manifest parses cleanly + has at least one plugin", () => {
    const path = join(REPO_ROOT, ".agents/plugins/marketplace.json");
    const raw = readFileSync(path, "utf-8");
    const manifest = JSON.parse(raw) as RawMarketplaceManifest;
    assert.equal(typeof manifest.name, "string", "manifest.name required (marketplace.rs:697)");
    assert.ok(manifest.name.length > 0, "manifest.name must be non-empty");
    assert.ok(
      Array.isArray(manifest.plugins),
      "manifest.plugins must be an array (marketplace.rs:700)",
    );
    assert.ok(
      manifest.plugins.length >= 1,
      "manifest.plugins must contain at least one entry",
    );
  });

  test("every plugin source resolves through Codex's strip_prefix non-empty check", () => {
    const path = join(REPO_ROOT, ".agents/plugins/marketplace.json");
    const marketplaceRoot = REPO_ROOT;
    const manifest = JSON.parse(readFileSync(path, "utf-8")) as RawMarketplaceManifest;
    for (const plugin of manifest.plugins) {
      const sourcePath = extractSourcePath(plugin.source);
      // This call throws the exact error Codex would `warn!` on. If it throws,
      // Codex would silently drop this plugin and /plugin would never show it.
      assert.doesNotThrow(
        () => resolveLocalPluginSourcePath(marketplaceRoot, sourcePath),
        `Plugin '${plugin.name}' has source "${sourcePath}" which Codex would reject. ` +
          `Use "./plugins/${plugin.name}" instead of "./" or other unsupported shapes.`,
      );
    }
  });

  test("every plugin's resolved path contains .codex-plugin/plugin.json (real plugin tree)", () => {
    const path = join(REPO_ROOT, ".agents/plugins/marketplace.json");
    const marketplaceRoot = REPO_ROOT;
    const manifest = JSON.parse(readFileSync(path, "utf-8")) as RawMarketplaceManifest;
    for (const plugin of manifest.plugins) {
      const sourcePath = extractSourcePath(plugin.source);
      const resolved = resolveLocalPluginSourcePath(marketplaceRoot, sourcePath);
      const realResolved = realpathSync(resolved);
      const pluginJson = join(realResolved, ".codex-plugin", "plugin.json");
      assert.ok(
        existsSync(pluginJson),
        `Plugin '${plugin.name}' resolves to ${resolved} (realpath ${realResolved}) ` +
          `but ${pluginJson} is missing. Codex's load_plugin_manifest (marketplace.rs:401) ` +
          `would return None → /plugin install would fail.`,
      );
    }
  });

  test("no ${CODEX_PLUGIN_ROOT} / ${CLAUDE_PLUGIN_ROOT} placeholders in Codex-facing manifests (upstream openai/codex#19582)", () => {
    // Codex does NOT interpolate these placeholders in plugin manifest
    // values — proven by zero `interpolat*`/`expand_env*`/`envsubst*` in
    // codex-rs/core-plugins/src/. Any placeholder in our manifests would
    // be passed through literally and break MCP server spawn / hook exec.
    const filesToCheck = [
      ".agents/plugins/marketplace.json",
      ".codex-plugin/plugin.json",
      ".codex-plugin/mcp.json",
    ];
    for (const rel of filesToCheck) {
      const absPath = join(REPO_ROOT, rel);
      if (!existsSync(absPath)) continue; // optional files are OK to skip
      const content = readFileSync(absPath, "utf-8");
      assert.doesNotMatch(
        content,
        /\$\{CODEX_PLUGIN_ROOT\}|\$\{CLAUDE_PLUGIN_ROOT\}/,
        `${rel} contains a \${CODEX_PLUGIN_ROOT}/\${CLAUDE_PLUGIN_ROOT} placeholder. ` +
          `Codex never interpolates these (openai/codex#19582 OPEN). The literal string ` +
          `would be passed to MCP spawn / hook exec verbatim and fail.`,
      );
    }
  });

  test(".codex-plugin/marketplace.json is removed (dead path — Codex never reads it)", () => {
    const deadPath = join(REPO_ROOT, ".codex-plugin/marketplace.json");
    assert.ok(
      !existsSync(deadPath),
      `${deadPath} still exists. Codex's MARKETPLACE_MANIFEST_RELATIVE_PATHS at ` +
        `marketplace.rs:21 does NOT include this path — keeping it ships dead bytes and ` +
        `misleads contributors into editing the wrong file.`,
    );
  });
});
