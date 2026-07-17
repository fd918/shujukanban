#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
SOURCE_XLSX="${1:-/Users/tanwenjie/Downloads/开放平台毛利表2026.xlsx}"
PRIVATE_DIR="${PROJECT_DIR}/data/private"
PRIVATE_XLSX="${PRIVATE_DIR}/开放平台毛利表2026.xlsx"
RAW_JSON="${PRIVATE_DIR}/open-platform-profit-workbook.json"
DASHBOARD_JSON="${PROJECT_DIR}/data/open-platform-profit-dashboard.json"
BUNDLED_PYTHON="/Users/tanwenjie/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"

if [[ ! -f "${SOURCE_XLSX}" ]]; then
  print -u2 "没有找到 Excel：${SOURCE_XLSX}"
  exit 1
fi

mkdir -p "${PRIVATE_DIR}"
cp "${SOURCE_XLSX}" "${PRIVATE_XLSX}"
"${BUNDLED_PYTHON}" "${SCRIPT_DIR}/extract-open-platform-profit-workbook.py" "${PRIVATE_XLSX}" "${RAW_JSON}"
node "${SCRIPT_DIR}/build-open-platform-profit-data.mjs" "${RAW_JSON}" "${DASHBOARD_JSON}"

print "毛利看板数据已更新：${DASHBOARD_JSON}"
