---
name: topic-fence
description: |
  Real-time topic drift detection for context-mode sessions.
  Detects when a new, unrelated topic creeps into an ongoing conversation
  and (eventually) recommends splitting into a fresh session to prevent
  attention pollution. Complementary to context-mode itself:
  context-mode manages the token budget, topic-fence manages the direction.
  Runs automatically on every user prompt — no explicit invocation required.
---

# topic-fence

Topic drift detection extension for context-mode.

## Status

**Phase 1 — Signal Collection (shipped).** Every user prompt is tokenized
into topic keywords and stored as a `topic` category event in SessionDB.
No user-facing surface yet. No drift scoring, no notifications. The
signals accumulate silently so later phases can tune real drift
thresholds against real data.

**Phase 2 — Drift Scoring (planned).** Jaccard similarity over a sliding
window of recent topic events. Emits `topic_drift` events when the
similarity drops below a tuned threshold.

**Phase 3 — User Notification (planned).** Drift warnings appear inside
the UserPromptSubmit hook output and the PreCompact snapshot. Message:
*"Topic has shifted. Consider starting a new session."*

## How It Works

Runs automatically — nothing for the user to invoke. On every user
prompt, `src/session/topic-fence.ts::extractTopicSignal()` is called from
`extractUserEvents()` inside the `UserPromptSubmit` hook. Budget: <5ms
per call, zero external dependencies, regex-based stopword filtering
(English + Korean).

Topic events are stored at priority 3 (NORMAL) so they survive FIFO
eviction long enough to feed the Phase 2 sliding window.

## Design Philosophy

> *"It is a fence, not a wall — it marks the boundary and alerts when
> something crosses it, with context-aware guidance on what to do about
> it."*

topic-fence never filters messages, never blocks prompts, never compacts
sessions. It is a pure **detector**. Acting on drift (summarizing the
conversation, triggering compact, starting a new session) is an
explicit, separately-scoped concern that will live in a companion skill
(`topic-handoff`) rather than inside topic-fence itself.

## Scope Boundaries

- ❌ NOT a token optimizer (that is context-mode's job)
- ❌ NOT a context loader / unloader (that is context-fence's job)
- ❌ NOT a message filter or blocker
- ❌ NOT an LLM-based analyzer (must stay under 5ms per hook call)
- ❌ NOT a session compactor (Phase 4+ `topic-handoff` skill, if ever)

## Inspecting Topic Events

The `topic` category events are stored in the standard session events
table alongside `intent`, `role`, `decision`, and the other user-message
categories. They can be queried directly via SessionDB or via the
existing `ctx_stats` tool's raw event inspection path.

Example row shape:

```json
{
  "type": "topic",
  "category": "topic",
  "data": "{\"keywords\":[\"drift\",\"detection\",\"context\",\"mode\"]}",
  "priority": 3
}
```

## Implementation

- Module: `src/session/topic-fence.ts`
- Wiring: one import + one call in `src/session/extract.ts`
- Tests: `tests/session/topic-fence.test.ts`
- Dev notes and phased spec: `.claude/skills/topic-fence/`
- Original design (Korean): `/PHASE1_SPEC.md` at repo root
