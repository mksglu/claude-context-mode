#!/usr/bin/env node
// Issue #531 — asymmetric-drift invariant asserter.
//
// The canonical MCP server config lives in TWO source-tracked files:
//
//   1. `.mcp.json.example`                    (template; copied to .mcp.json
//                                              locally by contributors. .mcp.json
//                                              itself is .gitignored after the
//                                              #531 architectural untrack — see
//                                              .gitignore and tests/core/cli.test.ts
//                                              "package.json files[] MUST NOT ship
//                                              .mcp.json".)
//   2. `.claude-plugin/plugin.json`           (Claude Code's primary read path
//                                              for installed plugins. cli.ts
//                                              upgrade() writes a matching
//                                              .mcp.json into the plugin cache.)
//
// If the two source-tracked files drift, fresh installs break silently
// (the #253 regression survived a full release cycle because no invariant
// caught the bare `./start.mjs` shape).
//
// This script is the build-chain half of the slice-9 invariant pair.
// The vitest sibling (tests/scripts/asymmetric-drift-assert.test.ts) covers
// the source tree at test time; this script covers the build chain — wired
// into `npm run build` so any regression surfaces in CI before publish.
//
// Contract:
//   - Read `.mcp.json.example` and `.claude-plugin/plugin.json` from --root.
//   - Extract mcpServers["context-mode"].args[0] from each.
//   - Assert both equal the literal `${CLAUDE_PLUGIN_ROOT}/start.mjs`.
//   - Assert the two values are equal (the explicit drift check).
//   - If a `.mcp.json` exists (contributor's local copy), check it too —
//     but absence is fine (it's .gitignored).
//   - Exit 0 on success, 1 with a violations report on failure.
//
// Usage:
//   node scripts/assert-asymmetric-drift.mjs              # checks repo root
//   node scripts/assert-asymmetric-drift.mjs --root <dir> # checks <dir>

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}/start.mjs";
const PLUGIN_KEY = "context-mode";

function parseArgs(argv) {
  const out = { root: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && i + 1 < argv.length) {
      out.root = argv[i + 1];
      i++;
    }
  }
  return out;
}

function readArgs0(filePath) {
  if (!existsSync(filePath)) return { ok: false, error: `missing: ${filePath}` };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    return { ok: false, error: `parse-failed (${filePath}): ${err && err.message}` };
  }
  const servers = parsed && parsed.mcpServers;
  if (!servers || typeof servers !== "object") {
    return { ok: false, error: `no mcpServers in ${filePath}` };
  }
  const ours = servers[PLUGIN_KEY];
  if (!ours || typeof ours !== "object" || !Array.isArray(ours.args) || ours.args.length === 0) {
    return { ok: false, error: `no args[] for ${PLUGIN_KEY} in ${filePath}` };
  }
  const a0 = ours.args[0];
  if (typeof a0 !== "string") {
    return { ok: false, error: `args[0] not a string in ${filePath}` };
  }
  return { ok: true, value: a0 };
}

function main() {
  const { root: explicitRoot } = parseArgs(process.argv.slice(2));
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = explicitRoot
    ? resolve(explicitRoot)
    : resolve(__dirname, "..");

  const exampleJsonPath = resolve(root, ".mcp.json.example");
  const pluginJsonPath = resolve(root, ".claude-plugin", "plugin.json");
  const localMcpJsonPath = resolve(root, ".mcp.json");

  /** @type {string[]} */
  const violations = [];

  const example = readArgs0(exampleJsonPath);
  const plg = readArgs0(pluginJsonPath);

  if (!example.ok) violations.push(example.error);
  if (!plg.ok) violations.push(plg.error);

  if (example.ok && example.value !== PLACEHOLDER) {
    violations.push(
      `.mcp.json.example args[0] is "${example.value}" but must equal "${PLACEHOLDER}". ` +
        `Contributors copy this template to .mcp.json for local dev, so the template MUST hold the canonical form. (Issue #531 / #253 class.)`,
    );
  }
  if (plg.ok && plg.value !== PLACEHOLDER) {
    violations.push(
      `.claude-plugin/plugin.json args[0] is "${plg.value}" but must equal "${PLACEHOLDER}". (Issue #523 class.)`,
    );
  }
  if (example.ok && plg.ok && example.value !== plg.value) {
    violations.push(
      `asymmetric drift: .mcp.json.example args[0]="${example.value}" vs .claude-plugin/plugin.json args[0]="${plg.value}". The two source-tracked manifests MUST agree so contributors copying the template and end-users via marketplace install resolve the same start.mjs.`,
    );
  }

  // Contributor's local .mcp.json (if present) — must match the template.
  // Absence is fine; the file is .gitignored after the #531 architectural untrack.
  if (existsSync(localMcpJsonPath)) {
    const local = readArgs0(localMcpJsonPath);
    if (local.ok && local.value !== PLACEHOLDER) {
      violations.push(
        `local .mcp.json args[0] is "${local.value}" but must equal "${PLACEHOLDER}". ` +
          `If you intentionally use a relative dev path locally, ignore — but this file would ship the regression if it ever lands in package.json files[]. Consider \`cp .mcp.json.example .mcp.json\` to reset.`,
      );
    }
  }

  if (violations.length > 0) {
    process.stderr.write("asymmetric-drift: FAIL\n");
    for (const v of violations) {
      process.stderr.write(`  - ${v}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(
    `asymmetric-drift: OK (.mcp.json.example + .claude-plugin/plugin.json both pin args[0] to ${PLACEHOLDER})\n`,
  );
}

main();
