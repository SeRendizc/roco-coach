#!/usr/bin/env bash
# 带 DS 密钥启动 8765（**重启也不掉连接**）。
#
# 背景：`/connect.html` 录入的密钥只在进程内存（启动日志逐字：「密钥仅保存在当前进程内存，不写入文件」）
#   ⇒ 每重启一次就丢一次 ⇒ 引擎那边每落一批都要重启，人就老被踢下线。
# 这个脚本走应用**本来就支持**的那条路（`src/server/index.js:614` 读 `DEEPSEEK_API_KEY`）：
#   · 密钥**由你放在本地文件里**（默认 `~/.roco-ds-key`，**不在仓库内** ⇒ git 永远看不到 ✓）
#   · 脚本**只做"读文件 → 设环境变量 → exec 服务"**，**不写日志、不回显密钥** ✓
#   · 应用本身**仍然不落盘**（它只在启动时读一次环境变量、读完不再引用 ✓）
#
# 用法：
#   printf '%s' 'sk-你的密钥' > ~/.roco-ds-key && chmod 600 ~/.roco-ds-key   # 只做一次
#   bash scripts/roco/serve-with-ds-key.sh                                    # 以后都这么起
#   ROCO_DS_KEY_FILE=/别处/的密钥 bash scripts/roco/serve-with-ds-key.sh      # 想换位置
set -euo pipefail
KEY_FILE="${ROCO_DS_KEY_FILE:-$HOME/.roco-ds-key}"
if [[ ! -f "${KEY_FILE}" ]]; then
  echo "找不到密钥文件：${KEY_FILE}" >&2
  echo "先建一次（只做一次，密钥不进仓库）：" >&2
  echo "  printf '%s' 'sk-真实密钥' > \"${KEY_FILE}\" && chmod 600 \"${KEY_FILE}\"" >&2
  echo "（不想放文件也行：直接 DEEPSEEK_API_KEY=sk-… node src/server/index.js）" >&2
  exit 2
fi
# 读进来、去掉首尾空白与换行；**不回显**
KEY="$(tr -d '\r\n' < "${KEY_FILE}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [[ ! "$KEY" =~ ^sk-[A-Za-z0-9_-]{16,}$ ]]; then
  echo "密钥格式不对（看长度/前缀即可，脚本不回显内容）：${KEY_FILE}" >&2
  echo "期望形如 sk- 开头、后面 16 位以上 [A-Za-z0-9_-]" >&2
  exit 2
fi
cd "$(dirname "$0")/../.."
echo "以环境变量方式带密钥启动（重启不掉连接）；密钥来自 ${KEY_FILE}（不回显）"
DEEPSEEK_API_KEY="$KEY" exec node src/server/index.js
