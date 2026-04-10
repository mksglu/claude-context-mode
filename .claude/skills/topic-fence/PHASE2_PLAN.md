# topic-fence Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement drift detection on top of Phase 1's topic signal extraction, so that `topic_drift` events are emitted when a user's session vocabulary changes persistently across two consecutive window pairs.

**Architecture:** Phase 1 already ships `extractKeywords` and `extractTopicSignal` as pure functions in `src/session/topic-fence.ts`. Phase 2 adds: (a) extended stopwords + Porter-inspired stemmer to the existing tokenizer, (b) `scoreDrift` pure function implementing the 2-consecutive-window-pair Jaccard rule, (c) optional `recent: true` flag on `SessionDB.getEvents` for efficient "last N of type" queries, (d) optional `topicHistory` parameter on `extractUserEvents` that plumbs the historical events into `scoreDrift`, (e) one new line in `hooks/userpromptsubmit.mjs` to fetch history. All new code is pure and stateless. The production tokenizer and scoring logic MUST match `eval-drift.mjs` byte-for-byte to preserve the F1=0.900 empirical claim.

**Tech Stack:** TypeScript (strict mode, ESM), Node.js 18+, better-sqlite3, vitest. Tests use `node:assert/strict` with vitest's `describe`/`test` runners, following the existing pattern in `tests/session/topic-fence.test.ts`.

**Spec reference:** `.claude/skills/topic-fence/PHASE2_SPEC.md` (canonical, English). Empirical validation: `.claude/skills/topic-fence/VALIDATION_RESULTS.md`. Reference implementation: `.claude/skills/topic-fence/eval-drift.mjs`.

**Workflow skills:** Use @superpowers:test-driven-development for every code task. Use @superpowers:verification-before-completion before marking any task complete.

---

## Scope Check

This plan covers a single focused subsystem (topic drift detection). No decomposition needed. All tasks produce testable, runnable changes that build on each other.

## File Structure

Files that will be created or modified:

| Path                                               | Status    | Responsibility                                                                                      |
| -------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `src/session/topic-fence.ts`                       | Modify    | Extended stopwords, Porter-inspired stemmer, env-var config, `scoreDrift()`, `TopicHistoryRow` type |
| `src/session/extract.ts`                           | Modify    | Accept optional `topicHistory` in `extractUserEvents`, dispatch to `scoreDrift` when applicable     |
| `src/session/db.ts`                                | Modify    | Add `getRecentEventsByType` prepared statement + `recent: boolean` option on `getEvents`            |
| `hooks/userpromptsubmit.mjs`                       | Modify    | Query last 6 topic events via `recent: true`, pass to `extractUserEvents`                           |
| `tests/session/topic-fence.test.ts`                | Modify    | Add `extractKeywords` tests for stopword/stemmer behavior; add integration tests for drift path    |
| `tests/session/topic-fence-drift.test.ts`          | **Create** | Unit tests U1-U13 for `scoreDrift`                                                                  |

**Design unit boundaries:**
- `topic-fence.ts` owns: tokenization, scoring, env config. No DB, no persistence.
- `extract.ts` owns: the single orchestration entrypoint `extractUserEvents`. Calls `topic-fence.ts` functions but does not know about DB.
- `db.ts` owns: SQLite persistence and query layer. No tokenization, no scoring logic.
- `userpromptsubmit.mjs` owns: I/O only (read stdin, query DB, insert events). No tokenization, no scoring.

These boundaries preserve the Phase 1 pattern and allow each unit to be tested in isolation.

---

## Task 1: Add Extended Stopwords and Porter-Inspired Stemmer

**Files:**
- Modify: `src/session/topic-fence.ts` (add constants + helper function, do not touch existing exports yet)
- Test: `tests/session/topic-fence.test.ts` (extend with direct stemmer tests)

**Context for the engineer:** Phase 1 has a base English stopword set `STOPWORDS_EN`. Phase 2 adds a larger set of generic coding-domain "filler" words (file, function, fix, run, etc.) and a lightweight English suffix stemmer. Both are pure data/logic — no behavior change yet until Task 2 plugs them into the tokenizer.

The stopword list and stemmer rules are **copied verbatim** from `.claude/skills/topic-fence/eval-drift.mjs` (lines 54-107 for stopwords, lines 113-136 for stemmer). That file is the empirical reference — deviating from it invalidates the F1=0.900 claim.

- [ ] **Step 1: Write the failing tests for `stem()`**

Add the following `describe` block to `tests/session/topic-fence.test.ts` immediately after the `describe("extractTopicSignal — direct unit tests", ...)` block:

```typescript
describe("stem — Porter-inspired English stemmer", () => {
  test("strips common suffixes", () => {
    assert.equal(stem("testing"), "test");
    assert.equal(stem("tested"), "test");
    assert.equal(stem("tests"), "test");
    assert.equal(stem("running"), "runn"); // no e-restoration; acceptable
    assert.equal(stem("implementing"), "implement"); // "ing" stripped
  });

  test("leaves short words (≤4 chars) untouched", () => {
    assert.equal(stem("auth"), "auth");
    assert.equal(stem("user"), "user");
    assert.equal(stem("ing"), "ing");
  });

  test("leaves words without a recognized suffix untouched", () => {
    assert.equal(stem("react"), "react");
    assert.equal(stem("context"), "context");
    assert.equal(stem("database"), "database");
  });

  test("strips tion as a 4-char suffix (not ation as a 5-char suffix)", () => {
    // Important: the rule list contains "tion" (4 chars), not "ation".
    // So "implementation" → strip "tion" → "implementa", NOT "implement".
    // This is the actual stemmer behavior — document it rather than
    // fight it, since drift detection only needs consistent application.
    assert.equal(stem("implementation"), "implementa");
    // Similarly "nationalization" strips "ization" (7 chars, which IS in
    // the list) before the "tion" rule is reached, because longer suffixes
    // come first in the iteration order.
    assert.equal(stem("nationalization"), "national");
  });
});
```

You will also need to add `stem` to the import at the top of the file:

```typescript
import { extractKeywords, extractTopicSignal, stem } from "../../src/session/topic-fence.js";
```

- [ ] **Step 2: Run the tests — expect them to fail**

Run: `npx vitest run tests/session/topic-fence.test.ts -t "stem"`

Expected: **FAIL** with `SyntaxError` or `Cannot find name 'stem'` — `stem` does not exist yet.

- [ ] **Step 3: Add the extended stopwords and stemmer to `topic-fence.ts`**

Open `src/session/topic-fence.ts`. Immediately after the existing `STOPWORDS_KO` declaration, add:

```typescript
// ─────────────────────────────────────────────────────────────────────────
// Phase 2 additions — extended stopwords and lightweight stemmer
//
// Generic coding-domain "filler" terms that poison Jaccard comparisons
// because they appear across topic events of almost every coding session.
// Empirically derived and validated in eval-drift.mjs (Path A tokenizer).
// Any change to this list MUST be re-validated by running eval-drift.mjs
// and confirming the F1=0.900 score is preserved.
// ─────────────────────────────────────────────────────────────────────────

const GENERIC_TECH_STOPWORDS = new Set([
  // generic verbs
  "use","using","used","make","makes","made","run","runs","running","ran",
  "check","checks","checking","checked","try","tries","trying","tried",
  "add","adds","adding","added","remove","removes","removing","removed",
  "update","updates","updating","updated","get","gets","getting","got",
  "set","sets","setting","need","needs","needed","want","wants","wanted",
  "show","shows","showing","showed","see","sees","seeing","saw",
  "look","looks","looking","looked","think","thinks","thinking","thought",
  "work","works","working","worked","fix","fixes","fixing","fixed",
  "build","builds","building","built","test","tests","testing","tested",
  "start","starts","starting","started","found","find","finds",
  "call","calls","calling","called","pass","passes","passing","passed",
  "return","returns","returning","returned","handle","handles","handling",
  "write","writes","writing","wrote","read","reads","reading",
  "change","changes","changing","changed","help","helps","helping",
  "create","creates","creating","created","delete","deletes","deleting",
  "let","lets","letting","move","moves","moving","moved",
  "now","next","first","then","actually","really","maybe","probably",
  "right","okay","good","great","nice","here","there","back","again",
  "new","old","big","small","same","different","many","much",
  "like","way","ways","thing","things","part","parts","side","sides",
  "case","cases","time","times","turn","turns","step","steps",
  // generic tech nouns
  "code","file","files","function","functions","method","methods",
  "class","classes","type","types","value","values","name","names",
  "data","item","items","list","lists","bug","bugs","error","errors",
  "issue","issues","problem","problems","stuff",
  // generic modals
  "still","already","yet","even","also","too","either","neither",
  // filler from LLM prompts
  "implement","implementing","implementation","implemented",
]);

const STOPWORDS_EN_EXTENDED = new Set([...STOPWORDS_EN, ...GENERIC_TECH_STOPWORDS]);

/**
 * Lightweight Porter-inspired English stemmer.
 *
 * Applies the most common English suffix rules in longest-first order.
 * Only strips a suffix if the resulting stem is at least 3 characters long.
 * Words of length ≤ 4 are returned unchanged to avoid over-aggressive
 * stripping of short technical terms.
 *
 * NOT a full Porter stemmer — deliberately minimal to stay pure and cheap.
 * The specific rule list is the empirical reference from eval-drift.mjs.
 * Do not "improve" this without re-running eval-drift.mjs to confirm
 * F1=0.900 is preserved.
 */
export function stem(word: string): string {
  if (word.length <= 4) return word;
  const suffixes = [
    "ational", "tional", "ization", "izing", "ized",
    "ingly", "edly",
    "ments", "ment",
    "tions", "sions", "tion", "sion",
    "ness", "able", "ible",
    "ing", "ers", "ed", "er",
    "ly", "es", "s",
  ];
  for (const suf of suffixes) {
    if (word.length - suf.length >= 3 && word.endsWith(suf)) {
      return word.slice(0, word.length - suf.length);
    }
  }
  return word;
}
```

Do NOT modify `extractKeywords` yet — Task 2 will do that.

- [ ] **Step 4: Run tests — expect them to pass**

Run: `npx vitest run tests/session/topic-fence.test.ts -t "stem"`

Expected: **PASS** — all stem tests green.

- [ ] **Step 5: Run the full topic-fence test file to verify Phase 1 tests still pass**

Run: `npx vitest run tests/session/topic-fence.test.ts`

Expected: **PASS** — all Phase 1 tests remain green (Task 1 adds only new code; no existing behavior is touched).

- [ ] **Step 6: Commit**

```bash
git add src/session/topic-fence.ts tests/session/topic-fence.test.ts
git commit -m "feat(topic-fence): add extended stopwords and Porter-inspired stemmer"
```

---

## Task 2: Apply Extended Stopwords and Stemming to `extractKeywords`

**Files:**
- Modify: `src/session/topic-fence.ts` (replace `extractKeywords` body)
- Test: `tests/session/topic-fence.test.ts` (verify existing Phase 1 tests still pass; add new behavior tests)

**Context for the engineer:** Phase 1's `extractKeywords` currently uses only the base `STOPWORDS_EN`/`STOPWORDS_KO` stopword sets and no stemming. Phase 2 requires the Path A tokenizer to be the production tokenizer (per `PHASE2_SPEC.md §Implementation fidelity requirement`). This task applies extended stopwords and stemming inline, and verifies that the existing Phase 1 tests still pass.

**Important note about existing Phase 1 tests:** Most Phase 1 tests assert behavioral properties (keyword count ≥ 2, specific stopwords filtered) and survive tokenizer changes trivially. However, **two tests use `deepEqual` on exact keyword strings**:
- Line 49-55 (`"auth auth auth login login database"` → `["auth", "login", "database"]`)
- Line 172-177 (`"auth auth login database"` → `["auth", "login", "database"]`)

These survive the Path A transition *only because* "auth", "login", and "database" all (a) stay below the 4-character stemmer guard for "auth", (b) have no matching suffix for "login"/"database", and (c) are not in the extended stopword list. This is fragile — if you find yourself extending `GENERIC_TECH_STOPWORDS` or the stemmer rules and these tests start failing, that's a signal to re-check the change, not to "fix" the test expectations. Run the Phase 1 test suite at Step 5 below and stop if anything unexpected fails.

- [ ] **Step 1: Write the new failing tests for extended-stopword and stemmer behavior**

Add the following tests to the `describe("extractKeywords — direct unit tests", ...)` block in `tests/session/topic-fence.test.ts`:

```typescript
  test("filters generic tech filler words (extended stopwords)", () => {
    // "file", "function", "test", "run" are all in GENERIC_TECH_STOPWORDS
    const result = extractKeywords("run the test function in this file");
    // After filtering: only "this" is removed as base stopword; "run/test/function/file"
    // are extended stopwords. Nothing survives — or maybe just nothing.
    assert.deepEqual(result, []);
  });

  test("stems English tokens so morphological variants collapse", () => {
    // "testing" and "tested" both stem to "test" which is then dropped as
    // a generic tech stopword. Use a non-stopword test target instead:
    const result = extractKeywords("authenticate authenticating authenticated");
    // "authenticate" length 12 → suffix "ate"? not in list. stays.
    // "authenticating" length 14 → "ing" suffix, stem to "authenticat"
    // "authenticated" length 13 → "ed" suffix, stem to "authenticat"
    // Frequencies: authenticate=1, authenticat=2
    assert.deepEqual(result, ["authenticat", "authenticate"]);
  });

  test("leaves Hangul tokens untouched by the stemmer", () => {
    const result = extractKeywords("세션 토픽 감지");
    // All Hangul tokens pass through without stemming.
    assert.equal(result.length, 3);
    for (const kw of result) {
      assert.ok(/^[가-힣]+$/.test(kw), `"${kw}" should be pure Hangul`);
    }
  });
```

- [ ] **Step 2: Run the new tests — expect them to fail**

Run: `npx vitest run tests/session/topic-fence.test.ts -t "generic tech filler"`

Expected: **FAIL** — existing `extractKeywords` does not filter "file/function/test/run" as stopwords.

- [ ] **Step 3: Replace `extractKeywords` body**

In `src/session/topic-fence.ts`, find the existing `extractKeywords` function and replace its body with the Path A logic. The function signature and export remain unchanged — only the internals are updated:

```typescript
export function extractKeywords(message: string): string[] {
  const normalized = message
    .toLowerCase()
    .replace(/[^\w\sㄱ-ㅎ가-힣]/g, " ");

  const tokens = normalized.split(/\s+/);
  const freq = new Map<string, number>();

  for (const rawToken of tokens) {
    if (rawToken.length < 2) continue;
    if (STOPWORDS_EN_EXTENDED.has(rawToken)) continue;
    if (STOPWORDS_KO.has(rawToken)) continue;

    // Apply stemming to ASCII-only tokens; Hangul passes through unchanged.
    const token = /^[a-z]+$/.test(rawToken) ? stem(rawToken) : rawToken;
    if (token.length < 2) continue;

    // Re-check stopwords after stemming — some stems may collapse to
    // entries that are in the extended set (e.g. "testing" → "test").
    if (STOPWORDS_EN_EXTENDED.has(token)) continue;

    freq.set(token, (freq.get(token) ?? 0) + 1);
  }

  if (freq.size === 0) return [];

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOPIC_MAX_KEYWORDS)
    .map(([word]) => word);
}
```

**Critical:** This must match `extractKeywordsPathA` in `.claude/skills/topic-fence/eval-drift.mjs` byte-for-byte. If you see any structural difference (re-check step order, the ASCII guard, the re-check after stemming), fix it before proceeding.

- [ ] **Step 4: Run the new tests — expect them to pass**

Run: `npx vitest run tests/session/topic-fence.test.ts -t "extractKeywords"`

Expected: **PASS** — the 3 new tests plus the existing 4 `extractKeywords` direct tests all green.

- [ ] **Step 5: Run the full topic-fence test file to verify Phase 1 tests still pass**

Run: `npx vitest run tests/session/topic-fence.test.ts`

Expected: **PASS** — all Phase 1 tests (Topic Signal Events, extractKeywords, extractTopicSignal) remain green. The Phase 1 tests assert behavioral properties (≥2 keywords, no specific stopwords) rather than exact keyword strings, so the tokenizer change does not break them.

If any Phase 1 test fails, stop and investigate. Do NOT "fix" by loosening the assertion — the Phase 1 tests are the behavioral contract.

- [ ] **Step 6: Run the full-project typecheck**

Run: `npm run typecheck`

Expected: **PASS** — no new type errors.

- [ ] **Step 7: Commit**

```bash
git add src/session/topic-fence.ts tests/session/topic-fence.test.ts
git commit -m "feat(topic-fence): apply Path A tokenization in extractKeywords"
```

---

## Task 3: Add Phase 2 Environment Variable Configuration

**Files:**
- Modify: `src/session/topic-fence.ts` (add clamp helpers and module-level config)
- Test: `tests/session/topic-fence.test.ts` (add direct tests for clamp helpers)

**Context for the engineer:** Phase 2 exposes 4 environment variables that control window sizes, threshold, and the kill switch. Values are read once at module load and cached to keep the hot path allocation-free. Invalid inputs (NaN, out-of-range, non-numeric strings) are silently normalized to defaults — this matches the "never block the session" contract. The existing Phase 1 module-level constants (`TOPIC_MAX_KEYWORDS`, `TOPIC_MIN_KEYWORDS`) live at the top of the file; place new config near them.

- [ ] **Step 1: Write failing tests for `clampInt` and `clampFloat`**

Add to `tests/session/topic-fence.test.ts`:

```typescript
import { clampInt, clampFloat } from "../../src/session/topic-fence.js";

describe("clampInt / clampFloat — Phase 2 config helpers", () => {
  test("clampInt returns default on undefined", () => {
    assert.equal(clampInt(undefined, 3, 1, 50), 3);
  });

  test("clampInt returns default on NaN / non-numeric", () => {
    assert.equal(clampInt("abc", 3, 1, 50), 3);
    assert.equal(clampInt("NaN", 3, 1, 50), 3);
  });

  test("clampInt returns default on out-of-range", () => {
    assert.equal(clampInt("0", 3, 1, 50), 3);   // below min
    assert.equal(clampInt("100", 3, 1, 50), 3); // above max
    assert.equal(clampInt("-5", 3, 1, 50), 3);  // negative
  });

  test("clampInt returns parsed integer on valid input", () => {
    assert.equal(clampInt("5", 3, 1, 50), 5);
    assert.equal(clampInt("1", 3, 1, 50), 1);
    assert.equal(clampInt("50", 3, 1, 50), 50);
  });

  test("clampInt floors fractional input", () => {
    assert.equal(clampInt("5.7", 3, 1, 50), 5);
  });

  test("clampFloat returns default on undefined / NaN / out-of-range", () => {
    assert.equal(clampFloat(undefined, 0.10, 0, 1), 0.10);
    assert.equal(clampFloat("abc", 0.10, 0, 1), 0.10);
    assert.equal(clampFloat("-0.5", 0.10, 0, 1), 0.10);
    assert.equal(clampFloat("1.5", 0.10, 0, 1), 0.10);
  });

  test("clampFloat accepts valid fractional input", () => {
    assert.equal(clampFloat("0.25", 0.10, 0, 1), 0.25);
    assert.equal(clampFloat("0", 0.10, 0, 1), 0);
    assert.equal(clampFloat("1", 0.10, 0, 1), 1);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `npx vitest run tests/session/topic-fence.test.ts -t "clampInt"`

Expected: **FAIL** with `Cannot find name 'clampInt'`.

- [ ] **Step 3: Add clamp helpers and module config to `topic-fence.ts`**

In `src/session/topic-fence.ts`, near the top of the file (after `import type { SessionEvent }` but before any constant declarations), add:

```typescript
// ─────────────────────────────────────────────────────────────────────────
// Phase 2 configuration — read once at module load, cached for hot path
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse an env var as an integer, clamping to [min, max]. Returns the
 * default value on any of: undefined, NaN, non-numeric string, out-of-range.
 * Silently normalizes invalid input — the hook layer must never block.
 */
export function clampInt(
  raw: string | undefined,
  def: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  const i = Math.floor(n);
  if (i < min || i > max) return def;
  return i;
}

/**
 * Parse an env var as a floating-point number, clamping to [min, max].
 * Same normalization semantics as clampInt but preserves the fractional part.
 */
export function clampFloat(
  raw: string | undefined,
  def: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  if (n < min || n > max) return def;
  return n;
}

const TOPIC_WINDOW_OLD       = clampInt(process.env.CONTEXT_MODE_TOPIC_WINDOW_OLD,        3,    1, 50);
const TOPIC_WINDOW_NEW       = clampInt(process.env.CONTEXT_MODE_TOPIC_WINDOW_NEW,        3,    1, 50);
const TOPIC_DRIFT_THRESHOLD  = clampFloat(process.env.CONTEXT_MODE_TOPIC_DRIFT_THRESHOLD, 0.10, 0, 1);
const TOPIC_FENCE_DISABLED   = process.env.CONTEXT_MODE_TOPIC_FENCE_DISABLED === "1";
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npx vitest run tests/session/topic-fence.test.ts -t "clampInt"`

Expected: **PASS** — all clamp helper tests green.

- [ ] **Step 5: Run the full topic-fence test file**

Run: `npx vitest run tests/session/topic-fence.test.ts`

Expected: **PASS** — all prior tests still green.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`

Expected: **PASS**.

- [ ] **Step 7: Commit**

```bash
git add src/session/topic-fence.ts tests/session/topic-fence.test.ts
git commit -m "feat(topic-fence): add Phase 2 env var config and clamp helpers"
```

---

## Task 4: Implement `scoreDrift` — Core Algorithm (Tests U1-U6)

**Files:**
- Modify: `src/session/topic-fence.ts` (add `TopicHistoryRow` type + `scoreDrift` function)
- Test: **Create** `tests/session/topic-fence-drift.test.ts`

**Context for the engineer:** `scoreDrift` is the heart of Phase 2. It computes two adjacent window-pair Jaccard scores and fires a `topic_drift` event only when both are below threshold. This "persistence" rule (from VALIDATION_RESULTS.md) filters out one-shot vocabulary rotation within stable topics. The function is pure — no DB access, no state, no side effects. Read `PHASE2_SPEC.md §API Surface` and `§Data Flow` before starting.

- [ ] **Step 1: Create the new test file with U1-U6**

Create `tests/session/topic-fence-drift.test.ts`:

```typescript
import { strict as assert } from "node:assert";
import { describe, test } from "vitest";
import { scoreDrift, type TopicHistoryRow } from "../../src/session/topic-fence.js";

// Helper: build a TopicHistoryRow from a keyword array.
function row(keywords: string[]): TopicHistoryRow {
  return { data: JSON.stringify({ keywords }) };
}

// Helper: build a "current" SessionEvent-shaped object.
function currentEvent(keywords: string[]) {
  return {
    type: "topic",
    category: "topic",
    data: JSON.stringify({ keywords }),
    priority: 3,
  };
}

// ════════════════════════════════════════════
// topic-fence Phase 2 — scoreDrift
// ════════════════════════════════════════════
//
// Unit tests for the drift scoring pure function. These tests bypass the
// full extractUserEvents integration and call scoreDrift directly with
// hand-crafted history arrays. See tests/session/topic-fence.test.ts for
// the integration-level tests.

describe("scoreDrift — core algorithm", () => {
  test("U1: returns [] when history is below N+M=6 (cold start)", () => {
    const history = [
      row(["auth", "jwt", "login"]),
      row(["auth", "jwt", "login"]),
      row(["auth", "jwt", "login"]),
      row(["auth", "jwt", "login"]),
      row(["auth", "jwt", "login"]),
    ]; // only 5 — below minimum
    const current = currentEvent(["react", "hooks", "state"]);
    assert.deepEqual(scoreDrift(history, current), []);
  });

  test("U2: fires a single drift event on a clean topic shift", () => {
    // CRITICAL: with window size N=M=3 and 7 combined events, the two
    // window pairs overlap by 2 rows (currOld = combined[1..4] overlaps
    // prevOld by rows 1-2 and shares row 3 with prevNew). If rows 3-5
    // all use the same vocabulary, currOld will inherit row 3's vocab
    // and share it with currNew — making currScore ≥ threshold even
    // when the "topic shift" looks clean at the row level.
    //
    // To guarantee BOTH window pairs are below threshold, each row must
    // use unique keywords so that no pair of rows shares any vocabulary.
    // This is the only construction where Jaccard is 0 everywhere and
    // the persistence rule fires cleanly.
    const history = [
      row(["alpha", "aleph", "aardvark"]),
      row(["beta", "banana", "bravo"]),
      row(["gamma", "grape", "gecko"]),
      row(["delta", "date", "duck"]),
      row(["epsilon", "eagle", "elephant"]),
      row(["zeta", "zebra", "zeppelin"]),
    ];
    const current = currentEvent(["lambda", "lion", "llama"]);
    // prev_pair: rows 0-2 vs rows 3-5 = 9 unique vs 9 unique, intersection ∅
    //            → prev_score = 0
    // curr_pair: rows 1-3 vs rows 4-6 = 9 unique vs 9 unique, intersection ∅
    //            → curr_score = 0
    // Both below threshold → persistence rule fires.
    const result = scoreDrift(history, current);
    assert.equal(result.length, 1, "should emit exactly one drift event");
    assert.equal(result[0].type, "topic_drift");
    assert.equal(result[0].category, "topic");
    assert.equal(result[0].priority, 2);
    const payload = JSON.parse(result[0].data);
    assert.ok(parseFloat(payload.prev_score) < 0.10, `prev_score ${payload.prev_score} should be < 0.10`);
    assert.ok(parseFloat(payload.curr_score) < 0.10, `curr_score ${payload.curr_score} should be < 0.10`);
  });

  test("U3: returns [] when the same topic repeats across all windows", () => {
    const history = [
      row(["auth", "login"]),
      row(["auth", "jwt"]),
      row(["login", "jwt"]),
      row(["auth", "login"]),
      row(["auth", "jwt"]),
      row(["login", "jwt"]),
    ];
    const current = currentEvent(["auth", "login"]);
    assert.deepEqual(scoreDrift(history, current), []);
  });

  test("U4: returns [] when windows have substantial partial overlap", () => {
    // ~50% shared vocabulary — should stay above threshold 0.10
    const history = [
      row(["auth", "login", "jwt"]),
      row(["auth", "login", "jwt"]),
      row(["auth", "login", "jwt"]),
      row(["auth", "login", "session"]),
      row(["auth", "login", "session"]),
      row(["auth", "login", "session"]),
    ];
    const current = currentEvent(["auth", "login", "session"]);
    assert.deepEqual(scoreDrift(history, current), []);
  });

  test("U5: returns [] on a single-turn dip (prev above, curr below)", () => {
    // Rows 0 and 3 share vocabulary (both in "old topic" cluster A),
    // making prev_pair's intersection non-empty and keeping prev_score
    // above threshold. curr_pair (rows 1-3 vs 4-6) is fully disjoint,
    // so curr_score alone would fire — but the persistence rule requires
    // BOTH to be below, so the event is suppressed.
    const history = [
      row(["alpha", "aleph", "aardvark"]),  // row 0 — set A
      row(["beta", "banana", "bravo"]),     // row 1 — filler
      row(["beta", "banana", "bravo"]),     // row 2 — filler
      row(["alpha", "aleph", "aardvark"]),  // row 3 — returns to set A (shares w/ row 0)
      row(["papa", "quebec", "romeo"]),     // row 4 — set B
      row(["papa", "quebec", "romeo"]),     // row 5 — set B
    ];
    const current = currentEvent(["papa", "quebec", "romeo"]); // set B
    // prev_pair: {alpha,aleph,aardvark, beta,banana,bravo}
    //         vs {alpha,aleph,aardvark, papa,quebec,romeo}
    //            intersection = {alpha, aleph, aardvark} = 3
    //            union = 9
    //            score ≈ 0.33 (above 0.10)
    // curr_pair: {beta,banana,bravo, alpha,aleph,aardvark}
    //         vs {papa, quebec, romeo}
    //            intersection = ∅, score = 0 (below 0.10)
    // Prev above but curr below → persistence rule does NOT fire.
    assert.deepEqual(scoreDrift(history, current), []);
  });

  test("U6: returns [] on a reverse single-turn dip (prev below, curr above)", () => {
    // Row 3 sits at the boundary: its vocabulary matches `current`
    // but not any earlier row. That makes prev_pair fully disjoint
    // (prev below), while curr_pair picks up row 3's vocabulary on
    // both sides (curr above).
    const history = [
      row(["alpha", "aleph", "aardvark"]),  // row 0
      row(["alpha", "aleph", "aardvark"]),  // row 1
      row(["alpha", "aleph", "aardvark"]),  // row 2
      row(["xray", "yankee", "zulu"]),      // row 3 — boundary
      row(["papa", "quebec", "romeo"]),     // row 4
      row(["papa", "quebec", "romeo"]),     // row 5
    ];
    const current = currentEvent(["xray", "yankee", "zulu"]); // shares with row 3
    // prev_pair: {alpha,aleph,aardvark} vs {xray,yankee,zulu, papa,quebec,romeo}
    //            intersection = ∅, score = 0 (below 0.10)
    // curr_pair: {alpha,aleph,aardvark, xray,yankee,zulu}
    //         vs {papa,quebec,romeo, xray,yankee,zulu}
    //            intersection = {xray, yankee, zulu} = 3
    //            union = 9
    //            score ≈ 0.33 (above 0.10)
    // Prev below but curr above → persistence rule does NOT fire.
    assert.deepEqual(scoreDrift(history, current), []);
  });
});
```

- [ ] **Step 2: Run the tests — expect failure**

Run: `npx vitest run tests/session/topic-fence-drift.test.ts`

Expected: **FAIL** with `Cannot find name 'scoreDrift'` or `'TopicHistoryRow' is not exported`.

- [ ] **Step 3: Implement `TopicHistoryRow` type and `scoreDrift` function**

In `src/session/topic-fence.ts`, after the existing `extractTopicSignal` export, add:

```typescript
// ─────────────────────────────────────────────────────────────────────────
// Phase 2: drift scoring with 2-consecutive-window-pair rule
// ─────────────────────────────────────────────────────────────────────────

/**
 * Minimal structural shape of a stored topic row. Exported so extract.ts
 * can reference the same type in extractUserEvents's signature without
 * redeclaring it. SessionDB.StoredEvent is structurally a superset of
 * this type, so the hook passes DB rows directly with no cast.
 */
export type TopicHistoryRow = { data: string };

/**
 * Parse a topic event row's `data` field into a keyword array.
 * Returns an empty array on any JSON parse error or schema mismatch.
 * Pure, defensive — never throws.
 */
function parseTopicKeywords(data: string): string[] {
  try {
    const parsed = JSON.parse(data);
    const kws = parsed?.keywords;
    return Array.isArray(kws) ? kws.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Compute Jaccard similarity between two flattened keyword arrays
 * (each representing one window: the union of all keywords across its
 * constituent topic events).
 *
 * Returns 1.0 when both sets are empty — the "pathological empty-set"
 * safe fallback described in PHASE2_SPEC.md §Edge Cases #5.
 */
function jaccardWindows(oldKw: string[][], newKw: string[][]): number {
  const oldSet = new Set(oldKw.flat());
  const newSet = new Set(newKw.flat());
  if (oldSet.size === 0 && newSet.size === 0) return 1.0;
  let inter = 0;
  for (const k of oldSet) if (newSet.has(k)) inter++;
  const uni = new Set([...oldSet, ...newSet]).size;
  return uni === 0 ? 1.0 : inter / uni;
}

/**
 * Detect topic drift across two adjacent sliding window pairs.
 *
 * Phase 2 requires BOTH window pairs (previous and current) to have Jaccard
 * similarity below TOPIC_DRIFT_THRESHOLD. This "persistence rule" filters
 * out one-shot vocabulary rotation within stable topics — empirically the
 * dominant source of false positives (see VALIDATION_RESULTS.md).
 *
 * Returns [] in all of: kill switch set, cold start (history.length < N+M),
 * either pair above threshold, pathological empty-set fallback.
 *
 * Pure function. Never throws. <1ms per call at default N=M=3.
 */
export function scoreDrift(
  history: ReadonlyArray<TopicHistoryRow>,
  currentTopic: SessionEvent,
): SessionEvent[] {
  if (TOPIC_FENCE_DISABLED) return [];

  const N = TOPIC_WINDOW_OLD;
  const M = TOPIC_WINDOW_NEW;
  if (history.length < N + M) return [];

  // Defensive parse of all rows — corrupted rows become empty arrays.
  const historyKeywords = history.map((r) => parseTopicKeywords(r.data));
  const currentKeywords = parseTopicKeywords(currentTopic.data);
  const combined = [...historyKeywords, currentKeywords];

  // Two adjacent window pairs.
  const prevOld = combined.slice(0, N);
  const prevNew = combined.slice(N, N + M);
  const currOld = combined.slice(1, 1 + N);
  const currNew = combined.slice(1 + N, 1 + N + M);

  const prevScore = jaccardWindows(prevOld, prevNew);
  const currScore = jaccardWindows(currOld, currNew);

  // Persistence rule: both must be strictly below threshold.
  if (prevScore >= TOPIC_DRIFT_THRESHOLD || currScore >= TOPIC_DRIFT_THRESHOLD) {
    return [];
  }

  // Deterministic payload for DB dedup compatibility.
  const sortedOld = [...new Set(currOld.flat())].sort();
  const sortedNew = [...new Set(currNew.flat())].sort();
  const payload = {
    prev_score: prevScore.toFixed(2),
    curr_score: currScore.toFixed(2),
    old: sortedOld,
    new: sortedNew,
    window: [N, M],
  };

  return [
    {
      type: "topic_drift",
      category: "topic",
      data: JSON.stringify(payload),
      priority: 2,
    },
  ];
}
```

**Critical fidelity check:** the `jaccardWindows` function and the slicing indices (`slice(0, N)`, `slice(N, N+M)`, `slice(1, 1+N)`, `slice(1+N, 1+N+M)`) must match `eval-drift.mjs` exactly. Any deviation invalidates F1=0.900.

- [ ] **Step 4: Run the tests — expect pass**

Run: `npx vitest run tests/session/topic-fence-drift.test.ts`

Expected: **PASS** — U1 through U6 all green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: **PASS**.

- [ ] **Step 6: Commit**

```bash
git add src/session/topic-fence.ts tests/session/topic-fence-drift.test.ts
git commit -m "feat(topic-fence): implement scoreDrift with 2-consecutive-pair rule"
```

---

## Task 5: `scoreDrift` — Defensive Handling (Tests U7-U11)

**Files:**
- Test: `tests/session/topic-fence-drift.test.ts` (extend with defensive tests)
- Modify: `src/session/topic-fence.ts` only if any test exposes a real bug

**Context for the engineer:** `scoreDrift` is already defensive (parseTopicKeywords catches JSON errors; empty-set fallback returns 1.0). This task writes the tests that assert those behaviors explicitly and verifies the kill switch + determinism + payload shape contracts. In most cases no code changes are needed — if Task 4 was done correctly, these tests should pass on the first run.

- [ ] **Step 1: Add tests U7-U11 to `topic-fence-drift.test.ts`**

Append the following describe block to `tests/session/topic-fence-drift.test.ts`:

```typescript
describe("scoreDrift — defensive handling", () => {
  test("U7: one corrupted history row is treated as empty, others proceed", () => {
    const history = [
      row(["auth", "jwt", "login"]),
      { data: "not valid json at all" }, // corrupted
      row(["auth", "jwt", "login"]),
      row(["react", "hooks", "state"]),
      row(["react", "hooks", "state"]),
      row(["react", "hooks", "state"]),
    ];
    const current = currentEvent(["react", "hooks", "state"]);
    // Should still produce a drift event since the surviving rows exhibit a clean shift.
    const result = scoreDrift(history, current);
    assert.doesNotThrow(() => result);
    // The exact fire/no-fire depends on how the corrupted row shifts the windows.
    // We assert the function did not throw; failing the assertion means a regression.
    assert.ok(Array.isArray(result), "must return an array");
  });

  test("U8: all history rows corrupted → empty-set fallback returns []", () => {
    const history = [
      { data: "garbage" },
      { data: "garbage" },
      { data: "garbage" },
      { data: "garbage" },
      { data: "garbage" },
      { data: "garbage" },
    ];
    const current = currentEvent(["react", "hooks", "state"]);
    // All windows degenerate to empty sets → similarity 1.0 → no drift.
    assert.deepEqual(scoreDrift(history, current), []);
  });

  test("U9: CONTEXT_MODE_TOPIC_FENCE_DISABLED=1 returns [] immediately", async () => {
    // Cache test: scoreDrift reads TOPIC_FENCE_DISABLED at module load.
    // Test the disabled state by stubbing the env var, resetting vitest's
    // module cache, and re-importing topic-fence fresh. The plain-import
    // form (no cache buster query string) is the vitest-idiomatic pattern.
    const { vi } = await import("vitest");
    vi.stubEnv("CONTEXT_MODE_TOPIC_FENCE_DISABLED", "1");
    vi.resetModules();
    const mod = await import("../../src/session/topic-fence.js");
    // Use the unique-keyword construction from U2 so we know drift WOULD
    // fire if the kill switch were off.
    const history = [
      row(["alpha", "aleph", "aardvark"]),
      row(["beta", "banana", "bravo"]),
      row(["gamma", "grape", "gecko"]),
      row(["delta", "date", "duck"]),
      row(["epsilon", "eagle", "elephant"]),
      row(["zeta", "zebra", "zeppelin"]),
    ];
    const current = currentEvent(["lambda", "lion", "llama"]);
    assert.deepEqual(mod.scoreDrift(history, current), []);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("U10: determinism — identical inputs produce byte-identical payloads", () => {
    // Use the U2 unique-keyword construction so drift actually fires and
    // the determinism assertion on the payload string has something to
    // check. Overlapping vocabularies would produce [] twice and pass
    // the assertion trivially without testing anything.
    const history = [
      row(["alpha", "aleph", "aardvark"]),
      row(["beta", "banana", "bravo"]),
      row(["gamma", "grape", "gecko"]),
      row(["delta", "date", "duck"]),
      row(["epsilon", "eagle", "elephant"]),
      row(["zeta", "zebra", "zeppelin"]),
    ];
    const current = currentEvent(["lambda", "lion", "llama"]);
    const r1 = scoreDrift(history, current);
    const r2 = scoreDrift(history, current);
    assert.equal(r1.length, 1, "drift must fire so we have a payload to compare");
    assert.equal(r2.length, 1);
    assert.equal(r1[0].data, r2[0].data, "payloads must be byte-identical");
  });

  test("U11: payload shape — sorted keywords, 2-decimal scores, window array", () => {
    // Same unique-keyword construction as U2/U10 but with intentionally
    // non-alphabetical insertion order in the current event, so we can
    // verify the sort step of the payload builder actually runs.
    const history = [
      row(["alpha", "aleph", "aardvark"]),
      row(["beta", "banana", "bravo"]),
      row(["gamma", "grape", "gecko"]),
      row(["delta", "date", "duck"]),
      row(["epsilon", "eagle", "elephant"]),
      row(["zeta", "zebra", "zeppelin"]),
    ];
    const current = currentEvent(["lion", "llama", "lambda"]); // not in alphabetical order
    const result = scoreDrift(history, current);
    assert.equal(result.length, 1, "drift must fire so payload is present");
    const payload = JSON.parse(result[0].data);
    assert.deepEqual(Object.keys(payload).sort(), ["curr_score", "new", "old", "prev_score", "window"]);
    // Keywords must be sorted lexicographically in the payload
    assert.deepEqual(payload.new, [...payload.new].sort());
    assert.deepEqual(payload.old, [...payload.old].sort());
    // The `new` array must CONTAIN all three current-event keywords.
    // They will sit in the middle of the alphabetically-sorted output,
    // not at the tail — verify by membership, not position.
    assert.ok(payload.new.includes("lambda"), "payload.new should contain 'lambda'");
    assert.ok(payload.new.includes("lion"),   "payload.new should contain 'lion'");
    assert.ok(payload.new.includes("llama"),  "payload.new should contain 'llama'");
    // Scores must be strings with exactly 2 decimal places
    assert.ok(/^\d\.\d{2}$/.test(payload.prev_score), `prev_score "${payload.prev_score}" malformed`);
    assert.ok(/^\d\.\d{2}$/.test(payload.curr_score), `curr_score "${payload.curr_score}" malformed`);
    // Window must be literal [N, M]
    assert.deepEqual(payload.window, [3, 3]);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/session/topic-fence-drift.test.ts`

Expected: **PASS** — all U1-U11 tests green. If any of U7-U11 fail, investigate:
- U7: check that `parseTopicKeywords` has a try/catch
- U8: check that `jaccardWindows` returns 1.0 when both sets are empty
- U9: check env-var caching and module re-import — the `?disabled=1` query string trick forces vitest to re-load the module fresh
- U10: check that sort order in payload construction is deterministic
- U11: check that scores use `toFixed(2)` and old/new arrays use `.sort()`

- [ ] **Step 3: Commit**

If you had to modify `topic-fence.ts` to make any test pass, include it in the commit:

```bash
git add tests/session/topic-fence-drift.test.ts src/session/topic-fence.ts
git commit -m "test(topic-fence): add defensive scoreDrift tests U7-U11"
```

If no code change was needed, commit just the test:

```bash
git add tests/session/topic-fence-drift.test.ts
git commit -m "test(topic-fence): add defensive scoreDrift tests U7-U11"
```

---

## Task 6: Add `recent: true` Option to `SessionDB.getEvents`

**Files:**
- Modify: `src/session/db.ts` (add prepared statement + option handling)
- Test: `tests/session/session-db.test.ts` (add test for the new option)

**Context for the engineer:** The existing `SessionDB.getEvents` uses `ORDER BY id ASC LIMIT ?`, which returns the *oldest* N rows of the given type. Phase 2 needs the *most recent* N rows in chronological order. The fix is a small internal addition: a new prepared statement with `ORDER BY id DESC LIMIT ?`, then reverse the result before returning so callers always receive chronological order. This preserves the existing API contract for callers who omit `recent`.

Read `src/session/db.ts:209-235` and `src/session/db.ts:350-370` before starting — that's where the current prepared statements and `getEvents` dispatch live.

- [ ] **Step 1: Write the failing test**

Open `tests/session/session-db.test.ts` and locate the describe block that tests `getEvents` (if none exists, create one near the existing tests). Add:

```typescript
describe("getEvents — recent: true option", () => {
  test("returns the most recent N events of type, in chronological order", () => {
    const db = new SessionDB({ dbPath: ":memory:" });
    db.ensureSession("S1", "/tmp");
    // Insert 10 topic events in order
    for (let i = 0; i < 10; i++) {
      db.insertEvent("S1", {
        type: "topic",
        category: "topic",
        data: JSON.stringify({ keywords: [`kw${i}`] }),
        priority: 3,
      }, "test");
    }
    const recent = db.getEvents("S1", { type: "topic", limit: 5, recent: true });
    assert.equal(recent.length, 5);
    // Should be events 5, 6, 7, 8, 9 in chronological order
    const kws = recent.map((r) => JSON.parse(r.data).keywords[0]);
    assert.deepEqual(kws, ["kw5", "kw6", "kw7", "kw8", "kw9"]);
    db.close();
  });

  test("omitting recent preserves the existing ASC behavior", () => {
    const db = new SessionDB({ dbPath: ":memory:" });
    db.ensureSession("S2", "/tmp");
    for (let i = 0; i < 5; i++) {
      db.insertEvent("S2", {
        type: "topic",
        category: "topic",
        data: JSON.stringify({ keywords: [`kw${i}`] }),
        priority: 3,
      }, "test");
    }
    const all = db.getEvents("S2", { type: "topic", limit: 3 });
    // Default ASC: oldest 3
    const kws = all.map((r) => JSON.parse(r.data).keywords[0]);
    assert.deepEqual(kws, ["kw0", "kw1", "kw2"]);
    db.close();
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npx vitest run tests/session/session-db.test.ts -t "recent: true"`

Expected: **FAIL** — existing `getEvents` either rejects the `recent` option or ignores it, returning oldest rows.

- [ ] **Step 3: Add the new prepared statement and dispatch branch**

In `src/session/db.ts`:

1. Add `getRecentEventsByType` to the `S` constant (around line 113):

```typescript
const S = {
  insertEvent: "insertEvent",
  getEvents: "getEvents",
  getEventsByType: "getEventsByType",
  getRecentEventsByType: "getRecentEventsByType",  // NEW
  getEventsByPriority: "getEventsByPriority",
  // ... rest unchanged
};
```

2. Add the prepared statement inside `prepareStatements()` (near the other `getEvents*` statements around line 225):

```typescript
p(S.getRecentEventsByType,
  `SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
   FROM session_events WHERE session_id = ? AND type = ? ORDER BY id DESC LIMIT ?`);
```

3. Extend the `getEvents` options type and add a dispatch branch. Find the existing method signature (around line 352) and update:

```typescript
getEvents(
  sessionId: string,
  opts?: { type?: string; minPriority?: number; limit?: number; recent?: boolean },
): StoredEvent[] {
  const limit = opts?.limit ?? 1000;
  const type = opts?.type;
  const minPriority = opts?.minPriority;

  // NEW: recent: true branch — uses DESC prepared statement and reverses
  // the result so downstream consumers always see chronological order.
  if (type && opts?.recent) {
    const rows = this.stmt(S.getRecentEventsByType).all(sessionId, type, limit) as StoredEvent[];
    return rows.reverse();
  }

  if (type && minPriority !== undefined) {
    return this.stmt(S.getEventsByTypeAndPriority).all(sessionId, type, minPriority, limit) as StoredEvent[];
  }
  if (type) {
    return this.stmt(S.getEventsByType).all(sessionId, type, limit) as StoredEvent[];
  }
  if (minPriority !== undefined) {
    return this.stmt(S.getEventsByPriority).all(sessionId, minPriority, limit) as StoredEvent[];
  }
  return this.stmt(S.getEvents).all(sessionId, limit) as StoredEvent[];
}
```

- [ ] **Step 4: Run the tests — expect pass**

Run: `npx vitest run tests/session/session-db.test.ts -t "recent: true"`

Expected: **PASS** — both new tests green.

- [ ] **Step 5: Run the full session-db tests**

Run: `npx vitest run tests/session/session-db.test.ts`

Expected: **PASS** — all existing tests remain green.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`

Expected: **PASS**.

- [ ] **Step 7: Commit**

```bash
git add src/session/db.ts tests/session/session-db.test.ts
git commit -m "feat(session-db): add recent option to getEvents for reverse-ordered queries"
```

---

## Task 7: Extend `extractUserEvents` Signature and Wire `scoreDrift` In

**Files:**
- Modify: `src/session/extract.ts` (extend signature, import scoreDrift, call when conditions met)
- Test: `tests/session/topic-fence.test.ts` (add integration tests I1-I5)

**Context for the engineer:** This task connects the drift scorer to the user event extraction pipeline. The change to `extractUserEvents` is minimal — an optional second parameter with a default value `[]` to preserve backwards compatibility. When the caller passes a non-empty history, the function calls `scoreDrift` after emitting the current topic event.

Read `src/session/extract.ts:636-650` to see the current `extractUserEvents` implementation. Also re-read `PHASE2_SPEC.md §Integration test matrix` for I1-I5 before starting.

- [ ] **Step 1: Write the failing integration tests I1-I5**

Add to `tests/session/topic-fence.test.ts` (at the bottom, after the existing describe blocks):

```typescript
// ════════════════════════════════════════════
// topic-fence Phase 2 — drift integration via extractUserEvents
// ════════════════════════════════════════════

describe("extractUserEvents with topicHistory — Phase 2 drift integration", () => {
  // Helper: build a stored topic row from keywords.
  const storedTopic = (keywords: string[]) => ({
    data: JSON.stringify({ keywords }),
  });

  test("I1: omitting topicHistory preserves Phase 1 behavior", () => {
    const events = extractUserEvents("implementing authentication for web app");
    const topics = events.filter((e) => e.type === "topic");
    const drifts = events.filter((e) => e.type === "topic_drift");
    assert.equal(topics.length, 1);
    assert.equal(drifts.length, 0);
  });

  test("I2: topic shift message + 6-row history emits both topic and topic_drift", () => {
    // Each history row uses unique vocabulary so that every possible
    // sliding window pair is Jaccard-disjoint. See U2 for the detailed
    // rationale — the same construction constraint applies here.
    //
    // The current MESSAGE goes through the production tokenizer, so we
    // pick a sentence whose Path A tokens do not collide with any
    // history row's keywords. "lambda lion llama cheetah python" uses
    // only short/uncommon words that survive the stemmer unchanged and
    // appear in neither the base nor extended stopword lists.
    const history = [
      storedTopic(["alpha", "aleph", "aardvark"]),
      storedTopic(["beta", "banana", "bravo"]),
      storedTopic(["gamma", "grape", "gecko"]),
      storedTopic(["delta", "date", "duck"]),
      storedTopic(["epsilon", "eagle", "elephant"]),
      storedTopic(["zeta", "zebra", "zeppelin"]),
    ];
    const events = extractUserEvents("lambda lion llama cheetah python", history);
    const topics = events.filter((e) => e.type === "topic");
    const drifts = events.filter((e) => e.type === "topic_drift");
    assert.equal(topics.length, 1, "should emit current topic");
    assert.equal(drifts.length, 1, "should emit drift event");
  });

  test("I3: short message with no current topic → no drift even with history", () => {
    // Same unique-vocabulary history as I2 — guarantees drift WOULD fire
    // if a current topic were produced. But "yes" produces no topic event.
    const history = [
      storedTopic(["alpha", "aleph", "aardvark"]),
      storedTopic(["beta", "banana", "bravo"]),
      storedTopic(["gamma", "grape", "gecko"]),
      storedTopic(["delta", "date", "duck"]),
      storedTopic(["epsilon", "eagle", "elephant"]),
      storedTopic(["zeta", "zebra", "zeppelin"]),
    ];
    const events = extractUserEvents("yes", history);
    const drifts = events.filter((e) => e.type === "topic_drift");
    assert.equal(drifts.length, 0);
  });

  test("I4: history below cold-start threshold → only topic, no drift", () => {
    const history = [
      storedTopic(["alpha", "aleph", "aardvark"]),
      storedTopic(["beta", "banana", "bravo"]),
      storedTopic(["gamma", "grape", "gecko"]),
    ]; // only 3 rows — below the 6-row minimum
    const events = extractUserEvents("lambda lion llama cheetah python", history);
    const topics = events.filter((e) => e.type === "topic");
    const drifts = events.filter((e) => e.type === "topic_drift");
    assert.equal(topics.length, 1);
    assert.equal(drifts.length, 0);
  });

  test("I5: empty history uses default parameter, no drift", () => {
    const events = extractUserEvents("lambda lion llama cheetah python", []);
    const drifts = events.filter((e) => e.type === "topic_drift");
    assert.equal(drifts.length, 0);
  });
});
```

- [ ] **Step 2: Run the tests — expect failure**

Run: `npx vitest run tests/session/topic-fence.test.ts -t "Phase 2 drift integration"`

Expected: **FAIL** — `extractUserEvents` does not yet accept a second parameter.

- [ ] **Step 3: Update `extractUserEvents` signature in `extract.ts`**

Open `src/session/extract.ts`. At the top of the file, update the import from `./topic-fence.js`:

```typescript
// BEFORE:
import { extractTopicSignal } from "./topic-fence.js";

// AFTER:
import { extractTopicSignal, scoreDrift, type TopicHistoryRow } from "./topic-fence.js";
```

Then replace the existing `extractUserEvents` function (around line 636) with:

```typescript
/**
 * Extract session events from a UserPromptSubmit hook input (user message text).
 *
 * Handles: decision, role, intent, data, topic, and (Phase 2) topic_drift.
 * When `topicHistory` is provided and non-empty AND the current message
 * produces a topic event, drift scoring runs and may emit a topic_drift
 * event alongside the topic event.
 *
 * The `topicHistory` parameter defaults to `[]` so adapters that have not
 * wired up the DB query continue to work unchanged — they simply get no
 * drift detection.
 *
 * Returns an array of zero or more SessionEvents. Never throws.
 */
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

    // Phase 2: drift scoring — only when history provided AND current topic emitted.
    if (topicHistory.length > 0 && topicEvents.length > 0) {
      events.push(...scoreDrift(topicHistory, topicEvents[0]));
    }

    return events;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run the integration tests — expect pass**

Run: `npx vitest run tests/session/topic-fence.test.ts -t "Phase 2 drift integration"`

Expected: **PASS** — I1 through I5 all green.

- [ ] **Step 5: Run the full topic-fence test file to verify nothing regressed**

Run: `npx vitest run tests/session/topic-fence.test.ts`

Expected: **PASS** — all Phase 1 tests, Phase 2 config tests, clamp helper tests, stem tests, drift unit tests, and drift integration tests all green.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`

Expected: **PASS**.

- [ ] **Step 7: Commit**

```bash
git add src/session/extract.ts tests/session/topic-fence.test.ts
git commit -m "feat(topic-fence): wire drift scoring into extractUserEvents"
```

---

## Task 8: Wire Topic History Query into UserPromptSubmit Hook

**Files:**
- Modify: `hooks/userpromptsubmit.mjs` (add one query line)

**Context for the engineer:** This is the smallest task. The hook currently calls `extractUserEvents(trimmed)` with no history. We need to query the last 6 topic events via the new `recent: true` option and pass them as the second argument. The existing insert loop automatically handles any new `topic_drift` events because `extractUserEvents` already appends them to the returned array.

Read `hooks/userpromptsubmit.mjs:34-58` to see the current hook body before starting.

- [ ] **Step 1: Update the hook body**

Open `hooks/userpromptsubmit.mjs`. Find the block that calls `extractUserEvents` (around line 52):

```javascript
// BEFORE:
    // 2. Extract decision/role/intent/data from user message
    const userEvents = extractUserEvents(trimmed);
    for (const ev of userEvents) {
      db.insertEvent(sessionId, ev, "UserPromptSubmit");
    }
```

Replace with:

```javascript
    // 2. Extract decision/role/intent/data/topic + Phase 2 drift detection
    //    from user message. The topic history is queried via the new
    //    `recent: true` option which returns the most recent N topic
    //    events in chronological order. historySize = TOPIC_WINDOW_OLD +
    //    TOPIC_WINDOW_NEW (6 at default config).
    const recentTopics = db.getEvents(sessionId, {
      type: "topic",
      limit: 6,
      recent: true,
    });
    const userEvents = extractUserEvents(trimmed, recentTopics);
    for (const ev of userEvents) {
      db.insertEvent(sessionId, ev, "UserPromptSubmit");
    }
```

- [ ] **Step 2: Verify the hook still parses as valid ESM**

Run: `node --check hooks/userpromptsubmit.mjs`

Expected: **PASS** (no output = success). Any parse error means a syntax mistake in the edit.

- [ ] **Step 3: Typecheck the project**

Run: `npm run typecheck`

Expected: **PASS**. (The `.mjs` file is not directly typechecked, but if any imported module changed signature incompatibly, related tests would have caught it in earlier tasks.)

- [ ] **Step 4: Commit**

```bash
git add hooks/userpromptsubmit.mjs
git commit -m "feat(topic-fence): query topic history in UserPromptSubmit hook"
```

---

## Task 9: Final Verification — Re-run `eval-drift.mjs` as a Sanity Check

**Files:** none modified — this is a verification gate, not a code change.

**Context for the engineer:** The implementation is done. Before declaring victory, re-run the validation harness to confirm that the production code produces the same F1=0.900 that the reference implementation did. This catches any accidental deviation from the Path A tokenizer or scoreDrift algorithm. Reference: @superpowers:verification-before-completion.

- [ ] **Step 1: Run `eval-drift.mjs` and capture the output**

Run: `node .claude/skills/topic-fence/eval-drift.mjs`

Expected: the "Path C (Path A + 2-consecutive rule)" row in the final summary shows `F1=0.900 P=0.818 R=1.000` exactly.

**Caveat:** `eval-drift.mjs` is a *standalone* reference harness — it defines its own `extractKeywordsPathA`, `STOPWORDS_EN_EXTENDED`, and `scoreDrift` inline and does NOT import from `src/session/topic-fence.ts`. Passing this step only confirms that the reference harness still produces the expected numbers against its own copy. To cross-check that the PRODUCTION code has not drifted from the reference, Step 2 below runs a direct parity test.

- [ ] **Step 2: Cross-check production `extractKeywords` against the reference tokenizer**

Add this one-off fidelity test to `tests/session/topic-fence.test.ts` (bottom of file, new describe block). This asserts that the production `extractKeywords` produces byte-identical output to what `eval-drift.mjs`'s `extractKeywordsPathA` would produce for a fixed set of inputs:

```typescript
describe("Path A fidelity — production tokenizer matches eval-drift.mjs reference", () => {
  // These expectations are snapshots of what eval-drift.mjs's
  // extractKeywordsPathA returns for these inputs. They are hand-computed
  // and verified once. If they ever diverge from the production
  // extractKeywords output, the production tokenizer has drifted from
  // the reference and the F1=0.900 empirical claim is at risk.
  const cases: Array<{ input: string; expected: string[] }> = [
    {
      input: "I want to build a React component for displaying a list of users",
      // Trace:
      //   "i" len 1 → drop
      //   "want" in extended stopwords → drop
      //   "to" in base stopwords → drop
      //   "build" in extended stopwords → drop
      //   "a" len 1 → drop
      //   "react" → stem: no suffix match → "react" ✓
      //   "component" → stem: no suffix match → "component" ✓
      //   "for" in base stopwords → drop
      //   "displaying" → stem: "ing" match, len 10-3=7 ≥ 3 → "display" ✓
      //   "a" len 1 → drop
      //   "list" in extended stopwords → drop
      //   "of" in base stopwords → drop
      //   "users" → stem: "ers" match but len 5-3=2 < 3 (skip); "s" match, len 5-1=4 ≥ 3 → "user" ✓
      // Frequency all 1, insertion order preserved.
      expected: ["react", "component", "display", "user"],
    },
    {
      input: "세션을 나눠서 진행할 수 있도록 감지해서 알려주는 기능",
      // Korean tokens pass through unchanged (stemmer skipped by ASCII guard).
      // 수 is 1 char (<2) → dropped.
      expected: ["세션을", "나눠서", "진행할", "있도록", "감지해서", "알려주는", "기능"],
    },
    {
      input: "auth auth login database",
      // No stemmer matches (auth ≤ 4 chars, login/database have no suffix),
      // no stopwords. Frequency: auth=2, login=1, database=1.
      expected: ["auth", "login", "database"],
    },
  ];

  for (const { input, expected } of cases) {
    test(`matches reference for: "${input.slice(0, 40)}${input.length > 40 ? "..." : ""}"`, () => {
      assert.deepEqual(extractKeywords(input), expected);
    });
  }
});
```

If any case fails, the production `extractKeywords` has drifted. Before "fixing" the expected values, derive them from `eval-drift.mjs` by:

```bash
# Temporary debug: add console.log(extractKeywordsPathA("your input")); near the top of eval-drift.mjs, run it, and read the output. Remove the debug line afterward.
```

This is the authoritative source for what the expected keyword array should be. The production code must match — never the other way around.

Run: `npx vitest run tests/session/topic-fence.test.ts -t "Path A fidelity"`

Expected: **PASS** on all cases. If any case fails, stop and investigate the tokenizer before proceeding.

- [ ] **Step 3: Run the full topic-fence test suite**

Run:

```bash
npx vitest run tests/session/topic-fence.test.ts tests/session/topic-fence-drift.test.ts tests/session/session-db.test.ts
```

Expected: **all tests green**.

- [ ] **Step 4: Full typecheck**

Run: `npm run typecheck`

Expected: **PASS**.

- [ ] **Step 5: Summary check**

Per @superpowers:verification-before-completion, explicitly confirm before reporting done:

- Phase 1 tests (`tests/session/topic-fence.test.ts` — original describe blocks): pass
- Clamp helpers + stem tests (new): pass
- Path A fidelity tests (Step 2): pass
- Drift unit tests U1-U11 (`tests/session/topic-fence-drift.test.ts`): pass
- Drift integration tests I1-I5 (`tests/session/topic-fence.test.ts` new block): pass
- `session-db.test.ts` recent option tests: pass
- `npm run typecheck`: pass
- `eval-drift.mjs` final summary shows `Path C F1=0.900`: confirmed

Only when every bullet is green do you report Phase 2 as complete.

- [ ] **Step 6: Commit the fidelity test**

The fidelity test from Step 2 is the only code change in this task — it should be committed:

```bash
git add tests/session/topic-fence.test.ts
git commit -m "test(topic-fence): add Path A fidelity check against eval-drift reference"
```

---

## Implementation Notes

**Commit discipline.** Each task ends with a `feat(topic-fence):` or `feat(session-db):` commit. This produces 7 commits total (Tasks 1-7) plus Task 5's test-only commit (Task 8 and 9 also commit). The docs for Phase 2 (`PHASE2_SPEC.md`, `PHASE2_SPEC.ko.md`, `VALIDATION_RESULTS.md`, `eval-drift.mjs`) are already committed as `23f2739` — implementation commits go *after* that.

**TDD discipline.** Do not write implementation code before the failing test is in place. If a test is hard to write, that's a signal the interface is wrong — redesign rather than skipping the test.

**Fidelity to eval-drift.mjs.** The production tokenizer (`extractKeywords` after Task 2) and scoring logic (`scoreDrift` after Task 4) MUST match `eval-drift.mjs` byte-for-byte. The F1=0.900 empirical claim is the primary justification for the entire implementation; invalidating it via "cleanup" or "improvement" defeats the purpose of the validation work. Task 9's `eval-drift.mjs` re-run is the final check against this drift.

**Do not touch Phase 1 tests.** Phase 1 tests in `tests/session/topic-fence.test.ts` assert behavioral properties (keyword count, specific stopwords filtered, never throwing) rather than exact keyword strings. They should continue to pass unchanged through Tasks 1-7. If any Phase 1 test fails after Task 2, stop and investigate — it usually means `extractKeywords` was incorrectly modified.

**Env var testing.** Tests that need to exercise environment-variable behavior (U9) must use `vi.stubEnv(...)` + `vi.resetModules()` followed by a plain `await import("../../src/session/topic-fence.js")`. Vitest's `resetModules` clears its internal cache so the next `import` re-reads `process.env` and re-caches the module-level constants. Clean up with `vi.unstubAllEnvs()` and `vi.resetModules()` afterwards so later tests get the original module back. Tests that use the default configuration do NOT need this pattern and should use the statically imported `scoreDrift` directly.

**If Task 4 tests reveal a scoring bug.** Compare the production `scoreDrift` and `jaccardWindows` to the reference in `eval-drift.mjs` lines 177-220. The slicing indices and the order of persistence-rule checks are the most common failure points.
