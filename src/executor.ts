import { spawn, execSync, execFileSync } from "node:child_process";
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

  /** PIDs of backgrounded processes — killed on cleanup to prevent zombies. */
  #backgroundedPids = new Set<number>();

  constructor(opts?: {
    maxOutputBytes?: number;
    hardCapBytes?: number;
    projectRoot?: string;
    runtimes?: RuntimeMap;
  }) {
    this.#maxOutputBytes = opts?.maxOutputBytes ?? 102_400;
    this.#hardCapBytes = opts?.hardCapBytes ?? 100 * 1024 * 1024; // 100MB
    this.#projectRoot = opts?.projectRoot ?? process.cwd();
    this.#runtimes = opts?.runtimes ?? detectRuntimes();
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
    const tmpDir = mkdtempSync(join(tmpdir(), ".ctx-mode-"));

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
      execFileSync("rustc", [srcPath, "-o", binPath], {
        cwd,
        timeout: Math.min(timeout, 60_000),
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

    // Denylist: env vars that corrupt sandbox stdout, inject code, or break
    // language runtimes. Each entry is backed by CVE, MITRE, or live testing.
    // See: https://www.elttam.com/blog/env/, MITRE T1574.006
    const DENIED = new Set([
      // Shell — auto-execute scripts, override builtins
      "BASH_ENV",             // sourced by non-interactive bash
      "ENV",                  // sourced by sh/dash
      "PROMPT_COMMAND",       // runs before each prompt
      "PS4",                  // $(cmd) expansion in xtrace
      "SHELLOPTS",            // enables xtrace/verbose, dumps to stdout
      "BASHOPTS",             // bash-specific shell options
      "CDPATH",               // makes cd print to stdout
      "INPUTRC",              // readline key rebinding
      "BASH_XTRACEFD",        // redirects debug output to stdout
      // Node.js — require injection, inspector
      "NODE_OPTIONS",         // --require, --loader, --inspect
      "NODE_PATH",            // module search path injection
      // Python — stdlib override, startup injection
      "PYTHONSTARTUP",        // auto-executes in interactive mode
      "PYTHONHOME",           // overrides stdlib location (breaks Python)
      "PYTHONWARNINGS",       // triggers module import chain → RCE
      "PYTHONBREAKPOINT",     // arbitrary callable
      "PYTHONINSPECT",        // enters interactive mode after script
      // Ruby — option/module injection
      "RUBYOPT",              // injects CLI options (-r loads files)
      "RUBYLIB",              // module search path injection
      // Perl — option/module injection
      "PERL5OPT",             // injects CLI options (-M runs code)
      "PERL5LIB",             // module search path injection
      "PERLLIB",              // legacy module search path
      "PERL5DB",              // debugger command injection
      // Elixir/Erlang — eval injection
      "ERL_AFLAGS",           // prepends erl flags (-eval runs code)
      "ERL_FLAGS",            // appends erl flags
      "ELIXIR_ERL_OPTIONS",   // Elixir-specific erl flags
      "ERL_LIBS",             // beam file loading
      // Go — compiler/linker injection
      "GOFLAGS",              // injects go command flags
      "CGO_CFLAGS",           // C compiler flag injection
      "CGO_LDFLAGS",          // linker flag injection
      // Rust — compiler substitution
      "RUSTC",                // arbitrary compiler binary
      "RUSTC_WRAPPER",        // compiler wrapper injection
      "RUSTC_WORKSPACE_WRAPPER",
      "CARGO_BUILD_RUSTC",
      "CARGO_BUILD_RUSTC_WRAPPER",
      "RUSTFLAGS",            // compiler flag injection
      // PHP — config injection
      "PHPRC",                // auto_prepend_file → RCE
      "PHP_INI_SCAN_DIR",     // additional .ini loading
      // R — startup script injection
      "R_PROFILE",            // site-wide R profile
      "R_PROFILE_USER",       // user R profile
      "R_HOME",               // R installation override
      // Dynamic linker — shared library injection
      "LD_PRELOAD",           // loads .so before all others (Linux)
      "DYLD_INSERT_LIBRARIES", // macOS equivalent of LD_PRELOAD
      // OpenSSL — engine loading
      "OPENSSL_CONF",         // loads engine modules → .so exec
      "OPENSSL_ENGINES",      // engine directory override
      // Compiler — binary substitution
      "CC",                   // C compiler override
      "CXX",                  // C++ compiler override
      "AR",                   // archiver override
      // Git — command injection via hooks/config
      "GIT_TEMPLATE_DIR",     // hook injection on git init
      "GIT_CONFIG_GLOBAL",    // core.pager/editor runs commands
      "GIT_CONFIG_SYSTEM",    // system-level config injection
      "GIT_EXEC_PATH",        // substitute git subcommands
      "GIT_SSH",              // arbitrary command instead of ssh
      "GIT_SSH_COMMAND",      // arbitrary ssh command
      "GIT_ASKPASS",          // arbitrary credential command
    ]);

    // Start with parent env, then strip dangerous vars and apply overrides
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(process.env)) {
      if (val !== undefined && !DENIED.has(key) && !key.startsWith("BASH_FUNC_")) {
        env[key] = val;
      }
    }

    // Sandbox overrides — forced values for correct sandbox behavior
    env["TMPDIR"] = tmpDir;
    env["HOME"] = realHome;
    env["LANG"] = "en_US.UTF-8";
    env["PYTHONDONTWRITEBYTECODE"] = "1";
    env["PYTHONUNBUFFERED"] = "1";
    env["PYTHONUTF8"] = "1";
    env["NO_COLOR"] = "1";
    // Windows uses "Path" (not "PATH") — normalize to "PATH" for consistency
    if (isWin && !env["PATH"] && env["Path"]) {
      env["PATH"] = env["Path"];
      delete env["Path"];
    }
    if (!env["PATH"]) {
      env["PATH"] = isWin ? "" : "/usr/local/bin:/usr/bin:/bin";
    }

    // Windows-critical env vars and path fixes
    if (isWin) {
      env["MSYS_NO_PATHCONV"] = "1";
      env["MSYS2_ARG_CONV_EXCL"] = "*";
      const gitUsrBin = "C:\\Program Files\\Git\\usr\\bin";
      const gitBin = "C:\\Program Files\\Git\\bin";
      if (!env["PATH"].includes(gitUsrBin)) {
        env["PATH"] = `${gitUsrBin};${gitBin};${env["PATH"]}`;
      }
    }

    // Ensure SSL_CERT_FILE is set so Python/Ruby HTTPS works in sandbox.
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
        return `#![allow(unused_variables)]\nuse std::fs;\n\nfn main() {\n    let file_content_path = ${escaped};\n    let file_path = file_content_path;\n    let file_content = fs::read_to_string(file_content_path).unwrap();\n${code}\n}\n`;
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
