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
