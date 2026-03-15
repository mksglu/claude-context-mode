# Multi-Agent Session Isolation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate context-mode sessions per OpenClaw agent using `sessionKey` from the `session_start` event, so two agents sharing the same project directory don't pollute each other's session data.

**Architecture:** Add a `session_key` column to `session_meta`. Move session lookup from `register()` to `session_start()`, scoping by `sessionKey`. Fall back to fresh sessions when `sessionKey` is absent.

**Tech Stack:** TypeScript, better-sqlite3, Vitest

**Spec:** `docs/superpowers/specs/2026-03-14-multi-agent-session-isolation-design.md`

---

## Chunk 1: Database Schema & Methods

### Task 1: Add `session_key` column and update `SessionMeta` type

**Files:**
- Modify: `src/session/db.ts:32-39` (SessionMeta interface)
- Modify: `src/session/db.ts:116-163` (initSchema)

- [ ] **Step 1: Write failing test — `ensureSession` with `sessionKey` parameter**

Add to `tests/openclaw-plugin-hooks.test.ts` inside a new describe block after the existing `SessionDB.renameSession` block:

```typescript
// ════════════════════════════════════════════
// SessionDB.session_key support
// ════════════════════════════════════════════

describe("SessionDB.session_key support", () => {
  test("ensureSession accepts optional sessionKey parameter", () => {
    const db = createTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const sessionKey = "agent-a:telegram:12345";

    db.ensureSession(sid, projectDir, sessionKey);

    const stats = db.getSessionStats(sid);
    assert.ok(stats, "session must exist");
    assert.equal(stats.session_key, sessionKey, "session_key must be stored");
  });

  test("ensureSession works without sessionKey (backward compat)", () => {
    const db = createTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);

    db.ensureSession(sid, projectDir);

    const stats = db.getSessionStats(sid);
    assert.ok(stats, "session must exist");
    assert.equal(stats.session_key, null, "session_key defaults to null");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/openclaw-plugin-hooks.test.ts -t "session_key support"`
Expected: FAIL — `ensureSession` doesn't accept 3rd arg, `SessionMeta` has no `session_key`

- [ ] **Step 3: Update `SessionMeta` interface**

In `src/session/db.ts`, add `session_key` to the interface:

```typescript
export interface SessionMeta {
  session_id: string;
  project_dir: string;
  session_key: string | null;
  started_at: string;
  last_event_at: string | null;
  event_count: number;
  compact_count: number;
}
```

- [ ] **Step 4: Update `CREATE TABLE` and add schema migration in `initSchema()`**

Update the `CREATE TABLE IF NOT EXISTS session_meta` statement to include `session_key` for new installs:

```sql
      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        session_key TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0
      );
```

Then add migration for existing DBs (after the CREATE TABLE block):

```typescript
    // ── Migration: add session_key column for existing DBs ──
    try {
      const cols = this.db.pragma("table_info(session_meta)") as Array<{ name: string }>;
      if (!cols.some(c => c.name === "session_key")) {
        this.db.exec(`
          ALTER TABLE session_meta ADD COLUMN session_key TEXT;
        `);
      }
    } catch { /* best effort */ }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_meta_session_key ON session_meta(session_key);
    `);
```

- [ ] **Step 5: Update `ensureSession` prepared statement to include `session_key`**

In `prepareStatements()`, change the `ensureSession` statement:

```typescript
    p(S.ensureSession,
      `INSERT OR IGNORE INTO session_meta (session_id, project_dir, session_key) VALUES (?, ?, ?)`);
```

- [ ] **Step 6: Update `getSessionStats` prepared statement to include `session_key`**

```typescript
    p(S.getSessionStats,
      `SELECT session_id, project_dir, session_key, started_at, last_event_at, event_count, compact_count
       FROM session_meta WHERE session_id = ?`);
```

- [ ] **Step 7: Update `ensureSession` method signature**

```typescript
  ensureSession(sessionId: string, projectDir: string, sessionKey?: string): void {
    this.stmt(S.ensureSession).run(sessionId, projectDir, sessionKey ?? null);
  }
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/openclaw-plugin-hooks.test.ts -t "session_key support"`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/session/db.ts tests/openclaw-plugin-hooks.test.ts
git commit -m "feat(db): add session_key column to session_meta for multi-agent isolation"
```

---

### Task 2: Update `getMostRecentSession` to query by `sessionKey`

**Files:**
- Modify: `src/session/db.ts:252-254` (prepared statement)
- Modify: `src/session/db.ts:404-407` (method)

- [ ] **Step 1: Write failing test — `getMostRecentSession` scoped by `sessionKey`**

Update the existing `SessionDB.getMostRecentSession` describe block in `tests/openclaw-plugin-hooks.test.ts`. Replace the three existing tests with sessionKey-based versions:

```typescript
describe("SessionDB.getMostRecentSession", () => {
  test("returns null when no sessions exist for sessionKey", () => {
    const db = createTestDB();
    const result = db.getMostRecentSession("no-such-key");
    assert.equal(result, null);
  });

  test("returns session_id scoped by sessionKey", () => {
    const db = createTestDB();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const keyA = "agent-a:telegram:111";
    const keyB = "agent-b:telegram:222";
    const sidA = randomUUID();
    const sidB = randomUUID();

    db.ensureSession(sidA, projectDir, keyA);
    db.ensureSession(sidB, projectDir, keyB);

    assert.equal(db.getMostRecentSession(keyA), sidA);
    assert.equal(db.getMostRecentSession(keyB), sidB);
  });

  test("returns most recent session when multiple exist for same sessionKey", () => {
    const db = createTestDB();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const key = "agent-a:telegram:111";
    const sid1 = randomUUID();
    const sid2 = randomUUID();

    db.ensureSession(sid1, projectDir, key);
    db.ensureSession(sid2, projectDir, key);

    const result = db.getMostRecentSession(key);
    // Both have sub-second timestamps from DEFAULT (datetime('now')),
    // but sid2 was inserted last so ORDER BY started_at DESC, rowid DESC returns sid2
    assert.equal(result, sid2, "must return the most recently inserted session");
  });

  test("ignores sessions with different sessionKey", () => {
    const db = createTestDB();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const sidA = randomUUID();
    const sidB = randomUUID();

    db.ensureSession(sidA, projectDir, "agent-a:telegram:111");
    db.ensureSession(sidB, projectDir, "agent-b:telegram:222");

    assert.equal(db.getMostRecentSession("agent-a:telegram:111"), sidA);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/openclaw-plugin-hooks.test.ts -t "getMostRecentSession"`
Expected: FAIL — `getMostRecentSession` still queries by `project_dir`

- [ ] **Step 3: Update prepared statement**

In `prepareStatements()`:

```typescript
    p(S.getMostRecentSession,
      `SELECT session_id FROM session_meta WHERE session_key = ?
       ORDER BY started_at DESC, rowid DESC LIMIT 1`);
```

- [ ] **Step 4: Update method signature (rename param for clarity)**

```typescript
  getMostRecentSession(sessionKey: string): string | null {
    const row = this.stmt(S.getMostRecentSession).get(sessionKey) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/openclaw-plugin-hooks.test.ts -t "getMostRecentSession"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/session/db.ts tests/openclaw-plugin-hooks.test.ts
git commit -m "feat(db): scope getMostRecentSession by sessionKey instead of projectDir"
```

---

## Chunk 2: Plugin Integration

### Task 3: Update `SessionStartEvent` interface and `session_start` handler

**Files:**
- Modify: `src/openclaw-plugin.ts:106-110` (SessionStartEvent interface)
- Modify: `src/openclaw-plugin.ts:188-210` (register — init section)
- Modify: `src/openclaw-plugin.ts:407-423` (session_start handler)

- [ ] **Step 1: Write failing test — `session_start` with `sessionKey` creates isolated session**

Add a new test to the `end-to-end flow` describe block in `tests/openclaw-plugin.test.ts`:

```typescript
    it("session_start with sessionKey isolates sessions per agent", async () => {
      // Agent A
      const mockA = await createTestPlugin(join(tempDir, "iso-agent-a"));
      const sessionStartA = mockA.lifecycle.find((h) => h.event === "session_start");
      const afterHookA = mockA.lifecycle.find((h) => h.event === "after_tool_call");
      const engineA = mockA.contextEngines[0].factory();

      const sidA = randomUUID();
      await sessionStartA!.handler({ sessionId: sidA, sessionKey: "agent-a:telegram:111" });

      await afterHookA!.handler({
        toolName: "Read",
        params: { file_path: "/a.ts" },
        output: "agent A content",
      });

      // Agent B (same project dir via env)
      const mockB = await createTestPlugin(join(tempDir, "iso-agent-a")); // same dir!
      const sessionStartB = mockB.lifecycle.find((h) => h.event === "session_start");
      const engineB = mockB.contextEngines[0].factory();

      const sidB = randomUUID();
      await sessionStartB!.handler({ sessionId: sidB, sessionKey: "agent-b:telegram:222" });

      // Agent B has no events — isolated from Agent A
      const resultB = await engineB.compact();
      expect(resultB.compacted).toBe(false);

      // Agent A still has its events
      const resultA = await engineA.compact();
      expect(resultA.compacted).toBe(true);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/openclaw-plugin.test.ts -t "sessionKey isolates"`
Expected: FAIL — current handler ignores `sessionKey`

- [ ] **Step 3: Update `SessionStartEvent` interface**

In `src/openclaw-plugin.ts`:

```typescript
interface SessionStartEvent {
  sessionId?: string;
  sessionKey?: string;
  resumedFrom?: string;
  agentId?: string;      // keep for future use
  startedAt?: string;
}
```

- [ ] **Step 4: Remove `getMostRecentSession` from `register()` init**

Replace the init block (around lines 206-210):

```typescript
    // Initialize session synchronously (SessionDB constructor is sync)
    const db = new SessionDB({ dbPath: getDBPath(projectDir) });
    db.cleanupOldSessions(7);
    // Start with temp UUID — session_start will assign the real ID + sessionKey
    let sessionId = randomUUID();
    let resumeInjected = false;
    // Create temp session so after_tool_call events before session_start have a valid row
    db.ensureSession(sessionId, projectDir);
```

Keep `db.ensureSession(sessionId, projectDir)` so that `after_tool_call` events arriving before `session_start` still have a valid session_meta row to write to. The temp session will be renamed or replaced when `session_start` fires.

- [ ] **Step 5: Update `session_start` handler**

Replace the handler body:

```typescript
    api.on(
      "session_start",
      async (event: unknown) => {
        try {
          const e = event as SessionStartEvent;
          const sid = e?.sessionId;
          if (!sid) return;

          const key = e?.sessionKey;
          if (key) {
            // Per-agent session lookup via sessionKey
            const prevId = db.getMostRecentSession(key);
            if (prevId && prevId !== sid) {
              db.renameSession(prevId, sid);
              log.info(`session re-keyed ${prevId.slice(0, 8)}… → ${sid.slice(0, 8)}… (key=${key})`);
            } else if (!prevId) {
              db.ensureSession(sid, projectDir, key);
              log.info(`new session ${sid.slice(0, 8)}… (key=${key})`);
            }
          } else {
            // Fallback: no sessionKey → fresh session (Option A)
            db.ensureSession(sid, projectDir);
            log.info(`session ${sid.slice(0, 8)}… (no sessionKey — fallback)`);
          }

          sessionId = sid;
          resumeInjected = false;
        } catch {
          // best effort — never break session start
        }
      },
    );
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/openclaw-plugin.test.ts -t "sessionKey isolates"`
Expected: PASS

- [ ] **Step 7: Update existing tests for new `session_start` behavior**

In `tests/openclaw-plugin-hooks.test.ts`, find existing `session_start` tests that call:
```typescript
await sessionStartHandler({ sessionId: randomUUID() });
```
Update each to also include `sessionKey`:
```typescript
await sessionStartHandler({ sessionId: randomUUID(), sessionKey: "test:agent:1" });
```
This affects tests in: `session_start hook`, `resume injection`, and `verbose logging` describe blocks.

Update the e2e `"events survive session_start re-key (renameSession)"` test in `tests/openclaw-plugin.test.ts`:

```typescript
    it("events survive session_start re-key (renameSession)", async () => {
      const mock = await createTestPlugin(join(tempDir, "e2e-rekey"));
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");
      const sessionStartHook = mock.lifecycle.find((h) => h.event === "session_start");
      const engine = mock.contextEngines[0].factory();

      const sessionKey = "test:rekey:agent";

      // First session_start — creates session in DB
      const firstSid = randomUUID();
      await sessionStartHook!.handler({ sessionId: firstSid, sessionKey });

      // Insert an event under initial session
      await afterHook!.handler({
        toolName: "Read",
        params: { file_path: "/app/main.ts" },
        output: "console.log('hello')",
      });

      // Simulate gateway restart — new sessionId, same sessionKey
      const newSessionId = randomUUID();
      await sessionStartHook!.handler({ sessionId: newSessionId, sessionKey });

      // Events must survive: compact should find them under newSessionId
      const result = await engine.compact();
      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(true);
    });
```

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run tests/openclaw-plugin.test.ts tests/openclaw-plugin-hooks.test.ts`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add src/openclaw-plugin.ts tests/openclaw-plugin.test.ts tests/openclaw-plugin-hooks.test.ts
git commit -m "feat(openclaw): scope sessions by sessionKey for multi-agent isolation"
```

---

### Task 4: Remove diagnostic logs & add `sessionKey` fallback test

**Files:**
- Modify: `src/openclaw-plugin.ts` (remove DIAGNOSTIC lines)
- Modify: `tests/openclaw-plugin.test.ts` (add fallback test)

- [ ] **Step 1: Write test for `sessionKey` fallback**

Add to `end-to-end flow` in `tests/openclaw-plugin.test.ts`:

```typescript
    it("session_start without sessionKey falls back to fresh session", async () => {
      const mock = await createTestPlugin(join(tempDir, "e2e-fallback"));
      const sessionStartHook = mock.lifecycle.find((h) => h.event === "session_start");
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");
      const engine = mock.contextEngines[0].factory();

      // session_start with no sessionKey
      const sid = randomUUID();
      await sessionStartHook!.handler({ sessionId: sid });

      await afterHook!.handler({
        toolName: "Read",
        params: { file_path: "/app/main.ts" },
        output: "console.log('hello')",
      });

      // Should still work — events captured under sid
      const result = await engine.compact();
      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(true);
    });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/openclaw-plugin.test.ts -t "falls back to fresh"`
Expected: PASS

- [ ] **Step 3: Remove diagnostic log lines from `session_start` handler**

In `src/openclaw-plugin.ts`, remove these two lines from the `session_start` handler:

```typescript
          // DIAGNOSTIC: log full payload to reveal available fields
          log.info("session_start payload keys:", JSON.stringify(Object.keys(event as object)));
          log.info("session_start agentId:", JSON.stringify((event as SessionStartEvent).agentId));
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS (full suite, not just plugin tests)

- [ ] **Step 5: Commit**

```bash
git add src/openclaw-plugin.ts tests/openclaw-plugin.test.ts
git commit -m "feat(openclaw): add sessionKey fallback test, remove diagnostic logs"
```

---

## Chunk 3: Build, Deploy & Verify

### Task 5: Build, deploy, and verify in production

- [ ] **Step 1: Build**

```bash
npm run build
```

Expected: Clean build, no TypeScript errors

- [ ] **Step 2: Clear jiti cache and reload gateway**

```bash
rm -f /tmp/jiti/context-mode-index.*.cjs
kill -USR1 $(pgrep -f openclaw)
```

- [ ] **Step 3: Verify — send `/restart` then `/ctx-stats` in EACH Telegram agent**

Expected: Each agent shows a different session ID and independent event counts.

- [ ] **Step 4: Final commit with version bump (optional)**

```bash
git add -A
git commit -m "chore: multi-agent session isolation complete"
git push
```
