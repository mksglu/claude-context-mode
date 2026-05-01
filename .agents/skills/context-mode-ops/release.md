# Release Workflow

## Trigger

User says: "release", "version bump", "npm publish", "ship it"

## Pre-Flight Checks

Before ANY release action, verify:

```bash
# Must be on main branch
git branch --show-current  # expect: main

# Must be clean
git status --porcelain  # expect: empty

# Must be up to date
git pull origin main
```

## Step-by-Step

### 1. Validate Codebase (Parallel Agents)

Spawn these agents simultaneously:

| Agent | Task |
|-------|------|
| **QA Engineer** | Run `npm test` + `npm run typecheck` — report full pass/fail |
| **Security Engineer** | Check for any open security issues, audit recent changes |
| **Release Engineer** | Check current version, changelog, unreleased commits |
| **DX Engineer** | Verify README is current, install instructions work |

All must report PASS before proceeding.

### 1b. Grill-Me Review — MANDATORY BLOCKING GATE

**Before ANY version bump, the EM MUST run a grill-me interview on all changes in this release.**

This is not optional. This is not skippable. Every release gets grilled.

Interview the user relentlessly about every aspect of the changes until reaching shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer. Ask questions one at a time. If a question can be answered by exploring the codebase, explore the codebase instead of asking.

**The release is BLOCKED until:**
- [ ] All branches of the design tree are resolved
- [ ] Zero unresolved questions remain
- [ ] User explicitly approves the grill results

Only after grill-me approval: proceed to version bump.

### 2. Version Bump — MANDATORY

<version_bump_enforcement>
You MUST run `npm version patch`. This is NOT optional. Do NOT skip this step.
Do NOT manually edit package.json version. Do NOT create git tags manually.
`npm version patch` does EVERYTHING — bump, sync manifests, stage, commit, tag.
</version_bump_enforcement>

```bash
npm version patch
```

This single command does ALL of the following automatically:
1. Bumps `package.json` version (e.g., 1.0.56 → 1.0.57)
2. Triggers `version` lifecycle hook → runs `scripts/version-sync.mjs`
3. `version-sync.mjs` syncs version to ALL 6 manifest files:
   - `.claude-plugin/plugin.json`
   - `.claude-plugin/marketplace.json`
   - `.openclaw-plugin/openclaw.plugin.json`
   - `.openclaw-plugin/package.json`
   - `openclaw.plugin.json`
   - `.pi/extensions/context-mode/package.json`
4. Stages the manifest files via `git add`
5. Creates a git commit and `v{VERSION}` tag

**Do NOT create your own commit or tag. `npm version patch` handles it.**

### 3. Validate (NO Build Needed)

**Do NOT run `npm run build` or `npm run bundle`.** CI generates bundle files automatically on GitHub. You only validate:

```bash
# Tests
npm test

# TypeScript
npm run typecheck
```

### 4. Git Tag & GitHub Release

```bash
# The npm version command already created a git tag
# Verify it exists:
git tag --list 'v*' | tail -5

# Push the commit and tag
git push origin main --tags

# Create GitHub release with auto-generated changelog
gh release create v{VERSION} \
  --title "v{VERSION}" \
  --generate-notes \
  --latest
```

### 5. npm Publish (Local)

**⚠️ REQUIRES USER APPROVAL — ask before running.**

```bash
# Dry run first
npm publish --dry-run

# If dry run looks good, publish
npm publish
```

Verify publication:
```bash
npm view context-mode version  # should show new version
```

### 6. Sync Branches

Sync `next` with `main` to ensure next has all release changes:

```bash
# Fetch latest
git fetch origin

# Merge main into next
git checkout next
git pull origin next
git merge main --no-edit

# Push
git push origin next

# Return to main
git checkout main
```

**If merge conflict:** Resolve in favor of `main` (release branch is authoritative).

### 7. Clean Remote Branches

**⚠️ REQUIRES USER APPROVAL for EACH branch.**

List stale remote branches (everything except `main` and `next`):

```bash
# List remote branches excluding main and next
git branch -r | grep -v 'origin/main' | grep -v 'origin/next' | grep -v 'origin/HEAD'
```

For each branch, ask the user:
```
Remote branch: origin/{branch-name}
Last commit: {date} — {message}
Related PR: #{number} ({state})

Delete this branch? [y/n]
```

Only delete after explicit approval:
```bash
git push origin --delete {branch-name}
```

## Release Checklist (EM Verification)

Before declaring release complete:

- [ ] `npm test` — all pass
- [ ] `npm run typecheck` — no errors
- [ ] `npm version patch` — version bumped in all manifests
- [ ] `git push origin main --tags` — pushed with tag (CI builds bundles automatically)
- [ ] `gh release create` — GitHub release published
- [ ] `npm publish` — package on npm registry
- [ ] `next` branch synced with `main`
- [ ] Stale remote branches cleaned (user approved)
- [ ] Verify: `npm view context-mode version` shows new version

## Rollback Plan

If something goes wrong after publish:

```bash
# Unpublish within 72 hours (npm policy)
npm unpublish context-mode@{BAD_VERSION}

# Or deprecate
npm deprecate context-mode@{BAD_VERSION} "Known issue: {description}"

# Revert git
git revert HEAD
git push origin main
```

## Post-Release

After successful release:

1. Comment on all issues fixed in this release:
   ```
   Released in v{VERSION}! Please update and test:
   npm update -g context-mode
   ```

2. Update Discord if there are noteworthy changes

3. Check npm download stats in 24h for any anomalies
