#!/usr/bin/env node
/**
 * context-mode CLI
 *
 * Usage:
 *   context-mode          → Start MCP server (stdio)
 *   context-mode setup    → Interactive setup (detect runtimes, install Bun)
 *   context-mode doctor   → Diagnose runtime issues, hooks, FTS5, version
 *   context-mode upgrade  → Fix hooks, permissions, and settings
 *   context-mode stats    → (skill only — /context-mode:stats)
 */

import * as p from "@clack/prompts";
import color from "picocolors";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, chmodSync, accessSync, readdirSync, constants } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  detectRuntimes,
  getRuntimeSummary,
  hasBunRuntime,
  getAvailableLanguages,
} from "./runtime.js";

const args = process.argv.slice(2);

if (args[0] === "setup") {
  setup();
} else if (args[0] === "doctor") {
  doctor().then((code) => process.exit(code));
} else if (args[0] === "upgrade") {
  upgrade();
} else {
  // Default: start MCP server
  import("./server.js");
}

/* -------------------------------------------------------
 * Shared helpers
 * ------------------------------------------------------- */

function getPluginRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return resolve(__dirname, "..");
}

function getSettingsPath(): string {
  return resolve(homedir(), ".claude", "settings.json");
}

function readSettings(): Record<string, unknown> | null {
  try {
    const raw = readFileSync(getSettingsPath(), "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getHookScriptPath(): string {
  return resolve(getPluginRoot(), "hooks", "pretooluse.sh");
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
  try {
    const resp = await fetch("https://registry.npmjs.org/context-mode/latest");
    if (!resp.ok) return "unknown";
    const data = (await resp.json()) as { version?: string };
    return data.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function getMarketplaceVersion(): string {
  // Detect from our own path: .../plugins/cache/<marketplace>/<plugin>/<version>/
  const root = getPluginRoot();
  const match = root.match(/plugins\/cache\/[^/]+\/[^/]+\/(\d+\.\d+\.\d+[^/]*)/);
  if (match) return match[1];

  // Fallback: scan common plugin cache locations
  const bases = [
    resolve(homedir(), ".claude"),
    resolve(homedir(), ".config", "claude"),
  ];
  for (const base of bases) {
    const cacheDir = resolve(base, "plugins", "cache", "claude-context-mode", "context-mode");
    try {
      const entries = readdirSync(cacheDir);
      const versions = entries
        .filter((e) => /^\d+\.\d+\.\d+/.test(e))
        .sort((a, b) => {
          const pa = a.split(".").map(Number);
          const pb = b.split(".").map(Number);
          for (let i = 0; i < 3; i++) {
            if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
          }
          return 0;
        });
      if (versions.length > 0) return versions[versions.length - 1];
    } catch { /* continue */ }
  }
  return "not installed";
}

function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

/* -------------------------------------------------------
 * Doctor
 * ------------------------------------------------------- */

async function doctor(): Promise<number> {
  if (process.stdout.isTTY) console.clear();

  p.intro(color.bgMagenta(color.white(" context-mode doctor ")));

  let criticalFails = 0;

  const s = p.spinner();
  s.start("Running diagnostics");

  const runtimes = detectRuntimes();
  const available = getAvailableLanguages(runtimes);

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
      p.log.error(
        color.red("Server test: FAIL") + ` — exit ${result.exitCode}`,
      );
    }
  } catch (err: unknown) {
    criticalFails++;
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(color.red("Server test: FAIL") + ` — ${message}`);
  }

  // Hooks installed
  p.log.step("Checking hooks configuration...");
  const settings = readSettings();
  const hookScriptPath = getHookScriptPath();

  if (settings) {
    const hooks = settings.hooks as Record<string, unknown[]> | undefined;
    const preToolUse = hooks?.PreToolUse as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> | undefined;

    if (preToolUse && preToolUse.length > 0) {
      const hasCorrectHook = preToolUse.some((entry) =>
        entry.hooks?.some((h) => h.command?.includes("pretooluse.sh")),
      );
      if (hasCorrectHook) {
        p.log.success(color.green("Hooks installed: PASS") + " — PreToolUse hook configured");
      } else {
        p.log.error(
          color.red("Hooks installed: FAIL") +
            " — PreToolUse exists but does not point to pretooluse.sh" +
            color.dim("\n  Run: npx context-mode upgrade"),
        );
      }
    } else {
      p.log.error(
        color.red("Hooks installed: FAIL") +
          " — No PreToolUse hooks found" +
          color.dim("\n  Run: npx context-mode upgrade"),
      );
    }
  } else {
    p.log.error(
      color.red("Hooks installed: FAIL") +
        " — Could not read ~/.claude/settings.json" +
        color.dim("\n  Run: npx context-mode upgrade"),
    );
  }

  // Hook script exists
  p.log.step("Checking hook script...");
  try {
    accessSync(hookScriptPath, constants.R_OK);
    p.log.success(color.green("Hook script exists: PASS") + color.dim(` — ${hookScriptPath}`));
  } catch {
    p.log.error(
      color.red("Hook script exists: FAIL") +
        color.dim(` — not found at ${hookScriptPath}`),
    );
  }

  // Plugin enabled
  p.log.step("Checking plugin registration...");
  if (settings) {
    const enabledPlugins = settings.enabledPlugins as Record<string, boolean> | undefined;
    if (enabledPlugins) {
      const pluginKey = Object.keys(enabledPlugins).find((k) =>
        k.startsWith("context-mode"),
      );
      if (pluginKey && enabledPlugins[pluginKey]) {
        p.log.success(color.green("Plugin enabled: PASS") + color.dim(` — ${pluginKey}`));
      } else {
        p.log.warn(
          color.yellow("Plugin enabled: WARN") +
            " — context-mode not in enabledPlugins" +
            color.dim(" (might be using standalone MCP mode)"),
        );
      }
    } else {
      p.log.warn(
        color.yellow("Plugin enabled: WARN") +
          " — no enabledPlugins section found" +
          color.dim(" (might be using standalone MCP mode)"),
      );
    }
  } else {
    p.log.warn(
      color.yellow("Plugin enabled: WARN") +
        " — could not read settings.json",
    );
  }

  // FTS5 / better-sqlite3
  p.log.step("Checking FTS5 / better-sqlite3...");
  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
    db.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
    const row = db.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content: string } | undefined;
    db.close();
    if (row && row.content === "hello world") {
      p.log.success(color.green("FTS5 / better-sqlite3: PASS") + " — native module works");
    } else {
      criticalFails++;
      p.log.error(color.red("FTS5 / better-sqlite3: FAIL") + " — query returned unexpected result");
    }
  } catch (err: unknown) {
    criticalFails++;
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(
      color.red("FTS5 / better-sqlite3: FAIL") +
        ` — ${message}` +
        color.dim("\n  Try: npm rebuild better-sqlite3"),
    );
  }

  // Version check
  p.log.step("Checking versions...");
  const localVersion = getLocalVersion();
  const latestVersion = await fetchLatestVersion();
  const marketplaceVersion = getMarketplaceVersion();

  // npm / MCP version
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
        color.dim("\n  Run: npm install -g context-mode@latest"),
    );
  }

  // Marketplace version
  if (marketplaceVersion === "not installed") {
    p.log.info(
      color.dim("Marketplace: not installed") +
        " — using standalone MCP mode",
    );
  } else if (latestVersion !== "unknown" && marketplaceVersion === latestVersion) {
    p.log.success(
      color.green("Marketplace: PASS") +
        ` — v${marketplaceVersion}`,
    );
  } else if (latestVersion !== "unknown") {
    p.log.warn(
      color.yellow("Marketplace: WARN") +
        ` — v${marketplaceVersion}, latest v${latestVersion}` +
        color.dim("\n  Update via Claude Code marketplace or reinstall plugin"),
    );
  } else {
    p.log.info(
      `Marketplace: v${marketplaceVersion}` +
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
 * Upgrade
 * ------------------------------------------------------- */

async function upgrade() {
  if (process.stdout.isTTY) console.clear();

  p.intro(color.bgCyan(color.black(" context-mode upgrade ")));

  let pluginRoot = getPluginRoot();
  const settingsPath = getSettingsPath();
  const changes: string[] = [];
  const s = p.spinner();

  // Step 1: Pull latest from GitHub (same source as marketplace)
  p.log.step("Pulling latest from GitHub...");
  const localVersion = getLocalVersion();
  const tmpDir = `/tmp/context-mode-upgrade-${Date.now()}`;

  s.start("Cloning mksglu/claude-context-mode");
  try {
    execSync(
      `git clone --depth 1 https://github.com/mksglu/claude-context-mode.git "${tmpDir}"`,
      { stdio: "pipe", timeout: 30000 },
    );
    s.stop("Downloaded");

    const srcDir = tmpDir;

    // Read new version
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
    execSync("npm install --no-audit --no-fund 2>/dev/null", {
      cwd: srcDir,
      stdio: "pipe",
      timeout: 60000,
    });
    execSync("npm run build 2>/dev/null", {
      cwd: srcDir,
      stdio: "pipe",
      timeout: 30000,
    });
    s.stop("Built successfully");

    // Step 3: Copy to plugin root
    s.start("Installing files");
    const items = [
      "build", "hooks", "skills", ".claude-plugin",
      "start.sh", "server.bundle.mjs", "package.json", ".mcp.json",
    ];
    for (const item of items) {
      try {
        execSync(`rm -rf "${pluginRoot}/${item}"`, { stdio: "pipe" });
        execSync(`cp -r "${srcDir}/${item}" "${pluginRoot}/"`, { stdio: "pipe" });
      } catch { /* some files may not exist */ }
    }
    s.stop(color.green("Files installed"));

    // Install production deps in plugin root
    s.start("Installing production dependencies");
    execSync("npm install --production --no-audit --no-fund 2>/dev/null", {
      cwd: pluginRoot,
      stdio: "pipe",
      timeout: 60000,
    });
    s.stop("Dependencies ready");

    // Step 2.5: Migrate versioned cache directory if version changed
    const cacheMatch = pluginRoot.match(
      /^(.*\/plugins\/cache\/[^/]+\/[^/]+\/)(\d+\.\d+\.\d+[^/]*)$/,
    );
    if (cacheMatch && newVersion !== cacheMatch[2] && newVersion !== "unknown") {
      const oldDirVersion = cacheMatch[2];
      const newCacheDir = cacheMatch[1] + newVersion;
      s.start(`Migrating cache: ${oldDirVersion} → ${newVersion}`);
      try {
        execSync(`rm -rf "${newCacheDir}"`, { stdio: "pipe" });
        execSync(`mv "${pluginRoot}" "${newCacheDir}"`, { stdio: "pipe" });
        pluginRoot = newCacheDir;
        s.stop(color.green(`Cache directory: ${newVersion}`));
        changes.push(`Migrated cache: ${oldDirVersion} → ${newVersion}`);
      } catch {
        s.stop(color.yellow("Cache migration skipped — using existing directory"));
      }
    }

    // Update global npm package from same GitHub source
    s.start("Updating npm global package");
    try {
      execSync(`npm install -g "${pluginRoot}" --no-audit --no-fund 2>/dev/null`, {
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
    execSync(`rm -rf "${tmpDir}"`, { stdio: "pipe" });

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
    // Cleanup on failure
    try { execSync(`rm -rf "${tmpDir}"`, { stdio: "pipe" }); } catch { /* ignore */ }
  }

  // Step 3: Backup settings.json
  p.log.step("Backing up settings.json...");
  try {
    accessSync(settingsPath, constants.R_OK);
    const backupPath = settingsPath + ".bak";
    copyFileSync(settingsPath, backupPath);
    p.log.success(color.green("Backup created") + color.dim(" -> " + backupPath));
    changes.push("Backed up settings.json");
  } catch {
    p.log.warn(
      color.yellow("No existing settings.json to backup") +
        " — a new one will be created",
    );
  }

  // Step 4: Fix hooks
  p.log.step("Configuring PreToolUse hooks...");
  const hookScriptPath = resolve(pluginRoot, "hooks", "pretooluse.sh");
  const settings = readSettings() ?? {};

  const desiredHookEntry = {
    matcher: "Bash|Read|Grep|Glob|WebFetch|WebSearch|Task",
    hooks: [
      {
        type: "command",
        command: "bash " + hookScriptPath,
      },
    ],
  };

  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const existingPreToolUse = hooks.PreToolUse as Array<Record<string, unknown>> | undefined;

  if (existingPreToolUse && Array.isArray(existingPreToolUse)) {
    const existingIdx = existingPreToolUse.findIndex((entry) => {
      const entryHooks = entry.hooks as Array<{ command?: string }> | undefined;
      return entryHooks?.some((h) => h.command?.includes("pretooluse.sh"));
    });

    if (existingIdx >= 0) {
      existingPreToolUse[existingIdx] = desiredHookEntry;
      p.log.info(color.dim("Updated existing PreToolUse hook entry"));
      changes.push("Updated existing PreToolUse hook entry");
    } else {
      existingPreToolUse.push(desiredHookEntry);
      p.log.info(color.dim("Added PreToolUse hook entry"));
      changes.push("Added PreToolUse hook entry to existing hooks");
    }
    hooks.PreToolUse = existingPreToolUse;
  } else {
    hooks.PreToolUse = [desiredHookEntry];
    p.log.info(color.dim("Created PreToolUse hooks section"));
    changes.push("Created PreToolUse hooks section");
  }

  settings.hooks = hooks;

  // Write updated settings
  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    p.log.success(color.green("Hooks configured") + color.dim(" -> " + settingsPath));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(color.red("Failed to write settings.json") + " — " + message);
    p.outro(color.red("Upgrade failed."));
    process.exit(1);
  }

  // Step 5: Set hook script permissions
  p.log.step("Setting hook script permissions...");
  try {
    accessSync(hookScriptPath, constants.R_OK);
    chmodSync(hookScriptPath, 0o755);
    p.log.success(color.green("Permissions set") + color.dim(" — chmod +x " + hookScriptPath));
    changes.push("Set pretooluse.sh as executable");
  } catch {
    p.log.error(
      color.red("Hook script not found") +
        color.dim(" — expected at " + hookScriptPath),
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

  const doctorCode = await doctor();
  if (doctorCode !== 0) {
    process.exit(doctorCode);
  }
}

/* -------------------------------------------------------
 * Setup
 * ------------------------------------------------------- */

async function setup() {
  if (process.stdout.isTTY) console.clear();

  p.intro(color.bgCyan(color.black(" context-mode setup ")));

  const s = p.spinner();

  // Step 1: Detect runtimes
  s.start("Detecting installed runtimes");
  const runtimes = detectRuntimes();
  const available = getAvailableLanguages(runtimes);
  s.stop("Detected " + available.length + " languages");

  // Show what's available
  p.note(getRuntimeSummary(runtimes), "Detected Runtimes");

  // Step 2: Check Bun
  if (!hasBunRuntime()) {
    p.log.warn(
      color.yellow("Bun is not installed.") +
        " JS/TS will run with Node.js (3-5x slower).",
    );

    const installBun = await p.confirm({
      message: "Would you like to install Bun for faster execution?",
      initialValue: true,
    });

    if (p.isCancel(installBun)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    if (installBun) {
      s.start("Installing Bun");
      try {
        execSync("curl -fsSL https://bun.sh/install | bash", {
          stdio: "pipe",
          timeout: 60000,
        });
        s.stop(color.green("Bun installed successfully!"));

        // Re-detect runtimes
        const newRuntimes = detectRuntimes();
        if (hasBunRuntime()) {
          p.log.success(
            "JavaScript and TypeScript will now use Bun " +
              color.dim("(3-5x faster)"),
          );
        }
        p.note(getRuntimeSummary(newRuntimes), "Updated Runtimes");
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err);
        s.stop(color.red("Failed to install Bun"));
        p.log.error(
          "Installation failed: " +
            message +
            "\nYou can install manually: curl -fsSL https://bun.sh/install | bash",
        );
        p.log.info(
          color.dim("Continuing with Node.js — everything will still work."),
        );
      }
    } else {
      p.log.info(
        color.dim(
          "No problem! Using Node.js. You can install Bun later: curl -fsSL https://bun.sh/install | bash",
        ),
      );
    }
  } else {
    p.log.success(
      color.green("Bun detected!") +
        " JS/TS will run at maximum speed.",
    );
  }

  // Step 3: Check optional runtimes
  const missing: string[] = [];
  if (!runtimes.python) missing.push("Python (python3)");
  if (!runtimes.ruby) missing.push("Ruby (ruby)");
  if (!runtimes.go) missing.push("Go (go)");
  if (!runtimes.php) missing.push("PHP (php)");
  if (!runtimes.r) missing.push("R (Rscript)");

  if (missing.length > 0) {
    p.log.info(
      color.dim("Optional runtimes not found: " + missing.join(", ")),
    );
    p.log.info(
      color.dim(
        "Install them to enable additional language support in context-mode.",
      ),
    );
  }

  // Step 4: Installation instructions
  const installMethod = await p.select({
    message: "How would you like to configure context-mode?",
    options: [
      {
        value: "claude-code",
        label: "Claude Code (recommended)",
        hint: "claude mcp add",
      },
      {
        value: "manual",
        label: "Show manual configuration",
        hint: ".mcp.json",
      },
      { value: "skip", label: "Skip — I'll configure later" },
    ],
  });

  if (p.isCancel(installMethod)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const serverPath = new URL("./server.js", import.meta.url).pathname;

  if (installMethod === "claude-code") {
    s.start("Adding to Claude Code");
    try {
      execSync(
        `claude mcp add context-mode -- node ${serverPath}`,
        { stdio: "pipe", timeout: 10000 },
      );
      s.stop(color.green("Added to Claude Code!"));
    } catch {
      s.stop(color.yellow("Could not add automatically"));
      p.log.info(
        "Run manually:\n" +
          color.cyan(`  claude mcp add context-mode -- node ${serverPath}`),
      );
    }
  } else if (installMethod === "manual") {
    p.note(
      JSON.stringify(
        {
          mcpServers: {
            "context-mode": {
              command: "node",
              args: [serverPath],
            },
          },
        },
        null,
        2,
      ),
      "Add to your .mcp.json or Claude Code settings",
    );
  }

  p.outro(
    color.green("Setup complete!") +
      " " +
      color.dim(available.length + " languages ready."),
  );
}


