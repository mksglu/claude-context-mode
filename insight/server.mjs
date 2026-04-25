#!/usr/bin/env node
/**
 * context-mode Insight — Local analytics dashboard.
 * Cross-platform: works with Bun (bun:sqlite) or Node.js (better-sqlite3).
 *
 * Usage:
 *   bun insight/server.mjs      # fast, uses bun:sqlite
 *   node insight/server.mjs     # fallback, uses better-sqlite3
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4747;

// ── Cross-platform SQLite ────────────────────────────────
// Detect runtime: Bun has bun:sqlite built-in, Node needs better-sqlite3

let Database;
const isBun = typeof globalThis.Bun !== "undefined";

if (isBun) {
  Database = (await import("bun:sqlite")).Database;
} else {
  try {
    Database = (await import("better-sqlite3")).default;
    // Verify native addon loads correctly (catches arch mismatch: x86_64 vs arm64)
    const testDb = new Database(":memory:");
    testDb.close();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("\n  Error: better-sqlite3 failed to load.");
    console.error(`  ${msg}`);
    if (msg.includes("incompatible architecture") || msg.includes("dlopen")) {
      const cacheHint = process.env.INSIGHT_SESSION_DIR
        ? join(dirname(process.env.INSIGHT_SESSION_DIR), "insight-cache", "node_modules")
        : join("~", ".claude", "context-mode", "insight-cache", "node_modules");
      console.error(`\n  Fix: rm -rf ${cacheHint} && context-mode insight`);
    } else {
      console.error("  Install it: npm install better-sqlite3");
    }
    process.exit(1);
  }
}

// ── Paths ────────────────────────────────────────────────
const SESSION_DIR = process.env.INSIGHT_SESSION_DIR || join(homedir(), ".claude", "context-mode", "sessions");
const CONTENT_DIR = process.env.INSIGHT_CONTENT_DIR || join(homedir(), ".claude", "context-mode", "content");
const DIST_DIR = join(__dirname, "dist");

// ── SQLite helpers ───────────────────────────────────────

function openDB(path) {
  try {
    return isBun
      ? new Database(path, { readonly: true })
      : new Database(path, { readonly: true, fileMustExist: true });
  } catch { return null; }
}

function safeAll(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function safeGet(db, sql, params = []) {
  try { return db.prepare(sql).get(...params); } catch { return null; }
}

function listDBFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".db"))
    .map(f => ({ name: f, path: join(dir, f), size: statSync(join(dir, f)).size }));
}

function formatBytes(b) {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function queryAllSessionDBs(fn) {
  const results = [];
  for (const f of listDBFiles(SESSION_DIR)) {
    const db = openDB(f.path);
    if (!db) continue;
    try { results.push(...fn(db)); } finally { db.close(); }
  }
  return results;
}

function queryAllContentDBs(fn) {
  const results = [];
  for (const f of listDBFiles(CONTENT_DIR)) {
    const db = openDB(f.path);
    if (!db) continue;
    try { results.push(...fn(db)); } finally { db.close(); }
  }
  return results;
}

function mergeByKey(arr, key, mergeFn) {
  const map = new Map();
  for (const item of arr) {
    const k = item[key];
    if (map.has(k)) map.set(k, mergeFn(map.get(k), item));
    else map.set(k, { ...item });
  }
  return [...map.values()];
}

// ── Input validation ────────────────────────────────────
function isValidHash(hash) {
  return /^[a-f0-9_]+$/.test(hash);
}

// ── API Handlers ─────────────────────────────────────────

function apiOverview() {
  const contentDBs = listDBFiles(CONTENT_DIR);
  const sessionDBs = listDBFiles(SESSION_DIR);
  let totalSources = 0, totalChunks = 0, totalContentSize = 0;
  let totalSessions = 0, totalEvents = 0, totalSessionSize = 0;

  for (const f of contentDBs) {
    totalContentSize += f.size;
    const db = openDB(f.path);
    if (!db) continue;
    try {
      totalSources += safeGet(db, "SELECT COUNT(*) as c FROM sources")?.c || 0;
      totalChunks += safeGet(db, "SELECT COUNT(*) as c FROM chunks")?.c || 0;
    } finally { db.close(); }
  }
  for (const f of sessionDBs) {
    totalSessionSize += f.size;
    const db = openDB(f.path);
    if (!db) continue;
    try {
      totalSessions += safeGet(db, "SELECT COUNT(*) as c FROM session_meta")?.c || 0;
      totalEvents += safeGet(db, "SELECT COUNT(*) as c FROM session_events")?.c || 0;
    } finally { db.close(); }
  }
  return {
    content: { databases: contentDBs.length, sources: totalSources, chunks: totalChunks,
      totalSize: formatBytes(totalContentSize), totalSizeBytes: totalContentSize },
    sessions: { databases: sessionDBs.length, sessions: totalSessions, events: totalEvents,
      totalSize: formatBytes(totalSessionSize), totalSizeBytes: totalSessionSize },
  };
}

function apiContentDBs() {
  return listDBFiles(CONTENT_DIR).map(f => {
    const db = openDB(f.path);
    if (!db) return { hash: f.name.replace(".db",""), size: formatBytes(f.size), sources: [], sourceCount: 0, chunkCount: 0 };
    try {
      const sources = safeAll(db, "SELECT id, label, chunk_count, code_chunk_count, indexed_at FROM sources ORDER BY indexed_at DESC");
      const chunkCount = safeGet(db, "SELECT COUNT(*) as c FROM chunks")?.c || 0;
      return {
        hash: f.name.replace(".db",""), size: formatBytes(f.size), sizeBytes: f.size,
        sourceCount: sources.length, chunkCount,
        sources: sources.map(s => ({ id: s.id, label: s.label, chunks: s.chunk_count, codeChunks: s.code_chunk_count, indexedAt: s.indexed_at })),
      };
    } finally { db.close(); }
  });
}

function apiSourceChunks(dbHash, sourceId) {
  const db = openDB(join(CONTENT_DIR, `${dbHash}.db`));
  if (!db) return [];
  try {
    return safeAll(db,
      `SELECT c.title, c.content, c.content_type, s.label
       FROM chunks c JOIN sources s ON s.id = c.source_id
       WHERE c.source_id = ? ORDER BY c.rowid`, [sourceId]);
  } finally { db.close(); }
}

function apiSearchAll(query) {
  const results = [];
  for (const f of listDBFiles(CONTENT_DIR)) {
    const db = openDB(f.path);
    if (!db) continue;
    try {
      const rows = safeAll(db,
        `SELECT c.title, c.content, c.content_type, s.label,
                bm25(chunks, 5.0, 1.0) AS rank,
                highlight(chunks, 1, '«', '»') AS highlighted
         FROM chunks c JOIN sources s ON s.id = c.source_id
         WHERE chunks MATCH ?
         ORDER BY rank LIMIT 10`, [query]);
      results.push(...rows.map(r => ({ ...r, dbHash: f.name.replace(".db","") })));
    } finally { db.close(); }
  }
  if (results.length > 0) {
    return results.sort((a, b) => a.rank - b.rank).slice(0, 30);
  }
  // Fallback: LIKE search across content + session events
  const likeResults = [];
  const likePattern = `%${query}%`;
  for (const f of listDBFiles(CONTENT_DIR)) {
    const db = openDB(f.path);
    if (!db) continue;
    try {
      const rows = safeAll(db,
        `SELECT c.title, c.content, c.content_type, s.label
         FROM chunks c JOIN sources s ON s.id = c.source_id
         WHERE c.content LIKE ? LIMIT 10`, [likePattern]);
      likeResults.push(...rows.map(r => ({ ...r, rank: 0, highlighted: null, dbHash: f.name.replace(".db","") })));
    } finally { db.close(); }
  }
  for (const f of listDBFiles(SESSION_DIR)) {
    const db = openDB(f.path);
    if (!db) continue;
    try {
      const rows = safeAll(db,
        `SELECT se.type as title, se.data as content, 'session' as content_type,
                sm.project_dir as label
         FROM session_events se
         LEFT JOIN session_meta sm ON se.session_id = sm.session_id
         WHERE se.data LIKE ? LIMIT 10`, [likePattern]);
      likeResults.push(...rows.map(r => ({ ...r, rank: 0, highlighted: null, dbHash: "session:" + f.name.replace(".db","").slice(0, 8) })));
    } finally { db.close(); }
  }
  return likeResults.slice(0, 20);
}

function apiSessionDBs() {
  return listDBFiles(SESSION_DIR).map(f => {
    const db = openDB(f.path);
    if (!db) return { hash: f.name.replace(".db",""), size: formatBytes(f.size), sessions: [] };
    try {
      const sessions = safeAll(db,
        `SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count
         FROM session_meta ORDER BY started_at DESC`);
      return {
        hash: f.name.replace(".db",""), size: formatBytes(f.size), sizeBytes: f.size,
        sessions: sessions.map(s => ({ id: s.session_id, projectDir: s.project_dir,
          startedAt: s.started_at, lastEventAt: s.last_event_at,
          eventCount: s.event_count, compactCount: s.compact_count })),
      };
    } finally { db.close(); }
  });
}

function apiSessionEvents(dbHash, sessionId) {
  const db = openDB(join(SESSION_DIR, `${dbHash}.db`));
  if (!db) return { events: [], resume: null };
  try {
    const events = safeAll(db,
      `SELECT id, type, category, priority, data, source_hook, created_at
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT 500`, [sessionId]);
    const resume = safeGet(db,
      `SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?`, [sessionId]);
    return { events, resume };
  } finally { db.close(); }
}

function apiDeleteSource(dbHash, sourceId) {
  try {
    const dbPath = join(CONTENT_DIR, `${dbHash}.db`);
    const db = isBun ? new Database(dbPath) : new Database(dbPath);
    db.prepare("DELETE FROM chunks WHERE source_id = ?").run(sourceId);
    try { db.prepare("DELETE FROM chunks_trigram WHERE source_id = ?").run(sourceId); } catch {}
    db.prepare("DELETE FROM sources WHERE id = ?").run(sourceId);
    db.close();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

function apiAnalytics() {
  const sessionDurations = queryAllSessionDBs(db =>
    safeAll(db, `SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count,
      ROUND((julianday(last_event_at) - julianday(started_at)) * 24 * 60, 1) as duration_min
      FROM session_meta WHERE started_at IS NOT NULL AND last_event_at IS NOT NULL
      ORDER BY started_at DESC LIMIT 50`)
  );
  const sessionsByDate = queryAllSessionDBs(db =>
    safeAll(db, `SELECT date(started_at) as date, COUNT(*) as count,
      SUM(event_count) as events, SUM(compact_count) as compacts
      FROM session_meta WHERE started_at IS NOT NULL
      GROUP BY date(started_at) ORDER BY date`)
  );
  const toolUsage = queryAllSessionDBs(db =>
    safeAll(db, `SELECT
      CASE
        WHEN type = 'file_read' THEN 'Read'
        WHEN type = 'file_write' THEN 'Write/Edit'
        WHEN type = 'file_glob' THEN 'Glob'
        WHEN type = 'file_search' THEN 'Grep'
        WHEN type = 'mcp' THEN 'context-mode'
        WHEN type = 'git' THEN 'Git'
        WHEN type = 'subagent' THEN 'Agent'
        WHEN type = 'task' THEN 'Task'
        WHEN type = 'error_tool' THEN 'Error'
        ELSE type
      END as tool, COUNT(*) as count
      FROM session_events
      WHERE type NOT IN ('rule', 'rule_content', 'user_prompt', 'intent', 'data', 'role', 'cwd')
      GROUP BY tool ORDER BY count DESC`)
  );
  const mcpTools = queryAllSessionDBs(db =>
    safeAll(db, `SELECT
      CASE
        WHEN data LIKE 'batch_execute%' THEN 'batch_execute'
        WHEN data LIKE 'execute_file%' THEN 'execute_file'
        WHEN data LIKE 'execute%' THEN 'execute'
        WHEN data LIKE 'search%' THEN 'search'
        WHEN data LIKE 'index%' THEN 'index'
        WHEN data LIKE 'fetch%' THEN 'fetch_and_index'
        WHEN data LIKE 'stats%' THEN 'stats'
        WHEN data LIKE 'purge%' THEN 'purge'
        ELSE substr(data, 1, 20)
      END as tool, COUNT(*) as count
      FROM session_events WHERE type = 'mcp'
      GROUP BY tool ORDER BY count DESC`)
  );
  const readWriteRatio = queryAllSessionDBs(db =>
    safeAll(db, `SELECT
      SUM(CASE WHEN type = 'file_read' THEN 1 ELSE 0 END) as reads,
      SUM(CASE WHEN type = 'file_write' THEN 1 ELSE 0 END) as writes,
      SUM(CASE WHEN type IN ('file_read', 'file_write', 'file', 'file_glob', 'file_search') THEN 1 ELSE 0 END) as total_file_ops
      FROM session_events`)
  );
  const errors = queryAllSessionDBs(db =>
    safeAll(db, `SELECT data as detail, created_at, session_id FROM session_events
      WHERE type = 'error_tool' OR type = 'error' ORDER BY created_at DESC LIMIT 20`)
  );
  const fileActivity = queryAllSessionDBs(db =>
    safeAll(db, `SELECT data as file, type as op, COUNT(*) as count FROM session_events
      WHERE type IN ('file_read', 'file_write', 'file') AND data != ''
      GROUP BY data ORDER BY count DESC LIMIT 20`)
  );
  const workModes = queryAllSessionDBs(db =>
    safeAll(db, `SELECT data as mode, COUNT(*) as count
      FROM session_events WHERE type = 'intent' AND data != ''
      GROUP BY data ORDER BY count DESC`)
  );
  const timeToFirstCommit = queryAllSessionDBs(db =>
    safeAll(db, `SELECT sm.session_id, sm.started_at,
      MIN(se.created_at) as first_commit_at,
      ROUND((julianday(MIN(se.created_at)) - julianday(sm.started_at)) * 24 * 60, 1) as minutes_to_commit
      FROM session_meta sm
      JOIN session_events se ON se.session_id = sm.session_id
      WHERE se.type = 'git' AND se.data = 'commit'
      GROUP BY sm.session_id`)
  );
  const exploreExecRatio = queryAllSessionDBs(db =>
    safeAll(db, `SELECT
      SUM(CASE WHEN type IN ('file_read', 'file_glob', 'file_search') THEN 1 ELSE 0 END) as explore,
      SUM(CASE WHEN type IN ('file_write') THEN 1 ELSE 0 END) as execute,
      COUNT(*) as total
      FROM session_events WHERE type IN ('file_read', 'file_glob', 'file_search', 'file_write')`)
  );
  const reworkData = queryAllSessionDBs(db =>
    safeAll(db, `SELECT se.session_id, se.data as file, COUNT(*) as edit_count
      FROM session_events se
      WHERE se.type IN ('file_write', 'file_read') AND se.data != ''
      GROUP BY se.session_id, se.data HAVING edit_count > 1
      ORDER BY edit_count DESC LIMIT 20`)
  );
  const gitActivity = queryAllSessionDBs(db =>
    safeAll(db, `SELECT se.data as action, se.created_at, se.session_id,
      sm.project_dir, sm.started_at as session_start
      FROM session_events se
      JOIN session_meta sm ON se.session_id = sm.session_id
      WHERE se.type = 'git' ORDER BY se.created_at DESC LIMIT 20`)
  );
  const rawSubagents = queryAllSessionDBs(db =>
    safeAll(db, `SELECT data as task, created_at, session_id FROM session_events
      WHERE type = 'subagent' ORDER BY created_at ASC`)
  );
  const bursts = [];
  let currentBurst = [];
  for (const s of rawSubagents) {
    if (currentBurst.length === 0) { currentBurst.push(s); continue; }
    const last = currentBurst[currentBurst.length - 1];
    const gap = (new Date(s.created_at) - new Date(last.created_at)) / 1000;
    if (gap <= 30) { currentBurst.push(s); }
    else { if (currentBurst.length > 0) bursts.push([...currentBurst]); currentBurst = [s]; }
  }
  if (currentBurst.length > 0) bursts.push(currentBurst);
  const parallelBursts = bursts.filter(b => b.length >= 2);
  const subagents = {
    total: rawSubagents.length,
    bursts: parallelBursts.length,
    maxConcurrent: bursts.reduce((max, b) => Math.max(max, b.length), 0),
    parallelCount: parallelBursts.reduce((a, b) => a + b.length, 0),
    sequentialCount: rawSubagents.length - parallelBursts.reduce((a, b) => a + b.length, 0),
    timeSavedMin: parallelBursts.reduce((a, b) => a + (b.length - 1) * 2, 0),
    burstDetails: parallelBursts.map(b => ({ size: b.length, time: b[0].created_at })),
  };
  const projectActivity = queryAllSessionDBs(db =>
    safeAll(db, `SELECT project_dir, COUNT(*) as sessions, SUM(event_count) as events,
      SUM(compact_count) as compacts
      FROM session_meta WHERE project_dir IS NOT NULL
      GROUP BY project_dir ORDER BY events DESC LIMIT 10`)
  );
  const hourlyPattern = queryAllSessionDBs(db =>
    safeAll(db, `SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
      FROM session_events WHERE created_at IS NOT NULL
      GROUP BY hour ORDER BY hour`)
  );
  const weeklyTrend = queryAllSessionDBs(db =>
    safeAll(db, `SELECT strftime('%Y-W%W', started_at) as week, COUNT(*) as sessions,
      SUM(event_count) as events
      FROM session_meta WHERE started_at IS NOT NULL
      GROUP BY week ORDER BY week`)
  );
  const tasks = queryAllSessionDBs(db =>
    safeAll(db, `SELECT substr(data, 1, 100) as task, created_at FROM session_events
      WHERE type = 'task' ORDER BY created_at DESC LIMIT 20`)
  );
  const prompts = queryAllSessionDBs(db =>
    safeAll(db, `SELECT substr(data, 1, 100) as prompt, created_at, session_id FROM session_events
      WHERE type = 'user_prompt' ORDER BY created_at DESC LIMIT 20`)
  );

  const rw = readWriteRatio.reduce((a, b) => ({
    reads: (a.reads || 0) + (b.reads || 0), writes: (a.writes || 0) + (b.writes || 0),
    total_file_ops: (a.total_file_ops || 0) + (b.total_file_ops || 0),
  }), { reads: 0, writes: 0, total_file_ops: 0 });
  const totalEvents = toolUsage.reduce((a, b) => a + b.count, 0);
  const totalErrors = errors.length;
  const totalCompacts = sessionDurations.reduce((a, b) => a + (b.compact_count || 0), 0);
  const sessionsWithCompact = sessionDurations.filter(s => s.compact_count > 0).length;

  // ── New metric queries ──────────────────────────────────

  // 1. Tool Mastery Curve — weekly error rate trend
  const masteryTrend = queryAllSessionDBs(db =>
    safeAll(db, `SELECT strftime('%Y-W%W', created_at) as week,
      SUM(CASE WHEN type = 'error_tool' THEN 1 ELSE 0 END) as errors,
      COUNT(*) as total,
      ROUND(100.0 * SUM(CASE WHEN type = 'error_tool' THEN 1 ELSE 0 END) / COUNT(*), 1) as error_rate
      FROM session_events WHERE created_at IS NOT NULL
      GROUP BY week ORDER BY week`)
  );

  // 2. Personal Commit Rate — commits per session
  const commitRate = queryAllSessionDBs(db =>
    safeAll(db, `SELECT sm.session_id, sm.project_dir,
      SUM(CASE WHEN se.type = 'git' AND se.data = 'commit' THEN 1 ELSE 0 END) as commits
      FROM session_meta sm
      LEFT JOIN session_events se ON se.session_id = sm.session_id
      GROUP BY sm.session_id`)
  );

  // 3. Sandbox Adoption — context-mode MCP tool usage vs total
  const sandboxAdoption = queryAllSessionDBs(db =>
    safeAll(db, `SELECT
      SUM(CASE WHEN type = 'mcp' THEN 1 ELSE 0 END) as sandbox_calls,
      COUNT(*) as total_calls
      FROM session_events
      WHERE type NOT IN ('rule', 'rule_content', 'user_prompt', 'intent', 'data', 'role', 'cwd')`)
  );

  // 4. CLAUDE.md Freshness — rule files loaded, how many distinct
  const rulesFreshness = queryAllSessionDBs(db =>
    safeAll(db, `SELECT data as rule_path, MAX(created_at) as last_seen, COUNT(*) as load_count
      FROM session_events WHERE type = 'rule' AND data != ''
      GROUP BY data ORDER BY last_seen DESC`)
  );

  // 5. Edit-Test Cycle — write followed by error patterns
  const editTestCycles = queryAllSessionDBs(db =>
    safeAll(db, `SELECT se1.session_id, COUNT(*) as cycles
      FROM session_events se1
      JOIN session_events se2 ON se1.session_id = se2.session_id AND se2.id > se1.id
        AND se2.id = (SELECT MIN(id) FROM session_events WHERE id > se1.id AND session_id = se1.session_id)
      WHERE se1.type = 'file_write' AND se2.type = 'error_tool'
      GROUP BY se1.session_id`)
  );

  // 6. Bug-Fix Ratio — derived from workModes (already queried above)

  // ── Derived aggregates for new metrics ──────────────────
  const sandboxAgg = sandboxAdoption.reduce((a, b) => ({
    sandbox_calls: (a.sandbox_calls || 0) + (b.sandbox_calls || 0),
    total_calls: (a.total_calls || 0) + (b.total_calls || 0),
  }), { sandbox_calls: 0, total_calls: 0 });

  return {
    totals: {
      totalSessions: sessionDurations.length, totalEvents,
      avgSessionMin: sessionDurations.length > 0
        ? Math.round(sessionDurations.reduce((a, b) => a + (b.duration_min || 0), 0) / sessionDurations.length) : 0,
      totalErrors,
      errorRate: totalEvents > 0 ? Math.round(1000 * totalErrors / totalEvents) / 10 : 0,
      totalCompacts,
      compactRate: sessionDurations.length > 0 ? Math.round(100 * sessionsWithCompact / sessionDurations.length) : 0,
      reads: rw.reads, writes: rw.writes,
      readWriteRatio: rw.writes > 0 ? Math.round(10 * rw.reads / rw.writes) / 10 : rw.reads,
      totalFileOps: rw.total_file_ops, totalSubagents: subagents.total,
      totalTasks: tasks.length, totalPrompts: prompts.length,
      promptsPerSession: sessionDurations.length > 0
        ? Math.round(10 * prompts.length / sessionDurations.length) / 10 : 0,
      uniqueProjects: projectActivity.length,
      totalCommits: commitRate.reduce((a, b) => a + (b.commits || 0), 0),
      commitsPerSession: sessionDurations.length > 0
        ? Math.round(10 * commitRate.reduce((a, b) => a + (b.commits || 0), 0) / sessionDurations.length) / 10 : 0,
      sandboxRate: sandboxAgg.total_calls > 0
        ? Math.round(1000 * sandboxAgg.sandbox_calls / sandboxAgg.total_calls) / 10 : 0,
      totalRules: rulesFreshness.length,
      totalEditTestCycles: editTestCycles.reduce((a, b) => a + (b.cycles || 0), 0),
    },
    sessionsByDate: mergeByKey(sessionsByDate, "date", (a, b) => ({
      date: a.date, count: a.count + b.count, events: a.events + b.events, compacts: a.compacts + b.compacts
    })),
    sessionDurations,
    toolUsage: mergeByKey(toolUsage, "tool", (a, b) => ({ tool: a.tool, count: a.count + b.count })).sort((a, b) => b.count - a.count),
    mcpTools: mergeByKey(mcpTools, "tool", (a, b) => ({ tool: a.tool, count: a.count + b.count })).sort((a, b) => b.count - a.count),
    errors, fileActivity: mergeByKey(fileActivity, "file", (a, b) => ({ file: a.file, op: a.op, count: a.count + b.count })).sort((a, b) => b.count - a.count).slice(0, 15),
    workModes: mergeByKey(workModes, "mode", (a, b) => ({ mode: a.mode, count: a.count + b.count })).sort((a, b) => b.count - a.count),
    timeToFirstCommit,
    exploreExecRatio: exploreExecRatio.reduce((a, b) => ({ explore: (a.explore||0)+(b.explore||0), execute: (a.execute||0)+(b.execute||0), total: (a.total||0)+(b.total||0) }), { explore: 0, execute: 0, total: 0 }),
    reworkData, gitActivity, subagents,
    projectActivity: mergeByKey(projectActivity, "project_dir", (a, b) => ({
      project_dir: a.project_dir, sessions: a.sessions + b.sessions, events: a.events + b.events, compacts: (a.compacts||0)+(b.compacts||0)
    })).sort((a, b) => b.events - a.events),
    hourlyPattern: mergeByKey(hourlyPattern, "hour", (a, b) => ({ hour: a.hour, count: a.count + b.count })),
    weeklyTrend: mergeByKey(weeklyTrend, "week", (a, b) => ({ week: a.week, sessions: a.sessions + b.sessions, events: a.events + b.events })),
    tasks, prompts,
    masteryTrend: mergeByKey(masteryTrend, "week", (a, b) => ({
      week: a.week, errors: a.errors + b.errors, total: a.total + b.total,
      error_rate: (a.total + b.total) > 0 ? Math.round(1000 * (a.errors + b.errors) / (a.total + b.total)) / 10 : 0,
    })),
    commitRate,
    sandboxAdoption: sandboxAgg,
    rulesFreshness,
    editTestCycles,
  };
}

// ── Router ───────────────────────────────────────────────

function route(method, pathname, params) {
  if (pathname === "/api/overview") return apiOverview();
  if (pathname === "/api/analytics") return apiAnalytics();
  if (pathname === "/api/content") return apiContentDBs();
  if (pathname === "/api/sessions") return apiSessionDBs();

  if (pathname.startsWith("/api/content/") && pathname.includes("/chunks/")) {
    const parts = pathname.split("/");
    if (!isValidHash(parts[3])) return { error: "invalid hash" };
    return apiSourceChunks(parts[3], Number(parts[5]));
  }
  if (pathname === "/api/search") {
    const q = params.get("q");
    if (!q) return { error: "missing q param" };
    return apiSearchAll(q);
  }
  if (pathname.startsWith("/api/sessions/") && pathname.includes("/events/")) {
    const parts = pathname.split("/");
    if (!isValidHash(parts[3])) return { error: "invalid hash" };
    return apiSessionEvents(parts[3], decodeURIComponent(parts[5]));
  }
  if (method === "DELETE" && pathname.startsWith("/api/content/")) {
    const parts = pathname.split("/");
    if (!isValidHash(parts[3])) return { error: "invalid hash" };
    return apiDeleteSource(parts[3], Number(parts[5]));
  }
  return null;
}

// ── Static file serving ──────────────────────────────────

const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon",
};

function serveStaticFile(pathname) {
  const ext = extname(pathname);
  const filePath = join(DIST_DIR, pathname);
  try {
    const content = readFileSync(filePath);
    return { content, type: MIME[ext] || "application/octet-stream" };
  } catch { return null; }
}

// ── Server (dual runtime) ────────────────────────────────

const indexHTML = readFileSync(join(DIST_DIR, "index.html"), "utf8");
const API_JSON_HEADERS = { "Content-Type": "application/json" };

if (isBun) {
  // Bun: use Bun.serve
  Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const data = route(req.method, url.pathname, url.searchParams);
      if (data !== null) {
        return new Response(JSON.stringify(data), {
          headers: API_JSON_HEADERS,
        });
      }
      if (url.pathname.startsWith("/assets/") || url.pathname.match(/\.\w{2,4}$/)) {
        const file = serveStaticFile(url.pathname);
        if (file) return new Response(file.content, {
          headers: { "Content-Type": file.type, "Cache-Control": "public, max-age=31536000" },
        });
      }
      return new Response(indexHTML, { headers: { "Content-Type": "text/html" } });
    },
  });
} else {
  // Node: use http.createServer
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method === "OPTIONS") { res.writeHead(405); res.end(); return; }

    const data = route(req.method, url.pathname, url.searchParams);
    if (data !== null) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }
    if (url.pathname.startsWith("/assets/") || url.pathname.match(/\.\w{2,4}$/)) {
      const file = serveStaticFile(url.pathname);
      if (file) {
        res.writeHead(200, { "Content-Type": file.type, "Cache-Control": "public, max-age=31536000" });
        res.end(file.content);
        return;
      }
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(indexHTML);
  });
  server.listen(PORT, "127.0.0.1");
}

console.log(`\n  context-mode Insight`);
console.log(`  http://localhost:${PORT}`);
console.log(`  Runtime: ${isBun ? "Bun" : "Node.js"}\n`);
