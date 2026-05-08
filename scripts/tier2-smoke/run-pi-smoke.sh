#!/usr/bin/env bash
# Tier-2 smoke runner — Pi host.
#
# Boots a real Pi binary in headless mode, feeds it a fixture prompt that
# forces use of ctx_search / ctx_execute / ctx_index, then captures the
# `/ctx-stats` JSON payload and pipes it into assert-stats.mjs.
#
# Requires:
#   - PI_BIN              path to the pi executable (default: $(which pi))
#   - ANTHROPIC_API_KEY   model provider key, capped on the Anthropic console
#   - PI_HEADLESS_FLAGS   any extra flags to pass to pi (default: --headless)
#   - FIXTURE             prompt fixture path (default: fixtures/search-corpus.txt)
#
# Exit code 0 on pass, non-zero on fail.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SMOKE_DIR="$REPO_ROOT/scripts/tier2-smoke"
LOG_DIR="${RUNNER_TEMP:-/tmp}/tier2-smoke-pi"
mkdir -p "$LOG_DIR"

PI_BIN="${PI_BIN:-$(command -v pi || true)}"
PI_HEADLESS_FLAGS="${PI_HEADLESS_FLAGS:---headless}"
FIXTURE="${FIXTURE:-$SMOKE_DIR/fixtures/search-corpus.txt}"
STATS_OUT="$LOG_DIR/ctx-stats.json"
PI_LOG="$LOG_DIR/pi.log"

echo "=== Tier-2 smoke (Pi) ==="
echo "Repo:    $REPO_ROOT"
echo "Pi bin:  ${PI_BIN:-<not found>}"
echo "Fixture: $FIXTURE"
echo "Logs:    $LOG_DIR"
echo

if [ -z "${PI_BIN:-}" ] || [ ! -x "$PI_BIN" ]; then
  echo "FATAL  Pi binary not found. Install Pi and set PI_BIN, or add it to PATH." >&2
  exit 2
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "FATAL  ANTHROPIC_API_KEY not set. Configure it as a repo secret." >&2
  exit 2
fi

if [ ! -f "$FIXTURE" ]; then
  echo "FATAL  Fixture not found at $FIXTURE" >&2
  exit 2
fi

# Sanity check: context-mode plugin must already be registered with Pi.
# The workflow installs it via scripts/install-* before invoking this script.
echo "--- Pi version ---"
"$PI_BIN" --version 2>&1 | tee -a "$PI_LOG"
echo

# Run Pi headless on the fixture prompt. We force a hard token cap to avoid
# accidental over-spending if the model misbehaves.
echo "--- Running fixture prompt ---"
PROMPT="$(cat "$FIXTURE")"
"$PI_BIN" $PI_HEADLESS_FLAGS \
  --max-tokens "${PI_MAX_TOKENS:-2000}" \
  --prompt "$PROMPT" \
  2>&1 | tee -a "$PI_LOG"
echo

# Ask Pi for the structured ctx-stats payload. The Pi extension exposes
# /ctx-stats as a registered command; in headless mode it should be
# callable via the same `--prompt` channel with a `/ctx-stats --json` hint,
# but we also fall back to invoking the bundled CLI directly if Pi cannot
# emit JSON.
echo "--- Capturing ctx-stats ---"
if "$PI_BIN" $PI_HEADLESS_FLAGS --prompt "/ctx-stats --json" \
   > "$STATS_OUT" 2>>"$PI_LOG"; then
  echo "ctx-stats captured via Pi /ctx-stats command"
else
  echo "Pi /ctx-stats failed — falling back to bundled CLI"
  node "$REPO_ROOT/cli.bundle.mjs" stats --json > "$STATS_OUT"
fi
echo

# Assert.
echo "--- Assertions ---"
node "$SMOKE_DIR/assert-stats.mjs" "$STATS_OUT"
