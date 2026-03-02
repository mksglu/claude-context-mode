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

// ─── Security module: graceful import from compiled build ───
let security = null;
try {
  const __hookDir = dirname(fileURLToPath(import.meta.url));
  security = await import(resolve(__hookDir, "..", "build", "security.js"));
} catch {
  // Build not available — skip security checks, rely on existing routing
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

// ─── Bash: Stage 1 security check, then Stage 2 routing ───
if (tool === "Bash") {
  const command = toolInput.command ?? "";

  // Stage 1: Security check against user's deny/allow patterns.
  // Only act when an explicit pattern matched. When no pattern matches,
  // evaluateCommand returns { decision: "ask" } with no matchedPattern —
  // in that case fall through so other hooks (e.g. git-guard) and Claude
  // Code's native engine can decide.
  if (security) {
    const policies = security.readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    if (policies.length > 0) {
      const result = security.evaluateCommand(command, policies);
      if (result.decision === "deny") {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            reason: `Blocked by security policy: matches deny pattern ${result.matchedPattern}`,
          },
        }));
        process.exit(0);
      }
      if (result.decision === "ask" && result.matchedPattern) {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
          },
        }));
        process.exit(0);
      }
      // "allow" or no match → fall through to Stage 2
    }
  }

  // Stage 2: Context-mode routing (existing behavior, unchanged)

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
        '<context_guidance>\n  <tip>\n    This operation may flood your context window. To stay efficient:\n    - Use mcp__context-mode__execute_file(path, language, code) to process large files in the sandbox.\n    - Only your final printed summary will enter the context.\n  </tip>\n</context_guidance>',
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
        '<context_guidance>\n  <tip>\n    This operation may flood your context window. To stay efficient:\n    - Use mcp__context-mode__execute(language: "shell", code: "...") to run searches in the sandbox.\n    - Only your final printed summary will enter the context.\n  </tip>\n</context_guidance>',
    },
  }));
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

// ─── Task: inject context-mode routing into subagent prompts ───
if (tool === "Task") {
  const subagentType = toolInput.subagent_type ?? "";
  const prompt = toolInput.prompt ?? "";

  const ROUTING_BLOCK = `

<context_window_protection>
  <priority_instructions>
    Raw tool output floods your context window. You MUST use context-mode MCP tools to keep raw data in the sandbox.
  </priority_instructions>

  <tool_selection_hierarchy>
    1. GATHER: mcp__context-mode__batch_execute(commands, queries)
       - Primary tool for research. Runs all commands, auto-indexes, and searches.
       - ONE call replaces many individual steps.
    2. FOLLOW-UP: mcp__context-mode__search(queries: ["q1", "q2", ...])
       - Use for all follow-up questions. ONE call, many queries.
    3. PROCESSING: mcp__context-mode__execute(language, code) | mcp__context-mode__execute_file(path, language, code)
       - Use for API calls, log analysis, and data processing.
  </tool_selection_hierarchy>

  <forbidden_actions>
    - DO NOT use Bash for commands producing >20 lines of output.
    - DO NOT use Read for large files.
    - DO NOT use WebFetch (use mcp__context-mode__fetch_and_index instead).
    - Bash is ONLY for git/mkdir/rm/mv/navigation.
  </forbidden_actions>

  <output_constraints>
    <word_limit>Keep your final response under 500 words.</word_limit>
    <artifact_policy>
      Write artifacts (code, configs, PRDs) to FILES. NEVER return them as inline text.
      Return only: file path + 1-line description.
    </artifact_policy>
    <response_format>
      Your response must be a concise summary:
      - Actions taken (2-3 bullets)
      - File paths created/modified
      - Knowledge base source labels (so parent can search)
      - Key findings
    </response_format>
  </output_constraints>
</context_window_protection>`;

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

// ─── MCP execute: security check for shell commands ───
if (tool.includes("context-mode") && tool.endsWith("__execute")) {
  if (security && toolInput.language === "shell") {
    const code = toolInput.code ?? "";
    const policies = security.readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    if (policies.length > 0) {
      const result = security.evaluateCommand(code, policies);
      if (result.decision === "deny") {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            reason: `Blocked by security policy: shell code matches deny pattern ${result.matchedPattern}`,
          },
        }));
        process.exit(0);
      }
      if (result.decision === "ask" && result.matchedPattern) {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
          },
        }));
        process.exit(0);
      }
    }
  }
  process.exit(0);
}

// ─── MCP execute_file: check file path + code against deny patterns ───
if (tool.includes("context-mode") && tool.endsWith("__execute_file")) {
  if (security) {
    // Check file path against Read deny patterns
    const filePath = toolInput.path ?? "";
    const denyGlobs = security.readToolDenyPatterns("Read", process.env.CLAUDE_PROJECT_DIR);
    const evalResult = security.evaluateFilePath(filePath, denyGlobs);
    if (evalResult.denied) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          reason: `Blocked by security policy: file path matches Read deny pattern ${evalResult.matchedPattern}`,
        },
      }));
      process.exit(0);
    }

    // Check code parameter against Bash deny patterns (same as execute)
    const lang = toolInput.language ?? "";
    const code = toolInput.code ?? "";
    if (lang === "shell") {
      const policies = security.readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
      if (policies.length > 0) {
        const result = security.evaluateCommand(code, policies);
        if (result.decision === "deny") {
          console.log(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              reason: `Blocked by security policy: shell code matches deny pattern ${result.matchedPattern}`,
            },
          }));
          process.exit(0);
        }
        if (result.decision === "ask" && result.matchedPattern) {
          console.log(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "ask",
            },
          }));
          process.exit(0);
        }
      }
    }
  }
  process.exit(0);
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
          console.log(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              reason: `Blocked by security policy: batch command "${entry.label ?? cmd}" matches deny pattern ${result.matchedPattern}`,
            },
          }));
          process.exit(0);
        }
        if (result.decision === "ask" && result.matchedPattern) {
          console.log(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "ask",
            },
          }));
          process.exit(0);
        }
      }
    }
  }
  process.exit(0);
}

// Unknown tool — pass through
process.exit(0);
