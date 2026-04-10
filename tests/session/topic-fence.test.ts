import { strict as assert } from "node:assert";
import { describe, test } from "vitest";
import { extractUserEvents } from "../../src/session/extract.js";
import { extractKeywords, extractTopicSignal } from "../../src/session/topic-fence.js";

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
