#!/usr/bin/env bash
# curl -fsSL https://raw.githubusercontent.com/mksglu/context-mode/main/install.sh | bash
#
# One-liner installer for context-mode (OpenClaw plugin).
# Clones the repo, builds, and registers the plugin into OpenClaw.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mksglu/context-mode/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/mksglu/context-mode/main/install.sh | bash -s -- /path/to/openclaw-state
#
# Environment variables:
#   OPENCLAW_STATE_DIR — OpenClaw state directory (default: /openclaw)
#   CONTEXT_MODE_DIR   — Where to clone context-mode (default: /tmp/context-mode-install)

set -euo pipefail

OPENCLAW_STATE_DIR="${1:-${OPENCLAW_STATE_DIR:-/openclaw}}"
INSTALL_DIR="${CONTEXT_MODE_DIR:-/tmp/context-mode-install}"

echo "→ context-mode one-liner installer"
echo "  openclaw state dir : $OPENCLAW_STATE_DIR"
echo "  install dir        : $INSTALL_DIR"

# Preflight
if ! command -v node &>/dev/null; then
  echo "✗ node is required but not found in PATH" >&2
  exit 1
fi

if [ ! -d "$OPENCLAW_STATE_DIR" ]; then
  echo "✗ OPENCLAW_STATE_DIR ($OPENCLAW_STATE_DIR) does not exist. Is OpenClaw installed?" >&2
  exit 1
fi

# Clone (shallow) if not already present
if [ ! -d "$INSTALL_DIR/.git" ]; then
  echo "→ cloning context-mode..."
  git clone --depth 1 https://github.com/mksglu/context-mode.git "$INSTALL_DIR"
else
  echo "→ updating context-mode..."
  git -C "$INSTALL_DIR" pull --ff-only || git -C "$INSTALL_DIR" fetch && git -C "$INSTALL_DIR" reset --hard origin/main
fi

# Run the installer
echo "→ running plugin installer..."
cd "$INSTALL_DIR"
bash scripts/install-openclaw-plugin.sh "$OPENCLAW_STATE_DIR"

echo ""
echo "✓ done — context-mode installed via one-liner"
