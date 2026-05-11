/**
 * Codex plugin manifest tests — guards the shipped `.codex-plugin/*` files
 * against accidental drift that would silently break Codex CLI marketplace
 * installs.
 *
 * Why these assertions matter (verified against codex-rs source @ 2026-05-11):
 *
 * - Codex's plugin loader deserializes `.codex-plugin/mcp.json` via
 *   `PluginMcpServersFile` which is `#[serde(rename_all = "camelCase")]`
 *   (codex-rs/core-plugins/src/loader.rs:101-104). The JSON key MUST be
 *   `mcpServers` (camelCase). A snake_case `mcp_servers` key falls through
 *   to the `ServerMap` fallback and registers a single bogus server literally
 *   named "mcp_servers" — silent breakage with no warning.
 *
 * - Codex performs ZERO variable substitution on `args` — the stdio launcher
 *   passes them verbatim to `Command::new(...).args(args)`
 *   (codex-rs/rmcp-client/src/stdio_server_launcher.rs:253-260). So
 *   `${CODEX_PLUGIN_ROOT}` would be passed literally to Node, which would
 *   then fail to load. (`CODEX_PLUGIN_ROOT` is also not a real env var —
 *   it only appears in TUI display strings.)
 *
 * - Codex DOES auto-resolve a relative `cwd` against the plugin root in
 *   `normalize_plugin_mcp_server_value` (codex-rs/core-plugins/src/loader.rs:1067-1071).
 *   So `cwd: "."` becomes `<plugin_root>` at spawn time, and a relative
 *   `args: ["./start.mjs"]` then resolves correctly when Node loads it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");

function readJson(relPath: string): Record<string, unknown> {
  const raw = readFileSync(resolve(REPO_ROOT, relPath), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe(".codex-plugin/mcp.json", () => {
  const mcp = readJson(".codex-plugin/mcp.json");

  it("uses camelCase `mcpServers` (Codex deserializes via #[serde(rename_all = camelCase)])", () => {
    expect(mcp).toHaveProperty("mcpServers");
    expect(mcp).not.toHaveProperty("mcp_servers");
  });

  it("declares the context-mode server entry", () => {
    const servers = mcp.mcpServers as Record<string, unknown>;
    expect(servers).toBeTypeOf("object");
    expect(servers).toHaveProperty("context-mode");
  });

  it("launches via `node` with relative `./start.mjs`", () => {
    const servers = mcp.mcpServers as Record<string, { command: string; args: string[] }>;
    const entry = servers["context-mode"];
    expect(entry.command).toBe("node");
    expect(entry.args).toEqual(["./start.mjs"]);
  });

  it("sets `cwd: \".\"` so Codex resolves it to the plugin root at spawn", () => {
    // Codex normalizes relative cwd → plugin_root.join(cwd). With cwd="."
    // the spawned `node ./start.mjs` resolves correctly inside the
    // installed plugin directory.
    const servers = mcp.mcpServers as Record<string, { cwd?: string }>;
    const entry = servers["context-mode"];
    expect(entry.cwd).toBe(".");
  });

  it("does NOT use `${CODEX_PLUGIN_ROOT}` placeholders (no var expansion happens)", () => {
    const raw = readFileSync(resolve(REPO_ROOT, ".codex-plugin/mcp.json"), "utf8");
    expect(raw).not.toMatch(/\$\{[^}]*PLUGIN_ROOT[^}]*\}/);
  });
});

describe(".codex-plugin/plugin.json", () => {
  const manifest = readJson(".codex-plugin/plugin.json");
  const pkg = readJson("package.json");

  it("references the sibling mcp.json via the camelCase `mcpServers` field", () => {
    // Codex's manifest schema (codex-rs/core-plugins/src/manifest.rs:28)
    // deserializes `mcpServers` as `Option<String>` — a path to the mcp file.
    expect(manifest.mcpServers).toBe("./.codex-plugin/mcp.json");
  });

  it("version matches package.json (kept in lockstep by version-sync)", () => {
    expect(manifest.version).toBe(pkg.version);
  });
});

describe(".codex-plugin/marketplace.json", () => {
  const marketplace = readJson(".codex-plugin/marketplace.json") as {
    metadata?: { version?: string };
    plugins?: Array<{ version?: string }>;
  };
  const pkg = readJson("package.json");

  it("metadata.version matches package.json", () => {
    expect(marketplace.metadata?.version).toBe(pkg.version);
  });

  it("plugin entry version matches package.json", () => {
    expect(marketplace.plugins?.[0]?.version).toBe(pkg.version);
  });
});
