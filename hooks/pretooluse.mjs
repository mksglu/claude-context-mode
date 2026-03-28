#!/usr/bin/env node
import "./suppress-stderr.mjs";
/**
 * Unified PreToolUse hook for context-mode (Claude Code)
 * Redirects data-fetching tools to context-mode MCP tools
 *
 * Cross-platform (Windows/macOS/Linux) — no bash/jq dependency.
 *
 * Routing is delegated to core/routing.mjs (shared across platforms).
 * This file retains the Claude Code-specific self-heal block and
 * uses core/formatters.mjs for Claude Code output format.
 */

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { readStdin } from "./core/stdin.mjs";
import { routePreToolUse, initSecurity } from "./core/routing.mjs";
import { formatDecision } from "./core/formatters.mjs";

// ─── Manual recursive copy (avoids cpSync libuv crash on non-ASCII paths, Windows + Node 24) ───
function copyDirSync(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = resolve(src, entry.name);
    const destPath = resolve(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, destPath);
    else copyFileSync(srcPath, destPath);
  }
}

// ─── Self-heal: rename dir to correct version, fix registry + hooks ───
try {
  const hookDir = dirname(fileURLToPath(import.meta.url));
  const myRoot = resolve(hookDir, "..");
  const myPkg = JSON.parse(readFileSync(resolve(myRoot, "package.json"), "utf-8"));
  const myVersion = myPkg.version ?? "unknown";
  const myDirName = basename(myRoot);
  const cacheParent = dirname(myRoot);
  const marker = resolve(tmpdir(), `context-mode-healed-${myVersion}`);

  // Only self-heal inside plugin cache dirs — skip in dev/CI environments
  const isInPluginCache = myRoot.includes("/plugins/cache/") || myRoot.includes("\\plugins\\cache\\");
  if (myVersion !== "unknown" && isInPluginCache && !existsSync(marker)) {
    // 1. If dir name doesn't match version (e.g. "0.7.0" but code is "0.9.12"),
    //    create correct dir, copy files, update registry + hooks
    const correctDir = resolve(cacheParent, myVersion);
    if (myDirName !== myVersion && !existsSync(correctDir)) {
      copyDirSync(myRoot, correctDir);

      // Create start.mjs in new dir if missing
      const startMjs = resolve(correctDir, "start.mjs");
      if (!existsSync(startMjs)) {
        writeFileSync(startMjs, [
          '#!/usr/bin/env node',
          'import { existsSync } from "node:fs";',
          'import { dirname, resolve } from "node:path";',
          'import { fileURLToPath } from "node:url";',
          'const __dirname = dirname(fileURLToPath(import.meta.url));',
          'process.chdir(__dirname);',
          'if (!process.env.CLAUDE_PROJECT_DIR) process.env.CLAUDE_PROJECT_DIR = process.cwd();',
          'if (existsSync(resolve(__dirname, "server.bundle.mjs"))) {',
          '  await import("./server.bundle.mjs");',
          '} else if (existsSync(resolve(__dirname, "build", "server.js"))) {',
          '  await import("./build/server.js");',
          '}',
        ].join("\n"), "utf-8");
      }
    }

    const targetDir = existsSync(correctDir) ? correctDir : myRoot;

    // 2. Update installed_plugins.json → point to correct version dir
    //    Skip if not present (e.g. CI / non-Claude-Code environments)
    const ipPath = resolve(homedir(), ".claude", "plugins", "installed_plugins.json");
    if (existsSync(ipPath)) {
      const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
      for (const [key, entries] of Object.entries(ip.plugins || {})) {
        if (!key.toLowerCase().includes("context-mode")) continue;
        for (const entry of entries) {
          entry.installPath = targetDir;
          entry.version = myVersion;
          entry.lastUpdated = new Date().toISOString();
        }
      }
      writeFileSync(ipPath, JSON.stringify(ip, null, 2) + "\n", "utf-8");
    }

    // 3. Update hook paths + matcher in settings.json for ALL hook types (#187)
    //    Previously only fixed PreToolUse — SessionStart, PostToolUse, PreCompact,
    //    UserPromptSubmit paths remained stale after marketplace auto-update.
    const settingsPath = resolve(homedir(), ".claude", "settings.json");
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const allHooks = settings.hooks || {};
      let changed = false;

      for (const hookType of Object.keys(allHooks)) {
        const entries = allHooks[hookType];
        if (!Array.isArray(entries)) continue;

        for (const entry of entries) {
          // Fix deprecated Task-only matcher (PreToolUse only)
          if (hookType === "PreToolUse" && entry.matcher?.includes("Task") && !entry.matcher.includes("Agent")) {
            entry.matcher = entry.matcher.replace("Task", "Agent|Task");
            changed = true;
          }
          // Rewrite stale context-mode hook paths to point to current version
          for (const h of (entry.hooks || [])) {
            if (h.command && h.command.includes(".mjs") && h.command.includes("context-mode") && !h.command.includes(targetDir)) {
              // Extract the script filename (e.g., sessionstart.mjs, pretooluse.mjs)
              const scriptMatch = h.command.match(/([a-z]+\.mjs)\s*"?\s*$/);
              if (scriptMatch) {
                h.command = "node " + resolve(targetDir, "hooks", scriptMatch[1]);
                changed = true;
              }
            }
          }
        }
      }

      if (changed) writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    } catch { /* skip settings update */ }

    // Old version dirs are cleaned lazily by sessionstart.mjs (age-gated >1h)
    // to avoid breaking active sessions that still reference them (#181).

    writeFileSync(marker, Date.now().toString(), "utf-8");
  }
} catch { /* best effort — don't block hook */ }

// ─── Init security from compiled build ───
const __hookDir = dirname(fileURLToPath(import.meta.url));
await initSecurity(resolve(__hookDir, "..", "build"));

// ─── Read stdin ───
const raw = await readStdin();
const input = JSON.parse(raw);
const tool = input.tool_name ?? "";
const toolInput = input.tool_input ?? {};

// ─── Route and format response ───
const decision = routePreToolUse(tool, toolInput, process.env.CLAUDE_PROJECT_DIR, "claude-code");
const response = formatDecision("claude-code", decision);
if (response !== null) {
  process.stdout.write(JSON.stringify(response) + "\n");
}
