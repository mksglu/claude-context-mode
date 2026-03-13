import { describe, test, expect, afterAll } from "vitest";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PolyglotExecutor } from "../src/executor.js";
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
    assert.ok(
      ["bun", "node"].includes(runtimes.javascript),
      `Got: ${runtimes.javascript}`,
    );
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
  test("smart truncation: keeps head + tail", async () => {
    const small = new PolyglotExecutor({ maxOutputBytes: 200, runtimes });
    const r = await small.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 100; i++) console.log(`line ${i}: ${"x".repeat(20)}`);',
    });
    assert.ok(r.stdout.includes("truncated"), "Should indicate truncation");
    assert.ok(r.stdout.includes("line 0"), "Should preserve first lines (head)");
    assert.ok(r.stdout.includes("line 99"), "Should preserve last lines (tail)");
    assert.ok(r.stdout.includes("showing first"), "Should show head/tail counts");
  });

  test("does not truncate under limit", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("small output");',
    });
    assert.ok(!r.stdout.includes("truncated"));
  });

  test("smart truncation on stderr preserves error context", async () => {
    const small = new PolyglotExecutor({ maxOutputBytes: 200, runtimes });
    const r = await small.execute({
      language: "javascript",
      code: `
        for (let i = 0; i < 50; i++) console.error("warn " + i);
        console.error("FINAL ERROR: something broke");
      `,
    });
    assert.ok(r.stderr.includes("FINAL ERROR"), "Should preserve last error line (tail)");
    assert.ok(r.stderr.includes("warn 0"), "Should preserve first warning (head)");
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

  test("PATH-dependent tools accessible from executor shell", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'node --version',
    });
    assert.equal(r.exitCode, 0, `node not found in executor env, stderr: ${r.stderr}`);
    assert.ok(r.stdout.trim().startsWith("v"), `Expected version string, got: ${r.stdout}`);
  });
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
});
