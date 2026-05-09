import{createRequire as M}from"node:module";import{existsSync as x,unlinkSync as v,renameSync as F}from"node:fs";import{tmpdir as B}from"node:os";import{join as P}from"node:path";var g=class{#t;constructor(t){this.#t=t}pragma(t){let s=this.#t.prepare(`PRAGMA ${t}`).all();if(!s||s.length===0)return;if(s.length>1)return s;let r=Object.values(s[0]);return r.length===1?r[0]:s[0]}exec(t){let e="",s=null;for(let o=0;o<t.length;o++){let a=t[o];if(s)e+=a,a===s&&(s=null);else if(a==="'"||a==='"')e+=a,s=a;else if(a===";"){let c=e.trim();c&&this.#t.prepare(c).run(),e=""}else e+=a}let r=e.trim();return r&&this.#t.prepare(r).run(),this}prepare(t){let e=this.#t.prepare(t);return{run:(...s)=>e.run(...s),get:(...s)=>{let r=e.get(...s);return r===null?void 0:r},all:(...s)=>e.all(...s),iterate:(...s)=>e.iterate(...s)}}transaction(t){return this.#t.transaction(t)}close(){this.#t.close()}},h=class{#t;constructor(t){this.#t=t}pragma(t){let s=this.#t.prepare(`PRAGMA ${t}`).all();if(!s||s.length===0)return;if(s.length>1)return s;let r=Object.values(s[0]);return r.length===1?r[0]:s[0]}exec(t){return this.#t.exec(t),this}prepare(t){let e=this.#t.prepare(t);return{run:(...s)=>e.run(...s),get:(...s)=>e.get(...s),all:(...s)=>e.all(...s),iterate:(...s)=>typeof e.iterate=="function"?e.iterate(...s):e.all(...s)[Symbol.iterator]()}}transaction(t){return(...e)=>{this.#t.exec("BEGIN");try{let s=t(...e);return this.#t.exec("COMMIT"),s}catch(s){throw this.#t.exec("ROLLBACK"),s}}}close(){this.#t.close()}},d=null;function k(i){let t=null;try{return t=new i(":memory:"),t.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)"),!0}catch{return!1}finally{try{t?.close()}catch{}}}function j(){if(!d){let i=M(import.meta.url);if(globalThis.Bun){let t=i(["bun","sqlite"].join(":")).Database;d=function(s,r){let o=new t(s,{readonly:r?.readonly,create:!0}),a=new g(o);return r?.timeout&&a.pragma(`busy_timeout = ${r.timeout}`),a}}else if(process.platform==="linux"){let t=null;try{({DatabaseSync:t}=i(["node","sqlite"].join(":")))}catch{t=null}t&&k(t)?d=function(s,r){let o=new t(s,{readOnly:r?.readonly??!1});return new h(o)}:d=i("better-sqlite3")}else d=i("better-sqlite3")}return d}function b(i){i.pragma("journal_mode = WAL"),i.pragma("synchronous = NORMAL");try{i.pragma("mmap_size = 268435456")}catch{}}function N(i){if(!x(i))for(let t of["-wal","-shm"])try{v(i+t)}catch{}}function X(i){for(let t of["","-wal","-shm"])try{v(i+t)}catch{}}function y(i){try{i.pragma("wal_checkpoint(TRUNCATE)")}catch{}try{i.close()}catch{}}function C(i="context-mode"){return P(B(),`${i}-${process.pid}.db`)}function W(i,t=[100,500,2e3]){let e;for(let s=0;s<=t.length;s++)try{return i()}catch(r){let o=r instanceof Error?r.message:String(r);if(!o.includes("SQLITE_BUSY")&&!o.includes("database is locked"))throw r;if(e=r instanceof Error?r:new Error(o),s<t.length){let a=t[s],c=Date.now();for(;Date.now()-c<a;);}}throw new Error(`SQLITE_BUSY: database is locked after ${t.length} retries. Original error: ${e?.message}`)}function H(i){return i.includes("SQLITE_CORRUPT")||i.includes("SQLITE_NOTADB")||i.includes("database disk image is malformed")||i.includes("file is not a database")}function Y(i){let t=Date.now();for(let e of["","-wal","-shm"])try{F(i+e,`${i}${e}.corrupt-${t}`)}catch{}}var m=Symbol.for("__context_mode_live_dbs__"),T=(()=>{let i=globalThis;return i[m]||(i[m]=new Set,process.on("exit",()=>{for(let t of i[m])y(t);i[m].clear()})),i[m]})(),p=class{#t;#e;constructor(t){let e=j();this.#t=t,N(t);let s;try{s=new e(t,{timeout:3e4}),b(s)}catch(r){let o=r instanceof Error?r.message:String(r);if(H(o)){Y(t),N(t);try{s=new e(t,{timeout:3e4}),b(s)}catch(a){throw new Error(`Failed to create fresh DB after renaming corrupt file: ${a instanceof Error?a.message:String(a)}`)}}else throw r}this.#e=s,T.add(this.#e),this.initSchema(),this.prepareStatements()}get db(){return this.#e}get dbPath(){return this.#t}close(){T.delete(this.#e),y(this.#e)}withRetry(t){return W(t)}cleanup(){T.delete(this.#e),y(this.#e),X(this.#t)}};import{createHash as f}from"node:crypto";import{execFileSync as $}from"node:child_process";var l;function w(i){let t=i.replace(/\\/g,"/");return/^\/+$/.test(t)?"/":/^[A-Za-z]:\/+$/.test(t)?`${t.slice(0,2)}/`:t.replace(/\/+$/,"")}function I(i,t){return $("git",["-C",i,...t],{encoding:"utf-8",timeout:2e3,stdio:["ignore","pipe","ignore"]}).trim()}function G(i){let t=I(i,["rev-parse","--show-toplevel"]);return t.length>0?w(t):null}function q(i){let t=I(i,["worktree","list","--porcelain"]).split(/\r?\n/).find(e=>e.startsWith("worktree "))?.replace("worktree ","")?.trim();return t?w(t):null}function st(i=process.cwd()){let t=process.env.CONTEXT_MODE_SESSION_SUFFIX;if(l&&l.projectDir===i&&l.envSuffix===t)return l.suffix;let e="";if(t!==void 0)e=t?`__${t}`:"";else try{let s=G(i),r=q(i);s&&r&&s!==r&&(e=`__${f("sha256").update(s).digest("hex").slice(0,8)}`)}catch{}return l={projectDir:i,envSuffix:t,suffix:e},e}function nt(){l=void 0}var O=1e3,D=5,n={insertEvent:"insertEvent",getEvents:"getEvents",getEventsByType:"getEventsByType",getEventsByPriority:"getEventsByPriority",getEventsByTypeAndPriority:"getEventsByTypeAndPriority",getEventCount:"getEventCount",getLatestAttributedProject:"getLatestAttributedProject",checkDuplicate:"checkDuplicate",evictLowestPriority:"evictLowestPriority",updateMetaLastEvent:"updateMetaLastEvent",ensureSession:"ensureSession",getSessionStats:"getSessionStats",incrementCompactCount:"incrementCompactCount",upsertResume:"upsertResume",getResume:"getResume",markResumeConsumed:"markResumeConsumed",claimLatestUnconsumedResume:"claimLatestUnconsumedResume",deleteEvents:"deleteEvents",deleteMeta:"deleteMeta",deleteResume:"deleteResume",getOldSessions:"getOldSessions",searchEvents:"searchEvents",incrementToolCall:"incrementToolCall",getToolCallTotals:"getToolCallTotals",getToolCallByTool:"getToolCallByTool"},A=class extends p{constructor(t){super(t?.dbPath??C("session"))}stmt(t){return this.stmts.get(t)}initSchema(){try{let e=this.db.pragma("table_xinfo(session_events)").find(s=>s.name==="data_hash");e&&e.hidden!==0&&this.db.exec("DROP TABLE session_events")}catch{}this.db.exec(`
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
    `);try{let t=this.db.pragma("table_xinfo(session_events)"),e=new Set(t.map(s=>s.name));e.has("project_dir")||this.db.exec("ALTER TABLE session_events ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''"),e.has("attribution_source")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_source TEXT NOT NULL DEFAULT 'unknown'"),e.has("attribution_confidence")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_confidence REAL NOT NULL DEFAULT 0"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(session_id, project_dir)")}catch{}}prepareStatements(){this.stmts=new Map;let t=(e,s)=>{this.stmts.set(e,this.db.prepare(s))};t(n.insertEvent,`INSERT INTO session_events (
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
         consumed = 0`),t(n.getResume,"SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?"),t(n.markResumeConsumed,"UPDATE session_resume SET consumed = 1 WHERE session_id = ?"),t(n.claimLatestUnconsumedResume,`UPDATE session_resume
       SET consumed = 1
       WHERE id = (
         SELECT id FROM session_resume
         WHERE consumed = 0
           AND session_id != ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )
       RETURNING session_id, snapshot`),t(n.deleteEvents,"DELETE FROM session_events WHERE session_id = ?"),t(n.deleteMeta,"DELETE FROM session_meta WHERE session_id = ?"),t(n.deleteResume,"DELETE FROM session_resume WHERE session_id = ?"),t(n.searchEvents,`SELECT id, session_id, category, type, data, created_at
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
       FROM tool_calls WHERE session_id = ? ORDER BY calls DESC`)}insertEvent(t,e,s="PostToolUse",r){let o=f("sha256").update(e.data).digest("hex").slice(0,16).toUpperCase(),a=String(r?.projectDir??e.project_dir??"").trim(),c=String(r?.source??e.attribution_source??"unknown"),u=Number(r?.confidence??e.attribution_confidence??0),_=Number.isFinite(u)?Math.max(0,Math.min(1,u)):0,E=this.db.transaction(()=>{if(this.stmt(n.checkDuplicate).get(t,D,e.type,o))return;this.stmt(n.getEventCount).get(t).cnt>=O&&this.stmt(n.evictLowestPriority).run(t),this.stmt(n.insertEvent).run(t,e.type,e.category,e.priority,e.data,a,c,_,s,o),this.stmt(n.updateMetaLastEvent).run(t)});this.withRetry(()=>E())}bulkInsertEvents(t,e,s="PostToolUse",r){if(!e||e.length===0)return;if(e.length===1){this.insertEvent(t,e[0],s,r?.[0]);return}let o=e.map((c,u)=>{let _=f("sha256").update(c.data).digest("hex").slice(0,16).toUpperCase(),E=r?.[u],R=String(E?.projectDir??c.project_dir??"").trim(),S=String(E?.source??c.attribution_source??"unknown"),L=Number(E?.confidence??c.attribution_confidence??0),U=Number.isFinite(L)?Math.max(0,Math.min(1,L)):0;return{event:c,dataHash:_,projectDir:R,attributionSource:S,attributionConfidence:U}}),a=this.db.transaction(()=>{let c=this.stmt(n.getEventCount).get(t).cnt;for(let u of o)this.stmt(n.checkDuplicate).get(t,D,u.event.type,u.dataHash)||(c>=O?this.stmt(n.evictLowestPriority).run(t):c++,this.stmt(n.insertEvent).run(t,u.event.type,u.event.category,u.event.priority,u.event.data,u.projectDir,u.attributionSource,u.attributionConfidence,s,u.dataHash));this.stmt(n.updateMetaLastEvent).run(t)});this.withRetry(()=>a())}getEvents(t,e){let s=e?.limit??1e3,r=e?.type,o=e?.minPriority;return r&&o!==void 0?this.stmt(n.getEventsByTypeAndPriority).all(t,r,o,s):r?this.stmt(n.getEventsByType).all(t,r,s):o!==void 0?this.stmt(n.getEventsByPriority).all(t,o,s):this.stmt(n.getEvents).all(t,s)}getEventCount(t){return this.stmt(n.getEventCount).get(t).cnt}getLatestAttributedProjectDir(t){return this.stmt(n.getLatestAttributedProject).get(t)?.project_dir||null}searchEvents(t,e,s,r){try{let o=t.replace(/[%_]/g,c=>"\\"+c),a=r??null;return this.stmt(n.searchEvents).all(s,o,o,a,a,e)}catch{return[]}}ensureSession(t,e){this.stmt(n.ensureSession).run(t,e)}getSessionStats(t){return this.stmt(n.getSessionStats).get(t)??null}incrementCompactCount(t){this.stmt(n.incrementCompactCount).run(t)}upsertResume(t,e,s){this.stmt(n.upsertResume).run(t,e,s??0)}getResume(t){return this.stmt(n.getResume).get(t)??null}markResumeConsumed(t){this.stmt(n.markResumeConsumed).run(t)}claimLatestUnconsumedResume(t){let e=this.stmt(n.claimLatestUnconsumedResume).get(t);return e?{sessionId:e.session_id,snapshot:e.snapshot}:null}getLatestSessionId(){try{return this.db.prepare("SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1").get()?.session_id??null}catch{return null}}incrementToolCall(t,e,s=0){let r=Number.isFinite(s)&&s>0?Math.round(s):0;try{this.stmt(n.incrementToolCall).run(t,e,r)}catch{}}getToolCallStats(t){try{let e=this.stmt(n.getToolCallTotals).get(t),s=this.stmt(n.getToolCallByTool).all(t),r={};for(let o of s)r[o.tool]={calls:o.calls,bytesReturned:o.bytes_returned};return{totalCalls:e?.calls??0,totalBytesReturned:e?.bytes_returned??0,byTool:r}}catch{return{totalCalls:0,totalBytesReturned:0,byTool:{}}}}deleteSession(t){this.db.transaction(()=>{this.stmt(n.deleteEvents).run(t),this.stmt(n.deleteResume).run(t),this.stmt(n.deleteMeta).run(t)})()}cleanupOldSessions(t=7){let e=`-${t}`,s=this.stmt(n.getOldSessions).all(e);for(let{session_id:r}of s)this.deleteSession(r);return s.length}};export{A as SessionDB,nt as _resetWorktreeSuffixCacheForTests,st as getWorktreeSuffix,w as normalizeWorktreePath};
