#!/usr/bin/env node
/**
 * Unified PreToolUse hook for context-mode (Claude Code)
 * Redirects data-fetching tools to context-mode MCP tools
 *
 * Cross-platform (Windows/macOS/Linux) — no bash/jq dependency.
 *
 * Routing is delegated to core/routing.mjs (shared across platforms).
 * This file retains the Claude Code-specific self-heal block and
 * uses core/formatters.mjs for Claude Code output format.
 *
 * Crash-resilience: wrapped via runHook (#414) — module loads happen
 * dynamically inside the wrapper.
 *
 * #415: the destructive settings.json mutation block (which removed
 * context-mode hook entries when hooks.json was present) was deleted.
 * It deleted user-written hook configs without consent and was the
 * documented cause of the regression.
 */

import { runHook } from "./run-hook.mjs";

await runHook(async () => {
  const { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } = await import("node:fs");
  const { resolve, dirname, basename } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { tmpdir } = await import("node:os");
  const { readStdin } = await import("./core/stdin.mjs");
  const { routePreToolUse, initSecurity } = await import("./core/routing.mjs");
  const { formatDecision } = await import("./core/formatters.mjs");
  const { parseStdin, getSessionId, resolveConfigDir } = await import("./session-helpers.mjs");

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
      const ipPath = resolve(resolveConfigDir(), "plugins", "installed_plugins.json");
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

      // 3. Legacy: hooks.json absent — rewrite stale paths in settings.json to current version dir.
      //    The previous "if hooks.json present, delete settings.json entries" block was REMOVED (#415):
      //    it destroyed user-written hook configs without consent. Plugin-system + settings.json
      //    coexistence is now Claude Code's responsibility, not ours.
      const settingsPath = resolve(resolveConfigDir(), "settings.json");
      try {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        const allHooks = settings.hooks || {};
        let changed = false;

        const hooksJsonPath = resolve(myRoot, "hooks", "hooks.json");
        if (!existsSync(hooksJsonPath)) {
          // Legacy: hooks.json absent — rewrite stale paths to current version dir.
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
  const input = parseStdin(raw);
  const tool = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};

  // ─── Route and format response ───
  const decision = routePreToolUse(tool, toolInput, process.env.CLAUDE_PROJECT_DIR, "claude-code", getSessionId(input));
  const response = formatDecision("claude-code", decision);

  // ─── Write latency marker for cross-hook timing (Category 27) ───
  // Marker writes MUST happen before stdout write — stdout is the last action
  // so the process can exit immediately after, avoiding CI test timeouts.
  try {
    const sessionId = getSessionId(input);
    if (tool) {
      const markerPath = resolve(tmpdir(), `context-mode-latency-${sessionId}-${tool}.txt`);
      writeFileSync(markerPath, String(Date.now()), "utf-8");
    }
  } catch { /* latency tracking is best-effort — never block hook */ }

  // ─── Write rejected-approach marker for PostToolUse to pick up ───
  // PreToolUse cannot safely load SessionDB (native module loading breaks hook stdout).
  // Write a marker file instead; PostToolUse reads it and writes the event.
  if (decision && (decision.action === "deny" || decision.action === "modify")) {
    try {
      const sessionId = getSessionId(input);
      const reason = decision.action === "deny"
        ? (decision.reason || "denied")
        : "Redirected to context-mode sandbox";
      const markerPath = resolve(tmpdir(), `context-mode-rejected-${sessionId}.txt`);
      writeFileSync(markerPath, `${tool}:${reason}`, "utf-8");
    } catch { /* best-effort — never block hook */ }
  }

  // ─── stdout write is the LAST action — process exits immediately after ───
  if (response !== null) {
    process.stdout.write(JSON.stringify(response) + "\n");
  }
});
