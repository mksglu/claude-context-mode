import { describe, test, expect, afterAll } from "vitest";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PolyglotExecutor, buildScriptFilename, buildSpawnOptions } from "../src/executor.js";
import {
  detectRuntimes,
  buildCommand,
  getRuntimeSummary,
  type RuntimeMap,
} from "../src/runtime.js";

const runtimes = detectRuntimes();
const executor = new PolyglotExecutor({ runtimes });

describe("Runtime Detection", () => {
  test("detects JavaScript runtime (bun or node)", async () => {
    const isBun = runtimes.javascript.endsWith("bun");
    const isAbsoluteNode = runtimes.javascript.startsWith("/") || runtimes.javascript.includes("\\");
    assert.ok(
      isBun || isAbsoluteNode,
      `Expected bun path or absolute node path, got: ${runtimes.javascript}`,
    );
  });

  test("detects JavaScript runtime (bun or absolute node path)", async () => {
    // runtimes.javascript is either a bun path/command or process.execPath —
    // never the bare string "node", since snap/wrapper envs need the real binary.
    const isBun = runtimes.javascript.endsWith("bun");
    const isAbsoluteNode = runtimes.javascript.startsWith("/") || runtimes.javascript.includes("\\");
    assert.ok(
      isBun || isAbsoluteNode,
      `Expected bun path or absolute node path, got: ${runtimes.javascript}`,
    );
  });

  test("buildCommand: javascript uses executable path, not bare 'node'", async () => {
    const cmd = buildCommand(runtimes, "javascript", "/tmp/test.js");
    assert.notEqual(cmd[0], "node", "Should not use bare 'node' — use process.execPath or full bun path");
    assert.equal(cmd[cmd.length - 1], "/tmp/test.js");
  });

  test("buildCommand: javascript with bun-path runtime uses 'run' subcommand", async () => {
    const bunRuntimes: RuntimeMap = { ...runtimes, javascript: "/home/user/.bun/bin/bun" };
    const cmd = buildCommand(bunRuntimes, "javascript", "/tmp/test.js");
    assert.equal(cmd[0], "/home/user/.bun/bin/bun");
    assert.equal(cmd[1], "run");
    assert.equal(cmd[2], "/tmp/test.js");
  });

  test("detects Shell runtime (non-empty string)", async () => {
    assert.ok(
      typeof runtimes.shell === "string" && runtimes.shell.length > 0,
      `Got: ${runtimes.shell}`,
    );
  });

  if (process.platform === "win32") {
    test("Windows: shell is Git Bash or fallback, never WSL bash", async () => {
      const shell = runtimes.shell.toLowerCase();
      assert.ok(
        !shell.includes("system32") && !shell.includes("windowsapps"),
        `Shell should not be WSL bash, got: ${runtimes.shell}`,
      );
    });

    test("Windows: shell execute works with non-ASCII (Chinese) project path", async () => {
      const { mkdirSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const chineseDir = join(tmpdir(), "测试目录");
      try { mkdirSync(chineseDir, { recursive: true }); } catch {}
      const chineseExecutor = new PolyglotExecutor({ runtimes, projectRoot: chineseDir });
      const r = await chineseExecutor.execute({ language: "shell", code: 'echo "chinese path ok"' });
      assert.equal(r.exitCode, 0, `Failed with stderr: ${r.stderr}`);
      assert.ok(r.stdout.includes("chinese path ok"), `Got: ${r.stdout}`);
      try { rmSync(chineseDir, { recursive: true, force: true }); } catch {}
    });
  }

  test("detects TypeScript runtime", async () => {
    assert.ok(runtimes.typescript !== null, "No TS runtime found");
  });

  test("detects Python runtime", async () => {
    assert.ok(runtimes.python !== null, "No Python runtime found");
  });

  test("buildCommand: correct JS command structure", async () => {
    const cmd = buildCommand(runtimes, "javascript", "/tmp/test.js");
    assert.ok(cmd.length >= 2);
    assert.ok(cmd[cmd.length - 1] === "/tmp/test.js");
  });

  test("buildCommand: throws for unavailable runtime", async () => {
    const noRuntimes: RuntimeMap = {
      javascript: "node",
      typescript: null,
      python: null,
      shell: "sh",
      ruby: null,
      go: null,
      rust: null,
      php: null,
      perl: null,
      r: null,
      elixir: null,
    };
    assert.throws(
      () => buildCommand(noRuntimes, "typescript", "/tmp/t.ts"),
      /No TypeScript runtime/,
    );
    assert.throws(
      () => buildCommand(noRuntimes, "python", "/tmp/t.py"),
      /No Python runtime/,
    );
    assert.throws(
      () => buildCommand(noRuntimes, "ruby", "/tmp/t.rb"),
      /Ruby not available/,
    );
    assert.throws(
      () => buildCommand(noRuntimes, "elixir", "/tmp/t.exs"),
      /Elixir not available/,
    );
  });
});

describe("JavaScript Execution", () => {
  test("JS: hello world", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("hello from js");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from js"));
    assert.equal(r.timedOut, false);
  });

  test("JS: variables, math, template literals", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: "const x = 42; const y = 58; console.log(`sum: ${x + y}`);",
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 100"));
  });

  test("JS: JSON parse + transform", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: `
        const data = [
          { name: "Alice", age: 30 },
          { name: "Bob", age: 25 },
          { name: "Charlie", age: 35 }
        ];
        const avg = data.reduce((s, d) => s + d.age, 0) / data.length;
        console.log(JSON.stringify({ count: data.length, avgAge: avg.toFixed(1) }));
      `,
    });
    assert.equal(r.exitCode, 0);
    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.count, 3);
    assert.equal(output.avgAge, "30.0");
  });

  test("JS: async/await + setTimeout", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: `
        async function work() {
          return new Promise(resolve => setTimeout(() => resolve("async done"), 50));
        }
        work().then(r => console.log(r));
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("async done"));
  });

  test("JS: require node:os module", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'const os = require("os"); console.log("platform:", os.platform());',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("platform:"));
  });

  test("JS: Array.from + map/filter/reduce chain", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: `
        const nums = Array.from({length: 100}, (_, i) => i + 1);
        const evenSum = nums.filter(n => n % 2 === 0).reduce((a, b) => a + b, 0);
        console.log("even sum:", evenSum);
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("even sum: 2550"));
  });
});

describe.runIf(runtimes.typescript)("TypeScript Execution", () => {
    test("TS: hello world with type annotation", async () => {
      const r = await executor.execute({
        language: "typescript",
        code: 'const msg: string = "hello from ts"; console.log(msg);',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("hello from ts"));
    });

    test("TS: interface + generics", async () => {
      const r = await executor.execute({
        language: "typescript",
        code: `
          interface Item<T> { id: number; value: T; }
          const items: Item<string>[] = [
            { id: 1, value: "apple" },
            { id: 2, value: "banana" },
          ];
          function first<T>(arr: T[]): T | undefined { return arr[0]; }
          console.log(first(items)?.value);
        `,
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("apple"));
    });

    test("TS: enum + switch", async () => {
      const r = await executor.execute({
        language: "typescript",
        code: `
          enum Color { Red = "red", Blue = "blue", Green = "green" }
          function describe(c: Color): string {
            switch (c) {
              case Color.Red: return "warm";
              case Color.Blue: return "cool";
              case Color.Green: return "natural";
            }
          }
          console.log(describe(Color.Blue));
        `,
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("cool"));
    });

    test("TS: async + Promise.all", async () => {
      const r = await executor.execute({
        language: "typescript",
        code: `
          async function fetchNum(n: number): Promise<number> {
            return new Promise(resolve => setTimeout(() => resolve(n * 2), 10));
          }
          Promise.all([1, 2, 3].map(fetchNum)).then(results => {
            console.log("doubled:", results.join(", "));
          });
        `,
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("doubled: 2, 4, 6"));
    });
});

describe.runIf(runtimes.python)("Python Execution", () => {
  test("Python: hello world", async () => {
    const r = await executor.execute({
      language: "python",
      code: 'print("hello from python")',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from python"));
  });

  test("Python: list comprehension + math", async () => {
    const r = await executor.execute({
      language: "python",
      code: `
nums = [i**2 for i in range(10)]
print(f"squares: {nums}")
print(f"sum: {sum(nums)}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 285"));
  });

  test("Python: dict + json", async () => {
    const r = await executor.execute({
      language: "python",
      code: `
import json
data = {"users": [{"name": "Alice"}, {"name": "Bob"}]}
print(json.dumps({"count": len(data["users"])}))
      `,
    });
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.count, 2);
  });

  test("Python: csv with io.StringIO", async () => {
    const r = await executor.execute({
      language: "python",
      code: `
import io, csv
data = "name,age\\nAlice,30\\nBob,25\\nCharlie,35"
reader = csv.DictReader(io.StringIO(data))
rows = list(reader)
print(f"rows: {len(rows)}, names: {[r['name'] for r in rows]}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("rows: 3"));
  });

  test("Python: regex extraction", async () => {
    const r = await executor.execute({
      language: "python",
      code: `
import re
text = "Error: 404 at /api/users, Error: 500 at /api/data, OK: 200"
errors = re.findall(r'Error: (\\d+) at (\\S+)', text)
print(f"Found {len(errors)} errors: {errors}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("Found 2 errors"));
  });

  test("Python: collections.Counter", async () => {
    const r = await executor.execute({
      language: "python",
      code: `
from collections import Counter
words = "the cat sat on the mat the cat".split()
c = Counter(words)
print(f"most common: {c.most_common(2)}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("most common:"));
    assert.ok(r.stdout.includes("the"));
  });
});

describe("Shell Execution", () => {
  test("Shell: hello world", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'echo "hello from shell"',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from shell"));
  });

  test("Shell: pipes + sort", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'printf "banana\\napple\\ncherry" | sort',
    });
    assert.equal(r.exitCode, 0);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines[0], "apple");
    assert.equal(lines[1], "banana");
    assert.equal(lines[2], "cherry");
  });

  test("Shell: arithmetic + variables", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'X=10\nY=20\necho "sum: $((X + Y))"',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 30"));
  });

  test("shell TMPDIR points to sandbox temp dir, not project root", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'echo "$TMPDIR"',
      timeout: 5_000,
    });
    const reported = r.stdout.trim();
    assert.ok(
      !reported.startsWith(process.cwd()),
      `TMPDIR should not be project root, got: ${reported}`,
    );
    assert.ok(
      reported.includes(".ctx-mode-"),
      `TMPDIR should be the sandbox temp dir, got: ${reported}`,
    );
  });

  test("shell TMPDIR works cross-platform (not just echo)", async () => {
    // Use a command that writes to TMPDIR to verify it's writable
    const r = await executor.execute({
      language: "shell",
      code: 'touch "$TMPDIR/ctx-test-file" && echo "ok"',
      timeout: 5_000,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.trim() === "ok");
  });

  test("Shell: for loop + wc", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'for i in 1 2 3 4 5; do echo "item $i"; done | wc -l | tr -d " "',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.trim() === "5");
  });

  test("Shell: awk processing", async () => {
    const r = await executor.execute({
      language: "shell",
      code: `printf "Alice 30\\nBob 25\\nCharlie 35" | awk '{sum += $2; count++} END {print "avg:", sum/count}'`,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("avg: 30"));
  });
});

describe.runIf(runtimes.ruby)("Ruby Execution", () => {
  test("Ruby: hello world", async () => {
    const r = await executor.execute({
      language: "ruby",
      code: 'puts "hello from ruby"',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from ruby"));
  });

  test("Ruby: array methods", async () => {
    const r = await executor.execute({
      language: "ruby",
      code: `
nums = (1..10).to_a
evens = nums.select { |n| n.even? }
puts "evens: #{evens.join(', ')}"
puts "sum: #{evens.sum}"
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 30"));
  });

  test("Ruby: hash + JSON", async () => {
    const r = await executor.execute({
      language: "ruby",
      code: `
require 'json'
data = { users: [{ name: "Alice" }, { name: "Bob" }] }
puts JSON.generate({ count: data[:users].length })
      `,
    });
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.count, 2);
  });
});

describe.runIf(runtimes.go)("Go Execution", () => {
  test("Go: hello world", async () => {
    const r = await executor.execute({
      language: "go",
      code: 'fmt.Println("hello from go")',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from go"));
  });

  test("Go: loops + slices", async () => {
    const r = await executor.execute({
      language: "go",
      code: `
  nums := []int{1, 2, 3, 4, 5}
  sum := 0
  for _, n := range nums {
  sum += n
  }
  fmt.Println("sum:", sum)
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 15"));
  });
});

describe.runIf(runtimes.php)("PHP Execution", () => {
  test("PHP: hello world", async () => {
    const r = await executor.execute({
      language: "php",
      code: 'echo "hello from php\\n";',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from php"));
  });

  test("PHP: array functions", async () => {
    const r = await executor.execute({
      language: "php",
      code: `
$nums = range(1, 10);
$evens = array_filter($nums, fn($n) => $n % 2 === 0);
echo "evens: " . implode(", ", $evens) . "\\n";
echo "sum: " . array_sum($evens) . "\\n";
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 30"));
  });
});

describe.runIf(runtimes.perl)("Perl Execution", () => {
  test("Perl: hello world", async () => {
    const r = await executor.execute({
      language: "perl",
      code: 'print "hello from perl\\n";',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from perl"));
  });

  test("Perl: regex + array", async () => {
    const r = await executor.execute({
      language: "perl",
      code: `
my @words = ("apple", "banana", "avocado", "blueberry");
my @a_words = grep { /^a/i } @words;
print "a-words: @a_words\\n";
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("apple"));
    assert.ok(r.stdout.includes("avocado"));
  });
});

describe.runIf(runtimes.r)("R Execution", () => {
  test("R: hello world", async () => {
    const r = await executor.execute({
      language: "r",
      code: 'cat("hello from R\\n")',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from R"));
  });

  test("R: vector operations", async () => {
    const r = await executor.execute({
      language: "r",
      code: `
nums <- 1:10
cat("mean:", mean(nums), "\\n")
cat("sum:", sum(nums), "\\n")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 55"));
  });
});

describe.runIf(runtimes.elixir)("Elixir Execution", () => {
  test("Elixir: hello world", async () => {
    const r = await executor.execute({
      language: "elixir",
      code: 'IO.puts("hello from elixir")',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from elixir"));
  });

  test("Elixir: list operations + Enum", async () => {
    const r = await executor.execute({
      language: "elixir",
      code: `
nums = Enum.to_list(1..10)
evens = Enum.filter(nums, fn n -> rem(n, 2) == 0 end)
IO.puts("evens: #{Enum.join(evens, ", ")}")
IO.puts("sum: #{Enum.sum(evens)}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 30"));
  });

  test("Elixir: map + pattern matching", async () => {
    const r = await executor.execute({
      language: "elixir",
      code: `
users = [%{name: "Alice", role: "admin"}, %{name: "Bob", role: "user"}]
admins = Enum.filter(users, fn %{role: role} -> role == "admin" end)
IO.puts("admins: #{length(admins)}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("admins: 1"));
  });

  test("Elixir: pipe operator + String functions", async () => {
    const r = await executor.execute({
      language: "elixir",
      code: `
result =
  "hello world from elixir"
  |> String.split()
  |> Enum.map(&String.upcase/1)
  |> Enum.join(" ")
IO.puts(result)
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("HELLO WORLD FROM ELIXIR"));
  });

  test("Elixir: error raises non-zero exit", async () => {
    const r = await executor.execute({
      language: "elixir",
      code: 'raise "intentional error"',
    });
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.length > 0 || r.stdout.includes("intentional error"));
  });
});

describe("Error Handling", () => {
  test("JS: syntax error returns non-zero", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: "const x = {",
    });
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.length > 0);
  });

  test("JS: runtime error returns non-zero", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'throw new Error("intentional");',
    });
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.includes("intentional"));
  });

    test.runIf(runtimes.python)("Python: syntax error", async () => {
    const r = await executor.execute({
      language: "python",
      code: "def foo(\n  pass",
    });
    assert.notEqual(r.exitCode, 0);
  });

    test.runIf(runtimes.python)("Python: runtime error (ValueError)", async () => {
    const r = await executor.execute({
      language: "python",
      code: 'raise ValueError("test error")',
    });
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.includes("ValueError"));
  });

  test("Shell: non-zero exit code preserved", async () => {
    const r = await executor.execute({
      language: "shell",
      code: "exit 42",
    });
    assert.equal(r.exitCode, 42);
  });

  test("Shell: command not found", async () => {
    const r = await executor.execute({
      language: "shell",
      code: "nonexistent_command_xyz 2>&1",
    });
    assert.notEqual(r.exitCode, 0);
  });
});

describe("Timeout Handling", () => {
  test("JS: infinite loop times out", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: "while(true) {}",
      timeout: 500,
    });
    assert.equal(r.timedOut, true);
  });

  test("JS: infinite loop leaves no orphaned process after kill", async () => {
    // Spawn a process that writes its PID then loops forever
    const r = await executor.execute({
      language: "javascript",
      code: `process.stdout.write(String(process.pid)); while(true) {}`,
      timeout: 1000,
    });
    assert.equal(r.timedOut, true);
    const pid = parseInt(r.stdout.trim(), 10);
    assert.ok(pid > 0, `Expected valid PID in stdout, got: "${r.stdout}"`);
    // Give OS a moment to reap
    await new Promise(r => setTimeout(r, 200));
    let alive = false;
    try {
      process.kill(pid, 0); // signal 0 = check if alive
      alive = true;
    } catch { /* ESRCH = not found = good */ }
    assert.equal(alive, false, `Process ${pid} should be dead after timeout kill`);
  }, 10_000);

  test("JS: child processes are killed with parent (no orphans)", async () => {
    // Parent spawns a child that writes its PID to stderr, then both loop
    const code = `
      const { fork } = require("child_process");
      if (process.env.__CHILD__) {
        process.stderr.write(String(process.pid));
        while(true) {}
      } else {
        process.stdout.write(String(process.pid));
        const env = { ...process.env, __CHILD__: "1" };
        fork(process.argv[1], { env });
        while(true) {}
      }
    `;
    const r = await executor.execute({
      language: "javascript",
      code,
      timeout: 1500,
    });
    assert.equal(r.timedOut, true);
    const parentPid = parseInt(r.stdout.trim(), 10);
    const childPid = parseInt(r.stderr.trim(), 10);
    assert.ok(parentPid > 0, `Expected parent PID, got: "${r.stdout}"`);
    assert.ok(childPid > 0, `Expected child PID, got: "${r.stderr}"`);
    await new Promise(r => setTimeout(r, 200));
    for (const pid of [parentPid, childPid]) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      assert.equal(alive, false, `Process ${pid} should be dead after group kill`);
    }
  }, 10_000);

  test("Shell: sleep times out", async () => {
    const r = await executor.execute({
      language: "shell",
      code: "sleep 5",
      timeout: 500,
    });
    assert.equal(r.timedOut, true);
  }, 10_000);

    test.runIf(runtimes.python)("Python: infinite sleep times out", async () => {
    const r = await executor.execute({
      language: "python",
      code: "import time; time.sleep(5)",
      timeout: 500,
    });
    assert.equal(r.timedOut, true);
  });
});

describe("Output Truncation", () => {
  test("stdout is returned in full without truncation", async () => {
    const small = new PolyglotExecutor({ runtimes });
    const r = await small.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 100; i++) console.log(`line ${i}: ${"x".repeat(20)}`);',
    });
    assert.ok(!r.stdout.includes("truncated"), "stdout should NOT be truncated");
    assert.ok(r.stdout.includes("line 0"), "Should contain first line");
    assert.ok(r.stdout.includes("line 50"), "Should contain middle line (previously lost)");
    assert.ok(r.stdout.includes("line 99"), "Should contain last line");
    assert.ok(!r.stdout.includes("showing first"), "Should have no truncation marker");
  });

  test("does not truncate under limit", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("small output");',
    });
    assert.ok(!r.stdout.includes("truncated"));
  });

  test("stderr is also returned in full without truncation", async () => {
    const small = new PolyglotExecutor({ runtimes });
    const r = await small.execute({
      language: "javascript",
      code: `
        for (let i = 0; i < 50; i++) console.error("warn " + i);
        console.error("FINAL ERROR: something broke");
      `,
    });
    assert.ok(r.stderr.includes("FINAL ERROR"), "Should contain last error line");
    assert.ok(r.stderr.includes("warn 0"), "Should contain first warning");
    assert.ok(r.stderr.includes("warn 25"), "Should contain middle warning (previously lost)");
    assert.ok(!r.stderr.includes("truncated"), "stderr should NOT be truncated");
  });
});

describe("execute_file (FILE_CONTENT)", () => {
  const testDir = join(tmpdir(), "ctx-mode-test-" + Date.now());
  mkdirSync(testDir, { recursive: true });
  const testFile = join(testDir, "test-data.json");
  writeFileSync(
    testFile,
    JSON.stringify({
      users: [
        { name: "Alice", role: "admin" },
        { name: "Bob", role: "user" },
        { name: "Charlie", role: "admin" },
      ],
    }),
    "utf-8",
  );

  test("execute_file: JS reads FILE_CONTENT", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "javascript",
      code: `
        const data = JSON.parse(FILE_CONTENT);
        const admins = data.users.filter(u => u.role === "admin");
        console.log("admins: " + admins.map(a => a.name).join(", "));
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("admins: Alice, Charlie"));
  });

    test.runIf(runtimes.python)("execute_file: Python reads FILE_CONTENT", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "python",
      code: `
import json
data = json.loads(FILE_CONTENT)
print(f"Users: {len(data['users'])}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("Users: 3"));
  });

  test("execute_file: Shell reads FILE_CONTENT", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "shell",
      code: 'echo "size: ${#FILE_CONTENT} bytes"',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("bytes"));
  });

    test.runIf(runtimes.ruby)("execute_file: Ruby reads FILE_CONTENT", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "ruby",
      code: `
require 'json'
data = JSON.parse(FILE_CONTENT)
puts "Users: #{data['users'].length}"
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("Users: 3"));
  });

  // --- execute_file: shell $ expansion in paths ---

  const dollarDir = join(testDir, "path$SHOULD_NOT_EXPAND");
  mkdirSync(dollarDir, { recursive: true });
  const dollarFile = join(dollarDir, "data.txt");
  writeFileSync(dollarFile, "dollar-sign-content", "utf-8");

  test("execute_file: Shell path with $ is not expanded", async () => {
    const r = await executor.executeFile({
      path: dollarFile,
      language: "shell",
      code: 'echo "content: $FILE_CONTENT"',
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes("content: dollar-sign-content"),
      `Expected literal file content, got: ${r.stdout}`,
    );
  });

  // --- execute_file: shell paths with spaces ---

  const spaceDir = join(testDir, "path with spaces");
  mkdirSync(spaceDir, { recursive: true });
  const spaceFile = join(spaceDir, "space file.txt");
  writeFileSync(spaceFile, "space-content", "utf-8");

  test("execute_file: Shell path with spaces works correctly", async () => {
    const r = await executor.executeFile({
      path: spaceFile,
      language: "shell",
      code: 'echo "content: $FILE_CONTENT"',
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes("content: space-content"),
      `Expected literal file content, got: ${r.stdout}`,
    );
  });

  // --- execute_file: shell paths with single quotes ---

  const quoteDir = join(testDir, "it's-a-dir");
  mkdirSync(quoteDir, { recursive: true });
  const quoteFile = join(quoteDir, "quote.txt");
  writeFileSync(quoteFile, "quote-content", "utf-8");

  test("execute_file: Shell path with single quotes works correctly", async () => {
    const r = await executor.executeFile({
      path: quoteFile,
      language: "shell",
      code: 'echo "content: $FILE_CONTENT"',
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes("content: quote-content"),
      `Expected literal file content, got: ${r.stdout}`,
    );
  });

  // --- execute_file: shell paths with backticks ---

  const backtickDir = join(testDir, "dir`tick");
  mkdirSync(backtickDir, { recursive: true });
  const backtickFile = join(backtickDir, "bt.txt");
  writeFileSync(backtickFile, "backtick-content", "utf-8");

  test("execute_file: Shell path with backticks is not executed", async () => {
    const r = await executor.executeFile({
      path: backtickFile,
      language: "shell",
      code: 'echo "content: $FILE_CONTENT"',
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes("content: backtick-content"),
      `Expected literal file content, got: ${r.stdout}`,
    );
  });

  // --- execute_file: shell paths with combined special characters ---

  const comboDir = join(testDir, "$HOME has `spaces` & 'quotes'");
  mkdirSync(comboDir, { recursive: true });
  const comboFile = join(comboDir, "combo.txt");
  writeFileSync(comboFile, "combo-content", "utf-8");

  test("execute_file: Shell path with combined special chars works", async () => {
    const r = await executor.executeFile({
      path: comboFile,
      language: "shell",
      code: 'echo "content: $FILE_CONTENT"',
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes("content: combo-content"),
      `Expected literal file content, got: ${r.stdout}`,
    );
  });

    test.runIf(runtimes.elixir)("execute_file: Elixir reads file_content", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "elixir",
      code: `
IO.puts("file size: #{byte_size(file_content)}")
IO.puts("has users: #{String.contains?(file_content, "users")}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("has users: true"));
  });

  // --- UTF-8 / Non-ASCII file content ---
  const utf8File = join(testDir, "utf8-data.txt");
  writeFileSync(utf8File, "这是中文内容\n日本語テスト\n한국어\nEmoji: 🔒✅\nLine 5", "utf-8");

  test("execute_file: Python reads UTF-8 non-ASCII content", async () => {
    const r = await executor.executeFile({
      path: utf8File,
      language: "python",
      code: `
lines = FILE_CONTENT.strip().split('\\n')
print(f"lines: {len(lines)}")
print(f"first: {lines[0]}")
print(f"has_emoji: {'🔒' in FILE_CONTENT}")
      `,
    });
    assert.equal(r.exitCode, 0, "Python UTF-8 exit code: " + r.stderr);
    assert.ok(r.stdout.includes("lines: 5"), "Should have 5 lines");
    assert.ok(r.stdout.includes("first: 这是中文内容"), "Should read Chinese");
    assert.ok(r.stdout.includes("has_emoji: True"), "Should find emoji");
  });

  test("execute_file: JS reads UTF-8 non-ASCII content", async () => {
    const r = await executor.executeFile({
      path: utf8File,
      language: "javascript",
      code: `
const lines = FILE_CONTENT.trim().split('\\n');
console.log("lines: " + lines.length);
console.log("first: " + lines[0]);
console.log("has_emoji: " + FILE_CONTENT.includes('🔒'));
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("lines: 5"));
    assert.ok(r.stdout.includes("first: 这是中文内容"));
    assert.ok(r.stdout.includes("has_emoji: true"));
  });

    test.runIf(runtimes.ruby)("execute_file: Ruby reads UTF-8 non-ASCII content", async () => {
    const r = await executor.executeFile({
      path: utf8File,
      language: "ruby",
      code: `
lines = FILE_CONTENT.strip.split("\\n")
puts "lines: #{lines.length}"
puts "first: #{lines[0]}"
puts "has_emoji: #{FILE_CONTENT.include?('🔒')}"
      `,
    });
    assert.equal(r.exitCode, 0, "Ruby UTF-8 exit code: " + r.stderr);
    assert.ok(r.stdout.includes("lines: 5"));
    assert.ok(r.stdout.includes("first: 这是中文内容"));
  });

  test("execute_file: Shell reads UTF-8 non-ASCII content", async () => {
    const r = await executor.executeFile({
      path: utf8File,
      language: "shell",
      code: 'echo "$FILE_CONTENT" | head -1',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("这是中文内容"), "Shell should read Chinese: " + r.stdout);
  });

  // --- execute_file: file_path alias ---

  test.runIf(runtimes.python)("execute_file: Python exposes 'file_path' as alias for FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "python",
      code: `
import json
with open(file_path) as f:
    data = json.load(f)
print(f"Users via file_path: {len(data['users'])}")
      `,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("Users via file_path: 3"), `Got: ${r.stdout}`);
  });

  test("execute_file: JS exposes 'file_path' as alias for FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "javascript",
      code: `console.log("file_path alias: " + file_path);`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test("execute_file: TypeScript exposes 'file_path' as alias for FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "typescript",
      code: `console.log("file_path alias: " + file_path);`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test("execute_file: Shell exposes 'file_path' as alias for FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "shell",
      code: 'echo "file_path alias: $file_path"',
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test.runIf(runtimes.ruby)("execute_file: Ruby exposes 'file_path' as alias for FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "ruby",
      code: `
require 'json'
data = JSON.parse(File.read(file_path))
puts "Users via file_path: #{data['users'].length}"
      `,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("Users via file_path: 3"), `Got: ${r.stdout}`);
  });

  test.runIf(runtimes.go)("execute_file: Go exposes 'file_path' as alias for FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "go",
      code: `fmt.Println("file_path alias: " + file_path)`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test.runIf(runtimes.rust)("execute_file: Rust exposes 'file_path' as alias for file_content_path", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "rust",
      code: `println!("file_path alias: {}", file_path);`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test.runIf(runtimes.php)("execute_file: PHP exposes '$file_path' as alias for $FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "php",
      code: `echo "file_path alias: " . $file_path . "\\n";`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test.runIf(runtimes.perl)("execute_file: Perl exposes '$file_path' as alias for $FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "perl",
      code: `print "file_path alias: $file_path\\n";`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test.runIf(runtimes.r)("execute_file: R exposes 'file_path' as alias for FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "r",
      code: `cat(paste0("file_path alias: ", file_path, "\\n"))`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test.runIf(runtimes.elixir)("execute_file: Elixir exposes 'file_path' as alias for file_content_path", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "elixir",
      code: `IO.puts("file_path alias: " <> file_path)`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });
});

describe("Environment Passthrough", () => {
  test("SSH_AUTH_SOCK is passed through to subprocess when set", async () => {
    const original = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = "/tmp/test-ssh-agent.sock";
    try {
      const r = await executor.execute({
        language: "shell",
        code: 'echo "SSH_AUTH_SOCK=$SSH_AUTH_SOCK"',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(
        r.stdout.includes("/tmp/test-ssh-agent.sock"),
        `Expected SSH_AUTH_SOCK to be passed through, got: ${r.stdout}`,
      );
    } finally {
      if (original === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = original;
    }
  });

  test("SSH_AGENT_PID is passed through to subprocess when set", async () => {
    const original = process.env.SSH_AGENT_PID;
    process.env.SSH_AGENT_PID = "99999";
    try {
      const r = await executor.execute({
        language: "shell",
        code: 'echo "SSH_AGENT_PID=$SSH_AGENT_PID"',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(
        r.stdout.includes("99999"),
        `Expected SSH_AGENT_PID to be passed through, got: ${r.stdout}`,
      );
    } finally {
      if (original === undefined) delete process.env.SSH_AGENT_PID;
      else process.env.SSH_AGENT_PID = original;
    }
  });

  test("SSH_AUTH_SOCK is absent from subprocess when not set in parent", async () => {
    const original = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
    try {
      const r = await executor.execute({
        language: "shell",
        code: 'if [ -z "${SSH_AUTH_SOCK+x}" ]; then echo "unset"; else echo "set=$SSH_AUTH_SOCK"; fi',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(
        r.stdout.includes("unset"),
        `Expected SSH_AUTH_SOCK to be absent, got: ${r.stdout}`,
      );
    } finally {
      if (original !== undefined) process.env.SSH_AUTH_SOCK = original;
    }
  });
});

describe("Environment Denylist", () => {
  test("dangerous vars are stripped from subprocess (BASH_ENV, NODE_OPTIONS)", async () => {
    const origBash = process.env.BASH_ENV;
    const origNode = process.env.NODE_OPTIONS;
    process.env.BASH_ENV = "/tmp/evil.sh";
    process.env.NODE_OPTIONS = "--inspect";
    try {
      const r = await executor.execute({
        language: "shell",
        code: 'echo "BASH_ENV=${BASH_ENV:-unset}" && echo "NODE_OPTIONS=${NODE_OPTIONS:-unset}"',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("BASH_ENV=unset"), `BASH_ENV should be stripped, got: ${r.stdout}`);
      assert.ok(r.stdout.includes("NODE_OPTIONS=unset"), `NODE_OPTIONS should be stripped, got: ${r.stdout}`);
    } finally {
      if (origBash === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = origBash;
      if (origNode === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = origNode;
    }
  });

  test("dangerous vars are stripped: PERL5OPT, RUBYOPT, LD_PRELOAD", async () => {
    const origPerl = process.env.PERL5OPT;
    const origRuby = process.env.RUBYOPT;
    const origLD = process.env.LD_PRELOAD;
    process.env.PERL5OPT = "-Mbase";
    process.env.RUBYOPT = "-rmalicious";
    process.env.LD_PRELOAD = "/tmp/evil.so";
    try {
      const r = await executor.execute({
        language: "shell",
        code: 'echo "PERL5OPT=${PERL5OPT:-unset}" && echo "RUBYOPT=${RUBYOPT:-unset}" && echo "LD_PRELOAD=${LD_PRELOAD:-unset}"',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("PERL5OPT=unset"), `PERL5OPT should be stripped, got: ${r.stdout}`);
      assert.ok(r.stdout.includes("RUBYOPT=unset"), `RUBYOPT should be stripped, got: ${r.stdout}`);
      assert.ok(r.stdout.includes("LD_PRELOAD=unset"), `LD_PRELOAD should be stripped, got: ${r.stdout}`);
    } finally {
      if (origPerl === undefined) delete process.env.PERL5OPT;
      else process.env.PERL5OPT = origPerl;
      if (origRuby === undefined) delete process.env.RUBYOPT;
      else process.env.RUBYOPT = origRuby;
      if (origLD === undefined) delete process.env.LD_PRELOAD;
      else process.env.LD_PRELOAD = origLD;
    }
  });

  test("user env vars pass through by default (no allowlist needed)", async () => {
    const origSlack = process.env.SLACK_BOT_TOKEN;
    const origCustom = process.env.MY_CUSTOM_API_KEY;
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.MY_CUSTOM_API_KEY = "custom-12345";
    try {
      const r = await executor.execute({
        language: "shell",
        code: 'echo "SLACK=$SLACK_BOT_TOKEN" && echo "CUSTOM=$MY_CUSTOM_API_KEY"',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("SLACK=xoxb-test-token"), `SLACK_BOT_TOKEN should pass through, got: ${r.stdout}`);
      assert.ok(r.stdout.includes("CUSTOM=custom-12345"), `MY_CUSTOM_API_KEY should pass through, got: ${r.stdout}`);
    } finally {
      if (origSlack === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = origSlack;
      if (origCustom === undefined) delete process.env.MY_CUSTOM_API_KEY;
      else process.env.MY_CUSTOM_API_KEY = origCustom;
    }
  });

  test("sandbox overrides take precedence over parent env", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'echo "NO_COLOR=$NO_COLOR" && echo "PYTHONUNBUFFERED=$PYTHONUNBUFFERED"',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("NO_COLOR=1"), `NO_COLOR should be forced to 1, got: ${r.stdout}`);
    assert.ok(r.stdout.includes("PYTHONUNBUFFERED=1"), `PYTHONUNBUFFERED should be forced to 1, got: ${r.stdout}`);
  });

  test("ERL_AFLAGS and ERL_FLAGS are stripped", async () => {
    const origA = process.env.ERL_AFLAGS;
    const origF = process.env.ERL_FLAGS;
    process.env.ERL_AFLAGS = "-eval 'os:cmd(\"id\")'";
    process.env.ERL_FLAGS = "-eval 'os:cmd(\"id\")'";
    try {
      const r = await executor.execute({
        language: "shell",
        code: 'echo "ERL_AFLAGS=${ERL_AFLAGS:-unset}" && echo "ERL_FLAGS=${ERL_FLAGS:-unset}"',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("ERL_AFLAGS=unset"), `ERL_AFLAGS should be stripped, got: ${r.stdout}`);
      assert.ok(r.stdout.includes("ERL_FLAGS=unset"), `ERL_FLAGS should be stripped, got: ${r.stdout}`);
    } finally {
      if (origA === undefined) delete process.env.ERL_AFLAGS;
      else process.env.ERL_AFLAGS = origA;
      if (origF === undefined) delete process.env.ERL_FLAGS;
      else process.env.ERL_FLAGS = origF;
    }
  });
});

describe("Concurrent Execution", () => {
  test("5 concurrent JS executions", async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      executor.execute({
        language: "javascript",
        code: `console.log("concurrent ${i}");`,
      }),
    );
    const all = await Promise.all(promises);
    for (const r of all) {
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("concurrent"));
    }
  });

  test("mixed language concurrent execution", async () => {
    const promises = [
      executor.execute({
        language: "javascript",
        code: 'console.log("js");',
      }),
      executor.execute({ language: "shell", code: 'echo "sh"' }),
    ];
    promises.push(
      executor.execute({ language: "python", code: 'print("py")' }),
    );
    const all = await Promise.all(promises);
    for (const r of all) {
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.trim().length > 0);
    }
  });
});

describe("Edge Cases", () => {
  test("empty output returns empty string", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: "// no output",
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "");
  });

  test("multiline output preserved", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: "for (let i = 0; i < 10; i++) console.log(`line ${i}`);",
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim().split("\n").length, 10);
  });

  test("stderr captured separately from stdout", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.error("warning"); console.log("ok");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("ok"));
    assert.ok(r.stderr.includes("warning"));
  });

  test("special characters in output", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("line1\\nline2\\ttab\\n\\"quoted\\"");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("line1"));
    assert.ok(r.stdout.includes("line2"));
    assert.ok(r.stdout.includes('"quoted"'));
  });

  test("unicode output", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("Hello world");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("Hello"));
  });
});

describe("Temp Cleanup Resilience", () => {
  test("concurrent executions all return valid results (EBUSY resilience)", async () => {
    const count = 15;
    const promises = Array.from({ length: count }, (_, i) =>
      executor.execute({
        language: "javascript",
        code: `
          const fs = require('fs');
          const path = require('path');
          for (let j = 0; j < 3; j++) {
            fs.writeFileSync(path.join(process.cwd(), 'f' + j + '.tmp'), 'data');
          }
          console.log("ok-${i}");
        `,
      }),
    );
    const results = await Promise.all(promises);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      assert.equal(typeof r.exitCode, "number", `Execution ${i}: exitCode not a number`);
      assert.equal(typeof r.stdout, "string", `Execution ${i}: stdout not a string`);
      assert.equal(typeof r.stderr, "string", `Execution ${i}: stderr not a string`);
      assert.equal(typeof r.timedOut, "boolean", `Execution ${i}: timedOut not a boolean`);
      assert.equal(r.exitCode, 0, `Execution ${i} failed with stderr: ${r.stderr}`);
      assert.ok(r.stdout.includes(`ok-${i}`), `Missing output for execution ${i}`);
    }
  });

  test("node runtime accessible from executor shell", async () => {
    // Use process.execPath rather than bare 'node' — snap/wrapper installs silently
    // exit 0 with no output when the snap wrapper is re-invoked as a subprocess.
    const r = await executor.execute({
      language: "shell",
      code: `"${process.execPath}" --version`,
    });
    assert.equal(r.exitCode, 0, `node not found in executor env, stderr: ${r.stderr}`);
    assert.ok(r.stdout.trim().startsWith("v"), `Expected version string, got: ${r.stdout}`);
  });
});

describe("Background Mode", () => {
  test("background: true returns partial output with backgrounded flag", async () => {
    const bgExecutor = new PolyglotExecutor({ runtimes });
    const r = await bgExecutor.execute({
      language: "javascript",
      code: `console.log("started"); setInterval(() => {}, 1000);`,
      timeout: 500,
      background: true,
    });
    assert.equal(r.backgrounded, true, "Should be marked as backgrounded");
    assert.equal(r.timedOut, true, "Background detach fires on timeout");
    assert.equal(r.exitCode, 0, "Backgrounded processes return exitCode 0");
    assert.ok(r.stdout.includes("started"), "Should capture output before detach");
    bgExecutor.cleanupBackgrounded();
  }, 10_000);

  test("cleanupBackgrounded kills detached process", async () => {
    const bgExecutor = new PolyglotExecutor({ runtimes });
    const r = await bgExecutor.execute({
      language: "javascript",
      code: `process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);`,
      timeout: 500,
      background: true,
    });
    const pid = parseInt(r.stdout.trim(), 10);
    assert.ok(pid > 0, `Expected valid PID, got: "${r.stdout}"`);

    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* ESRCH */ }
    assert.equal(alive, true, "Process should be alive before cleanup");

    bgExecutor.cleanupBackgrounded();
    await new Promise((r) => setTimeout(r, 300));

    alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* ESRCH */ }
    assert.equal(alive, false, `Process ${pid} should be dead after cleanup`);
  }, 10_000);
});

describe("hardCapBytes Enforcement", () => {
  test("kills process when combined output exceeds byte cap", async () => {
    const cappedExecutor = new PolyglotExecutor({
      runtimes,
      hardCapBytes: 1024,
    });
    const r = await cappedExecutor.execute({
      language: "javascript",
      code: `for (let i = 0; i < 10000; i++) console.log("x".repeat(100));`,
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped at"), "Should indicate cap was hit");
    assert.notEqual(r.exitCode, 0, "Process should be killed (non-zero exit)");
  }, 15_000);

  test("stderr contributes to byte cap", async () => {
    const cappedExecutor = new PolyglotExecutor({
      runtimes,
      hardCapBytes: 1024,
    });
    const r = await cappedExecutor.execute({
      language: "javascript",
      code: `for (let i = 0; i < 10000; i++) console.error("e".repeat(100));`,
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped at"), "stderr should trigger cap");
  }, 15_000);
});

describe("Windows Shell Support", () => {
  test("shell runtime is always a non-empty string", async () => {
    assert.ok(
      typeof runtimes.shell === "string" && runtimes.shell.length > 0,
      `shell should always be a non-empty string, got: ${runtimes.shell}`,
    );
  });

  test("getAvailableLanguages always includes shell", async () => {
    const { getAvailableLanguages } = await import("../src/runtime.js");
    const langs = getAvailableLanguages(runtimes);
    assert.ok(langs.includes("shell"), `shell should always be in available languages, got: ${langs}`);
  });

  test("buildCommand returns shell command array", async () => {
    const cmd = buildCommand(runtimes, "shell", "/tmp/script.sh");
    assert.ok(Array.isArray(cmd) && cmd.length === 2, `Expected [shell, path], got: ${cmd}`);
    assert.equal(cmd[1], "/tmp/script.sh");
  });

  // --- Issue #384: hide Windows console + drop .sh extension for shell ---

  test("buildSpawnOptions: windowsHide=true on Windows", async () => {
    assert.equal(buildSpawnOptions("win32").windowsHide, true);
  });

  test("buildSpawnOptions: windowsHide=false on macOS/Linux", async () => {
    assert.equal(buildSpawnOptions("darwin").windowsHide, false);
    assert.equal(buildSpawnOptions("linux").windowsHide, false);
  });

  test("buildScriptFilename: shell on Windows has NO extension (avoid .sh file association)", async () => {
    assert.equal(buildScriptFilename("shell", "win32"), "script");
  });

  test("buildScriptFilename: shell on Unix keeps .sh extension", async () => {
    assert.equal(buildScriptFilename("shell", "darwin"), "script.sh");
    assert.equal(buildScriptFilename("shell", "linux"), "script.sh");
  });

  test("buildScriptFilename: non-shell languages keep their extension on Windows", async () => {
    assert.equal(buildScriptFilename("python", "win32"), "script.py");
    assert.equal(buildScriptFilename("javascript", "win32"), "script.js");
    assert.equal(buildScriptFilename("typescript", "win32"), "script.ts");
    assert.equal(buildScriptFilename("ruby", "win32"), "script.rb");
    assert.equal(buildScriptFilename("go", "win32"), "script.go");
    assert.equal(buildScriptFilename("rust", "win32"), "script.rs");
  });

  test("buildScriptFilename: non-shell languages keep their extension on Unix", async () => {
    assert.equal(buildScriptFilename("python", "linux"), "script.py");
    assert.equal(buildScriptFilename("javascript", "darwin"), "script.js");
  });
});

