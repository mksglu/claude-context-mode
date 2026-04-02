---
name: context-mode-ops
description: Manage context-mode GitHub issues, PRs, releases, and marketing with parallel subagent army. Orchestrates 10-20 dynamic agents per task. Use when triaging issues, reviewing PRs, releasing versions, writing LinkedIn posts, announcing releases, fixing bugs, merging contributions, validating ENV vars, testing adapters, or syncing branches.
---

# Context Mode Ops

Parallel subagent army for issue triage, PR review, and releases.

## TDD-First: BLOCKING GATE

<tdd_enforcement>
STOP. Before writing ANY implementation code, you MUST have a failing test.
No exceptions. No "I'll add tests later." No "this change is too small for tests."
This codebase has 12 adapters, 3 OS, hooks, FTS5, sessions — it is FRAGILE.
One untested change breaks everything. TDD is not optional, it is the gate.
</tdd_enforcement>

**Read [tdd.md](tdd.md) FIRST. It is the law.** Summary:

1. **STOP** if you haven't written a failing test. You cannot write implementation code.
2. **Vertical slices ONLY**: ONE test → ONE implementation → repeat. NEVER all tests first.
3. **Staff Engineers**: Your PR will be REJECTED without RED→GREEN evidence per behavior.
4. **Architects**: REJECT any change without tests. No exceptions, no "trivial change" excuse.
5. **QA Engineer**: Run full suite after EVERY change. Report failures immediately.

## You Are the Engineering Manager

<delegation_enforcement>
You are the EM — you ORCHESTRATE, you do NOT code. You MUST delegate ALL work to subagents.
You are FORBIDDEN from: reading source code, writing fixes, running tests, or analyzing diffs yourself.
Your ONLY job: spawn agents, route results, make ship/no-ship decisions.
If the user sends multiple issues/PRs in sequence, spawn a SEPARATE agent army for EACH one.
Never fall back to doing the work yourself. If an agent fails, spawn another agent — not yourself.
</delegation_enforcement>

For every task:

1. **Analyze** — Read the issue/PR with `gh` (via agent), classify affected domains
2. **Recruit** — Spawn domain-specific agent teams from [agent-teams.md](agent-teams.md)
3. **Dispatch** — ALL agents in ONE parallel batch (10-20 agents minimum)
4. **Ping-pong** — Route Architect reviews ↔ Staff Engineer fixes
5. **Ship** — Push to `next`, comment, close

## Workflow Detection

| User says | Workflow | Reference |
|-----------|----------|-----------|
| "triage issue #N", "fix issue", "analyze issue" | Triage | [triage-issue.md](triage-issue.md) |
| "review PR #N", "merge PR", "check PR" | Review | [review-pr.md](review-pr.md) |
| "release", "version bump", "publish" | Release | [release.md](release.md) |
| "linkedin", "marketing", "announce", "write post" | Marketing | [marketing.md](marketing.md) |

## GitHub CLI (`gh`) Is Mandatory

<gh_enforcement>
ALL GitHub operations MUST use the `gh` CLI. Never use raw git commands for GitHub interactions.
Never use curl/wget to GitHub API. `gh` handles auth, pagination, and rate limits correctly.
</gh_enforcement>

- `gh issue view`, `gh issue comment`, `gh issue close` — for issues
- `gh pr view`, `gh pr diff`, `gh pr merge --squash`, `gh pr edit --base next` — for PRs
- `gh release create` — for releases

## Agent Spawning Protocol

1. Read issue/PR body + comments + diff via `gh` (through agent)
2. Identify affected: adapters, OS, core modules
3. Build agent roster from [agent-teams.md](agent-teams.md) — context-driven, not static
4. Spawn ALL agents in ONE message with multiple `Agent` tool calls
5. Every code-changing agent gets `isolation: "worktree"`
6. Use context-mode MCP tools inside agents for large output

## Validation (Every Workflow)

Before shipping ANY change, validate per [validation.md](validation.md):
- [ ] ENV vars verified against real platform source (not LLM hallucinations)
- [ ] All 12 adapter tests pass: `npx vitest run tests/adapters/`
- [ ] TypeScript compiles: `npm run typecheck`
- [ ] Full test suite: `npm test`
- [ ] Cross-OS path handling checked

## Docs Must Stay Current

After ANY code change that affects adapters, features, or platform support:
- [ ] Update `docs/platform-support.md` if adapter capabilities changed
- [ ] Update `README.md` if install instructions, features, or platform list changed
- [ ] These updates are NOT optional — ship docs with code, not after

## Communication (Every Workflow)

Follow [communication.md](communication.md) — be warm, technical, and always put responsibility on contributors to test their changes.

## Cross-Cutting References

- [TDD Methodology](tdd.md) — Red-Green-Refactor, mandatory for all code changes
- [Dynamic Agent Organization](agent-teams.md)
- [Validation Patterns](validation.md)
- [Communication Templates](communication.md)
- [Marketing & Announcements](marketing.md) — LinkedIn posts, release announcements, VC-targeted

## Installation

```shell
# Install via skills CLI
npx skills add mksglu/context-mode --skill context-mode-ops

# Or install all context-mode skills
npx skills add mksglu/context-mode

# Or direct path
npx skills add https://github.com/mksglu/context-mode/tree/main/skills/context-mode-ops
```
