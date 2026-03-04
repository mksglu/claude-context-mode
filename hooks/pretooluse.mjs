#!/usr/bin/env node
/**
 * Unified PreToolUse hook for context-mode
 * Redirects data-fetching tools to context-mode MCP tools
 *
 * Cross-platform (Windows/macOS/Linux) — no bash/jq dependency.
 *
 * Routing is structured as a pure function that returns a response object
 * (or null for passthrough). This avoids process.exit() which drops piped
 * stdout on Windows before the buffer is flushed.
 */

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir, tmpdir } from "node:os";
import { ROUTING_BLOCK, READ_GUIDANCE, GREP_GUIDANCE } from "./routing-block.mjs";

// ─── Security module: graceful import from compiled build ───
let security = null;
try {
  const __hookDir = dirname(fileURLToPath(import.meta.url));
  const secPath = resolve(__hookDir, "..", "build", "security.js");
  security = await import(pathToFileURL(secPath).href);
} catch {
  // Build not available — skip security checks, rely on existing routing
}

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

  if (myVersion !== "unknown" && !existsSync(marker)) {
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

    // 3. Update hook path in settings.json
    const settingsPath = resolve(homedir(), ".claude", "settings.json");
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const hooks = settings.hooks?.PreToolUse;
      if (Array.isArray(hooks)) {
        let changed = false;
        for (const entry of hooks) {
          for (const h of (entry.hooks || [])) {
            if (h.command?.includes("pretooluse.mjs") && !h.command.includes(targetDir)) {
              h.command = "node " + resolve(targetDir, "hooks", "pretooluse.mjs");
              changed = true;
            }
          }
        }
        if (changed) writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      }
    } catch { /* skip settings update */ }

    // 4. Nuke stale version dirs (keep only targetDir and current running dir)
    try {
      const keepDirs = new Set([basename(targetDir), myDirName]);
      for (const d of readdirSync(cacheParent)) {
        if (!keepDirs.has(d)) {
          try { rmSync(resolve(cacheParent, d), { recursive: true, force: true }); } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }

    writeFileSync(marker, Date.now().toString(), "utf-8");
  }
} catch { /* best effort — don't block hook */ }

// Event-based flowing mode avoids two platform bugs:
// - `for await (process.stdin)` hangs on macOS when piped via spawnSync
// - `readFileSync(0)` throws EOF/EISDIR on Windows, EAGAIN on Linux
const raw = await new Promise((resolve, reject) => {
  let data = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => resolve(data));
  process.stdin.on("error", reject);
  process.stdin.resume();
});

const input = JSON.parse(raw);
const tool = input.tool_name ?? "";
const toolInput = input.tool_input ?? {};

// ─── Route tool to appropriate response ───
// Returns a response object, or null for passthrough.
function route() {
  // ─── Bash: Stage 1 security check, then Stage 2 routing ───
  if (tool === "Bash") {
    const command = toolInput.command ?? "";

    // Stage 1: Security check against user's deny/allow patterns.
    // Only act when an explicit pattern matched. When no pattern matches,
    // evaluateCommand returns { decision: "ask" } with no matchedPattern —
    // in that case fall through so other hooks and Claude Code's native engine can decide.
    if (security) {
      const policies = security.readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
      if (policies.length > 0) {
        const result = security.evaluateCommand(command, policies);
        if (result.decision === "deny") {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              reason: `Blocked by security policy: matches deny pattern ${result.matchedPattern}`,
            },
          };
        }
        if (result.decision === "ask" && result.matchedPattern) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "ask",
            },
          };
        }
        // "allow" or no match → fall through to Stage 2
      }
    }

    // Stage 2: Context-mode routing (existing behavior)

    // curl/wget → replace with echo redirect
    if (/(^|\s|&&|\||\;)(curl|wget)\s/i.test(command)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: {
            command: 'echo "context-mode: curl/wget blocked. You MUST use mcp__plugin_context-mode_context-mode__fetch_and_index(url, source) to fetch URLs, or mcp__plugin_context-mode_context-mode__execute(language, code) to run HTTP calls in sandbox. Do NOT retry with curl/wget."',
          },
        },
      };
    }

    // inline fetch (node -e, python -c, etc.) → replace with echo redirect
    if (
      /fetch\s*\(\s*['"](https?:\/\/|http)/i.test(command) ||
      /requests\.(get|post|put)\s*\(/i.test(command) ||
      /http\.(get|request)\s*\(/i.test(command)
    ) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: {
            command: 'echo "context-mode: Inline HTTP blocked. Use mcp__plugin_context-mode_context-mode__execute(language, code) to run HTTP calls in sandbox, or mcp__plugin_context-mode_context-mode__fetch_and_index(url, source) for web pages. Do NOT retry with Bash."',
          },
        },
      };
    }

    // allow all other Bash commands
    return null;
  }

  // ─── Read: nudge toward execute_file ───
  if (tool === "Read") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: READ_GUIDANCE,
      },
    };
  }

  // ─── Grep: nudge toward execute ───
  if (tool === "Grep") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: GREP_GUIDANCE,
      },
    };
  }

  // ─── WebFetch: deny + redirect to sandbox ───
  if (tool === "WebFetch") {
    const url = toolInput.url ?? "";
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        reason: `context-mode: WebFetch blocked. Use mcp__plugin_context-mode_context-mode__fetch_and_index(url: "${url}", source: "...") to fetch this URL in sandbox. Then use mcp__plugin_context-mode_context-mode__search(queries: [...]) to query results. Do NOT use curl/wget — they are also blocked.`,
      },
    };
  }

  // ─── Task: inject context-mode routing into subagent prompts ───
  if (tool === "Task") {
    const subagentType = toolInput.subagent_type ?? "";
    const prompt = toolInput.prompt ?? "";

    const updatedInput =
      subagentType === "Bash"
        ? { ...toolInput, prompt: prompt + ROUTING_BLOCK, subagent_type: "general-purpose" }
        : { ...toolInput, prompt: prompt + ROUTING_BLOCK };

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput,
      },
    };
  }

  // ─── MCP execute: security check for shell commands ───
  if (tool.includes("context-mode") && tool.endsWith("__execute")) {
    if (security && toolInput.language === "shell") {
      const code = toolInput.code ?? "";
      const policies = security.readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
      if (policies.length > 0) {
        const result = security.evaluateCommand(code, policies);
        if (result.decision === "deny") {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              reason: `Blocked by security policy: shell code matches deny pattern ${result.matchedPattern}`,
            },
          };
        }
        if (result.decision === "ask" && result.matchedPattern) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "ask",
            },
          };
        }
      }
    }
    return null;
  }

  // ─── MCP execute_file: check file path + code against deny patterns ───
  if (tool.includes("context-mode") && tool.endsWith("__execute_file")) {
    if (security) {
      // Check file path against Read deny patterns
      const filePath = toolInput.path ?? "";
      const denyGlobs = security.readToolDenyPatterns("Read", process.env.CLAUDE_PROJECT_DIR);
      const evalResult = security.evaluateFilePath(filePath, denyGlobs);
      if (evalResult.denied) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            reason: `Blocked by security policy: file path matches Read deny pattern ${evalResult.matchedPattern}`,
          },
        };
      }

      // Check code parameter against Bash deny patterns (same as execute)
      const lang = toolInput.language ?? "";
      const code = toolInput.code ?? "";
      if (lang === "shell") {
        const policies = security.readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
        if (policies.length > 0) {
          const result = security.evaluateCommand(code, policies);
          if (result.decision === "deny") {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                reason: `Blocked by security policy: shell code matches deny pattern ${result.matchedPattern}`,
              },
            };
          }
          if (result.decision === "ask" && result.matchedPattern) {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "ask",
              },
            };
          }
        }
      }
    }
    return null;
  }

  // ─── MCP batch_execute: check each command individually ───
  if (tool.includes("context-mode") && tool.endsWith("__batch_execute")) {
    if (security) {
      const commands = toolInput.commands ?? [];
      const policies = security.readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
      if (policies.length > 0) {
        for (const entry of commands) {
          const cmd = entry.command ?? "";
          const result = security.evaluateCommand(cmd, policies);
          if (result.decision === "deny") {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                reason: `Blocked by security policy: batch command "${entry.label ?? cmd}" matches deny pattern ${result.matchedPattern}`,
              },
            };
          }
          if (result.decision === "ask" && result.matchedPattern) {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "ask",
              },
            };
          }
        }
      }
    }
    return null;
  }

  // Unknown tool — pass through
  return null;
}

// ─── Output response ───
// Write to stdout and let Node.js exit naturally. This guarantees stdout
// is fully flushed on all platforms. On Windows, process.exit() can drop
// piped stdout before the buffer is written — so we never call it.
const response = route();
if (response !== null) {
  process.stdout.write(JSON.stringify(response) + "\n");
}
