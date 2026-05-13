/**
 * Multilingual extract-user-events behavior tests.
 *
 * Verifies that universal-rule detectors (structural / Unicode-aware) work
 * for any human language — not just the keyword sets baked into the old
 * keyword arrays. Drives behavior through the public `extractUserEvents`
 * interface so the tests survive any internal refactor.
 *
 * Issue: mksglu/context-mode#535
 */

import { strict as assert } from "node:assert";
import { describe, test } from "vitest";
import { extractUserEvents } from "../../src/session/extract.js";
import type { SessionEvent } from "../../src/session/extract.js";
import { buildResumeSnapshot, type StoredEvent } from "../../src/session/snapshot.js";

function makeUserPromptEvent(data: string, isoTimestamp?: string): StoredEvent {
  return {
    type: "user_prompt",
    category: "user-prompt",
    data,
    priority: 1,
    created_at: isoTimestamp ?? new Date().toISOString(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findEvent(events: SessionEvent[], type: string): SessionEvent | undefined {
  return events.find(e => e.type === type);
}

function intentMode(message: string): string | undefined {
  const events = extractUserEvents(message);
  return findEvent(events, "intent")?.data;
}

function hasDecision(message: string): boolean {
  return Boolean(findEvent(extractUserEvents(message), "decision"));
}

function hasRole(message: string): boolean {
  return Boolean(findEvent(extractUserEvents(message), "role"));
}

function hasBlocker(message: string): boolean {
  return Boolean(findEvent(extractUserEvents(message), "blocker"));
}

function hasBlockerResolved(message: string): boolean {
  return Boolean(findEvent(extractUserEvents(message), "blocker_resolved"));
}

// ════════════════════════════════════════════════════════════════════════════
// SLICE 1: investigate intent via Unicode question-mark family
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 1: investigate intent — Chinese fullwidth question mark", () => {
  test('"为什么这个 hook 没有触发？" yields mode:"investigate"', () => {
    assert.equal(intentMode("为什么这个 hook 没有触发？"), "investigate");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE 2: investigate intent via Arabic question mark
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 2: investigate intent — Arabic question mark U+061F", () => {
  test('"لماذا لم يعمل هذا؟" yields mode:"investigate"', () => {
    assert.equal(intentMode("لماذا لم يعمل هذا؟"), "investigate");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE 3: investigate intent via Spanish opening question mark U+00BF
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 3: investigate intent — Spanish opening ¿", () => {
  test('"¿Por qué falla esto?" yields mode:"investigate"', () => {
    assert.equal(intentMode("¿Por qué falla esto?"), "investigate");
  });

  test('opening-only "¿qué hora es" still yields mode:"investigate"', () => {
    // Some users drop the closing mark on chat / mobile keyboards.
    assert.equal(intentMode("¿qué hora es"), "investigate");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE 4: implement intent — short directive without a question mark
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 4: implement intent — short imperative across scripts", () => {
  test('English "add login page" yields mode:"implement"', () => {
    assert.equal(intentMode("add login page"), "implement");
  });

  test('mixed Japanese/Latin "登录页面を作って" yields mode:"implement"', () => {
    assert.equal(intentMode("登录页面を作って"), "implement");
  });

  test('Spanish "crear página de inicio" yields mode:"implement"', () => {
    assert.equal(intentMode("crear página de inicio"), "implement");
  });

  test('Turkish "giriş sayfası ekle" yields mode:"implement"', () => {
    assert.equal(intentMode("giriş sayfası ekle"), "implement");
  });

  test('a long paragraph without `?` does NOT yield implement (too discursive)', () => {
    // 80+ chars of running text should fall through, not be classified.
    const longRun =
      "We have been discussing this architecture for a while now and there is a lot to unpack here.";
    assert.notEqual(intentMode(longRun), "implement");
  });

  test('a message ending with `?` yields investigate not implement', () => {
    assert.equal(intentMode("add login page?"), "investigate");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE 5: decision — language-agnostic via negation/alternation structure
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 5: decision — universal negation+alternative pattern", () => {
  test('English "don\'t use useState, use useReducer instead" is a decision', () => {
    assert.ok(hasDecision("don't use useState, use useReducer instead"));
  });

  test('Russian "не используй X, используй Y вместо" is a decision', () => {
    assert.ok(hasDecision("не используй X, используй Y вместо"));
  });

  test('Chinese "不要用 setState，用 useReducer" is a decision', () => {
    assert.ok(hasDecision("不要用 setState，用 useReducer"));
  });

  test('Turkish "useState kullanma, useReducer kullan" is a decision', () => {
    assert.ok(hasDecision("useState kullanma, useReducer kullan"));
  });

  test('a plain question is NOT a decision', () => {
    assert.equal(hasDecision("what time is it?"), false);
  });

  test('a single-word noun is NOT a decision', () => {
    assert.equal(hasDecision("test"), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE 6: role — structural persona statement across scripts
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 6: role — second-person persona statements across scripts", () => {
  test('English "You are a senior backend engineer" is a role', () => {
    assert.ok(hasRole("You are a senior backend engineer"));
  });

  test('French "Tu es un développeur senior" is a role', () => {
    assert.ok(hasRole("Tu es un développeur senior"));
  });

  test('Japanese "あなたは経験豊富なエンジニアです" is a role', () => {
    assert.ok(hasRole("あなたは経験豊富なエンジニアです"));
  });

  test('Turkish "Sen kıdemli bir backend mühendisisin" is a role', () => {
    assert.ok(hasRole("Sen kıdemli bir backend mühendisisin"));
  });

  test('a question is NOT a role', () => {
    assert.equal(hasRole("what time is it?"), false);
  });

  test('a long discursive paragraph is NOT a role', () => {
    const longRun =
      "We have been discussing this architecture for a while and there are several trade-offs to weigh before committing to any single approach right now.";
    assert.equal(hasRole(longRun), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE 7: blocker — programming-domain markers (language-neutral)
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 7: blocker — programming-domain error markers", () => {
  test('"Error: cannot read property" is a blocker', () => {
    assert.ok(hasBlocker("Error: cannot read property"));
  });

  test('Python "Traceback (most recent call last):" is a blocker', () => {
    assert.ok(hasBlocker("Traceback (most recent call last):"));
  });

  test('Java "Exception: NullPointerException" is a blocker', () => {
    assert.ok(hasBlocker("Exception: NullPointerException at line 42"));
  });

  test('Chinese-localised "Error: 找不到模块" is a blocker', () => {
    // Programming-domain markers like `Error:` are emitted by tooling
    // regardless of the user's native language — they are universal.
    assert.ok(hasBlocker("Error: 找不到模块"));
  });

  test('a plain greeting is NOT a blocker', () => {
    assert.equal(hasBlocker("hello there"), false);
  });

  test('a question is NOT a blocker', () => {
    assert.equal(hasBlocker("why does this fail?"), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE 8: blocker_resolved — Unicode checkmark / structural marker
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 8: blocker_resolved — Unicode checkmark or marker prefix", () => {
  test('"✅ Fixed the auth bug" is a resolved blocker', () => {
    assert.ok(hasBlockerResolved("✅ Fixed the auth bug"));
  });

  test('"✓ done" (light checkmark) is a resolved blocker', () => {
    assert.ok(hasBlockerResolved("✓ done"));
  });

  test('"🎉 ship it" (emoji celebration) is a resolved blocker', () => {
    assert.ok(hasBlockerResolved("🎉 ship it"));
  });

  test('"fixed: 修复了登录问题" (cross-script marker prefix) is a resolved blocker', () => {
    assert.ok(hasBlockerResolved("fixed: 修复了登录问题"));
  });

  test('"resolved: cache miss in dev" is a resolved blocker', () => {
    assert.ok(hasBlockerResolved("resolved: cache miss in dev"));
  });

  test('a checkmark beats a blocker marker — emits ONLY resolved', () => {
    const events = extractUserEvents("✅ Error: cannot read property (was a stale build)");
    assert.equal(events.filter(e => e.type === "blocker_resolved").length, 1);
    assert.equal(events.filter(e => e.type === "blocker").length, 0);
  });

  test('a message without checkmark/marker is NOT resolved', () => {
    assert.equal(hasBlockerResolved("the bug is back"), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE 9: <recent_user_messages> raw-prompt fallback in the snapshot
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 9: recent_user_messages safety-net section", () => {
  test('buildResumeSnapshot renders the last 3 user prompts verbatim', () => {
    const events: StoredEvent[] = [
      makeUserPromptEvent("first prompt that should be dropped"),
      makeUserPromptEvent("второе сообщение"),
      makeUserPromptEvent("第三条消息"),
      makeUserPromptEvent("الرسالة الأخيرة"),
    ];
    const xml = buildResumeSnapshot(events);

    assert.ok(xml.includes("<recent_user_messages"), "should emit the section");
    assert.ok(xml.includes("</recent_user_messages>"), "should close the section");
    assert.ok(xml.includes("второе сообщение"), "should keep Russian prompt");
    assert.ok(xml.includes("第三条消息"), "should keep Chinese prompt");
    assert.ok(xml.includes("الرسالة الأخيرة"), "should keep Arabic prompt");
    assert.ok(!xml.includes("first prompt that should be dropped"), "should drop older prompts");
  });

  test('individual prompts longer than 400 chars are truncated', () => {
    const long = "a".repeat(800);
    const xml = buildResumeSnapshot([makeUserPromptEvent(long)]);
    assert.ok(xml.includes("<recent_user_messages"));
    // The truncated message should be present but shorter than the original.
    const aRuns = xml.match(/a+/g) ?? [];
    const longestRun = aRuns.reduce((m, r) => Math.max(m, r.length), 0);
    assert.ok(
      longestRun <= 400,
      `expected longest run of 'a' ≤ 400, got ${longestRun}`,
    );
  });

  test('no user_prompt events -> section is omitted', () => {
    const xml = buildResumeSnapshot([]);
    assert.equal(xml.includes("<recent_user_messages"), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE 10: cross-language regression guards — 8 languages × 5 categories
// ════════════════════════════════════════════════════════════════════════════

/**
 * Each language contributes one fixture per universal-rule category.
 * The expectation columns capture the structural shape — not the
 * spoken-language keyword. If a future refactor preserves the
 * universal-rule semantics, every fixture stays green; if it drifts
 * back to keyword matching, this matrix catches the regression.
 */
type CategoryExpectation = {
  intent?: string | null;
  decision?: boolean;
  role?: boolean;
  blocker?: boolean;
  blockerResolved?: boolean;
};

const LANGUAGE_MATRIX: Array<{
  language: string;
  message: string;
  expect: CategoryExpectation;
}> = [
  // ── English ──
  { language: "English",  message: "why does the hook not fire?",                       expect: { intent: "investigate" } },
  { language: "English",  message: "add login page",                                    expect: { intent: "implement" } },
  { language: "English",  message: "don't use useState, use useReducer instead",        expect: { decision: true } },
  { language: "English",  message: "You are a senior backend engineer",                 expect: { role: true } },
  { language: "English",  message: "Error: cannot read property",                       expect: { blocker: true } },
  { language: "English",  message: "✅ Fixed the auth bug",                             expect: { blockerResolved: true } },

  // ── Turkish ──
  { language: "Turkish",  message: "neden bu hook çalışmıyor?",                         expect: { intent: "investigate" } },
  { language: "Turkish",  message: "giriş sayfası ekle",                                expect: { intent: "implement" } },
  { language: "Turkish",  message: "useState kullanma, useReducer kullan",              expect: { decision: true } },
  { language: "Turkish",  message: "Sen kıdemli bir backend mühendisisin",              expect: { role: true } },
  { language: "Turkish",  message: "Exception: NullPointerException",                   expect: { blocker: true } },
  { language: "Turkish",  message: "fixed: auth hatası giderildi",                      expect: { blockerResolved: true } },

  // ── Chinese ──
  { language: "Chinese",  message: "为什么这个 hook 没有触发？",                        expect: { intent: "investigate" } },
  { language: "Chinese",  message: "创建登录页面",                                       expect: { intent: "implement" } },
  { language: "Chinese",  message: "不要用 setState，用 useReducer",                    expect: { decision: true } },
  { language: "Chinese",  message: "你是一名资深后端工程师",                            expect: { role: true } },
  { language: "Chinese",  message: "Error: 找不到模块",                                  expect: { blocker: true } },
  { language: "Chinese",  message: "fixed: 修复了登录问题",                              expect: { blockerResolved: true } },

  // ── Arabic ──
  { language: "Arabic",   message: "لماذا لم يعمل هذا؟",                                 expect: { intent: "investigate" } },
  { language: "Arabic",   message: "أضف صفحة تسجيل الدخول",                              expect: { intent: "implement" } },
  { language: "Arabic",   message: "لا تستخدم X، استخدم Y بدلاً من ذلك",                expect: { decision: true } },
  { language: "Arabic",   message: "أنت مهندس واجهات خلفية محترف",                       expect: { role: true } },
  { language: "Arabic",   message: "Traceback (most recent call last):",                expect: { blocker: true } },
  { language: "Arabic",   message: "✓ تم الإصلاح",                                       expect: { blockerResolved: true } },

  // ── Russian ──
  { language: "Russian",  message: "почему этот хук не срабатывает?",                   expect: { intent: "investigate" } },
  { language: "Russian",  message: "добавь страницу входа",                              expect: { intent: "implement" } },
  { language: "Russian",  message: "не используй X, используй Y вместо",                expect: { decision: true } },
  { language: "Russian",  message: "Ты опытный backend-инженер",                        expect: { role: true } },
  { language: "Russian",  message: "Error: модуль не найден",                            expect: { blocker: true } },
  { language: "Russian",  message: "resolved: кеш починили",                             expect: { blockerResolved: true } },

  // ── Spanish ──
  { language: "Spanish",  message: "¿por qué falla esto?",                              expect: { intent: "investigate" } },
  { language: "Spanish",  message: "crear página de inicio",                            expect: { intent: "implement" } },
  { language: "Spanish",  message: "no uses useState, usa useReducer en su lugar",      expect: { decision: true } },
  { language: "Spanish",  message: "Eres un ingeniero backend senior",                  expect: { role: true } },
  { language: "Spanish",  message: "Error: módulo no encontrado",                       expect: { blocker: true } },
  { language: "Spanish",  message: "🎉 listo en producción",                            expect: { blockerResolved: true } },

  // ── Hindi ──
  { language: "Hindi",    message: "यह hook क्यों नहीं चलता?",                            expect: { intent: "investigate" } },
  { language: "Hindi",    message: "लॉगिन पेज जोड़ो",                                    expect: { intent: "implement" } },
  { language: "Hindi",    message: "useState मत लो, useReducer लो",                     expect: { decision: true } },
  { language: "Hindi",    message: "तुम एक senior backend इंजीनियर हो",                  expect: { role: true } },
  { language: "Hindi",    message: "Exception: कनेक्शन टूट गया",                          expect: { blocker: true } },
  { language: "Hindi",    message: "✅ बग ठीक हो गया",                                    expect: { blockerResolved: true } },

  // ── Japanese ──
  { language: "Japanese", message: "なぜこのフックは動かない？",                          expect: { intent: "investigate" } },
  { language: "Japanese", message: "ログインページを作って",                              expect: { intent: "implement" } },
  { language: "Japanese", message: "useState を使わないで、useReducer を使って",          expect: { decision: true } },
  { language: "Japanese", message: "あなたは経験豊富なエンジニアです",                    expect: { role: true } },
  { language: "Japanese", message: "Error: モジュールが見つかりません",                    expect: { blocker: true } },
  { language: "Japanese", message: "fixed: ログインのバグを修正",                          expect: { blockerResolved: true } },
];

describe("Slice 10: 8-language × 5-category regression matrix", () => {
  for (const { language, message, expect: expected } of LANGUAGE_MATRIX) {
    test(`${language} :: "${message.slice(0, 40)}…"`, () => {
      const events = extractUserEvents(message);

      if (expected.intent !== undefined) {
        const got = events.find(e => e.type === "intent")?.data;
        assert.equal(got, expected.intent ?? undefined, `intent: ${language}`);
      }
      if (expected.decision !== undefined) {
        const has = Boolean(events.find(e => e.type === "decision"));
        assert.equal(has, expected.decision, `decision: ${language}`);
      }
      if (expected.role !== undefined) {
        const has = Boolean(events.find(e => e.type === "role"));
        assert.equal(has, expected.role, `role: ${language}`);
      }
      if (expected.blocker !== undefined) {
        const has = Boolean(events.find(e => e.type === "blocker"));
        assert.equal(has, expected.blocker, `blocker: ${language}`);
      }
      if (expected.blockerResolved !== undefined) {
        const has = Boolean(events.find(e => e.type === "blocker_resolved"));
        assert.equal(has, expected.blockerResolved, `blocker_resolved: ${language}`);
      }
    });
  }

  test('non-English recall is non-zero across every detector', () => {
    // Recall sanity check across all 7 non-English languages.
    const buckets: Record<string, number> = {
      investigate: 0,
      implement: 0,
      decision: 0,
      role: 0,
      blocker: 0,
      blocker_resolved: 0,
    };
    for (const { language, message, expect: expected } of LANGUAGE_MATRIX) {
      if (language === "English") continue;
      const events = extractUserEvents(message);
      if (expected.intent === "investigate" && events.find(e => e.type === "intent" && e.data === "investigate")) buckets.investigate++;
      if (expected.intent === "implement"   && events.find(e => e.type === "intent" && e.data === "implement"))   buckets.implement++;
      if (expected.decision && events.find(e => e.type === "decision")) buckets.decision++;
      if (expected.role     && events.find(e => e.type === "role"))     buckets.role++;
      if (expected.blocker  && events.find(e => e.type === "blocker"))  buckets.blocker++;
      if (expected.blockerResolved && events.find(e => e.type === "blocker_resolved")) buckets.blocker_resolved++;
    }
    for (const [bucket, count] of Object.entries(buckets)) {
      assert.ok(count >= 5, `${bucket} recall should be ≥5 across 7 non-EN languages, got ${count}`);
    }
  });
});
