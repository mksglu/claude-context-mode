# ADR 0001 — SessionDB is multi-writer-safe

- **Status**: Accepted
- **Date**: 2026-05-14
- **Version**: v1.0.130
- **Supersedes**: the v1.0.128 single-writer guard and its v1.0.129 hotfix
- **Reviewers**: 10 parallel grill verdicts (UX, SQLite, Security, Perf, Architect, Test, SRE, PM, Data, DevEx)

## Context

v1.0.128 introduced two new defenses inside `SQLiteBase` (the shared
ctor for `SessionDB` and `ContentStore`):

1. `acquireDbLock(dbPath)` — an O_EXCL `<dbPath>.lock` file containing
   the owning PID. Subsequent openers that found a live PID inside the
   lockfile threw `DatabaseLockedError("Another context-mode server is
   already running (PID: N). Stop it before starting a new instance.")`.
2. `db.pragma("locking_mode = EXCLUSIVE")` — applied immediately after
   `applyWALPragmas`, on both the main open path and the corruption
   recovery path.

The stated goal was to fix issue #560: @ishabana reported a 5-process
scenario where multiple context-mode MCP servers writing the same on-
disk SQLite content store unbounded the WAL — readers held shared locks
indefinitely so `wal_checkpoint(TRUNCATE)` never fired, the only
existing truncation path is `closeDB`'s checkpoint on graceful exit
(which #559's zombie servers never reached), and the result was
238MB+ WAL files plus `ctx_search` hangs.

v1.0.129 added a tmpdir skip-gate to both primitives because the test
suite (which opens many DBs on tmp paths in the same process) tripped
the lockfile + `SQLITE_BUSY` from the EXCLUSIVE pragma.

After v1.0.128 + v1.0.129 shipped, multi-window users — who legitimately
run two Claude sessions against the same project DB — hit the
`DatabaseLockedError` and could not work. That is the regression this
ADR rolls out.

## Root cause re-analysis

#560's actual root causes were not "two MCP processes opened the same
DB at the same time." They were:

- **#559 (zombie MCP child accumulation)**. After `/ctx-upgrade`, the
  previous MCP server child was not killed, so old + new processes
  both ran, both wrote, and neither ever exited gracefully (so the WAL
  truncation in `closeDB` never fired). Fixed in v1.0.128 by killing
  the previous child before starting a new one.
- **#561 (Pi misdetection writing to `~/.claude/context-mode/`)**.
  Adapter detection accidentally fired on Pi installs, and
  `defaultDBPath()` produced a path that was shared across user
  sessions instead of the per-process tmp DB shape. Fixed in v1.0.129
  by scrubbing foreign identification env on bridge spawn.

With both root causes fixed, normal usage is **one MCP process per
Claude session per project**. Legitimate multi-window UX is **two
processes on the same on-disk dbPath** — and the SQLite WAL handles
that natively. The lockfile was solving a problem that no longer
existed once #559 + #561 were fixed.

## Decision

- `SessionDB` is multi-writer-safe. So is `ContentStore`. Both are
  built on `SQLiteBase`, so `SQLiteBase` ctor MUST NOT apply any
  single-writer enforcement.
- `acquireDbLock`, `releaseDbLock`, `DatabaseLockedError`, and the
  whole `src/util/db-lock.ts` module are deleted (v1.0.130 slice 4).
- `db.pragma("locking_mode = EXCLUSIVE")` is removed from the ctor.
  `applyWALPragmas` already does not apply it.
- `withRetry()` (busy_timeout = 30000ms inside `new Database(...)`,
  bounded retry loop on `SQLITE_BUSY`) remains the documented
  contract for handling write contention. That is the SQLite-native
  multi-writer story.

### Regression-proof anchor

Two paired tests in `tests/util/db-base-platform-gate.test.ts`:

1. **Behavioural** (`v1.0.130 INVARIANT — SQLiteBase multi-writer
   default > "INVARIANT: two SQLiteBase instances on the same tmpdir
   path can both open and write (multi-writer default)"`). Opens two
   `SessionDB` instances on the same on-disk path (NOT tmpdir), writes
   through both via `insertEvent`, asserts neither throws.
2. **Source-pin** (`"INVARIANT: SQLiteBase ctor must NOT contain
   acquireDbLock or locking_mode=EXCLUSIVE"`). Reads the source of
   `src/db-base.ts`, scopes to the `SQLiteBase` class body, regex
   asserts the literal identifier names + `locking_mode=EXCLUSIVE`
   pattern do not appear.

If a future contributor pulls the v1.0.128 single-writer primitives
back into the ctor, the source-pin test fails LOUDLY in CI before
merge. If they invent a new shape that passes the source-pin but
breaks behaviourally, the behavioural test fails. Defense in depth.

## Consequences

### Positive

- Legitimate multi-window users can run two Claude sessions on the
  same project without the `DatabaseLockedError` regression.
- The 5-worktree workflow (one Claude session per worktree, separate
  dbPath per worktree) keeps working — that path was never affected
  by the lockfile, but it is documented here as covered by the
  multi-writer contract.
- ContentStore (FTS5 shared knowledge base across sessions) — which
  was always multi-writer by design — no longer needs the `applyWALPragmas`
  guard against `applyWALPragmas` accidentally applying EXCLUSIVE.
- Deletes 185 lines of code (`db-lock.ts`) plus 80+ lines of
  ctor-side plumbing. Smaller, simpler, faster to reason about.

### Negative

- A future bug shaped like "two processes both opened the same DB
  and it broke" will not be diagnosed by the lockfile error message.
  It will surface as `SQLITE_BUSY` after the 30s busy_timeout +
  bounded `withRetry` loop, which is a less specific message. We
  accept this — the fix lives in the process layer, not the DB layer.
- If a future regression in the process layer (sibling-mcp) lets two
  MCP children both run against the same project, the WAL will grow
  unbounded again. The mitigation is the existing `_liveDBs` exit-hook
  WAL checkpoint (which the rollback preserved) plus the periodic
  optimize loop in `ContentStore`.

### Neutral

- Test count: net -10 tests in `db-base-platform-gate.test.ts`. The 11
  v1.0.128 lockfile tests are gone; they are replaced by 3 v1.0.130
  tests (2 INVARIANT + 1 lifecycle suite with 2 cases).

## Alternatives considered

### Lockfile (the v1.0.128 approach) — rejected

The lockfile correctly enforced single-writer but solved the wrong
problem. Once #559 + #561 were fixed, the only callers it blocked were
the legitimate multi-window UX users it was never meant to target. The
"who else is on this DB" UX story was useful diagnostic value, but the
cost (broken multi-window) outweighed the benefit.

### Leader election — rejected

A "first opener wins, others become read-only followers" pattern was
floated. This is over-engineering for the actual constraint set: SQLite
WAL already provides the right semantics for two writers, and the
process layer (sibling-mcp) is the right place to enforce process
identity, not the DB layer.

### `locking_mode = EXCLUSIVE` pragma — rejected

EXCLUSIVE blocks the second opener with `SQLITE_BUSY` instead of a
clean error. It also requires every consumer of `SQLiteBase` to opt out
explicitly, and `ContentStore` is multi-writer by design — so EXCLUSIVE
in a shared base class is a foot-gun. Belongs (if at all) inside an
explicit single-writer subclass, not the base.

### Deferred WAL truncation hook — partially adopted

The `_liveDBs` exit hook WAL checkpoint was preserved from v1.0.128.
That is the actual mitigation against unbounded WAL growth, separate
from the lockfile question. We keep it.

## Reference

- v1.0.128 release notes: introduced `acquireDbLock` + EXCLUSIVE pragma
  for #560.
- v1.0.129 release notes: added tmpdir skip-gate hotfix because the
  v1.0.128 work broke 82 tests and ContentStore concurrency.
- v1.0.130 (this ADR): rolls out the single-writer guard entirely.

10 parallel grill verdicts informed this decision (untracked artifacts
in the repo root: `PR-559-560-VERDICT.md`, `PERF-560-GRILL-VERDICT.md`,
`SECURITY-GRILL-VERDICT.md`, `SQLITE-EXPERT-GRILL-VERDICT.md`,
`SRE-VERDICT-v130-rollback.md`, etc.) — all converged on "the lockfile
is solving the wrong problem; the fix is in the process layer."

## Contract for `SQLiteBase` consumers

If you build on `SQLiteBase`:

- Your DB MAY be opened from multiple processes on the same on-disk
  path. Both ContentStore and SessionDB explicitly support this.
- Wrap writes that may contend in `withRetry()`. The base class exposes
  it as a `protected withRetry<T>()` method.
- Do NOT add `db.pragma("locking_mode = EXCLUSIVE")` inside `SQLiteBase`
  or `applyWALPragmas`. If you genuinely need single-writer semantics
  for a new subclass, add it in that subclass's ctor and document why.
- Process-identity invariants (only-one-MCP-per-project) belong in
  `src/util/sibling-mcp.ts`, not in the DB layer.
