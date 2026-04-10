import { strict as assert } from "node:assert";
import { describe, test } from "vitest";
import { extractUserEvents } from "../../src/session/extract.js";
import { clampFloat, clampInt, extractKeywords, extractTopicSignal, stem } from "../../src/session/topic-fence.js";

// ════════════════════════════════════════════
// topic-fence Phase 1 — extractTopicSignal
// ════════════════════════════════════════════
//
// These tests live in a dedicated file (rather than session-extract.test.ts)
// so that topic-fence can be maintained and eventually extracted as a
// standalone skill without pulling the full session extraction test surface
// along with it. The tests exercise the module both directly and through
// the extractUserEvents() integration point.

describe("Topic Signal Events — via extractUserEvents", () => {
  test("emits topic event with correct shape for keyword-rich English message", () => {
    const events = extractUserEvents("Implementing drift detection in context-mode");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 1, "should emit exactly one topic event");
    assert.equal(topicEvents[0].category, "topic");
    assert.equal(topicEvents[0].priority, 3);
    assert.equal(typeof topicEvents[0].data, "string");
  });

  test("stores keywords as JSON with a keywords array", () => {
    const events = extractUserEvents("Implementing drift detection in context-mode");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 1);
    const parsed = JSON.parse(topicEvents[0].data);
    assert.ok(Array.isArray(parsed.keywords), "data.keywords must be an array");
    assert.ok(parsed.keywords.length >= 2, "should have at least 2 keywords");
    // English stopwords ("in") must be filtered
    assert.ok(!parsed.keywords.includes("in"), "'in' is a stopword and must be filtered");
  });

  test("does not emit topic event for a single short word", () => {
    const events = extractUserEvents("yes");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 0, "single-keyword message should not emit topic event");
  });

  test("does not emit topic event for stopwords-only message", () => {
    const events = extractUserEvents("the is a an of to");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 0, "stopwords-only message should not emit topic event");
  });

  test("orders keywords by frequency (most frequent first)", () => {
    const events = extractUserEvents("auth auth auth login login database");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 1);
    const { keywords } = JSON.parse(topicEvents[0].data);
    assert.deepEqual(keywords, ["auth", "login", "database"]);
  });

  test("caps keyword count at 8", () => {
    const events = extractUserEvents(
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu",
    );
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 1);
    const { keywords } = JSON.parse(topicEvents[0].data);
    assert.ok(keywords.length <= 8, `expected <= 8 keywords, got ${keywords.length}`);
  });

  test("handles Korean text without throwing and preserves Hangul tokens", () => {
    const events = extractUserEvents("세션을 나눠서 진행할 수 있도록 감지해서 알려주는 기능");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 1);
    const { keywords } = JSON.parse(topicEvents[0].data);
    assert.ok(keywords.length >= 2, "Korean message should produce keywords");
    for (const kw of keywords) {
      assert.ok(
        /[가-힣]/.test(kw) || /^[a-z]+$/.test(kw),
        `keyword "${kw}" should contain Hangul or be ASCII`,
      );
    }
  });

  test("handles mixed English-Korean dev text", () => {
    const events = extractUserEvents("context-mode에서 topic drift를 감지하려고 합니다");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 1);
    const { keywords } = JSON.parse(topicEvents[0].data);
    assert.ok(keywords.includes("context"), "should include 'context' after hyphen split");
    assert.ok(keywords.includes("topic"), "should include 'topic'");
  });

  test("lowercases tokens for case-insensitive matching", () => {
    const events = extractUserEvents("AUTH Auth auth LOGIN Login");
    const topicEvents = events.filter(e => e.type === "topic");
    assert.equal(topicEvents.length, 1);
    const { keywords } = JSON.parse(topicEvents[0].data);
    assert.deepEqual(keywords, ["auth", "login"]);
  });

  test("topic event is produced alongside other user event types", () => {
    const events = extractUserEvents("Create a drift detection module for sessions");
    const types = new Set(events.map(e => e.type));
    assert.ok(types.has("topic"), "topic event should coexist with intent event");
    assert.ok(types.has("intent"), "intent event should still be emitted");
  });

  test("executes within performance budget (<5ms for typical message)", () => {
    const msg = "Implementing drift detection in context-mode using Jaccard similarity over sliding windows";
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      extractUserEvents(msg);
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / 100;
    assert.ok(
      perCall < 5,
      `extractUserEvents should run <5ms per call, got ${perCall.toFixed(3)}ms`,
    );
  });

  test("never throws on pathological input", () => {
    assert.doesNotThrow(() => extractUserEvents(""));
    assert.doesNotThrow(() => extractUserEvents("   "));
    assert.doesNotThrow(() => extractUserEvents("!@#$%^&*()"));
    assert.doesNotThrow(() => extractUserEvents("\n\n\n"));
    assert.doesNotThrow(() => extractUserEvents("a".repeat(100000)));
  });
});

// ════════════════════════════════════════════
// Direct unit tests for extractKeywords / extractTopicSignal
// ════════════════════════════════════════════

describe("extractKeywords — direct unit tests", () => {
  test("returns empty array for empty string", () => {
    assert.deepEqual(extractKeywords(""), []);
  });

  test("returns empty array when all tokens are stopwords", () => {
    assert.deepEqual(extractKeywords("the a an is"), []);
  });

  test("preserves frequency order", () => {
    assert.deepEqual(
      extractKeywords("auth auth login"),
      ["auth", "login"],
    );
  });

  test("is idempotent on repeated calls", () => {
    const msg = "Implementing drift detection in context-mode";
    assert.deepEqual(extractKeywords(msg), extractKeywords(msg));
  });

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
});

describe("extractTopicSignal — direct unit tests", () => {
  test("returns empty array when keywords < 2", () => {
    assert.deepEqual(extractTopicSignal("yes"), []);
    assert.deepEqual(extractTopicSignal("the is a"), []);
  });

  test("returns exactly one event with 4-field SessionEvent shape", () => {
    const events = extractTopicSignal("auth auth login database");
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.type, "topic");
    assert.equal(ev.category, "topic");
    assert.equal(ev.priority, 3);
    assert.equal(typeof ev.data, "string");
    // Must NOT carry data_hash — that's a persistence-layer concern
    assert.ok(!("data_hash" in ev), "extractors must not emit data_hash");
  });

  test("data field is valid JSON with only a keywords array", () => {
    const events = extractTopicSignal("auth auth login database");
    const parsed = JSON.parse(events[0].data);
    assert.deepEqual(Object.keys(parsed), ["keywords"]);
    assert.deepEqual(parsed.keywords, ["auth", "login", "database"]);
  });
});

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
