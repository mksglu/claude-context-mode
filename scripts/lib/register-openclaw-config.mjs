// Idempotent runtime-config mutation for `openclaw.json`, extracted from
// scripts/install-openclaw-plugin.sh so the logic can be unit-tested.
//
// Responsibilities:
//   1. Remove the legacy `plugins.load.paths` entry (caused duplicate registration).
//   2. Ensure `context-mode` is present in `plugins.allow` + `plugins.entries`.
//   3. Register `mcp.servers.context-mode` → `{command:"node", args:["<pluginRoot>/server.bundle.mjs"]}`
//      so OpenClaw spawns the MCP sidecar and surfaces `ctx_*` tools to the agent.
//
// Can be used as a library (`import { registerContextModeInOpenclawConfig } from ...`)
// or as a CLI (`node register-openclaw-config.mjs <runtimePath> <pluginRoot>`).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function registerContextModeInOpenclawConfig(runtimePath, pluginRoot) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(runtimePath, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse ${runtimePath} — is it valid JSON? (${e.message})`);
  }

  const messages = [];
  const plugins = (cfg.plugins ??= {});

  // 1. Remove plugins.load.paths entry (causes duplicate registration)
  const load = plugins.load ?? {};
  const paths = load.paths ?? [];
  const idx = paths.indexOf(pluginRoot);
  if (idx !== -1) {
    paths.splice(idx, 1);
    if (!paths.length) delete load.paths;
    if (!Object.keys(load).length) delete plugins.load;
    messages.push("removed plugins.load.paths entry (caused duplicate registration)");
  }

  // 2. Add to plugins.allow (idempotent)
  const allow = (plugins.allow ??= []);
  if (!allow.includes("context-mode")) allow.unshift("context-mode");

  // 3. Add to plugins.entries (idempotent)
  const entries = (plugins.entries ??= {});
  if (!entries["context-mode"]) entries["context-mode"] = { enabled: true };

  // 4. Register MCP sidecar so OpenClaw spawns server.bundle.mjs and surfaces
  //    ctx_* tools to the agent. Without this entry the plugin loads but its
  //    tools never reach the agent's tool list (confirmed against OpenClaw
  //    2026.4.22: context-mode 1.0.89 plugin "loaded" but no ctx_* tools
  //    visible until mcp.servers.context-mode was set).
  const mcp = (cfg.mcp ??= {});
  const servers = (mcp.servers ??= {});
  const serverBundle = `${pluginRoot}/server.bundle.mjs`;
  const existing = servers["context-mode"];
  const needsWrite =
    !existing ||
    existing.command !== "node" ||
    !Array.isArray(existing.args) ||
    existing.args[0] !== serverBundle;
  if (needsWrite) {
    // Preserve any unrelated fields a user (or future OpenClaw version) may have
    // added — e.g. `env`, `cwd`, `timeout` — and only overwrite the two this
    // helper owns. Full-reset would silently drop those.
    const base = existing && typeof existing === "object" ? existing : {};
    servers["context-mode"] = { ...base, command: "node", args: [serverBundle] };
    messages.push(`registered mcp.servers.context-mode → ${serverBundle}`);
  }

  writeFileSync(runtimePath, JSON.stringify(cfg, null, 2) + "\n");

  return {
    pluginsAllow: allow,
    mcpServer: servers["context-mode"],
    messages,
  };
}

// CLI entry point — preserves the output format used by the previous inline
// `node -e` block in install-openclaw-plugin.sh so existing installers keep
// the same stdout contract.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtimePath, pluginRoot] = process.argv.slice(2);
  if (!runtimePath || !pluginRoot) {
    console.error("Usage: node register-openclaw-config.mjs <runtimePath> <pluginRoot>");
    process.exit(1);
  }
  try {
    const { pluginsAllow, messages } = registerContextModeInOpenclawConfig(runtimePath, pluginRoot);
    for (const msg of messages) console.log(`  ${msg}`);
    console.log("  plugins.allow:", JSON.stringify(pluginsAllow));
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    process.exit(1);
  }
}
