# Review PR Workflow

## Trigger

User says: "review PR #N", "merge PR #N", "check PR #N"

## Core Philosophy

**Merge first, fix on top.** Contributors ghost when you request changes. Merge their work (if not absurd), then fix issues in follow-up commits. This keeps momentum and respects their effort.

**Exception:** Only reject if the PR introduces a security vulnerability, breaks core functionality beyond repair, or is completely unrelated to the project.

## Step-by-Step

### 1. Gather Intelligence (ONE batch call)

```javascript
commands: [
  { label: "pr-body", command: "gh pr view {N} --json title,body,state,author,baseRefName,headRefName,additions,deletions,files,reviews,comments,labels" },
  { label: "pr-diff", command: "gh pr diff {N}" },
  { label: "pr-comments", command: "gh pr view {N} --comments" },
  { label: "pr-checks", command: "gh pr checks {N}" },
  { label: "pr-files", command: "gh pr view {N} --json files --jq '.files[].path'" },
  { label: "related-issue", command: "gh pr view {N} --json body --jq '.body' | grep -oP '#\\d+' | head -5" }
],
queries: [
  "PR title description changes",
  "files modified adapter platform",
  "diff code changes additions deletions",
  "review comments feedback",
  "CI check status pass fail",
  "related issues referenced"
]
```

### 2. Classify & Spawn Agents

Same classification as [triage-issue.md](triage-issue.md) step 2, but based on PR diff:

```
ALWAYS spawn:
├── Context Mode Architect (reviews all changes)
├── QA Engineer (tests everything)
├── DX Engineer (output quality check)

BASED ON FILES CHANGED:
├── {Platform} Architect (for each affected adapter)
├── Validation Engineer (verify ENV vars, hooks, configs via websearch)

BASED ON CONTENT:
├── {Domain} Architect (database, security, OS, hooks, session, etc.)
```

**Critical addition for PRs — Validation Engineer:**

This agent specifically validates claims made in the PR:
- ENV variables actually exist in the target platform
- Hook formats match the platform's actual API
- Config paths are real, not LLM hallucinations
- Features referenced actually exist in the platform's codebase

Uses WebSearch and Context7 to verify against official docs.

### 3. Validation Phase (Parallel)

All agents run simultaneously:

**Context Mode Architect:**
- Does the change align with project architecture?
- Does it follow existing patterns?
- Are there edge cases the author missed?
- Is session continuity preserved?
- **TDD compliance**: Does the PR include tests? Do tests verify behavior (not implementation)?
  - If no tests: flag as CHANGES_NEEDED (but still merge + add tests in follow-up)
  - If tests mock internal collaborators: flag — tests should use public interfaces per [tdd.md](tdd.md)

**QA Engineer:**
```shell
# Checkout PR locally
gh pr checkout {N}

# Run affected adapter tests
npx vitest run tests/adapters/{affected}.test.ts

# Run full suite
npm test

# TypeScript
npm run typecheck
```

**Validation Engineer:**
```javascript
// For each ENV var mentioned in the PR:
// 1. Grep for it in context-mode source
// 2. WebSearch: "{PLATFORM_NAME} {ENV_VAR} environment variable"
// 3. Context7: resolve-library-id for the platform, then query-docs

// Example: PR adds OPENCODE_CONFIG_PATH
// → Search OpenCode source: does this env var exist?
// → If not: flag as potential LLM hallucination
```

**Platform Architects:**
- Review changes specific to their platform
- Validate against platform's actual hook/config format
- Check backward compatibility

### 4. Merge Decision Matrix

```
All tests pass + All architects APPROVE?
├── YES → Merge immediately
│
├── TESTS FAIL but fix is trivial?
│   └── Merge → Fix on top in follow-up commit
│
├── ARCHITECT has minor concerns?
│   └── Merge → Fix concerns in follow-up commit
│
├── VALIDATION catches hallucinated ENV/feature?
│   └── Merge if core logic is sound → Remove hallucinated parts
│   └── OR: Comment explaining the issue, give 48h, then merge+fix
│
├── SECURITY issue found?
│   └── Do NOT merge. Comment with specific vulnerability.
│
└── PR is completely off-base?
    └── Close with kind explanation. Rare — almost never do this.
```

### 5. Merge to `next` & Fix Flow

Always use `gh` CLI. Always squash merge into `next`:

```bash
# Change PR base to next if needed
gh pr edit {N} --base next

# Squash merge into next
gh pr merge {N} --squash
```

If follow-up fixes needed, push directly to `next`:

```bash
git checkout next
git pull origin next
```

**Follow-up fixes MUST follow TDD** (per [tdd.md](tdd.md)):

```bash
# RED: Write failing test for the issue found during review
npx vitest run tests/{file}.test.ts  # verify FAILS

# GREEN: Write minimal fix
# ... edit files ...
npx vitest run tests/{file}.test.ts  # verify PASSES

# REFACTOR: Clean up
npm test  # full suite still passes

# Commit
git add {files}
git commit -m "fix: address review findings from #{N}

- {fix 1}
- {fix 2}

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"

git push origin next
```

### 6. Comment on PR

**After merge (standard):**

```bash
gh pr comment {N} --body "$(cat <<'EOF'
Thanks for this contribution, @{author}! 🎉

Merged into `next` — this will ship in the next release.

Could you please test it in your setup once the release is out? You know this area best, so your verification would be really valuable. 🙏

{IF follow-up fixes were made:}
I made a small follow-up adjustment in {commit_sha}:
- {what was adjusted and why}
EOF
)"
```

**After merge with concerns:**

```bash
gh pr comment {N} --body "$(cat <<'EOF'
Thanks @{author}! Merged this into `next`.

I made a few adjustments on top:
- {change 1}: {reason}
- {change 2}: {reason}

These are in {commit_sha}. Could you review those changes and test the complete flow in your environment? The responsibility for verifying this works end-to-end is on you since you're closest to the use case. 🙏

This will ship in the next release!
EOF
)"
```

**Rare: closing without merge:**

```bash
gh pr comment {N} --body "$(cat <<'EOF'
Hey @{author}, thanks for taking the time to put this together!

Unfortunately, we can't merge this as-is because:
- {specific technical reason}

{IF salvageable:}
If you'd like to take another pass, here's what would need to change:
- {specific guidance}

{IF not salvageable:}
The direction we're going with this area is {explanation}. I appreciate the effort though!
EOF
)"
gh pr close {N}
```

## ENV/Feature Validation Protocol

This is the most critical part of PR review. LLMs frequently hallucinate ENV vars, hooks, and features.

### Red Flags to Watch For

1. **New ENV variable** — Does this actually exist in the platform?
2. **New hook type** — Does the platform support this hook lifecycle?
3. **Config path** — Is this the real config location?
4. **API endpoint** — Does this API actually exist?
5. **Feature flag** — Is this a real feature of the platform?

### Verification Steps

For EACH claim in the PR:

1. **Grep source**: `rg "{CLAIM}" src/` — is it already used?
2. **WebSearch**: Search for official documentation of the claim
3. **Context7**: `resolve-library-id` → `query-docs` for the platform
4. **GitHub source**: Check the platform's actual repository if open source

### Example: Fake ENV Detection

```
PR adds: process.env.OPENCODE_HOOK_PATH
Step 1: rg "OPENCODE_HOOK_PATH" src/ → not found
Step 2: WebSearch "OpenCode OPENCODE_HOOK_PATH environment variable" → no results
Step 3: Context7 query OpenCode docs for "HOOK_PATH" → not documented
Verdict: HALLUCINATED — flag to EM, remove from PR
```

## Handling Stale PRs

If a PR has been open >7 days with no activity:
1. Check if it's still relevant
2. If yes: merge it, fix on top
3. If no: close with kind explanation
4. Never leave PRs in limbo
