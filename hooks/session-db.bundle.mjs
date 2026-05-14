import{createRequire as Y}from"node:module";import{existsSync as G,unlinkSync as x,renameSync as q}from"node:fs";import{tmpdir as z}from"node:os";import{join as K}from"node:path";var N=class{#t;constructor(t){this.#t=t}pragma(t){let n=this.#t.prepare(`PRAGMA ${t}`).all();if(!n||n.length===0)return;if(n.length>1)return n;let r=Object.values(n[0]);return r.length===1?r[0]:n[0]}exec(t){let e="",n=null;for(let a=0;a<t.length;a++){let o=t[a];if(n)e+=o,o===n&&(n=null);else if(o==="'"||o==='"')e+=o,n=o;else if(o===";"){let c=e.trim();c&&this.#t.prepare(c).run(),e=""}else e+=o}let r=e.trim();return r&&this.#t.prepare(r).run(),this}prepare(t){let e=this.#t.prepare(t);return{run:(...n)=>e.run(...n),get:(...n)=>{let r=e.get(...n);return r===null?void 0:r},all:(...n)=>e.all(...n),iterate:(...n)=>e.iterate(...n)}}transaction(t){return this.#t.transaction(t)}close(){this.#t.close()}},A=class{#t;constructor(t){this.#t=t}pragma(t){let n=this.#t.prepare(`PRAGMA ${t}`).all();if(!n||n.length===0)return;if(n.length>1)return n;let r=Object.values(n[0]);return r.length===1?r[0]:n[0]}exec(t){return this.#t.exec(t),this}prepare(t){let e=this.#t.prepare(t);return{run:(...n)=>e.run(...n),get:(...n)=>e.get(...n),all:(...n)=>e.all(...n),iterate:(...n)=>typeof e.iterate=="function"?e.iterate(...n):e.all(...n)[Symbol.iterator]()}}transaction(t){return(...e)=>{this.#t.exec("BEGIN");try{let n=t(...e);return this.#t.exec("COMMIT"),n}catch(n){throw this.#t.exec("ROLLBACK"),n}}}close(){this.#t.close()}},l=null;function V(s){let t=null;try{return t=new s(":memory:"),t.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)"),!0}catch{return!1}finally{try{t?.close()}catch{}}}function Q(s,t){let e=t!==void 0?t:globalThis.Bun;if(typeof e<"u"&&e!==null)return!0;let n=s??process.versions,[r,a]=(n.node??"0.0.0").split("."),o=Number(r),c=Number(a);return!Number.isFinite(o)||!Number.isFinite(c)?!1:o>22||o===22&&c>=5}function J(){if(!l){let s=Y(import.meta.url);if(globalThis.Bun){let t=s(["bun","sqlite"].join(":")).Database;l=function(n,r){let a=new t(n,{readonly:r?.readonly,create:!0}),o=new N(a);return r?.timeout&&o.pragma(`busy_timeout = ${r.timeout}`),o}}else if(Q()){let t=null;try{({DatabaseSync:t}=s(["node","sqlite"].join(":")))}catch{t=null}t&&V(t)?l=function(n,r){let a=new t(n,{readOnly:r?.readonly??!1});return new A(a)}:l=s("better-sqlite3")}else l=s("better-sqlite3")}return l}function I(s){s.pragma("journal_mode = WAL"),s.pragma("synchronous = NORMAL");try{s.pragma("mmap_size = 268435456")}catch{}}function U(s){if(!G(s))for(let t of["-wal","-shm"])try{x(s+t)}catch{}}function Z(s){for(let t of["","-wal","-shm"])try{x(s+t)}catch{}}function C(s){try{s.pragma("wal_checkpoint(TRUNCATE)")}catch{}try{s.close()}catch{}}function M(s="context-mode"){return K(z(),`${s}-${process.pid}.db`)}function tt(s){let t=s instanceof Error?s.message:String(s);return t.includes("SQLITE_BUSY")||t.includes("database is locked")}function et(s){return s instanceof Error?s:new Error(String(s))}function nt(s){s<=0||Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,s)}function st(s,t){return new Error(`SQLITE_BUSY: database is locked after ${s.length} retries. Original error: ${t?.message}`)}function rt(s,t=[100,500,2e3]){let e;for(let n=0;n<=t.length;n++)try{return s()}catch(r){if(!tt(r))throw r;e=et(r),n<t.length&&nt(t[n])}throw st(t,e)}function it(s){return s.includes("SQLITE_CORRUPT")||s.includes("SQLITE_NOTADB")||s.includes("database disk image is malformed")||s.includes("file is not a database")}function ot(s){let t=Date.now();for(let e of["","-wal","-shm"])try{q(s+e,`${s}${e}.corrupt-${t}`)}catch{}}var _=Symbol.for("__context_mode_live_dbs_v3__"),v=(()=>{let s=globalThis;return s[_]||(s[_]=new Set,process.on("exit",()=>{for(let t of s[_])C(t);s[_].clear()})),s[_]})(),T=class{#t;#e;constructor(t){let e=J();this.#t=t,U(t);let n;try{n=new e(t,{timeout:3e4}),I(n)}catch(r){let a=r instanceof Error?r.message:String(r);if(it(a)){ot(t),U(t);try{n=new e(t,{timeout:3e4}),I(n)}catch(o){throw new Error(`Failed to create fresh DB after renaming corrupt file: ${o instanceof Error?o.message:String(o)}`)}}else throw r}this.#e=n,v.add(this.#e),this.initSchema(),this.prepareStatements()}get db(){return this.#e}get dbPath(){return this.#t}close(){v.delete(this.#e),C(this.#e)}withRetry(t){return rt(t)}cleanup(){v.delete(this.#e),C(this.#e),Z(this.#t)}};import{createHash as p}from"node:crypto";import{execFileSync as at}from"node:child_process";import{existsSync as f,realpathSync as ct,renameSync as D}from"node:fs";import{join as b}from"node:path";var E;function g(s){let t=s.replace(/\\/g,"/");return/^\/+$/.test(t)?"/":/^[A-Za-z]:\/+$/.test(t)?`${t.slice(0,2)}/`:t.replace(/\/+$/,"")}function F(s){let t=s;try{t=ct.native(s)}catch{}let e=g(t);return process.platform==="win32"||process.platform==="darwin"?e.toLowerCase():e}function j(s,t){return at("git",["-C",s,...t],{encoding:"utf-8",timeout:2e3,stdio:["ignore","pipe","ignore"]}).trim()}function ut(s){let t=j(s,["rev-parse","--show-toplevel"]);return t.length>0?g(t):null}function dt(s){let t=j(s,["worktree","list","--porcelain"]).split(/\r?\n/).find(e=>e.startsWith("worktree "))?.replace("worktree ","")?.trim();return t?g(t):null}function lt(s=process.cwd()){let t=process.env.CONTEXT_MODE_SESSION_SUFFIX;if(E&&E.projectDir===s&&E.envSuffix===t)return E.suffix;let e="";if(t!==void 0)e=t?`__${t}`:"";else try{let n=ut(s),r=dt(s);if(n&&r){let a=F(n),o=F(r);a!==o&&(e=`__${p("sha256").update(a).digest("hex").slice(0,8)}`)}}catch{}return E={projectDir:s,envSuffix:t,suffix:e},e}function St(){E=void 0}function X(s){return p("sha256").update(g(s)).digest("hex").slice(0,16)}function W(s){let t=g(s),e=process.platform==="darwin"||process.platform==="win32"?t.toLowerCase():t;return p("sha256").update(e).digest("hex").slice(0,16)}function Lt(s){let{projectDir:t,contentDir:e}=s,n=W(t),r=b(e,`${n}.db`);if(f(r))return r;let a=X(t);if(a===n)return r;let o=b(e,`${a}.db`);if(f(o))try{D(o,r);for(let c of["-wal","-shm"])try{D(o+c,r+c)}catch{}}catch{}return r}function vt(s){return Et({...s,ext:".db"})}function Et(s){let{projectDir:t,sessionsDir:e,ext:n}=s,r=s.suffix??lt(t),a=W(t),o=b(e,`${a}${r}${n}`);if(f(o))return o;let c=X(t);if(c===a)return o;let d=b(e,`${c}${r}${n}`);if(f(d))try{D(d,o)}catch{}return o}var B=1e3,P=5;function h(s){let t=Number(s);return!Number.isFinite(t)||t<=0?0:Math.floor(t)}var i={insertEvent:"insertEvent",getEvents:"getEvents",getEventsByType:"getEventsByType",getEventsByPriority:"getEventsByPriority",getEventsByTypeAndPriority:"getEventsByTypeAndPriority",getEventCount:"getEventCount",getLatestAttributedProject:"getLatestAttributedProject",checkDuplicate:"checkDuplicate",evictLowestPriority:"evictLowestPriority",updateMetaLastEvent:"updateMetaLastEvent",ensureSession:"ensureSession",getSessionStats:"getSessionStats",incrementCompactCount:"incrementCompactCount",upsertResume:"upsertResume",getResume:"getResume",markResumeConsumed:"markResumeConsumed",claimLatestUnconsumedResume:"claimLatestUnconsumedResume",deleteEvents:"deleteEvents",deleteMeta:"deleteMeta",deleteResume:"deleteResume",getOldSessions:"getOldSessions",searchEvents:"searchEvents",incrementToolCall:"incrementToolCall",getToolCallTotals:"getToolCallTotals",getToolCallByTool:"getToolCallByTool",getEventBytesSummary:"getEventBytesSummary"},k=class extends T{constructor(t){super(t?.dbPath??M("session"))}stmt(t){return this.stmts.get(t)}initSchema(){try{let e=this.db.pragma("table_xinfo(session_events)").find(n=>n.name==="data_hash");e&&e.hidden!==0&&this.db.exec("DROP TABLE session_events")}catch{}this.db.exec(`
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
        bytes_avoided INTEGER NOT NULL DEFAULT 0,
        bytes_returned INTEGER NOT NULL DEFAULT 0,
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
    `);try{let t=this.db.pragma("table_xinfo(session_events)"),e=new Set(t.map(n=>n.name));e.has("project_dir")||this.db.exec("ALTER TABLE session_events ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''"),e.has("attribution_source")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_source TEXT NOT NULL DEFAULT 'unknown'"),e.has("attribution_confidence")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_confidence REAL NOT NULL DEFAULT 0"),e.has("bytes_avoided")||this.db.exec("ALTER TABLE session_events ADD COLUMN bytes_avoided INTEGER NOT NULL DEFAULT 0"),e.has("bytes_returned")||this.db.exec("ALTER TABLE session_events ADD COLUMN bytes_returned INTEGER NOT NULL DEFAULT 0"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(session_id, project_dir)")}catch{}}prepareStatements(){this.stmts=new Map;let t=(e,n)=>{this.stmts.set(e,this.db.prepare(n))};t(i.insertEvent,`INSERT INTO session_events (
         session_id, type, category, priority, data,
         project_dir, attribution_source, attribution_confidence,
         bytes_avoided, bytes_returned,
         source_hook, data_hash
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),t(i.getEvents,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`),t(i.getEventsByType,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`),t(i.getEventsByPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(i.getEventsByTypeAndPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
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
         consumed = 0`),t(i.getResume,"SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?"),t(i.markResumeConsumed,"UPDATE session_resume SET consumed = 1 WHERE session_id = ?"),t(i.claimLatestUnconsumedResume,`UPDATE session_resume
       SET consumed = 1
       WHERE id = (
         SELECT id FROM session_resume
         WHERE consumed = 0
           AND session_id != ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )
       RETURNING session_id, snapshot`),t(i.deleteEvents,"DELETE FROM session_events WHERE session_id = ?"),t(i.deleteMeta,"DELETE FROM session_meta WHERE session_id = ?"),t(i.deleteResume,"DELETE FROM session_resume WHERE session_id = ?"),t(i.searchEvents,`SELECT id, session_id, category, type, data, created_at
       FROM session_events
       WHERE project_dir = ?
         AND (data LIKE '%' || ? || '%' ESCAPE '\\' OR category LIKE '%' || ? || '%' ESCAPE '\\')
         AND (? IS NULL OR category = ?)
       ORDER BY id ASC
       LIMIT ?`),t(i.getOldSessions,"SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')"),t(i.incrementToolCall,`INSERT INTO tool_calls (session_id, tool, calls, bytes_returned)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(session_id, tool) DO UPDATE SET
         calls = calls + 1,
         bytes_returned = bytes_returned + excluded.bytes_returned,
         updated_at = datetime('now')`),t(i.getToolCallTotals,`SELECT COALESCE(SUM(calls), 0) AS calls,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM tool_calls WHERE session_id = ?`),t(i.getToolCallByTool,`SELECT tool, calls, bytes_returned
       FROM tool_calls WHERE session_id = ? ORDER BY calls DESC`),t(i.getEventBytesSummary,`SELECT COALESCE(SUM(bytes_avoided), 0) AS bytes_avoided,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM session_events WHERE session_id = ?`)}insertEvent(t,e,n="PostToolUse",r,a){let o=p("sha256").update(e.data).digest("hex").slice(0,16).toUpperCase(),c=String(r?.projectDir??e.project_dir??"").trim(),d=String(r?.source??e.attribution_source??"unknown"),u=Number(r?.confidence??e.attribution_confidence??0),y=Number.isFinite(u)?Math.max(0,Math.min(1,u)):0,m=h(a?.bytesAvoided),R=h(a?.bytesReturned),S=this.db.transaction(()=>{if(this.stmt(i.checkDuplicate).get(t,P,e.type,o))return;this.stmt(i.getEventCount).get(t).cnt>=B&&this.stmt(i.evictLowestPriority).run(t),this.stmt(i.insertEvent).run(t,e.type,e.category,e.priority,e.data,c,d,y,m,R,n,o),this.stmt(i.updateMetaLastEvent).run(t)});this.withRetry(()=>S())}bulkInsertEvents(t,e,n="PostToolUse",r,a){if(!e||e.length===0)return;if(e.length===1){this.insertEvent(t,e[0],n,r?.[0],a?.[0]);return}let o=e.map((d,u)=>{let y=p("sha256").update(d.data).digest("hex").slice(0,16).toUpperCase(),m=r?.[u],R=String(m?.projectDir??d.project_dir??"").trim(),S=String(m?.source??d.attribution_source??"unknown"),L=Number(m?.confidence??d.attribution_confidence??0),O=Number.isFinite(L)?Math.max(0,Math.min(1,L)):0,w=a?.[u],H=h(w?.bytesAvoided),$=h(w?.bytesReturned);return{event:d,dataHash:y,projectDir:R,attributionSource:S,attributionConfidence:O,bytesAvoided:H,bytesReturned:$}}),c=this.db.transaction(()=>{let d=this.stmt(i.getEventCount).get(t).cnt;for(let u of o)this.stmt(i.checkDuplicate).get(t,P,u.event.type,u.dataHash)||(d>=B?this.stmt(i.evictLowestPriority).run(t):d++,this.stmt(i.insertEvent).run(t,u.event.type,u.event.category,u.event.priority,u.event.data,u.projectDir,u.attributionSource,u.attributionConfidence,u.bytesAvoided,u.bytesReturned,n,u.dataHash));this.stmt(i.updateMetaLastEvent).run(t)});this.withRetry(()=>c())}getEvents(t,e){let n=e?.limit??1e3,r=e?.type,a=e?.minPriority;return r&&a!==void 0?this.stmt(i.getEventsByTypeAndPriority).all(t,r,a,n):r?this.stmt(i.getEventsByType).all(t,r,n):a!==void 0?this.stmt(i.getEventsByPriority).all(t,a,n):this.stmt(i.getEvents).all(t,n)}getEventCount(t){return this.stmt(i.getEventCount).get(t).cnt}getEventBytesSummary(t){let e=this.stmt(i.getEventBytesSummary).get(t);return{bytesAvoided:Number(e?.bytes_avoided??0),bytesReturned:Number(e?.bytes_returned??0)}}getLatestAttributedProjectDir(t){return this.stmt(i.getLatestAttributedProject).get(t)?.project_dir||null}searchEvents(t,e,n,r){try{let a=t.replace(/[%_]/g,c=>"\\"+c),o=r??null;return this.stmt(i.searchEvents).all(n,a,a,o,o,e)}catch{return[]}}ensureSession(t,e){this.stmt(i.ensureSession).run(t,e)}getSessionStats(t){return this.stmt(i.getSessionStats).get(t)??null}incrementCompactCount(t){this.stmt(i.incrementCompactCount).run(t)}upsertResume(t,e,n){this.stmt(i.upsertResume).run(t,e,n??0)}getResume(t){return this.stmt(i.getResume).get(t)??null}markResumeConsumed(t){this.stmt(i.markResumeConsumed).run(t)}claimLatestUnconsumedResume(t){let e=this.stmt(i.claimLatestUnconsumedResume).get(t);return e?{sessionId:e.session_id,snapshot:e.snapshot}:null}getLatestSessionId(){try{return this.db.prepare("SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1").get()?.session_id??null}catch{return null}}incrementToolCall(t,e,n=0){this.bulkIncrementToolCalls(t,[{tool:e,calls:1,bytesReturned:n}])}bulkIncrementToolCalls(t,e){if(e.length!==0)try{let n=this.db.transaction(()=>{for(let r of e){let a=Number.isFinite(r.calls)&&r.calls>0?Math.round(r.calls):0,o=Number.isFinite(r.bytesReturned)&&r.bytesReturned>0?Math.round(r.bytesReturned):0;for(let c=0;c<a;c++)this.stmt(i.incrementToolCall).run(t,r.tool,c===0?o:0)}});this.withRetry(()=>n())}catch{}}getToolCallStats(t){try{let e=this.stmt(i.getToolCallTotals).get(t),n=this.stmt(i.getToolCallByTool).all(t),r={};for(let a of n)r[a.tool]={calls:a.calls,bytesReturned:a.bytes_returned};return{totalCalls:e?.calls??0,totalBytesReturned:e?.bytes_returned??0,byTool:r}}catch{return{totalCalls:0,totalBytesReturned:0,byTool:{}}}}deleteSession(t){this.db.transaction(()=>{this.stmt(i.deleteEvents).run(t),this.stmt(i.deleteResume).run(t),this.stmt(i.deleteMeta).run(t)})()}cleanupOldSessions(t=7){let e=`-${t}`,n=this.stmt(i.getOldSessions).all(e);for(let{session_id:r}of n)this.deleteSession(r);return n.length}};export{k as SessionDB,St as _resetWorktreeSuffixCacheForTests,lt as getWorktreeSuffix,W as hashProjectDirCanonical,X as hashProjectDirLegacy,g as normalizeWorktreePath,Lt as resolveContentStorePath,vt as resolveSessionDbPath,Et as resolveSessionPath};
