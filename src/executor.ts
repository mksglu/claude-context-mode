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

const isWin = process.platform === "win32";

/** Kill process tree — on Windows, proc.kill() only kills the shell, not children. */
function killTree(proc: ReturnType<typeof spawn>): void {
  if (isWin && proc.pid) {
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "pipe" });
    } catch { /* already dead */ }
  } else {
    proc.kill("SIGKILL");
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

interface ExecuteOptions {
  language: Language;
  code: string;
  timeout?: number;
}

interface ExecuteFileOptions extends ExecuteOptions {
  path: string;
}

export class PolyglotExecutor {
  #maxOutputBytes: number;
  #hardCapBytes: number;
  #projectRoot: string;
  #runtimes: RuntimeMap;

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

  async execute(opts: ExecuteOptions): Promise<ExecResult> {
    const { language, code, timeout = 30_000 } = opts;
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-mode-"));

    try {
      const filePath = this.#writeScript(tmpDir, code, language);
      const cmd = buildCommand(this.#runtimes, language, filePath);

      // Rust: compile then run
      if (cmd[0] === "__rust_compile_run__") {
        return await this.#compileAndRun(filePath, tmpDir, timeout);
      }

      return await this.#spawn(cmd, tmpDir, timeout);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
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

  /**
   * Smart truncation: keeps head (60%) + tail (40%) of output,
   * preserving both initial context and final error messages.
   * Snaps to line boundaries and handles UTF-8 safely.
   */
  static #smartTruncate(raw: string, max: number): string {
    if (Buffer.byteLength(raw) <= max) return raw;

    const lines = raw.split("\n");

    // Budget: 60% head, 40% tail (errors/results are usually at the end)
    const headBudget = Math.floor(max * 0.6);
    const tailBudget = max - headBudget;

    // Collect head lines
    const headLines: string[] = [];
    let headBytes = 0;
    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line) + 1; // +1 for \n
      if (headBytes + lineBytes > headBudget) break;
      headLines.push(line);
      headBytes += lineBytes;
    }

    // Collect tail lines (from end)
    const tailLines: string[] = [];
    let tailBytes = 0;
    for (let i = lines.length - 1; i >= headLines.length; i--) {
      const lineBytes = Buffer.byteLength(lines[i]) + 1;
      if (tailBytes + lineBytes > tailBudget) break;
      tailLines.unshift(lines[i]);
      tailBytes += lineBytes;
    }

    const skippedLines =
      lines.length - headLines.length - tailLines.length;
    const skippedBytes =
      Buffer.byteLength(raw) - headBytes - tailBytes;

    const separator = `\n\n... [${skippedLines} lines / ${(skippedBytes / 1024).toFixed(1)}KB truncated — showing first ${headLines.length} + last ${tailLines.length} lines] ...\n\n`;

    return headLines.join("\n") + separator + tailLines.join("\n");
  }

  async #spawn(
    cmd: string[],
    cwd: string,
    timeout: number,
  ): Promise<ExecResult> {
    return new Promise((res) => {
      const proc = spawn(cmd[0], cmd.slice(1), {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: this.#buildSafeEnv(cwd),
        shell: isWin,
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(proc);
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
        const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
        let rawStderr = Buffer.concat(stderrChunks).toString("utf-8");

        if (capExceeded) {
          rawStderr += `\n[output capped at ${(this.#hardCapBytes / 1024 / 1024).toFixed(0)}MB — process killed]`;
        }

        const max = this.#maxOutputBytes;
        const stdout = PolyglotExecutor.#smartTruncate(rawStdout, max);
        const stderr = PolyglotExecutor.#smartTruncate(rawStderr, max);

        res({
          stdout,
          stderr,
          exitCode: timedOut ? 1 : (exitCode ?? 1),
          timedOut,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
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
      // XDG (config paths for gh, gcloud, etc.)
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ];

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? (isWin ? "" : "/usr/local/bin:/usr/bin:/bin"),
      HOME: realHome,
      TMPDIR: tmpDir,
      LANG: "en_US.UTF-8",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUNBUFFERED: "1",
      NO_COLOR: "1",
    };

    // Windows-critical env vars
    if (isWin) {
      const winVars = [
        "SYSTEMROOT", "SystemRoot", "COMSPEC", "PATHEXT",
        "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
        "GOROOT", "GOPATH",
      ];
      for (const key of winVars) {
        if (process.env[key]) env[key] = process.env[key]!;
      }
    }

    for (const key of passthrough) {
      if (process.env[key]) {
        env[key] = process.env[key]!;
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
        return `const FILE_CONTENT_PATH = ${escaped};\nconst FILE_CONTENT = require("fs").readFileSync(FILE_CONTENT_PATH, "utf-8");\n${code}`;
      case "python":
        return `FILE_CONTENT_PATH = ${escaped}\nwith open(FILE_CONTENT_PATH, "r") as _f:\n    FILE_CONTENT = _f.read()\n${code}`;
      case "shell": {
        // Single-quote the path to prevent $, backtick, and ! expansion
        const sq = "'" + absolutePath.replace(/'/g, "'\\''") + "'";
        return `FILE_CONTENT_PATH=${sq}\nFILE_CONTENT=$(cat ${sq})\n${code}`;
      }
      case "ruby":
        return `FILE_CONTENT_PATH = ${escaped}\nFILE_CONTENT = File.read(FILE_CONTENT_PATH)\n${code}`;
      case "go":
        return `package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nvar FILE_CONTENT_PATH = ${escaped}\n\nfunc main() {\n\tb, _ := os.ReadFile(FILE_CONTENT_PATH)\n\tFILE_CONTENT := string(b)\n\t_ = FILE_CONTENT\n\t_ = fmt.Sprint()\n${code}\n}\n`;
      case "rust":
        return `use std::fs;\n\nfn main() {\n    let file_content_path = ${escaped};\n    let file_content = fs::read_to_string(file_content_path).unwrap();\n${code}\n}\n`;
      case "php":
        return `<?php\n$FILE_CONTENT_PATH = ${escaped};\n$FILE_CONTENT = file_get_contents($FILE_CONTENT_PATH);\n${code}`;
      case "perl":
        return `my $FILE_CONTENT_PATH = ${escaped};\nopen(my $fh, '<', $FILE_CONTENT_PATH) or die "Cannot open: $!";\nmy $FILE_CONTENT = do { local $/; <$fh> };\nclose($fh);\n${code}`;
      case "r":
        return `FILE_CONTENT_PATH <- ${escaped}\nFILE_CONTENT <- readLines(FILE_CONTENT_PATH, warn=FALSE)\nFILE_CONTENT <- paste(FILE_CONTENT, collapse="\\n")\n${code}`;
      case "elixir":
        return `file_content_path = ${escaped}\nfile_content = File.read!(file_content_path)\n${code}`;
    }
  }
}
