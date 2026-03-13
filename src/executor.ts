import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  detectRuntimes,
  buildCommand,
  type RuntimeMap,
  type Language,
} from "./runtime.js";
import { smartTruncate } from "./truncate.js";
export type { ExecResult } from "./types.js";
import type { ExecResult } from "./types.js";

const isWin = process.platform === "win32";

/** Kill process tree — on Windows uses taskkill /T; on Unix kills the process group. */
function killTree(proc: ReturnType<typeof spawn>): void {
  if (isWin && proc.pid) {
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "pipe" });
    } catch { /* already dead */ }
  } else if (proc.pid) {
    try {
      // Kill entire process group (negative PID) to prevent orphaned children
      process.kill(-proc.pid, "SIGKILL");
    } catch { /* already dead */ }
  }
}

interface ExecuteOptions {
  language: Language;
  code: string;
  timeout?: number;
  /** Keep process running after timeout instead of killing it. */
  background?: boolean;
}

interface ExecuteFileOptions extends ExecuteOptions {
  path: string;
}

export class PolyglotExecutor {
  #maxOutputBytes: number;
  #hardCapBytes: number;
  #projectRoot: string;
  #runtimes: RuntimeMap;
  #envPassthrough: string[] | true | undefined;

  /** PIDs of backgrounded processes — killed on cleanup to prevent zombies. */
  #backgroundedPids = new Set<number>();

  constructor(opts?: {
    maxOutputBytes?: number;
    hardCapBytes?: number;
    projectRoot?: string;
    runtimes?: RuntimeMap;
    /**
     * Additional environment variables to pass through to sandboxed processes.
     *
     * - `true` — inherit ALL parent environment variables (no filtering).
     * - `string[]` — list of variable names or wildcard patterns (e.g. `"SLACK_*"`)
     *   to pass through in addition to the built-in whitelist.
     *   Only `*` wildcards are supported (matched as `.*` regex).
     * - `undefined` (default) — only pass the built-in whitelist.
     *
     * Can also be configured via the `CONTEXT_MODE_ENV_PASSTHROUGH` env var:
     * - `"*"` — same as `true`
     * - Comma-separated patterns — e.g. `"SLACK_*,LINEAR_*,MY_TOKEN"`
     *
     * **Security warning:** `envPassthrough: true` (or `CONTEXT_MODE_ENV_PASSTHROUGH=*`)
     * disables all environment filtering and exposes every variable in the parent
     * process to sandboxed subprocesses. This may include AWS credentials, SSH keys,
     * database passwords, or other secrets injected by CI, `.env` loaders, or secret
     * managers. Use specific patterns (e.g. `["SLACK_*", "LINEAR_*"]`) instead of
     * `true` unless you explicitly need full inheritance.
     */
    envPassthrough?: string[] | true;
  }) {
    this.#maxOutputBytes = opts?.maxOutputBytes ?? 102_400;
    this.#hardCapBytes = opts?.hardCapBytes ?? 100 * 1024 * 1024; // 100MB
    this.#projectRoot = opts?.projectRoot ?? process.cwd();
    this.#runtimes = opts?.runtimes ?? detectRuntimes();

    // Resolve envPassthrough: constructor option takes precedence over env var
    if (opts?.envPassthrough !== undefined) {
      this.#envPassthrough = opts.envPassthrough;
    } else {
      const envVal = process.env.CONTEXT_MODE_ENV_PASSTHROUGH;
      if (envVal === "*") {
        this.#envPassthrough = true;
      } else if (envVal) {
        this.#envPassthrough = envVal.split(",").map(s => s.trim()).filter(Boolean);
      }
    }
  }

  get runtimes(): RuntimeMap {
    return { ...this.#runtimes };
  }

  /** Kill all backgrounded processes to prevent zombie/port-conflict issues. */
  cleanupBackgrounded(): void {
    for (const pid of this.#backgroundedPids) {
      try {
        // Kill process group on Unix to catch all children
        process.kill(isWin ? pid : -pid, "SIGTERM");
      } catch { /* already dead */ }
    }
    this.#backgroundedPids.clear();
  }

  async execute(opts: ExecuteOptions): Promise<ExecResult> {
    const { language, code, timeout = 30_000, background = false } = opts;
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-mode-"));

    try {
      const filePath = this.#writeScript(tmpDir, code, language);
      const cmd = buildCommand(this.#runtimes, language, filePath);

      // Rust: compile then run
      if (cmd[0] === "__rust_compile_run__") {
        return await this.#compileAndRun(filePath, tmpDir, timeout);
      }

      // Shell commands run in the project directory so git, relative paths,
      // and other project-aware tools work naturally. Non-shell languages
      // run in the temp directory where their script file is written.
      const cwd = language === "shell" ? this.#projectRoot : tmpDir;
      const result = await this.#spawn(cmd, cwd, timeout, background);

      // Skip tmpDir cleanup if process was backgrounded — it may still need files
      if (!result.backgrounded) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch { /* ignore */ }
      }

      return result;
    } catch (err) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
      throw err;
    }
  }

  async executeFile(opts: ExecuteFileOptions): Promise<ExecResult> {
    const { path: filePath, language, code, timeout = 30_000 } = opts;
    const absolutePath = resolve(this.#projectRoot, filePath);
    const wrappedCode = this.#wrapWithFileContent(
      absolutePath,
      language,
      code,
    );
    return this.execute({ language, code: wrappedCode, timeout });
  }

  #writeScript(tmpDir: string, code: string, language: Language): string {
    const extMap: Record<Language, string> = {
      javascript: "js",
      typescript: "ts",
      python: "py",
      shell: "sh",
      ruby: "rb",
      go: "go",
      rust: "rs",
      php: "php",
      perl: "pl",
      r: "R",
      elixir: "exs",
    };

    // Go needs a main package wrapper if not present
    if (language === "go" && !code.includes("package ")) {
      code = `package main\n\nimport "fmt"\n\nfunc main() {\n${code}\n}\n`;
    }

    // PHP needs opening tag if not present
    if (language === "php" && !code.trimStart().startsWith("<?")) {
      code = `<?php\n${code}`;
    }

    // Elixir: prepend compiled BEAM paths when inside a Mix project
    if (language === "elixir" && existsSync(join(this.#projectRoot, "mix.exs"))) {
      const escaped = JSON.stringify(join(this.#projectRoot, "_build/dev/lib"));
      code = `Path.wildcard(Path.join(${escaped}, "*/ebin"))\n|> Enum.each(&Code.prepend_path/1)\n\n${code}`;
    }

    const fp = join(tmpDir, `script.${extMap[language]}`);
    if (language === "shell") {
      writeFileSync(fp, code, { encoding: "utf-8", mode: 0o700 });
    } else {
      writeFileSync(fp, code, "utf-8");
    }
    return fp;
  }

  async #compileAndRun(
    srcPath: string,
    cwd: string,
    timeout: number,
  ): Promise<ExecResult> {
    const binSuffix = isWin ? ".exe" : "";
    const binPath = srcPath.replace(/\.rs$/, "") + binSuffix;

    // Compile
    try {
      execSync(`rustc ${srcPath} -o ${binPath}`, {
        cwd,
        timeout: Math.min(timeout, 30_000),
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? (err as any).stderr || err.message : String(err);
      return {
        stdout: "",
        stderr: `Compilation failed:\n${message}`,
        exitCode: 1,
        timedOut: false,
      };
    }

    // Run
    return this.#spawn([binPath], cwd, timeout);
  }

  async #spawn(
    cmd: string[],
    cwd: string,
    timeout: number,
    background = false,
  ): Promise<ExecResult> {
    return new Promise((res) => {
      // Only .cmd/.bat shims need shell on Windows; real executables don't.
      // Using shell: true globally causes process-tree kill issues with MSYS2/Git Bash.
      const needsShell = isWin && ["tsx", "ts-node", "elixir"].includes(cmd[0]);

      // On Windows with Git Bash, pass the script as `bash -c "source /posix/path"`
      // rather than `bash /path/to/script.sh`. This avoids MSYS2 path mangling
      // while still allowing MSYS_NO_PATHCONV to protect non-ASCII paths in commands.
      let spawnCmd = cmd[0];
      let spawnArgs: string[];
      if (isWin && cmd.length === 2 && cmd[1]) {
        const posixPath = cmd[1].replace(/\\/g, "/");
        spawnArgs = [posixPath];
      } else {
        spawnArgs = isWin
          ? cmd.slice(1).map(a => a.replace(/\\/g, "/"))
          : cmd.slice(1);
      }

      const proc = spawn(spawnCmd, spawnArgs, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: this.#buildSafeEnv(cwd),
        shell: needsShell,
        // On Unix, create a new process group so killTree can kill all children
        detached: !isWin,
      });

      let timedOut = false;
      let resolved = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (background) {
          // Background mode: detach process, return partial output, keep running
          resolved = true;
          if (proc.pid) this.#backgroundedPids.add(proc.pid);
          proc.unref();
          proc.stdout!.destroy();
          proc.stderr!.destroy();
          const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
          const rawStderr = Buffer.concat(stderrChunks).toString("utf-8");
          const max = this.#maxOutputBytes;
          res({
            stdout: smartTruncate(rawStdout, max),
            stderr: smartTruncate(rawStderr, max),
            exitCode: 0,
            timedOut: true,
            backgrounded: true,
          });
        } else {
          killTree(proc);
        }
      }, timeout);

      // Stream-level byte cap: kill the process once combined stdout+stderr
      // exceeds hardCapBytes. Without this, a command like `yes` or
      // `cat /dev/urandom | base64` can accumulate gigabytes in memory
      // before the timeout fires.
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalBytes = 0;
      let capExceeded = false;

      proc.stdout!.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= this.#hardCapBytes) {
          stdoutChunks.push(chunk);
        } else if (!capExceeded) {
          capExceeded = true;
          killTree(proc);
        }
      });

      proc.stderr!.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= this.#hardCapBytes) {
          stderrChunks.push(chunk);
        } else if (!capExceeded) {
          capExceeded = true;
          killTree(proc);
        }
      });

      proc.on("close", (exitCode) => {
        clearTimeout(timer);
        if (resolved) return; // Already resolved by background timeout
        const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
        let rawStderr = Buffer.concat(stderrChunks).toString("utf-8");

        if (capExceeded) {
          rawStderr += `\n[output capped at ${(this.#hardCapBytes / 1024 / 1024).toFixed(0)}MB — process killed]`;
        }

        const max = this.#maxOutputBytes;
        const stdout = smartTruncate(rawStdout, max);
        const stderr = smartTruncate(rawStderr, max);

        res({
          stdout,
          stderr,
          exitCode: timedOut ? 1 : (exitCode ?? 1),
          timedOut,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        if (resolved) return; // Already resolved by background timeout
        res({
          stdout: "",
          stderr: err.message,
          exitCode: 1,
          timedOut: false,
        });
      });
    });
  }

  #buildSafeEnv(tmpDir: string): Record<string, string> {
    const realHome = process.env.HOME ?? process.env.USERPROFILE ?? tmpDir;

    // Pass through auth-related env vars so CLI tools (gh, aws, gcloud, etc.) work
    const passthrough = [
      // GitHub
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_HOST",
      // AWS
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "AWS_PROFILE",
      // Google Cloud
      "GOOGLE_APPLICATION_CREDENTIALS",
      "CLOUDSDK_CONFIG",
      // Docker / K8s
      "DOCKER_HOST",
      "KUBECONFIG",
      // Node / npm
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "npm_config_registry",
      // General
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "SSL_CERT_FILE",
      "CURL_CA_BUNDLE",
      "NODE_EXTRA_CA_CERTS",
      "REQUESTS_CA_BUNDLE",
      // XDG (config paths for gh, gcloud, etc.)
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      // SSH agent socket — required for git/jj operations that use SSH remotes.
      // Without this, subprocesses cannot reach the agent and fall back to
      // prompting for the key passphrase directly on the TTY, which corrupts
      // Claude Code's PTY ownership.
      "SSH_AUTH_SOCK",
      "SSH_AGENT_PID",
      // Virtual environments (direnv, nix devshells, asdf, mise, etc.)
      "DIRENV_DIR",
      "DIRENV_FILE",
      "DIRENV_DIFF",
      "DIRENV_WATCHES",
      "DIRENV_LAYOUT_DIR",
      "NIX_PATH",
      "NIX_PROFILES",
      "NIX_SSL_CERT_FILE",
      "NIX_CC",
      "NIX_STORE",
      "NIX_BUILD_CORES",
      "IN_NIX_SHELL",
      "LOCALE_ARCHIVE",
      "LD_LIBRARY_PATH",
      "DYLD_LIBRARY_PATH",
      "LIBRARY_PATH",
      "C_INCLUDE_PATH",
      "CPLUS_INCLUDE_PATH",
      "PKG_CONFIG_PATH",
      "CMAKE_PREFIX_PATH",
      "GOPATH",
      "GOROOT",
      "CARGO_HOME",
      "RUSTUP_HOME",
      "ASDF_DIR",
      "ASDF_DATA_DIR",
      "MISE_DATA_DIR",
      "VIRTUAL_ENV",
      "CONDA_PREFIX",
      "CONDA_DEFAULT_ENV",
      "PYTHONPATH",
      "GEM_HOME",
      "GEM_PATH",
      "BUNDLE_PATH",
      "RBENV_ROOT",
      "JAVA_HOME",
      "SDKMAN_DIR",
    ];

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? (isWin ? "" : "/usr/local/bin:/usr/bin:/bin"),
      HOME: realHome,
      TMPDIR: tmpDir,
      LANG: "en_US.UTF-8",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUNBUFFERED: "1",
      PYTHONUTF8: "1",
      NO_COLOR: "1",
    };

    // Windows-critical env vars
    if (isWin) {
      const winVars = [
        "SYSTEMROOT", "SystemRoot", "COMSPEC", "PATHEXT",
        "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
      ];
      for (const key of winVars) {
        if (process.env[key]) env[key] = process.env[key]!;
      }
      // Prevent MSYS2/Git Bash from converting non-ASCII Windows paths
      // (e.g. Chinese characters in project paths) to POSIX paths.
      env["MSYS_NO_PATHCONV"] = "1";
      env["MSYS2_ARG_CONV_EXCL"] = "*";
      // Ensure Git Bash unix tools (cat, ls, head, etc.) are on PATH.
      // The MCP server process may not inherit the full user PATH that
      // includes Git's usr/bin directory.
      const gitUsrBin = "C:\\Program Files\\Git\\usr\\bin";
      const gitBin = "C:\\Program Files\\Git\\bin";
      if (!env["PATH"].includes(gitUsrBin)) {
        env["PATH"] = `${gitUsrBin};${gitBin};${env["PATH"]}`;
      }
    }

    for (const key of passthrough) {
      if (process.env[key]) {
        env[key] = process.env[key]!;
      }
    }

    // Apply user-configured env passthrough
    if (this.#envPassthrough === true) {
      // Inherit all parent env vars; built-in whitelist takes precedence on conflicts
      for (const [key, value] of Object.entries(process.env)) {
        if (key && value !== undefined && !(key in env)) {
          env[key] = value;
        }
      }
    } else if (Array.isArray(this.#envPassthrough)) {
      for (const pattern of this.#envPassthrough) {
        if (pattern.includes("*")) {
          // Wildcard pattern — match against all env var names
          const regex = new RegExp(
            "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
          );
          for (const [key, value] of Object.entries(process.env)) {
            if (key && value !== undefined && regex.test(key) && !(key in env)) {
              env[key] = value;
            }
          }
        } else if (process.env[pattern] && !(pattern in env)) {
          // Exact match
          env[pattern] = process.env[pattern]!;
        }
      }
    }

    // Ensure SSL_CERT_FILE is set so Python/Ruby HTTPS works in sandbox.
    // On macOS, it's typically unset (Python uses its own bundle or none),
    // causing urllib/requests to fail with SSL cert verification errors.
    if (!env["SSL_CERT_FILE"]) {
      const certPaths = isWin ? [] : [
        "/etc/ssl/cert.pem",                         // macOS, some Linux
        "/etc/ssl/certs/ca-certificates.crt",         // Debian/Ubuntu/Alpine
        "/etc/pki/tls/certs/ca-bundle.crt",           // RHEL/CentOS/Fedora
        "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", // Fedora alt
      ];
      for (const p of certPaths) {
        if (existsSync(p)) {
          env["SSL_CERT_FILE"] = p;
          break;
        }
      }
    }

    return env;
  }

  #wrapWithFileContent(
    absolutePath: string,
    language: Language,
    code: string,
  ): string {
    const escaped = JSON.stringify(absolutePath);
    switch (language) {
      case "javascript":
      case "typescript":
        return `const FILE_CONTENT_PATH = ${escaped};\nconst file_path = FILE_CONTENT_PATH;\nconst FILE_CONTENT = require("fs").readFileSync(FILE_CONTENT_PATH, "utf-8");\n${code}`;
      case "python":
        return `FILE_CONTENT_PATH = ${escaped}\nfile_path = FILE_CONTENT_PATH\nwith open(FILE_CONTENT_PATH, "r", encoding="utf-8") as _f:\n    FILE_CONTENT = _f.read()\n${code}`;
      case "shell": {
        // Single-quote the path to prevent $, backtick, and ! expansion
        const sq = "'" + absolutePath.replace(/'/g, "'\\''") + "'";
        return `FILE_CONTENT_PATH=${sq}\nfile_path=${sq}\nFILE_CONTENT=$(cat ${sq})\n${code}`;
      }
      case "ruby":
        return `FILE_CONTENT_PATH = ${escaped}\nfile_path = FILE_CONTENT_PATH\nFILE_CONTENT = File.read(FILE_CONTENT_PATH, encoding: "utf-8")\n${code}`;
      case "go":
        return `package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nvar FILE_CONTENT_PATH = ${escaped}\nvar file_path = FILE_CONTENT_PATH\n\nfunc main() {\n\tb, _ := os.ReadFile(FILE_CONTENT_PATH)\n\tFILE_CONTENT := string(b)\n\t_ = FILE_CONTENT\n\t_ = fmt.Sprint()\n${code}\n}\n`;
      case "rust":
        return `use std::fs;\n\nfn main() {\n    let file_content_path = ${escaped};\n    let file_path = file_content_path;\n    let file_content = fs::read_to_string(file_content_path).unwrap();\n${code}\n}\n`;
      case "php":
        return `<?php\n$FILE_CONTENT_PATH = ${escaped};\n$file_path = $FILE_CONTENT_PATH;\n$FILE_CONTENT = file_get_contents($FILE_CONTENT_PATH);\n${code}`;
      case "perl":
        return `my $FILE_CONTENT_PATH = ${escaped};\nmy $file_path = $FILE_CONTENT_PATH;\nopen(my $fh, '<:encoding(UTF-8)', $FILE_CONTENT_PATH) or die "Cannot open: $!";\nmy $FILE_CONTENT = do { local $/; <$fh> };\nclose($fh);\n${code}`;
      case "r":
        return `FILE_CONTENT_PATH <- ${escaped}\nfile_path <- FILE_CONTENT_PATH\nFILE_CONTENT <- readLines(FILE_CONTENT_PATH, warn=FALSE, encoding="UTF-8")\nFILE_CONTENT <- paste(FILE_CONTENT, collapse="\\n")\n${code}`;
      case "elixir":
        return `file_content_path = ${escaped}\nfile_path = file_content_path\nfile_content = File.read!(file_content_path)\n${code}`;
    }
  }
}
