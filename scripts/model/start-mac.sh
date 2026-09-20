#!/usr/bin/env bash
# 常驻启动本地模型**网关**（后台），PID 与日志落在 reports/roco/local-model/。
#
# 架构：Node 网关（OpenAI-compatible :8766）→ 常驻 MLX 推理子进程（stdio JSONL）。
# 为什么不让调用方直接连推理进程：超时 / 并发 / 取消 / 回退需要**一个**实现位置，
# 散在每个调用点一定会漂移。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"
OUT="${ROOT}/reports/roco/local-model"; mkdir -p "${OUT}"
PIDFILE="${OUT}/gateway.pid"; LOG="${OUT}/gateway.log"
GW_PORT="${ROCO_LOCAL_PORT:-8766}"

if [ -f "${PIDFILE}" ] && kill -0 "$(cat "${PIDFILE}")" 2>/dev/null; then
  echo "已在运行：pid $(cat "${PIDFILE}")，端口 ${GW_PORT}（日志 ${LOG}）"
  exit 0
fi
[ -x "${ROOT}/.venv-mlx/bin/python" ] || { echo "缺少 .venv-mlx，先跑 bash scripts/model/setup-mac.sh" >&2; exit 3; }

nohup node "${ROOT}/scripts/model/local-gateway.mjs" --port "${GW_PORT}" >"${LOG}" 2>&1 &
echo $! >"${PIDFILE}"
for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${GW_PORT}/healthz" >/dev/null 2>&1; then
    echo "网关就绪：http://127.0.0.1:${GW_PORT}（pid $(cat "${PIDFILE}")，日志 ${LOG}）"
    exit 0
  fi
  kill -0 "$(cat "${PIDFILE}")" 2>/dev/null || { echo "网关进程退出了，见 ${LOG}" >&2; tail -5 "${LOG}" >&2; exit 4; }
  sleep 1
done
echo "网关 120s 内未就绪，见 ${LOG}" >&2; tail -5 "${LOG}" >&2; exit 4
