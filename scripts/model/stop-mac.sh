#!/usr/bin/env bash
# 停掉常驻推理服务（幂等）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PIDFILE="$ROOT/reports/roco/local-model/serve.pid"
if [ ! -f "$PIDFILE" ]; then echo "没有在运行"; exit 0; fi
PID="$(cat "$PIDFILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID" 2>/dev/null || true
  for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
  echo "已停止 pid $PID"
else
  echo "进程 $PID 已不在"
fi
rm -f "$PIDFILE"
