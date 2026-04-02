# Triage Issue Workflow

## Trigger

User says: "triage issue #N", "fix issue #N", "analyze issue #N"

## Step-by-Step

### 1. Gather Intelligence (ONE batch call)

Use `ctx_batch_execute` to gather everything in ONE call:

```javascript
commands: [
  { label: "issue-body", command: "gh issue view {N} --json title,body,labels,state,comments,author,createdAt" },
  { label: "issue-comments", command: "gh issue view {N} --comments" },
  { label: "recent-related-prs", command: "gh pr list --state all --limit 10 --json number,title,state,headRefName" },
  { label: "source-tree", command: "find src -type f -name '*.ts' | sort" },
  { label: "test-tree", command: "find tests -type f -name '*.test.ts' | sort" },
  { label: "open-issues", command: "gh issue list --state open --limit 20 --json number,title,labels" }
],
queries: [
  "issue title description problem",
  "affected adapter platform",
  "error message stack trace",
  "environment variables mentioned",
  "OS platform specific",
  "related PRs and issues"
]
```

### 2. Classify Domains

From the gathered intelligence, identify:

- [ ] **Affected adapters** — which of the 12 platforms?
- [ ] **Affected OS** — macOS, Linux, Windows, or all?
- [ ] **Core modules** — server, store, executor, session, hooks?
- [ ] **Issue type** — bug, feature request, question, discussion?
- [ ] **Severity** — breaking (can't use tool), degraded (works but wrong), cosmetic

### 3. Spawn Agent Army

Based on classification, spawn from [agent-teams.md](agent-teams.md):

```
ALWAYS spawn:
├── Context Mode Architect (reviews everything)
├── QA Engineer (runs all tests)
├── DX Engineer (checks user-facing quality)

IF adapter X is affected:
├── {X} Architect
├── {X} Staff Engineer

IF OS-specific:
├── OS Compatibility Architect
├── {macOS|Linux|Windows} Staff Engineer

IF domain-specific:
├── {Domain} Architect
└── (Staff Engineer if code changes needed)
```

**Example: Issue #208 "CLI upgrade full support for Opencode/Kilocode"**
```
Agents to spawn:
1. Context Mode Architect
2. QA Engineer
3. DX Engineer
4. OpenCode Architect
5. OpenCode Staff Engineer
6. Kilo Architect
7. Kilo Staff Engineer
8. Hooks Architect (CLI upgrade touches hooks)
9. OS Compatibility Architect (CLI runs on all OS)
```

### 4. Investigation Phase (Parallel)

All agents investigate simultaneously:

**Architects** research:
- Read relevant source files
- Check if claimed behavior actually exists
- Validate ENV vars against real platform docs (use WebSearch + Context7)
- Review related closed issues for prior art
- Report: FINDINGS with specific file:line references

**Staff Engineers** prepare (TDD-first per [tdd.md](tdd.md)):
- Read the code that needs changing
- **RED**: Write a failing test that reproduces the bug / specifies new behavior
- Run test — verify it **FAILS** (if it passes, the test is useless)
- **GREEN**: Write minimal code to make the test pass
- Run test — verify it **PASSES**
- **REFACTOR**: Clean up while keeping tests green
- Repeat for each behavior (vertical slices, never horizontal)
- Run full affected adapter tests
- Report: DRAFT_FIX with RED→GREEN evidence for each behavior

### 5. Ping-Pong Review

Route Staff Engineer outputs to their paired Architects:

```
EM reads Staff Engineer result
  → Sends to Architect via Agent(SendMessage)
  → Architect reviews: APPROVED or CHANGES_NEEDED
  → If CHANGES_NEEDED: route back to Staff Engineer
  → Max 2 rounds, then EM decides
```

### 6. Validate (QA Engineer)

QA Engineer runs the full validation matrix:

```shell
# All adapter tests
npx vitest run tests/adapters/

# Core tests
npx vitest run tests/core/

# Full suite
npm test

# TypeScript
npm run typecheck
```

Report as a matrix:

```
Adapter Tests:
  ✓ claude-code    ✓ gemini-cli    ✓ opencode
  ✓ openclaw       ✓ kilo          ✓ codex
  ✓ vscode-copilot ✓ cursor        ✓ antigravity
  ✓ kiro           ✓ pi            ✓ zed

Core Tests:    ✓ routing  ✓ search  ✓ server  ✓ cli
TypeScript:    ✓ no errors
Full Suite:    ✓ 47/47 passed
```

### 7. Push Directly to `next`

**Do NOT open a PR.** Push fixes directly to the `next` branch:

```bash
# Ensure we're on next
git checkout next
git pull origin next

# Apply changes from worktree agents
# ... (merge worktree changes)

# Commit with issue reference
git commit -m "fix: {concise description} (closes #{N})

- {what was broken}
- {what was fixed}
- {which adapters/modules affected}

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"

# Push to next
git push origin next
```

### 8. Comment on Issue & Close

After pushing to `next`, comment and **close the issue immediately**:

```bash
gh issue comment {N} --body "$(cat <<'EOF'
Hey @{author}! 👋

We investigated this and pushed a fix to the `next` branch ({commit_sha}).

**What was happening:** {technical explanation of the root cause}

**What we fixed:** {technical explanation of the fix}

**Affected area:** {adapter/module names}

This will ship in the next release. Once it's out, could you please test it in your setup and let us know if it resolves the issue? 🙏

If the fix doesn't work for you, feel free to reopen this issue.

Thanks for reporting this!
EOF
)"

# Close the issue — fix is pushed, job done
gh issue close {N}
```

## Decision Tree: Fix vs. Wontfix vs. Needs Info

```
Issue is clear and reproducible?
├── YES → Fix it (steps 3-8 above)
├── UNCLEAR → Comment asking for reproduction steps
│   └── Template: "Could you share the exact command/config that triggers this?"
└── BY DESIGN → Explain why, close with "working as intended" label
    └── Be kind — explain the design decision
```

## Edge Cases

### Issue references a feature that doesn't exist
The issue author may have been told by an LLM that a feature exists when it doesn't. Use [validation.md](validation.md) ENV verification to catch this. Comment explaining the misunderstanding kindly.

### Issue is a duplicate
Link to the original issue, close as duplicate, thank the reporter.

### Issue is actually a feature request
Re-label, add to backlog discussion, don't close — let the community weigh in.
