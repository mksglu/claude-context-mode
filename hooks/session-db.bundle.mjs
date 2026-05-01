import{createRequire as b}from"node:module";import{existsSync as N,unlinkSync as y,renameSync as D}from"node:fs";import{tmpdir as O}from"node:os";import{join as A}from"node:path";var p=class{#t;constructor(t){this.#t=t}pragma(t){let e=this.#t.prepare(`PRAGMA ${t}`).all();if(!e||e.length===0)return;if(e.length>1)return e;let n=Object.values(e[0]);return n.length===1?n[0]:e[0]}exec(t){let s="",e=null;for(let o=0;o<t.length;o++){let a=t[o];if(e)s+=a,a===e&&(e=null);else if(a==="'"||a==='"')s+=a,e=a;else if(a===";"){let c=s.trim();c&&this.#t.prepare(c).run(),s=""}else s+=a}let n=s.trim();return n&&this.#t.prepare(n).run(),this}prepare(t){let s=this.#t.prepare(t);return{run:(...e)=>s.run(...e),get:(...e)=>{let n=s.get(...e);return n===null?void 0:n},all:(...e)=>s.all(...e),iterate:(...e)=>s.iterate(...e)}}transaction(t){return this.#t.transaction(t)}close(){this.#t.close()}},_=class{#t;constructor(t){this.#t=t}pragma(t){let e=this.#t.prepare(`PRAGMA ${t}`).all();if(!e||e.length===0)return;if(e.length>1)return e;let n=Object.values(e[0]);return n.length===1?n[0]:e[0]}exec(t){return this.#t.exec(t),this}prepare(t){let s=this.#t.prepare(t);return{run:(...e)=>s.run(...e),get:(...e)=>s.get(...e),all:(...e)=>s.all(...e),iterate:(...e)=>typeof s.iterate=="function"?s.iterate(...e):s.all(...e)[Symbol.iterator]()}}transaction(t){return(...s)=>{this.#t.exec("BEGIN");try{let e=t(...s);return this.#t.exec("COMMIT"),e}catch(e){throw this.#t.exec("ROLLBACK"),e}}}close(){this.#t.close()}},u=null;function w(){if(!u){let i=b(import.meta.url);if(globalThis.Bun){let t=i(["bun","sqlite"].join(":")).Database;u=function(e,n){let o=new t(e,{readonly:n?.readonly,create:!0}),a=new p(o);return n?.timeout&&a.pragma(`busy_timeout = ${n.timeout}`),a}}else if(process.platform==="linux")try{let{DatabaseSync:t}=i(["node","sqlite"].join(":"));u=function(e,n){let o=new t(e,{readOnly:n?.readonly??!1});return new _(o)}}catch{u=i("better-sqlite3")}else u=i("better-sqlite3")}return u}function T(i){i.pragma("journal_mode = WAL"),i.pragma("synchronous = NORMAL");try{i.pragma("mmap_size = 268435456")}catch{}}function h(i){if(!N(i))for(let t of["-wal","-shm"])try{y(i+t)}catch{}}function C(i){for(let t of["","-wal","-shm"])try{y(i+t)}catch{}}function l(i){try{i.pragma("wal_checkpoint(TRUNCATE)")}catch{}try{i.close()}catch{}}function f(i="context-mode"){return A(O(),`${i}-${process.pid}.db`)}function I(i,t=[100,500,2e3]){let s;for(let e=0;e<=t.length;e++)try{return i()}catch(n){let o=n instanceof Error?n.message:String(n);if(!o.includes("SQLITE_BUSY")&&!o.includes("database is locked"))throw n;if(s=n instanceof Error?n:new Error(o),e<t.length){let a=t[e],c=Date.now();for(;Date.now()-c<a;);}}throw new Error(`SQLITE_BUSY: database is locked after ${t.length} retries. Original error: ${s?.message}`)}function U(i){return i.includes("SQLITE_CORRUPT")||i.includes("SQLITE_NOTADB")||i.includes("database disk image is malformed")||i.includes("file is not a database")}function M(i){let t=Date.now();for(let s of["","-wal","-shm"])try{D(i+s,`${i}${s}.corrupt-${t}`)}catch{}}var d=Symbol.for("__context_mode_live_dbs__"),m=(()=>{let i=globalThis;return i[d]||(i[d]=new Set,process.on("exit",()=>{for(let t of i[d])l(t);i[d].clear()})),i[d]})(),E=class{#t;#e;constructor(t){let s=w();this.#t=t,h(t);let e;try{e=new s(t,{timeout:3e4}),T(e)}catch(n){let o=n instanceof Error?n.message:String(n);if(U(o)){M(t),h(t);try{e=new s(t,{timeout:3e4}),T(e)}catch(a){throw new Error(`Failed to create fresh DB after renaming corrupt file: ${a instanceof Error?a.message:String(a)}`)}}else throw n}this.#e=e,m.add(this.#e),this.initSchema(),this.prepareStatements()}get db(){return this.#e}get dbPath(){return this.#t}close(){m.delete(this.#e),l(this.#e)}withRetry(t){return I(t)}cleanup(){m.delete(this.#e),l(this.#e),C(this.#t)}};import{createHash as R}from"node:crypto";import{execFileSync as x}from"node:child_process";function K(){let i=process.env.CONTEXT_MODE_SESSION_SUFFIX;if(i!==void 0)return i?`__${i}`:"";try{let t=process.cwd(),s=x("git",["worktree","list","--porcelain"],{encoding:"utf-8",timeout:2e3,stdio:["ignore","pipe","ignore"]}).split(/\r?\n/).find(e=>e.startsWith("worktree "))?.replace("worktree ","")?.trim();if(s&&t!==s)return`__${R("sha256").update(t).digest("hex").slice(0,8)}`}catch{}return""}var k=1e3,F=5,r={insertEvent:"insertEvent",getEvents:"getEvents",getEventsByType:"getEventsByType",getEventsByPriority:"getEventsByPriority",getEventsByTypeAndPriority:"getEventsByTypeAndPriority",getEventCount:"getEventCount",getLatestAttributedProject:"getLatestAttributedProject",checkDuplicate:"checkDuplicate",evictLowestPriority:"evictLowestPriority",updateMetaLastEvent:"updateMetaLastEvent",ensureSession:"ensureSession",getSessionStats:"getSessionStats",incrementCompactCount:"incrementCompactCount",upsertResume:"upsertResume",getResume:"getResume",markResumeConsumed:"markResumeConsumed",deleteEvents:"deleteEvents",deleteMeta:"deleteMeta",deleteResume:"deleteResume",getOldSessions:"getOldSessions",searchEvents:"searchEvents"},L=class extends E{constructor(t){super(t?.dbPath??f("session"))}stmt(t){return this.stmts.get(t)}initSchema(){try{let s=this.db.pragma("table_xinfo(session_events)").find(e=>e.name==="data_hash");s&&s.hidden!==0&&this.db.exec("DROP TABLE session_events")}catch{}this.db.exec(`
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
    `);try{let t=this.db.pragma("table_xinfo(session_events)"),s=new Set(t.map(e=>e.name));s.has("project_dir")||this.db.exec("ALTER TABLE session_events ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''"),s.has("attribution_source")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_source TEXT NOT NULL DEFAULT 'unknown'"),s.has("attribution_confidence")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_confidence REAL NOT NULL DEFAULT 0"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(session_id, project_dir)")}catch{}}prepareStatements(){this.stmts=new Map;let t=(s,e)=>{this.stmts.set(s,this.db.prepare(e))};t(r.insertEvent,`INSERT INTO session_events (
         session_id, type, category, priority, data,
         project_dir, attribution_source, attribution_confidence,
         source_hook, data_hash
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),t(r.getEvents,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`),t(r.getEventsByType,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`),t(r.getEventsByPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(r.getEventsByTypeAndPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(r.getEventCount,"SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?"),t(r.getLatestAttributedProject,`SELECT project_dir
       FROM session_events
       WHERE session_id = ? AND project_dir != ''
       ORDER BY id DESC
       LIMIT 1`),t(r.checkDuplicate,`SELECT 1 FROM (
         SELECT type, data_hash FROM session_events
         WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) AS recent
       WHERE recent.type = ? AND recent.data_hash = ?
       LIMIT 1`),t(r.evictLowestPriority,`DELETE FROM session_events WHERE id = (
         SELECT id FROM session_events WHERE session_id = ?
         ORDER BY priority ASC, id ASC LIMIT 1
       )`),t(r.updateMetaLastEvent,`UPDATE session_meta
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`),t(r.ensureSession,"INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)"),t(r.getSessionStats,`SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count
       FROM session_meta WHERE session_id = ?`),t(r.incrementCompactCount,"UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?"),t(r.upsertResume,`INSERT INTO session_resume (session_id, snapshot, event_count)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         created_at = datetime('now'),
         consumed = 0`),t(r.getResume,"SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?"),t(r.markResumeConsumed,"UPDATE session_resume SET consumed = 1 WHERE session_id = ?"),t(r.deleteEvents,"DELETE FROM session_events WHERE session_id = ?"),t(r.deleteMeta,"DELETE FROM session_meta WHERE session_id = ?"),t(r.deleteResume,"DELETE FROM session_resume WHERE session_id = ?"),t(r.searchEvents,`SELECT id, session_id, category, type, data, created_at
       FROM session_events
       WHERE project_dir = ?
         AND (data LIKE '%' || ? || '%' ESCAPE '\\' OR category LIKE '%' || ? || '%' ESCAPE '\\')
         AND (? IS NULL OR category = ?)
       ORDER BY id ASC
       LIMIT ?`),t(r.getOldSessions,"SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')")}insertEvent(t,s,e="PostToolUse",n){let o=R("sha256").update(s.data).digest("hex").slice(0,16).toUpperCase(),a=String(n?.projectDir??s.project_dir??"").trim(),c=String(n?.source??s.attribution_source??"unknown"),g=Number(n?.confidence??s.attribution_confidence??0),S=Number.isFinite(g)?Math.max(0,Math.min(1,g)):0,v=this.db.transaction(()=>{if(this.stmt(r.checkDuplicate).get(t,F,s.type,o))return;this.stmt(r.getEventCount).get(t).cnt>=k&&this.stmt(r.evictLowestPriority).run(t),this.stmt(r.insertEvent).run(t,s.type,s.category,s.priority,s.data,a,c,S,e,o),this.stmt(r.updateMetaLastEvent).run(t)});this.withRetry(()=>v())}getEvents(t,s){let e=s?.limit??1e3,n=s?.type,o=s?.minPriority;return n&&o!==void 0?this.stmt(r.getEventsByTypeAndPriority).all(t,n,o,e):n?this.stmt(r.getEventsByType).all(t,n,e):o!==void 0?this.stmt(r.getEventsByPriority).all(t,o,e):this.stmt(r.getEvents).all(t,e)}getEventCount(t){return this.stmt(r.getEventCount).get(t).cnt}getLatestAttributedProjectDir(t){return this.stmt(r.getLatestAttributedProject).get(t)?.project_dir||null}searchEvents(t,s,e,n){try{let o=t.replace(/[%_]/g,c=>"\\"+c),a=n??null;return this.stmt(r.searchEvents).all(e,o,o,a,a,s)}catch{return[]}}ensureSession(t,s){this.stmt(r.ensureSession).run(t,s)}getSessionStats(t){return this.stmt(r.getSessionStats).get(t)??null}incrementCompactCount(t){this.stmt(r.incrementCompactCount).run(t)}upsertResume(t,s,e){this.stmt(r.upsertResume).run(t,s,e??0)}getResume(t){return this.stmt(r.getResume).get(t)??null}markResumeConsumed(t){this.stmt(r.markResumeConsumed).run(t)}deleteSession(t){this.db.transaction(()=>{this.stmt(r.deleteEvents).run(t),this.stmt(r.deleteResume).run(t),this.stmt(r.deleteMeta).run(t)})()}cleanupOldSessions(t=7){let s=`-${t}`,e=this.stmt(r.getOldSessions).all(s);for(let{session_id:n}of e)this.deleteSession(n);return e.length}};export{L as SessionDB,K as getWorktreeSuffix};
