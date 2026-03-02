## What

<!-- Brief description of the change -->

## Why

<!-- What problem does this solve? Link to issue if applicable: Fixes #000 -->

## How

<!-- Implementation approach. What did you change and why? -->

## Test plan

- [ ] `npm run test:all` passes
- [ ] `npm run typecheck` passes
- [ ] `/context-mode:doctor` -- all checks PASS on my local build
- [ ] Tested in a live Claude Code session with my local MCP server

### Test output

<!-- Paste the output of `npm run test:all` here -->

```
```

### Before/After comparison

<!-- Show the output quality difference. Run the same prompt before and after your change. -->

## Local development setup

<!-- Confirm you followed the local dev workflow from CONTRIBUTING.md -->

- [ ] Pointed `installed_plugins.json` installPath to my local clone
- [ ] Updated `settings.json` hook path to my local clone
- [ ] Killed cached MCP server, verified local server is running
- [ ] Bumped version in `package.json` and confirmed with `/context-mode:doctor`

## Checklist

- [ ] I've checked [existing PRs](https://github.com/mksglu/claude-context-mode/pulls) to make sure this isn't a duplicate
- [ ] I'm targeting the `main` branch
- [ ] I've run the full test suite locally
- [ ] New functionality includes tests (TDD: red-green-refactor)
- [ ] No breaking changes to existing tool interfaces
- [ ] I've compared output quality before and after my change
