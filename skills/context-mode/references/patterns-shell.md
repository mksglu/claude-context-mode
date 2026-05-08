# Shell Patterns for execute

Practical patterns for using `execute` with `language: shell`.
Best for piping, filtering, and leveraging native OS tools.

---

## Build Output Filtering

### Capture build errors only

```shell
npm run build 2>&1 | tee /tmp/build-output.txt
EXIT_CODE=${PIPESTATUS[0]}

echo "=== Build Result ==="
echo "Exit code: $EXIT_CODE"

if [ "$EXIT_CODE" -ne 0 ]; then
  echo ""
  echo "=== Errors ==="
  grep -iE '(error|failed|FAIL)' /tmp/build-output.txt | head -50
  echo ""
  echo "=== Warnings ==="
  grep -iE '(warning|warn)' /tmp/build-output.txt | head -20
else
  echo "Build succeeded."
  echo ""
  echo "=== Warnings (if any) ==="
  grep -iE '(warning|warn)' /tmp/build-output.txt | head -10
fi

echo ""
echo "=== Output Size ==="
wc -l < /tmp/build-output.txt | xargs -I{} echo "{} total lines of output"
rm -f /tmp/build-output.txt
```
> summary_prompt: "Report build success/failure, list all errors with file paths, and count warnings"
> timeout_ms: 120000

### TypeScript compilation check

```shell
npx tsc --noEmit 2>&1 | tee /tmp/tsc-output.txt
EXIT_CODE=${PIPESTATUS[0]}

echo "=== TypeScript Check ==="
echo "Exit code: $EXIT_CODE"

TOTAL_ERRORS=$(grep -c 'error TS' /tmp/tsc-output.txt 2>/dev/null || echo 0)
echo "Total errors: $TOTAL_ERRORS"

if [ "$TOTAL_ERRORS" -gt 0 ]; then
  echo ""
  echo "=== Errors by Code ==="
  grep -oP 'error TS\d+' /tmp/tsc-output.txt | sort | uniq -c | sort -rn | head -20

  echo ""
  echo "=== Errors by File ==="
  grep 'error TS' /tmp/tsc-output.txt | cut -d'(' -f1 | sort | uniq -c | sort -rn | head -20

  echo ""
  echo "=== First 30 Errors ==="
  grep 'error TS' /tmp/tsc-output.txt | head -30
fi

rm -f /tmp/tsc-output.txt
```
> summary_prompt: "Report type error count, most common error codes, and most affected files"
> timeout_ms: 60000

---

## Test Result Summarization

### Jest test summary

```shell
npx jest --verbose 2>&1 | tee /tmp/test-output.txt
EXIT_CODE=${PIPESTATUS[0]}

echo ""
echo "=== Test Summary ==="
echo "Exit code: $EXIT_CODE"

# Extract summary line
grep -E '(Tests:|Test Suites:|Snapshots:|Time:)' /tmp/test-output.txt

echo ""
echo "=== Failed Tests ==="
grep -A 2 'FAIL ' /tmp/test-output.txt | head -40

echo ""
echo "=== Slow Tests (if reported) ==="
grep -i 'slow' /tmp/test-output.txt | head -10

rm -f /tmp/test-output.txt
```
> summary_prompt: "Report pass/fail ratio, list all failing test names with suite, note any slow tests"
> timeout_ms: 120000

### Pytest summary

```shell
python -m pytest --tb=short -q 2>&1 | tee /tmp/pytest-output.txt
EXIT_CODE=${PIPESTATUS[0]}

echo ""
echo "=== Pytest Summary ==="
echo "Exit code: $EXIT_CODE"

# Last 20 lines usually contain the summary
tail -20 /tmp/pytest-output.txt

echo ""
echo "=== Failures ==="
grep -E '(FAILED|ERROR)' /tmp/pytest-output.txt | head -30

rm -f /tmp/pytest-output.txt
```
> summary_prompt: "Report test results, list all failures with file and test name"
> timeout_ms: 120000

---

## Log File Analysis

### Filter application logs by severity

```shell
LOG_FILE="${1:-/var/log/app.log}"

echo "=== Log File: $LOG_FILE ==="
echo "Total lines: $(wc -l < "$LOG_FILE")"
echo ""

echo "=== Level Distribution ==="
grep -oE '\b(DEBUG|INFO|WARN|ERROR|FATAL)\b' "$LOG_FILE" | sort | uniq -c | sort -rn

echo ""
echo "=== Last 20 Errors ==="
grep -i 'ERROR\|FATAL' "$LOG_FILE" | tail -20

echo ""
echo "=== Error Timeline (hourly) ==="
grep -i 'ERROR' "$LOG_FILE" | grep -oE '\d{4}-\d{2}-\d{2} \d{2}' | sort | uniq -c | tail -24
```
> summary_prompt: "Report error frequency, identify patterns, and note any error spikes"

### Analyze access logs

```shell
LOG_FILE="${1:-/var/log/access.log}"

echo "=== Access Log Summary ==="
echo "Total requests: $(wc -l < "$LOG_FILE")"

echo ""
echo "=== HTTP Status Codes ==="
awk '{print $9}' "$LOG_FILE" | sort | uniq -c | sort -rn | head -10

echo ""
echo "=== Top 20 Paths ==="
awk '{print $7}' "$LOG_FILE" | sort | uniq -c | sort -rn | head -20

echo ""
echo "=== Top 10 IPs ==="
awk '{print $1}' "$LOG_FILE" | sort | uniq -c | sort -rn | head -10

echo ""
echo "=== 5xx Errors ==="
awk '$9 ~ /^5/' "$LOG_FILE" | tail -20

echo ""
echo "=== Requests per Hour ==="
awk '{print $4}' "$LOG_FILE" | cut -d: -f1-2 | sort | uniq -c | tail -24
```
> summary_prompt: "Report traffic patterns, error rates, most hit endpoints, and suspicious IPs"

---

## Directory Size and Structure Analysis

### Project structure overview

```shell
echo "=== Directory Structure ==="
find . -maxdepth 3 -type d \
  ! -path '*/node_modules/*' \
  ! -path '*/.git/*' \
  ! -path '*/dist/*' \
  ! -path '*/.next/*' \
  ! -path '*/__pycache__/*' \
  | sort

echo ""
echo "=== File Type Distribution ==="
find . -type f \
  ! -path '*/node_modules/*' \
  ! -path '*/.git/*' \
  ! -path '*/dist/*' \
  | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -20

echo ""
echo "=== Largest Files (top 20) ==="
find . -type f \
  ! -path '*/node_modules/*' \
  ! -path '*/.git/*' \
  -exec ls -la {} \; | sort -k5 -rn | head -20 | awk '{print $5, $9}'

echo ""
echo "=== Directory Sizes ==="
du -sh */ 2>/dev/null | sort -rh | head -15
```
> summary_prompt: "Describe the project structure, identify large files that may need attention, report file type distribution"

### Disk usage investigation

```shell
echo "=== Top-Level Disk Usage ==="
du -sh */ 2>/dev/null | sort -rh

echo ""
echo "=== node_modules Size ==="
if [ -d "node_modules" ]; then
  du -sh node_modules
  echo ""
  echo "=== Largest node_modules packages ==="
  du -sh node_modules/*/ 2>/dev/null | sort -rh | head -20
else
  echo "No node_modules directory"
fi

echo ""
echo "=== Build Artifacts ==="
for dir in dist build .next out .cache; do
  if [ -d "$dir" ]; then
    echo "  $dir: $(du -sh "$dir" | cut -f1)"
  fi
done

echo ""
echo "=== Git Objects Size ==="
if [ -d ".git" ]; then
  du -sh .git
fi
```
> summary_prompt: "Report total project size, largest contributors, and recommend cleanup targets"

---

## Git Analysis

### Commit activity analysis

```shell
echo "=== Recent Commits (last 30 days) ==="
git log --since="30 days ago" --oneline | wc -l | xargs -I{} echo "{} commits in last 30 days"

echo ""
echo "=== Commits by Author ==="
git shortlog -sn --since="30 days ago" | head -15

echo ""
echo "=== Most Changed Files (last 30 days) ==="
git log --since="30 days ago" --pretty=format: --name-only | sort | uniq -c | sort -rn | head -20

echo ""
echo "=== Branches ==="
echo "Local: $(git branch | wc -l | xargs)"
echo "Remote: $(git branch -r | wc -l | xargs)"

echo ""
echo "=== Stale Branches (merged, excluding main/master) ==="
git branch --merged main 2>/dev/null | grep -v 'main\|master\|\*' | head -10
```
> summary_prompt: "Report development velocity, active contributors, hotspot files, and cleanup opportunities"
