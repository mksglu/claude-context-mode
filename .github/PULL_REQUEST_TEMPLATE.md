## What / Why / How

<!-- Brief: what changed, why, and implementation approach. Link issue: Fixes #000 -->

## Affected platforms

<!-- Check all platforms affected by this change -->

- [ ] Claude Code
- [ ] Cursor
- [ ] VS Code Copilot (GitHub Copilot)
- [ ] JetBrains Copilot
- [ ] Gemini CLI
- [ ] Qwen Code
- [ ] OpenCode
- [ ] KiloCode
- [ ] Codex CLI
- [ ] OpenClaw (Pi Agent)
- [ ] Pi
- [ ] Kiro
- [ ] Antigravity
- [ ] Zed
- [ ] All platforms

## Test plan

<!-- What tests were added or modified? -->

## Checklist

- [ ] Tests added/updated (TDD: red → green)
- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] Docs updated if needed (README, platform-support.md)
- [ ] No Windows path regressions (forward slashes only)
- [ ] Targets `next` branch (unless hotfix)

<details>
<summary><strong>Cross-platform notes</strong></summary>

Our CI runs on **Ubuntu, macOS, and Windows**.

- If touching file paths, verify forward-slash normalization on Windows
- If touching hook paths, verify no backslash separators
- Use `path.join()` / `path.resolve()`, never hardcode `/` separators
- Use event-based stdin reading — `readFileSync(0)` breaks on Windows
- Use `os.tmpdir()`, never hardcode `/tmp`

</details>
