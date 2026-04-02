# Validation Patterns

Cross-cutting validation rules used by ALL workflows (triage, review, release).

## ENV Variable Verification

LLMs frequently hallucinate environment variables. Every ENV var in an issue or PR must be verified.

### Verification Protocol

For EACH environment variable mentioned:

```
Step 1: GREP — Does it exist in context-mode source?
  → rg "{ENV_VAR}" src/
  → If found: VERIFIED (we already use it)
  → If not found: continue to Step 2

Step 2: GREP ADAPTERS — Is it in the adapter detect logic?
  → Read src/adapters/detect.ts
  → Check the verified env vars comment block at the top
  → If listed: VERIFIED (we know about it)

Step 3: WEBSEARCH — Does the platform document it?
  → WebSearch: "{PLATFORM} {ENV_VAR} environment variable"
  → Check official docs, GitHub repos, release notes
  → If found in official source: REAL but we don't use it yet

Step 4: CONTEXT7 — Library documentation check
  → resolve-library-id for the platform
  → query-docs for the ENV var
  → Cross-reference with Step 3

Step 5: VERDICT
  → VERIFIED: We use it and it's real
  → REAL_NEW: Platform has it but we don't use it yet
  → HALLUCINATED: No evidence it exists — flag it
  → DEPRECATED: Used to exist but was removed
```

### Known Verified ENV Vars (Reference)

| Platform | Verified ENV Vars | Source |
|----------|------------------|--------|
| Claude Code | `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID` | src/adapters/detect.ts |
| Gemini CLI | `GEMINI_PROJECT_DIR`, `GEMINI_CLI` | src/adapters/detect.ts |
| OpenCode | `OPENCODE`, `OPENCODE_PID` | src/adapters/detect.ts |
| OpenClaw | `OPENCLAW_HOME`, `OPENCLAW_CLI` | src/adapters/detect.ts |
| Kilo | `KILO`, `KILO_PID` | src/adapters/detect.ts |
| Codex | `CODEX_CI`, `CODEX_THREAD_ID` | src/adapters/detect.ts |
| VS Code Copilot | `VSCODE_PID`, `VSCODE_CWD` | src/adapters/detect.ts |
| Cursor | `CURSOR_TRACE_ID`, `CURSOR_CLI` | src/adapters/detect.ts |
| Override | `CONTEXT_MODE_PLATFORM` | src/adapters/detect.ts |

Any ENV var NOT in this table must go through the full verification protocol.

## Adapter Test Matrix

### Full Matrix Run

```shell
# Run ALL adapter tests
npx vitest run tests/adapters/

# Individual adapter (for targeted testing)
npx vitest run tests/adapters/claude-code.test.ts
npx vitest run tests/adapters/gemini-cli.test.ts
npx vitest run tests/adapters/opencode.test.ts
npx vitest run tests/adapters/openclaw.test.ts
npx vitest run tests/adapters/kilo.test.ts
npx vitest run tests/adapters/codex.test.ts
npx vitest run tests/adapters/vscode-copilot.test.ts
npx vitest run tests/adapters/cursor.test.ts
npx vitest run tests/adapters/antigravity.test.ts
npx vitest run tests/adapters/kiro.test.ts
npx vitest run tests/adapters/zed.test.ts

# Detection logic
npx vitest run tests/adapters/detect.test.ts
npx vitest run tests/adapters/client-map.test.ts
```

### Report Format

```
ADAPTER TEST MATRIX
═══════════════════
claude-code     ✓ 5/5    gemini-cli      ✓ 4/4
opencode        ✓ 6/6    openclaw        ✓ 3/3
kilo            ✓ 4/4    codex           ✓ 3/3
vscode-copilot  ✓ 4/4    cursor          ✓ 3/3
antigravity     ✓ 2/2    kiro            ✓ 3/3
pi              ✓ 2/2    zed             ✓ 2/2
detect          ✓ 8/8    client-map      ✓ 6/6
───────────────────────────────────────────
TOTAL: {N}/{N} passed | 0 failed
```

## Core Module Tests

```shell
# Core tests
npx vitest run tests/core/routing.test.ts
npx vitest run tests/core/search.test.ts
npx vitest run tests/core/server.test.ts
npx vitest run tests/core/cli.test.ts

# Module tests
npx vitest run tests/store.test.ts
npx vitest run tests/executor.test.ts
npx vitest run tests/security.test.ts
npx vitest run tests/formatters.test.ts

# Hook tests
npx vitest run tests/hooks/

# Full suite
npm test
```

## OS Compatibility Checks

### Path Handling

```javascript
// WRONG — breaks on Windows
const configPath = homedir + "/.config/opencode/config.json";

// CORRECT — works everywhere
const configPath = path.join(homedir(), ".config", "opencode", "config.json");
```

Grep for potential issues:
```shell
# String concatenation with path separators
rg "homedir\(\)\s*\+" src/
rg '"/\.' src/
rg "'\\./" src/

# Direct slash usage in paths (should use path.join)
rg 'path\s*=.*"/' src/ --type ts
```

### Temp Directory

```javascript
// WRONG — hardcoded /tmp
const tmpFile = "/tmp/context-mode-output.txt";

// CORRECT — uses OS temp dir
const tmpFile = path.join(os.tmpdir(), "context-mode-output.txt");
```

Grep for hardcoded temp:
```shell
rg '"/tmp/' src/
rg "'/tmp/" src/
```

### Native Bindings (better-sqlite3)

Check that `better-sqlite3` is in `optionalDependencies` (not `dependencies`) and the code handles the case where it's not available:

```shell
rg "better-sqlite3" src/ --type ts
rg "optionalDependencies" package.json
```

### Process Spawn

```javascript
// WRONG — shell: true behaves differently on Windows
spawn("command", { shell: true });

// CORRECT — explicit shell selection
spawn("command", { shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh" });
```

## Hook Format Validation

Each platform has different hook formats. Verify changes match:

| Platform | Hook Format | Key Differences |
|----------|------------|-----------------|
| Claude Code | `hooks.json` in plugin dir | `PreToolUse`, `PostToolUse`, `PreCompact`, `SessionStart` |
| Gemini CLI | `~/.gemini/settings.json` | `BeforeTool`, `AfterTool`, `PreCompress`, `SessionStart` + `matcher` |
| VS Code Copilot | `.github/hooks/*.json` | Same as Claude Code but separate file |
| Cursor | `.cursor/hooks.json` | No `SessionStart` (injects via file instead) |
| OpenCode | `opencode.json` | Uses `agents` section, not traditional hooks |
| OpenClaw | `openclaw.plugin.json` | Extension model, not hook-based |

## Security Checks

### Sandbox Escape

```shell
# File writing attempts through ctx_execute
rg "writeFile\|appendFile\|createWriteStream" src/executor.ts

# Path traversal
rg "\.\.\/" src/ --type ts

# Command injection vectors
rg "exec\(.*\$\{" src/ --type ts
rg "spawn\(.*\$\{" src/ --type ts
```

### Information Disclosure

```shell
# Sensitive paths
rg "process\.env\b" src/ --type ts | grep -v "test"

# Home directory exposure
rg "homedir\(\)" src/ --type ts
```

## TypeScript Validation

```bash
# Full type check
npm run typecheck

# Should report 0 errors
# If errors exist, they MUST be fixed before shipping
```

## Pre-Ship Checklist

Every change, regardless of workflow, must pass:

- [ ] `npm run typecheck` — 0 errors
- [ ] `npm test` — all pass
- [ ] Adapter tests — all 12 pass (or N/A if untouched)
- [ ] ENV vars — all verified against real platform source
- [ ] Path handling — no hardcoded separators
- [ ] Hook format — matches target platform's schema
- [ ] No security regressions
