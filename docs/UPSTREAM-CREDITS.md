# Upstream Skill Credits

context-mode vendors a small set of operating-discipline skills authored
by Matt Pocock. They are referenced as the operational backbone of the
[`context-mode-ops`](../.claude/skills/context-mode-ops/SKILL.md) skill
(`/diagnose`, `/tdd`, `/grill-me`, `/grill-with-docs`,
`/improve-codebase-architecture`).

These skills live under `.claude/skills/` rather than `skills/` because
`context-mode-ops` is a maintainer-only workflow; shipping them to every
plugin install would pay description tokens for tools end users never
invoke. Maintainers working inside this repo still get them auto-loaded
via Claude Code's project-scoped skill discovery.

## Source

- **Repository:** https://github.com/mattpocock/skills
- **License:** MIT (Copyright © 2026 Matt Pocock)
- **Commit:** `b843cb5ea74b1fe5e58a0fc23cddef9e66076fb8` (vendored 2026-05-04)

## Vendored skills (paths inside this repository)

| Skill | Upstream path | Local path |
|-------|---------------|------------|
| `/diagnose` | `skills/engineering/diagnose/` | `.claude/skills/diagnose/` |
| `/tdd` | `skills/engineering/tdd/` | `.claude/skills/tdd/` |
| `/grill-me` | `skills/productivity/grill-me/` | `.claude/skills/grill-me/` |
| `/grill-with-docs` | `skills/engineering/grill-with-docs/` | `.claude/skills/grill-with-docs/` |
| `/improve-codebase-architecture` | `skills/engineering/improve-codebase-architecture/` | `.claude/skills/improve-codebase-architecture/` |

## Why vendor instead of just listing as docs?

The owner operating directive at the top of `context-mode-ops/SKILL.md`
treats these skills as **mandatory tools**, not advisory references. If a
context-mode user invokes `/context-mode-ops` and the directive points to
skills they have never installed, the discipline collapses. Vendoring
guarantees that every install of context-mode ships the operational
toolkit alongside the policy that depends on it.

## Refreshing

To pull upstream changes:

```bash
git clone --depth 1 https://github.com/mattpocock/skills /tmp/mattpocock-skills-update
for d in diagnose tdd grill-me grill-with-docs improve-codebase-architecture; do
  src=$(find /tmp/mattpocock-skills-update/skills -maxdepth 3 -type d -name "$d" | head -1)
  cp -R "$src/." ".claude/skills/$d/"
done
# Then update the commit SHA above and run the full test suite.
```

## License preservation

The MIT license terms travel with the source. Each vendored `SKILL.md`
carries a one-line footer pointing back here, and the full license
text is preserved at the upstream repository. No portion of these
skills is relicensed — they remain MIT under Matt's copyright.
