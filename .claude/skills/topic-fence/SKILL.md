---
name: topic-fence
description: |
  Topic drift detection extension for context-mode.
  Use when working on topic-fence implementation: extractTopicSignal,
  drift scoring, session split recommendations, or related tests.
---

# topic-fence — Real-time Topic Drift Detection for context-mode

## What This Is

An extension to context-mode that detects when a new, unrelated topic
silently creeps into an ongoing session. When drift is detected,
it recommends splitting into a new session to prevent attention pollution.

**context-fence** solves token budget (space management).
**topic-fence** solves attention pollution (direction management).
They are complementary.

No existing tool in the LLM ecosystem provides this capability (as of 2026-04-10).

## Architecture

### Why context-mode as the Base
- SQLite-backed session event storage already exists
- Hook system (UserPromptSubmit, PostToolUse, PreCompact, SessionStart) enables per-turn intervention
- `extractUserEvents()` pattern is directly extensible
- 12-platform support (Claude Code, Gemini CLI, Cursor, etc.)

### Key Source Files
```
src/session/extract.ts    — Event extraction (pure functions). Add topic extraction here
src/session/db.ts         — SessionDB. Store topic category events
src/session/snapshot.ts   — XML snapshot builder. Add drift warning section
src/session/analytics.ts  — Analytics engine. Add drift statistics
hooks/userpromptsubmit.mjs — UserPromptSubmit hook entry point
hooks/precompact.mjs      — PreCompact hook entry point
hooks/hooks.json          — Hook configuration
src/types.ts              — Shared types
```

### Existing Event Categories (13 tool + 4 user)
- Tool: file, rule, cwd, error, git, task, plan, skill, subagent, mcp, decision, worktree, env
- User: decision, role, intent, data
- **New categories: topic, topic_drift**

### Pattern to Follow
```typescript
// From extract.ts — topic-fence follows this exact structure
const INTENT_PATTERNS: Array<{ mode: string; pattern: RegExp }> = [
  { mode: "investigate", pattern: /\b(why|how does|explain|...)\b/i },
  { mode: "implement",   pattern: /\b(create|add|build|...)\b/i },
];

function extractIntent(message: string): SessionEvent[] {
  const match = INTENT_PATTERNS.find(({ pattern }) => pattern.test(message));
  if (!match) return [];
  return [{ type: "intent", category: "intent", data: match.mode, priority: 4 }];
}
```

## Implementation Phases

### Phase 1: Topic Signal Extraction
Add `extractTopicSignal()` to `extract.ts`.
Extract topic keywords from each user message via regex-based stopword removal.
Store as `topic` category in SessionDB.
Performance constraint: <5ms per call (UserPromptSubmit hook total budget <10ms). No network, no LLM, no external deps.
See PHASE1_SPEC.md for detailed specification.

### Phase 2: Drift Scoring
Query last N topic events from SessionDB.
Compute Jaccard similarity across sliding windows.
When similarity drops below threshold → emit `topic_drift` event.
Window size and threshold must be configurable.

### Phase 3: User Notification
Include drift warning in UserPromptSubmit hook output.
Add `<topic_drift>` section to PreCompact snapshot.
Message format: "Topic has shifted. Consider starting a new session."

### Phase 4: Tests & Documentation
Follow existing vitest structure in tests/ directory.
Add feature documentation to README.

## Constraints
- Pure functions first (follow extract.ts pattern)
- Hooks must never block (<20ms, try-catch with silent fallback)
- No external dependencies for keyword extraction
- All code in English, docs can be bilingual
