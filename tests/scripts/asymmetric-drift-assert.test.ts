/**
 * Issue #531 — asymmetric-drift invariant.
 *
 * Architectural guardrail that prevents the class of bug that caused #531.
 * The repo ships TWO sibling files that BOTH carry the MCP server args:
 *
 *   1. `.mcp.json`                            (Claude Code reads at plugin load)
 *   2. `.claude-plugin/plugin.json`           (used by some adapters / Cursor)
 *
 * v1.0.118 (#411) fixed `.mcp.json` to use `${CLAUDE_PLUGIN_ROOT}/start.mjs`.
 * v1.0.119 (#523) fixed `.claude-plugin/plugin.json` to use the same placeholder
 * AND added a self-heal sibling — but ONLY for plugin.json. Asymmetric coverage.
 *
 * Then commit aea633c (#253, 2026-04-13) regressed the `.mcp.json` source
 * template to bare `./start.mjs` — and there was no invariant to catch it.
 * Fresh marketplace installs broke (issue #531) for a full release cycle.
 *
 * This invariant locks in: the two sibling files MUST agree on args[0]. The
 * invariant runs in two layers:
 *
 *   A. Source-tree test (this file) — vitest sees both files have matching
 *      args[0] and they're the literal `${CLAUDE_PLUGIN_ROOT}/start.mjs`.
 *   B. Build-chain script (`scripts/assert-asymmetric-drift.mjs`) — same check,
 *      wired into `npm run build` so a future cli.ts/marketplace.json drift
 *      surfaces in CI before publish.
 *
 * Failure mode caught: any future commit that rewrites EITHER file's args[0]
 * without rewriting the other surfaces immediately — no more silent
 * regressions like #531.
 */

import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}/start.mjs";

interface McpJson {
  mcpServers?: Record<string, { args?: unknown[] }>;
}

function readArgs0(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as McpJson;
  const args = parsed.mcpServers?.[key]?.args;
  if (!Array.isArray(args) || args.length === 0) return null;
  const a0 = args[0];
  return typeof a0 === "string" ? a0 : null;
}

describe("Issue #531 — asymmetric-drift invariant", () => {
  test(".mcp.json.example args[0] is the ${CLAUDE_PLUGIN_ROOT}/start.mjs placeholder", () => {
    // After the #531 architectural untrack (commit 9261377), .mcp.json is no
    // longer tracked in source — the canonical template moved to
    // .mcp.json.example. Contributors copy it to .mcp.json locally; end users
    // get MCP via .claude-plugin/plugin.json. This test pins the template.
    const got = readArgs0(resolve(ROOT, ".mcp.json.example"), "context-mode");
    expect(got, ".mcp.json.example missing or args[0] not a string").toBe(PLACEHOLDER);
  });

  test(".claude-plugin/plugin.json args[0] is the ${CLAUDE_PLUGIN_ROOT}/start.mjs placeholder", () => {
    const got = readArgs0(
      resolve(ROOT, ".claude-plugin", "plugin.json"),
      "context-mode",
    );
    expect(got, "plugin.json missing or args[0] not a string").toBe(PLACEHOLDER);
  });

  test(".mcp.json.example args[0] EQUALS .claude-plugin/plugin.json args[0] (drift guard)", () => {
    // Core architectural invariant. If the source-tracked template and the
    // shipped Claude Code manifest ever drift, fresh installs break silently.
    // This is the test-time mirror of scripts/assert-asymmetric-drift.mjs.
    const exampleArgs = readArgs0(resolve(ROOT, ".mcp.json.example"), "context-mode");
    const pluginArgs = readArgs0(
      resolve(ROOT, ".claude-plugin", "plugin.json"),
      "context-mode",
    );
    expect(exampleArgs).not.toBeNull();
    expect(pluginArgs).not.toBeNull();
    expect(exampleArgs).toBe(pluginArgs);
  });

  test("build-chain asserter script exists at scripts/assert-asymmetric-drift.mjs", () => {
    // The script is the same check, invocable from the build chain so future
    // regressions surface in CI before publish.
    expect(existsSync(resolve(ROOT, "scripts", "assert-asymmetric-drift.mjs"))).toBe(true);
  });

  test("build-chain asserter script exits 0 against the current source tree", () => {
    // End-to-end: run the script against the real repo. It MUST agree with
    // the in-process check (defence-in-depth). If this test fails, the
    // script and the source disagree — fix one or the other.
    const r = spawnSync(
      process.execPath,
      [resolve(ROOT, "scripts", "assert-asymmetric-drift.mjs")],
      { encoding: "utf-8", timeout: 10_000 },
    );
    expect(r.status, `asserter stderr: ${r.stderr}`).toBe(0);
  });

  test("build-chain asserter script exits non-zero when args[0] drifts", () => {
    // Drive the asserter with a temp scratch that intentionally drifts one
    // file. Use --root <path> to point it at the scratch dir.
    // (This documents the script's contract: it accepts --root.)
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");

    const scratch = mkdtempSync(join(tmpdir(), "asymmetric-drift-"));
    try {
      mkdirSync(join(scratch, ".claude-plugin"), { recursive: true });
      // mcp.json correct
      writeFileSync(
        join(scratch, ".mcp.json"),
        JSON.stringify({
          mcpServers: { "context-mode": { command: "node", args: [PLACEHOLDER] } },
        }),
      );
      // plugin.json DRIFTED — bare relative path (the #253 regression shape)
      writeFileSync(
        join(scratch, ".claude-plugin", "plugin.json"),
        JSON.stringify({
          name: "context-mode",
          mcpServers: { "context-mode": { command: "node", args: ["./start.mjs"] } },
        }),
      );
      const r = spawnSync(
        process.execPath,
        [resolve(ROOT, "scripts", "assert-asymmetric-drift.mjs"), "--root", scratch],
        { encoding: "utf-8", timeout: 10_000 },
      );
      expect(r.status, `asserter should fail on drift; stdout=${r.stdout}`).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(/drift|mismatch|differ/i);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("build chain (package.json) wires assert-asymmetric-drift into npm run build", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    // Same wiring posture as assert-bundle: chained from `build`.
    expect(pkg.scripts.build, "build script must invoke assert-asymmetric-drift")
      .toMatch(/assert-asymmetric-drift|asymmetric-drift/);
  });

  // ── PR #620 slice 5 — Tier C portability invariant (#613) ─────────────
  // PR #620 fixed the live regression in vscode-copilot + jetbrains-copilot
  // (commit f5c9d02 had baked absolute process.execPath + script paths into
  // workspace-committed `.github/hooks/context-mode.json` etc.). The fix was
  // surgical at the adapter layer; nothing structural prevents a future
  // contributor from accidentally re-introducing the same bug class in any
  // of the 15 adapters under configs/.
  //
  // This invariant scans every committed config template under configs/**
  // and asserts that no string value contains an absolute path, an fnm
  // session shim, a `process.execPath` literal, or a tilde-prefixed
  // home-dir path. Allowed shapes: bare commands ("context-mode", "node"),
  // CLI dispatcher form ("context-mode hook <platform> <event>"),
  // placeholders (${CLAUDE_PLUGIN_ROOT}), schema URLs.
  //
  // The persistence-tier rule (ISSUE-613-VERDICT §6.1):
  //   Tier C (workspace-committed, cross-machine, multi-user) MUST be
  //   born portable -- no heal seam exists for files that ship in users'
  //   git history.
  //
  // This catches the bug class at PR-review time across the entire
  // configs/ surface, not just the two adapters PR #620 fixed.
  test("configs/** templates ship no absolute paths, fnm shims, or shell-expansion paths (#613 PR #620)", () => {
    // Recursively enumerate every .json file under configs/.
    const { readdirSync, statSync } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");

    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const s = statSync(p);
        if (s.isDirectory()) out.push(...walk(p));
        else if (entry.endsWith(".json")) out.push(p);
      }
      return out;
    }

    const files = walk(resolve(ROOT, "configs"));
    // Sanity: configs/ should ship multiple adapter templates. If this is
    // ever 0 the test silently passes -- guard against that.
    expect(files.length, "configs/ should contain at least one .json template").toBeGreaterThan(0);

    // Forbidden patterns -- each captures a different way the bug class
    // re-surfaces in practice:
    const forbidden: { name: string; re: RegExp }[] = [
      // Unix absolute home directories (PII leak per ISSUE-613-VERDICT
      // multi-hat §Security; also the #613 reporter symptom shape).
      { name: "unix /Users absolute path", re: /^\/Users\// },
      { name: "unix /home absolute path", re: /^\/home\// },
      // Windows absolute paths (drive-letter + separator).
      { name: "Windows drive-letter absolute", re: /^[A-Za-z]:[/\\]/ },
      // UNC paths.
      { name: "Windows UNC path", re: /^\\\\/ },
      // fnm session-ephemeral shim -- the literal #613 reporter saw.
      // Per fnm-rs docs this directory is per-shell-session per-PID
      // ephemeral; baking it into any committable file is invalid.
      { name: "fnm session shim", re: /fnm_multishells/ },
      // process.execPath as a string literal: indicates the generator
      // baked node's runtime binary path into the JSON (the f5c9d02
      // anti-pattern PR #620 reverted in two adapters).
      { name: "process.execPath literal", re: /process\.execPath/ },
      // Tilde-prefixed paths: shells expand `~` but JSON consumers do
      // not. A committed `~/...` value would resolve literally on
      // every platform (and fail). Also a Windows-safety violation.
      { name: "literal tilde path", re: /^~[/\\]/ },
      // ${HOME} shell-expansion: same issue -- not JSON-portable, only
      // the spawned shell expands it; cross-platform consumers don't.
      { name: "${HOME} shell expansion", re: /\$\{?HOME\}?[/\\]/ },
    ];

    interface Offence {
      file: string;
      jsonPath: string;
      value: string;
      pattern: string;
    }
    const offences: Offence[] = [];

    function recurse(node: unknown, file: string, path: string): void {
      if (typeof node === "string") {
        for (const f of forbidden) {
          if (f.re.test(node)) {
            offences.push({
              file,
              jsonPath: path || "$",
              value: node.length > 120 ? node.slice(0, 117) + "..." : node,
              pattern: f.name,
            });
          }
        }
      } else if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) recurse(node[i], file, `${path}[${i}]`);
      } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          recurse(v, file, `${path}.${k}`);
        }
      }
    }

    for (const abs of files) {
      const rel = abs.slice(ROOT.length + 1).replace(/\\/g, "/");
      const raw = readFileSync(abs, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(`configs/ template is not valid JSON: ${rel} -- ${(err as Error).message}`);
      }
      recurse(parsed, rel, "");
    }

    if (offences.length > 0) {
      const lines = offences.map(
        (o) => `  - ${o.file}:${o.jsonPath} = ${JSON.stringify(o.value)} [${o.pattern}]`,
      );
      throw new Error(
        [
          `${offences.length} Tier C portability violation(s) in configs/ (PR #620 / #613):`,
          ...lines,
          "",
          "Workspace-committed config templates ship to every user's git tree.",
          "Per ISSUE-613-VERDICT 6.1, Tier C files MUST be born portable -- no",
          "heal seam exists for files committed to user repos. Allowed shapes:",
          "  - CLI dispatcher: \"context-mode hook <platform> <event>\"",
          "  - Bare command:   \"context-mode\" / \"node\"",
          "  - Placeholder:    \"${CLAUDE_PLUGIN_ROOT}/...\"",
          "  - Schema URL:     \"https://.../config.json\"",
          "",
          "Forbidden: absolute paths, fnm session shims, process.execPath literals,",
          "literal `~/...` or `${HOME}/...` (not JSON-portable; Windows-unsafe).",
        ].join("\n"),
      );
    }
  });

  // ── Regression guard for the postinstall-heal scope bug ──────────────
  // CI run 25734987495 (Windows-latest) failed on `npm run build` because
  // scripts/postinstall.mjs section 4 called `normalizeHooksOnStartup`
  // which rewrites `${CLAUDE_PLUGIN_ROOT}` → an absolute path in source-
  // tracked `.claude-plugin/plugin.json`. The existing TMPDIR_UPGRADE_RE
  // guard only skipped /ctx-upgrade staging, not contributor / CI installs.
  // Result: every `npm install` from a git clone (CI runners + contributors)
  // mutated the source file, and the very next step (`npm run build` →
  // `assert-asymmetric-drift`) detected the drift and failed the build.
  //
  // Fix gated section 4 with `isGlobalInstall()` (same heuristic section -1
  // uses: `npm_config_global=true` AND no `.git` walking up). This test
  // drives the exact scenario CI exercises and locks the contract so the
  // heal cannot silently regain mutation power.
  test("postinstall.mjs DOES NOT mutate source-tracked plugin.json when run from a clone (Windows CI regression)", () => {
    const { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");

    const scratch = mkdtempSync(join(tmpdir(), "postinstall-clone-"));
    try {
      // Simulate a contributor / CI clone: `.git` present, source-tracked
      // plugin.json carries the literal placeholder.
      mkdirSync(join(scratch, ".git"), { recursive: true });
      mkdirSync(join(scratch, ".claude-plugin"), { recursive: true });
      mkdirSync(join(scratch, "scripts"), { recursive: true });
      mkdirSync(join(scratch, "hooks"), { recursive: true });
      mkdirSync(join(scratch, "node_modules"), { recursive: true });

      writeFileSync(
        join(scratch, ".claude-plugin", "plugin.json"),
        JSON.stringify({
          name: "context-mode",
          version: "0.0.0-test",
          mcpServers: {
            "context-mode": {
              command: "node",
              args: [PLACEHOLDER],
            },
          },
        }),
      );
      // Also seed hooks.json since normalize-hooks targets that too.
      writeFileSync(
        join(scratch, "hooks", "hooks.json"),
        JSON.stringify({ hooks: {} }),
      );
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ name: "context-mode", version: "0.0.0-test" }),
      );

      // Copy the live postinstall + normalize-hooks (the modules that
      // implement section 4 — the actual code under test). Stub out the
      // heal-* modules with no-ops so we don't pay for prebuild-install
      // downloads (~20s, blows past CI's 30s budget) and registry walks.
      // We're testing the GUARD on section 4, not the heal logic itself,
      // so the heals being live adds nothing and removes determinism.
      cpSync(
        resolve(ROOT, "scripts", "postinstall.mjs"),
        join(scratch, "scripts", "postinstall.mjs"),
      );
      cpSync(
        resolve(ROOT, "hooks", "normalize-hooks.mjs"),
        join(scratch, "hooks", "normalize-hooks.mjs"),
      );
      writeFileSync(
        join(scratch, "scripts", "heal-better-sqlite3.mjs"),
        "export function healBetterSqlite3Binding() { /* stub */ }\n",
      );
      writeFileSync(
        join(scratch, "scripts", "heal-installed-plugins.mjs"),
        [
          "export function healInstalledPlugins() { return { skipped: 'test-stub' }; }",
          "export function healSettingsEnabledPlugins() { return { healed: [] }; }",
          "export function healPluginJsonMcpServers() { return { healed: [] }; }",
          "export function healMcpJsonArgs() { return { healed: [] }; }",
          // Issue #609 — sweepStaleMcpJson replaced per-entry healMcpJsonArgs.
          // Stubbed alongside healMcpJsonArgs for backwards compatibility with
          // any in-flight callers that still import it.
          "export function sweepStaleMcpJson() { return { removed: [] }; }",
          "",
        ].join("\n"),
      );

      // Run postinstall the same way npm does — env stripped of
      // npm_config_global (this is the contributor / CI codepath).
      const env = { ...process.env };
      delete env.npm_config_global;
      const r = spawnSync(process.execPath, ["scripts/postinstall.mjs"], {
        cwd: scratch,
        env,
        encoding: "utf-8",
        timeout: 30_000,
      });
      expect(r.status, `postinstall failed: ${r.stderr}`).toBe(0);

      const after = readArgs0(
        join(scratch, ".claude-plugin", "plugin.json"),
        "context-mode",
      );
      expect(
        after,
        "postinstall.mjs mutated source-tracked .claude-plugin/plugin.json — section 4's heal must skip contributor / CI installs (isGlobalInstall guard)",
      ).toBe(PLACEHOLDER);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
