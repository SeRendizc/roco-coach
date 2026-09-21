#!/usr/bin/env bash
# 逐个适配器在**同一把尺子**上重测，结果写到**显式**的产物名上。
#
# 为什么需要这个脚本（而不是手敲几条命令）
# ----------------------------------------
# 第 37 轮发现模型臂的成绩存档**错位**：`-sft-v2.json` 里装的是 v1 的成绩、
# `-sft-v3.json` 里装的是 v2 的、真正的 v3 一个产物都没留下。两个原因叠加：
#   ① 报告里没有模型身份，看不出「这份是谁跑出来的」；
#   ② 运行器把结果写到同一个 `-local_4b.json`，再由人工 `cp` 改名——手一滑就错位。
# 所以这里把「换适配器 → 起网关 → 核对身份 → 跑门禁 → 写到显式路径」串成一条命令，
# 每一步都打印身份，人不需要记任何中间状态。
#
# 用法::
#
#     bash scripts/model/measure-arms.sh base= \
#         v1="$PWD/.models/adapters/qwen35-4b-tool-v1" \
#         v2="$PWD/.models/adapters/qwen35-4b-tool-v2"
#
# 每个参数形如 `标签=适配器路径`；`base=` 表示不带适配器（基座）。
# 产物：`reports/roco/shadow-replay-<标签>.json`，日志 `reports/roco/model-arms/<标签>.log`。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"
PORT="${ROCO_LOCAL_PORT:-8766}"
OUT_DIR="${ROOT}/reports/roco"
LOG_DIR="${OUT_DIR}/model-arms"; mkdir -p "${LOG_DIR}"
REF="${OUT_DIR}/shadow-replay.json"

[ "$#" -ge 1 ] || { echo "用法：bash scripts/model/measure-arms.sh 标签=适配器路径 [标签=路径 …]" >&2; exit 2; }
[ -f "${REF}" ] || { echo "缺少参考臂 ${REF}，先跑 node scripts/roco/shadow-replay.mjs --arm rule" >&2; exit 2; }

for spec in "$@"; do
  LABEL="${spec%%=*}"
  ADAPTER="${spec#*=}"
  LOG="${LOG_DIR}/${LABEL}.log"
  echo "=== ${LABEL}（适配器：${ADAPTER:-无，基座）} ===" | tee "${LOG}"

  # 必须真的停掉。旧版 stop 脚本找的是从来没被写过的 serve.pid，
  # 于是「停」是个空操作，下一个 arm 其实还在用上一个 arm 的权重。
  bash "${ROOT}/scripts/model/stop-mac.sh" | tee -a "${LOG}"

  if [ -n "${ADAPTER}" ]; then
    [ -d "${ADAPTER}" ] || { echo "适配器目录不存在：${ADAPTER}" >&2; exit 3; }
    export ROCO_LOCAL_ADAPTER="${ADAPTER}"
  else
    unset ROCO_LOCAL_ADAPTER || true
  fi
  bash "${ROOT}/scripts/model/start-mac.sh" | tee -a "${LOG}"

  # 把网关**自己报的**身份记下来。名字对不对不重要，这里记的是它真的加载了什么。
  curl -fsS "http://127.0.0.1:${PORT}/healthz" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  网关自报：ready', d['ready'], '| model', d['model'], '| adapter', d['adapter'])
" | tee -a "${LOG}"

  node "${ROOT}/scripts/roco/shadow-replay.mjs" --arm local_4b \
    --out "${OUT_DIR}/shadow-replay-${LABEL}.json" --compare "${REF}" 2>&1 | tee -a "${LOG}"

  python3 - "${OUT_DIR}/shadow-replay-${LABEL}.json" "${LABEL}" <<'PY' | tee -a "${LOG}"
import json, sys
path, label = sys.argv[1], sys.argv[2]
d = json.load(open(path, encoding='utf-8'))
ident = d.get('identity') or {}
print('  产物身份：adapter_basename', ident.get('adapter_basename'),
      '| adapter_sha256', str(ident.get('adapter_sha256'))[:16],
      '| prompt_digest', str(d.get('prompt_digest'))[:16])
# 存档名与真正加载的适配器必须一致。不一致就**明确报错**，不让它静默通过——
# 第 37 轮那几个错位存档就是这么产生的。
if label == 'base':
    if ident.get('adapter') is not None:
        raise SystemExit('  ✖ base 的产物里写着 adapter=' + str(ident.get('adapter')) + '：它其实是某个适配器的成绩')
elif label.startswith('sft-'):
    want = 'qwen35-4b-tool-' + label.split('-')[1]
    if ident.get('adapter_basename') != want:
        raise SystemExit('  ✖ ' + label + ' 的产物里写着 adapter=' + str(ident.get('adapter_basename')) + '，应当是 ' + want)
else:
    print('  （标签不参与命名约定，跳过名字核对）')
PY
done

echo "全部完成。产物在 ${OUT_DIR}/shadow-replay-*.json，日志在 ${LOG_DIR}/"
