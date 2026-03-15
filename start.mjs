#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
process.chdir(__dirname);

if (!process.env.CLAUDE_PROJECT_DIR) {
  process.env.CLAUDE_PROJECT_DIR = process.cwd();
}

// Auto-write routing instructions file for the detected platform
try {
  const projectDir =
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.GEMINI_PROJECT_DIR ||
    process.env.VSCODE_CWD ||
    process.cwd();

  const configsDir = resolve(__dirname, "configs");

  // Detect platform and determine instruction file
  const platformConfigs = [
    { env: ["CLAUDE_PROJECT_DIR", "CLAUDE_SESSION_ID"], dir: "claude-code", file: "CLAUDE.md", target: "CLAUDE.md" },
    { env: ["GEMINI_PROJECT_DIR", "GEMINI_SESSION_ID"], dir: "gemini-cli", file: "GEMINI.md", target: "GEMINI.md" },
    { env: ["VSCODE_PID", "VSCODE_CWD"], dir: "vscode-copilot", file: "copilot-instructions.md", target: ".github/copilot-instructions.md" },
    { env: ["OPENCODE_PROJECT_DIR", "OPENCODE_SESSION_ID"], dir: "opencode", file: "AGENTS.md", target: "AGENTS.md" },
    { env: ["OPENCLAW_HOME", "OPENCLAW_PROJECT_DIR"], dir: "openclaw", file: "AGENTS.md", target: "AGENTS.md" },
    { env: ["CODEX_HOME"], dir: "codex", file: "AGENTS.md", target: "AGENTS.md" },
  ];

  const detected = platformConfigs.find((p) => p.env.some((e) => process.env[e]));
  if (detected) {
    const targetPath = resolve(projectDir, detected.target);
    const sourcePath = resolve(configsDir, detected.dir, detected.file);

    // Ensure parent dir exists (for .github/copilot-instructions.md)
    const targetDir = resolve(targetPath, "..");
    if (!existsSync(targetDir)) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(targetDir, { recursive: true });
    }

    if (existsSync(sourcePath)) {
      const content = readFileSync(sourcePath, "utf-8");
      if (existsSync(targetPath)) {
        const existing = readFileSync(targetPath, "utf-8");
        if (!existing.includes("context-mode")) {
          writeFileSync(targetPath, existing.trimEnd() + "\n\n" + content, "utf-8");
        }
      } else {
        writeFileSync(targetPath, content, "utf-8");
      }
    }
  }
} catch {
  /* best effort — don't block server startup */
}

// Self-heal: if a newer version dir exists, update registry so next session uses it
const cacheMatch = __dirname.match(
  /^(.*[\/\\]plugins[\/\\]cache[\/\\][^\/\\]+[\/\\][^\/\\]+[\/\\])([^\/\\]+)$/,
);
if (cacheMatch) {
  try {
    const cacheParent = cacheMatch[1];
    const myVersion = cacheMatch[2];
    const dirs = readdirSync(cacheParent).filter((d) =>
      /^\d+\.\d+\.\d+/.test(d),
    );
    if (dirs.length > 1) {
      dirs.sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if ((pa[i] ?? 0) !== (pb[i] ?? 0))
            return (pa[i] ?? 0) - (pb[i] ?? 0);
        }
        return 0;
      });
      const newest = dirs[dirs.length - 1];
      if (newest && newest !== myVersion) {
        const ipPath = resolve(
          homedir(),
          ".claude",
          "plugins",
          "installed_plugins.json",
        );
        const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
        for (const [key, entries] of Object.entries(ip.plugins || {})) {
          if (!key.toLowerCase().includes("context-mode")) continue;
          for (const entry of entries) {
            entry.installPath = resolve(cacheParent, newest);
            entry.version = newest;
            entry.lastUpdated = new Date().toISOString();
          }
        }
        writeFileSync(
          ipPath,
          JSON.stringify(ip, null, 2) + "\n",
          "utf-8",
        );
      }
    }
  } catch {
    /* best effort — don't block server startup */
  }
}

// Ensure external dependencies are available
for (const pkg of ["better-sqlite3", "turndown", "turndown-plugin-gfm", "@mixmark-io/domino"]) {
  if (!existsSync(resolve(__dirname, "node_modules", pkg))) {
    try {
      execSync(`npm install ${pkg} --no-package-lock --no-save --silent`, {
        cwd: __dirname,
        stdio: "pipe",
        timeout: 60000,
      });
    } catch { /* best effort */ }
  }
}

// Bundle exists (CI-built) — start instantly
if (existsSync(resolve(__dirname, "server.bundle.mjs"))) {
  await import("./server.bundle.mjs");
} else {
  // Dev or npm install — full build
  if (!existsSync(resolve(__dirname, "node_modules"))) {
    try {
      execSync("npm install --silent", { cwd: __dirname, stdio: "pipe", timeout: 60000 });
    } catch { /* best effort */ }
  }
  if (!existsSync(resolve(__dirname, "build", "server.js"))) {
    try {
      execSync("npx tsc --silent", { cwd: __dirname, stdio: "pipe", timeout: 30000 });
    } catch { /* best effort */ }
  }
  await import("./build/server.js");
}
