#!/usr/bin/env node
/**
 * context-mode-install - Installer for multiple LLM CLI platforms
 * 
 * Usage:
 *   npx context-mode-install
 *   npx context-mode-install --claude --global
 *   npx context-mode-install --gemini --local
 *   npx context-mode-install --opencode --all
 *   npx context-mode-install --codex
 *   npx context-mode-install --vscode
 */

import { execSync } from "node:child_process";
import { mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir, homedir } from "node:os";

const args = process.argv.slice(2);

type Runtime = "claude" | "gemini" | "opencode" | "codex" | "vscode";
type Location = "global" | "local";

interface InstallOptions {
  runtimes: Runtime[];
  location?: Location;
  account?: string;
  marketplace?: string;
  help?: boolean;
  all?: boolean;
}

const RUNTIME_CONFIGS: Record<Runtime, { configDir: string; name: string }> = {
  "claude": { configDir: ".claude", name: "Claude Code" },
  "gemini": { configDir: ".gemini", name: "Gemini CLI" },
  "opencode": { configDir: ".config/opencode", name: "OpenCode" },
  "codex": { configDir: ".codex", name: "Codex" },
  "vscode": { configDir: ".vscode/copilot", name: "VS Code Copilot" },
};

function parseArgs(args: string[]): InstallOptions {
  const result: InstallOptions = { runtimes: [] };
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--claude" || args[i] === "-c") {
      result.runtimes.push("claude");
    } else if (args[i] === "--gemini" || args[i] === "-g") {
      result.runtimes.push("gemini");
    } else if (args[i] === "--opencode" || args[i] === "-o") {
      result.runtimes.push("opencode");
    } else if (args[i] === "--codex" || args[i] === "-x") {
      result.runtimes.push("codex");
    } else if (args[i] === "--vscode" || args[i] === "-v") {
      result.runtimes.push("vscode");
    } else if (args[i] === "--all" || args[i] === "-a") {
      result.all = true;
    } else if (args[i] === "--global") {
      result.location = "global";
    } else if (args[i] === "--local") {
      result.location = "local";
    } else if (args[i] === "--account" || args[i] === "-A") {
      result.account = args[++i];
    } else if (args[i] === "--marketplace" || args[i] === "-m") {
      result.marketplace = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      result.help = true;
    }
  }
  
  // Default to claude if no runtime specified
  if (result.runtimes.length === 0 && !result.all) {
    result.runtimes = ["claude"];
  }
  
  // Expand --all to all runtimes
  if (result.all) {
    result.runtimes = ["claude", "gemini", "opencode", "codex", "vscode"];
  }
  
  return result;
}

function getInstallPath(runtime: Runtime, location: Location, customAccount?: string): string {
  if (customAccount) {
    return resolve(customAccount);
  }
  
  const config = RUNTIME_CONFIGS[runtime];
  
  if (location === "local") {
    return resolve(process.cwd(), config.configDir);
  }
  
  return join(homedir(), config.configDir);
}

function installToRuntime(runtime: Runtime, marketplace: string, claudeAccount: string): boolean {
  const marketplaceName = marketplace.split("/")[1] || "context-mode";
  const config = RUNTIME_CONFIGS[runtime];
  
  console.log(`\n=== Installing to ${config.name} ===`);
  console.log(`Location: ${claudeAccount}`);
  
  // Create directories
  const pluginCacheDir = join(claudeAccount, "plugins", "cache", marketplaceName);
  const pluginMarketplaceDir = join(claudeAccount, "plugins", "marketplaces");
  mkdirSync(pluginCacheDir, { recursive: true });
  mkdirSync(pluginMarketplaceDir, { recursive: true });
  
  // Clone via HTTPS
  const tempDir = join(tmpdir(), `context-mode-install-${Date.now()}-${runtime}`);
  const repoUrl = `https://github.com/${marketplace}.git`;
  
  console.log("1. Cloning repository...");
  try {
    execSync(`git clone --depth 1 ${repoUrl} "${tempDir}"`, { stdio: "pipe" });
  } catch (e: any) {
    console.error(`   Failed to clone: ${e.message}`);
    return false;
  }
  
  // Get version
  let version = "unknown";
  const pluginJsonPath = join(tempDir, ".claude-plugin", "plugin.json");
  if (existsSync(pluginJsonPath)) {
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
    version = pluginJson.version || "unknown";
  }
  
  console.log(`2. Version: ${version}`);
  
  // Copy to cache
  const cacheVersionDir = join(pluginCacheDir, marketplaceName, version);
  if (existsSync(cacheVersionDir)) {
    console.log("3. Removing old version...");
    rmSync(cacheVersionDir, { recursive: true, force: true });
  }
  
  console.log("4. Copying to cache...");
  mkdirSync(join(pluginCacheDir, marketplaceName), { recursive: true });
  cpSync(tempDir, cacheVersionDir, { recursive: true });
  
  // Install dependencies
  const packageJsonPath = join(cacheVersionDir, "package.json");
  if (existsSync(packageJsonPath)) {
    console.log("5. Installing dependencies...");
    try {
      execSync("npm install --no-audit --no-fund", { cwd: cacheVersionDir, stdio: "pipe" });
      
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      if (packageJson.scripts?.build) {
        console.log("   Building plugin...");
        execSync("npm run build", { cwd: cacheVersionDir, stdio: "pipe" });
      }
    } catch (e: any) {
      console.warn("   Warning: Build/install failed, plugin may not work correctly");
    }
  }
  
  // Get plugin name
  let pluginName = marketplaceName;
  if (existsSync(pluginJsonPath)) {
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
    pluginName = pluginJson.name || marketplaceName;
  }
  
  // Update installed_plugins.json
  const installedPluginsFile = join(claudeAccount, "plugins", "installed_plugins.json");
  const installTime = new Date().toISOString();
  
  console.log("6. Registering plugin...");
  let installedPlugins: any = { version: 2, plugins: {} };
  if (existsSync(installedPluginsFile)) {
    installedPlugins = JSON.parse(readFileSync(installedPluginsFile, "utf-8"));
  }
  
  if (!installedPlugins.plugins) {
    installedPlugins.plugins = {};
  }
  
  const pluginKey = `${pluginName}@${marketplaceName}`;
  if (!installedPlugins.plugins[pluginKey]) {
    installedPlugins.plugins[pluginKey] = [];
  }
  
  installedPlugins.plugins[pluginKey].push({
    scope: "user",
    installPath: cacheVersionDir,
    version: version,
    installedAt: installTime
  });
  
  writeFileSync(installedPluginsFile, JSON.stringify(installedPlugins, null, 2));
  
  // Update known_marketplaces.json
  const knownMarketplacesFile = join(claudeAccount, "plugins", "known_marketplaces.json");
  const knownMarketplaces = existsSync(knownMarketplacesFile)
    ? JSON.parse(readFileSync(knownMarketplacesFile, "utf-8"))
    : {};
  
  knownMarketplaces[marketplaceName] = {
    source: {
      source: "git",
      url: repoUrl
    },
    installLocation: join(pluginMarketplaceDir, marketplaceName),
    lastUpdated: installTime
  };
  writeFileSync(knownMarketplacesFile, JSON.stringify(knownMarketplaces, null, 2));
  
  // Enable plugin in settings (runtime-specific)
  let settingsFile = join(claudeAccount, ".claude.json");
  
  // Try runtime-specific settings files
  if (runtime === "opencode" && !existsSync(settingsFile)) {
    settingsFile = join(claudeAccount, "opencode.json");
  } else if (runtime === "gemini" && !existsSync(settingsFile)) {
    settingsFile = join(claudeAccount, ".gemini.json");
  } else if (runtime === "codex" && !existsSync(settingsFile)) {
    settingsFile = join(claudeAccount, ".codex.json");
  }
  
  if (existsSync(settingsFile)) {
    console.log("7. Enabling plugin in settings...");
    const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
    settings.enabledPlugins = settings.enabledPlugins || {};
    settings.enabledPlugins[pluginKey] = true;
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  }
  
  // Cleanup
  rmSync(tempDir, { recursive: true, force: true });
  
  console.log(`\n✓ Installed to ${config.name}`);
  return true;
}

function main() {
  const opts = parseArgs(args);
  
  if (opts.help) {
    console.log(`
context-mode-install - Installer for multiple LLM CLI platforms

Usage:
  npx context-mode-install [options]

Runtimes:
  -c, --claude      Install to Claude Code
  -g, --gemini      Install to Gemini CLI
  -o, --opencode    Install to OpenCode
  -x, --codex       Install to Codex
  -v, --vscode      Install to VS Code Copilot
  -a, --all         Install to all supported runtimes

Location:
  --global          Install globally (default)
  --local           Install locally (current project)
  -A, --account     Custom account directory

Other:
  -m, --marketplace Marketplace to install (default: mksglu/context-mode)
  -h, --help        Show this help message

Examples:
  npx context-mode-install                      # Interactive, Claude Code global
  npx context-mode-install --claude --global    # Claude Code global
  npx context-mode-install --gemini --local     # Gemini CLI local
  npx context-mode-install --all --global       # All runtimes global
  npx context-mode-install -c -g -o -A ~/.custom
`.trim());
    process.exit(0);
  }
  
  const marketplace = opts.marketplace || "mksglu/context-mode";
  const location = opts.location || "global";
  
  console.log("=== context-mode-install ===");
  console.log(`Marketplace: ${marketplace}`);
  console.log(`Runtimes: ${opts.runtimes.map(r => RUNTIME_CONFIGS[r].name).join(", ")}`);
  console.log(`Location: ${location}`);
  
  let successCount = 0;
  
  for (const runtime of opts.runtimes) {
    const installPath = getInstallPath(runtime, location, opts.account);
    
    try {
      if (installToRuntime(runtime, marketplace, installPath)) {
        successCount++;
      }
    } catch (e: any) {
      console.error(`Failed to install to ${RUNTIME_CONFIGS[runtime].name}: ${e.message}`);
    }
  }
  
  console.log("\n=== Installation Complete ===");
  console.log(`Successfully installed to ${successCount}/${opts.runtimes.length} runtime(s)`);
  console.log("\nRestart your CLI to activate the plugin.");
}

main();
