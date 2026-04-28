import{createRequire as b}from"node:module";import{existsSync as N,unlinkSync as y,renameSync as D}from"node:fs";import{tmpdir as O}from"node:os";import{join as w}from"node:path";var p=class{#t;constructor(t){this.#t=t}pragma(t){let e=this.#t.prepare(`PRAGMA ${t}`).all();if(!e||e.length===0)return;if(e.length>1)return e;let r=Object.values(e[0]);return r.length===1?r[0]:e[0]}exec(t){let s="",e=null;for(let o=0;o<t.length;o++){let a=t[o];if(e)s+=a,a===e&&(e=null);else if(a==="'"||a==='"')s+=a,e=a;else if(a===";"){let c=s.trim();c&&this.#t.prepare(c).run(),s=""}else s+=a}let r=s.trim();return r&&this.#t.prepare(r).run(),this}prepare(t){let s=this.#t.prepare(t);return{run:(...e)=>s.run(...e),get:(...e)=>{let r=s.get(...e);return r===null?void 0:r},all:(...e)=>s.all(...e),iterate:(...e)=>s.iterate(...e)}}transaction(t){return this.#t.transaction(t)}close(){this.#t.close()}},_=class{#t;constructor(t){this.#t=t}pragma(t){let e=this.#t.prepare(`PRAGMA ${t}`).all();if(!e||e.length===0)return;if(e.length>1)return e;let r=Object.values(e[0]);return r.length===1?r[0]:e[0]}exec(t){return this.#t.exec(t),this}prepare(t){let s=this.#t.prepare(t);return{run:(...e)=>s.run(...e),get:(...e)=>s.get(...e),all:(...e)=>s.all(...e),iterate:(...e)=>typeof s.iterate=="function"?s.iterate(...e):s.all(...e)[Symbol.iterator]()}}transaction(t){return(...s)=>{this.#t.exec("BEGIN");try{let e=t(...s);return this.#t.exec("COMMIT"),e}catch(e){throw this.#t.exec("ROLLBACK"),e}}}close(){this.#t.close()}},u=null;function A(){if(!u){let n=b(import.meta.url);if(globalThis.Bun){let t=n(["bun","sqlite"].join(":")).Database;u=function(e,r){let o=new t(e,{readonly:r?.readonly,create:!0}),a=new p(o);return r?.timeout&&a.pragma(`busy_timeout = ${r.timeout}`),a}}else if(process.platform==="linux")try{let{DatabaseSync:t}=n(["node","sqlite"].join(":"));u=function(e,r){let o=new t(e,{readOnly:r?.readonly??!1});return new _(o)}}catch{u=n("better-sqlite3")}else u=n("better-sqlite3")}return u}function g(n){n.pragma("journal_mode = WAL"),n.pragma("synchronous = NORMAL");try{n.pragma("mmap_size = 268435456")}catch{}}function h(n){if(!N(n))for(let t of["-wal","-shm"])try{y(n+t)}catch{}}function C(n){for(let t of["","-wal","-shm"])try{y(n+t)}catch{}}function l(n){try{n.pragma("wal_checkpoint(TRUNCATE)")}catch{}try{n.close()}catch{}}function f(n="context-mode"){return w(O(),`${n}-${process.pid}.db`)}function I(n,t=[100,500,2e3]){let s;for(let e=0;e<=t.length;e++)try{return n()}catch(r){let o=r instanceof Error?r.message:String(r);if(!o.includes("SQLITE_BUSY")&&!o.includes("database is locked"))throw r;if(s=r instanceof Error?r:new Error(o),e<t.length){let a=t[e],c=Date.now();for(;Date.now()-c<a;);}}throw new Error(`SQLITE_BUSY: database is locked after ${t.length} retries. Original error: ${s?.message}`)}function U(n){return n.includes("SQLITE_CORRUPT")||n.includes("SQLITE_NOTADB")||n.includes("database disk image is malformed")||n.includes("file is not a database")}function x(n){let t=Date.now();for(let s of["","-wal","-shm"])try{D(n+s,`${n}${s}.corrupt-${t}`)}catch{}}var d=Symbol.for("__context_mode_live_dbs__"),m=(()=>{let n=globalThis;return n[d]||(n[d]=new Set,process.on("exit",()=>{for(let t of n[d])l(t);n[d].clear()})),n[d]})(),E=class{#t;#e;constructor(t){let s=A();this.#t=t,h(t);let e;try{e=new s(t,{timeout:3e4}),g(e)}catch(r){let o=r instanceof Error?r.message:String(r);if(U(o)){x(t),h(t);try{e=new s(t,{timeout:3e4}),g(e)}catch(a){throw new Error(`Failed to create fresh DB after renaming corrupt file: ${a instanceof Error?a.message:String(a)}`)}}else throw r}this.#e=e,m.add(this.#e),this.initSchema(),this.prepareStatements()}get db(){return this.#e}get dbPath(){return this.#t}close(){m.delete(this.#e),l(this.#e)}withRetry(t){return I(t)}cleanup(){m.delete(this.#e),l(this.#e),C(this.#t)}};import{createHash as R}from"node:crypto";import{execFileSync as M}from"node:child_process";function K(){let n=process.env.CONTEXT_MODE_SESSION_SUFFIX;if(n!==void 0)return n?`__${n}`:"";try{let t=process.cwd(),s=M("git",["worktree","list","--porcelain"],{encoding:"utf-8",timeout:2e3,stdio:["ignore","pipe","ignore"]}).split(/\r?\n/).find(e=>e.startsWith("worktree "))?.replace("worktree ","")?.trim();if(s&&t!==s)return`__${R("sha256").update(t).digest("hex").slice(0,8)}`}catch{}return""}var k=1e3,F=5,i={insertEvent:"insertEvent",getEvents:"getEvents",getEventsByType:"getEventsByType",getEventsByPriority:"getEventsByPriority",getEventsByTypeAndPriority:"getEventsByTypeAndPriority",getEventCount:"getEventCount",getLatestAttributedProject:"getLatestAttributedProject",checkDuplicate:"checkDuplicate",evictLowestPriority:"evictLowestPriority",updateMetaLastEvent:"updateMetaLastEvent",ensureSession:"ensureSession",getSessionStats:"getSessionStats",incrementCompactCount:"incrementCompactCount",upsertResume:"upsertResume",getResume:"getResume",markResumeConsumed:"markResumeConsumed",deleteEvents:"deleteEvents",deleteMeta:"deleteMeta",deleteResume:"deleteResume",getOldSessions:"getOldSessions"},L=class extends E{constructor(t){super(t?.dbPath??f("session"))}stmt(t){return this.stmts.get(t)}initSchema(){try{let s=this.db.pragma("table_xinfo(session_events)").find(e=>e.name==="data_hash");s&&s.hidden!==0&&this.db.exec("DROP TABLE session_events")}catch{}this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        data TEXT NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        attribution_source TEXT NOT NULL DEFAULT 'unknown',
        attribution_confidence REAL NOT NULL DEFAULT 0,
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
    `);try{let t=this.db.pragma("table_xinfo(session_events)"),s=new Set(t.map(e=>e.name));s.has("project_dir")||this.db.exec("ALTER TABLE session_events ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''"),s.has("attribution_source")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_source TEXT NOT NULL DEFAULT 'unknown'"),s.has("attribution_confidence")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_confidence REAL NOT NULL DEFAULT 0"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(session_id, project_dir)")}catch{}}prepareStatements(){this.stmts=new Map;let t=(s,e)=>{this.stmts.set(s,this.db.prepare(e))};t(i.insertEvent,`INSERT INTO session_events (
         session_id, type, category, priority, data,
         project_dir, attribution_source, attribution_confidence,
         source_hook, data_hash
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),t(i.getEvents,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`),t(i.getEventsByType,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`),t(i.getEventsByPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(i.getEventsByTypeAndPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(i.getEventCount,"SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?"),t(i.getLatestAttributedProject,`SELECT project_dir
       FROM session_events
       WHERE session_id = ? AND project_dir != ''
       ORDER BY id DESC
       LIMIT 1`),t(i.checkDuplicate,`SELECT 1 FROM (
         SELECT type, data_hash FROM session_events
         WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) AS recent
       WHERE recent.type = ? AND recent.data_hash = ?
       LIMIT 1`),t(i.evictLowestPriority,`DELETE FROM session_events WHERE id = (
         SELECT id FROM session_events WHERE session_id = ?
         ORDER BY priority ASC, id ASC LIMIT 1
       )`),t(i.updateMetaLastEvent,`UPDATE session_meta
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`),t(i.ensureSession,"INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)"),t(i.getSessionStats,`SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count
       FROM session_meta WHERE session_id = ?`),t(i.incrementCompactCount,"UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?"),t(i.upsertResume,`INSERT INTO session_resume (session_id, snapshot, event_count)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         created_at = datetime('now'),
         consumed = 0`),t(i.getResume,"SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?"),t(i.markResumeConsumed,"UPDATE session_resume SET consumed = 1 WHERE session_id = ?"),t(i.deleteEvents,"DELETE FROM session_events WHERE session_id = ?"),t(i.deleteMeta,"DELETE FROM session_meta WHERE session_id = ?"),t(i.deleteResume,"DELETE FROM session_resume WHERE session_id = ?"),t(i.getOldSessions,"SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')")}insertEvent(t,s,e="PostToolUse",r){let o=R("sha256").update(s.data).digest("hex").slice(0,16).toUpperCase(),a=String(r?.projectDir??s.project_dir??"").trim(),c=String(r?.source??s.attribution_source??"unknown"),T=Number(r?.confidence??s.attribution_confidence??0),S=Number.isFinite(T)?Math.max(0,Math.min(1,T)):0,v=this.db.transaction(()=>{if(this.stmt(i.checkDuplicate).get(t,F,s.type,o))return;this.stmt(i.getEventCount).get(t).cnt>=k&&this.stmt(i.evictLowestPriority).run(t),this.stmt(i.insertEvent).run(t,s.type,s.category,s.priority,s.data,a,c,S,e,o),this.stmt(i.updateMetaLastEvent).run(t)});this.withRetry(()=>v())}getEvents(t,s){let e=s?.limit??1e3,r=s?.type,o=s?.minPriority;return r&&o!==void 0?this.stmt(i.getEventsByTypeAndPriority).all(t,r,o,e):r?this.stmt(i.getEventsByType).all(t,r,e):o!==void 0?this.stmt(i.getEventsByPriority).all(t,o,e):this.stmt(i.getEvents).all(t,e)}getEventCount(t){return this.stmt(i.getEventCount).get(t).cnt}getLatestAttributedProjectDir(t){return this.stmt(i.getLatestAttributedProject).get(t)?.project_dir||null}ensureSession(t,s){this.stmt(i.ensureSession).run(t,s)}getSessionStats(t){return this.stmt(i.getSessionStats).get(t)??null}incrementCompactCount(t){this.stmt(i.incrementCompactCount).run(t)}upsertResume(t,s,e){this.stmt(i.upsertResume).run(t,s,e??0)}getResume(t){return this.stmt(i.getResume).get(t)??null}markResumeConsumed(t){this.stmt(i.markResumeConsumed).run(t)}deleteSession(t){this.db.transaction(()=>{this.stmt(i.deleteEvents).run(t),this.stmt(i.deleteResume).run(t),this.stmt(i.deleteMeta).run(t)})()}cleanupOldSessions(t=7){let s=`-${t}`,e=this.stmt(i.getOldSessions).all(s);for(let{session_id:r}of e)this.deleteSession(r);return e.length}};export{L as SessionDB,K as getWorktreeSuffix};
