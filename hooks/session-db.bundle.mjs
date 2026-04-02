import{createRequire as h}from"node:module";import{unlinkSync as y}from"node:fs";import{tmpdir as R}from"node:os";import{join as S}from"node:path";var p=class{#t;constructor(t){this.#t=t}pragma(t){let s=this.#t.prepare(`PRAGMA ${t}`).all();if(!s||s.length===0)return;if(s.length>1)return s;let i=Object.values(s[0]);return i.length===1?i[0]:s[0]}exec(t){let e="",s=null;for(let o=0;o<t.length;o++){let a=t[o];if(s)e+=a,a===s&&(s=null);else if(a==="'"||a==='"')e+=a,s=a;else if(a===";"){let c=e.trim();c&&this.#t.prepare(c).run(),e=""}else e+=a}let i=e.trim();return i&&this.#t.prepare(i).run(),this}prepare(t){let e=this.#t.prepare(t);return{run:(...s)=>e.run(...s),get:(...s)=>{let i=e.get(...s);return i===null?void 0:i},all:(...s)=>e.all(...s),iterate:(...s)=>e.iterate(...s)}}transaction(t){return this.#t.transaction(t)}close(){this.#t.close()}},u=null;function v(){if(!u){let r=h(import.meta.url);if(globalThis.Bun){let t=r(["bun","sqlite"].join(":")).Database;u=function(s,i){let o=new t(s,{readonly:i?.readonly,create:!0});return new p(o)}}else u=r("better-sqlite3")}return u}function f(r){r.pragma("journal_mode = WAL"),r.pragma("synchronous = NORMAL")}function L(r){for(let t of["","-wal","-shm"])try{y(r+t)}catch{}}function l(r){try{r.pragma("wal_checkpoint(TRUNCATE)")}catch{}try{r.close()}catch{}}function _(r="context-mode"){return S(R(),`${r}-${process.pid}.db`)}function N(r){let t=[100,500,2e3],e;for(let s=0;s<=t.length;s++)try{return r()}catch(i){let o=i instanceof Error?i.message:String(i);if(!o.includes("SQLITE_BUSY")&&!o.includes("database is locked"))throw i;if(e=i instanceof Error?i:new Error(o),s<t.length){let a=t[s],c=Date.now();for(;Date.now()-c<a;);}}throw new Error(`SQLITE_BUSY: database is locked after ${t.length} retries. Original error: ${e?.message}`)}var d=Symbol.for("__context_mode_live_dbs__"),m=(()=>{let r=globalThis;return r[d]||(r[d]=new Set,process.on("exit",()=>{for(let t of r[d])try{t.close()}catch{}r[d].clear()})),r[d]})(),E=class{#t;#e;constructor(t){let e=v();this.#t=t,this.#e=new e(t,{timeout:3e4}),m.add(this.#e),f(this.#e),this.initSchema(),this.prepareStatements()}get db(){return this.#e}get dbPath(){return this.#t}close(){m.delete(this.#e),l(this.#e)}withRetry(t){return N(t)}cleanup(){m.delete(this.#e),l(this.#e),L(this.#t)}};import{createHash as g}from"node:crypto";import{execFileSync as O}from"node:child_process";function x(){let r=process.env.CONTEXT_MODE_SESSION_SUFFIX;if(r!==void 0)return r?`__${r}`:"";try{let t=process.cwd(),e=O("git",["worktree","list","--porcelain"],{encoding:"utf-8",timeout:2e3,stdio:["ignore","pipe","ignore"]}).split(/\r?\n/).find(s=>s.startsWith("worktree "))?.replace("worktree ","")?.trim();if(e&&t!==e)return`__${g("sha256").update(t).digest("hex").slice(0,8)}`}catch{}return""}var D=1e3,b=5,n={insertEvent:"insertEvent",getEvents:"getEvents",getEventsByType:"getEventsByType",getEventsByPriority:"getEventsByPriority",getEventsByTypeAndPriority:"getEventsByTypeAndPriority",getEventCount:"getEventCount",checkDuplicate:"checkDuplicate",evictLowestPriority:"evictLowestPriority",updateMetaLastEvent:"updateMetaLastEvent",ensureSession:"ensureSession",getSessionStats:"getSessionStats",incrementCompactCount:"incrementCompactCount",upsertResume:"upsertResume",getResume:"getResume",markResumeConsumed:"markResumeConsumed",deleteEvents:"deleteEvents",deleteMeta:"deleteMeta",deleteResume:"deleteResume",getOldSessions:"getOldSessions"},T=class extends E{constructor(t){super(t?.dbPath??_("session"))}stmt(t){return this.stmts.get(t)}initSchema(){try{let e=this.db.pragma("table_xinfo(session_events)").find(s=>s.name==="data_hash");e&&e.hidden!==0&&this.db.exec("DROP TABLE session_events")}catch{}this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        data TEXT NOT NULL,
        source_hook TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        data_hash TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
      CREATE INDEX IF NOT EXISTS idx_session_events_priority ON session_events(session_id, priority);

      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_resume (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        snapshot TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        consumed INTEGER NOT NULL DEFAULT 0
      );
    `)}prepareStatements(){this.stmts=new Map;let t=(e,s)=>{this.stmts.set(e,this.db.prepare(s))};t(n.insertEvent,`INSERT INTO session_events (session_id, type, category, priority, data, source_hook, data_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`),t(n.getEvents,`SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`),t(n.getEventsByType,`SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`),t(n.getEventsByPriority,`SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(n.getEventsByTypeAndPriority,`SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(n.getEventCount,"SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?"),t(n.checkDuplicate,`SELECT 1 FROM (
         SELECT type, data_hash FROM session_events
         WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) AS recent
       WHERE recent.type = ? AND recent.data_hash = ?
       LIMIT 1`),t(n.evictLowestPriority,`DELETE FROM session_events WHERE id = (
         SELECT id FROM session_events WHERE session_id = ?
         ORDER BY priority ASC, id ASC LIMIT 1
       )`),t(n.updateMetaLastEvent,`UPDATE session_meta
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`),t(n.ensureSession,"INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)"),t(n.getSessionStats,`SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count
       FROM session_meta WHERE session_id = ?`),t(n.incrementCompactCount,"UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?"),t(n.upsertResume,`INSERT INTO session_resume (session_id, snapshot, event_count)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         created_at = datetime('now'),
         consumed = 0`),t(n.getResume,"SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?"),t(n.markResumeConsumed,"UPDATE session_resume SET consumed = 1 WHERE session_id = ?"),t(n.deleteEvents,"DELETE FROM session_events WHERE session_id = ?"),t(n.deleteMeta,"DELETE FROM session_meta WHERE session_id = ?"),t(n.deleteResume,"DELETE FROM session_resume WHERE session_id = ?"),t(n.getOldSessions,"SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')")}insertEvent(t,e,s="PostToolUse"){let i=g("sha256").update(e.data).digest("hex").slice(0,16).toUpperCase();this.db.transaction(()=>{if(this.stmt(n.checkDuplicate).get(t,b,e.type,i))return;this.stmt(n.getEventCount).get(t).cnt>=D&&this.stmt(n.evictLowestPriority).run(t),this.stmt(n.insertEvent).run(t,e.type,e.category,e.priority,e.data,s,i),this.stmt(n.updateMetaLastEvent).run(t)})()}getEvents(t,e){let s=e?.limit??1e3,i=e?.type,o=e?.minPriority;return i&&o!==void 0?this.stmt(n.getEventsByTypeAndPriority).all(t,i,o,s):i?this.stmt(n.getEventsByType).all(t,i,s):o!==void 0?this.stmt(n.getEventsByPriority).all(t,o,s):this.stmt(n.getEvents).all(t,s)}getEventCount(t){return this.stmt(n.getEventCount).get(t).cnt}ensureSession(t,e){this.stmt(n.ensureSession).run(t,e)}getSessionStats(t){return this.stmt(n.getSessionStats).get(t)??null}incrementCompactCount(t){this.stmt(n.incrementCompactCount).run(t)}upsertResume(t,e,s){this.stmt(n.upsertResume).run(t,e,s??0)}getResume(t){return this.stmt(n.getResume).get(t)??null}markResumeConsumed(t){this.stmt(n.markResumeConsumed).run(t)}deleteSession(t){this.db.transaction(()=>{this.stmt(n.deleteEvents).run(t),this.stmt(n.deleteResume).run(t),this.stmt(n.deleteMeta).run(t)})()}cleanupOldSessions(t=7){let e=`-${t}`,s=this.stmt(n.getOldSessions).all(e);for(let{session_id:i}of s)this.deleteSession(i);return s.length}};export{T as SessionDB,x as getWorktreeSuffix};
