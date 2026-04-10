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

  for (const token of tokens) {
    if (token.length < 2) continue;
    if (STOPWORDS_EN.has(token)) continue;
    if (STOPWORDS_KO.has(token)) continue;
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
