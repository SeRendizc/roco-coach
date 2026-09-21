#!/usr/bin/env bash
# 常驻启动本地模型**网关**（后台），PID 与日志落在 reports/roco/local-model/。
#
# 架构：Node 网关（OpenAI-compatible :8766）→ 常驻 MLX 推理子进程（stdio JSONL）。
# 为什么不让调用方直接连推理进程：超时 / 并发 / 取消 / 回退需要**一个**实现位置，
# 散在每个调用点一定会漂移。
#
# 「就绪」的判据是 `/healthz` 里的 `ready: true`，**不是**「pid 还活着」。
# 第 39 轮实测到这个区别要命：网关进程还在、pidfile 也在，而 MLX 子进程已经死了，
# `/healthz` 返回 503（`ready: false`）。旧版这里只看 pidfile → 打印「已在运行」并
# **退出码 0**，于是调用方以为模型可用，直到下一次请求报
# 「写入失败：Cannot read properties of null (reading 'stdin')」。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"
OUT="${ROOT}/reports/roco/local-model"; mkdir -p "${OUT}"
PIDFILE="${OUT}/gateway.pid"; LOG="${OUT}/gateway.log"
GW_PORT="${ROCO_LOCAL_PORT:-8766}"
URL="http://127.0.0.1:${GW_PORT}"

# `/healthz` 只有在 `ready: true` 时返回 200；否则 503。所以 `curl -f` 成功 == 真的可用。
ready() { curl -fsS "${URL}/healthz" >/dev/null 2>&1; }

if [ -f "${PIDFILE}" ] && kill -0 "$(cat "${PIDFILE}")" 2>/dev/null; then
  if ready; then
    echo "已在运行且就绪：pid $(cat "${PIDFILE}")，端口 ${GW_PORT}（日志 ${LOG}）"
    exit 0
  fi
  echo "网关进程还在（pid $(cat "${PIDFILE}")）但**模型不可用**（/healthz 不是 ready）——重启它"
  bash "${ROOT}/scripts/model/stop-mac.sh"
fi
# pidfile 丢了但端口还占着：也要先清掉，否则新进程起不来。
if lsof -ti "tcp:${GW_PORT}" >/dev/null 2>&1; then
  echo "端口 ${GW_PORT} 被占用但网关不健康，先清掉"
  bash "${ROOT}/scripts/model/stop-mac.sh"
fi
[ -x "${ROOT}/.venv-mlx/bin/python" ] || { echo "缺少 .venv-mlx，先跑 bash scripts/model/setup-mac.sh" >&2; exit 3; }

nohup node "${ROOT}/scripts/model/local-gateway.mjs" --port "${GW_PORT}" >"${LOG}" 2>&1 &
echo $! >"${PIDFILE}"
for _ in $(seq 1 180); do
  if ready; then
    echo "网关就绪：${URL}（pid $(cat "${PIDFILE}")，日志 ${LOG}）"
    exit 0
  fi
  kill -0 "$(cat "${PIDFILE}")" 2>/dev/null || { echo "网关进程退出了，见 ${LOG}" >&2; tail -5 "${LOG}" >&2; exit 4; }
  sleep 1
done
echo "网关 180s 内未就绪（/healthz 不是 ready），见 ${LOG}" >&2; tail -5 "${LOG}" >&2; exit 4
