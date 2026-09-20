#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 小芽 · v0.1 一键启动入口
#
# v0.1 = 2026-09-18 完成的自创宠物 Demo + AI Coach「小芽」，tag `v0.1.0`
#        （commit 1717cd515e8d900e6f2ccccb8707a0a85a809989）
#
# 为什么要这个脚本：v0.1 的代码在 git 历史里（后续 M0/M1 数据层提交在它之上），
# 所以「跑 v0.1」= 把那个 tag 取出来跑。脚本用 git worktree 在仓库旁边
# 放一份只读检出，不污染当前工作区、不影响 master 的代码。
#
# 用法：
#   ./run-v0.1.sh              # 起服务并打开浏览器
#   ./run-v0.1.sh --port 9000  # 指定端口
#   ./run-v0.1.sh --no-open    # 不自动打开浏览器
#   ./run-v0.1.sh --stop       # 停掉 v0.1 服务（不碰 8765 上别的服务）
#   ./run-v0.1.sh --clean      # 移除 v0.1 的工作树检出
#
# 不需要 Python，不需要下载模型，不需要 API Key（不接模型也能完整游玩）。
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
TAG="v0.1.0"
WORKTREE="${REPO_DIR}/.v0.1-run"
PIDFILE="${WORKTREE}/.v0.1-server.pid"
LOGFILE="${WORKTREE}/.v0.1-server.log"

PORT=""
OPEN_BROWSER=1
MODE="run"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --no-open) OPEN_BROWSER=0; shift ;;
    --stop) MODE="stop"; shift ;;
    --clean) MODE="clean"; shift ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

# ── --stop：只停我们自己起的那个进程 ────────────────────────────────────────
if [ "$MODE" = "stop" ]; then
  if [ -f "$PIDFILE" ]; then
    PID="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null || true
      sleep 1
      say "已停掉 v0.1 服务（PID ${PID}）。"
    else
      say "v0.1 服务未在运行。"
    fi
    rm -f "$PIDFILE"
  else
    say "没有找到 v0.1 的 PID 文件，未在运行。"
  fi
  exit 0
fi

# ── --clean：移除工作树检出 ────────────────────────────────────────────────
if [ "$MODE" = "clean" ]; then
  if [ -f "$PIDFILE" ]; then
    PID="$(cat "$PIDFILE" 2>/dev/null || true)"
    [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
    sleep 1
  fi
  if [ -d "$WORKTREE" ]; then
    ( cd "$REPO_DIR" && git worktree remove --force .v0.1-run ) 2>/dev/null || rm -rf "$WORKTREE"
    say "已移除 v0.1 检出（${WORKTREE}）。"
  else
    say "v0.1 检出不存在，无需清理。"
  fi
  exit 0
fi

# ── 前置检查 ────────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "没有找到 node。v0.1 需要 Node.js 20+。"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || say "提示：v0.1 要求 Node 20+，当前是 $(node -v)，可能会失败。"

( cd "$REPO_DIR" && git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null ) \
  || die "找不到 tag ${TAG}。请先执行： git fetch --tags"

# ── 准备 worktree 检出 ─────────────────────────────────────────────────────
if [ ! -d "$WORKTREE" ]; then
  say "首次运行：从 tag ${TAG} 取出一份 v0.1 检出到 .v0.1-run/ ..."
  ( cd "$REPO_DIR" && git worktree add -q --detach "$WORKTREE" "$TAG" ) \
    || die "创建 worktree 失败。"
else
  say "复用已有的 v0.1 检出（.v0.1-run/）。"
fi

# ── 选端口：默认 8765，被占则顺延；已是本项目服务则直接复用 ────────────────
is_our_server() {
  local body
  body="$(curl -sS -m 3 "http://127.0.0.1:$1/api/bootstrap" 2>/dev/null || true)"
  case "$body" in *'"runtimeVersion"'*) return 0 ;; *) return 1 ;; esac
}

if [ -n "$PORT" ]; then
  PICKED="$PORT"
  if is_our_server "$PICKED"; then
    say "端口 ${PICKED} 上已经有一个小芽服务在跑，直接用它。"
    if [ "$OPEN_BROWSER" = "1" ]; then open "http://127.0.0.1:${PICKED}/"; fi
    exit 0
  fi
else
  PICKED=""
  for p in 8765 8766 8767 8768 8769 8770; do
    if is_our_server "$p"; then
      say "端口 ${p} 上已经有一个小芽服务在跑，直接用它。"
      if [ "$OPEN_BROWSER" = "1" ]; then open "http://127.0.0.1:${p}/"; fi
      exit 0
    fi
    if ! lsof -ti:"$p" >/dev/null 2>&1; then PICKED="$p"; break; fi
  done
  [ -n "$PICKED" ] || die "8765—8770 都被占用了，请用 --port 指定一个空闲端口。"
fi

# ── 启动 ────────────────────────────────────────────────────────────────────
# 关键：把 stdin 接到 /dev/null，并把 stdout/stderr 落进日志文件。
# 少了 `</dev/null`，背景进程会继承调用方的 stdin，从脚本/CI 里调用时
# 会一直等不到 EOF 而挂住（交互式终端里看不出来）。
# 也不要写 `2>&-` 之类的「关闭描述符」——那样 node 起不来。
# 关于这一行，两个坑都实测踩过，写下来免得后人再踩：
#   1) 必须用 exec，让子 shell 被 node 取代，$! 才是 **node 自己的 pid**。
#      不用 exec 时 $! 是子 shell 的 pid，node 是它的子进程；--stop 杀掉子 shell
#      只把 node 变成孤儿，服务继续跑（实测：pidfile 78141 / 真实监听 78142）。
#   2) 不能写 `nohup exec node ...`。macOS 的 nohup 会把 exec 当成要执行的程序，
#      报 `nohup: exec: No such file or directory`，服务根本起不来。
#      这里不需要 nohup：后台运行靠 `&`，父子关系靠 exec 断开即可。
#   3) 不能省 `</dev/null`：否则背景进程继承调用方 stdin，从脚本里调用会挂住。
say "启动 v0.1（${TAG}），端口 ${PICKED} ..."
( cd "$WORKTREE" && PORT="$PICKED" exec node server.js >"$LOGFILE" 2>&1 </dev/null & echo $! >"$PIDFILE" )
sleep 2

PID="$(cat "$PIDFILE" 2>/dev/null || true)"
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  say "启动失败，日志："
  sed -n '1,40p' "$LOGFILE" 2>/dev/null || true
  die "服务没有起来。"
fi

# 等它真正响应
for _ in $(seq 1 20); do
  if curl -sS -m 2 -o /dev/null "http://127.0.0.1:${PICKED}/api/bootstrap" 2>/dev/null; then break; fi
  sleep 0.5
done

URL="http://127.0.0.1:${PICKED}/"
say ""
say "  ✅ v0.1 已在运行： ${URL}"
say "     营地首页：      ${URL}"
say "     接入模型（可选）：${URL}connect.html"
say ""
say "  停止：./run-v0.1.sh --stop      清理检出：./run-v0.1.sh --clean"
say "  不接模型也能完整游玩；要接 DeepSeek，可在上面那个页面填 Key"
say "  （Key 只留在服务进程内存里，不落盘、不写日志）。"
say ""

if [ "$OPEN_BROWSER" = "1" ]; then
  open "$URL" 2>/dev/null || say "（自动打开浏览器失败，请手动访问上面的地址。）"
fi
