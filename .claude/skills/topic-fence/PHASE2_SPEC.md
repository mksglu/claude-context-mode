# Phase 2 Specification: Drift Scoring

> Status: design approved, implementation pending
> Depends on: Phase 1 (`extractTopicSignal` shipped in `src/session/topic-fence.ts`)
> Branch: `feature/topic-fence`

## Goal

Detect topic drift within an ongoing session by computing Jaccard similarity
across a sliding window of topic events, and emit a `topic_drift` event when
similarity falls below a configurable threshold. The emitted event is a
**detector signal only** — Phase 3 will consume it to render user-facing
notifications, and Phase 2 itself performs no summarization, compaction, or
session-splitting action.

## Non-Goals

- LLM calls, summarization, compaction, session splitting — out of scope per
  `.claude/skills/topic-fence/SKILL.md` and the scope memory
  (`topic_fence_scope.md`). Those belong to a future `topic-handoff` skill.
- User notification rendering — Phase 3.
- Hand-off automation — not in the topic-fence roadmap at all.
- Cross-session drift detection — Phase 2 operates strictly within a single
  `session_id`.

## Why Jaccard (and not something "more modern")

Jaccard similarity (1912) is over a century old. The choice deserves
explicit justification, particularly because more sophisticated
alternatives exist.

**Constraint envelope.** The following constraints eliminate most modern
alternatives before any empirical comparison:

- **Hot-path budget <5ms** — excludes loading any ML model, any network
  call, any native-binary dependency. Eliminates Sentence-BERT, SimCSE,
  E5, WMD, and all embedding-based methods.
- **No new npm dependencies** — excludes libraries that would require
  native bindings across 12 adapter platforms.
- **No cross-session corpus** — each session is isolated. Eliminates
  TF-IDF (which requires a corpus-wide IDF statistic) and BM25.
- **Inputs are pre-tokenized small keyword sets** — each topic event has
  ≤8 keywords, each window has ≤24 keywords. At this scale, MinHash and
  SimHash (which are *approximations* of Jaccard for large-scale data)
  offer no speedup — exact Jaccard is sub-millisecond.
- **Symmetric windows (N=M)** — eliminates the asymmetric-measure
  advantage of Tversky index. Dice-Sørensen is a monotonic transform
  of Jaccard producing identical decisions — no reason to prefer it.

The surviving candidates are: plain Jaccard, Dice (equivalent),
weighted Jaccard, and Overlap coefficient (rejected for structural
bias — returns 1.0 when one set is a subset of the other).

**Empirical validation.** Rather than rely on theoretical arguments,
Phase 2 was validated against a 15-scenario ground-truth corpus
covering six failure-mode categories (`clean_shift`, `no_drift`,
`gradual`, `generic_masking`, `synonymy`, `tangent_return`). Six
variants were evaluated across a threshold sweep:

| Variant                                   | Best F1 |
| ----------------------------------------- | ------- |
| Plain Jaccard (Phase 1 stopwords)         | 0.800   |
| Path A (extended stopwords + stemming)    | 0.818   |
| Path B (session-local IDF)                | 0.800   |
| **Path C (Path A + 2-consecutive rule)**  | **0.900** |
| Path D (2-turn rolling mean)              | 0.900   |
| Path E (3-turn rolling mean)              | 0.900   |

**Path C won at F1 = 0.900 with recall = 1.000.** Full methodology,
per-scenario traces, caveats about corpus size, and Phase 4 follow-up
items are recorded in `VALIDATION_RESULTS.md`. The winning algorithm
is:

1. **Tokenizer** — Phase 1 stopwords plus ~80 generic coding-domain
   filler terms plus a lightweight Porter-inspired stemmer.
2. **Measure** — plain Jaccard (unchanged from original design).
3. **Decision rule** — require TWO consecutive window-pair Jaccard
   scores both below threshold. This filters out one-shot vocabulary
   rotation within stable topics, which empirically was the dominant
   source of false positives.
4. **Default threshold** — `0.10` (not `0.30` as originally proposed).

**The validation falsified two of my original theoretical claims.**
First, the original threshold of `0.30` was empirically wrong — at that
value the detector fires on every user turn, making it useless. Second,
session-local IDF weighting (originally presented as the most promising
refinement) did not improve over plain Path A on this corpus. Both
lessons are preserved here as a caution against relying on theoretical
reasoning without measurement for similarity-threshold calibration.

**Implementation fidelity requirement.** The production tokenizer in
`src/session/topic-fence.ts` MUST match `extractKeywordsPathA` in
`eval-drift.mjs` **byte-for-byte** in terms of: (a) the stopword set
(Phase 1 base + the same `GENERIC_TECH_STOPWORDS` entries), (b) the
stemmer rule list and order, (c) the token length threshold (≥2 chars),
(d) the stem re-check against the extended stopword set, and (e) the
ASCII-only guard on the stemmer (Hangul must pass through unchanged).
Any deviation invalidates the F1=0.900 empirical claim — an implementer
who "improves" the stemmer or "tidies up" the stopword list must re-run
`eval-drift.mjs` and confirm the result before landing the change.

## Design Decisions Summary

All algorithm-layer decisions below are backed by empirical validation
against a 15-scenario ground-truth corpus. Full results, methodology,
and caveats are recorded in `VALIDATION_RESULTS.md` and reproducible via
`node eval-drift.mjs`.

| Dimension                | Decision                                                   |
| ------------------------ | ---------------------------------------------------------- |
| Window shape             | Two adjacent symmetric windows, `N = M = 3`                |
| Minimum history          | **7** topic events total (6 from DB + 1 current)           |
| Cold-start behavior      | Return `[]` — no warm-up mode, no degraded comparison      |
| Cooldown                 | None — algorithmic self-stabilization + DB-layer dedup     |
| **Decision rule**        | **Two consecutive window pairs both below threshold**      |
| **Tokenization**         | **Phase 1 + extended coding stopwords + light stemming**   |
| Integration point        | Optional second parameter on `extractUserEvents()`         |
| Scoring residence        | `scoreDrift()` pure function in `topic-fence.ts`           |
| Hook coupling            | 1 new line in `userpromptsubmit.mjs` (DB query)            |
| Configuration surface    | 3 env vars + 1 kill switch, cached at module load          |
| **Default threshold**    | **`0.10`** Jaccard similarity (drift fires below this)     |
| Rollout strategy         | Default-enabled with `CONTEXT_MODE_TOPIC_FENCE_DISABLED=1` |
| Payload determinism      | Sorted keywords, 2-decimal string score, fixed window key  |
| `topic_drift` priority   | `2` (see §Payload priority rationale below)                |
| DB query ordering        | New `recent: true` option on `SessionDB.getEvents`         |
| Empirical F1 (corpus)    | 0.900 (recall 1.000, precision 0.818)                      |

Rationale for each decision is recorded in the design brainstorming thread and
summarized inline below.

## Architecture

### Module Boundaries

```
hooks/userpromptsubmit.mjs
        │
        ├── db.ts            (getEvents, insertEvent — unchanged)
        └── extract.ts       (extractUserEvents — signature extended)
                │
                └── topic-fence.ts    (scoreDrift — new pure function)
```

The dependency graph is strictly unidirectional. The hook imports `db.ts` and
`extract.ts` (as in Phase 1); `extract.ts` imports `topic-fence.ts` (as in
Phase 1); `topic-fence.ts` imports nothing persistence-related. Phase 2 adds
zero new imports to the hook layer.

### Why This Shape

The upstream author's existing pattern (observed in `snapshot.ts`) is: pure
functions accept already-fetched data and return pure outputs; hooks handle
all I/O. Phase 2 follows that pattern, but also preserves Phase 1's property
that the hook has a **single entry point** into the extract layer
(`extractUserEvents`). Passing `topicHistory` as an optional second parameter
achieves both goals simultaneously — the hook keeps its single call, and
`topic-fence.ts` keeps its purity. See the brainstorming thread for the full
comparison against two rejected alternatives (interface wrapper; DB-coupled
wrapper).

## API Surface

### `src/session/topic-fence.ts` — new exports

```ts
// ── Module-level configuration (cached once at load time) ──
const TOPIC_WINDOW_OLD       = clampInt(process.env.CONTEXT_MODE_TOPIC_WINDOW_OLD,       3,    1, 50);
const TOPIC_WINDOW_NEW       = clampInt(process.env.CONTEXT_MODE_TOPIC_WINDOW_NEW,       3,    1, 50);
const TOPIC_DRIFT_THRESHOLD  = clampFloat(process.env.CONTEXT_MODE_TOPIC_DRIFT_THRESHOLD, 0.10, 0, 1);
const TOPIC_FENCE_DISABLED   = process.env.CONTEXT_MODE_TOPIC_FENCE_DISABLED === "1";

// Extended stopwords: Phase 1 base list plus ~80 generic coding-domain
// filler words. See VALIDATION_RESULTS.md for the empirical motivation.
// The full list is inlined at the top of topic-fence.ts next to STOPWORDS_EN.
const STOPWORDS_EN_EXTENDED = new Set([...STOPWORDS_EN, ...GENERIC_TECH_STOPWORDS]);

/**
 * Minimal structural shape of a stored topic row. Exported so `extract.ts`
 * can reuse the same type in the `extractUserEvents` signature without
 * redeclaring it. `SessionDB.getEvents` returns `StoredEvent[]`, which
 * is structurally a superset of this type, so the hook passes DB rows
 * directly with no cast.
 */
export type TopicHistoryRow = { data: string };

/**
 * Detect topic drift across two adjacent sliding window pairs.
 *
 * Phase 2 requires **two consecutive window-pair Jaccard scores** to both
 * fall below TOPIC_DRIFT_THRESHOLD before emitting a drift event. This
 * "persistence" rule filters out one-shot vocabulary rotation within a
 * stable topic — empirically, stable-topic sessions exhibit isolated
 * single-turn Jaccard dips, while genuine drift exhibits sustained
 * low scores across multiple consecutive turns (see VALIDATION_RESULTS.md).
 *
 * Algorithm (given TOPIC_WINDOW_OLD=N, TOPIC_WINDOW_NEW=M, both default 3):
 *
 *   combined   = [...history, currentTopic]   // length: N + M + 1 = 7 at defaults
 *   prevOld    = combined[0 .. N)
 *   prevNew    = combined[N .. N+M)
 *   currOld    = combined[1 .. N+1)
 *   currNew    = combined[N+1 .. N+M+1)
 *   prevScore  = jaccard(union(prevOld), union(prevNew))
 *   currScore  = jaccard(union(currOld), union(currNew))
 *
 *   if (prevScore < THRESHOLD && currScore < THRESHOLD)
 *       → emit topic_drift event
 *   else
 *       → return []
 *
 * Returns [] in all of: cold start (history.length < N + M), kill switch,
 * either score above threshold, pathological empty-set fallback.
 *
 * The "pathological empty sets" case: if all keyword sets in a window are
 * empty (e.g. all rows were corrupt JSON), the Jaccard denominator is
 * zero. The implementation treats similarity as `1.0` (maximally similar)
 * in that case, which necessarily exceeds any threshold and produces [].
 * Edge case #5 below refers to the same safe-fallback path.
 *
 * Pure function. Never throws. <1ms per call at N=M=3.
 */
export function scoreDrift(
  history: ReadonlyArray<TopicHistoryRow>,
  currentTopic: SessionEvent,
): SessionEvent[];
```

### `src/session/extract.ts` — signature extension

```ts
import { extractTopicSignal, scoreDrift, type TopicHistoryRow } from "./topic-fence.js";

export function extractUserEvents(
  message: string,
  topicHistory: ReadonlyArray<TopicHistoryRow> = [],
): SessionEvent[] {
  try {
    const events: SessionEvent[] = [];
    events.push(...extractUserDecision(message));
    events.push(...extractRole(message));
    events.push(...extractIntent(message));
    events.push(...extractData(message));

    const topicEvents = extractTopicSignal(message);
    events.push(...topicEvents);

    // Phase 2: drift scoring — only when history provided AND current topic emitted
    if (topicHistory.length > 0 && topicEvents.length > 0) {
      events.push(...scoreDrift(topicHistory, topicEvents[0]));
    }
    return events;
  } catch {
    return [];
  }
}
```

Backward compatibility: the default value `[]` for `topicHistory` means any
existing adapter that calls `extractUserEvents(message)` continues to work
unchanged and simply has drift detection disabled.

### `src/session/db.ts` — `getEvents` gains a `recent` option

The existing `SessionDB.getEvents` method uses `ORDER BY id ASC LIMIT ?`
(`db.ts:221-235`), which returns the **oldest** N rows of a given type — the
opposite of what drift scoring requires. Phase 2 needs the **most recent** N
topic events in chronological order. Two options were considered:

1. Fetch all topic events (bounded by the 1000-event session cap) and slice
   `-N` in the hook. Rejected: wasteful on long sessions, scales poorly.
2. Add a `recent: true` option that flips the SQL ordering. Accepted: small
   structural change, matches the existing pattern of multiple prepared
   statement variants in `db.ts:209-235`.

The required diff in `db.ts`:

```ts
// Add to the S constant
getRecentEventsByType: "getRecentEventsByType",

// Add to prepareStatements()
p(S.getRecentEventsByType,
  `SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
   FROM session_events WHERE session_id = ? AND type = ? ORDER BY id DESC LIMIT ?`);

// Extend getEvents signature and dispatch
getEvents(
  sessionId: string,
  opts?: { type?: string; minPriority?: number; limit?: number; recent?: boolean },
): StoredEvent[] {
  // ... existing branches ...
  if (type && opts?.recent) {
    const rows = this.stmt(S.getRecentEventsByType).all(sessionId, type, limit) as StoredEvent[];
    return rows.reverse(); // restore chronological (id ASC) order for downstream consumers
  }
  // ... rest unchanged ...
}
```

The reverse-after-fetch step ensures callers always receive events in
chronological order regardless of the `recent` flag. Existing callers
(which omit `recent`) are unaffected.

### `hooks/userpromptsubmit.mjs` — minimal glue

```js
// Phase 2: query the most recent (N+M) topic events for drift scoring.
// Note: the 2-consecutive-window rule requires N+M historical events
// (not N+M-1) so that two adjacent window pairs can both be computed.
const historySize = 6; // = TOPIC_WINDOW_OLD + TOPIC_WINDOW_NEW under defaults
const recentTopics = db.getEvents(sessionId, {
  type: "topic",
  limit: historySize,
  recent: true,
});
const userEvents = extractUserEvents(trimmed, recentTopics);
for (const ev of userEvents) {
  db.insertEvent(sessionId, ev, "UserPromptSubmit");
}
```

Exactly one new variable + one new option key (`recent: true`) relative
to Phase 1. The existing insert loop handles the new `topic_drift` event
with no special casing. The `historySize = 6` constant matches the
shipped `TOPIC_WINDOW_OLD + TOPIC_WINDOW_NEW = 6`. If users raise the
window sizes via env vars beyond the defaults, drift scoring remains in
cold-start mode until enough history accumulates — graceful degradation,
no crash.

## Data Flow

### Normal case trace

Assume SessionDB contains 6 prior `topic` events (`t1..t6`) and the user
submits a 7th topic-bearing message.

1. Hook: `db.getEvents(sessionId, {type:"topic", limit:6, recent:true})`
   → `[t1, t2, t3, t4, t5, t6]` (chronological order)
2. Hook: calls `extractUserEvents(message, [t1..t6])`
3. `extract.ts`: Phase 1 extractors run; `extractTopicSignal(message)` emits `t7`
4. `extract.ts`: condition satisfied, calls `scoreDrift([t1..t6], t7)`
5. `topic-fence.ts`: `combined = [t1..t6, t7]` (7 topic events)
6. `topic-fence.ts` computes **two** adjacent window pairs:
   - `prevOld = [t1, t2, t3]`, `prevNew = [t4, t5, t6]` → `prevScore`
   - `currOld = [t2, t3, t4]`, `currNew = [t5, t6, t7]` → `currScore`
7. For each pair: keyword union per window, then Jaccard `J = |A∩B| / |A∪B|`
8. If `prevScore < THRESHOLD && currScore < THRESHOLD` → emit 1 `topic_drift`
   event; otherwise `[]`
9. `extract.ts`: returns `[..., t7, drift?]`
10. Hook: inserts all returned events via `db.insertEvent`

Total new hot-path work: one DB query (already indexed by
`idx_session_events_type`), two Jaccard computations over ≤48 keywords
each, one JSON stringify. Combined cost still well under the 5 ms budget.

### Why two window pairs

Requiring two consecutive sub-threshold scores filters out one-shot
vocabulary rotation within a stable topic — empirically the dominant
source of false positives. The `prev` window pair corresponds to "the
drift score that would have been computed on the previous user turn";
the `curr` window pair is "the drift score for the current user turn".
Both must be low for the detector to fire. This is computed statelessly
at each call — no per-turn state persists.

## `topic_drift` Event Schema

```json
{
  "type": "topic_drift",
  "category": "topic",
  "data": "{\"prev_score\":\"0.07\",\"curr_score\":\"0.03\",\"old\":[\"auth\",\"jwt\",\"login\"],\"new\":[\"hooks\",\"react\",\"state\"],\"window\":[3,3]}",
  "priority": 2
}
```

The payload records **both** window-pair scores (`prev_score`, `curr_score`)
so Phase 3 can surface the evidence that "drift was sustained across two
consecutive turns" rather than "drift was a single-turn spike". The `old`
and `new` keyword arrays correspond to the CURRENT window pair
(`currOld`, `currNew`).

### Payload priority rationale

`topic_drift` carries `priority: 2`, one level higher than the raw `topic`
events it derives from (`priority: 3`, set in Phase 1 at `topic-fence.ts:98`).
The reasoning: raw topic events are fine-grained bookkeeping that can tolerate
FIFO eviction under memory pressure, but a `topic_drift` event represents
an *actionable* signal that Phase 3 will surface to the user. Losing a
drift event to eviction would silently drop the very thing topic-fence
exists to produce. Priority 2 matches the treatment of other user-facing
decision events (`extract.ts:526` — `decision` category) and guarantees
survival through normal eviction pressure.

### Payload determinism rules

These rules exist so the DB-layer deduplication (`(type, data_hash)` over the
last 5 events — see `db.ts:240-246`) can absorb identical drift events that
might arise from retries or reinvocations.

- **Scores** — both `prev_score` and `curr_score` are formatted as
  `value.toFixed(2)` and stored as **strings**. Floating-point noise is
  absorbed at the second decimal place.
- **Keywords** — both `old` and `new` arrays are sorted lexicographically
  before serialization.
- **Window** — stored as a literal 2-element array `[N, M]` matching the
  values actually used for the computation (not the env-var defaults).
- **No timestamps, no random IDs, no session identifiers** — those would
  defeat the dedup hash.

## Configuration

Four environment variables, all read once at module load and cached.
Defaults and validation rules:

| Variable                                   | Default  | Range         | Parser          |
| ------------------------------------------ | -------- | ------------- | --------------- |
| `CONTEXT_MODE_TOPIC_WINDOW_OLD`            | `3`      | `[1, 50]`     | `clampInt`      |
| `CONTEXT_MODE_TOPIC_WINDOW_NEW`            | `3`      | `[1, 50]`     | `clampInt`      |
| `CONTEXT_MODE_TOPIC_DRIFT_THRESHOLD`       | **`0.10`** | `[0.0, 1.0]` | `clampFloat`    |
| `CONTEXT_MODE_TOPIC_FENCE_DISABLED`        | *unset*  | `"1"` or unset | strict equality |

`clampInt` / `clampFloat` return the default value on any of: `undefined`,
`NaN`, non-numeric string, out-of-range value. Invalid input is silently
normalized — no startup warnings, no exceptions. This matches the "never
block the session" contract of the hook layer.

### Default threshold justification

The default threshold of `0.10` was selected empirically via threshold
sweep across the validation corpus. See `VALIDATION_RESULTS.md` for the
full sweep table. The key finding: a threshold of `0.30` (the original
spec's value, chosen theoretically) triggers drift on essentially every
user turn because single-turn Jaccard scores naturally range in
`[0.03, 0.25]` even within stable topics due to vocabulary rotation.
A threshold of `0.10` combined with the 2-consecutive-turn rule yields
F1 = 0.900 on the validation corpus (recall 1.000, precision 0.818).

Jaccard `< 0.10` means more than 90% of the keyword union is exclusive
to one window within a single turn AND the same condition held on the
previous turn — a sustained substantial vocabulary shift. The value is
calibrated toward keeping recall at 1.0 (no missed drifts) while
accepting ~18% false positive rate, which is within the "fence, not
wall" tolerance. This default should be re-evaluated against real
topic event data in Phase 4 using ROC analysis on a larger corpus.

## Edge Cases

1. **Cold start** (`history.length < TOPIC_WINDOW_OLD + TOPIC_WINDOW_NEW`):
   `scoreDrift` returns `[]`. No special notification; Phase 1 continues
   accumulating topic events. With default config (`N=M=3`) this is
   `history.length < 6`, meaning the first drift firing is possible on
   the 7th topic-bearing user turn. If an operator raises either window
   via env var, the cold-start threshold adapts automatically — no code
   change needed.
2. **Current message has no topic** (`extractTopicSignal` returns `[]`):
   `extract.ts` skips the `scoreDrift` call. No drift is evaluated on turns
   that produced no topic signal. This correctly distinguishes "content
   drift" from "content density".
3. **Drift firing twice in a row**: prevented by the algorithmic
   self-stabilization property (window boundary shifts by one **topic event**
   per topic-bearing turn, so within 3 topic-bearing turns the old window
   absorbs the new topic's vocabulary and Jaccard recovers). Note: turns
   that produce no topic signal (edge case #2) do not advance the window —
   in an unusual session where the user sends many short messages after a
   drift, re-firing could be delayed beyond 3 wall-clock turns.
   **Additional caveat**: the 3-turn recovery claim assumes the new drifted
   topic's vocabulary remains *stable* across those 3 turns. Rapid
   oscillation between two topics (A → B → A → B) could cause repeated
   drift events because each "return" to the previous vocabulary produces
   a genuine distributional shift. In that pathological case, DB-layer
   dedup serves as defense-in-depth against exact-duplicate drift
   payloads, but distinct drift events with different keyword sets *will*
   be emitted — which is arguably the correct behavior for a detector.
   Cooldown remains explicitly out of scope per Q3 of the design thread.
4. **Corrupted topic data** (`JSON.parse` throws on a history row OR on the
   `currentTopic.data`): `scoreDrift` catches per-row and treats the
   malformed entry as an **empty keyword set**. This applies uniformly to
   history rows AND to the current topic — if both windows degenerate to
   empty sets, edge case #5 takes over. No exception propagates. Other
   rows contribute normally.
5. **Both windows have zero keywords** (pathological — all history rows
   corrupted): Jaccard denominator would be zero. Guard: treat similarity as
   `1.0` (no drift) and return `[]`. Safe-fallback to silence.
6. **Kill switch** (`CONTEXT_MODE_TOPIC_FENCE_DISABLED=1`): `scoreDrift`
   returns `[]` immediately. **Phase 1 topic extraction continues normally.**
   This asymmetry is deliberate — it means re-enabling the kill switch does
   not require a warm-up period because history is already populated.
7. **FIFO eviction gaps**: `session_events` has a 1000-event cap and
   priority-3 topic events are eligible for eviction.
   `getEvents(..., {limit: 6, recent: true})` returns only the rows that
   still exist; temporal ordering is preserved; the algorithm handles
   gaps naturally with no special logic (two consecutive-turn window
   pairs are still constructible from whatever 6 rows the query returns).

## Error Handling Philosophy

- `scoreDrift` never throws. All internal operations (JSON parse, Jaccard
  arithmetic, payload stringify) are wrapped or guarded so that any
  unexpected failure produces `[]` rather than an exception.
- `extractUserEvents` retains its Phase 1 outermost `try/catch` returning
  `[]` on any failure.
- The hook (`userpromptsubmit.mjs`) retains its outermost `try/catch`
  returning silently on any failure (`userpromptsubmit.mjs:21, 59`).
- Net effect: Phase 2 can fail in arbitrary ways without ever blocking a
  user prompt. The worst observable failure mode is "no drift warnings in
  this session," which is acceptable for a background signal.

## Testing Strategy

### Locations

| File                                         | Scope                                        |
| -------------------------------------------- | -------------------------------------------- |
| `tests/session/topic-fence-drift.test.ts`    | `scoreDrift` unit tests (new file)           |
| `tests/session/session-extract.test.ts`      | `extractUserEvents(message, history)` (extend) |

No new hook-level smoke tests. The existing hook-bundle tests have a known
pre-existing failure mode without `npm run build` (`tooling.md`); adding more
such tests would compound noise. Phase 2's core logic is pure and fully
testable without the hook bundle.

### Unit test matrix (`scoreDrift`)

Numbering prefix `U` to distinguish from integration tests (`I`).

| #   | Input                                                                 | Expected                                             |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| U1  | `history.length < N + M` (default config: `< 6`)                      | `[]` (cold start)                                    |
| U2  | Clean topic shift, both prev and curr windows below 0.10              | 1 drift event with both `prev_score` and `curr_score` < 0.10 |
| U3  | Same topic repeated across all windows                                | `[]` (scores above threshold)                        |
| U4  | Partial overlap (~50% shared keywords)                                | `[]` (above threshold)                               |
| U5  | **Single-turn dip** — prev above threshold, curr below                | `[]` (persistence rule rejects one-shot dip)         |
| U6  | **Reverse single-turn dip** — prev below, curr above                  | `[]` (persistence rule rejects one-shot dip)         |
| U7  | One history row corrupted (`"data":"not-json"`)                       | Processed normally; corrupted row = empty set        |
| U8  | All history rows corrupted                                            | `[]` (empty-union safety fallback)                   |
| U9  | `CONTEXT_MODE_TOPIC_FENCE_DISABLED=1` (via `vi.stubEnv`)              | `[]` returned immediately                            |
| U10 | Determinism — identical inputs invoked twice                          | Byte-identical payload strings                       |
| U11 | Schema shape assertion — sorted keys, 2-decimal prev/curr, window     | Explicit assertions on payload JSON                  |
| U12 | Extended stopwords effect — session heavy on `function`/`test`/`run`  | Those tokens dropped before Jaccard computation      |
| U13 | Stemmer effect — `testing`, `tested`, `tests` collapse                | All three contribute to the same keyword             |

### Integration test matrix (`extractUserEvents`)

| #  | Input                                                                | Expected                                             |
| -- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| I1 | `extractUserEvents("implementing auth")` (no history arg)            | Identical to Phase 1 output (backward compat)        |
| I2 | Topic shift message + **6-row history** (see construction note)      | Result contains both `topic` and `topic_drift`       |
| I3 | Short message `"yes"` + 6-row history                                | No `topic_drift` (no current topic)                  |
| I4 | Topic message + history with 5 rows or fewer                         | Only `topic`; no `topic_drift` (cold start)          |
| I5 | Topic message + empty history `[]`                                   | Only `topic`; no `topic_drift` (default parameter)   |

**Construction note for I2**: the 2-consecutive-pair rule requires
**both** `prevScore` and `currScore` to fall below threshold. Populate
the 6-row history with two disjoint topic vocabularies in positions 1-3
and 4-6 (so that `prevOld = [1,2,3]` and `prevNew = [4,5,6]` have
near-zero Jaccard), then supply a 7th message whose vocabulary matches
positions 4-6 but differs from positions 2-4 (so that `currOld = [2,3,4]`
and `currNew = [5,6,7]` also have low Jaccard). This is a non-trivial
setup — getting it wrong will silently produce I4-like cold-start output.

### Env-var testing pattern

Because constants are cached at module load, env-var tests must reload the
module with `vi.resetModules()`. **Important:** the re-import must target
`topic-fence.ts` *directly*, not `extract.ts`. Since `extract.ts` imports
`topic-fence.ts` statically, a test that does `vi.resetModules()` and then
re-imports `extract.ts` will still get the originally-cached `topic-fence`
constants unless `extract.ts` itself is also re-imported (and even then, the
static import chain makes this fragile). Tests that exercise env-var
overrides should therefore target `scoreDrift` directly:

```ts
import { vi, afterEach } from "vitest";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it("respects custom window sizes", async () => {
  vi.stubEnv("CONTEXT_MODE_TOPIC_WINDOW_OLD", "2");
  const { scoreDrift } = await import("../../src/session/topic-fence.js");
  // assertions against scoreDrift only
});
```

Integration tests against `extractUserEvents` should use the **default**
env-var configuration and rely on handcrafted input data to exercise drift
behavior — they verify that the plumbing is wired correctly, not that env
vars are respected.

### Verification commands

```bash
npx vitest run tests/session/topic-fence-drift.test.ts
npx vitest run tests/session/session-extract.test.ts
npm run typecheck
```

Full `npx vitest run` is **not** used as the regression gate, because the
pre-existing hook-bundle failures produce noise unrelated to Phase 2
(`tooling.md`).

### Coverage target

All six branches of `scoreDrift` covered: cold start, kill switch, corrupted
data, empty-union safety fallback, drift above threshold, drift below
threshold. Env-var override path covered by at least one test.

## What Comes Next (Phase 3 Preview)

Phase 3 will consume the `topic_drift` events emitted here. Per the
topic-fence scope memory (`topic_fence_scope.md`) and the Phase 3
description in `.claude/skills/topic-fence/SKILL.md`, Phase 3 is
**user notification only** — any form of summarization, compaction, or
session-splitting automation belongs to a separate future `topic-handoff`
skill and is explicitly out of scope here.

The planned Phase 3 surface is:

1. `hooks/userpromptsubmit.mjs` checks for recent unacknowledged drift
   events and prepends a `<topic_drift>` notice to the hook's stdout,
   which Claude Code injects as additional context for the next turn.
   This is a pure read-and-display operation — no state mutation beyond
   marking the drift event as acknowledged.
2. `snapshot.ts` gains a `buildTopicDriftSection` that lists recent drift
   events in the compact resume snapshot. This is a read-only surface;
   it does not modify the snapshot's existing event classification logic.
3. Message format: a single line suggesting the user consider starting a
   new session (e.g., *"Topic has shifted. Consider starting a new
   session."*). No blocking, no compaction, no LLM summarization — the
   scope boundary stays firm.

Phase 4 will introduce tests and documentation, and use accumulated real
topic/drift event data to re-tune the three configuration defaults via
ROC analysis.
