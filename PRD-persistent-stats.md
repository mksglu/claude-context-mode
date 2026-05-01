# PRD: Persistent Project Memory in ctx_stats

## Problem

After compact, stats show "no savings yet" — user feels value is lost. But 1,656 events across 6 sessions ARE persistent and searchable. Stats doesn't show this.

## Design: Two mockups with REAL data

### Mockup A — Fresh session (after compact, no runtime savings)

```
context-mode -- session (19h 50m)

1 tool call  |  11.2 KB in context  |  no savings yet

── project memory ──────────────────────────────────────
1.7K events across 6 sessions  ·  survives compact & restart

  Files tracked       752   ████████████████████░░░░░░░░░░
  Prompts saved       250   ███████░░░░░░░░░░░░░░░░░░░░░░░
  Delegated work      202   █████░░░░░░░░░░░░░░░░░░░░░░░░░
  Git operations      155   ████░░░░░░░░░░░░░░░░░░░░░░░░░░
  Project rules       152   ████░░░░░░░░░░░░░░░░░░░░░░░░░░
  Errors caught        61   ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░
  Decisions            27   █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

v1.0.89
```

### Mockup B — Active session (savings + persistent)

```
12.5K tokens saved  ·  87.3% reduction  ·  2h 15m

Without context-mode  |████████████████████████████████████████| 96.2 KB
With context-mode     |█████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░| 12.2 KB

84.0 KB kept out of your conversation. Never entered context.

23 calls  ·  4 cache hits (+12.5 KB)

  batch_execute              8 calls    52.3 KB saved
  execute                    6 calls    18.7 KB saved
  search                     9 calls     8.2 KB saved

── project memory ──────────────────────────────────────
1.7K events across 6 sessions  ·  survives compact & restart

  752 files  ·  250 prompts  ·  202 delegated  ·  155 git ops  ·  61 errors

v1.0.89
```

### Mockup C — No persistent data (first session ever)

```
context-mode -- session (5 min)

No tool calls yet. Use batch_execute or execute to start saving tokens.

v1.0.89
```

## Design Decisions

1. **"project memory" section** — always visible when persistent data exists, regardless of runtime savings
2. **Fresh session: expanded view** — bars show category distribution (user has NO runtime savings to look at, so project memory IS the value)
3. **Active session: compact view** — one-line summary (runtime savings is the hero, project memory is supporting)
4. **"survives compact & restart"** — the value proposition in 4 words
5. **Session count** — "6 sessions" proves longevity/accumulated value
6. **No bars in active mode** — avoid visual competition with the Before/After savings bars

## Implementation

### Changes needed

1. **`analytics.ts` — FullReport interface**: Add `projectMemory` field
   ```typescript
   projectMemory?: {
     total_events: number;
     session_count: number;
     by_category: Array<{ category: string; count: number; label: string }>;
   };
   ```

2. **`analytics.ts` — queryAll()`**: Add project-wide query (no session_id filter)
   ```typescript
   // Project-wide stats (persistent across all sessions)
   const projectTotal = this.db.prepare(
     "SELECT COUNT(*) as cnt FROM session_events"
   ).get() as { cnt: number };
   
   const projectSessions = this.db.prepare(
     "SELECT COUNT(DISTINCT session_id) as cnt FROM session_events"
   ).get() as { cnt: number };
   
   const projectByCategory = this.db.prepare(
     "SELECT category, COUNT(*) as cnt FROM session_events GROUP BY category ORDER BY cnt DESC"
   ).all() as Array<{ category: string; cnt: number }>;
   ```

3. **`analytics.ts` — formatReport()`**: Render "project memory" section
   - If `projectMemory.total_events > 0`: show section
   - If runtime savings active: one-line compact summary
   - If no runtime savings: expanded bars view

4. **`server.ts`**: No changes needed — already opens SessionDB and passes to AnalyticsEngine

### Edge case: Multiple DB files per project

Current server.ts opens ONE SessionDB (current session). For true project-wide totals, need to scan all `<projectHash>*.db` files. Two options:

- **Option A (simple)**: Query current DB only — shows events from sessions that share this DB file
- **Option B (complete)**: Scan all project DBs, aggregate — shows true project-wide totals

Recommend **Option A** for v1 — covers 95% of value (main DB has 1,578 of 1,656 events). Option B as follow-up.
