import "./setup-home";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Slice 7 (bonus, from PR #376) — OpenCode added SessionStart support
 * via `experimental.chat.messages.transform`. The plugin should
 * register that hook so prior-session continuity now works on OpenCode
 * the same way it does on Claude Code / Gemini / Qwen.
 *
 * Static guard against regression of the wired hook.
 */

const SRC = readFileSync(
  resolve(__dirname, "../src/opencode-plugin.ts"),
  "utf-8",
);

describe("OpenCode plugin — experimental.chat.messages.transform", () => {
  it("registers experimental.chat.messages.transform hook", () => {
    expect(SRC).toMatch(/"experimental\.chat\.messages\.transform"/);
  });

  it("uses the hook to inject prior-session content (SessionStart equivalent)", () => {
    // The transform hook body should reference db.getResume / snapshot —
    // matching the SessionStart pattern used by every other adapter.
    const idx = SRC.indexOf('"experimental.chat.messages.transform"');
    expect(idx).toBeGreaterThan(0);
    const block = SRC.slice(idx, idx + 1500);
    expect(block).toMatch(/getResume|buildResumeSnapshot|snapshot/);
  });
});
