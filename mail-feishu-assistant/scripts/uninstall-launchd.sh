#!/bin/zsh
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.tanwenjie.mail-feishu-assistant.plist"

launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "已停止并移除：$PLIST"
