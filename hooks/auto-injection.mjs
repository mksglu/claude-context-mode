/**
 * Auto-injection for compaction events.
 *
 * Builds a prioritized, budget-capped injection block from session events.
 * Only fires on source === "compact" (wired in sessionstart.mjs).
 *
 * Priority order:
 *   P1: Role (behavioral_directive) — always first, never truncated
 *   P2: Decisions (rules) — latest 5, overflow reduces to 3
 *   P3: Skills (active_skills) — unique names, latest 10
 *   P4: Intent (session_mode) — latest
 *
 * Hard cap: 500 tokens (~2000 chars at 4 chars/token).
 */

/**
 * Rough token estimate: ~4 chars per token.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Build auto-injection block from session events.
 * @param {Array<{category: string, data: string}>} events
 * @returns {string} XML block or empty string
 */
export function buildAutoInjection(events) {
  // Single O(N) pass instead of 4× O(N) Array.filter() loops. UserPromptSubmit
  // fires this on every prompt; with N up to 100 events the prior implementation
  // walked the array 4 times per prompt — wasteful on macOS, painful on Windows
  // where V8 cold paths cost more.
  let role;
  const decisionsAll = [];
  const skillsSeen = new Set();
  const skillsOrdered = [];
  let intent;
  for (const e of events) {
    switch (e.category) {
      case "role":
        role = e;
        break;
      case "decision":
        decisionsAll.push(e);
        break;
      case "skill":
        if (!skillsSeen.has(e.data)) {
          skillsSeen.add(e.data);
          skillsOrdered.push(e.data);
        }
        break;
      case "intent":
        intent = e;
        break;
    }
  }

  const parts = [];
  let budget = 500; // hard cap in tokens

  // P1: Role (always first, never truncated from output)
  if (role) {
    const text = `<behavioral_directive>\n${role.data.slice(0, 400)}\n</behavioral_directive>`;
    parts.push(text);
    budget -= estimateTokens(text);
  }

  // P2: Decisions (latest 5)
  const decisions = decisionsAll.slice(-5);
  if (decisions.length > 0) {
    const lines = decisions.map(d => `- ${d.data.slice(0, 100)}`).join("\n");
    const text = `<rules>\nFollow these decisions:\n${lines}\n</rules>`;
    const cost = estimateTokens(text);
    if (cost <= budget) {
      parts.push(text);
      budget -= cost;
    } else {
      // Overflow: reduce to 3 decisions
      const reduced = decisions.slice(-3).map(d => `- ${d.data.slice(0, 100)}`).join("\n");
      const fallback = `<rules>\nFollow these decisions:\n${reduced}\n</rules>`;
      parts.push(fallback);
      budget -= estimateTokens(fallback);
    }
  }

  // P3: Skills (unique names, latest 10)
  if (skillsOrdered.length > 0 && budget > 50) {
    const text = `<active_skills>\nRe-invoke if relevant: ${skillsOrdered.slice(-10).join(", ")}\nTo reload: call the Skill tool with the skill name.\n</active_skills>`;
    parts.push(text);
    budget -= estimateTokens(text);
  }

  // P4: Intent (latest)
  if (intent && budget > 20) {
    parts.push(`<session_mode>${intent.data}</session_mode>`);
  }

  if (parts.length === 0) return "";
  return `<session_state source="compaction">\n\n${parts.join("\n\n")}\n\n</session_state>`;
}
