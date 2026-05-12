#!/usr/bin/env node
// Sync version from package.json to all manifest files.
// Runs automatically via npm `version` lifecycle hook.

import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;

console.log(`→ syncing version ${version} to manifests...`);

const targets = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  // .codex-plugin/marketplace.json is intentionally absent — Codex CLI
  // reads marketplaces from .agents/plugins/marketplace.json (or
  // .claude-plugin/marketplace.json for Claude-compat). See
  // refs/platforms/codex/codex-rs/core-plugins/src/marketplace.rs:21
  // (MARKETPLACE_MANIFEST_RELATIVE_PATHS).
  //
  // .agents/plugins/marketplace.json has no top-level `version` field
  // (per the Codex serde schema at marketplace.rs:694-700 — only `name`,
  // `interface`, and `plugins[]`), so it doesn't need version-syncing.
  // Per-plugin `version` lives in .codex-plugin/plugin.json which is
  // already in this list.
  ".openclaw-plugin/openclaw.plugin.json",
  ".openclaw-plugin/package.json",
  "openclaw.plugin.json",
  ".pi/extensions/context-mode/package.json",
];

for (const file of targets) {
  try {
    const content = JSON.parse(readFileSync(file, "utf8"));
    if (content.version !== undefined) content.version = version;
    if (content.metadata?.version !== undefined) content.metadata.version = version;
    if (content.plugins) {
      for (const p of content.plugins) {
        if (p.version !== undefined) p.version = version;
      }
    }
    writeFileSync(file, JSON.stringify(content, null, 2) + "\n");
    console.log(`  ✓ ${file}`);
  } catch (e) {
    console.log(`  ⚠ ${file} — ${e.message}`);
  }
}

// Note: package.json's `omp` block intentionally has no `version` field.
// The OMP loader stamps `manifest.version = pluginPkg.version` from the
// top-level package.json:version at load time (see
// refs/platforms/oh-my-pi/packages/coding-agent/src/extensibility/plugins/
// loader.ts:87), so a duplicate would just drift on every release without
// adding any signal. The `pi` block follows the same upstream rule.

console.log(`✓ all manifests at v${version}`);
