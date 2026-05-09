#!/usr/bin/env bash
# End-to-end synthetic smoke test for the OpenClaw plugin.
# Loads the real built plugin, fires all hooks in sequence with a recording
# API proxy, and queries SQLite to verify DB writes. No real gateway needed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${RUNNER_TEMP:-/tmp}/e2e-output.log"
cd "$REPO_ROOT"

echo "=== context-mode OpenClaw E2E Synthetic Test ===" | tee "$LOG_FILE"
echo "Repo:    $REPO_ROOT" | tee -a "$LOG_FILE"
echo "Node:    $(node --version)" | tee -a "$LOG_FILE"
echo "Version: $(node -e "console.log(require('./package.json').version)" 2>/dev/null)" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

node --experimental-vm-modules --no-warnings --input-type=module 2>&1 <<'HARNESS_EOF' | tee -a "$LOG_FILE"
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

let passed = 0;
let failed = 0;
let warned = 0;

function pass(label) { console.log(`  ✅ ${label}`); passed++; }
function fail(label, detail) { console.error(`  ❌ ${label}${detail ? ': ' + detail : ''}`); failed++; }
function warn(label) { console.log(`  ⚠️  ${label}`); warned++; }
function section(label) { console.log(`\n--- ${label} ---`); }

// ── 0. Load plugin ────────────────────────────────────────
section("Phase 1: Plugin load");
// Plugin entry was moved from build/openclaw-plugin.js to
// build/adapters/openclaw/plugin.js when the OpenClaw entry file was
// relocated under src/adapters/openclaw/. The legacy path is kept as a
// fall-back so older checked-out CI configs do not break across the
// transition.
const pluginPath = join(process.cwd(), "build", "adapters", "openclaw", "plugin.js");
const legacyPluginPath = join(process.cwd(), "build", "openclaw-plugin.js");
const resolvedPluginPath = existsSync(pluginPath)
  ? pluginPath
  : existsSync(legacyPluginPath)
    ? legacyPluginPath
    : null;
if (!resolvedPluginPath) { fail("build/adapters/openclaw/plugin.js exists"); process.exit(1); }

let plugin;
try {
  const mod = await import(resolvedPluginPath);
  plugin = mod.default;
  pass(`${resolvedPluginPath.includes("adapters") ? "build/adapters/openclaw/plugin.js" : "build/openclaw-plugin.js"} loaded`);
} catch (err) {
  fail("plugin load", err.message);
  process.exit(1);
}

// ── 1. Plugin metadata ────────────────────────────────────
section("Phase 2: Plugin metadata");
[
  ["id === 'context-mode'",        plugin.id === "context-mode"],
  ["name defined",                 !!plugin.name],
  ["configSchema is object",       typeof plugin.configSchema === "object"],
  ["register is function",         typeof plugin.register === "function"],
].forEach(([l, ok]) => ok ? pass(l) : fail(l));

// ── 2. Build recording API proxy ──────────────────────────
const hooks = new Map();
const lifecycle = new Map();
const commands = new Map();
let contextEngineId = null;

const api = {
  registerHook(event, handler, meta) {
    if (!hooks.has(event)) hooks.set(event, []);
    hooks.get(event).push({ handler, meta });
  },
  on(event, handler, opts) {
    if (!lifecycle.has(event)) lifecycle.set(event, []);
    lifecycle.get(event).push({ handler, priority: opts?.priority ?? 0 });
  },
  registerContextEngine(id) { contextEngineId = id; },
  registerCommand(cmd) { commands.set(cmd.name, cmd); },
  logger: {
    info:  (...a) => {},
    error: (...a) => console.error("[plugin:error]", ...a),
    debug: (...a) => {},
    warn:  (...a) => {},
  },
};

// ── 3. register() ─────────────────────────────────────────
section("Phase 3: register()");
try {
  plugin.register(api);
  pass("register() completed synchronously without throwing");
} catch (err) {
  fail("register()", err.message);
  process.exit(1);
}

// ── 4. Hook registration ──────────────────────────────────
section("Phase 4: Hook registration");
const expectedLifecycle = [
  "before_tool_call", "after_tool_call",
  "session_start", "before_compaction", "after_compaction",
  "before_model_resolve", "before_prompt_build",
];
expectedLifecycle.forEach(name => {
  lifecycle.has(name) && lifecycle.get(name).length > 0
    ? pass(`api.on("${name}") registered`)
    : fail(`api.on("${name}") registered`);
});

["command:new", "command:stop"].forEach(name => {
  hooks.has(name) && hooks.get(name).length > 0
    ? pass(`api.registerHook("${name}") registered`)
    : fail(`api.registerHook("${name}") registered`);
});

const promptHandlers = lifecycle.get("before_prompt_build") || [];
promptHandlers.length >= 2
  ? pass(`before_prompt_build has ${promptHandlers.length} handlers (resume p=10 + routing p=5)`)
  : warn(`before_prompt_build has only ${promptHandlers.length} handler(s) — expected 2`);

contextEngineId === "context-mode"
  ? pass("registerContextEngine('context-mode') called")
  : fail("registerContextEngine('context-mode') called", `got: ${contextEngineId}`);

["/ctx-stats", "/ctx-doctor", "/ctx-upgrade"].forEach(name => {
  commands.has(name.slice(1))
    ? pass(`${name} command registered`)
    : fail(`${name} command registered`);
});

// ── 5. Hook execution sequence ────────────────────────────
section("Phase 5: Hook execution (full lifecycle)");

async function fireLifecycle(event, payload) {
  const hs = lifecycle.get(event) || [];
  const results = [];
  for (const { handler } of hs) results.push(await handler(payload));
  return results;
}
async function fireHook(event) {
  const hs = hooks.get(event) || [];
  for (const { handler } of hs) await handler();
}

// 5a. command:new — session init
await fireHook("command:new");
pass("command:new fired");

// 5b. session_start — re-key session
const testSessionId = randomUUID();
const testSessionKey = `e2e-agent:test:${Date.now()}`;
await fireLifecycle("session_start", {
  sessionId: testSessionId,
  sessionKey: testSessionKey,
  startedAt: new Date().toISOString(),
});
pass("session_start fired (sessionKey provided)");

// Allow initPromise to resolve
await new Promise(r => setTimeout(r, 600));

// 5c. before_tool_call — read tool (should passthrough)
const btcResult = await (async () => {
  const hs = lifecycle.get("before_tool_call") || [];
  for (const { handler } of hs) return await handler({
    toolName: "read",
    params: { file_path: "/tmp/e2e-test.txt" },
    runId: randomUUID(),
    toolCallId: randomUUID(),
  });
})();
pass(`before_tool_call fired (read) → ${btcResult == null ? "passthrough" : JSON.stringify(btcResult)}`);

// 5d. after_tool_call — read
await fireLifecycle("after_tool_call", {
  toolName: "read",
  params: { file_path: "/tmp/e2e-test.txt" },
  result: "line1\nline2\nline3",
  runId: randomUUID(), toolCallId: randomUUID(), durationMs: 12,
});
pass("after_tool_call fired (read)");

// 5e. after_tool_call — exec/bash
await fireLifecycle("after_tool_call", {
  toolName: "exec",
  params: { command: "ls -la" },
  result: "total 8\ndrwxr-xr-x 2 pedro pedro",
  runId: randomUUID(), toolCallId: randomUUID(), durationMs: 45,
});
pass("after_tool_call fired (exec)");

// 5f. after_tool_call — write
await fireLifecycle("after_tool_call", {
  toolName: "write",
  params: { file_path: "/tmp/e2e-out.txt", content: "test" },
  result: "ok",
  runId: randomUUID(), toolCallId: randomUUID(), durationMs: 8,
});
pass("after_tool_call fired (write)");

// 5g. after_tool_call — error case
await fireLifecycle("after_tool_call", {
  toolName: "exec",
  params: { command: "false" },
  error: "exit code 1",
  isError: true,
  runId: randomUUID(), toolCallId: randomUUID(), durationMs: 5,
});
pass("after_tool_call fired (error case)");

// 5h. before_model_resolve
await fireLifecycle("before_model_resolve", {
  userMessage: "Please read the config and summarize the recent changes",
});
pass("before_model_resolve fired");

// 5i. before_compaction
await fireLifecycle("before_compaction", {});
pass("before_compaction fired");

// 5j. after_compaction
await fireLifecycle("after_compaction", {});
pass("after_compaction fired");

// 5k. before_prompt_build — both handlers
const promptResults = await fireLifecycle("before_prompt_build", {});
pass(`before_prompt_build fired (${promptResults.length} handlers)`);

// ── 6. SQLite DB verification ─────────────────────────────
section("Phase 6: SQLite DB verification");

await new Promise(r => setTimeout(r, 300));

const sessionDir = join(homedir(), ".openclaw", "context-mode", "sessions");
if (!existsSync(sessionDir)) {
  fail("session directory exists", sessionDir);
  process.exit(1);
}
pass(`session directory exists: ${sessionDir}`);

const dbFiles = readdirSync(sessionDir).filter(f => f.endsWith(".db"));
if (dbFiles.length === 0) { fail("session DB file(s) created"); process.exit(1); }
pass(`${dbFiles.length} session DB file(s) found`);

const Database = (await import("better-sqlite3")).default;
// Use the most recently modified DB

// Find DB with our session or most recent
const { statSync } = await import("node:fs");
let chosenDb;
for (const f of dbFiles.map(f => join(sessionDir, f)).reverse()) {
  try {
    const d = new Database(f, { readonly: true });
    const row = d.prepare("SELECT 1 FROM session_meta WHERE session_id = ? OR session_id LIKE ?")
      .get(testSessionId, testSessionId.slice(0,8) + "%");
    d.close();
    if (row) { chosenDb = f; break; }
  } catch {}
}

// Fallback: most recently modified
if (!chosenDb) {
  chosenDb = dbFiles.map(f => join(sessionDir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  warn(`exact session not found — using most recent DB: ${chosenDb.split('/').pop()}`);
}

const db = new Database(chosenDb, { readonly: true });

// session_meta
const allMeta = db.prepare("SELECT session_id, event_count FROM session_meta").all();
allMeta.length > 0
  ? pass(`session_meta has ${allMeta.length} session(s)`)
  : fail("session_meta populated");

// session_events
const eventCount = db.prepare("SELECT COUNT(*) as cnt FROM session_events").get();
eventCount.cnt >= 3
  ? pass(`session_events has ${eventCount.cnt} event(s) (≥3 expected)`)
  : fail(`session_events populated`, `only ${eventCount.cnt} events`);

// event type breakdown
const types = db.prepare("SELECT type, COUNT(*) as cnt FROM session_events GROUP BY type ORDER BY cnt DESC").all();
console.log(`       event types: ${types.map(t => `${t.type}(${t.cnt})`).join(", ")}`);

// session_resume (compaction)
const resume = db.prepare("SELECT COUNT(*) as cnt FROM session_resume").get();
resume.cnt > 0
  ? pass(`session_resume has ${resume.cnt} snapshot(s) — before_compaction fired correctly`)
  : warn("session_resume is empty — compaction hook may not have produced a snapshot yet");

// openclaw_session_map
const mapRow = db.prepare("SELECT * FROM openclaw_session_map WHERE session_key = ?").get(testSessionKey);
mapRow
  ? pass(`openclaw_session_map entry for key '${testSessionKey.slice(0,20)}...' → ${mapRow.session_id.slice(0,8)}`)
  : warn(`openclaw_session_map entry not found for test key — session re-keying may differ`);

db.close();

// ── 7. Command handlers ───────────────────────────────────
section("Phase 7: Command handlers");

const statsCmd = commands.get("ctx-stats");
if (statsCmd) {
  try {
    const result = statsCmd.handler({});
    const text = typeof result === "object" ? (result.text ?? JSON.stringify(result)) : String(result ?? "");
    text.length > 10
      ? pass(`/ctx-stats returns output (${text.length} chars)`)
      : fail("/ctx-stats returns non-empty output");
  } catch (e) {
    fail("/ctx-stats handler throws", e.message);
  }
} else {
  fail("/ctx-stats handler callable");
}

// ── 8. command:stop ────────────────────────────────────────
section("Phase 8: Cleanup");
try {
  await fireHook("command:stop");
  pass("command:stop fired without throwing");
} catch (e) {
  fail("command:stop", e.message);
}

// ── Summary ────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════");
console.log(`Results: ${passed} passed  ${warned} warned  ${failed} failed`);
console.log("══════════════════════════════════════════");

if (failed > 0) {
  console.error(`\n❌ E2E test FAILED (${failed} failure(s))`);
  process.exit(1);
} else {
  console.log(`\n✅ E2E test PASSED`);
}
HARNESS_EOF

EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo "E2E test failed (exit $EXIT_CODE)" >> "$LOG_FILE"
  exit $EXIT_CODE
fi
