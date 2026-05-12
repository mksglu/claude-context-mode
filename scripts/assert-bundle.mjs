#!/usr/bin/env node
// G3 — post-build bundle invariant assertion.
//
// Issue #511 class: esbuild rewrites bare `require("node:...")` calls into a
// `__require` shim that throws `Dynamic require of "..." is not supported`
// under Node ESM / Bun. Detecting the shim text in the produced bundle is the
// single invariant signal — the variable name is renamed by the minifier, but
// the embedded error literal is stable.
//
// This script is invoked by `npm run assert-bundle` (chained from `build`)
// and by the CI workflows. It scans every passed file for forbidden patterns
// and exits 1 with a violations report if any hit, exits 0 otherwise.
//
// Usage:
//   node scripts/assert-bundle.mjs <file> [<file>...]

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** @type {Array<{ name: string; pattern: RegExp; reason: string }>} */
const FORBIDDEN_PATTERNS = [
  {
    name: "esbuild-throwing-require-shim",
    pattern: /Dynamic require of/,
    reason:
      "esbuild emitted the throwing __require shim. This means a bare require() of a node: module reached the bundle and will throw under Node ESM / Bun. Use createRequire(import.meta.url) at module top instead. (Issue #511 class.)",
  },
  {
    name: "shimmed-node-builtin-call",
    pattern: /__require\s*\(\s*["'`]\s*node:/,
    reason:
      "Bundle contains a __require('node:...') call site, which routes through the throwing shim. Replace with createRequire(import.meta.url) at module top.",
  },
  {
    name: "raw-bare-require-node-builtin",
    pattern: /\brequire\s*\(\s*["'`]\s*node:/,
    reason:
      "Bundle contains a bare require('node:...') call. esbuild ESM output cannot resolve this at runtime. Use createRequire(import.meta.url). (Pattern catches single, double, and template-literal quote forms with optional whitespace.)",
  },
];

/**
 * Scan a single bundle file for forbidden patterns.
 * @param {string} filePath
 * @returns {{ clean: boolean; violations: string[] }}
 */
export function assertBundleClean(filePath) {
  if (!existsSync(filePath)) {
    return {
      clean: false,
      violations: [`File not found: ${filePath}`],
    };
  }
  const content = readFileSync(filePath, "utf-8");
  const violations = [];
  for (const { name, pattern, reason } of FORBIDDEN_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      violations.push(
        `[${name}] matched ${JSON.stringify(match[0])} — ${reason}`,
      );
    }
  }
  return { clean: violations.length === 0, violations };
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error(
      "assert-bundle: no bundle paths provided.\nUsage: node scripts/assert-bundle.mjs <file> [<file>...]",
    );
    process.exit(2);
  }

  let failed = false;
  for (const f of files) {
    const abs = resolve(f);
    const { clean, violations } = assertBundleClean(abs);
    if (clean) {
      console.log(`assert-bundle: OK  ${f}`);
    } else {
      failed = true;
      console.error(`assert-bundle: FAIL ${f}`);
      for (const v of violations) console.error(`  - ${v}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

// Run only when invoked directly, not when imported.
// On Windows, `import.meta.url` is `file:///C:/...` (forward slashes),
// while `process.argv[1]` is `C:\...` (backslashes). A literal-string
// `file://${argv[1]}` template never matches, so the prior comparison
// silently skipped main() on Windows and the script exited 0 with empty
// stdout — making the assert-bundle CI guardrail vacuous. Use
// `pathToFileURL` so the entry-point comparison is OS-agnostic.
const isDirectInvocation =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectInvocation) {
  main();
}
