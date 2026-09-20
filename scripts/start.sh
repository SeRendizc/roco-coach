#!/usr/bin/env bash
# 启动服务。密钥从 macOS 钥匙串读取，不落盘、不进 shell 历史。
#
# 首次使用（只做一次）：
#   ./scripts/start.sh --save-key
#   它会提示你输入 DeepSeek API Key（输入时不显示），存进登录钥匙串。
#
# 之后每次启动：
#   ./scripts/start.sh
#
# 为什么这么做：这个应用的密钥只存在进程内存里（设计如此，从不写盘）。
# 代价是每次重启都要重新录入——今天的开发里这件事已经发生四五次。
# 存钥匙串把「谁保存密钥」交回给操作系统，应用本身仍然不写它。
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICE="pet-coach-deepseek"
ACCOUNT="${USER}"

if [ "${1:-}" = "--save-key" ]; then
  echo "把 DeepSeek API Key 存进钥匙串（服务名 ${SERVICE}，账户 ${ACCOUNT}）。"
  echo "输入时不回显，这是正常的。"
  read -r -s -p "API Key: " KEY; echo
  case "$KEY" in
    sk-*) ;;
    *) echo "看起来不像 sk- 开头的密钥，已中止。" >&2; exit 1;;
  esac
  security add-generic-password -U -s "$SERVICE" -a "$ACCOUNT" -w "$KEY"
  echo "已存入钥匙串。以后直接跑 ./scripts/start.sh 即可。"
  exit 0
fi

KEY="$(security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w 2>/dev/null || true)"
if [ -z "$KEY" ]; then
  echo "钥匙串里没有密钥。先跑一次： ./scripts/start.sh --save-key" >&2
  echo "（或者照旧用 connect.html 录入，那样每次重启都要重录。）" >&2
  exit 1
fi

OLD="$(lsof -ti:8765 2>/dev/null || true)"
if [ -n "$OLD" ]; then
  echo "停掉旧的 8765 进程 $OLD"
  kill $OLD 2>/dev/null || true
  sleep 2
fi

DEEPSEEK_API_KEY="$KEY" nohup node src/server/index.js > tmp/server.log 2>&1 &
sleep 3
if curl -s -m 5 http://127.0.0.1:8765/api/bootstrap | grep -q '"configured":true'; then
  echo "已启动，密钥已加载。 http://127.0.0.1:8765/"
else
  echo "起来了但 configured 不是 true，看看 tmp/server.log" >&2
fi
