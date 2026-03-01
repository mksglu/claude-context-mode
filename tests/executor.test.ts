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

let passed = 0;
let failed = 0;
let skipped = 0;
const results: {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  time: number;
  error?: string;
}[] = [];

async function test(name: string, fn: () => Promise<void>) {
  const start = performance.now();
  try {
    await fn();
    const time = performance.now() - start;
    passed++;
    results.push({ name, status: "PASS", time });
    console.log(`  \u2713 ${name} (${time.toFixed(0)}ms)`);
  } catch (err: any) {
    const time = performance.now() - start;
    failed++;
    results.push({ name, status: "FAIL", time, error: err.message });
    console.log(`  \u2717 ${name} (${time.toFixed(0)}ms)`);
    console.log(`    Error: ${err.message}`);
  }
}

function skip(name: string, reason: string) {
  skipped++;
  results.push({ name, status: "SKIP", time: 0 });
  console.log(`  - ${name} (SKIP: ${reason})`);
}

async function main() {
  const runtimes = detectRuntimes();
  const executor = new PolyglotExecutor({ runtimes });

  console.log("\nContext Mode — Comprehensive Test Suite");
  console.log("========================================\n");
  console.log("Detected runtimes:");
  console.log(getRuntimeSummary(runtimes));

  // ===== RUNTIME DETECTION =====
  console.log("\n--- Runtime Detection ---\n");

  await test("detects JavaScript runtime (bun or node)", async () => {
    assert.ok(
      ["bun", "node"].includes(runtimes.javascript),
      `Got: ${runtimes.javascript}`,
    );
  });

  await test("detects Shell runtime (bash or sh)", async () => {
    assert.ok(
      ["bash", "sh"].includes(runtimes.shell),
      `Got: ${runtimes.shell}`,
    );
  });

  await test("detects TypeScript runtime", async () => {
    assert.ok(runtimes.typescript !== null, "No TS runtime found");
  });

  await test("detects Python runtime", async () => {
    assert.ok(runtimes.python !== null, "No Python runtime found");
  });

  await test("buildCommand: correct JS command structure", async () => {
    const cmd = buildCommand(runtimes, "javascript", "/tmp/test.js");
    assert.ok(cmd.length >= 2);
    assert.ok(cmd[cmd.length - 1] === "/tmp/test.js");
  });

  await test("buildCommand: throws for unavailable runtime", async () => {
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

  // ===== JAVASCRIPT =====
  console.log("\n--- JavaScript Execution ---\n");

  await test("JS: hello world", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("hello from js");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from js"));
    assert.equal(r.timedOut, false);
  });

  await test("JS: variables, math, template literals", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: "const x = 42; const y = 58; console.log(`sum: ${x + y}`);",
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 100"));
  });

  await test("JS: JSON parse + transform", async () => {
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

  await test("JS: async/await + setTimeout", async () => {
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

  await test("JS: require node:os module", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'const os = require("os"); console.log("platform:", os.platform());',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("platform:"));
  });

  await test("JS: Array.from + map/filter/reduce chain", async () => {
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

  // ===== TYPESCRIPT =====
  console.log("\n--- TypeScript Execution ---\n");

  if (runtimes.typescript) {
    await test("TS: hello world with type annotation", async () => {
      const r = await executor.execute({
        language: "typescript",
        code: 'const msg: string = "hello from ts"; console.log(msg);',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("hello from ts"));
    });

    await test("TS: interface + generics", async () => {
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

    await test("TS: enum + switch", async () => {
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

    await test("TS: async + Promise.all", async () => {
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
  } else {
    skip("TS tests", "No TypeScript runtime available");
  }

  // ===== PYTHON =====
  console.log("\n--- Python Execution ---\n");

  if (runtimes.python) {
    await test("Python: hello world", async () => {
      const r = await executor.execute({
        language: "python",
        code: 'print("hello from python")',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("hello from python"));
    });

    await test("Python: list comprehension + math", async () => {
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

    await test("Python: dict + json", async () => {
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

    await test("Python: csv with io.StringIO", async () => {
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

    await test("Python: regex extraction", async () => {
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

    await test("Python: collections.Counter", async () => {
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
  } else {
    skip("Python tests", "No Python runtime available");
  }

  // ===== SHELL =====
  console.log("\n--- Shell Execution ---\n");

  await test("Shell: hello world", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'echo "hello from shell"',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from shell"));
  });

  await test("Shell: pipes + sort", async () => {
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

  await test("Shell: arithmetic + variables", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'X=10\nY=20\necho "sum: $((X + Y))"',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 30"));
  });

  await test("Shell: for loop + wc", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'for i in 1 2 3 4 5; do echo "item $i"; done | wc -l | tr -d " "',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.trim() === "5");
  });

  await test("Shell: awk processing", async () => {
    const r = await executor.execute({
      language: "shell",
      code: `printf "Alice 30\\nBob 25\\nCharlie 35" | awk '{sum += $2; count++} END {print "avg:", sum/count}'`,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("avg: 30"));
  });

  // ===== RUBY =====
  console.log("\n--- Ruby Execution ---\n");

  if (runtimes.ruby) {
    await test("Ruby: hello world", async () => {
      const r = await executor.execute({
        language: "ruby",
        code: 'puts "hello from ruby"',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("hello from ruby"));
    });

    await test("Ruby: array methods", async () => {
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

    await test("Ruby: hash + JSON", async () => {
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
  } else {
    skip("Ruby tests", "Ruby not available");
  }

  // ===== GO =====
  console.log("\n--- Go Execution ---\n");

  if (runtimes.go) {
    await test("Go: hello world", async () => {
      const r = await executor.execute({
        language: "go",
        code: 'fmt.Println("hello from go")',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("hello from go"));
    });

    await test("Go: loops + slices", async () => {
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
  } else {
    skip("Go tests", "Go not available");
  }

  // ===== PHP =====
  console.log("\n--- PHP Execution ---\n");

  if (runtimes.php) {
    await test("PHP: hello world", async () => {
      const r = await executor.execute({
        language: "php",
        code: 'echo "hello from php\\n";',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("hello from php"));
    });

    await test("PHP: array functions", async () => {
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
  } else {
    skip("PHP tests", "PHP not available");
  }

  // ===== PERL =====
  console.log("\n--- Perl Execution ---\n");

  if (runtimes.perl) {
    await test("Perl: hello world", async () => {
      const r = await executor.execute({
        language: "perl",
        code: 'print "hello from perl\\n";',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("hello from perl"));
    });

    await test("Perl: regex + array", async () => {
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
  } else {
    skip("Perl tests", "Perl not available");
  }

  // ===== R =====
  console.log("\n--- R Execution ---\n");

  if (runtimes.r) {
    await test("R: hello world", async () => {
      const r = await executor.execute({
        language: "r",
        code: 'cat("hello from R\\n")',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("hello from R"));
    });

    await test("R: vector operations", async () => {
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
  } else {
    skip("R tests", "R / Rscript not available");
  }

  // ===== ELIXIR =====
  console.log("\n--- Elixir Execution ---\n");

  if (runtimes.elixir) {
    await test("Elixir: hello world", async () => {
      const r = await executor.execute({
        language: "elixir",
        code: 'IO.puts("hello from elixir")',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("hello from elixir"));
    });

    await test("Elixir: list operations + Enum", async () => {
      const r = await executor.execute({
        language: "elixir",
        code: `
nums = Enum.to_list(1..10)
evens = Enum.filter(nums, fn n -> rem(n, 2) == 0 end)
IO.puts("evens: \${Enum.join(evens, ", ")}")
IO.puts("sum: \${Enum.sum(evens)}")
        `,
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("sum: 30"));
    });

    await test("Elixir: map + pattern matching", async () => {
      const r = await executor.execute({
        language: "elixir",
        code: `
users = [%{name: "Alice", role: "admin"}, %{name: "Bob", role: "user"}]
admins = Enum.filter(users, fn %{role: role} -> role == "admin" end)
IO.puts("admins: \${length(admins)}")
        `,
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("admins: 1"));
    });

    await test("Elixir: pipe operator + String functions", async () => {
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

    await test("Elixir: error raises non-zero exit", async () => {
      const r = await executor.execute({
        language: "elixir",
        code: 'raise "intentional error"',
      });
      assert.notEqual(r.exitCode, 0);
      assert.ok(r.stderr.length > 0 || r.stdout.includes("intentional error"));
    });
  } else {
    skip("Elixir tests", "Elixir not available");
  }

  // ===== ERROR HANDLING =====
  console.log("\n--- Error Handling ---\n");

  await test("JS: syntax error returns non-zero", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: "const x = {",
    });
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.length > 0);
  });

  await test("JS: runtime error returns non-zero", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'throw new Error("intentional");',
    });
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.includes("intentional"));
  });

  if (runtimes.python) {
    await test("Python: syntax error", async () => {
      const r = await executor.execute({
        language: "python",
        code: "def foo(\n  pass",
      });
      assert.notEqual(r.exitCode, 0);
    });

    await test("Python: runtime error (ValueError)", async () => {
      const r = await executor.execute({
        language: "python",
        code: 'raise ValueError("test error")',
      });
      assert.notEqual(r.exitCode, 0);
      assert.ok(r.stderr.includes("ValueError"));
    });
  }

  await test("Shell: non-zero exit code preserved", async () => {
    const r = await executor.execute({
      language: "shell",
      code: "exit 42",
    });
    assert.equal(r.exitCode, 42);
  });

  await test("Shell: command not found", async () => {
    const r = await executor.execute({
      language: "shell",
      code: "nonexistent_command_xyz 2>&1",
    });
    assert.notEqual(r.exitCode, 0);
  });

  // ===== TIMEOUT HANDLING =====
  console.log("\n--- Timeout Handling ---\n");

  await test("JS: infinite loop times out", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: "while(true) {}",
      timeout: 500,
    });
    assert.equal(r.timedOut, true);
  });

  await test("Shell: sleep times out", async () => {
    const r = await executor.execute({
      language: "shell",
      code: "sleep 60",
      timeout: 500,
    });
    assert.equal(r.timedOut, true);
  });

  if (runtimes.python) {
    await test("Python: infinite sleep times out", async () => {
      const r = await executor.execute({
        language: "python",
        code: "import time; time.sleep(60)",
        timeout: 500,
      });
      assert.equal(r.timedOut, true);
    });
  }

  // ===== OUTPUT TRUNCATION =====
  console.log("\n--- Output Truncation ---\n");

  await test("smart truncation: keeps head + tail", async () => {
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

  await test("does not truncate under limit", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("small output");',
    });
    assert.ok(!r.stdout.includes("truncated"));
  });

  await test("smart truncation on stderr preserves error context", async () => {
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

  // ===== EXECUTE_FILE =====
  console.log("\n--- execute_file (FILE_CONTENT) ---\n");

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

  await test("execute_file: JS reads FILE_CONTENT", async () => {
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

  if (runtimes.python) {
    await test("execute_file: Python reads FILE_CONTENT", async () => {
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
  }

  await test("execute_file: Shell reads FILE_CONTENT", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "shell",
      code: 'echo "size: ${#FILE_CONTENT} bytes"',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("bytes"));
  });

  if (runtimes.ruby) {
    await test("execute_file: Ruby reads FILE_CONTENT", async () => {
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
  }

  // --- execute_file: shell $ expansion in paths ---

  const dollarDir = join(testDir, "path$SHOULD_NOT_EXPAND");
  mkdirSync(dollarDir, { recursive: true });
  const dollarFile = join(dollarDir, "data.txt");
  writeFileSync(dollarFile, "dollar-sign-content", "utf-8");

  await test("execute_file: Shell path with $ is not expanded", async () => {
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

  await test("execute_file: Shell path with spaces works correctly", async () => {
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

  await test("execute_file: Shell path with single quotes works correctly", async () => {
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

  await test("execute_file: Shell path with backticks is not executed", async () => {
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

  await test("execute_file: Shell path with combined special chars works", async () => {
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

  if (runtimes.elixir) {
    await test("execute_file: Elixir reads file_content", async () => {
      const r = await executor.executeFile({
        path: testFile,
        language: "elixir",
        code: `
IO.puts("file size: \${byte_size(file_content)}")
IO.puts("has users: \${String.contains?(file_content, "users")}")
        `,
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("has users: true"));
    });
  }

  rmSync(testDir, { recursive: true, force: true });

  // ===== CONCURRENCY =====
  console.log("\n--- Concurrent Execution ---\n");

  await test("5 concurrent JS executions", async () => {
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

  await test("mixed language concurrent execution", async () => {
    const promises = [
      executor.execute({
        language: "javascript",
        code: 'console.log("js");',
      }),
      executor.execute({ language: "shell", code: 'echo "sh"' }),
    ];
    if (runtimes.python) {
      promises.push(
        executor.execute({ language: "python", code: 'print("py")' }),
      );
    }
    const all = await Promise.all(promises);
    for (const r of all) {
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.trim().length > 0);
    }
  });

  // ===== EDGE CASES =====
  console.log("\n--- Edge Cases ---\n");

  await test("empty output returns empty string", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: "// no output",
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "");
  });

  await test("multiline output preserved", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: "for (let i = 0; i < 10; i++) console.log(`line ${i}`);",
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim().split("\n").length, 10);
  });

  await test("stderr captured separately from stdout", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.error("warning"); console.log("ok");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("ok"));
    assert.ok(r.stderr.includes("warning"));
  });

  await test("special characters in output", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("line1\\nline2\\ttab\\n\\"quoted\\"");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("line1"));
    assert.ok(r.stdout.includes("line2"));
    assert.ok(r.stdout.includes('"quoted"'));
  });

  await test("unicode output", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("Hello world");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("Hello"));
  });

  // ===== SUMMARY =====
  console.log("\n" + "=".repeat(60));
  console.log(
    `Results: ${passed} passed, ${failed} failed, ${skipped} skipped (${passed + failed + skipped} total)`,
  );
  console.log("=".repeat(60));

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => r.status === "FAIL")) {
      console.log(`  \u2717 ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
