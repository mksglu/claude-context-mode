/**
 * Security Module — Pattern Matching Tests
 *
 * Tests for parseBashPattern, globToRegex, matchesAnyPattern,
 * chained command splitting, shell-escape scanning, and file path evaluation.
 */

import { describe, test, beforeAll, afterAll } from "vitest";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";

import {
  parseBashPattern,
  globToRegex,
  matchesAnyPattern,
  splitChainedCommands,
  readBashPolicies,
  evaluateCommand,
  evaluateCommandDenyOnly,
  parseToolPattern,
  readToolDenyPatterns,
  fileGlobToRegex,
  evaluateFilePath,
  extractShellCommands,
} from "../build/security.js";

describe("parseBashPattern", () => {
  test("parseBashPattern: extracts glob from Bash(glob)", () => {
    assert.equal(parseBashPattern("Bash(sudo *)"), "sudo *");
  });

  test("parseBashPattern: handles colon format", () => {
    assert.equal(parseBashPattern("Bash(tree:*)"), "tree:*");
  });

  test("parseBashPattern: returns null for non-Bash", () => {
    assert.equal(parseBashPattern("Read(.env)"), null);
  });

  test("parseBashPattern: returns null for malformed", () => {
    assert.equal(parseBashPattern("Bash("), null);
    assert.equal(parseBashPattern("notapattern"), null);
  });
});

describe("globToRegex: word boundary tests from SECURITY.md", () => {
  test("glob: 'ls *' matches 'ls -la'", () => {
    assert.ok(globToRegex("ls *").test("ls -la"));
  });

  test("glob: 'ls *' does NOT match 'lsof -i'", () => {
    assert.ok(!globToRegex("ls *").test("lsof -i"));
  });

  test("glob: 'ls*' matches 'lsof -i' (prefix)", () => {
    assert.ok(globToRegex("ls*").test("lsof -i"));
  });

  test("glob: 'ls*' matches 'ls -la'", () => {
    assert.ok(globToRegex("ls*").test("ls -la"));
  });

  test("glob: 'git *' matches 'git commit -m msg'", () => {
    assert.ok(globToRegex("git *").test('git commit -m "msg"'));
  });

  test("glob: '* commit *' matches 'git commit -m msg'", () => {
    assert.ok(globToRegex("* commit *").test('git commit -m "msg"'));
  });
});

describe("globToRegex: colon separator", () => {
  test("glob: 'tree:*' matches 'tree' (no args)", () => {
    assert.ok(globToRegex("tree:*").test("tree"));
  });

  test("glob: 'tree:*' matches 'tree -a'", () => {
    assert.ok(globToRegex("tree:*").test("tree -a"));
  });

  test("glob: 'tree:*' does NOT match 'treemap'", () => {
    assert.ok(!globToRegex("tree:*").test("treemap"));
  });
});

describe("globToRegex: real-world deny patterns", () => {
  test("glob: 'sudo *' matches 'sudo apt install'", () => {
    assert.ok(globToRegex("sudo *").test("sudo apt install"));
  });

  test("glob: 'sudo *' does NOT match 'sudoedit'", () => {
    assert.ok(!globToRegex("sudo *").test("sudoedit"));
  });

  test("glob: 'rm -rf /*' matches 'rm -rf /etc'", () => {
    assert.ok(globToRegex("rm -rf /*").test("rm -rf /etc"));
  });

  test("glob: 'chmod -R 777 *' matches 'chmod -R 777 /tmp'", () => {
    assert.ok(globToRegex("chmod -R 777 *").test("chmod -R 777 /tmp"));
  });
});

describe("globToRegex: case sensitivity", () => {
  test("glob: case-insensitive 'dir *' matches 'DIR /W'", () => {
    assert.ok(globToRegex("dir *", true).test("DIR /W"));
  });

  test("glob: case-sensitive 'dir *' does NOT match 'DIR /W'", () => {
    assert.ok(!globToRegex("dir *", false).test("DIR /W"));
  });
});

describe("matchesAnyPattern", () => {
  test("matchesAnyPattern: returns matching pattern on hit", () => {
    const result = matchesAnyPattern(
      "sudo apt install",
      ["Bash(git:*)", "Bash(sudo *)"],
      false,
    );
    assert.equal(result, "Bash(sudo *)");
  });

  test("matchesAnyPattern: returns null on miss", () => {
    const result = matchesAnyPattern(
      "npm install",
      ["Bash(sudo *)", "Bash(rm -rf /*)"],
      false,
    );
    assert.equal(result, null);
  });
});

describe("Chained Command Splitting", () => {
  test("splitChainedCommands: simple && chain", () => {
    const parts = splitChainedCommands("echo hello && sudo rm -rf /");
    assert.deepEqual(parts, ["echo hello", "sudo rm -rf /"]);
  });

  test("splitChainedCommands: || chain", () => {
    const parts = splitChainedCommands("test -f /tmp/x || sudo reboot");
    assert.deepEqual(parts, ["test -f /tmp/x", "sudo reboot"]);
  });

  test("splitChainedCommands: semicolon chain", () => {
    const parts = splitChainedCommands("cd /tmp; sudo rm -rf /");
    assert.deepEqual(parts, ["cd /tmp", "sudo rm -rf /"]);
  });

  test("splitChainedCommands: pipe chain", () => {
    const parts = splitChainedCommands("cat /etc/passwd | sudo tee /tmp/out");
    assert.deepEqual(parts, ["cat /etc/passwd", "sudo tee /tmp/out"]);
  });

  test("splitChainedCommands: multiple operators", () => {
    const parts = splitChainedCommands("echo a && echo b; sudo rm -rf /");
    assert.deepEqual(parts, ["echo a", "echo b", "sudo rm -rf /"]);
  });

  test("splitChainedCommands: respects double quotes", () => {
    const parts = splitChainedCommands('echo "hello && world"');
    assert.deepEqual(parts, ['echo "hello && world"']);
  });

  test("splitChainedCommands: respects single quotes", () => {
    const parts = splitChainedCommands("echo 'test; value'");
    assert.deepEqual(parts, ["echo 'test; value'"]);
  });

  test("splitChainedCommands: single command unchanged", () => {
    const parts = splitChainedCommands("git status");
    assert.deepEqual(parts, ["git status"]);
  });
});

describe("Chained Command Evaluation", () => {
  let chainTmpBase: string;
  let chainGlobalPath: string;

  beforeAll(() => {
    chainTmpBase = join(tmpdir(), `chain-test-${Date.now()}`);
    const chainGlobalDir = join(chainTmpBase, "global-home", ".claude");
    chainGlobalPath = join(chainGlobalDir, "settings.json");
    mkdirSync(chainGlobalDir, { recursive: true });
    writeFileSync(
      chainGlobalPath,
      JSON.stringify({
        permissions: {
          deny: ["Bash(sudo *)", "Bash(rm -rf /*)"],
          allow: ["Bash(echo:*)", "Bash(git:*)"],
        },
      }),
    );
  });

  afterAll(() => {
    rmSync(chainTmpBase, { recursive: true, force: true });
  });

  test("evaluateCommand: detects 'sudo' in 'echo ok && sudo rm -rf /'", () => {
    const policies = readBashPolicies(undefined, chainGlobalPath);
    const result = evaluateCommand("echo ok && sudo rm -rf /", policies, false);
    assert.equal(result.decision, "deny");
    assert.equal(result.matchedPattern, "Bash(sudo *)");
  });

  test("evaluateCommand: detects 'sudo' after semicolon", () => {
    const policies = readBashPolicies(undefined, chainGlobalPath);
    const result = evaluateCommand("cd /tmp; sudo apt install vim", policies, false);
    assert.equal(result.decision, "deny");
  });

  test("evaluateCommand: detects 'rm -rf' in piped chain", () => {
    const policies = readBashPolicies(undefined, chainGlobalPath);
    const result = evaluateCommand("cat file | rm -rf /etc", policies, false);
    assert.equal(result.decision, "deny");
  });

  test("evaluateCommandDenyOnly: detects chained deny", () => {
    const policies = readBashPolicies(undefined, chainGlobalPath);
    const result = evaluateCommandDenyOnly("echo hello && sudo rm -rf /", policies, false);
    assert.equal(result.decision, "deny");
  });

  test("evaluateCommandDenyOnly: allows safe chained commands", () => {
    const policies = readBashPolicies(undefined, chainGlobalPath);
    const result = evaluateCommandDenyOnly("echo hello && git status", policies, false);
    assert.equal(result.decision, "allow");
  });
});

describe("Settings Reader", () => {
  let tmpBase: string;
  let globalSettingsPath: string;
  let projectDir: string;

  beforeAll(() => {
    tmpBase = join(tmpdir(), `security-test-${Date.now()}`);
    const globalDir = join(tmpBase, "global-home", ".claude");
    globalSettingsPath = join(globalDir, "settings.json");
    projectDir = join(tmpBase, "project");
    const projectClaudeDir = join(projectDir, ".claude");

    mkdirSync(globalDir, { recursive: true });
    mkdirSync(projectClaudeDir, { recursive: true });

    writeFileSync(
      globalSettingsPath,
      JSON.stringify({
        permissions: {
          allow: ["Bash(npm:*)", "Read(.env)"],
          deny: ["Bash(sudo *)"],
        },
      }),
    );

    writeFileSync(
      join(projectClaudeDir, "settings.json"),
      JSON.stringify({
        permissions: {
          deny: ["Bash(npm publish)"],
          allow: [],
        },
      }),
    );
  });

  afterAll(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  test("readBashPolicies: reads global only when no projectDir", () => {
    const policies = readBashPolicies(undefined, globalSettingsPath);
    assert.equal(policies.length, 1, "should have 1 policy (global)");
    assert.deepEqual(policies[0].allow, ["Bash(npm:*)"]);
    assert.deepEqual(policies[0].deny, ["Bash(sudo *)"]);
  });

  test("readBashPolicies: reads project + global with precedence", () => {
    const policies = readBashPolicies(projectDir, globalSettingsPath);
    assert.equal(policies.length, 2, "should have 2 policies");
    assert.deepEqual(policies[0].deny, ["Bash(npm publish)"]);
    assert.deepEqual(policies[1].allow, ["Bash(npm:*)"]);
    assert.deepEqual(policies[1].deny, ["Bash(sudo *)"]);
  });

  test("readBashPolicies: missing files produce empty policies", () => {
    const policies = readBashPolicies("/nonexistent/path", globalSettingsPath);
    assert.equal(policies.length, 1);
  });

  test("evaluateCommand: global allow matches", () => {
    const policies = readBashPolicies(undefined, globalSettingsPath);
    const result = evaluateCommand("npm install", policies, false);
    assert.equal(result.decision, "allow");
    assert.equal(result.matchedPattern, "Bash(npm:*)");
  });

  test("evaluateCommand: global deny beats allow", () => {
    const policies = readBashPolicies(undefined, globalSettingsPath);
    const result = evaluateCommand("sudo npm install", policies, false);
    assert.equal(result.decision, "deny");
    assert.equal(result.matchedPattern, "Bash(sudo *)");
  });

  test("evaluateCommand: local deny overrides global allow", () => {
    const policies = readBashPolicies(projectDir, globalSettingsPath);
    const result = evaluateCommand("npm publish", policies, false);
    assert.equal(result.decision, "deny");
    assert.equal(result.matchedPattern, "Bash(npm publish)");
  });

  test("evaluateCommand: no match returns ask", () => {
    const policies = readBashPolicies(projectDir, globalSettingsPath);
    const result = evaluateCommand("python script.py", policies, false);
    assert.equal(result.decision, "ask");
    assert.equal(result.matchedPattern, undefined);
  });

  test("evaluateCommandDenyOnly: denied command", () => {
    const policies = readBashPolicies(undefined, globalSettingsPath);
    const result = evaluateCommandDenyOnly("sudo rm -rf /", policies, false);
    assert.equal(result.decision, "deny");
    assert.equal(result.matchedPattern, "Bash(sudo *)");
  });

  test("evaluateCommandDenyOnly: non-denied returns allow", () => {
    const policies = readBashPolicies(undefined, globalSettingsPath);
    const result = evaluateCommandDenyOnly("npm install", policies, false);
    assert.equal(result.decision, "allow");
    assert.equal(result.matchedPattern, undefined);
  });
});

describe("Tool Pattern Parsing", () => {
  test("parseToolPattern: Read(.env)", () => {
    const result = parseToolPattern("Read(.env)");
    assert.deepEqual(result, { tool: "Read", glob: ".env" });
  });

  test("parseToolPattern: Grep(**/*.ts)", () => {
    const result = parseToolPattern("Grep(**/*.ts)");
    assert.deepEqual(result, { tool: "Grep", glob: "**/*.ts" });
  });

  test("parseToolPattern: Bash(sudo *)", () => {
    const result = parseToolPattern("Bash(sudo *)");
    assert.deepEqual(result, { tool: "Bash", glob: "sudo *" });
  });

  test("parseToolPattern: returns null for bare string", () => {
    assert.equal(parseToolPattern("notapattern"), null);
  });
});

describe("readToolDenyPatterns", () => {
  let toolDenyTmpBase: string;
  let toolDenyGlobalPath: string;

  beforeAll(() => {
    toolDenyTmpBase = join(tmpdir(), `tool-deny-test-${Date.now()}`);
    const toolDenyGlobalDir = join(toolDenyTmpBase, "global-home", ".claude");
    toolDenyGlobalPath = join(toolDenyGlobalDir, "settings.json");

    mkdirSync(toolDenyGlobalDir, { recursive: true });
    writeFileSync(
      toolDenyGlobalPath,
      JSON.stringify({
        permissions: {
          deny: [
            "Read(.env)",
            "Read(**/.env)",
            "Read(**/*credentials*)",
            "Bash(sudo *)",
            "Bash(rm -rf /*)",
          ],
          allow: [],
        },
      }),
    );
  });

  afterAll(() => {
    rmSync(toolDenyTmpBase, { recursive: true, force: true });
  });

  test("readToolDenyPatterns: returns only Read globs for Read", () => {
    const result = readToolDenyPatterns("Read", undefined, toolDenyGlobalPath);
    assert.equal(result.length, 1, "should have 1 settings file");
    assert.deepEqual(result[0], [".env", "**/.env", "**/*credentials*"]);
  });

  test("readToolDenyPatterns: returns only Bash globs for Bash", () => {
    const result = readToolDenyPatterns("Bash", undefined, toolDenyGlobalPath);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], ["sudo *", "rm -rf /*"]);
  });

  test("readToolDenyPatterns: returns empty for Grep (no patterns)", () => {
    const result = readToolDenyPatterns("Grep", undefined, toolDenyGlobalPath);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], []);
  });
});

describe("File Glob Matching", () => {
  test("fileGlobToRegex: '.env' matches exactly '.env'", () => {
    assert.ok(fileGlobToRegex(".env").test(".env"));
  });

  test("fileGlobToRegex: '.env' does not match 'src/.env'", () => {
    assert.ok(!fileGlobToRegex(".env").test("src/.env"));
  });

  test("fileGlobToRegex: '**/.env' matches 'deep/nested/.env'", () => {
    assert.ok(fileGlobToRegex("**/.env").test("deep/nested/.env"));
  });

  test("fileGlobToRegex: '**/.env' matches '.env' at root", () => {
    assert.ok(fileGlobToRegex("**/.env").test(".env"));
  });

  test("fileGlobToRegex: '**/*credentials*' matches nested path", () => {
    assert.ok(fileGlobToRegex("**/*credentials*").test("secrets/credentials.json"));
  });

  test("fileGlobToRegex: '**/*credentials*' does not match 'readme.md'", () => {
    assert.ok(!fileGlobToRegex("**/*credentials*").test("readme.md"));
  });
});

describe("evaluateFilePath", () => {
  test("evaluateFilePath: .env denied by ['.env']", () => {
    const result = evaluateFilePath(".env", [[".env"]], false);
    assert.equal(result.denied, true);
    assert.equal(result.matchedPattern, ".env");
  });

  test("evaluateFilePath: src/config.ts not denied by ['.env']", () => {
    const result = evaluateFilePath("src/config.ts", [[".env"]], false);
    assert.equal(result.denied, false);
    assert.equal(result.matchedPattern, undefined);
  });

  test("evaluateFilePath: deep/nested/.env denied by ['**/.env']", () => {
    const result = evaluateFilePath("deep/nested/.env", [["**/.env"]], false);
    assert.equal(result.denied, true);
    assert.equal(result.matchedPattern, "**/.env");
  });

  test("evaluateFilePath: credentials file denied by ['**/*credentials*']", () => {
    const result = evaluateFilePath(
      "secrets/credentials.json",
      [["**/*credentials*"]],
      false,
    );
    assert.equal(result.denied, true);
    assert.equal(result.matchedPattern, "**/*credentials*");
  });

  test("evaluateFilePath: readme.md not denied by ['**/*credentials*']", () => {
    const result = evaluateFilePath("readme.md", [["**/*credentials*"]], false);
    assert.equal(result.denied, false);
  });

  test("evaluateFilePath: Windows path with backslashes", () => {
    const result = evaluateFilePath(
      "C:\\Users\\.env",
      [["**/.env"]],
      true,
    );
    assert.equal(result.denied, true);
    assert.equal(result.matchedPattern, "**/.env");
  });

  test("evaluateFilePath: traversal does not bypass absolute deny glob when projectRoot is supplied", () => {
    // An absolute deny rule for ~/.ssh/** should still match when the caller
    // passes a ../-traversal relative path that resolves into ~/.ssh.
    const home = homedir();
    const projectRoot = resolve(home, "some/project");
    const denyGlob = resolve(home, ".ssh").replace(/\\/g, "/") + "/**";

    const result = evaluateFilePath(
      "../../.ssh/id_rsa",
      [[denyGlob]],
      process.platform === "win32",
      projectRoot,
    );
    assert.equal(result.denied, true);
    assert.equal(result.matchedPattern, denyGlob);
  });

  test("evaluateFilePath: without projectRoot, absolute deny glob is still bypassable (regression guard)", () => {
    // Documents the pre-fix behavior: without projectRoot, `..` is not
    // resolved, so the raw string doesn't match the absolute glob.
    // This test exists so any change in behavior is intentional.
    const absoluteSshGlob = resolve(homedir(), ".ssh").replace(/\\/g, "/") + "/**";
    const result = evaluateFilePath(
      "../../.ssh/id_rsa",
      [[absoluteSshGlob]],
      process.platform === "win32",
    );
    assert.equal(result.denied, false);
  });
});

describe("Shell-Escape Scanner", () => {
  test("extractShellCommands: Python os.system", () => {
    const result = extractShellCommands(
      'os.system("sudo rm -rf /")',
      "python",
    );
    assert.deepEqual(result, ["sudo rm -rf /"]);
  });

  test("extractShellCommands: Python subprocess.run string", () => {
    const result = extractShellCommands(
      'subprocess.run("sudo apt install vim")',
      "python",
    );
    assert.deepEqual(result, ["sudo apt install vim"]);
  });

  test("extractShellCommands: Python subprocess.run list args", () => {
    const result = extractShellCommands(
      'subprocess.run(["rm", "-rf", "/"])',
      "python",
    );
    assert.ok(result.length > 0, "should extract commands from list form");
    assert.ok(
      result.some((cmd) => cmd.includes("rm") && cmd.includes("-rf")),
      `should join list args into command string, got: ${JSON.stringify(result)}`,
    );
  });

  test("extractShellCommands: Python subprocess.call list args", () => {
    const result = extractShellCommands(
      'subprocess.call(["sudo", "reboot"])',
      "python",
    );
    assert.ok(result.some((cmd) => cmd.includes("sudo") && cmd.includes("reboot")));
  });

  test("extractShellCommands: JS execSync", () => {
    const cmds = extractShellCommands(
      'const r = execSync("sudo apt update")',
      "javascript",
    );
    assert.deepEqual(cmds, ["sudo apt update"]);
  });

  test("extractShellCommands: JS spawnSync", () => {
    const cmds = extractShellCommands(
      'spawnSync("sudo", ["rm", "-rf"])',
      "javascript",
    );
    assert.ok(cmds.length > 0, "should detect spawnSync");
    assert.ok(cmds[0].includes("sudo"));
  });

  test("extractShellCommands: Ruby system()", () => {
    const result = extractShellCommands(
      'system("sudo rm -rf /tmp")',
      "ruby",
    );
    assert.deepEqual(result, ["sudo rm -rf /tmp"]);
  });

  test("extractShellCommands: Go exec.Command", () => {
    const result = extractShellCommands(
      'exec.Command("sudo", "rm", "-rf")',
      "go",
    );
    assert.ok(result.length > 0, "should detect Go exec.Command");
    assert.ok(result[0].includes("sudo"));
  });

  test("extractShellCommands: PHP shell_exec", () => {
    const result = extractShellCommands(
      'shell_exec("sudo rm -rf /tmp")',
      "php",
    );
    assert.ok(result.length > 0, "should detect PHP shell_exec");
    assert.ok(result[0].includes("sudo"));
  });

  test("extractShellCommands: PHP system()", () => {
    const result = extractShellCommands(
      'system("sudo reboot")',
      "php",
    );
    assert.ok(result.length > 0, "should detect PHP system()");
  });

  test("extractShellCommands: Rust Command::new", () => {
    const result = extractShellCommands(
      'Command::new("sudo").arg("reboot")',
      "rust",
    );
    assert.ok(result.length > 0, "should detect Rust Command::new");
    assert.ok(result[0].includes("sudo"));
  });

  test("extractShellCommands: safe JS code returns empty", () => {
    const result = extractShellCommands(
      'console.log("hello")',
      "javascript",
    );
    assert.deepEqual(result, []);
  });

  test("extractShellCommands: unknown language returns empty", () => {
    const result = extractShellCommands(
      'os.system("rm -rf /")',
      "haskell",
    );
    assert.deepEqual(result, []);
  });
});
