#!/usr/bin/env bash
# 停掉常驻推理服务（幂等）。
#
# 这里必须认 **gateway.pid**：网关（`local-gateway.mjs`）写的 pid 文件叫
# `gateway.pid`，推理子进程由网关自己管、在它的 shutdown 里收掉。
# 原来只找 `serve.pid`，而那个文件从来没被任何代码写过——于是 `stop` 永远打印
# 「没有在运行」并退出 0，**而网关其实还在跑**。换适配器时就会以为已经停了，
# 继续用旧权重出结果，然后把新名字写到旧数字上（第 37 轮真的这么错过一次）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/reports/roco/local-model"
STOPPED=0

stop_pidfile() {
  local pidfile="$1" label="$2"
  [ -f "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    # SIGTERM 会让网关走 shutdown：关服务、收推理子进程、删 pid 文件。
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
    echo "已停止${label} pid $pid"
    STOPPED=1
  else
    echo "${label}进程 $pid 已不在"
  fi
  rm -f "$pidfile"
}

stop_pidfile "$OUT/gateway.pid" "网关"
# 兼容旧版本可能留下的名字。
stop_pidfile "$OUT/serve.pid" "推理"

# 兜底：pid 文件丢了但端口还占着——按端口把网关找出来。
PORT="${ROCO_LOCAL_PORT:-8766}"
if command -v lsof >/dev/null 2>&1; then
  LEFTOVER="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
  if [ -n "$LEFTOVER" ]; then
    echo "端口 ${PORT} 仍被占用，按端口停止：${LEFTOVER}"
    # shellcheck disable=SC2086
    kill $LEFTOVER 2>/dev/null || true
    sleep 1
    STOPPED=1
  fi
fi

if [ "$STOPPED" -eq 0 ]; then echo "没有在运行"; fi
