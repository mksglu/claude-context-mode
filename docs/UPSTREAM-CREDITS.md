# Upstream Skill Credits

context-mode references a small set of operating-discipline skills
authored by Matt Pocock (MIT). They are the operational backbone of the
[`context-mode-ops`](https://github.com/mksglu/context-mode/tree/next/.claude/skills/context-mode-ops)
skill (`/diagnose`, `/tdd`, `/grill-me`, `/grill-with-docs`,
`/improve-codebase-architecture`).

These skills are **referenced, not vendored**. Maintainers install them
locally via the upstream `skills` CLI. Shipping them to every plugin
install would pay description tokens for tools end users never invoke,
so they stay out of this repo.

## Source

- **Repository:** https://github.com/mattpocock/skills
- **License:** MIT (Copyright (c) 2026 Matt Pocock)
- **Author:** Matt Pocock

## Referenced (not vendored)

Install the upstream skills into your local Claude Code:

```bash
npx skills add mattpocock/skills \
  -s tdd grill-me grill-with-docs diagnose improve-codebase-architecture \
  -a claude-code -y
```

| Skill | Upstream path |
|-------|---------------|
| `/diagnose` | `skills/engineering/diagnose/` |
| `/tdd` | `skills/engineering/tdd/` |
| `/grill-me` | `skills/productivity/grill-me/` |
| `/grill-with-docs` | `skills/engineering/grill-with-docs/` |
| `/improve-codebase-architecture` | `skills/engineering/improve-codebase-architecture/` |

## Why reference instead of vendor?

The owner operating directive at the top of
[`context-mode-ops/SKILL.md`](https://github.com/mksglu/context-mode/tree/next/.claude/skills/context-mode-ops/SKILL.md)
treats these skills as mandatory tools, not advisory references.
Maintainers running `/context-mode-ops` install the upstream skills
once via the command above; end users do not need them. This keeps
the plugin install lean while preserving the discipline.

## License preservation

The MIT license terms travel with the source. Full license text lives
at the upstream repository
(https://github.com/mattpocock/skills). No portion is relicensed.
Skills remain MIT under Matt Pocock's copyright.
