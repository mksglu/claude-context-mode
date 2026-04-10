/**
 * topic-fence — Topic drift detection for context-mode sessions.
 *
 * Pure functions only. Zero external dependencies. Hot path: <5ms per call,
 * invoked from UserPromptSubmit hook via extractUserEvents().
 *
 * Phase 1 (this file): Extract topic keywords from each user message and
 * emit a "topic" SessionEvent for later drift scoring (Phase 2).
 *
 * Design rationale: Jaccard similarity (used in Phase 2) is a *relative*
 * comparison. A morphologically perfect tokenizer is unnecessary because
 * any consistent tokenizer preserves drift signal across sliding windows.
 * This keeps the hot-path constraint achievable with a pure regex
 * approach — no native deps, no dictionary loading, no network.
 *
 * See .claude/skills/topic-fence/ for the full phased plan.
 */

import type { SessionEvent } from "./extract.js";

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

const STOPWORDS_EN = new Set([
  "the","a","an","is","are","was","were","be","been","being",
  "have","has","had","do","does","did","will","would","could",
  "should","may","might","shall","can","need","dare","ought",
  "i","you","he","she","it","we","they","me","him","her","us",
  "my","your","his","its","our","their","this","that","these",
  "those","what","which","who","whom","whose","when","where",
  "how","why","not","no","nor","as","at","by","for","from",
  "in","into","of","on","or","to","with","and","but","if",
  "then","than","too","very","just","about","above","after",
  "before","between","both","each","few","more","most","other",
  "some","such","only","own","same","so","also","any","all",
  "please","thanks","thank","hello","hi","hey","ok","okay",
]);

const STOPWORDS_KO = new Set([
  "은","는","이","가","을","를","의","에","에서","로","으로",
  "와","과","도","만","부터","까지","에게","한테","께",
  "그","저","이것","그것","저것","여기","거기","저기",
  "하다","있다","없다","되다","않다","수","것","등","및",
  "좀","네","예","아니","뭐","어떻게","왜","어디",
]);

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

const TOPIC_MAX_KEYWORDS = 8;
const TOPIC_MIN_KEYWORDS = 2;

/**
 * Tokenize a message into lowercased, stopword-filtered keywords, ranked by
 * frequency. Preserves Hangul characters. Pure function.
 *
 * The regex keeps `\w` (A-Za-z0-9_), whitespace, and Korean consonants +
 * syllable blocks; everything else becomes a space. Tokens shorter than 2
 * chars and stopword hits are dropped. Results are capped at
 * TOPIC_MAX_KEYWORDS.
 */
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

/**
 * Extract a topic signal event from a user message, or return [] when the
 * message is too short to carry meaningful drift signal.
 *
 * Emits at most one event:
 *   { type: "topic", category: "topic", data: JSON({keywords}), priority: 3 }
 *
 * Priority 3 matches other hot-path metadata events (skill/mcp/glob) and
 * ensures topic rows survive FIFO eviction long enough to populate the
 * Phase 2 sliding window.
 */
export function extractTopicSignal(message: string): SessionEvent[] {
  const keywords = extractKeywords(message);
  if (keywords.length < TOPIC_MIN_KEYWORDS) return [];

  return [{
    type: "topic",
    category: "topic",
    data: JSON.stringify({ keywords }),
    priority: 3,
  }];
}

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
