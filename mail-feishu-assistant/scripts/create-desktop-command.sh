#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMAND_FILE="$HOME/Desktop/飞书邮件助手.command"

cat > "$COMMAND_FILE" <<COMMAND
#!/bin/zsh

PROJECT_DIR="$PROJECT_DIR"
PLIST="\$HOME/Library/LaunchAgents/com.tanwenjie.mail-feishu-assistant.plist"

cd "\$PROJECT_DIR" || exit 1

while true; do
  clear
  echo "飞书邮件助手"
  echo
  echo "1. 查看服务状态"
  echo "2. 启动服务"
  echo "3. 停止服务"
  echo "4. 重启服务"
  echo "5. 手动巡检一次"
  echo "6. 查看最近日志"
  echo "0. 退出"
  echo
  read "choice?请选择："

  case "\$choice" in
    1)
      launchctl print "gui/\$(id -u)/com.tanwenjie.mail-feishu-assistant" 2>/dev/null | head -80 || echo "服务未运行或未安装。"
      ;;
    2)
      ./scripts/install-launchd.sh
      ;;
    3)
      launchctl unload "\$PLIST" 2>/dev/null || true
      echo "已停止服务。"
      ;;
    4)
      launchctl unload "\$PLIST" 2>/dev/null || true
      ./scripts/install-launchd.sh
      ;;
    5)
      npm run scan
      ;;
    6)
      echo "---- launchd.log ----"
      tail -80 logs/launchd.log 2>/dev/null || true
      echo
      echo "---- launchd-error.log ----"
      tail -80 logs/launchd-error.log 2>/dev/null || true
      echo
      echo "---- assistant.log ----"
      tail -80 logs/assistant.log 2>/dev/null || true
      ;;
    0)
      exit 0
      ;;
    *)
      echo "无效选择。"
      ;;
  esac
  echo
  read "pause?按回车继续..."
done
COMMAND

chmod +x "$COMMAND_FILE"
chmod +x "$PROJECT_DIR/scripts/install-launchd.sh" "$PROJECT_DIR/scripts/uninstall-launchd.sh"
echo "已创建桌面入口：$COMMAND_FILE"
