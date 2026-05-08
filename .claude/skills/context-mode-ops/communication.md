# Communication Templates

Tone: warm, professional, technical, grateful. Always put testing responsibility on the contributor.

## Issue Comments

### After Fix (Standard)

```markdown
Hey @{author}! 👋

We investigated this and pushed a fix in #{PR_NUMBER}.

**Root cause:** {1-2 sentence technical explanation}

**Fix:** {1-2 sentence description of what changed}

**Affected area:** `{adapter/module path}`

This lands on the `next` branch and will ship in the next release. Once it's out, could you please test it in your setup and confirm it resolves the issue? 🙏

```
npm update -g context-mode
# or for plugin users:
/context-mode:ctx-upgrade
```

Thanks for reporting this — it helped improve context-mode for everyone!
```

### Needs More Information

```markdown
Hey @{author}, thanks for opening this!

To investigate further, could you share:
- Your platform (Claude Code / Gemini CLI / OpenCode / etc.)
- context-mode version (`ctx doctor` or `npm list -g context-mode`)
- The exact command or action that triggers this
- Any error messages or unexpected output

This will help us reproduce and fix the issue faster. 🙏
```

### Working As Intended

```markdown
Hey @{author}, thanks for raising this!

This is actually working as intended — here's why:

{Technical explanation of the design decision}

{If there's a workaround:}
That said, you can achieve what you're looking for by:
{workaround steps}

{If it's a reasonable feature request:}
I can see why this would be useful though. I'll re-label this as a feature request so we can discuss it with the community.

Let me know if you have any questions!
```

### Duplicate Issue

```markdown
Hey @{author}, thanks for reporting!

This is a duplicate of #{ORIGINAL_NUMBER} which tracks the same issue. I'm closing this one to keep discussion in one place — please follow #{ORIGINAL_NUMBER} for updates.

If your case is different from what's described there, please reopen and let us know what's different!
```

### LLM Hallucination (Feature/ENV Doesn't Exist)

```markdown
Hey @{author}, thanks for the detailed report!

After investigation, it looks like `{CLAIMED_FEATURE/ENV}` doesn't actually exist in {PLATFORM}. This is a common issue where AI assistants sometimes reference features or environment variables that don't exist in the actual platform.

Here's what we found:
- {What we checked}
- {Official docs reference showing it's not a real feature}

**What actually works:**
{The correct approach or existing alternative}

No worries at all — this kind of thing is surprisingly common! Let us know if you need help with the correct approach.
```

## PR Comments

### After Merge (Clean)

```markdown
Thanks for this contribution, @{author}! 🎉

Merged into `next` — this will ship in the next release.

Could you please test it in your setup once the release is out? You know this area best, so your verification would be really valuable. 🙏

Thanks for making context-mode better!
```

### After Merge (With Follow-Up Fixes)

```markdown
Thanks @{author}! Merged into `next`.

I made a few small adjustments on top in {commit_sha}:
- **{change 1}:** {reason — e.g., "aligned with existing pattern in other adapters"}
- **{change 2}:** {reason — e.g., "added missing test for edge case"}

Could you review those changes and test the complete flow in your environment? Since you're closest to this use case, your verification is important. 🙏

This will ship in the next release!
```

### After Merge (Significant Fixes Needed)

```markdown
Hey @{author}, thanks for putting this together! I've merged it into `next`.

I did need to make some adjustments though — the core idea is solid but a few things needed fixing:

**Changes I made:**
- {change 1}: {detailed reason}
- {change 2}: {detailed reason}
- {change 3}: {detailed reason}

These are in {commit_sha_1} and {commit_sha_2}.

**Important:** Could you please thoroughly test this in your environment? The responsibility for verifying this works end-to-end is yours since you're closest to the use case and these changes touch {what they touch}. 🙏

Let me know if anything doesn't work as expected!
```

### Closing Without Merge (Rare)

```markdown
Hey @{author}, thanks for taking the time to put this together — I appreciate the effort!

Unfortunately we can't merge this as-is:
- **{reason 1}:** {technical explanation}
- **{reason 2}:** {technical explanation}

{IF the work is salvageable:}
If you'd like to take another pass, here's what would make this mergeable:
1. {specific guidance}
2. {specific guidance}

Happy to help if you have questions!

{IF the direction is wrong:}
The direction we're going with {area} is {explanation}. This is to ensure {rationale}.

Thanks again for the contribution — hope to see more PRs from you! 🙌
```

### PR Has Hallucinated Features

```markdown
Hey @{author}, thanks for this PR!

While reviewing, I noticed that `{CLAIMED_FEATURE}` doesn't appear to exist in {PLATFORM}'s actual implementation:

- Searched {PLATFORM}'s source/docs — not found
- The ENV var `{VAR}` isn't documented or used by {PLATFORM}

This might be an AI assistant suggestion that doesn't match the real platform API. No worries — it's surprisingly common!

{IF core logic is still valid:}
The rest of the PR looks solid though. I'll merge it and remove the non-existent parts in a follow-up.

{IF the whole PR is based on the hallucination:}
Since the core change depends on this feature, we'd need to find an alternative approach. {Suggestion for correct approach}

Let me know how you'd like to proceed!
```

## Release Comments

### On Issues Fixed in Release

```markdown
🎉 Released in **v{VERSION}**!

Please update and test:
```
npm update -g context-mode
# or for plugin users:
/context-mode:ctx-upgrade
```

Let us know if this resolves your issue!
```

### Release Announcement (GitHub Release Body)

The `gh release create --generate-notes` handles this automatically. Only add a manual note if there are:
- Breaking changes
- Migration steps required
- Notable new features

## Tone Guidelines

### DO

- Start with gratitude: "Thanks for..."
- Use names: "@{author}"
- Be specific and technical
- Give clear next steps
- Use emoji sparingly (👋 🎉 🙏 at most)
- Frame responsibility clearly but kindly

### DON'T

- Be passive-aggressive
- Use corporate speak
- Leave ambiguity about next steps
- Promise timelines
- Blame the contributor for mistakes
- Use excessive emoji
- Write walls of text — keep it concise
