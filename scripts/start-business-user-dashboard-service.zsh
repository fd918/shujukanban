#!/bin/zsh
set -euo pipefail

PROJECT="/Users/tanwenjie/Documents/New project"
USERNAME_SERVICE="com.tanwenjie.yunzhan-business-dashboard.username"
PASSWORD_SERVICE="com.tanwenjie.yunzhan-business-dashboard.password"

USER_NAME="$(/usr/bin/security find-generic-password -a default -s "$USERNAME_SERVICE" -w 2>/dev/null || true)"
USER_PASS="$(/usr/bin/security find-generic-password -a default -s "$PASSWORD_SERVICE" -w 2>/dev/null || true)"

if [[ -z "$USER_NAME" || -z "$USER_PASS" ]]; then
  echo "业务用户看板服务缺少钥匙串账号或密码。"
  echo "请先运行桌面入口里的“写入/更新钥匙串账号”。"
  exit 1
fi

export DASHBOARD_PORT="${DASHBOARD_PORT:-8791}"
export YZ_DASHBOARD_USER="$USER_NAME"
export YZ_DASHBOARD_PASS="$USER_PASS"

cd "$PROJECT"
exec /usr/local/bin/node "$PROJECT/dashboard-live-server.mjs"
