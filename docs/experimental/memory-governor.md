# Experimental: Memory Governor

The memory governor is an opt-in session-continuity experiment for long Codex sessions.
It continuously distills SessionDB events into a compact working-state capsule and lets the model recall raw details with `ctx_recall` when needed.

Enable it explicitly:

```bash
CONTEXT_MODE_MEMORY_GOVERNOR=1
```

With the flag off, context-mode keeps the existing session-continuity behavior only:
normal event capture, PreCompact snapshot persistence where the platform emits it, SessionStart directive injection, and the stable MCP tool surface.

With the flag on:

- Codex `UserPromptSubmit` stores the latest goal as a memory-governor event.
- Codex `Stop` writes one latest `working_state_capsule` per session.
- Codex `SessionStart` appends the latest capsule when no PreCompact resume snapshot is available.
- The MCP server exposes `ctx_curate` and `ctx_recall`.
- `ctx_curate` can refresh the capsule manually and persist `focus` / `retain` hints.
- `ctx_recall` returns the latest capsule by `id: "latest"` and prefers raw events for normal query recall.

Current hardening rules:

- Capsule rows are pruned before writing a fresh capsule, so stale high-priority summaries do not crowd out raw event history.
- Query recall ignores capsule rows unless the caller asks for the latest capsule or an explicit event id.
- SessionStart still writes the existing events file and session directive before appending a capsule.
- PreCompact resume snapshots keep precedence over memory-governor capsules.

Known limitations:

- The capsule schema and scoring are experimental and may change.
- Ranking is intentionally simple; long-session evidence should still be validated with `ctx_search` / `ctx_recall`.
- The Codex path is the first target. Other platforms need separate hook choreography before this should be enabled there.
- The benchmark is a local/manual harness under `benchmarks/`, not a CI performance guarantee.

Do not present this as a stable replacement for session continuity yet. Treat it as an opt-in extension until long-session behavior, recall ranking, and platform coverage have been proven.
