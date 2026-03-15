# Multi-Agent Session Isolation

**Date:** 2026-03-14
**Status:** Approved

## Problem

When multiple OpenClaw agents share the same project directory (`OPENCLAW_PROJECT_DIR`), they collide on a single context-mode session:

1. `register()` calls `getMostRecentSession(projectDir)` — both agents get the same row
2. `session_start` fires for each agent with a different `sessionId`, but `renameSession(oldId, newSid)` causes the second agent to rename an already-renamed session
3. `after_tool_call` writes to a shared `sessionId` closure variable — events from both agents interleave
4. `/ctx-stats` shows combined counts from both agents

## Key Discovery

The `session_start` event payload (confirmed from OpenClaw bundle `buildSessionStartHookPayload`):

```typescript
event: {
  sessionId: string;   // volatile UUID — new each gateway restart
  sessionKey: string;  // stable per agent/channel (e.g. "divorcebot:telegram:799119510")
  resumedFrom?: string; // previous sessionId if resuming
}
```

`sessionKey` is **stable across gateway restarts** and **unique per agent/channel combination**. This is the discriminator.

## Design

### Approach: `sessionKey`-scoped sessions (Option B with `sessionKey`)

**DB file layout** — unchanged. One SQLite file per project (keyed by `hash(projectDir)`). Session isolation happens at the row level via a new `session_key` column.

### Schema Change

Add `session_key TEXT` column to `session_meta` table:

```sql
ALTER TABLE session_meta ADD COLUMN session_key TEXT;
CREATE INDEX IF NOT EXISTS idx_session_meta_session_key ON session_meta(session_key);
```

Migration: existing rows get `session_key = NULL` (treated as legacy/unscoped).

### `register()` Changes

**Before:**
```typescript
let sessionId = db.getMostRecentSession(projectDir) ?? randomUUID();
db.ensureSession(sessionId, projectDir);
```

**After:**
```typescript
let sessionId = randomUUID();
// Don't create a session yet — wait for session_start to provide sessionKey
```

No DB lookup at init time. The temp UUID is a placeholder until `session_start` fires.

### `session_start` Handler Changes

**Before:**
```typescript
if (e?.sessionId && e.sessionId !== sessionId) {
  db.renameSession(sessionId, e.sessionId);
  sessionId = e.sessionId;
}
```

**After:**
```typescript
const key = e?.sessionKey;
const sid = e?.sessionId;
if (!sid) return;

if (key) {
  // Per-agent session lookup
  const prevId = db.getMostRecentSession(key);
  if (prevId && prevId !== sid) {
    db.renameSession(prevId, sid);
  } else {
    db.ensureSession(sid, projectDir, key);
  }
} else {
  // Fallback: no sessionKey → fresh session (Option A)
  db.ensureSession(sid, projectDir);
}
sessionId = sid;
```

### `SessionDB` Changes

- `getMostRecentSession(sessionKey: string)` — query `WHERE session_key = ?` instead of `WHERE project_dir = ?`
- `ensureSession(id, projectDir, sessionKey?)` — store `session_key` in `session_meta`
- Schema migration: add `session_key` column + index on first access

### Known Limitation

`after_tool_call` hooks receive no session/agent context from OpenClaw. Events write to the `sessionId` closure variable (last agent whose `session_start` fired). For concurrent agents, events could land in the wrong session. In practice (sequential Telegram replies), this is safe. A future OpenClaw API change adding `sessionKey` to tool call events would fix this fully.

### Fallback Behavior

If `sessionKey` is absent in `session_start`:
- Start a fresh session with `e.sessionId`
- No cross-restart continuity (Option A behavior)
- No risk of session pollution

## Files to Change

| File | Change |
|------|--------|
| `src/session/db.ts` | Add `session_key` column, update `getMostRecentSession`, update `ensureSession` |
| `src/openclaw-plugin.ts` | Remove `getMostRecentSession` from `register()`, update `session_start` handler, update `SessionStartEvent` interface, remove diagnostic logs |
| `tests/openclaw-plugin.test.ts` | Update tests for new `session_start` behavior with `sessionKey` |
| `tests/openclaw-plugin-hooks.test.ts` | Update `getMostRecentSession` tests to use `sessionKey` |

## Test Plan

- [ ] Two agents with different `sessionKey` values get separate sessions in same DB
- [ ] Gateway restart: agent reconnects to previous session via `sessionKey` lookup
- [ ] Missing `sessionKey`: falls back to fresh session (no crash, no pollution)
- [ ] `/ctx-stats` shows per-agent event counts after isolation
- [ ] Existing sessions without `session_key` column migrate cleanly (NULL treated as unscoped)
