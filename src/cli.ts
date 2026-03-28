#!/usr/bin/env node
/**
 * context-mode CLI
 *
 * Usage:
 *   context-mode                              → Start MCP server (stdio)
 *   context-mode doctor                       → Diagnose runtime issues, hooks, FTS5, version
 *   context-mode upgrade                      → Fix hooks, permissions, and settings
 *   context-mode hook <platform> <event>      → Dispatch a hook script (used by platform hook configs)
 *
 * Platform auto-detection: CLI detects which platform is running
 * (Claude Code, Gemini CLI, OpenCode, etc.) and uses the appropriate adapter.
 */

import * as p from "@clack/prompts";
import color from "picocolors";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, cpSync, accessSync, existsSync, readdirSync, rmSync, closeSync, openSync, chmodSync, constants } from "node:fs";
import { request as httpsRequest } from "node:https";
import { resolve, dirname, join } from "node:path";
import { tmpdir, devNull } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  detectRuntimes,
  getRuntimeSummary,
  hasBunRuntime,
  getAvailableLanguages,
} from "./runtime.js";

// ── Adapter imports ──────────────────────────────────────
import { detectPlatform, getAdapter } from "./adapters/detect.js";
import type { HookAdapter } from "./adapters/types.js";

/* -------------------------------------------------------
 * Hook dispatcher — `context-mode hook <platform> <event>`
 * ------------------------------------------------------- */

const HOOK_MAP: Record<string, Record<string, string>> = {
  "claude-code": {
    pretooluse: "hooks/pretooluse.mjs",
    posttooluse: "hooks/posttooluse.mjs",
    precompact: "hooks/precompact.mjs",
    sessionstart: "hooks/sessionstart.mjs",
    userpromptsubmit: "hooks/userpromptsubmit.mjs",
  },
  "gemini-cli": {
    beforetool: "hooks/gemini-cli/beforetool.mjs",
    aftertool: "hooks/gemini-cli/aftertool.mjs",
    precompress: "hooks/gemini-cli/precompress.mjs",
    sessionstart: "hooks/gemini-cli/sessionstart.mjs",
  },
  "vscode-copilot": {
    pretooluse: "hooks/vscode-copilot/pretooluse.mjs",
    posttooluse: "hooks/vscode-copilot/posttooluse.mjs",
    precompact: "hooks/vscode-copilot/precompact.mjs",
    sessionstart: "hooks/vscode-copilot/sessionstart.mjs",
  },
  "cursor": {
    pretooluse: "hooks/cursor/pretooluse.mjs",
    posttooluse: "hooks/cursor/posttooluse.mjs",
    sessionstart: "hooks/cursor/sessionstart.mjs",
  },
  "kiro": {
    pretooluse: "hooks/kiro/pretooluse.mjs",
    posttooluse: "hooks/kiro/posttooluse.mjs",
  },
};

async function hookDispatch(platform: string, event: string): Promise<void> {
  // Suppress stderr at OS fd level — native C++ modules (better-sqlite3) write
  // directly to fd 2 during initialization, bypassing Node.js process.stderr.
  // Platforms like Claude Code interpret ANY stderr output as hook failure.
  // Cross-platform: os.devNull → /dev/null (Unix) or \\.\NUL (Windows). See: #68
  try {
    closeSync(2);
    openSync(devNull, "w"); // Acquires fd 2 (lowest available)
  } catch {
    process.stderr.write = (() => true) as typeof process.stderr.write;
  }

  const scriptPath = HOOK_MAP[platform]?.[event];
  if (!scriptPath) {
    process.exit(1);
  }
  const pluginRoot = getPluginRoot();
  await import(pathToFileURL(join(pluginRoot, scriptPath)).href);
}

/* -------------------------------------------------------
 * Entry point
 * ------------------------------------------------------- */

const args = process.argv.slice(2);

if (args[0] === "doctor") {
  doctor().then((code) => process.exit(code));
} else if (args[0] === "upgrade") {
  upgrade();
} else if (args[0] === "hook") {
  hookDispatch(args[1], args[2]);
} else {
  // Default: start MCP server
  import("./server.js");
}

/* -------------------------------------------------------
 * Shared helpers
 * ------------------------------------------------------- */

/** Normalize Windows backslash paths to forward slashes for Bash (MSYS2) compatibility. */
export function toUnixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function getPluginRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // build/cli.js or src/cli.ts → go up one level; cli.bundle.mjs at project root → stay here
  if (__dirname.endsWith("/build") || __dirname.endsWith("\\build") ||
      __dirname.endsWith("/src") || __dirname.endsWith("\\src")) {
    return resolve(__dirname, "..");
  }
  return __dirname;
}

function getLocalVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(getPluginRoot(), "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function fetchLatestVersion(): Promise<string> {
  // Use node:https instead of global fetch to avoid a Windows libuv assertion
  // (UV_HANDLE_CLOSING) caused by undici's connection-pool background threads
  // racing with process.exit() teardown on Node.js v24+.
  return new Promise((resolve) => {
    const req = httpsRequest(
      "https://registry.npmjs.org/context-mode/latest",
      { headers: { Connection: "close" } },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => { raw += chunk; });
        res.on("end", () => {
          try {
            const data = JSON.parse(raw) as { version?: string };
            resolve(data.version ?? "unknown");
          } catch {
            resolve("unknown");
          }
        });
      },
    );
    req.on("error", () => resolve("unknown"));
    req.setTimeout(5000, () => { req.destroy(); resolve("unknown"); });
    req.end();
  });
}

/* -------------------------------------------------------
 * Doctor — adapter-aware diagnostics
 * ------------------------------------------------------- */

async function doctor(): Promise<number> {
  if (process.stdout.isTTY) console.clear();

  // Detect platform
  const detection = detectPlatform();
  const adapter = await getAdapter(detection.platform);

  p.intro(color.bgMagenta(color.white(" context-mode doctor ")));
  p.log.info(
    `Platform: ${color.cyan(adapter.name)}` +
      color.dim(` (${detection.confidence} confidence — ${detection.reason})`),
  );

  let criticalFails = 0;

  const s = p.spinner();
  s.start("Running diagnostics");

  let runtimes: ReturnType<typeof detectRuntimes>;
  let available: string[];
  try {
    runtimes = detectRuntimes();
    available = getAvailableLanguages(runtimes);
  } catch {
    s.stop("Diagnostics partial");
    p.log.warn(color.yellow("Could not detect runtimes") + color.dim(" — module may be missing, restart session after upgrade"));
    p.outro(color.yellow("Doctor could not fully run — try again after restarting"));
    return 1;
  }

  s.stop("Diagnostics complete");

  // Runtime check
  p.note(getRuntimeSummary(runtimes), "Runtimes");

  // Speed tier
  if (hasBunRuntime()) {
    p.log.success(
      color.green("Performance: FAST") +
        " — Bun detected for JS/TS execution",
    );
  } else {
    p.log.warn(
      color.yellow("Performance: NORMAL") +
        " — Using Node.js (install Bun for 3-5x speed boost)",
    );
  }

  // Language coverage
  const total = 11;
  const pct = ((available.length / total) * 100).toFixed(0);
  if (available.length < 2) {
    criticalFails++;
    p.log.error(
      color.red(`Language coverage: ${available.length}/${total} (${pct}%)`) +
        " — too few runtimes detected" +
        color.dim(` — ${available.join(", ") || "none"}`),
    );
  } else {
    p.log.info(
      `Language coverage: ${available.length}/${total} (${pct}%)` +
        color.dim(` — ${available.join(", ")}`),
    );
  }

  // Server test
  p.log.step("Testing server initialization...");
  try {
    const { PolyglotExecutor } = await import("./executor.js");
    const executor = new PolyglotExecutor({ runtimes });
    const result = await executor.execute({
      language: "javascript",
      code: 'console.log("ok");',
      timeout: 5000,
    });
    if (result.exitCode === 0 && result.stdout.trim() === "ok") {
      p.log.success(color.green("Server test: PASS"));
    } else {
      criticalFails++;
      const detail = result.stderr?.trim() ? ` (${result.stderr.trim().slice(0, 200)})` : "";
      p.log.error(
        color.red("Server test: FAIL") + ` — exit ${result.exitCode}${detail}`,
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Cannot find module") || message.includes("MODULE_NOT_FOUND")) {
      p.log.warn(color.yellow("Server test: SKIP") + color.dim(" — module not available (restart session after upgrade)"));
    } else {
      criticalFails++;
      p.log.error(color.red("Server test: FAIL") + ` — ${message}`);
    }
  }

  // Hooks — adapter-aware validation
  p.log.step(`Checking ${adapter.name} hooks configuration...`);
  const pluginRoot = getPluginRoot();
  const hookResults = adapter.validateHooks(pluginRoot);

  for (const result of hookResults) {
    if (result.status === "pass") {
      p.log.success(color.green(`${result.check}: PASS`) + ` — ${result.message}`);
    } else {
      p.log.error(
        color.red(`${result.check}: FAIL`) +
          ` — ${result.message}` +
          (result.fix ? color.dim(`\n  Run: ${result.fix}`) : ""),
      );
    }
  }

  // Hook script exists
  p.log.step("Checking hook script...");
  const hookScriptPath = resolve(pluginRoot, "hooks", "pretooluse.mjs");
  try {
    accessSync(hookScriptPath, constants.R_OK);
    p.log.success(color.green("Hook script exists: PASS") + color.dim(` — ${hookScriptPath}`));
  } catch {
    p.log.error(
      color.red("Hook script exists: FAIL") +
        color.dim(` — not found at ${hookScriptPath}`),
    );
  }

  // Plugin registration — adapter-aware
  p.log.step(`Checking ${adapter.name} plugin registration...`);
  const pluginCheck = adapter.checkPluginRegistration();
  if (pluginCheck.status === "pass") {
    p.log.success(color.green("Plugin enabled: PASS") + color.dim(` — ${pluginCheck.message}`));
  } else {
    p.log.warn(
      color.yellow("Plugin enabled: WARN") +
        ` — ${pluginCheck.message}`,
    );
  }

  // FTS5 / SQLite
  p.log.step("Checking FTS5 / SQLite...");
  try {
    const Database = (await import("./db-base.js")).loadDatabase();
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
    db.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
    const row = db.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content: string } | undefined;
    db.close();
    if (row && row.content === "hello world") {
      p.log.success(color.green("FTS5 / SQLite: PASS") + " — native module works");
    } else {
      criticalFails++;
      p.log.error(color.red("FTS5 / SQLite: FAIL") + " — query returned unexpected result");
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Cannot find module") || message.includes("MODULE_NOT_FOUND")) {
      p.log.warn(color.yellow("FTS5 / better-sqlite3: SKIP") + color.dim(" — module not available (restart session after upgrade)"));
    } else {
      criticalFails++;
      p.log.error(
        color.red("FTS5 / better-sqlite3: FAIL") +
          ` — ${message}` +
          color.dim("\n  Try: npm rebuild better-sqlite3"),
      );
    }
  }

  // Version check — adapter-aware
  p.log.step("Checking versions...");
  const localVersion = getLocalVersion();
  const latestVersion = await fetchLatestVersion();
  const installedVersion = adapter.getInstalledVersion();

  if (latestVersion === "unknown") {
    p.log.warn(
      color.yellow("npm (MCP): WARN") +
        ` — local v${localVersion}, could not reach npm registry`,
    );
  } else if (localVersion === latestVersion) {
    p.log.success(
      color.green("npm (MCP): PASS") +
        ` — v${localVersion}`,
    );
  } else {
    p.log.warn(
      color.yellow("npm (MCP): WARN") +
        ` — local v${localVersion}, latest v${latestVersion}` +
        color.dim("\n  Run: /context-mode:ctx-upgrade"),
    );
  }

  if (installedVersion === "not installed") {
    p.log.info(
      color.dim(`${adapter.name}: not installed`) +
        " — using standalone MCP mode",
    );
  } else if (latestVersion !== "unknown" && installedVersion === latestVersion) {
    p.log.success(
      color.green(`${adapter.name}: PASS`) +
        ` — v${installedVersion}`,
    );
  } else if (latestVersion !== "unknown") {
    p.log.warn(
      color.yellow(`${adapter.name}: WARN`) +
        ` — v${installedVersion}, latest v${latestVersion}` +
        color.dim("\n  Run: /context-mode:ctx-upgrade"),
    );
  } else {
    p.log.info(
      `${adapter.name}: v${installedVersion}` +
        color.dim(" — could not verify against npm registry"),
    );
  }

  // Summary
  if (criticalFails > 0) {
    p.outro(
      color.red(`Diagnostics failed — ${criticalFails} critical issue(s) found`),
    );
    return 1;
  }

  p.outro(
    available.length >= 4
      ? color.green("Diagnostics complete!")
      : color.yellow("Some checks need attention — see above for details"),
  );
  return 0;
}

/* -------------------------------------------------------
 * Upgrade — adapter-aware hook configuration
 * ------------------------------------------------------- */

async function upgrade() {
  if (process.stdout.isTTY) console.clear();

  // Detect platform
  const detection = detectPlatform();
  const adapter = await getAdapter(detection.platform);

  p.intro(color.bgCyan(color.black(" context-mode upgrade ")));
  p.log.info(
    `Platform: ${color.cyan(adapter.name)}` +
      color.dim(` (${detection.confidence} confidence)`),
  );

  let pluginRoot = getPluginRoot();
  const changes: string[] = [];
  const s = p.spinner();

  // Step 1: Pull latest from GitHub
  p.log.step("Pulling latest from GitHub...");
  const localVersion = getLocalVersion();
  const tmpDir = join(tmpdir(), `context-mode-upgrade-${Date.now()}`);

  s.start("Cloning mksglu/context-mode");
  try {
    execFileSync(
      "git", ["clone", "--depth", "1", "https://github.com/mksglu/context-mode.git", tmpDir],
      { stdio: "pipe", timeout: 30000 },
    );
    s.stop("Downloaded");

    const srcDir = tmpDir;
    const newPkg = JSON.parse(
      readFileSync(resolve(srcDir, "package.json"), "utf-8"),
    );
    const newVersion = newPkg.version ?? "unknown";

    if (newVersion === localVersion) {
      p.log.success(color.green("Already on latest") + ` — v${localVersion}`);
    } else {
      p.log.info(
        `Update available: ${color.yellow("v" + localVersion)} → ${color.green("v" + newVersion)}`,
      );
    }

    // Step 2: Install dependencies + build
    s.start("Installing dependencies & building");
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: srcDir,
      stdio: "pipe",
      timeout: 120000,
    });
    execFileSync("npm", ["run", "build"], {
      cwd: srcDir,
      stdio: "pipe",
      timeout: 60000,
    });
    s.stop("Built successfully");

    // Step 3: Update in-place
    s.start("Updating files in-place");

    // Old version dirs are cleaned lazily by sessionstart.mjs (age-gated >1h)
    // to avoid breaking active sessions that still reference them (#181).

    const items = [
      "build", "src", "hooks", "skills", "scripts", ".claude-plugin",
      "start.mjs", "server.bundle.mjs", "cli.bundle.mjs", "package.json",
    ];
    for (const item of items) {
      try {
        rmSync(resolve(pluginRoot, item), { recursive: true, force: true });
        cpSync(resolve(srcDir, item), resolve(pluginRoot, item), { recursive: true });
      } catch { /* some files may not exist in source */ }
    }

    // Write .mcp.json with resolved absolute path (fixes #132)
    const mcpConfig = {
      mcpServers: {
        "context-mode": {
          command: "node",
          args: [resolve(pluginRoot, "start.mjs")],
        },
      },
    };
    writeFileSync(
      resolve(pluginRoot, ".mcp.json"),
      JSON.stringify(mcpConfig, null, 2) + "\n",
    );

    s.stop(color.green(`Updated in-place to v${newVersion}`));

    // Fix registry — adapter-aware
    adapter.updatePluginRegistry(pluginRoot, newVersion);
    p.log.info(color.dim("  Registry synced to " + pluginRoot));

    // Install production deps
    s.start("Installing production dependencies");
    execFileSync("npm", ["install", "--production", "--no-audit", "--no-fund"], {
      cwd: pluginRoot,
      stdio: "pipe",
      timeout: 60000,
    });
    s.stop("Dependencies ready");

    // Rebuild native addons for current Node.js ABI (fixes #131)
    s.start("Rebuilding native addons");
    try {
      execFileSync("npm", ["rebuild", "better-sqlite3"], {
        cwd: pluginRoot,
        stdio: "pipe",
        timeout: 60000,
      });
      s.stop(color.green("Native addons rebuilt"));
      changes.push("Rebuilt better-sqlite3 for current Node.js");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      s.stop(color.yellow("Native addon rebuild warning"));
      p.log.warn(
        color.yellow("better-sqlite3 rebuild issue") +
          ` — ${message}` +
          color.dim(`\n  Try manually: cd "${pluginRoot}" && npm rebuild better-sqlite3`),
      );
    }

    // Update global npm
    s.start("Updating npm global package");
    try {
      execFileSync("npm", ["install", "-g", pluginRoot, "--no-audit", "--no-fund"], {
        stdio: "pipe",
        timeout: 30000,
      });
      s.stop(color.green("npm global updated"));
      changes.push("Updated npm global package");
    } catch {
      s.stop(color.yellow("npm global update skipped"));
      p.log.info(color.dim("  Could not update global npm — may need sudo or standalone install"));
    }

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });

    changes.push(
      newVersion !== localVersion
        ? `Updated v${localVersion} → v${newVersion}`
        : `Reinstalled v${localVersion} from GitHub`,
    );
    p.log.success(
      color.green("Plugin reinstalled from GitHub!") +
        color.dim(` — v${newVersion}`),
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop(color.red("Update failed"));
    p.log.error(color.red("GitHub pull failed") + ` — ${message}`);
    p.log.info(color.dim("Continuing with hooks/settings fix..."));
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Step 3: Backup settings — adapter-aware
  p.log.step(`Backing up ${adapter.name} settings...`);
  const backupPath = adapter.backupSettings();
  if (backupPath) {
    p.log.success(color.green("Backup created") + color.dim(" -> " + backupPath));
    changes.push("Backed up settings");
  } else {
    p.log.warn(
      color.yellow("No existing settings to backup") +
        " — a new one will be created",
    );
  }

  // Step 4: Configure hooks — adapter-aware
  p.log.step(`Configuring ${adapter.name} hooks...`);
  const hookChanges = adapter.configureAllHooks(pluginRoot);
  for (const change of hookChanges) {
    p.log.info(color.dim(`  ${change}`));
    changes.push(change);
  }
  p.log.success(color.green("Hooks configured") + color.dim(` — ${adapter.name}`));

  // Step 5: Set hook script permissions — adapter-aware
  p.log.step("Setting hook script permissions...");
  const permSet = adapter.setHookPermissions(pluginRoot);
  // Also ensure CLI binaries are executable (tsc doesn't set +x)
  // chmod is POSIX-only — skip on Windows where execute bits are irrelevant
  if (process.platform !== "win32") {
    for (const bin of ["build/cli.js", "cli.bundle.mjs"]) {
      const binPath = resolve(pluginRoot, bin);
      try {
        accessSync(binPath, constants.F_OK);
        chmodSync(binPath, 0o755);
        permSet.push(binPath);
      } catch { /* not found — skip */ }
    }
  }
  if (permSet.length > 0) {
    p.log.success(color.green("Permissions set") + color.dim(` — ${permSet.length} hook script(s)`));
    changes.push(`Set ${permSet.length} hook scripts as executable`);
  } else {
    p.log.error(
      color.red("No hook scripts found") +
        color.dim(" — expected in " + resolve(pluginRoot, "hooks")),
    );
  }

  // Step 6: Report
  if (changes.length > 0) {
    p.note(
      changes.map((c) => color.green("  + ") + c).join("\n"),
      "Changes Applied",
    );
  } else {
    p.log.info(color.dim("No changes were needed."));
  }

  // Step 7: Run doctor
  p.log.step("Running doctor to verify...");
  console.log();

  try {
    const cliBundlePath = resolve(pluginRoot, "cli.bundle.mjs");
    const cliBuildPath = resolve(pluginRoot, "build", "cli.js");
    const cliPath = existsSync(cliBundlePath) ? cliBundlePath : cliBuildPath;
    execFileSync("node", [cliPath, "doctor"], {
      stdio: "inherit",
      timeout: 30000,
      cwd: pluginRoot,
    });
  } catch {
    p.log.warn(
      color.yellow("Doctor had warnings") +
        color.dim(` — restart your ${adapter.name} session to pick up the new version`),
    );
  }
}
