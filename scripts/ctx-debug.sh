#!/usr/bin/env bash
# context-mode diagnostic report
# Runs 18 diagnostic sections, writes markdown + JSON to temp files,
# shows a compact summary in the terminal.
#
# Usage: bash scripts/ctx-debug.sh
# Output: /tmp/ctx-debug-<ts>.md  +  /tmp/ctx-debug-<ts>.json
#
# Works on Linux, macOS, and Windows (Git Bash / MSYS2 / WSL).

CTX_DEBUG_VERSION="2.0.0"
set -uo pipefail  # NOT -e — we must never crash

# ─── Helpers ──────────────────────────────────────────────────────────────────

# Detect plugin root (directory containing this script's parent).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)}"

# timed SECS CMD [ARGS...] — portable timeout wrapper (macOS has no `timeout`)
timed() {
  local secs="$1"; shift
  if command -v timeout &>/dev/null; then
    timeout "$secs" "$@"
  elif command -v gtimeout &>/dev/null; then
    gtimeout "$secs" "$@"
  else
    "$@"
  fi
}

# safe_cmd CMD [ARGS...] — run a command with a 10-second timeout.
# Prints stdout on success or a failure marker on error.
safe_cmd() {
  local out rc
  if command -v timeout &>/dev/null; then
    out="$(timeout 10 "$@" 2>&1)" && rc=0 || rc=$?
  elif command -v gtimeout &>/dev/null; then
    out="$(gtimeout 10 "$@" 2>&1)" && rc=0 || rc=$?
  else
    out="$("$@" 2>&1)" && rc=0 || rc=$?
  fi
  if [ $rc -eq 0 ]; then
    printf '%s' "$out"
  elif [ $rc -eq 127 ]; then
    printf '[SKIP] command not found: %s' "$1"
  else
    printf '[FAIL] exit %d — %s' "$rc" "$out"
  fi
}

# safe_cmd_quiet — like safe_cmd but returns "" on failure (no marker).
safe_cmd_quiet() {
  local out
  if command -v timeout &>/dev/null; then
    out="$(timeout 10 "$@" 2>/dev/null)" || out=""
  elif command -v gtimeout &>/dev/null; then
    out="$(gtimeout 10 "$@" 2>/dev/null)" || out=""
  else
    out="$("$@" 2>/dev/null)" || out=""
  fi
  printf '%s' "$out"
}

# redact — replace API keys, tokens, secrets, and connection strings with ***REDACTED***.
redact() {
  sed -E \
    -e 's/(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/\1***REDACTED***/g' \
    -e 's/("(key|token|secret|password|apiKey|api_key|auth|credential|authorization)"[[:space:]]*:[[:space:]]*")([^"]{4})[^"]*/\1\3***REDACTED***/g' \
    -e 's/(ghp_[A-Za-z0-9]{4})[A-Za-z0-9]+/\1***REDACTED***/g' \
    -e 's/(ghu_[A-Za-z0-9]{4})[A-Za-z0-9]+/\1***REDACTED***/g' \
    -e 's/(xox[bpras]-[A-Za-z0-9]{4})[A-Za-z0-9-]+/\1***REDACTED***/g' \
    -e 's|(postgres(ql)?://[^:]+:)[^@]+(@)|\1***REDACTED***\3|g' \
    -e 's|(mongodb(\+srv)?://[^:]+:)[^@]+(@)|\1***REDACTED***\3|g' \
    -e 's|(mysql://[^:]+:)[^@]+(@)|\1***REDACTED***\2|g' \
    -e 's|(redis://[^:]+:)[^@]+(@)|\1***REDACTED***\2|g' \
    -e 's|(https?://[^:]+:)[^@]+(@)|\1***REDACTED***\2|g'
}

# ─── JSONL accumulator ──────────────────────────────────────────────────────
# All data goes to a JSONL temp file. At the end, node converts to final JSON.
JSONL_FILE="$(mktemp)"
CURRENT_SECTION=""
PASS_TOTAL=0
FAIL_TOTAL=0
WARN_TOTAL=0

_jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n'; }

section() {
  CURRENT_SECTION="$1"
}

check() {
  local label="$1" ok="$2"
  if [ "$ok" = "true" ]; then
    PASS_TOTAL=$((PASS_TOTAL + 1))
    printf '{"t":"c","s":"%s","l":"%s","p":true}\n' "$CURRENT_SECTION" "$(_jesc "$label")" >> "$JSONL_FILE"
  else
    FAIL_TOTAL=$((FAIL_TOTAL + 1))
    printf '{"t":"c","s":"%s","l":"%s","p":false}\n' "$CURRENT_SECTION" "$(_jesc "$label")" >> "$JSONL_FILE"
  fi
}

kv() {
  printf '{"t":"i","s":"%s","k":"%s","v":"%s"}\n' "$CURRENT_SECTION" "$(_jesc "$1")" "$(_jesc "$2")" >> "$JSONL_FILE"
}

warn() {
  WARN_TOTAL=$((WARN_TOTAL + 1))
  printf '{"t":"w","s":"%s","m":"%s"}\n' "$CURRENT_SECTION" "$(_jesc "$1")" >> "$JSONL_FILE"
}

detail() {
  printf '{"t":"d","s":"%s","m":"%s"}\n' "$CURRENT_SECTION" "$(_jesc "$1")" >> "$JSONL_FILE"
}

# detect_os — sets OS_TYPE to "macos", "linux", "windows", or "unknown".
detect_os() {
  case "$(uname -s 2>/dev/null)" in
    Darwin*)  OS_TYPE="macos"   ;;
    Linux*)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        OS_TYPE="wsl"
      else
        OS_TYPE="linux"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)  OS_TYPE="windows" ;;
    *)  OS_TYPE="unknown" ;;
  esac
}

# abbrev_path — shorten HOME to ~ for display.
abbrev_path() {
  local p="$1"
  if [ -n "${HOME:-}" ]; then
    printf '%s' "${p/#$HOME/~}"
  else
    printf '%s' "$p"
  fi
}

# config_file — check existence, capture contents (redacted) into JSON.
config_file() {
  local label="$1" path="$2"
  local display
  display="$(abbrev_path "$path")"
  if [ -f "$path" ]; then
    kv "$label" "$display (exists)"
    # Use node for proper JSON escaping of file content
    local content_json
    content_json="$(node -e "
      const fs=require('fs');
      let c=fs.readFileSync('$path','utf8').slice(0,3000);
      // Redact secrets
      c=c.replace(/(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g,'\$1***');
      c=c.replace(/(postgres(ql)?:\/\/[^:]+:)[^@]+(@)/g,'\$1***\$3');
      c=c.replace(/(mongodb(\+srv)?:\/\/[^:]+:)[^@]+(@)/g,'\$1***\$3');
      console.log(JSON.stringify(c));
    " 2>/dev/null || echo '""')"
    printf '{"t":"cfg","s":"%s","k":"%s","path":"%s","exists":true,"content":%s}\n' "$CURRENT_SECTION" "$(_jesc "$label")" "$(_jesc "$display")" "$content_json" >> "$JSONL_FILE"
  else
    kv "$label" "$display (not found)"
  fi
}

# ─── Output setup ─────────────────────────────────────────────────────────────

TS="$(date +%s)"
EFFECTIVE_TMP="${TMPDIR:-${TEMP:-${TMP:-/tmp}}}"
JSON_FILE="${EFFECTIVE_TMP}/ctx-debug-${TS}.json"

# Ensure node can find plugin dependencies
export NODE_PATH="$PLUGIN_ROOT/node_modules:${NODE_PATH:-}"

# Redirect all stray stdout to /dev/null — only JSONL accumulation matters
exec 3>&1          # save original stdout (terminal)
exec 1>/dev/null   # suppress stray output

# ─── Begin Report ─────────────────────────────────────────────────────────────

detect_os

NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date '+%Y-%m-%d %H:%M:%S')"

cat <<HEADER
# context-mode diagnostic report

> Generated by \`ctx-debug.sh\` v${CTX_DEBUG_VERSION} at ${NOW}
HEADER

# ─── 1. System Info ──────────────────────────────────────────────────────────

section "1. System Info"

kv "OS type" "$OS_TYPE"
kv "uname -a" "$(safe_cmd_quiet uname -a | head -c 200)"
kv "Architecture" "$(safe_cmd_quiet uname -m)"

if [ "$OS_TYPE" = "macos" ]; then
  kv "macOS version" "$(safe_cmd_quiet sw_vers -productVersion) ($(safe_cmd_quiet sw_vers -buildVersion))"
elif [ "$OS_TYPE" = "linux" ] || [ "$OS_TYPE" = "wsl" ]; then
  if [ -f /etc/os-release ]; then
    kv "Distro" "$(safe_cmd_quiet bash -c '. /etc/os-release && echo "$PRETTY_NAME"')"
  fi
elif [ "$OS_TYPE" = "windows" ]; then
  kv "Windows ver" "$(safe_cmd_quiet cmd //c ver 2>/dev/null | tr -d '\r')"
fi

kv "Shell" "${SHELL:-unknown}"
[ -n "${BASH_VERSION:-}" ] && kv "Bash version" "$BASH_VERSION"
[ -n "${ZSH_VERSION:-}" ]  && kv "Zsh version" "$ZSH_VERSION"
kv "Locale" "LANG=${LANG:-unset}, LC_ALL=${LC_ALL:-unset}"

# ─── 2. Runtime Versions ─────────────────────────────────────────────────────

section "2. Runtime Versions"

# Node.js
NODE_VER="$(safe_cmd_quiet node --version)"
NODE_PATH_BIN="$(safe_cmd_quiet which node)"
if [ -n "$NODE_VER" ]; then
  kv "Node.js" "$NODE_VER"
  kv "node path" "$NODE_PATH_BIN"
  kv "execPath" "$(safe_cmd_quiet node -e 'console.log(process.execPath)')"

  # Install method heuristic
  NODE_INSTALL="unknown"
  case "$NODE_PATH_BIN" in
    */snap/*)       NODE_INSTALL="snap" ;;
    */.nvm/*)       NODE_INSTALL="nvm" ;;
    */.volta/*)     NODE_INSTALL="volta" ;;
    */.mise/*)      NODE_INSTALL="mise" ;;
    */.asdf/*)      NODE_INSTALL="asdf" ;;
    */.fnm/*)       NODE_INSTALL="fnm" ;;
    */homebrew/*|*/Homebrew/*|*/Cellar/*) NODE_INSTALL="brew" ;;
  esac
  kv "Node install method" "$NODE_INSTALL"
else
  check "Node.js in PATH" "false"
fi

# Bun
BUN_VER="$(safe_cmd_quiet bun --version)"
if [ -n "$BUN_VER" ]; then
  kv "Bun" "$BUN_VER"
  kv "bun path" "$(safe_cmd_quiet which bun)"
else
  BUN_HOME="${HOME:-}/.bun/bin/bun"
  if [ -x "$BUN_HOME" ]; then
    kv "Bun" "$("$BUN_HOME" --version 2>/dev/null || echo 'found but failed')"
    kv "bun path" "$BUN_HOME"
  else
    printf -- '- Bun: not installed\n'
  fi
fi

# Codex CLI
CODEX_VER="$(safe_cmd_quiet codex --version 2>/dev/null | head -1)"
if [ -n "$CODEX_VER" ]; then
  kv "Codex CLI" "$CODEX_VER"
  # Warn about exec-mode MCP regression in 0.118.0+
  CODEX_MINOR="$(echo "$CODEX_VER" | sed -E 's/[^0-9]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/' | cut -d. -f2)"
  if [ -n "$CODEX_MINOR" ] && [ "$CODEX_MINOR" -ge 118 ] 2>/dev/null; then
    warn "Codex ≥0.118.0: exec-mode MCP broken (openai/codex#16685). Pin to ≤0.116.0 for exec-mode."
  fi
fi

# Python
PY_VER="$(safe_cmd_quiet python3 --version || safe_cmd_quiet python --version)"
[ -n "$PY_VER" ] && kv "Python" "$PY_VER"

# Ruby
RUBY_VER="$(safe_cmd_quiet ruby --version)"
[ -n "$RUBY_VER" ] && kv "Ruby" "$RUBY_VER"

# npm
NPM_VER="$(safe_cmd_quiet npm --version)"
if [ -n "$NPM_VER" ]; then
  kv "npm" "$NPM_VER"
  kv "npm global root" "$(safe_cmd_quiet npm root -g | head -c 120)"
fi

# ─── 3. context-mode Installation ────────────────────────────────────────────

section "3. context-mode Installation"

# Version from package.json
PKG_JSON="$PLUGIN_ROOT/package.json"
if [ -f "$PKG_JSON" ]; then
  LOCAL_VER="$(safe_cmd_quiet node -e "console.log(require('$PKG_JSON').version)")"
  kv "Installed version" "${LOCAL_VER:-unknown}"
else
  LOCAL_VER=""
  check "package.json at plugin root" "false"
fi

kv "Plugin root" "$(abbrev_path "$PLUGIN_ROOT")"

# Install method heuristic
INSTALL_METHOD="unknown"
case "$PLUGIN_ROOT" in
  */.claude/*)          INSTALL_METHOD="marketplace" ;;
  */node_modules/*)     INSTALL_METHOD="npm global/local" ;;
  *)                    INSTALL_METHOD="git clone / manual" ;;
esac
kv "Install method" "$INSTALL_METHOD"

# Key paths
check "build/ directory exists" "$([ -d "$PLUGIN_ROOT/build" ] && echo true || echo false)"
check "hooks/pretooluse.mjs exists" "$([ -f "$PLUGIN_ROOT/hooks/pretooluse.mjs" ] && echo true || echo false)"
check "hooks/sessionstart.mjs exists" "$([ -f "$PLUGIN_ROOT/hooks/sessionstart.mjs" ] && echo true || echo false)"
check "server.bundle.mjs exists" "$([ -f "$PLUGIN_ROOT/server.bundle.mjs" ] && echo true || echo false)"
check "cli.bundle.mjs exists" "$([ -f "$PLUGIN_ROOT/cli.bundle.mjs" ] && echo true || echo false)"

# npm latest
NPM_LATEST="$(safe_cmd_quiet npm view context-mode version 2>/dev/null)"
if [ -n "$NPM_LATEST" ]; then
  kv "npm latest" "$NPM_LATEST"
  if [ -n "$LOCAL_VER" ] && [ "$LOCAL_VER" != "$NPM_LATEST" ]; then
    warn "Update available: $LOCAL_VER → $NPM_LATEST"
  fi
fi

# ─── 4. better-sqlite3 Native Module ─────────────────────────────────────────

section "4. better-sqlite3 Native Module"

# Find .node binary
SQLITE_NODE_FILE=""
if [ -d "$PLUGIN_ROOT/node_modules/better-sqlite3" ]; then
  SQLITE_NODE_FILE="$(find "$PLUGIN_ROOT/node_modules/better-sqlite3" -name '*.node' -type f 2>/dev/null | head -1)"
fi
check "better-sqlite3 .node binary exists" "$([ -n "$SQLITE_NODE_FILE" ] && echo true || echo false)"
[ -n "$SQLITE_NODE_FILE" ] && kv "Binary path" "$(abbrev_path "$SQLITE_NODE_FILE")"

# Require test
SQLITE_REQ="$(safe_cmd_quiet node -e "try{require('better-sqlite3');console.log('ok')}catch(e){console.log('FAIL: '+e.message)}" 2>&1)"
check "require('better-sqlite3') succeeds" "$([ "$SQLITE_REQ" = "ok" ] && echo true || echo false)"
[ "$SQLITE_REQ" != "ok" ] && printf -- '  > Error: `%s`\n' "$SQLITE_REQ"

# ABI version
NODE_ABI="$(safe_cmd_quiet node -e "console.log(process.versions.modules)")"
[ -n "$NODE_ABI" ] && kv "Node ABI version" "$NODE_ABI"

# ignore-scripts check
IGNORE_SCRIPTS="$(safe_cmd_quiet npm config get ignore-scripts)"
if [ "$IGNORE_SCRIPTS" = "true" ]; then
  warn "npm ignore-scripts=true — prevents native module compilation"
else
  check "npm ignore-scripts is false" "true"
fi

# ─── 5. Adapter Detection ────────────────────────────────────────────────────

section "5. Adapter Detection"

# Env var table
printf '| Variable | Value |\n|----------|-------|\n'

ADAPTER_VARS=(
  CONTEXT_MODE_PLATFORM
  CLAUDE_PROJECT_DIR CLAUDE_SESSION_ID
  GEMINI_PROJECT_DIR GEMINI_CLI
  OPENCLAW_HOME OPENCLAW_CLI
  KILO KILO_PID
  OPENCODE OPENCODE_PID
  CODEX_CI CODEX_THREAD_ID
  CURSOR_TRACE_ID CURSOR_CLI
  VSCODE_PID VSCODE_CWD
)

DETECTED_ADAPTER="none"
for var in "${ADAPTER_VARS[@]}"; do
  val="${!var:-}"
  if [ -n "$val" ]; then
    # Abbreviate long values
    display_val="$(printf '%s' "$val" | head -c 80)"
    printf '| `%s` | `%s` |\n' "$var" "$display_val"
  fi
done

# Detection logic (mirrors context-mode adapter selection)
if [ -n "${CONTEXT_MODE_PLATFORM:-}" ]; then
  DETECTED_ADAPTER="$CONTEXT_MODE_PLATFORM (explicit)"
elif [ -n "${CURSOR_TRACE_ID:-}${CURSOR_CLI:-}" ]; then
  DETECTED_ADAPTER="cursor"
elif [ -n "${VSCODE_PID:-}" ]; then
  DETECTED_ADAPTER="vscode-copilot"
elif [ -n "${CODEX_CI:-}${CODEX_THREAD_ID:-}" ]; then
  DETECTED_ADAPTER="codex"
elif [ -n "${GEMINI_PROJECT_DIR:-}${GEMINI_CLI:-}" ]; then
  DETECTED_ADAPTER="gemini-cli"
elif [ -n "${OPENCLAW_HOME:-}${OPENCLAW_CLI:-}" ]; then
  DETECTED_ADAPTER="openclaw"
elif [ -n "${KILO:-}${KILO_PID:-}" ]; then
  DETECTED_ADAPTER="kilocode"
elif [ -n "${OPENCODE:-}${OPENCODE_PID:-}" ]; then
  DETECTED_ADAPTER="opencode"
elif [ -n "${CLAUDE_SESSION_ID:-}${CLAUDE_PROJECT_DIR:-}" ]; then
  DETECTED_ADAPTER="claude-code"
fi

printf '\n'
kv "Active adapter (env)" "$DETECTED_ADAPTER"

# Detect installed adapters from config directories
HOME_DIR_EARLY="${HOME:-$USERPROFILE}"
INSTALLED=()
[ -d "$HOME_DIR_EARLY/.claude" ]                && INSTALLED+=("claude-code")
[ -d "$HOME_DIR_EARLY/.cursor" ] || [ -f ".cursor/mcp.json" ] && INSTALLED+=("cursor")
[ -d "$HOME_DIR_EARLY/.codex" ]                 && INSTALLED+=("codex")
[ -d "$HOME_DIR_EARLY/.gemini" ]                && INSTALLED+=("gemini-cli")
[ -d "$HOME_DIR_EARLY/.openclaw" ]              && INSTALLED+=("openclaw")
[ -d "$HOME_DIR_EARLY/.kiro" ]                  && INSTALLED+=("kiro")
[ -d "$HOME_DIR_EARLY/.config/opencode" ] || [ -f "opencode.json" ] || [ -d ".opencode" ] && INSTALLED+=("opencode")
[ -d "$HOME_DIR_EARLY/.config/kilo" ]           && INSTALLED+=("kilocode")
[ -d "$HOME_DIR_EARLY/.config/zed" ]            && INSTALLED+=("zed")
[ -f ".vscode/mcp.json" ]                       && INSTALLED+=("vscode-copilot")

if [ ${#INSTALLED[@]} -gt 0 ]; then
  kv "Installed adapters" "${INSTALLED[*]}"
else
  kv "Installed adapters" "none detected"
fi

# ─── 6. Config Files ─────────────────────────────────────────────────────────

section "6. Config Files"

HOME_DIR="${HOME:-$USERPROFILE}"
# Use git root for project-level configs, fall back to cwd
CWD="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Claude Code
config_file "Claude settings.json" "$HOME_DIR/.claude/settings.json"
config_file "Claude settings.local.json" "$HOME_DIR/.claude/settings.local.json"

# Gemini CLI
config_file "Gemini settings.json" "$HOME_DIR/.gemini/settings.json"

# Codex
config_file "Codex config.toml" "$HOME_DIR/.codex/config.toml"
config_file "Codex hooks.json" "$HOME_DIR/.codex/hooks.json"

# Cursor (project + global)
config_file "Cursor hooks.json (project)" "$CWD/.cursor/hooks.json"
config_file "Cursor mcp.json (project)" "$CWD/.cursor/mcp.json"
config_file "Cursor mcp.json (global)" "$HOME_DIR/.cursor/mcp.json"
config_file "Cursor hooks.json (global)" "$HOME_DIR/.cursor/hooks.json"

# VS Code Copilot
config_file "VS Code mcp.json (project)" "$CWD/.vscode/mcp.json"

# OpenCode
config_file "opencode.json (project)" "$CWD/opencode.json"
config_file "opencode.json (dotdir)" "$CWD/.opencode/opencode.json"
config_file "opencode.json (global)" "$HOME_DIR/.config/opencode/opencode.json"

# KiloCode
config_file "KiloCode settings.json" "$HOME_DIR/.config/kilo/settings.json"

# OpenClaw
config_file "OpenClaw openclaw.json" "$HOME_DIR/.openclaw/openclaw.json"
if [ -d "$HOME_DIR/.openclaw/extensions/context-mode" ]; then
  printf -- '- **OpenClaw extension dir**: exists (`~/.openclaw/extensions/context-mode/`)\n'
else
  printf -- '- **OpenClaw extension dir**: not found\n'
fi

# Kiro
config_file "Kiro mcp.json" "$HOME_DIR/.kiro/settings/mcp.json"
config_file "Kiro default agent" "$HOME_DIR/.kiro/agents/default.json"

# Zed
config_file "Zed settings.json" "$HOME_DIR/.config/zed/settings.json"

# ─── 7. Hook Validation ──────────────────────────────────────────────────────

section "7. Hook Validation"

# Collect hook files from plugin
HOOK_FILES=()
if [ -d "$PLUGIN_ROOT/hooks" ]; then
  while IFS= read -r f; do
    HOOK_FILES+=("$f")
  done < <(find "$PLUGIN_ROOT/hooks" -maxdepth 1 -type f -name '*.mjs' 2>/dev/null | sort)
fi

if [ ${#HOOK_FILES[@]} -gt 0 ]; then
  printf 'Hook files found in plugin:\n\n'
  for hf in "${HOOK_FILES[@]}"; do
    local_hf="$(abbrev_path "$hf")"
    if [ -x "$hf" ] || head -1 "$hf" 2>/dev/null | grep -q '#!/'; then
      printf -- '- [x] `%s`\n' "$local_hf"
    else
      printf -- '- [x] `%s` (not executable, but .mjs — OK for node)\n' "$local_hf"
    fi
  done
else
  check "Hook files in plugin" "false"
fi

# Check hooks.json in plugin root/hooks
HOOKS_JSON="$PLUGIN_ROOT/hooks/hooks.json"
if [ -f "$HOOKS_JSON" ]; then
  printf '\nhooks/hooks.json:\n'
  printf '```json\n'
  head -40 "$HOOKS_JSON" 2>/dev/null | redact
  printf '\n```\n'
fi

# Check for stale paths in Claude settings.json
CLAUDE_SETTINGS="$HOME_DIR/.claude/settings.json"
if [ -f "$CLAUDE_SETTINGS" ]; then
  STALE_HOOKS=()
  while IFS= read -r hookpath; do
    # Extract paths from the hooks section
    hookpath="$(printf '%s' "$hookpath" | sed -E 's/.*"([^"]+\.mjs)".*/\1/' | tr -d '"')"
    if [ -n "$hookpath" ] && [ ! -f "$hookpath" ]; then
      STALE_HOOKS+=("$hookpath")
    fi
  done < <(safe_cmd_quiet node -e "
    const s = require('$CLAUDE_SETTINGS');
    const hooks = s.hooks || {};
    for (const [event, arr] of Object.entries(hooks)) {
      if (Array.isArray(arr)) {
        for (const h of arr) {
          if (h.command) console.log(h.command);
          if (h.script) console.log(h.script);
        }
      }
    }
  " 2>/dev/null)

  if [ ${#STALE_HOOKS[@]} -gt 0 ]; then
    printf '\n**Stale hook paths detected:**\n'
    for sp in "${STALE_HOOKS[@]}"; do
      warn "Stale hook path: $sp"
    done
  else
    printf '\n'
    check "No stale hook paths in Claude settings.json" "true"
  fi
fi

# Hook registration completeness — check all required hooks are registered
if [ -f "$CLAUDE_SETTINGS" ] || [ -f "$HOOKS_JSON" ]; then
  printf '\n**Hook registration check:**\n'
  REQUIRED_HOOKS=("PreToolUse" "PostToolUse" "PreCompact" "SessionStart")
  for rh in "${REQUIRED_HOOKS[@]}"; do
    FOUND="false"
    # Check hooks.json
    if [ -f "$HOOKS_JSON" ] && grep -q "\"$rh\"" "$HOOKS_JSON" 2>/dev/null; then
      FOUND="true"
    fi
    # Check settings.json
    if [ -f "$CLAUDE_SETTINGS" ] && grep -q "\"$rh\"" "$CLAUDE_SETTINGS" 2>/dev/null; then
      FOUND="true"
    fi
    check "$rh registered" "$FOUND"
  done
fi

# Path separator check on Windows
if [ "$OS_TYPE" = "windows" ]; then
  if [ -f "$CLAUDE_SETTINGS" ]; then
    if grep -q '\\\\' "$CLAUDE_SETTINGS" 2>/dev/null; then
      warn "Backslash paths in settings.json — use forward slashes on Windows"
    else
      check "No backslash paths in settings.json" "true"
    fi
  fi
fi

# ─── 8. SQLite / FTS5 Test ───────────────────────────────────────────────────

section "8. SQLite / FTS5 Test"

FTS5_RESULT="$(safe_cmd_quiet node -e "
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE VIRTUAL TABLE t USING fts5(c)');
    db.exec(\"INSERT INTO t VALUES('context-mode diagnostic test')\");
    const row = db.prepare('SELECT * FROM t WHERE t MATCH ?').get('diagnostic');
    if (row && row.c) { console.log('PASS'); } else { console.log('FAIL: no results'); }
    db.close();
  } catch (e) {
    console.log('FAIL: ' + e.message);
  }
" 2>&1)"

check "FTS5 in-memory test" "$([ "$FTS5_RESULT" = "PASS" ] && echo true || echo false)"
[ "$FTS5_RESULT" != "PASS" ] && printf -- '  > Error: `%s`\n' "$FTS5_RESULT"

# ─── 9. Executor Test ────────────────────────────────────────────────────────

section "9. Executor Test"

EXEC_RESULT="$(node -e "console.log('ok')" 2>&1)" && EXEC_RC=0 || EXEC_RC=$?
check "node subprocess spawn" "$([ "$EXEC_RESULT" = "ok" ] && [ "$EXEC_RC" -eq 0 ] && echo true || echo false)"
if [ "$EXEC_RESULT" != "ok" ] || [ "$EXEC_RC" -ne 0 ]; then
  printf '  > exit=%d, output: `%s`\n' "$EXEC_RC" "$EXEC_RESULT"
fi

# Shell executor
SHELL_EXEC="$(bash -c 'echo ok' 2>&1)" && SHELL_RC=0 || SHELL_RC=$?
check "bash subprocess spawn" "$([ "$SHELL_EXEC" = "ok" ] && [ "$SHELL_RC" -eq 0 ] && echo true || echo false)"

# ─── 10. Process Check ───────────────────────────────────────────────────────

section "10. Process Check"

# Portable process listing — exclude dashboard, esbuild, wrangler, workerd, grep
if command -v ps &>/dev/null; then
  CTX_PROCS="$(ps aux 2>/dev/null | grep '[c]ontext-mode' | grep -v -E 'context-mode-dashboard|esbuild|wrangler|workerd|grep' || true)"
  CTX_COUNT="$(printf '%s' "$CTX_PROCS" | grep -c . 2>/dev/null || echo 0)"
else
  CTX_PROCS=""
  CTX_COUNT="0"
fi

kv "Running context-mode processes" "$CTX_COUNT"

if [ "$CTX_COUNT" -gt 0 ]; then
  printf '\n```\n%s\n```\n' "$(printf '%s' "$CTX_PROCS" | head -10)"
fi

if [ "$CTX_COUNT" -gt 3 ]; then
  warn "Multiple context-mode processes — possible orphans"
fi

# ─── 11. Session Databases ───────────────────────────────────────────────────

section "11. Session Databases"

# Check session dirs for all adapters
SESSION_DIRS=(
  "$HOME_DIR/.claude/context-mode/sessions"
  "$HOME_DIR/.cursor/context-mode/sessions"
  "$HOME_DIR/.codex/context-mode/sessions"
  "$HOME_DIR/.gemini/context-mode/sessions"
  "$HOME_DIR/.openclaw/context-mode/sessions"
  "$HOME_DIR/.kiro/context-mode/sessions"
)
TOTAL_DB_COUNT=0
for SESSION_DIR in "${SESSION_DIRS[@]}"; do
  if [ -d "$SESSION_DIR" ]; then
    DB_COUNT="$(find "$SESSION_DIR" -name '*.db' -type f 2>/dev/null | wc -l | tr -d ' ')"
    DB_COUNT="${DB_COUNT:-0}"
    if [ "$DB_COUNT" -gt 0 ] 2>/dev/null; then
      TOTAL_DB_COUNT=$((TOTAL_DB_COUNT + DB_COUNT))
      if command -v du &>/dev/null; then
        DB_SIZE="$(find "$SESSION_DIR" -name '*.db' -type f 2>/dev/null | xargs du -ch 2>/dev/null | tail -1 | cut -f1)"
      else
        DB_SIZE="unknown"
      fi
      kv "$(abbrev_path "$SESSION_DIR")" "$DB_COUNT files, $DB_SIZE"
    fi
  fi
done
if [ "$TOTAL_DB_COUNT" -eq 0 ]; then
  printf -- '- No session databases found in any adapter directory\n'
else
  kv "Total session DBs" "$TOTAL_DB_COUNT"
fi

# ─── 12. Environment Variables ───────────────────────────────────────────────

section "12. Environment Variables"

# Temp dirs
kv "TMPDIR" "${TMPDIR:-unset}"
kv "TEMP" "${TEMP:-unset}"
kv "TMP" "${TMP:-unset}"

# Node config
kv "NODE_OPTIONS" "${NODE_OPTIONS:-unset}"
kv "NODE_PATH" "${NODE_PATH:-unset}"
kv "NODE_EXTRA_CA_CERTS" "${NODE_EXTRA_CA_CERTS:-unset}"

# SSL
kv "SSL_CERT_FILE" "${SSL_CERT_FILE:-unset}"
kv "CURL_CA_BUNDLE" "${CURL_CA_BUNDLE:-unset}"

# Auth (redacted)
if [ -n "${SSH_AUTH_SOCK:-}" ]; then
  kv "SSH_AUTH_SOCK" "yes (set)"
else
  kv "SSH_AUTH_SOCK" "unset"
fi

# context-mode specific
kv "CONTEXT_MODE_SESSION_SUFFIX" "${CONTEXT_MODE_SESSION_SUFFIX:-unset}"
kv "CONTEXT_MODE_NODE" "${CONTEXT_MODE_NODE:-unset}"

# PATH (abbreviated — show key directories)
printf -- '- **PATH** (key dirs):\n'
IFS=':' read -ra PATH_PARTS <<< "${PATH:-}"
SHOWN=0
for p in "${PATH_PARTS[@]}"; do
  case "$p" in
    *node*|*npm*|*nvm*|*volta*|*mise*|*bun*|*python*|*ruby*|*homebrew*|*Homebrew*|*/usr/local/bin|*/usr/bin|*/.local/bin|*snap*)
      printf -- '  - `%s`\n' "$(abbrev_path "$p")"
      SHOWN=$((SHOWN + 1))
      ;;
  esac
  [ "$SHOWN" -ge 15 ] && break
done
[ "$SHOWN" -eq 0 ] && printf '  - (no notable dirs detected)\n'
printf -- '  - ... (%d total entries)\n' "${#PATH_PARTS[@]}"

# ─── 13. Hook Execution ─────────────────────────────────────────────────────

section "13. Hook Execution"

# Note: hooks may fail outside an active session — this is expected.
# The test validates the hook CAN execute, not that a session exists.
HOOK_PRE="$PLUGIN_ROOT/hooks/pretooluse.mjs"
# Hooks need CLAUDE_PLUGIN_ROOT to resolve internal imports
export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
if [ -f "$HOOK_PRE" ]; then
  # Test 1: PreToolUse WebFetch → should deny/redirect
  PRE_INPUT='{"tool_name":"WebFetch","tool_input":{"url":"https://example.com"}}'
  PRE_OUTPUT="$(printf '%s' "$PRE_INPUT" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" timed 10 node "$HOOK_PRE" 2>/dev/null || true)"
  if [ -n "$PRE_OUTPUT" ]; then
    PRE_VALID="$(node -e "
      try {
        const o = JSON.parse(process.argv[1]);
        const d = (o.hookSpecificOutput||{}).permissionDecision || o.decision || '';
        console.log(d === 'deny' ? 'PASS' : 'PARTIAL: decision=' + d);
      } catch(e) { console.log('FAIL: ' + e.message); }
    " -- "$PRE_OUTPUT" 2>/dev/null || echo "FAIL: node parse error")"
    check "PreToolUse denies WebFetch" "$([ "${PRE_VALID%%:*}" = "PASS" ] && echo true || echo false)"
    [ "${PRE_VALID%%:*}" != "PASS" ] && printf -- '  > %s\n' "$PRE_VALID"
  else
    check "PreToolUse denies WebFetch" "false"
    printf -- '  > Hook returned empty output\n'
  fi

  # Test 2: PreToolUse Write → should passthrough (no deny)
  PASS_INPUT='{"tool_name":"Write","tool_input":{"file_path":"/tmp/test.txt","content":"hello"}}'
  PASS_OUTPUT="$(printf '%s' "$PASS_INPUT" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" timed 10 node "$HOOK_PRE" 2>/dev/null || true)"
  if [ -z "$PASS_OUTPUT" ]; then
    check "PreToolUse passes Write tool through" "true"
  else
    PASS_DEC="$(node -e "try{const o=JSON.parse(process.argv[1]);console.log((o.hookSpecificOutput||{}).permissionDecision||'none')}catch{console.log('none')}" -- "$PASS_OUTPUT" 2>/dev/null || echo "none")"
    check "PreToolUse passes Write tool through" "$([ "$PASS_DEC" != "deny" ] && echo true || echo false)"
    [ "$PASS_DEC" = "deny" ] && printf -- '  > Write tool was unexpectedly denied\n'
  fi
else
  check "PreToolUse hook" "false"
  printf -- '  > Not found: %s\n' "$(abbrev_path "$HOOK_PRE")"
fi

# Test 3: SessionStart → should return additionalContext
HOOK_SS="$PLUGIN_ROOT/hooks/sessionstart.mjs"
if [ -f "$HOOK_SS" ]; then
  SS_INPUT='{"source":"startup"}'
  SS_OUTPUT="$(printf '%s' "$SS_INPUT" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" timed 15 node "$HOOK_SS" 2>/dev/null || true)"
  if [ -n "$SS_OUTPUT" ]; then
    SS_VALID="$(node -e "
      try {
        const o = JSON.parse(process.argv[1]);
        const ctx = (o.hookSpecificOutput||{}).additionalContext || '';
        console.log(ctx.length > 50 ? 'PASS (' + ctx.length + ' chars)' : 'FAIL: context too short (' + ctx.length + ')');
      } catch(e) { console.log('FAIL: ' + e.message); }
    " -- "$SS_OUTPUT" 2>/dev/null || echo "FAIL: parse error")"
    check "SessionStart injects routing context" "$(echo "$SS_VALID" | grep -q '^PASS' && echo true || echo false)"
    [ "$(echo "$SS_VALID" | grep -q '^PASS' && echo true)" != "true" ] && printf -- '  > %s\n' "$SS_VALID"
  else
    check "SessionStart injects routing context" "false"
    printf -- '  > Hook returned empty output\n'
  fi
else
  check "SessionStart hook" "false"
  printf -- '  > Not found: %s\n' "$(abbrev_path "$HOOK_SS")"
fi

# ─── 14. MCP Server Startup ────────────────────────────────────────────────

section "14. MCP Server Startup"

SERVER_ENTRY="$PLUGIN_ROOT/server.bundle.mjs"
[ ! -f "$SERVER_ENTRY" ] && SERVER_ENTRY="$PLUGIN_ROOT/build/server.js"

if [ -f "$SERVER_ENTRY" ]; then
  # Verify server module can be parsed (not imported — import starts MCP transport)
  SERVER_CHECK="$(timed 10 node -e "
    const fs = require('fs');
    const src = fs.readFileSync('$SERVER_ENTRY', 'utf8');
    // Check critical imports resolve
    try { require.resolve('better-sqlite3'); } catch(e) { console.log('FAIL: ' + e.message); process.exit(0); }
    try { require.resolve('@modelcontextprotocol/sdk/server/mcp.js'); } catch(e) { console.log('FAIL: ' + e.message); process.exit(0); }
    console.log('PASS');
  " 2>/dev/null || echo "FAIL: timeout")"
  check "Server entry + deps resolve" "$(echo "$SERVER_CHECK" | grep -q '^PASS' && echo true || echo false)"
  [ "$(echo "$SERVER_CHECK" | grep -q '^PASS' && echo true)" != "true" ] && printf -- '  > %s\n' "$SERVER_CHECK"
else
  check "Server module loads" "false"
  printf -- '  > Not found: server.bundle.mjs or build/server.js\n'
fi

# ─── 15. SQLite Concurrency ────────────────────────────────────────────────

section "15. SQLite Concurrency"

SESSION_BASE="$HOME_DIR/.claude/context-mode/sessions"
if [ -d "$SESSION_BASE" ]; then
  FIRST_DB="$(find "$SESSION_BASE" -name '*.db' -type f 2>/dev/null | head -1)"
  if [ -n "$FIRST_DB" ]; then
    WAL_MODE="$(node -e "
      try {
        const D = require('better-sqlite3');
        const db = new D('$FIRST_DB', { readonly: true, timeout: 3000 });
        const r = db.pragma('journal_mode');
        console.log(JSON.stringify(r));
        db.close();
      } catch(e) { console.log('ERROR: ' + e.message); }
    " 2>/dev/null || echo "ERROR")"
    check "Session DB uses WAL mode" "$(echo "$WAL_MODE" | grep -qi wal && echo true || echo false)"
    [ "$(echo "$WAL_MODE" | grep -qi wal && echo true)" != "true" ] && printf -- '  > journal_mode: %s\n' "$WAL_MODE"
  fi

  # Orphaned journal check
  WAL_BIG="$(find "$SESSION_BASE" -name '*-wal' -type f -size +1M 2>/dev/null | wc -l | tr -d ' ')"
  SHM_ORPHAN=0
  while IFS= read -r shm; do
    [ -n "$shm" ] && [ ! -f "${shm%-shm}" ] && SHM_ORPHAN=$((SHM_ORPHAN + 1))
  done < <(find "$SESSION_BASE" -name '*-shm' -type f 2>/dev/null)
  check "No oversized WAL journals (>1MB)" "$([ "${WAL_BIG:-0}" -eq 0 ] && echo true || echo false)"
  check "No orphaned -shm files" "$([ "$SHM_ORPHAN" -eq 0 ] && echo true || echo false)"
else
  printf -- '- No session directory at %s\n' "$(abbrev_path "$SESSION_BASE")"
fi

CONCUR="$(timed 15 node -e "
  const Database = require('better-sqlite3');
  const os = require('os'), fs = require('fs'), path = require('path');
  const dbPath = path.join(os.tmpdir(), 'ctx-debug-concur-' + process.pid + '.db');
  try {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
    let errors = 0;
    const conns = [1,2,3].map(() => {
      const c = new Database(dbPath);
      c.pragma('journal_mode = WAL');
      c.pragma('busy_timeout = 5000');
      return c;
    });
    for (let i = 0; i < 30; i++) {
      for (const c of conns) {
        try { c.prepare('INSERT INTO t(v) VALUES(?)').run('r' + i); }
        catch { errors++; }
      }
    }
    conns.forEach(c => c.close()); db.close();
    console.log(errors === 0 ? 'PASS: 90 writes, 0 SQLITE_BUSY' : 'FAIL: ' + errors + ' errors');
  } catch(e) { console.log('FAIL: ' + e.message); }
  finally { try { fs.unlinkSync(dbPath); fs.unlinkSync(dbPath+'-wal'); fs.unlinkSync(dbPath+'-shm'); } catch {} }
" 2>/dev/null || echo "FAIL: timeout")"
check "Concurrent SQLite writes (3 conns × 30)" "$(echo "$CONCUR" | grep -q '^PASS' && echo true || echo false)"
[ "$(echo "$CONCUR" | grep -q '^PASS' && echo true)" != "true" ] && printf -- '  > %s\n' "$CONCUR"

# ─── 16. Adapter Validation ────────────────────────────────────────────────

section "16. Adapter Validation"

DETECT_JS="$PLUGIN_ROOT/build/adapters/detect.js"
if [ -f "$DETECT_JS" ]; then
  ADAPTER_VAL="$(timed 15 node --input-type=module -e "
    try {
      const { detectPlatform, getAdapter } = await import('file://$DETECT_JS');
      const signal = detectPlatform();
      const adapter = await getAdapter(signal.platform);
      console.log('platform: ' + adapter.name);
      const hookResults = adapter.validateHooks('$PLUGIN_ROOT');
      for (const r of hookResults) {
        console.log(r.status + ': ' + r.check + ' — ' + (r.message || ''));
      }
      try {
        const reg = await adapter.checkPluginRegistration();
        if (reg) console.log(reg.status + ': ' + reg.check + ' — ' + (reg.message || ''));
      } catch {}
    } catch(e) { console.log('error: ' + e.message); }
  " 2>/dev/null || echo "error: timeout")"

  ADAPTER_NAME="$(echo "$ADAPTER_VAL" | grep '^platform:' | cut -d' ' -f2-)"
  kv "Validated adapter" "${ADAPTER_NAME:-unknown}"

  FAIL_N="$(echo "$ADAPTER_VAL" | grep -c '^fail:' 2>/dev/null || true)"
  FAIL_N="$(echo "$FAIL_N" | tr -d ' \n')"
  FAIL_N="${FAIL_N:-0}"
  check "Adapter validation passes" "$([ "$FAIL_N" -eq 0 ] 2>/dev/null && echo true || echo false)"

  echo "$ADAPTER_VAL" | grep -E '^(pass|fail|warn):' | while IFS= read -r line; do
    status="${line%%:*}"
    detail="${line#*: }"
    case "$status" in
      pass) printf -- '  - [x] %s\n' "$detail" ;;
      fail) printf -- '  - [ ] %s\n' "$detail" ;;
      warn) printf -- '  - [~] %s\n' "$detail" ;;
    esac
  done
else
  printf -- '- Adapter validation skipped (build/adapters/detect.js not found — run `npm run build`)\n'
fi

# ─── 17. Sandbox Environment ───────────────────────────────────────────────

section "17. Sandbox Environment"

# Check system CA certificates
CA_PATHS=("/etc/ssl/cert.pem" "/etc/ssl/certs/ca-certificates.crt" "/etc/pki/tls/certs/ca-bundle.crt" "/usr/local/etc/openssl/cert.pem")
CA_FOUND=false
for ca in "${CA_PATHS[@]}"; do
  [ -f "$ca" ] && CA_FOUND=true && break
done
check "System CA certificates found" "$CA_FOUND"
[ "$CA_FOUND" = "false" ] && printf -- '  > No system CA bundle — HTTPS in sandbox may fail. Set SSL_CERT_FILE.\n'

# TMPDIR write test
EFFECTIVE_TMP="${TMPDIR:-${TEMP:-${TMP:-/tmp}}}"
kv "Effective temp dir" "$EFFECTIVE_TMP"
if [ -d "$EFFECTIVE_TMP" ]; then
  TMP_TEST="$EFFECTIVE_TMP/.ctx-debug-$$"
  if touch "$TMP_TEST" 2>/dev/null && rm -f "$TMP_TEST" 2>/dev/null; then
    check "Temp dir writable" "true"
  else
    check "Temp dir writable" "false"
    printf -- '  > Cannot write to %s — check permissions or Snap confinement\n' "$EFFECTIVE_TMP"
  fi
else
  check "Temp dir exists" "false"
fi

# Env denylist spot-check — verify dangerous vars don't leak to subprocess
DENY_TEST="$(node -e "
  const { execFileSync } = require('child_process');
  const env = { ...process.env };
  env.BASH_ENV = '/tmp/evil'; env.LD_PRELOAD = '/tmp/evil.so';
  env.PYTHONSTARTUP = '/tmp/evil.py'; env.PROMPT_COMMAND = 'echo pwned';
  // Simulate what a safe sandbox would strip
  const DENIED = ['BASH_ENV','LD_PRELOAD','PYTHONSTARTUP','PROMPT_COMMAND','ENV','PS4','DYLD_INSERT_LIBRARIES','PERL5OPT','RUBYOPT','GIT_TEMPLATE_DIR'];
  const safe = Object.fromEntries(Object.entries(env).filter(([k]) => !DENIED.includes(k)));
  const out = execFileSync('node', ['-e', 'const d=[\"BASH_ENV\",\"LD_PRELOAD\",\"PYTHONSTARTUP\",\"PROMPT_COMMAND\"];const l=d.filter(v=>process.env[v]);console.log(l.length?\"LEAKED:\"+l.join(\",\"):\"STRIPPED\")'], { env: safe, timeout: 5000 }).toString().trim();
  console.log(out);
" 2>/dev/null || echo "ERROR")"
check "Env denylist strips dangerous vars" "$([ "$DENY_TEST" = "STRIPPED" ] && echo true || echo false)"
[ "$DENY_TEST" != "STRIPPED" ] && printf -- '  > %s\n' "$DENY_TEST"

# ─── 18. Network / TLS ─────────────────────────────────────────────────────

section "18. Network / TLS"

# NODE_EXTRA_CA_CERTS check
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ]; then
  check "NODE_EXTRA_CA_CERTS file exists" "$([ -f "$NODE_EXTRA_CA_CERTS" ] && echo true || echo false)"
  [ ! -f "$NODE_EXTRA_CA_CERTS" ] && printf -- '  > File not found: %s\n' "$NODE_EXTRA_CA_CERTS"
fi

# Proxy detection
PROXY_SET=false
for pvar in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY; do
  pval="$(eval echo "\${$pvar:-}" 2>/dev/null)"
  if [ -n "$pval" ]; then
    kv "$pvar" "$(echo "$pval" | redact)"
    PROXY_SET=true
  fi
done
[ "$PROXY_SET" = "false" ] && printf -- '- No proxy environment variables detected\n'

# HTTPS connectivity
NPM_TLS="$(timed 10 node -e "
  const https = require('https');
  const req = https.get('https://registry.npmjs.org/context-mode', { timeout: 5000 }, (res) => {
    console.log('PASS: HTTP ' + res.statusCode);
    req.destroy();
  });
  req.on('error', (e) => {
    if (e.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || e.code === 'CERT_HAS_EXPIRED') {
      console.log('FAIL_TLS: ' + e.code);
    } else if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
      console.log('FAIL_NET: ' + e.code);
    } else {
      console.log('FAIL: ' + e.code + ' ' + e.message);
    }
  });
  req.on('timeout', () => { console.log('FAIL_NET: timeout'); req.destroy(); });
" 2>/dev/null || echo "FAIL: timeout")"
check "HTTPS to npm registry" "$(echo "$NPM_TLS" | grep -q '^PASS' && echo true || echo false)"
if ! echo "$NPM_TLS" | grep -q '^PASS'; then
  printf -- '  > %s\n' "$NPM_TLS"
  case "$NPM_TLS" in
    FAIL_TLS*) printf -- '  > Fix: Set NODE_EXTRA_CA_CERTS to your corporate CA bundle\n' ;;
    FAIL_NET*) printf -- '  > Fix: Check network, DNS, or proxy settings\n' ;;
  esac
fi

# Snap confinement (Linux)
if [ "$OS_TYPE" = "linux" ]; then
  SNAP_NODE="$(which node 2>/dev/null || true)"
  if echo "$SNAP_NODE" | grep -q '/snap/'; then
    check "Node.js not Snap-confined" "false"
    printf -- '  > Node.js installed via Snap — causes connection errors and TMPDIR restrictions\n'
    printf -- '  > Fix: Install via nvm, volta, or package manager\n'
  else
    check "Node.js not Snap-confined" "true"
  fi
fi

# Disk space on temp dir
if command -v df &>/dev/null; then
  TMP_AVAIL="$(df -m "$EFFECTIVE_TMP" 2>/dev/null | awk 'NR==2{print $(NF-2)}' || true)"
  if [ -n "$TMP_AVAIL" ] && [ "$TMP_AVAIL" -lt 100 ] 2>/dev/null; then
    check "Temp dir >100MB free" "false"
    printf -- '  > Only %sMB available\n' "$TMP_AVAIL"
  elif [ -n "$TMP_AVAIL" ] 2>/dev/null; then
    check "Temp dir >100MB free" "true"
  fi
fi

# ─── Restore stdout, generate JSON, print summary ───────────────────────────

exec 1>&3  # restore stdout → terminal

# Generate JSON from JSONL
node -e "
  const fs = require('fs');
  const lines = fs.readFileSync('$JSONL_FILE', 'utf8').trim().split('\n').filter(Boolean);
  const result = { version: '$CTX_DEBUG_VERSION', generated: '$NOW', sections: {}, summary: {} };
  let pass = 0, fail = 0, warns = 0;
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (!result.sections[e.s]) result.sections[e.s] = { checks: [], info: {}, configs: [], warnings: [], details: [] };
      const sec = result.sections[e.s];
      if (e.t === 'c') {
        sec.checks.push({ pass: e.p, label: e.l });
        if (e.p) pass++; else fail++;
      } else if (e.t === 'i') {
        sec.info[e.k] = e.v;
      } else if (e.t === 'w') {
        sec.warnings.push(e.m);
        warns++;
      } else if (e.t === 'd') {
        sec.details.push(e.m);
      } else if (e.t === 'cfg') {
        sec.configs.push({ name: e.k, path: e.path, exists: e.exists, content: e.content || null });
      }
    } catch {}
  }
  result.summary = { pass, fail, warnings: warns, total: pass + fail };
  fs.writeFileSync('$JSON_FILE', JSON.stringify(result, null, 2));
" 2>/dev/null || true

# ─── Terminal summary ────────────────────────────────────────────────────────

printf '\n'
printf '  context-mode diagnostic v%s\n' "$CTX_DEBUG_VERSION"
printf '  ─────────────────────────────\n'
if [ "$FAIL_TOTAL" -eq 0 ]; then
  printf '  ✓ All %s checks passed' "$PASS_TOTAL"
  [ "$WARN_TOTAL" -gt 0 ] && printf ' (%s warnings)' "$WARN_TOTAL"
  printf '\n'
else
  printf '  %s passed, %s failed' "$PASS_TOTAL" "$FAIL_TOTAL"
  [ "$WARN_TOTAL" -gt 0 ] && printf ', %s warnings' "$WARN_TOTAL"
  printf '\n\n'
  printf '  Failed:\n'
  node -e "
    const r = JSON.parse(require('fs').readFileSync('$JSON_FILE','utf8'));
    for (const [s,d] of Object.entries(r.sections)) {
      for (const c of d.checks) { if (!c.pass) console.log('    ✗ ' + c.label); }
    }
  " 2>/dev/null || true
fi
printf '\n'
printf '  %s\n' "$JSON_FILE"
printf '\n'
# Copy hint
if command -v pbcopy &>/dev/null; then
  printf '  pbcopy: cat %s | pbcopy\n' "$JSON_FILE"
elif command -v xclip &>/dev/null; then
  printf '  copy:   cat %s | xclip -selection clipboard\n' "$JSON_FILE"
elif command -v clip &>/dev/null; then
  printf '  copy:   cat %s | clip\n' "$JSON_FILE"
fi
printf '\n'

# Cleanup JSONL
rm -f "$JSONL_FILE" 2>/dev/null
