#!/usr/bin/env bash
#
# Remove the OpenCode model-fallback plugin from a global OpenCode config dir.
#
# Usage:
#   ./uninstall.sh
#   OPENCODE_CONFIG_DIR=/path ./uninstall.sh
set -euo pipefail

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
PLUGIN_DIR="$CONFIG_DIR/plugins/opencode-model-fallback"

rm -rf "$PLUGIN_DIR"
echo "plugin: removed $PLUGIN_DIR"

if [ -f "$CONFIG_DIR/model-fallback.json" ]; then
  echo "config: left $CONFIG_DIR/model-fallback.json in place (delete it manually if you no longer want it)"
fi
