import{createRequire as N}from"node:module";import{existsSync as v,unlinkSync as h,renameSync as O}from"node:fs";import{tmpdir as C}from"node:os";import{join as D}from"node:path";var m=class{#t;constructor(t){this.#t=t}pragma(t){let e=this.#t.prepare(`PRAGMA ${t}`).all();if(!e||e.length===0)return;if(e.length>1)return e;let r=Object.values(e[0]);return r.length===1?r[0]:e[0]}exec(t){let s="",e=null;for(let i=0;i<t.length;i++){let a=t[i];if(e)s+=a,a===e&&(e=null);else if(a==="'"||a==='"')s+=a,e=a;else if(a===";"){let c=s.trim();c&&this.#t.prepare(c).run(),s=""}else s+=a}let r=s.trim();return r&&this.#t.prepare(r).run(),this}prepare(t){let s=this.#t.prepare(t);return{run:(...e)=>s.run(...e),get:(...e)=>{let r=s.get(...e);return r===null?void 0:r},all:(...e)=>s.all(...e),iterate:(...e)=>s.iterate(...e)}}transaction(t){return this.#t.transaction(t)}close(){this.#t.close()}},_=class{#t;constructor(t){this.#t=t}pragma(t){let e=this.#t.prepare(`PRAGMA ${t}`).all();if(!e||e.length===0)return;if(e.length>1)return e;let r=Object.values(e[0]);return r.length===1?r[0]:e[0]}exec(t){return this.#t.exec(t),this}prepare(t){let s=this.#t.prepare(t);return{run:(...e)=>s.run(...e),get:(...e)=>s.get(...e),all:(...e)=>s.all(...e),iterate:(...e)=>typeof s.iterate=="function"?s.iterate(...e):s.all(...e)[Symbol.iterator]()}}transaction(t){return(...s)=>{this.#t.exec("BEGIN");try{let e=t(...s);return this.#t.exec("COMMIT"),e}catch(e){throw this.#t.exec("ROLLBACK"),e}}}close(){this.#t.close()}},u=null;function A(){if(!u){let o=N(import.meta.url);if(globalThis.Bun){let t=o(["bun","sqlite"].join(":")).Database;u=function(e,r){let i=new t(e,{readonly:r?.readonly,create:!0}),a=new m(i);return r?.timeout&&a.pragma(`busy_timeout = ${r.timeout}`),a}}else if(process.platform==="linux")try{let{DatabaseSync:t}=o(["node","sqlite"].join(":"));u=function(e,r){let i=new t(e,{readOnly:r?.readonly??!1});return new _(i)}}catch{u=o("better-sqlite3")}else u=o("better-sqlite3")}return u}function g(o){o.pragma("journal_mode = WAL"),o.pragma("synchronous = NORMAL");try{o.pragma("mmap_size = 268435456")}catch{}}function y(o){if(!v(o))for(let t of["-wal","-shm"])try{h(o+t)}catch{}}function w(o){for(let t of["","-wal","-shm"])try{h(o+t)}catch{}}function T(o){try{o.pragma("wal_checkpoint(TRUNCATE)")}catch{}try{o.close()}catch{}}function L(o="context-mode"){return D(C(),`${o}-${process.pid}.db`)}function I(o,t=[100,500,2e3]){let s;for(let e=0;e<=t.length;e++)try{return o()}catch(r){let i=r instanceof Error?r.message:String(r);if(!i.includes("SQLITE_BUSY")&&!i.includes("database is locked"))throw r;if(s=r instanceof Error?r:new Error(i),e<t.length){let a=t[e],c=Date.now();for(;Date.now()-c<a;);}}throw new Error(`SQLITE_BUSY: database is locked after ${t.length} retries. Original error: ${s?.message}`)}function U(o){return o.includes("SQLITE_CORRUPT")||o.includes("SQLITE_NOTADB")||o.includes("database disk image is malformed")||o.includes("file is not a database")}function M(o){let t=Date.now();for(let s of["","-wal","-shm"])try{O(o+s,`${o}${s}.corrupt-${t}`)}catch{}}var d=Symbol.for("__context_mode_live_dbs__"),E=(()=>{let o=globalThis;return o[d]||(o[d]=new Set,process.on("exit",()=>{for(let t of o[d])T(t);o[d].clear()})),o[d]})(),l=class{#t;#e;constructor(t){let s=A();this.#t=t,y(t);let e;try{e=new s(t,{timeout:3e4}),g(e)}catch(r){let i=r instanceof Error?r.message:String(r);if(U(i)){M(t),y(t);try{e=new s(t,{timeout:3e4}),g(e)}catch(a){throw new Error(`Failed to create fresh DB after renaming corrupt file: ${a instanceof Error?a.message:String(a)}`)}}else throw r}this.#e=e,E.add(this.#e),this.initSchema(),this.prepareStatements()}get db(){return this.#e}get dbPath(){return this.#t}close(){E.delete(this.#e),T(this.#e)}withRetry(t){return I(t)}cleanup(){E.delete(this.#e),T(this.#e),w(this.#t)}};import{createHash as R}from"node:crypto";import{execFileSync as x}from"node:child_process";function K(){let o=process.env.CONTEXT_MODE_SESSION_SUFFIX;if(o!==void 0)return o?`__${o}`:"";try{let t=process.cwd(),s=x("git",["worktree","list","--porcelain"],{encoding:"utf-8",timeout:2e3,stdio:["ignore","pipe","ignore"]}).split(/\r?\n/).find(e=>e.startsWith("worktree "))?.replace("worktree ","")?.trim();if(s&&t!==s)return`__${R("sha256").update(t).digest("hex").slice(0,8)}`}catch{}return""}var F=1e3,B=5,n={insertEvent:"insertEvent",getEvents:"getEvents",getEventsByType:"getEventsByType",getEventsByPriority:"getEventsByPriority",getEventsByTypeAndPriority:"getEventsByTypeAndPriority",getEventCount:"getEventCount",getLatestAttributedProject:"getLatestAttributedProject",checkDuplicate:"checkDuplicate",evictLowestPriority:"evictLowestPriority",updateMetaLastEvent:"updateMetaLastEvent",ensureSession:"ensureSession",getSessionStats:"getSessionStats",incrementCompactCount:"incrementCompactCount",upsertResume:"upsertResume",getResume:"getResume",markResumeConsumed:"markResumeConsumed",deleteEvents:"deleteEvents",deleteMeta:"deleteMeta",deleteResume:"deleteResume",getOldSessions:"getOldSessions",searchEvents:"searchEvents",incrementToolCall:"incrementToolCall",getToolCallTotals:"getToolCallTotals",getToolCallByTool:"getToolCallByTool"},S=class extends l{constructor(t){super(t?.dbPath??L("session"))}stmt(t){return this.stmts.get(t)}initSchema(){try{let s=this.db.pragma("table_xinfo(session_events)").find(e=>e.name==="data_hash");s&&s.hidden!==0&&this.db.exec("DROP TABLE session_events")}catch{}this.db.exec(`
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

      CREATE TABLE IF NOT EXISTS tool_calls (
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        bytes_returned INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, tool)
      );

      CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
    `);try{let t=this.db.pragma("table_xinfo(session_events)"),s=new Set(t.map(e=>e.name));s.has("project_dir")||this.db.exec("ALTER TABLE session_events ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''"),s.has("attribution_source")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_source TEXT NOT NULL DEFAULT 'unknown'"),s.has("attribution_confidence")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_confidence REAL NOT NULL DEFAULT 0"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(session_id, project_dir)")}catch{}}prepareStatements(){this.stmts=new Map;let t=(s,e)=>{this.stmts.set(s,this.db.prepare(e))};t(n.insertEvent,`INSERT INTO session_events (
         session_id, type, category, priority, data,
         project_dir, attribution_source, attribution_confidence,
         source_hook, data_hash
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),t(n.getEvents,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`),t(n.getEventsByType,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`),t(n.getEventsByPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(n.getEventsByTypeAndPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(n.getEventCount,"SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?"),t(n.getLatestAttributedProject,`SELECT project_dir
       FROM session_events
       WHERE session_id = ? AND project_dir != ''
       ORDER BY id DESC
       LIMIT 1`),t(n.checkDuplicate,`SELECT 1 FROM (
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
         consumed = 0`),t(n.getResume,"SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?"),t(n.markResumeConsumed,"UPDATE session_resume SET consumed = 1 WHERE session_id = ?"),t(n.deleteEvents,"DELETE FROM session_events WHERE session_id = ?"),t(n.deleteMeta,"DELETE FROM session_meta WHERE session_id = ?"),t(n.deleteResume,"DELETE FROM session_resume WHERE session_id = ?"),t(n.searchEvents,`SELECT id, session_id, category, type, data, created_at
       FROM session_events
       WHERE project_dir = ?
         AND (data LIKE '%' || ? || '%' ESCAPE '\\' OR category LIKE '%' || ? || '%' ESCAPE '\\')
         AND (? IS NULL OR category = ?)
       ORDER BY id ASC
       LIMIT ?`),t(n.getOldSessions,"SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')"),t(n.incrementToolCall,`INSERT INTO tool_calls (session_id, tool, calls, bytes_returned)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(session_id, tool) DO UPDATE SET
         calls = calls + 1,
         bytes_returned = bytes_returned + excluded.bytes_returned,
         updated_at = datetime('now')`),t(n.getToolCallTotals,`SELECT COALESCE(SUM(calls), 0) AS calls,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM tool_calls WHERE session_id = ?`),t(n.getToolCallByTool,`SELECT tool, calls, bytes_returned
       FROM tool_calls WHERE session_id = ? ORDER BY calls DESC`)}insertEvent(t,s,e="PostToolUse",r){let i=R("sha256").update(s.data).digest("hex").slice(0,16).toUpperCase(),a=String(r?.projectDir??s.project_dir??"").trim(),c=String(r?.source??s.attribution_source??"unknown"),p=Number(r?.confidence??s.attribution_confidence??0),f=Number.isFinite(p)?Math.max(0,Math.min(1,p)):0,b=this.db.transaction(()=>{if(this.stmt(n.checkDuplicate).get(t,B,s.type,i))return;this.stmt(n.getEventCount).get(t).cnt>=F&&this.stmt(n.evictLowestPriority).run(t),this.stmt(n.insertEvent).run(t,s.type,s.category,s.priority,s.data,a,c,f,e,i),this.stmt(n.updateMetaLastEvent).run(t)});this.withRetry(()=>b())}getEvents(t,s){let e=s?.limit??1e3,r=s?.type,i=s?.minPriority;return r&&i!==void 0?this.stmt(n.getEventsByTypeAndPriority).all(t,r,i,e):r?this.stmt(n.getEventsByType).all(t,r,e):i!==void 0?this.stmt(n.getEventsByPriority).all(t,i,e):this.stmt(n.getEvents).all(t,e)}getEventCount(t){return this.stmt(n.getEventCount).get(t).cnt}getLatestAttributedProjectDir(t){return this.stmt(n.getLatestAttributedProject).get(t)?.project_dir||null}searchEvents(t,s,e,r){try{let i=t.replace(/[%_]/g,c=>"\\"+c),a=r??null;return this.stmt(n.searchEvents).all(e,i,i,a,a,s)}catch{return[]}}ensureSession(t,s){this.stmt(n.ensureSession).run(t,s)}getSessionStats(t){return this.stmt(n.getSessionStats).get(t)??null}incrementCompactCount(t){this.stmt(n.incrementCompactCount).run(t)}upsertResume(t,s,e){this.stmt(n.upsertResume).run(t,s,e??0)}getResume(t){return this.stmt(n.getResume).get(t)??null}markResumeConsumed(t){this.stmt(n.markResumeConsumed).run(t)}getLatestSessionId(){try{return this.db.prepare("SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1").get()?.session_id??null}catch{return null}}incrementToolCall(t,s,e=0){let r=Number.isFinite(e)&&e>0?Math.round(e):0;try{this.stmt(n.incrementToolCall).run(t,s,r)}catch{}}getToolCallStats(t){try{let s=this.stmt(n.getToolCallTotals).get(t),e=this.stmt(n.getToolCallByTool).all(t),r={};for(let i of e)r[i.tool]={calls:i.calls,bytesReturned:i.bytes_returned};return{totalCalls:s?.calls??0,totalBytesReturned:s?.bytes_returned??0,byTool:r}}catch{return{totalCalls:0,totalBytesReturned:0,byTool:{}}}}deleteSession(t){this.db.transaction(()=>{this.stmt(n.deleteEvents).run(t),this.stmt(n.deleteResume).run(t),this.stmt(n.deleteMeta).run(t)})()}cleanupOldSessions(t=7){let s=`-${t}`,e=this.stmt(n.getOldSessions).all(s);for(let{session_id:r}of e)this.deleteSession(r);return e.length}};export{S as SessionDB,K as getWorktreeSuffix};
