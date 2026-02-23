# Publishing Plan — context-mode v0.4.0

## Current State

- Source: TypeScript, 1,647 LOC across 5 files
- Tests: 113 passing (3 suites)
- Benchmarks: 94% context savings across 13 use cases
- Package: `context-mode` v0.4.0, MIT license

## Publishing Channels (3 tiers)

### Tier 1: npm (Primary Distribution)

Users install via `npx -y context-mode` — no global install needed.

**Remaining Steps:**

1. **GitHub repo** — Create `mksglu/context-mode` (or your preferred org/name)
   - Push source code
   - Update `repository` URL in package.json if different from `mksglu/context-mode`

2. **npm account** — Verify npm login: `npm whoami`
   - If scoped package needed: `@mksglu/context-mode`

3. **First publish:**
   ```bash
   npm run build
   npm publish
   ```

4. **Verify install works:**
   ```bash
   npx -y context-mode  # should start MCP server on stdio
   ```

### Tier 2: MCP Registry (Discoverability)

Register on [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io/) for discoverability by all MCP clients.

**Steps:**

1. Install publisher: `npm install -g mcp-publisher`
2. Authenticate with GitHub
3. Register: `mcp-publisher publish`
4. Server name: `io.github.mksglu/context-mode`

### Tier 3: Claude Code Plugin Marketplace (Optional)

Bundle as a Claude Code plugin with skills/hooks for enhanced experience.

**Steps:**

1. Create `.claude-plugin/manifest.json`
2. Register on community marketplace at claudemarketplaces.com
3. Or submit to Anthropic's official marketplace

## Pre-Publish Checklist

| Item | Status | Action |
|------|--------|--------|
| README.md | Done | Comprehensive with benchmarks, installation, architecture |
| LICENSE | Done | MIT |
| .gitignore | Done | Excludes node_modules, build, .db files |
| .npmignore | Done | Only ships build/, skills/, README, LICENSE |
| package.json `files` | Done | `["build", "skills", "README.md", "LICENSE"]` |
| package.json `keywords` | Done | mcp, claude, context-window, sandbox |
| package.json `repository` | Done | github.com/mksglu/context-mode |
| package.json `bin` | Done | Points to `./build/server.js` |
| `prepublishOnly` script | Done | Runs `npm run build` before publish |
| Shebang on server.ts | Done | `#!/usr/bin/env node` on line 1 |
| TypeScript builds clean | Done | `tsc` passes with no errors |
| All tests pass | Done | 113/113 |

## Post-Publish Steps

1. **Tag release**: `git tag v0.4.0 && git push --tags`
2. **GitHub Release**: Create release with changelog
3. **Test npx install**: `npx -y context-mode` in a clean environment
4. **Test Claude Code integration**:
   ```bash
   claude mcp add-json context-mode '{"type":"stdio","command":"npx","args":["-y","context-mode"]}'
   ```
5. **Social**: Share on X/LinkedIn with benchmark screenshots

## CI/CD (Future)

GitHub Actions workflow for automated publishing on release tags:

```yaml
# .github/workflows/publish.yml
name: Publish to npm
on:
  release:
    types: [published]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run test:store
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## Installation Command for Users

After publishing, users just run:

```bash
claude mcp add-json context-mode '{"type":"stdio","command":"npx","args":["-y","context-mode"]}'
```

One command. Done.
