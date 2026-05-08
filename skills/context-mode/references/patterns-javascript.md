# JavaScript / TypeScript Patterns for execute

Practical patterns for using `execute` with `language: javascript`.
All examples assume Node.js runtime with native fetch (Node 18+).

---

## API Response Processing

### Fetch and summarize a REST API

```javascript
// execute: Analyze API health endpoint
const resp = await fetch('https://api.example.com/health');
const data = await resp.json();

console.log('=== Service Health ===');
console.log(`Status: ${data.status}`);
console.log(`Uptime: ${data.uptime}`);
console.log(`Timestamp: ${data.timestamp}`);

if (data.services) {
  console.log('\n=== Service Components ===');
  for (const [name, info] of Object.entries(data.services)) {
    console.log(`  ${name}: ${info.status} (latency: ${info.latency_ms}ms)`);
  }
}

if (data.errors && data.errors.length > 0) {
  console.log('\n=== Recent Errors ===');
  data.errors.slice(0, 10).forEach(e => {
    console.log(`  [${e.timestamp}] ${e.code}: ${e.message}`);
  });
}
```
> summary_prompt: "Report overall health, list any degraded services, and highlight errors"

### Paginated API collection

```javascript
// execute: Fetch all open issues from GitHub API
const owner = 'org';
const repo = 'project';
let page = 1;
let allIssues = [];

while (true) {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${page}`,
    { headers: { 'Accept': 'application/vnd.github.v3+json' } }
  );
  const issues = await resp.json();
  if (issues.length === 0) break;
  allIssues.push(...issues);
  page++;
}

console.log(`Total open issues: ${allIssues.length}\n`);

// Group by labels
const byLabel = {};
allIssues.forEach(issue => {
  issue.labels.forEach(label => {
    byLabel[label.name] = (byLabel[label.name] || 0) + 1;
  });
});

console.log('=== Issues by Label ===');
Object.entries(byLabel)
  .sort((a, b) => b[1] - a[1])
  .forEach(([label, count]) => console.log(`  ${label}: ${count}`));

// Oldest issues
console.log('\n=== 10 Oldest Issues ===');
allIssues
  .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  .slice(0, 10)
  .forEach(i => console.log(`  #${i.number} (${i.created_at.slice(0,10)}): ${i.title}`));
```
> summary_prompt: "Summarize issue distribution by label, highlight stale issues, suggest priorities"
> timeout_ms: 30000

---

## JSON Data Analysis

### Analyze a large JSON config file

```javascript
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('tsconfig.json', 'utf8'));

console.log('=== TSConfig Analysis ===');
console.log(`Target: ${data.compilerOptions?.target}`);
console.log(`Module: ${data.compilerOptions?.module}`);
console.log(`Strict: ${data.compilerOptions?.strict}`);
console.log(`Paths aliases: ${Object.keys(data.compilerOptions?.paths || {}).length}`);

if (data.compilerOptions?.paths) {
  console.log('\n=== Path Aliases ===');
  for (const [alias, targets] of Object.entries(data.compilerOptions.paths)) {
    console.log(`  ${alias} -> ${targets.join(', ')}`);
  }
}

if (data.include) console.log(`\nInclude: ${data.include.join(', ')}`);
if (data.exclude) console.log(`Exclude: ${data.exclude.join(', ')}`);
if (data.references) {
  console.log(`\nProject References: ${data.references.length}`);
  data.references.forEach(r => console.log(`  ${r.path}`));
}
```
> summary_prompt: "Report compiler strictness, module system, and any unusual configuration"

### Diff two JSON files

```javascript
const fs = require('fs');
const a = JSON.parse(fs.readFileSync('config.prod.json', 'utf8'));
const b = JSON.parse(fs.readFileSync('config.staging.json', 'utf8'));

function diffObjects(obj1, obj2, path = '') {
  const allKeys = new Set([...Object.keys(obj1 || {}), ...Object.keys(obj2 || {})]);
  for (const key of allKeys) {
    const fullPath = path ? `${path}.${key}` : key;
    if (!(key in (obj1 || {}))) {
      console.log(`+ ${fullPath}: ${JSON.stringify(obj2[key])}`);
    } else if (!(key in (obj2 || {}))) {
      console.log(`- ${fullPath}: ${JSON.stringify(obj1[key])}`);
    } else if (typeof obj1[key] === 'object' && typeof obj2[key] === 'object') {
      diffObjects(obj1[key], obj2[key], fullPath);
    } else if (JSON.stringify(obj1[key]) !== JSON.stringify(obj2[key])) {
      console.log(`~ ${fullPath}: ${JSON.stringify(obj1[key])} -> ${JSON.stringify(obj2[key])}`);
    }
  }
}

console.log('=== Config Diff: prod vs staging ===');
diffObjects(a, b);
```
> summary_prompt: "List all configuration differences between prod and staging environments"

---

## Package.json / Lock File Analysis

### Dependency audit

```javascript
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

const deps = Object.entries(pkg.dependencies || {});
const devDeps = Object.entries(pkg.devDependencies || {});

console.log(`Package: ${pkg.name}@${pkg.version}`);
console.log(`Dependencies: ${deps.length}`);
console.log(`DevDependencies: ${devDeps.length}`);

// Find non-pinned versions
console.log('\n=== Non-Pinned Dependencies ===');
[...deps, ...devDeps].forEach(([name, version]) => {
  if (version.startsWith('^') || version.startsWith('~') || version === '*') {
    console.log(`  ${name}: ${version}`);
  }
});

// Find duplicated categories
console.log('\n=== Scripts ===');
Object.entries(pkg.scripts || {}).forEach(([name, cmd]) => {
  console.log(`  ${name}: ${cmd}`);
});

// Workspace detection
if (pkg.workspaces) {
  console.log('\n=== Monorepo Workspaces ===');
  const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || [];
  ws.forEach(w => console.log(`  ${w}`));
}
```
> summary_prompt: "Report dependency health: unpinned versions, total count, any security concerns from package names"

### Lock file drift detection

```javascript
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

let lockExists = { npm: false, yarn: false, pnpm: false };
try { fs.accessSync('package-lock.json'); lockExists.npm = true; } catch {}
try { fs.accessSync('yarn.lock'); lockExists.yarn = true; } catch {}
try { fs.accessSync('pnpm-lock.yaml'); lockExists.pnpm = true; } catch {}

console.log('=== Lock File Status ===');
Object.entries(lockExists).forEach(([mgr, exists]) => {
  console.log(`  ${mgr}: ${exists ? 'PRESENT' : 'missing'}`);
});

const activeLocks = Object.entries(lockExists).filter(([, v]) => v);
if (activeLocks.length > 1) {
  console.log('\nWARNING: Multiple lock files detected! This causes inconsistent installs.');
}
if (activeLocks.length === 0) {
  console.log('\nWARNING: No lock file found! Dependencies are not reproducible.');
}

// Check engines
if (pkg.engines) {
  console.log('\n=== Required Engines ===');
  Object.entries(pkg.engines).forEach(([e, v]) => console.log(`  ${e}: ${v}`));
}
```
> summary_prompt: "Report lock file health and any warnings about package management"

---

## File Content Parsing

### Parse and summarize a large markdown file

```javascript
const fs = require('fs');
const content = fs.readFileSync('CHANGELOG.md', 'utf8');
const lines = content.split('\n');

const sections = [];
let currentSection = null;

for (const line of lines) {
  if (line.startsWith('## ')) {
    if (currentSection) sections.push(currentSection);
    currentSection = { title: line.replace('## ', ''), items: 0, breaking: 0 };
  } else if (currentSection && line.startsWith('- ')) {
    currentSection.items++;
    if (line.toLowerCase().includes('breaking') || line.toLowerCase().includes('BREAKING')) {
      currentSection.breaking++;
    }
  }
}
if (currentSection) sections.push(currentSection);

console.log(`Total versions: ${sections.length}\n`);
console.log('=== Recent Versions ===');
sections.slice(0, 10).forEach(s => {
  const warn = s.breaking > 0 ? ` [${s.breaking} BREAKING]` : '';
  console.log(`  ${s.title}: ${s.items} changes${warn}`);
});

const totalBreaking = sections.reduce((sum, s) => sum + s.breaking, 0);
if (totalBreaking > 0) {
  console.log(`\nTotal breaking changes across all versions: ${totalBreaking}`);
}
```
> summary_prompt: "Summarize recent releases, highlight breaking changes, report release cadence"

---

## Test Output Parsing

### Run tests and extract failures

```javascript
const { execSync } = require('child_process');

let output;
try {
  output = execSync('npx jest --json 2>/dev/null', { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
} catch (e) {
  output = e.stdout || '';
}

try {
  const results = JSON.parse(output);
  console.log(`=== Test Results ===`);
  console.log(`Suites: ${results.numPassedTestSuites} passed, ${results.numFailedTestSuites} failed`);
  console.log(`Tests:  ${results.numPassedTests} passed, ${results.numFailedTests} failed`);
  console.log(`Time:   ${(results.testResults || []).reduce((s, t) => s + (t.endTime - t.startTime), 0)}ms`);

  const failures = (results.testResults || []).filter(t => t.status === 'failed');
  if (failures.length > 0) {
    console.log('\n=== Failed Tests ===');
    failures.forEach(suite => {
      console.log(`\nSuite: ${suite.name}`);
      (suite.assertionResults || [])
        .filter(a => a.status === 'failed')
        .forEach(a => {
          console.log(`  FAIL: ${a.ancestorTitles.join(' > ')} > ${a.title}`);
          console.log(`    ${(a.failureMessages || []).join('\n    ').slice(0, 200)}`);
        });
    });
  }
} catch {
  console.log('Could not parse JSON output. Raw output:');
  console.log(output.slice(0, 5000));
}
```
> summary_prompt: "Report test pass/fail counts, list each failing test with its error message"
> timeout_ms: 60000
