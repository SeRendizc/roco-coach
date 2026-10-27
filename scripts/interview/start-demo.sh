#!/usr/bin/env bash
# 演示启动器（本地）：优先用环境变量，其次从 macOS Keychain 读 key，最后允许到 /connect.html 输入。
# 不把 key 写进仓库；首次在页面输入后，服务会把 key 存进 Keychain（见 src/server/index.js 的 ROCO_KEYCHAIN_SERVICE）。
set -euo pipefail
PORT="${1:-8910}"
SERVICE="${ROCO_KEYCHAIN_SERVICE:-roco-deepseek}"
KEY="${DEEPSEEK_API_KEY:-}"
CRED_FILE="${ROCO_CREDENTIAL_FILE:-$HOME/.config/roco/deepseek.key}"
if [ -z "$KEY" ] && command -v security >/dev/null 2>&1; then
  KEY="$(security find-generic-password -s "$SERVICE" -w 2>/dev/null || true)"
fi
if [ -z "$KEY" ] && [ -f "$CRED_FILE" ]; then
  KEY="$(cat "$CRED_FILE")"
fi
if [ -n "$KEY" ]; then
  export DEEPSEEK_API_KEY="$KEY"
  echo "[start-demo] key: 已从环境变量/Keychain 加载（不打印）"
else
  echo "[start-demo] key: 未配置 —— 打开 http://127.0.0.1:${PORT}/connect.html 输入一次（会存入 Keychain: ${SERVICE}）"
fi
echo "[start-demo] URL: http://127.0.0.1:${PORT}/connect.html"
echo "[start-demo] 健康检查: curl -s http://127.0.0.1:${PORT}/api/models"
ROCO_KEYCHAIN_SERVICE="$SERVICE" ROCO_CREDENTIAL_FILE="$CRED_FILE" PORT="$PORT" exec npm start
