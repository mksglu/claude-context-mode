/**
 * MCP Integration Test
 *
 * Tests the actual MCP server by sending JSON-RPC messages over stdio,
 * exactly how Claude Code communicates with the plugin.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "build", "server.js");
const fixtureDir = join(__dirname, "fixtures");

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    serverInfo?: { name: string; version: string };
    capabilities?: unknown;
    tools?: Array<{ name: string; description: string }>;
  };
  error?: { code: number; message: string };
}

function startServer(): ReturnType<typeof spawn> {
  return spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function send(proc: ReturnType<typeof spawn>, msg: JsonRpcRequest): void {
  proc.stdin!.write(JSON.stringify(msg) + "\n");
}

function collectResponses(
  proc: ReturnType<typeof spawn>,
  timeout: number,
): Promise<JsonRpcResponse[]> {
  return new Promise((resolve) => {
    let buffer = "";
    proc.stdout!.on("data", (d: Buffer) => {
      buffer += d.toString();
    });
    setTimeout(() => {
      proc.kill();
      const responses = buffer
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l) as JsonRpcResponse;
          } catch {
            return null;
          }
        })
        .filter((r): r is JsonRpcResponse => r !== null);
      resolve(responses);
    }, timeout);
  });
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

async function test(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err: any) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${err.message}`);
  }
}

async function main() {
  console.log("\nContext Mode — MCP Integration Tests");
  console.log("=====================================\n");
  console.log("Server:", serverPath);
  console.log("");

  // ===== Test 1: Server initialization =====
  console.log("--- Server Lifecycle ---\n");

  await test("Server initializes correctly", async () => {
    const proc = startServer();
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    const responses = await collectResponses(proc, 2000);
    const init = responses.find((r) => r.id === 1);
    assert(!!init, "No init response");
    assert(
      init!.result?.serverInfo?.name === "context-mode",
      "Wrong server name",
    );
    assert(
      init!.result?.serverInfo?.version === "0.4.0",
      "Wrong server version",
    );
  });

  await test("tools/list returns execute and execute_file", async () => {
    const proc = startServer();
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(proc, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const responses = await collectResponses(proc, 2000);
    const list = responses.find((r) => r.id === 2);
    assert(!!list, "No tools/list response");
    const tools = list!.result?.tools || [];
    assert(tools.length === 5, `Expected 5 tools, got ${tools.length}`);
    const names = tools.map((t) => t.name);
    assert(names.includes("execute"), "Missing execute tool");
    assert(names.includes("execute_file"), "Missing execute_file tool");
    assert(names.includes("index"), "Missing index tool");
    assert(names.includes("search"), "Missing search tool");
    assert(names.includes("fetch_and_index"), "Missing fetch_and_index tool");
  });

  // ===== Test 2: Execute tool — all languages =====
  console.log("\n--- Execute Tool (all languages) ---\n");

  const langTests: Array<{
    name: string;
    lang: string;
    code: string;
    expect: string;
  }> = [
    {
      name: "JavaScript",
      lang: "javascript",
      code: 'console.log("js-ok");',
      expect: "js-ok",
    },
    {
      name: "TypeScript",
      lang: "typescript",
      code: 'const x: number = 42; console.log("ts-" + x);',
      expect: "ts-42",
    },
    {
      name: "Python",
      lang: "python",
      code: 'print("py-ok")',
      expect: "py-ok",
    },
    {
      name: "Shell",
      lang: "shell",
      code: 'echo "sh-ok"',
      expect: "sh-ok",
    },
    {
      name: "Ruby",
      lang: "ruby",
      code: 'puts "rb-ok"',
      expect: "rb-ok",
    },
    {
      name: "Perl",
      lang: "perl",
      code: 'print "pl-ok\\n";',
      expect: "pl-ok",
    },
  ];

  for (const lt of langTests) {
    await test(`execute: ${lt.name}`, async () => {
      const proc = startServer();
      send(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      });
      send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
      send(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "execute",
          arguments: { language: lt.lang, code: lt.code },
        },
      });
      const responses = await collectResponses(proc, 3000);
      const result = responses.find((r) => r.id === 10);
      assert(!!result, "No response for " + lt.name);
      const text = result!.result?.content?.[0]?.text || "";
      assert(!result!.result?.isError, "Tool returned error: " + text);
      assert(
        text.includes(lt.expect),
        `Expected "${lt.expect}" in output, got: "${text.trim()}"`,
      );
    });
  }

  // ===== Test 3: Execute_file tool =====
  console.log("\n--- Execute File Tool (fixtures) ---\n");

  await test("execute_file: package.json summary", async () => {
    const proc = startServer();
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(proc, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "execute_file",
        arguments: {
          path: join(fixtureDir, "package-large.json"),
          language: "javascript",
          code: 'const pkg = JSON.parse(FILE_CONTENT); console.log(pkg.name + " has " + Object.keys(pkg.dependencies).length + " deps");',
        },
      },
    });
    const responses = await collectResponses(proc, 3000);
    const result = responses.find((r) => r.id === 20);
    assert(!!result, "No response");
    const text = result!.result?.content?.[0]?.text || "";
    assert(!result!.result?.isError, "Error: " + text);
    assert(text.includes("23 deps"), "Expected 23 deps, got: " + text.trim());
  });

  await test("execute_file: access log analysis", async () => {
    const proc = startServer();
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(proc, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "execute_file",
        arguments: {
          path: join(fixtureDir, "access.log"),
          language: "javascript",
          code: `
            const lines = FILE_CONTENT.trim().split("\\n");
            console.log("Requests: " + lines.length);
          `,
        },
      },
    });
    const responses = await collectResponses(proc, 3000);
    const result = responses.find((r) => r.id === 21);
    assert(!!result, "No response");
    const text = result!.result?.content?.[0]?.text || "";
    assert(!result!.result?.isError, "Error: " + text);
    assert(text.includes("500"), "Expected 500 requests, got: " + text.trim());
  });

  await test("execute_file: CSV analysis with Python", async () => {
    const proc = startServer();
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(proc, {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "execute_file",
        arguments: {
          path: join(fixtureDir, "analytics.csv"),
          language: "python",
          code: 'import csv, io\nreader = csv.DictReader(io.StringIO(FILE_CONTENT))\nrows = list(reader)\nprint(f"Events: {len(rows)}")',
        },
      },
    });
    const responses = await collectResponses(proc, 3000);
    const result = responses.find((r) => r.id === 22);
    assert(!!result, "No response");
    const text = result!.result?.content?.[0]?.text || "";
    assert(!result!.result?.isError, "Error: " + text);
    assert(
      text.includes("Events: 500"),
      "Expected 500 events, got: " + text.trim(),
    );
  });

  // ===== Test 4: Index + Search tools =====
  console.log("\n--- Index + Search Tools ---\n");

  await test("index: stores content and returns chunk count", async () => {
    const proc = startServer();
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(proc, {
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: {
        name: "index",
        arguments: {
          content:
            "# useEffect\n\nThe effect hook.\n\n```js\nuseEffect(() => {}, []);\n```\n\n## Cleanup\n\nReturn a function.",
          source: "React Hooks",
        },
      },
    });
    const responses = await collectResponses(proc, 3000);
    const result = responses.find((r) => r.id === 50);
    assert(!!result, "No response for index");
    const text = result!.result?.content?.[0]?.text || "";
    assert(!result!.result?.isError, "Index returned error: " + text);
    assert(text.includes("Indexed"), "Should confirm indexing: " + text);
    assert(text.includes("with code"), "Should mention code chunks: " + text);
  });

  await test("index + search: retrieves indexed content in same session", async () => {
    const proc = startServer();
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
    // Index first — wait for response before searching
    send(proc, {
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: {
        name: "index",
        arguments: {
          content:
            "# Authentication\n\nUse JWT tokens.\n\n## OAuth\n\nSupports Google and GitHub OAuth providers.",
          source: "Auth Guide",
        },
      },
    });

    // Wait for index to complete, then send search
    const allResponses = await new Promise<JsonRpcResponse[]>((resolve) => {
      let buffer = "";
      let searchSent = false;
      proc.stdout!.on("data", (d: Buffer) => {
        buffer += d.toString();
        // Once we see the index response (id:51), send the search
        if (!searchSent && buffer.includes('"id":51')) {
          searchSent = true;
          send(proc, {
            jsonrpc: "2.0",
            id: 52,
            method: "tools/call",
            params: {
              name: "search",
              arguments: { query: "OAuth providers" },
            },
          });
        }
      });
      setTimeout(() => {
        proc.kill();
        const responses = buffer
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => {
            try { return JSON.parse(l) as JsonRpcResponse; }
            catch { return null; }
          })
          .filter((r): r is JsonRpcResponse => r !== null);
        resolve(responses);
      }, 4000);
    });

    const searchResult = allResponses.find((r) => r.id === 52);
    assert(!!searchResult, "No response for search");
    const text = searchResult!.result?.content?.[0]?.text || "";
    assert(!searchResult!.result?.isError, "Search returned error: " + text);
    assert(text.includes("OAuth"), "Should find OAuth content: " + text);
    assert(
      text.includes("Auth Guide"),
      "Should include source label: " + text,
    );
  });

  await test("search: returns no-results message for empty store", async () => {
    const proc = startServer();
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(proc, {
      jsonrpc: "2.0",
      id: 53,
      method: "tools/call",
      params: {
        name: "search",
        arguments: { query: "nonexistent topic" },
      },
    });
    const responses = await collectResponses(proc, 3000);
    const result = responses.find((r) => r.id === 53);
    assert(!!result, "No response");
    const text = result!.result?.content?.[0]?.text || "";
    assert(text.includes("No results"), "Should say no results: " + text);
  });

  await test("index: from file path", async () => {
    const proc = startServer();
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(proc, {
      jsonrpc: "2.0",
      id: 54,
      method: "tools/call",
      params: {
        name: "index",
        arguments: {
          path: join(fixtureDir, "context7-react-docs.md"),
          source: "Context7: React",
        },
      },
    });
    const responses = await collectResponses(proc, 3000);
    const result = responses.find((r) => r.id === 54);
    assert(!!result, "No response for file index");
    const text = result!.result?.content?.[0]?.text || "";
    assert(!result!.result?.isError, "File index returned error: " + text);
    assert(text.includes("Indexed"), "Should confirm indexing: " + text);
  });

  // ===== Test 5: fetch_and_index tool =====
  console.log("\n--- Fetch & Index Tool ---\n");

  await test("fetch_and_index: indexes URL content", async () => {
    const proc = startServer();
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(proc, {
      jsonrpc: "2.0",
      id: 60,
      method: "tools/call",
      params: {
        name: "fetch_and_index",
        arguments: {
          url: "https://example.com",
          source: "Example Domain",
        },
      },
    });
    const responses = await collectResponses(proc, 10000);
    const result = responses.find((r) => r.id === 60);
    assert(!!result, "No response for fetch_and_index");
    const text = result!.result?.content?.[0]?.text || "";
    // example.com should return some content (even if minimal)
    // It either indexes successfully or fails gracefully
    assert(
      text.includes("Indexed") || text.includes("Failed") || text.includes("empty"),
      "Should return index result or error: " + text,
    );
  });

  await test("fetch_and_index: handles invalid URL gracefully", async () => {
    const proc = startServer();
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(proc, {
      jsonrpc: "2.0",
      id: 61,
      method: "tools/call",
      params: {
        name: "fetch_and_index",
        arguments: {
          url: "https://this-domain-does-not-exist-xyz123.com",
          source: "Invalid",
        },
      },
    });
    const responses = await collectResponses(proc, 10000);
    const result = responses.find((r) => r.id === 61);
    assert(!!result, "No response");
    assert(
      result!.result?.isError === true,
      "Should return error for invalid URL",
    );
  });

  // ===== Test 6: Context savings measurement =====
  console.log("\n--- Context Savings (real measurement) ---\n");

  const savingsTests = [
    { fixture: "access.log", name: "Access log (500 req)" },
    { fixture: "analytics.csv", name: "Analytics CSV (500 rows)" },
    { fixture: "mcp-tools.json", name: "MCP tools (40 tools)" },
    { fixture: "git-log.txt", name: "Git log (153 commits)" },
    { fixture: "test-output.txt", name: "Test output (30 suites)" },
  ];

  for (const st of savingsTests) {
    await test(`context savings: ${st.name}`, async () => {
      const rawContent = readFileSync(join(fixtureDir, st.fixture), "utf-8");
      const rawBytes = Buffer.byteLength(rawContent);

      const proc = startServer();
      send(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      });
      send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
      send(proc, {
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: {
          name: "execute_file",
          arguments: {
            path: join(fixtureDir, st.fixture),
            language: "javascript",
            code: 'const lines = FILE_CONTENT.trim().split("\\n"); console.log("Lines: " + lines.length + " | Size: " + FILE_CONTENT.length + " chars");',
          },
        },
      });
      const responses = await collectResponses(proc, 3000);
      const result = responses.find((r) => r.id === 30);
      assert(!!result, "No response");
      const text = result!.result?.content?.[0]?.text || "";
      assert(!result!.result?.isError, "Error: " + text);

      const outputBytes = Buffer.byteLength(text);
      const savings = ((1 - outputBytes / rawBytes) * 100).toFixed(0);
      console.log(
        `    Raw: ${(rawBytes / 1024).toFixed(1)}KB → Output: ${outputBytes}B (${savings}% saved)`,
      );
      assert(outputBytes < rawBytes, "Output should be smaller than raw");
    });
  }

  // ===== Test 7: Error handling =====
  console.log("\n--- Error Handling ---\n");

  await test("returns isError for bad code", async () => {
    const proc = startServer();
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(proc, {
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "execute",
        arguments: {
          language: "javascript",
          code: 'throw new Error("test");',
        },
      },
    });
    const responses = await collectResponses(proc, 3000);
    const result = responses.find((r) => r.id === 40);
    assert(!!result, "No response");
    assert(result!.result?.isError === true, "Should be isError");
  });

  await test("returns isError for nonexistent file", async () => {
    const proc = startServer();
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(proc, {
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "execute_file",
        arguments: {
          path: "/tmp/nonexistent-file-xyz.json",
          language: "javascript",
          code: "console.log(FILE_CONTENT.length);",
        },
      },
    });
    const responses = await collectResponses(proc, 3000);
    const result = responses.find((r) => r.id === 41);
    assert(!!result, "No response");
    assert(result!.result?.isError === true, "Should be isError for missing file");
  });

  // ===== Summary =====
  console.log("\n" + "=".repeat(50));
  console.log(`MCP Integration: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(50));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Integration test error:", err);
  process.exit(1);
});
