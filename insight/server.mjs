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
import { join, dirname, extname, normalize } from "node:path";
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

// ── Response cache (5min TTL) ────────────────────────────
// Prevents double DB open when dashboard loads /analytics + /category-analytics
const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
function cached(key, fn) {
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.data;
  try {
    const data = fn();
    _cache.set(key, { data, ts: Date.now() });
    return data;
  } catch (e) {
    // Cache the error for 30s to avoid repeated expensive failures
    _cache.set(key, { data: { error: String(e) }, ts: Date.now() - CACHE_TTL_MS + 30000 });
    return { error: "analytics computation failed" };
  }
}

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

function hasColumn(db, table, column) {
  try {
    const rows = db.prepare(`PRAGMA table_xinfo(${table})`).all();
    return rows.some(r => r.name === column);
  } catch {
    return false;
  }
}

const UNKNOWN_PROJECT_KEY = "__unknown__";

function normalizeFsPath(path) {
  const norm = normalize(String(path || "")).replace(/\\/g, "/");
  if (norm.length <= 1) return norm;
  return norm.replace(/\/+$/, "");
}

function parseFileSearchPath(data) {
  const marker = " in ";
  const idx = String(data || "").lastIndexOf(marker);
  if (idx < 0) return null;
  const p = String(data || "").slice(idx + marker.length).trim();
  return p || null;
}

function isLikelyPath(value) {
  const v = String(value || "");
  return v.includes("/") || v.includes("\\") || v.startsWith(".") || /^[A-Za-z]:[\\/]/.test(v);
}

function legacyProjectAttribution(db) {
  const origins = new Map(
    safeAll(db, "SELECT session_id, project_dir FROM session_meta")
      .map((r) => [r.session_id, r.project_dir || UNKNOWN_PROJECT_KEY]),
  );

  const events = safeAll(db, `SELECT id, session_id, type, data FROM session_events ORDER BY id ASC`);
  const lastProjectBySession = new Map();
  const projectAgg = new Map();
  let unknownEvents = 0;

  function addProject(projectDir, sessionId) {
    const key = projectDir || UNKNOWN_PROJECT_KEY;
    const existing = projectAgg.get(key) || { project_dir: key, sessionsSet: new Set(), events: 0, compacts: 0, avg_confidence: 0, high_conf_events: 0 };
    existing.events += 1;
    existing.sessionsSet.add(sessionId);
    projectAgg.set(key, existing);
  }

  for (const ev of events) {
    const sessionId = ev.session_id;
    const origin = origins.get(sessionId) || UNKNOWN_PROJECT_KEY;
    const last = lastProjectBySession.get(sessionId) || "";
    let projectDir = "";

    if (ev.type === "cwd" && isLikelyPath(ev.data)) {
      projectDir = normalizeFsPath(ev.data);
    } else if (ev.type === "file_read" || ev.type === "file_write" || ev.type === "file_edit" || ev.type === "rule") {
      if (isLikelyPath(ev.data)) {
        const p = normalizeFsPath(ev.data);
        if (origin !== UNKNOWN_PROJECT_KEY && (p === origin || p.startsWith(`${origin}/`))) projectDir = origin;
        else projectDir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : p;
      }
    } else if (ev.type === "file_search") {
      const p = parseFileSearchPath(ev.data);
      if (p && isLikelyPath(p)) {
        const pp = normalizeFsPath(p);
        if (origin !== UNKNOWN_PROJECT_KEY && (pp === origin || pp.startsWith(`${origin}/`))) projectDir = origin;
        else projectDir = pp;
      }
    }

    if (!projectDir) {
      projectDir = last || origin || UNKNOWN_PROJECT_KEY;
    }
    if (!projectDir || projectDir === UNKNOWN_PROJECT_KEY) unknownEvents += 1;

    addProject(projectDir, sessionId);
    if (projectDir && projectDir !== UNKNOWN_PROJECT_KEY) {
      lastProjectBySession.set(sessionId, projectDir);
    }
  }

  const rows = [...projectAgg.values()].map((r) => ({
    project_dir: r.project_dir,
    sessions: r.sessionsSet.size,
    events: r.events,
    compacts: 0,
    avg_confidence: 0,
    high_conf_events: 0,
  })).sort((a, b) => b.events - a.events);

  return {
    projectRows: rows,
    total_events: events.length,
    unknown_events: unknownEvents,
    avg_confidence: 0,
    high_conf_events: 0,
  };
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
  const gitActivity = queryAllSessionDBs(db => {
    if (hasColumn(db, "session_events", "project_dir")) {
      return safeAll(db, `SELECT se.data as action, se.created_at, se.session_id,
        COALESCE(NULLIF(se.project_dir, ''), sm.project_dir, '${UNKNOWN_PROJECT_KEY}') as project_dir,
        sm.started_at as session_start
        FROM session_events se
        LEFT JOIN session_meta sm ON se.session_id = sm.session_id
        WHERE se.type = 'git' ORDER BY se.created_at DESC LIMIT 20`);
    }
    return safeAll(db, `SELECT se.data as action, se.created_at, se.session_id,
      COALESCE(sm.project_dir, '${UNKNOWN_PROJECT_KEY}') as project_dir, sm.started_at as session_start
      FROM session_events se
      LEFT JOIN session_meta sm ON se.session_id = sm.session_id
      WHERE se.type = 'git' ORDER BY se.created_at DESC LIMIT 20`);
  });
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
  const projectActivity = queryAllSessionDBs(db => {
    if (hasColumn(db, "session_events", "project_dir")) {
      return safeAll(db, `SELECT
        COALESCE(NULLIF(se.project_dir, ''), '${UNKNOWN_PROJECT_KEY}') as project_dir,
        COUNT(DISTINCT se.session_id) as sessions,
        COUNT(*) as events,
        0 as compacts,
        AVG(COALESCE(se.attribution_confidence, 0)) as avg_confidence,
        SUM(CASE WHEN COALESCE(se.attribution_confidence, 0) >= 0.8 THEN 1 ELSE 0 END) as high_conf_events
        FROM session_events se
        GROUP BY project_dir
        ORDER BY events DESC
        LIMIT 20`);
    }
    return legacyProjectAttribution(db).projectRows;
  });

  const attributionSummary = queryAllSessionDBs(db => {
    if (hasColumn(db, "session_events", "project_dir")) {
      return safeAll(db, `SELECT
        COUNT(*) as total_events,
        SUM(CASE WHEN COALESCE(project_dir, '') = '' THEN 1 ELSE 0 END) as unknown_events,
        AVG(COALESCE(attribution_confidence, 0)) as avg_confidence,
        SUM(CASE WHEN COALESCE(attribution_confidence, 0) >= 0.8 THEN 1 ELSE 0 END) as high_conf_events
        FROM session_events`);
    }
    return [legacyProjectAttribution(db)];
  });
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
  const commitRate = queryAllSessionDBs(db => {
    if (hasColumn(db, "session_events", "project_dir")) {
      return safeAll(db, `SELECT
        sm.session_id,
        COALESCE(NULLIF(MAX(CASE WHEN se.type = 'git' THEN se.project_dir END), ''), sm.project_dir, '${UNKNOWN_PROJECT_KEY}') as project_dir,
        SUM(CASE WHEN se.type = 'git' AND se.data = 'commit' THEN 1 ELSE 0 END) as commits
        FROM session_meta sm
        LEFT JOIN session_events se ON se.session_id = sm.session_id
        GROUP BY sm.session_id`);
    }
    return safeAll(db, `SELECT sm.session_id, COALESCE(sm.project_dir, '${UNKNOWN_PROJECT_KEY}') as project_dir,
      SUM(CASE WHEN se.type = 'git' AND se.data = 'commit' THEN 1 ELSE 0 END) as commits
      FROM session_meta sm
      LEFT JOIN session_events se ON se.session_id = sm.session_id
      GROUP BY sm.session_id`);
  });

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
  const attributionSchemaCoverage = queryAllSessionDBs(db => [{
    has_attribution_columns: hasColumn(db, "session_events", "project_dir") ? 1 : 0,
  }]);
  const fallbackOnly = attributionSchemaCoverage.length > 0
    && attributionSchemaCoverage.every((r) => !r.has_attribution_columns);

  const mergedProjectActivity = mergeByKey(projectActivity, "project_dir", (a, b) => {
    const aEvents = Number(a.events || 0);
    const bEvents = Number(b.events || 0);
    const aWeighted = Number(
      (a.weighted_confidence_sum ?? (Number(a.avg_confidence || 0) * aEvents)) || 0,
    );
    const bWeighted = Number(
      (b.weighted_confidence_sum ?? (Number(b.avg_confidence || 0) * bEvents)) || 0,
    );
    return {
      project_dir: a.project_dir,
      sessions: (a.sessions || 0) + (b.sessions || 0),
      events: aEvents + bEvents,
      compacts: (a.compacts || 0) + (b.compacts || 0),
      weighted_confidence_sum: aWeighted + bWeighted,
      high_conf_events: (a.high_conf_events || 0) + (b.high_conf_events || 0),
    };
  })
    .map((p) => ({
      project_dir: p.project_dir,
      sessions: p.sessions || 0,
      events: p.events || 0,
      compacts: p.compacts || 0,
      avg_confidence: (p.events || 0) > 0 ? (p.weighted_confidence_sum || 0) / p.events : 0,
      high_conf_events: p.high_conf_events || 0,
    }))
    .sort((a, b) => (b.events || 0) - (a.events || 0));
  const nonUnknownProjects = mergedProjectActivity.filter((p) => p.project_dir !== UNKNOWN_PROJECT_KEY);

  const attributionAgg = attributionSummary.reduce((a, b) => ({
    total_events: (a.total_events || 0) + (b.total_events || 0),
    unknown_events: (a.unknown_events || 0) + (b.unknown_events || 0),
    high_conf_events: (a.high_conf_events || 0) + (b.high_conf_events || 0),
    // weighted sum for avg_confidence
    weighted_confidence_sum: (a.weighted_confidence_sum || 0) + ((b.avg_confidence || 0) * (b.total_events || 0)),
  }), { total_events: 0, unknown_events: 0, high_conf_events: 0, weighted_confidence_sum: 0 });

  const attributedEvents = Math.max(0, attributionAgg.total_events - attributionAgg.unknown_events);
  const unknownPct = attributionAgg.total_events > 0
    ? Math.round(1000 * attributionAgg.unknown_events / attributionAgg.total_events) / 10
    : 100;
  const avgConfidencePct = attributionAgg.total_events > 0
    ? Math.round(1000 * attributionAgg.weighted_confidence_sum / attributionAgg.total_events) / 10
    : 0;
  const highConfidencePct = attributionAgg.total_events > 0
    ? Math.round(1000 * attributionAgg.high_conf_events / attributionAgg.total_events) / 10
    : 0;

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
      uniqueProjects: nonUnknownProjects.length,
      totalCommits: commitRate.reduce((a, b) => a + (b.commits || 0), 0),
      commitsPerSession: sessionDurations.length > 0
        ? Math.round(10 * commitRate.reduce((a, b) => a + (b.commits || 0), 0) / sessionDurations.length) / 10 : 0,
      sandboxRate: sandboxAgg.total_calls > 0
        ? Math.round(1000 * sandboxAgg.sandbox_calls / sandboxAgg.total_calls) / 10 : 0,
      totalRules: rulesFreshness.length,
      totalEditTestCycles: editTestCycles.reduce((a, b) => a + (b.cycles || 0), 0),
    },
    attribution: {
      totalEvents: attributionAgg.total_events,
      attributedEvents,
      unknownEvents: attributionAgg.unknown_events,
      unknownPct,
      avgConfidencePct,
      highConfidencePct,
      isFallbackOnly: fallbackOnly,
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
    projectActivity: mergedProjectActivity,
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

// ── Category Analytics ──────────────────────────────────

function apiCategoryAnalytics() {
  // 1. Category distribution
  const rawCategoryCounts = queryAllSessionDBs(db =>
    safeAll(db, `SELECT category, type, COUNT(*) as count FROM session_events GROUP BY category, type ORDER BY count DESC`)
  );
  // Add composite key for merge
  const catTypeRows = mergeByKey(
    rawCategoryCounts.map(r => ({ ...r, _cat_type: `${r.category}::${r.type}` })),
    "_cat_type",
    (a, b) => ({ _cat_type: a._cat_type, category: a.category, type: a.type, count: a.count + b.count })
  );

  const CATEGORY_MAP = {
    file: ["file_read", "file_write", "file_edit", "file_glob", "file_search"],
    git: ["git"],
    error: ["error_tool"],
    subagent: ["subagent_launched", "subagent_completed"],
    "rejected-approach": ["rejected"],
    latency: ["tool_latency"],
    decision: ["decision", "decision_question"],
    skill: ["skill"],
    rule: ["rule", "rule_content"],
    plan: ["plan_enter", "plan_exit", "plan_approved", "plan_rejected", "plan_file_write"],
    intent: ["intent"],
    "blocked-on": ["blocker", "blocker_resolved"],
    constraint: ["constraint_discovered"],
    "user-prompt": ["user_prompt"],
    "error-resolution": ["error_resolved"],
    "iteration-loop": ["retry_detected"],
    env: ["env", "worktree"],
    task: ["task_create", "task_update"],
    mcp: ["mcp"],
    "agent-finding": ["agent_finding"],
    "external-ref": ["external_ref"],
    role: ["role"],
    cwd: ["cwd"],
    data: ["data"],
  };

  const typeCountMap = new Map();
  for (const row of catTypeRows) {
    typeCountMap.set(`${row.category}::${row.type}`, row.count);
  }

  const categories = Object.entries(CATEGORY_MAP).map(([cat, types]) => {
    const typesObj = {};
    let total = 0;
    for (const t of types) {
      const c = typeCountMap.get(`${cat}::${t}`) || 0;
      typesObj[t] = c;
      total += c;
    }
    return { category: cat, count: total, types: typesObj };
  });

  // 2. Error intelligence
  const errorResolution = queryAllSessionDBs(db =>
    safeAll(db, `SELECT
      SUM(CASE WHEN category = 'error' THEN 1 ELSE 0 END) as total_errors,
      SUM(CASE WHEN category = 'error-resolution' THEN 1 ELSE 0 END) as resolved_errors
      FROM session_events`)
  );
  const totalErrors = errorResolution.reduce((s, r) => s + (r.total_errors || 0), 0);
  const resolvedErrors = errorResolution.reduce((s, r) => s + (r.resolved_errors || 0), 0);
  const resolutionRate = totalErrors > 0 ? Math.round(1000 * resolvedErrors / totalErrors) / 10 : 0;

  const retryStorms = queryAllSessionDBs(db =>
    safeAll(db, `SELECT session_id, COUNT(*) as retries FROM session_events WHERE category = 'iteration-loop' GROUP BY session_id HAVING COUNT(*) > 3`)
  );

  const latencyData = queryAllSessionDBs(db =>
    safeAll(db, `SELECT data FROM session_events WHERE category = 'latency'`)
  );
  const latencies = [];
  const latencyByToolMap = new Map();
  for (const row of latencyData) {
    if (!row.data) continue;
    const match = String(row.data).match(/^(.+?):\s*(\d+)\s*(?:ms)?$/);
    if (!match) continue;
    const tool = match[1].trim();
    const ms = parseInt(match[2], 10);
    if (isNaN(ms)) continue;
    latencies.push(ms);
    if (!latencyByToolMap.has(tool)) latencyByToolMap.set(tool, { sum: 0, count: 0, max: 0 });
    const entry = latencyByToolMap.get(tool);
    entry.sum += ms;
    entry.count += 1;
    entry.max = Math.max(entry.max, ms);
  }
  latencies.sort((a, b) => a - b);
  const avgLatencyMs = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const p95LatencyMs = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : 0;

  const latencyByTool = [...latencyByToolMap.entries()]
    .map(([tool, e]) => ({ tool, avg_ms: Math.round(e.sum / e.count), count: e.count, max_ms: e.max }))
    .sort((a, b) => b.avg_ms - a.avg_ms);

  let slowestTool = latencyByTool.length > 0 ? latencyByTool[0].tool : null;

  const topErrorTools = queryAllSessionDBs(db =>
    safeAll(db, `SELECT
      CASE
        WHEN data LIKE '%Bash%' THEN 'Bash'
        WHEN data LIKE '%Read%' THEN 'Read'
        WHEN data LIKE '%Edit%' THEN 'Edit'
        WHEN data LIKE '%Write%' THEN 'Write'
        WHEN data LIKE '%Agent%' THEN 'Agent'
        ELSE substr(data, 1, 30)
      END as tool,
      COUNT(*) as count
      FROM session_events WHERE category = 'error'
      GROUP BY tool ORDER BY count DESC LIMIT 5`)
  );
  const mergedTopErrorTools = mergeByKey(topErrorTools, "tool", (a, b) => ({ tool: a.tool, count: a.count + b.count }))
    .sort((a, b) => b.count - a.count).slice(0, 5);

  const errorIntelligence = {
    totalErrors,
    resolvedErrors,
    resolutionRate,
    retryStorms: retryStorms.length,
    avgLatencyMs,
    p95LatencyMs,
    p95SampleCount: latencies.length,
    slowestTool,
    topErrorTools: mergedTopErrorTools,
    latencyByTool,
  };

  // 3. Delegation metrics
  const subagentCat = categories.find(c => c.category === "subagent");
  const launched = subagentCat ? (subagentCat.types.subagent_launched || 0) : 0;
  let completed = subagentCat ? (subagentCat.types.subagent_completed || 0) : 0;
  if (completed > launched && launched > 0) completed = launched; // cap anomaly
  const completionRate = launched > 0 ? Math.round(1000 * completed / launched) / 10 : 0;

  // Parallel bursts: sessions with >1 subagent_launched in same session
  const parallelBurstData = queryAllSessionDBs(db =>
    safeAll(db, `SELECT session_id, COUNT(*) as cnt FROM session_events WHERE type = 'subagent_launched' GROUP BY session_id HAVING cnt > 1`)
  );
  const parallelBursts = parallelBurstData.length;
  const maxConcurrent = parallelBurstData.reduce((m, r) => Math.max(m, r.cnt || 0), 0);
  // Rough estimate: each completed subagent saves ~2 min
  const timeSavedMin = Math.round(completed * 2);

  const delegation = { launched, completed, completionRate, parallelBursts, maxConcurrent, timeSavedMin };

  // 4. Governance
  const rejectedData = queryAllSessionDBs(db =>
    safeAll(db, `SELECT data FROM session_events WHERE category = 'rejected-approach'`)
  );
  const rejectedToolMap = new Map();
  for (const row of rejectedData) {
    if (!row.data) continue;
    const tool = String(row.data).split(":")[0].trim() || "unknown";
    rejectedToolMap.set(tool, (rejectedToolMap.get(tool) || 0) + 1);
  }
  const topRejected = [...rejectedToolMap.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const planCat = categories.find(c => c.category === "plan");
  const planApproved = planCat ? (planCat.types.plan_approved || 0) : 0;
  const planRejected = planCat ? (planCat.types.plan_rejected || 0) : 0;
  const totalPlans = planApproved + planRejected;
  const planApprovalRate = totalPlans > 0 ? Math.round(1000 * planApproved / totalPlans) / 10 : 0;

  const rejectedCat = categories.find(c => c.category === "rejected-approach");
  const decisionCat = categories.find(c => c.category === "decision");
  const constraintCat = categories.find(c => c.category === "constraint");

  const governance = {
    totalRejections: rejectedCat ? rejectedCat.count : 0,
    totalDecisions: decisionCat ? decisionCat.count : 0,
    totalConstraints: constraintCat ? constraintCat.count : 0,
    planApproved,
    planRejected,
    planApprovalRate,
    topRejected,
  };

  // 5. Git productivity
  const gitOps = queryAllSessionDBs(db =>
    safeAll(db, `SELECT data as operation, COUNT(*) as count FROM session_events WHERE category = 'git' AND data IS NOT NULL AND data != '' GROUP BY data ORDER BY count DESC`)
  );
  const mergedGitOps = mergeByKey(gitOps, "operation", (a, b) => ({ operation: a.operation, count: a.count + b.count }))
    .sort((a, b) => b.count - a.count);
  const totalCommits = mergedGitOps.find(o => o.operation === "commit")?.count || 0;
  const totalPushes = mergedGitOps.find(o => o.operation === "push")?.count || 0;
  const totalGitOps = mergedGitOps.reduce((s, o) => s + o.count, 0);

  const gitProductivity = {
    totalCommits,
    totalPushes,
    commitPushRatio: totalPushes > 0 ? Math.round(100 * totalCommits / totalPushes) / 100 : totalCommits,
    totalOperations: totalGitOps,
    operationMix: mergedGitOps,
  };

  // 6. Context health
  const uniqueSkills = queryAllSessionDBs(db =>
    safeAll(db, `SELECT DISTINCT data as skill FROM session_events WHERE category = 'skill' AND data != ''`)
  );
  const skillSet = [...new Set(uniqueSkills.map(r => r.skill).filter(Boolean))];

  const modeDistribution = queryAllSessionDBs(db =>
    safeAll(db, `SELECT data as mode, COUNT(*) as count FROM session_events WHERE category = 'intent' AND data != '' GROUP BY data ORDER BY count DESC`)
  );
  const mergedModes = mergeByKey(modeDistribution, "mode", (a, b) => ({ mode: a.mode, count: a.count + b.count }))
    .sort((a, b) => b.count - a.count);
  const totalModeEvents = mergedModes.reduce((s, m) => s + m.count, 0);
  const modesWithPct = mergedModes.map(m => ({ ...m, pct: totalModeEvents > 0 ? Math.round(1000 * m.count / totalModeEvents) / 10 : 0 }));

  const blockerData = queryAllSessionDBs(db =>
    safeAll(db, `SELECT type, COUNT(*) as count FROM session_events WHERE category = 'blocked-on' GROUP BY type`)
  );
  const mergedBlockers = mergeByKey(blockerData, "type", (a, b) => ({ type: a.type, count: a.count + b.count }));
  const totalBlockers = mergedBlockers.find(b => b.type === "blocker")?.count || 0;
  const resolvedBlockers = mergedBlockers.find(b => b.type === "blocker_resolved")?.count || 0;

  const ruleCat = categories.find(c => c.category === "rule");
  const ruleCount = ruleCat ? ruleCat.count : 0;

  // Unique rule files: count distinct data values for rule category
  const uniqueRuleFiles = queryAllSessionDBs(db =>
    safeAll(db, `SELECT DISTINCT data FROM session_events WHERE category = 'rule' AND type = 'rule' AND data IS NOT NULL AND data != ''`)
  );
  const uniqueRuleCount = new Set(uniqueRuleFiles.map(r => r.data)).size;

  // Sessions + compacts in one query (avoids extra DB open cycle)
  const sessionAgg = queryAllSessionDBs(db =>
    safeAll(db, `SELECT COUNT(*) as cnt, COALESCE(SUM(compact_count), 0) as compacts FROM session_meta`)
  );
  const totalSessions = sessionAgg.reduce((s, r) => s + (r.cnt || 0), 0);
  const totalCompacts = sessionAgg.reduce((s, r) => s + (r.compacts || 0), 0);
  const compactRate = totalSessions > 0 ? Math.round(100 * totalCompacts / totalSessions) : 0;

  const contextHealth = {
    uniqueRuleFiles: uniqueRuleCount,
    ruleLoadsPerSession: totalSessions > 0 ? Math.round(100 * ruleCount / totalSessions) / 100 : 0,
    uniqueSkills: skillSet.length,
    skillList: skillSet,
    modeDistribution: modesWithPct,
    compactRate,
    totalBlockers,
    resolvedBlockers,
    blockerResolutionRate: totalBlockers > 0 ? Math.round(1000 * resolvedBlockers / totalBlockers) / 10 : 0,
  };

  // 7. File activity intelligence
  const fileStats = queryAllSessionDBs(db =>
    safeAll(db, `SELECT
      SUM(CASE WHEN type = 'file_read' THEN 1 ELSE 0 END) as reads,
      SUM(CASE WHEN type IN ('file_write','file_edit') THEN 1 ELSE 0 END) as writes,
      SUM(CASE WHEN type IN ('file_glob','file_search') THEN 1 ELSE 0 END) as exploration,
      COUNT(*) as total
      FROM session_events WHERE category = 'file'`)
  );
  const reads = fileStats.reduce((s, r) => s + (r.reads || 0), 0);
  const writes = fileStats.reduce((s, r) => s + (r.writes || 0), 0);
  const exploration = fileStats.reduce((s, r) => s + (r.exploration || 0), 0);
  const totalFileEvents = fileStats.reduce((s, r) => s + (r.total || 0), 0);

  const hotFiles = queryAllSessionDBs(db =>
    safeAll(db, `SELECT data as file, COUNT(*) as touches
      FROM session_events
      WHERE category = 'file' AND type IN ('file_read','file_edit','file_write') AND data != ''
      GROUP BY data HAVING COUNT(*) > 3
      ORDER BY touches DESC LIMIT 10`)
  );
  const mergedHotFiles = mergeByKey(hotFiles, "file", (a, b) => ({ file: a.file, touches: a.touches + b.touches }))
    .filter(f => f.touches > 3)
    .sort((a, b) => b.touches - a.touches)
    .slice(0, 10);

  // Unique edited + read files in one query for churn rate
  const fileChurnData = queryAllSessionDBs(db =>
    safeAll(db, `SELECT
      COUNT(DISTINCT CASE WHEN type IN ('file_write','file_edit') THEN data END) as edited,
      COUNT(DISTINCT CASE WHEN type = 'file_read' THEN data END) as read_files
      FROM session_events WHERE category = 'file' AND data != ''`)
  );
  const uniqueEditedCount = fileChurnData.reduce((s, r) => s + (r.edited || 0), 0);
  const uniqueReadCount = fileChurnData.reduce((s, r) => s + (r.read_files || 0), 0);

  const fileIntelligence = {
    readWriteRatio: writes > 0 ? Math.round(100 * reads / writes) / 100 : reads,
    explorationDepth: totalFileEvents > 0 ? Math.round(1000 * exploration / totalFileEvents) / 10 : 0,
    hotFiles: mergedHotFiles,
    fileChurnRate: uniqueReadCount > 0 ? Math.round(100 * uniqueEditedCount / uniqueReadCount) / 100 : 0,
  };

  // 8. Composite scores (0-100)
  const totalEvents = categories.reduce((s, c) => s + c.count, 0);

  // Productivity
  const commitSessions = queryAllSessionDBs(db =>
    safeAll(db, `SELECT COUNT(DISTINCT session_id) as cnt FROM session_events WHERE category = 'git' AND data = 'commit'`)
  );
  const sessionsWithCommits = commitSessions.reduce((s, r) => s + (r.cnt || 0), 0);
  const commitRate = totalSessions > 0 ? (sessionsWithCommits / totalSessions) * 100 : 0;
  // delegationRate: ratio of sessions with subagents (not events — avoids tiny % problem)
  const delegationRate = totalSessions > 0 ? Math.min(100, (launched / totalSessions) * 100) : 0;
  // fileChurnRate: unique edited / unique read (not count/events — fixes dimensional mismatch)
  const fileChurnForScore = uniqueReadCount > 0 ? Math.min(100, (uniqueEditedCount / uniqueReadCount) * 100) : 0;
  const productivityScore = Math.min(100, Math.round(
    (commitRate * 0.3) + (delegationRate * 0.2) + ((100 - fileChurnForScore) * 0.2) + (resolutionRate * 0.3)
  ));

  // Quality — zero errors = perfect quality (100), not penalized
  const retryRate = totalSessions > 0 ? (retryStorms.length / totalSessions) * 100 : 0;
  const errorRate = totalEvents > 0 ? (totalErrors / totalEvents) * 100 : 0;
  const effectiveResolution = totalErrors === 0 ? 100 : resolutionRate; // no errors = perfect
  const qualityScore = Math.min(100, Math.round(
    (effectiveResolution * 0.4) + ((100 - retryRate) * 0.3) + ((100 - errorRate) * 0.3)
  ));

  // Delegation
  const agentFindingCat = categories.find(c => c.category === "agent-finding");
  const findingCount = agentFindingCat ? agentFindingCat.count : 0;
  const hasBursts = parallelBursts > 0 ? 100 : 0;
  const delegationScore = Math.min(100, Math.round(
    (completionRate * 0.5) + (hasBursts * 0.3) + (Math.min(findingCount / 5, 1) * 20)
  ));

  // Context Health
  const ruleFreshness = uniqueRuleCount > 0 ? 100 : 0;
  const skillDiversity = Math.min(skillSet.length * 20, 100);
  const planApprovalForScore = (planApproved + planRejected) > 0 ? planApprovalRate : 50;
  const modeBalance = mergedModes.length > 1 ? 100 : 50;
  const contextHealthScore = Math.min(100, Math.round(
    (ruleFreshness * 0.3) + (skillDiversity * 0.2) + (planApprovalForScore * 0.25) + (modeBalance * 0.25)
  ));

  const compositeScores = {
    productivity: productivityScore,
    quality: qualityScore,
    delegation: delegationScore,
    contextHealth: contextHealthScore,
  };

  const insufficientData = totalEvents < 50 || totalSessions < 3;

  return {
    categories,
    errorIntelligence,
    delegation,
    governance,
    gitProductivity,
    contextHealth,
    fileIntelligence,
    compositeScores,
    insufficientData,
  };
}

// ── Router ───────────────────────────────────────────────

function route(method, pathname, params) {
  if (pathname === "/api/overview") return apiOverview();
  if (pathname === "/api/analytics") return cached("analytics", apiAnalytics);
  if (pathname === "/api/category-analytics") return cached("category-analytics", apiCategoryAnalytics);
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

// ── On-demand build: install + build if dist/ is missing ─
if (!existsSync(join(DIST_DIR, "index.html"))) {
  const { execSync } = await import("node:child_process");
  const shellOpts = { cwd: __dirname, stdio: "pipe", shell: true };
  try {
    console.error("\n  ┌─ Insight Dashboard ─────────────────────────────┐");
    console.error("  │  First run — building the dashboard UI.          │");
    console.error("  │  This only happens once.                         │");
    console.error("  └─────────────────────────────────────────────────┘\n");
    console.error("  [1/2] Installing dependencies...");
    execSync("npm install --no-package-lock --no-save --silent", { ...shellOpts, timeout: 120000 });
    console.error("  [2/2] Building dashboard...");
    execSync("npm run build", { ...shellOpts, timeout: 60000 });
    console.error("  ✓ Ready.\n");
  } catch (e) {
    console.error("  ✗ Build failed:", e.message);
    console.error("  Try manually: cd insight && npm install && npm run build");
    process.exit(1);
  }
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

// Parent watchdog: exit when the MCP process that spawned us disappears.
// Fallback for SIGKILL / crash paths where shutdown() cannot run.
const PARENT_PID = Number(process.env.INSIGHT_PARENT_PID);
if (Number.isFinite(PARENT_PID) && PARENT_PID > 0) {
  setInterval(() => {
    try {
      process.kill(PARENT_PID, 0);
    } catch {
      process.exit(0);
    }
  }, 5000).unref();
}

console.log(`\n  context-mode Insight`);
console.log(`  http://localhost:${PORT}`);
console.log(`  Runtime: ${isBun ? "Bun" : "Node.js"}\n`);
