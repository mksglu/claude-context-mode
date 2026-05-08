import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Allowlist for SHELL env override. Only POSIX shells + Windows shells permit
 * arbitrary command interpretation; anything else (e.g., /usr/bin/python set
 * as SHELL) would let an attacker redirect the executor to a non-shell binary.
 *
 * basename split handles BOTH `/` and `\` separators so a Windows-style path
 * (`C:\Program Files\PowerShell\7\pwsh.exe`) classifies correctly even when
 * the runtime is on POSIX (where node:path.basename only splits on `/`).
 *
 * Match is case-insensitive; `.exe` extension tolerated for Windows binaries.
 */
const ALLOWED_SHELL_BASENAMES = /^(bash|sh|zsh|dash|pwsh|powershell|cmd)(\.exe)?$/i;

export function isAllowlistedShell(shellPath: string): boolean {
  // Cross-OS basename: split on either separator, take the last segment.
  const segments = shellPath.split(/[\\/]/);
  const base = segments[segments.length - 1];
  return ALLOWED_SHELL_BASENAMES.test(base);
}

export type Language =
  | "javascript"
  | "typescript"
  | "python"
  | "shell"
  | "ruby"
  | "go"
  | "rust"
  | "php"
  | "perl"
  | "r"
  | "elixir";

export interface RuntimeInfo {
  command: string;
  available: boolean;
  version: string;
  preferred: boolean;
}

export interface RuntimeMap {
  javascript: string;
  typescript: string | null;
  python: string | null;
  shell: string;
  ruby: string | null;
  go: string | null;
  rust: string | null;
  php: string | null;
  perl: string | null;
  r: string | null;
  elixir: string | null;
}

const isWindows = process.platform === "win32";

function commandExists(cmd: string): boolean {
  try {
    const check = isWindows ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(check, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stricter probe than commandExists() — also verifies the resolved binary
 * actually runs. On Windows, `where python3` matches the Microsoft Store
 * App Execution Alias stub at C:\Users\<u>\AppData\Local\Microsoft\WindowsApps\
 * even when no real Python is installed; the stub exits non-zero (9009) and
 * pops the Store. Filter those entries out and require `<cmd> --version` to
 * exit 0 before declaring the runtime available (#455).
 */
function runnableExists(cmd: string): boolean {
  if (isWindows) {
    // Reject if every `where` hit lives under Microsoft\WindowsApps (Store stubs).
    try {
      const out = execSync(`where ${cmd}`, { encoding: "utf-8", stdio: "pipe" });
      const hits = out.trim().split(/\r?\n/).map(p => p.trim()).filter(Boolean);
      if (hits.length === 0) return false;
      const realHits = hits.filter(p => !/\\Microsoft\\WindowsApps\\/i.test(p));
      if (realHits.length === 0) return false;
    } catch {
      return false;
    }
  } else if (!commandExists(cmd)) {
    return false;
  }
  // Probe with --version (5s timeout). Exit 0 means it really runs.
  try {
    execFileSync(cmd, ["--version"], {
      shell: isWindows,
      stdio: "pipe",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function bunExists(): boolean {
  if (commandExists("bun")) return true;
  for (const p of bunFallbackPaths()) {
    if (existsSync(p)) return true;
  }
  return false;
}

function bunCommand(): string {
  if (commandExists("bun")) return "bun";
  for (const p of bunFallbackPaths()) {
    if (existsSync(p)) return p;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return isWindows ? `${home}\\.bun\\bin\\bun.exe` : `${home}/.bun/bin/bun`;
}

/** Fallback paths where Bun may be installed but not on PATH. */
function bunFallbackPaths(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    return [
      ...(home ? [`${home}\\.bun\\bin\\bun.exe`] : []),
      ...(localAppData ? [`${localAppData}\\bun\\bin\\bun.exe`] : []),
    ];
  }
  return home ? [`${home}/.bun/bin/bun`] : [];
}

/**
 * On Windows, resolve the first non-WSL bash in PATH.
 * WSL bash (C:\Windows\System32\bash.exe) cannot handle Windows paths,
 * so we skip it and prefer Git Bash or MSYS2 bash instead.
 */
function resolveWindowsBash(): string | null {
  // First, try well-known Git Bash locations directly (works even when
  // Git\usr\bin is not on PATH, which is common in MCP server environments
  // that only inherit Git\cmd from the system PATH).
  const knownPaths = [
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
  ];
  for (const p of knownPaths) {
    if (existsSync(p)) return p;
  }

  // Fallback: scan PATH via `where bash`, skipping WSL and WindowsApps entries.
  try {
    const result = execSync("where bash", { encoding: "utf-8", stdio: "pipe" });
    const candidates = result.trim().split(/\r?\n/).map(p => p.trim()).filter(Boolean);
    for (const p of candidates) {
      const lower = p.toLowerCase();
      if (lower.includes("system32") || lower.includes("windowsapps")) continue;
      return p;
    }
    return null;
  } catch {
    return null;
  }
}

function getVersion(cmd: string, args: string[] = ["--version"]): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf-8",
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    return "unknown";
  }
}

export function detectRuntimes(): RuntimeMap {
  const hasBun = bunExists();
  const bun = hasBun ? bunCommand() : null;

  // Honor SHELL env var when it points at a real binary AND the basename is
  // an allowlisted shell. Lets users with non-standard setups (WSL, custom
  // bash, msys2) pin context-mode to their preferred shell.
  //
  // Allowlist (PR #401 ops review): basename must match
  // /^(bash|sh|zsh|dash|pwsh|cmd)(\.exe)?$/. Without this guard, an attacker
  // who controls SHELL (e.g., supply-chain compromise of a profile script)
  // could redirect the executor to /usr/bin/python or any arbitrary binary.
  const userShell = process.env.SHELL;
  const shellOverride = userShell && existsSync(userShell) && isAllowlistedShell(userShell)
    ? userShell
    : null;
  const isWin = process.platform === "win32";

  return {
    javascript: bun ?? process.execPath,
    typescript: bun
      ? bun
      : commandExists("tsx")
        ? "tsx"
        : commandExists("ts-node")
          ? "ts-node"
          : null,
    python: runnableExists("python3")
      ? "python3"
      : runnableExists("python")
        ? "python"
        : runnableExists("py")
          ? "py"
          : null,
    shell: shellOverride ?? (isWin
      ? (resolveWindowsBash() ?? (commandExists("sh") ? "sh" : commandExists("powershell") ? "powershell" : "cmd.exe"))
      : commandExists("bash") ? "bash" : "sh"),
    ruby: commandExists("ruby") ? "ruby" : null,
    go: commandExists("go") ? "go" : null,
    rust: commandExists("rustc") ? "rustc" : null,
    php: commandExists("php") ? "php" : null,
    perl: commandExists("perl") ? "perl" : null,
    r: commandExists("Rscript")
      ? "Rscript"
      : commandExists("r")
        ? "r"
        : null,
    elixir: commandExists("elixir") ? "elixir" : null,
  };
}

export function hasBunRuntime(): boolean {
  return bunExists();
}

export function getRuntimeSummary(runtimes: RuntimeMap): string {
  const lines: string[] = [];
  const bunPreferred = runtimes.javascript?.endsWith("bun") ?? false;

  lines.push(
    `  JavaScript: ${runtimes.javascript} (${getVersion(runtimes.javascript)})${bunPreferred ? " ⚡" : ""}`,
  );

  if (runtimes.typescript) {
    lines.push(
      `  TypeScript: ${runtimes.typescript} (${getVersion(runtimes.typescript)})`,
    );
  } else {
    lines.push(
      `  TypeScript: not available (install bun, tsx, or ts-node)`,
    );
  }

  if (runtimes.python) {
    lines.push(
      `  Python:     ${runtimes.python} (${getVersion(runtimes.python)})`,
    );
  } else {
    lines.push(`  Python:     not available`);
  }

  lines.push(
    `  Shell:      ${runtimes.shell} (${getVersion(runtimes.shell)})`,
  );

  // Optional runtimes — only show if available
  if (runtimes.ruby)
    lines.push(
      `  Ruby:       ${runtimes.ruby} (${getVersion(runtimes.ruby)})`,
    );
  if (runtimes.go)
    lines.push(`  Go:         ${runtimes.go} (${getVersion(runtimes.go, ["version"])})`);
  if (runtimes.rust)
    lines.push(
      `  Rust:       ${runtimes.rust} (${getVersion(runtimes.rust)})`,
    );
  if (runtimes.php)
    lines.push(
      `  PHP:        ${runtimes.php} (${getVersion(runtimes.php)})`,
    );
  if (runtimes.perl)
    lines.push(
      `  Perl:       ${runtimes.perl} (${getVersion(runtimes.perl)})`,
    );
  if (runtimes.r)
    lines.push(`  R:          ${runtimes.r} (${getVersion(runtimes.r)})`);
  if (runtimes.elixir)
    lines.push(
      `  Elixir:     ${runtimes.elixir} (${getVersion(runtimes.elixir)})`,
    );

  if (!bunPreferred) {
    lines.push("");
    lines.push(
      "  Tip: Install Bun for 3-5x faster JS/TS execution → https://bun.sh",
    );
  }

  return lines.join("\n");
}

export function getAvailableLanguages(runtimes: RuntimeMap): Language[] {
  const langs: Language[] = ["javascript", "shell"];
  if (runtimes.typescript) langs.push("typescript");
  if (runtimes.python) langs.push("python");
  if (runtimes.ruby) langs.push("ruby");
  if (runtimes.go) langs.push("go");
  if (runtimes.rust) langs.push("rust");
  if (runtimes.php) langs.push("php");
  if (runtimes.perl) langs.push("perl");
  if (runtimes.r) langs.push("r");
  if (runtimes.elixir) langs.push("elixir");
  return langs;
}

export function buildCommand(
  runtimes: RuntimeMap,
  language: Language,
  filePath: string,
): string[] {
  switch (language) {
    case "javascript":
      return runtimes.javascript.endsWith("bun")
        ? [runtimes.javascript, "run", filePath]
        : [runtimes.javascript, filePath];

    case "typescript":
      if (!runtimes.typescript) {
        throw new Error(
          "No TypeScript runtime available. Install one of: bun (recommended), tsx (npm i -g tsx), or ts-node.",
        );
      }
      if (runtimes.typescript?.endsWith("bun")) return [runtimes.typescript, "run", filePath];
      if (runtimes.typescript === "tsx") return ["tsx", filePath];
      return ["ts-node", filePath];

    case "python":
      if (!runtimes.python) {
        throw new Error(
          "No Python runtime available. Install python3 or python.",
        );
      }
      return [runtimes.python, filePath];

    case "shell": {
      // Re-evaluate platform per call so detection-time and command-build-time
      // can be tested independently (and to allow tests to stub process.platform).
      const winNow = process.platform === "win32";
      if (winNow) {
        const shellName = runtimes.shell.toLowerCase();
        if (shellName.includes("bash") || shellName.endsWith("/sh") || shellName.endsWith("\\sh.exe")) {
          // bash -c "source 'path'" — avoids MSYS2 path mangling on non-C:
          // drives. When bash.exe receives a script as a direct argument,
          // MSYS rewrites D:\tmp\script → D:\c\tmp\script and execution
          // breaks. The -c flag prevents MSYS from touching the file arg.
          // Single-quote escape: ' → '\''
          const escaped = filePath.replace(/'/g, "'\\''");
          return [runtimes.shell, "-c", `source '${escaped}'`];
        }
        if (shellName.includes("powershell") || shellName.includes("pwsh")) {
          return [runtimes.shell, "-File", filePath];
        }
        // cmd.exe and others: direct file (cmd reads .cmd association safely).
      }
      return [runtimes.shell, filePath];
    }

    case "ruby":
      if (!runtimes.ruby) {
        throw new Error("Ruby not available. Install ruby.");
      }
      return [runtimes.ruby, filePath];

    case "go":
      if (!runtimes.go) {
        throw new Error("Go not available. Install go.");
      }
      return ["go", "run", filePath];

    case "rust": {
      if (!runtimes.rust) {
        throw new Error(
          "Rust not available. Install rustc via https://rustup.rs",
        );
      }
      // Rust needs compile + run — handled specially in executor
      return ["__rust_compile_run__", filePath];
    }

    case "php":
      if (!runtimes.php) {
        throw new Error("PHP not available. Install php.");
      }
      return ["php", filePath];

    case "perl":
      if (!runtimes.perl) {
        throw new Error("Perl not available. Install perl.");
      }
      return ["perl", filePath];

    case "r":
      if (!runtimes.r) {
        throw new Error("R not available. Install R / Rscript.");
      }
      return [runtimes.r, filePath];

    case "elixir":
      if (!runtimes.elixir) {
        throw new Error( "Elixir not available. Install elixir.");
      }
      return ["elixir", filePath];
  }
}
