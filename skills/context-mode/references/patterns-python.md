# Python Patterns for execute

Practical patterns for using `execute` with `language: python`.
All examples use Python standard library only (no pip installs required).

---

## Data Processing with json Module

### Analyze a large JSON dataset

```python
import json

with open('data/users.json') as f:
    users = json.load(f)

print(f"Total users: {len(users)}")

# Group by status
from collections import Counter
statuses = Counter(u.get('status', 'unknown') for u in users)
print("\n=== Users by Status ===")
for status, count in statuses.most_common():
    print(f"  {status}: {count}")

# Find anomalies
inactive_with_recent = [
    u for u in users
    if u.get('status') == 'inactive' and u.get('last_login', '') > '2025-01-01'
]
if inactive_with_recent:
    print(f"\n=== Anomaly: {len(inactive_with_recent)} inactive users with recent logins ===")
    for u in inactive_with_recent[:10]:
        print(f"  {u['email']} - last login: {u['last_login']}")

# Field completeness
fields = ['name', 'email', 'phone', 'address']
print("\n=== Field Completeness ===")
for field in fields:
    filled = sum(1 for u in users if u.get(field))
    pct = (filled / len(users)) * 100 if users else 0
    print(f"  {field}: {filled}/{len(users)} ({pct:.1f}%)")
```
> summary_prompt: "Report user distribution, data quality issues, and any anomalies found"

### Merge and compare two JSON configs

```python
import json

with open('config.default.json') as f:
    defaults = json.load(f)
with open('config.local.json') as f:
    local = json.load(f)

def compare(d1, d2, path=""):
    diffs = []
    all_keys = set(list(d1.keys()) + list(d2.keys()))
    for key in sorted(all_keys):
        full_path = f"{path}.{key}" if path else key
        if key not in d1:
            diffs.append(f"  + {full_path} = {json.dumps(d2[key])}")
        elif key not in d2:
            diffs.append(f"  - {full_path} = {json.dumps(d1[key])}")
        elif isinstance(d1[key], dict) and isinstance(d2[key], dict):
            diffs.extend(compare(d1[key], d2[key], full_path))
        elif d1[key] != d2[key]:
            diffs.append(f"  ~ {full_path}: {json.dumps(d1[key])} -> {json.dumps(d2[key])}")
    return diffs

diffs = compare(defaults, local)
print(f"Config differences: {len(diffs)}")
if diffs:
    print("\n=== Changes (local overrides) ===")
    for d in diffs:
        print(d)
else:
    print("No differences found — local matches defaults.")
```
> summary_prompt: "List all local config overrides and flag any potentially dangerous changes"

---

## CSV / Log File Analysis

### Analyze a CSV file

```python
import csv
from collections import Counter, defaultdict
from datetime import datetime

with open('data/transactions.csv') as f:
    reader = csv.DictReader(f)
    rows = list(reader)

print(f"Total records: {len(rows)}")
print(f"Columns: {', '.join(rows[0].keys()) if rows else 'none'}")

# Summary statistics for numeric column
amounts = [float(r['amount']) for r in rows if r.get('amount')]
if amounts:
    print(f"\n=== Amount Statistics ===")
    print(f"  Min:    ${min(amounts):,.2f}")
    print(f"  Max:    ${max(amounts):,.2f}")
    print(f"  Mean:   ${sum(amounts)/len(amounts):,.2f}")
    print(f"  Median: ${sorted(amounts)[len(amounts)//2]:,.2f}")
    print(f"  Total:  ${sum(amounts):,.2f}")

# Group by category
if 'category' in rows[0]:
    by_cat = defaultdict(list)
    for r in rows:
        by_cat[r['category']].append(float(r.get('amount', 0)))
    print("\n=== By Category ===")
    for cat, vals in sorted(by_cat.items(), key=lambda x: -sum(x[1])):
        print(f"  {cat}: {len(vals)} txns, total ${sum(vals):,.2f}")
```
> summary_prompt: "Summarize transaction patterns, highlight outliers, report category distribution"

### Parse application logs

```python
import re
from collections import Counter
from datetime import datetime

error_pattern = re.compile(r'\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] (\w+): (.+)')

levels = Counter()
errors_by_type = Counter()
hourly = Counter()

with open('app.log') as f:
    for line in f:
        match = error_pattern.match(line.strip())
        if match:
            timestamp, level, message = match.groups()
            levels[level] += 1
            hour = timestamp[:13]
            hourly[hour] += 1
            if level in ('ERROR', 'FATAL'):
                # Extract error class
                err_type = message.split(':')[0].strip()
                errors_by_type[err_type] += 1

print("=== Log Level Distribution ===")
for level, count in levels.most_common():
    print(f"  {level}: {count}")

print("\n=== Top Error Types ===")
for err, count in errors_by_type.most_common(10):
    print(f"  {err}: {count}")

print("\n=== Hourly Activity (last 24h) ===")
for hour, count in sorted(hourly.items())[-24:]:
    bar = '#' * min(count // 10, 50)
    print(f"  {hour}: {count:>5} {bar}")
```
> summary_prompt: "Report error rates, identify the most common failures, and note any traffic spikes"

---

## Text Extraction and Summarization

### Extract TODOs and FIXMEs from codebase

```python
import os
import re

pattern = re.compile(r'(TODO|FIXME|HACK|XXX|WARN)[:\s](.+)', re.IGNORECASE)
results = []

for root, dirs, files in os.walk('src'):
    # Skip node_modules and hidden dirs
    dirs[:] = [d for d in dirs if not d.startswith('.') and d != 'node_modules']
    for fname in files:
        if fname.endswith(('.ts', '.tsx', '.js', '.jsx', '.py')):
            filepath = os.path.join(root, fname)
            with open(filepath) as f:
                for i, line in enumerate(f, 1):
                    match = pattern.search(line)
                    if match:
                        results.append({
                            'file': filepath,
                            'line': i,
                            'type': match.group(1).upper(),
                            'text': match.group(2).strip()
                        })

from collections import Counter
by_type = Counter(r['type'] for r in results)

print(f"Total annotations found: {len(results)}\n")
print("=== By Type ===")
for t, c in by_type.most_common():
    print(f"  {t}: {c}")

print("\n=== All Items ===")
for r in results:
    print(f"  [{r['type']}] {r['file']}:{r['line']} — {r['text'][:100]}")
```
> summary_prompt: "Categorize TODOs by urgency, group by file area, suggest which to address first"

### Summarize a large text/markdown file

```python
with open('ARCHITECTURE.md') as f:
    content = f.read()

lines = content.split('\n')
print(f"Total lines: {len(lines)}")
print(f"Total words: {len(content.split())}")

# Extract structure
headings = [(i+1, line) for i, line in enumerate(lines) if line.startswith('#')]
print(f"Sections: {len(headings)}\n")

print("=== Document Structure ===")
for line_num, heading in headings:
    level = len(heading) - len(heading.lstrip('#'))
    indent = '  ' * (level - 1)
    print(f"  {indent}{heading.strip()} (line {line_num})")

# Extract code blocks
import re
code_blocks = re.findall(r'```(\w+)?', content)
if code_blocks:
    from collections import Counter
    langs = Counter(b for b in code_blocks if b)
    print(f"\n=== Code Blocks: {len(code_blocks)} total ===")
    for lang, count in langs.most_common():
        print(f"  {lang}: {count}")

# Print first 50 lines for content preview
print("\n=== Content Preview (first 50 lines) ===")
for line in lines[:50]:
    print(line)
```
> summary_prompt: "Summarize the document structure, key architectural decisions, and main components described"

---

## File Comparison

### Compare two source files

```python
import difflib

with open('src/auth/login.ts') as f:
    old_lines = f.readlines()
with open('src/auth/login.new.ts') as f:
    new_lines = f.readlines()

diff = list(difflib.unified_diff(old_lines, new_lines, fromfile='login.ts', tofile='login.new.ts', lineterm=''))

additions = sum(1 for l in diff if l.startswith('+') and not l.startswith('+++'))
deletions = sum(1 for l in diff if l.startswith('-') and not l.startswith('---'))

print(f"Changes: +{additions} -{deletions}\n")

if diff:
    print("=== Diff ===")
    for line in diff:
        print(line)
else:
    print("Files are identical.")
```
> summary_prompt: "Describe the functional changes between the old and new versions"

### Find duplicate content across files

```python
import os
import hashlib
from collections import defaultdict

file_hashes = defaultdict(list)

for root, dirs, files in os.walk('src'):
    dirs[:] = [d for d in dirs if not d.startswith('.') and d != 'node_modules']
    for fname in files:
        if fname.endswith(('.ts', '.tsx', '.js', '.jsx')):
            filepath = os.path.join(root, fname)
            with open(filepath, 'rb') as f:
                content_hash = hashlib.md5(f.read()).hexdigest()
            file_hashes[content_hash].append(filepath)

duplicates = {h: files for h, files in file_hashes.items() if len(files) > 1}

if duplicates:
    print(f"Found {len(duplicates)} sets of duplicate files:\n")
    for h, files in duplicates.items():
        print(f"  Hash: {h[:8]}...")
        for f in files:
            print(f"    {f}")
        print()
else:
    print("No duplicate files found.")
```
> summary_prompt: "List all duplicate files and suggest which copies to remove"
