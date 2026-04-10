# topic-fence — Purpose & Vision

*Automates the "I should split this session" moment that humans consistently notice too late.*

## The Problem

In long coding sessions, users naturally drift between topics.
A session starts with "fix the auth bug", then halfway through
the user says "oh, also refactor the payment module" — and now
the LLM is juggling two unrelated problems in the same context window.

This is not a token budget problem. The context window may have
plenty of room. The problem is **attention pollution**: the model
starts reasoning about auth while payment context is interfering,
and vice versa. Decisions get muddled. The model contradicts itself.
Quality silently degrades — and neither the model nor the user
notices until the damage is done.

Currently, the only defense is the user manually recognizing
"I should start a new session." Most don't — or they notice too late.

## What topic-fence Does

topic-fence watches every user message during a session.
It tracks what the session is "about" by extracting topic keywords
over time, building a running picture of the session's subject matter.

When the keyword profile shifts, topic-fence doesn't just say
"something changed." It distinguishes **how** it changed and
gives a different recommendation accordingly:

### Branching (derived topic)

The new topic grew out of the current one. Shared context is valuable.

Example: "fix auth bug" → "add auth-related tests"

> "Topic is branching. Consider forking to keep the main thread clean."

Forking preserves the existing context because the branch needs it.
The auth test work benefits from knowing what was just fixed.

### Switching (unrelated topic)

The new topic has nothing to do with the current one.
Existing context is dead weight — it wastes tokens and pollutes attention.

Example: "fix auth bug" → "translate README to Korean"

> "Topic has switched. Starting a fresh session is recommended."

A clean session is better here. The auth context doesn't help
with translation — it only gets in the way.

### How It Tells the Difference

Both are detected by the same mechanism: Jaccard similarity between
the current message's keywords and the session's recent topic history.

- **Similarity dips slightly** (moderate drift) → branching.
  The keywords overlap enough to suggest a related subtopic.
- **Similarity drops sharply** (severe drift) → switching.
  The keywords are almost entirely different — a new subject.

Two thresholds, two recommendations. One mechanism.

topic-fence does not block anything. It does not filter messages.
It is a fence, not a wall — it marks the boundary and alerts
when something crosses it, with context-aware guidance on
what to do about it.

## How It Works (End-to-End)

```
User sends message
       │
       ▼
[UserPromptSubmit hook]
       │
       ├─ Extract topic keywords from the message
       │  (regex-based, no LLM, <5ms)
       │
       ├─ Store as "topic" event in SessionDB
       │
       ├─ Compare current keywords against recent topic history
       │  (sliding window + Jaccard similarity)
       │
       ├─ High similarity? → do nothing (same topic)
       │
       ├─ Moderate drift? → emit "topic_branch" event
       │  └─ "Topic is branching. Consider forking."
       │
       └─ Severe drift? → emit "topic_switch" event
          └─ "Topic has switched. Fresh session recommended."
```

## What It Is NOT

- NOT a token optimizer (that's context-mode's job)
- NOT a context loader/unloader (that's context-fence's job)
- NOT a message filter or blocker
- NOT an LLM-based analyzer (must stay under 5ms per call; hook total budget <10ms)

## Where It Lives

Built as an extension to context-mode, leveraging its existing
SessionDB, hook system, and event pipeline. The core addition is
a new event extraction function (`extractTopicSignal`) and a
drift scoring mechanism — both pure functions with zero side effects,
following the exact patterns already established in
`src/session/extract.ts`.
