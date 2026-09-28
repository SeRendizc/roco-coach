#!/usr/bin/env bash
# 用户亲自运行；本次交付未执行此脚本。不会修改或覆盖 v8。
set -euo pipefail
GUIDE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="/Users/serendizc/Developer/roco-coach"
MODE="${1:-smoke}"
DATA_DIR="${ROCO_TRAIN_DATA:-${GUIDE_DIR}/data/router-v9}"
case "$MODE" in
 smoke) STEPS=20; LR=0.00001; EVAL=20; SAVE=20;;
 fresh) STEPS="${ROCO_TRAIN_STEPS:-400}"; LR=0.00001; EVAL=100; SAVE=100;;
 continue) STEPS="${ROCO_TRAIN_STEPS:-200}"; LR=0.000005; EVAL=100; SAVE=100;;
 *) echo '用法：bash train_v9.sh smoke|fresh|continue' >&2; exit 2;;
esac
for name in train valid test; do
 [[ -f "$DATA_DIR/$name.jsonl" ]] || { echo "缺 $DATA_DIR/$name.jsonl；先完成数据与接口冻结，不能拿教程样例当正式训练集。" >&2; exit 2; }
done
[[ -f "$GUIDE_DIR/READY.json" ]] || { echo '先按指导完成接口与样本审核并建立 READY.json；当前包尚未具备正式训练数据。' >&2; exit 2; }
node "$GUIDE_DIR/readiness.mjs" check "$DATA_DIR"
node "$GUIDE_DIR/audit_dataset.mjs" "$DATA_DIR" --new-data
PYTHONDONTWRITEBYTECODE=1 "$REPO_DIR/.venv-mlx/bin/python" "$GUIDE_DIR/token_audit.py" "$DATA_DIR" --max-seq-length 1024
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="${GUIDE_DIR}/runs/${STAMP}-${MODE}"
mkdir -p "$RUN_DIR"
cp "$GUIDE_DIR/lora-v9.yaml" "$RUN_DIR/config-source.yaml"
cp "$GUIDE_DIR/READY.json" "$RUN_DIR/READY.json"
RESUME_ARGS=()
if [[ "$MODE" == continue ]]; then
 RESUME_ARGS=(--resume-adapter-file "$REPO_DIR/.models/adapters/qwen35-4b-tool-v8/adapters.safetensors")
fi
PYTHONDONTWRITEBYTECODE=1 "$REPO_DIR/.venv-mlx/bin/python" -m mlx_lm lora \
 --config "$GUIDE_DIR/lora-v9.yaml" \
 --model "$REPO_DIR/.models/mlx/Qwen3.5-4B-4bit" \
 --data "$DATA_DIR" --train --iters "$STEPS" --learning-rate "$LR" \
 --steps-per-eval "$EVAL" --save-every "$SAVE" \
 --adapter-path "$RUN_DIR/adapter" "${RESUME_ARGS[@]}" \
 2>&1 | tee "$RUN_DIR/train.log"
printf '训练输出：%s\n' "$RUN_DIR"
