#!/usr/bin/env bash
#
# Install the OpenCode model-fallback plugin into a global OpenCode config dir.
#
# Usage:
#   ./install.sh                       # -> ${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}
#   OPENCODE_CONFIG_DIR=/path ./install.sh
#
# Idempotent: re-running upgrades index.js/package.json in place and leaves an
# existing model-fallback.json untouched, so your chain is never overwritten.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
PLUGIN_DIR="$CONFIG_DIR/plugins/opencode-model-fallback"

mkdir -p "$PLUGIN_DIR"
cp -f "$SRC_DIR/index.js" "$SRC_DIR/package.json" "$PLUGIN_DIR/"

if [ -f "$CONFIG_DIR/model-fallback.json" ]; then
  echo "config: keeping existing $CONFIG_DIR/model-fallback.json"
else
  cp "$SRC_DIR/model-fallback.example.json" "$CONFIG_DIR/model-fallback.json"
  echo "config: created $CONFIG_DIR/model-fallback.json (edit the chain for your providers)"
fi

echo "plugin: installed to $PLUGIN_DIR"
echo
echo "Restart OpenCode (or reload plugins) to activate."
