#!/usr/bin/env node
/**
 * Unified PreToolUse hook for context-mode
 * Redirects data-fetching tools to context-mode MCP tools
 *
 * Cross-platform (Windows/macOS/Linux) — no bash/jq dependency.
 */

import { readFileSync, writeFileSync, existsSync, rmSync, cpSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

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
      cpSync(myRoot, correctDir, { recursive: true });

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
    const ipPath = resolve(homedir(), ".claude", "plugins", "installed_plugins.json");
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

let raw = "";
process.stdin.setEncoding("utf-8");
for await (const chunk of process.stdin) raw += chunk;

const input = JSON.parse(raw);
const tool = input.tool_name ?? "";
const toolInput = input.tool_input ?? {};

// ─── Bash: redirect data-fetching commands via updatedInput ───
if (tool === "Bash") {
  const command = toolInput.command ?? "";

  // curl/wget → replace with echo redirect
  if (/(^|\s|&&|\||\;)(curl|wget)\s/i.test(command)) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          command: 'echo "context-mode: curl/wget blocked. You MUST use mcp__context-mode__fetch_and_index(url, source) to fetch URLs, or mcp__context-mode__execute(language, code) to run HTTP calls in sandbox. Do NOT retry with curl/wget."',
        },
      },
    }));
    process.exit(0);
  }

  // inline fetch (node -e, python -c, etc.) → replace with echo redirect
  if (
    /fetch\s*\(\s*['"](https?:\/\/|http)/i.test(command) ||
    /requests\.(get|post|put)\s*\(/i.test(command) ||
    /http\.(get|request)\s*\(/i.test(command)
  ) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          command: 'echo "context-mode: Inline HTTP blocked. Use mcp__context-mode__execute(language, code) to run HTTP calls in sandbox, or mcp__context-mode__fetch_and_index(url, source) for web pages. Do NOT retry with Bash."',
        },
      },
    }));
    process.exit(0);
  }

  // allow all other Bash commands
  process.exit(0);
}

// ─── Read: nudge toward execute_file ───
if (tool === "Read") {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        "CONTEXT TIP: If this file is large (>50 lines), prefer mcp__context-mode__execute_file(path, language, code) — processes in sandbox, only stdout enters context.",
    },
  }));
  process.exit(0);
}

// ─── Grep: nudge toward execute ───
if (tool === "Grep") {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        'CONTEXT TIP: If results may be large, prefer mcp__context-mode__execute(language: "shell", code: "grep ...") — runs in sandbox, only stdout enters context.',
    },
  }));
  process.exit(0);
}

// ─── Glob: passthrough ───
if (tool === "Glob") {
  process.exit(0);
}

// ─── WebFetch: deny + redirect to sandbox ───
if (tool === "WebFetch") {
  const url = toolInput.url ?? "";
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      reason: `context-mode: WebFetch blocked. Use mcp__context-mode__fetch_and_index(url: "${url}", source: "...") to fetch this URL in sandbox. Then use mcp__context-mode__search(queries: [...]) to query results. Do NOT use curl/wget — they are also blocked.`,
    },
  }));
  process.exit(0);
}

// ─── WebSearch: passthrough ───
if (tool === "WebSearch") {
  process.exit(0);
}

// ─── Task: inject context-mode routing into subagent prompts ───
if (tool === "Task") {
  const subagentType = toolInput.subagent_type ?? "";
  const prompt = toolInput.prompt ?? "";

  const ROUTING_BLOCK = `

---
CONTEXT WINDOW PROTECTION — USE CONTEXT-MODE MCP TOOLS

Raw Bash/Read/WebFetch output floods your context. You have context-mode tools that keep data in sandbox.

STEP 1 — GATHER: mcp__context-mode__batch_execute(commands, queries)
  commands: [{label: "Name", command: "shell cmd"}, ...]
  queries: ["query1", "query2", ...] — put 5-8 queries covering everything you need.
  Runs all commands, indexes output, returns search results. ONE call, no follow-ups.

STEP 2 — FOLLOW-UP: mcp__context-mode__search(queries: ["q1", "q2", "q3", ...])
  Pass ALL follow-up questions as queries array. ONE call, not separate calls.

OTHER: execute(language, code) | execute_file(path, language, code) | fetch_and_index(url) + search

FORBIDDEN: Bash for output, Read for files, WebFetch. Bash is ONLY for git/mkdir/rm/mv.

OUTPUT FORMAT — KEEP YOUR FINAL RESPONSE UNDER 500 WORDS:
The parent agent context window is precious. Your full response gets injected into it.

1. ARTIFACTS (PRDs, configs, code files) → Write to FILES, never return as inline text.
   Return only: file path + 1-line description.
2. DETAILED FINDINGS → Index into knowledge base:
   mcp__context-mode__index(content: "...", source: "descriptive-label")
   The parent agent shares the SAME knowledge base and can search() your indexed content.
3. YOUR RESPONSE must be a concise summary:
   - What you did (2-3 bullets)
   - File paths created/modified (if any)
   - Source labels you indexed (so parent can search)
   - Key findings in bullet points
   Do NOT return raw data, full file contents, or lengthy explanations.
---`;

  const updatedInput =
    subagentType === "Bash"
      ? { ...toolInput, prompt: prompt + ROUTING_BLOCK, subagent_type: "general-purpose" }
      : { ...toolInput, prompt: prompt + ROUTING_BLOCK };

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput,
    },
  }));
  process.exit(0);
}

// Unknown tool — pass through
process.exit(0);
