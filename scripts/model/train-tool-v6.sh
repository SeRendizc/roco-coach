#!/usr/bin/env bash
# 训 v5：**基座 + 老 SFT + 新覆盖切片**（8 个"从没被考过"的工具），配置对齐 v4 那一套。
#
# 为什么从基座重训而不是接着 v4 续训：v5 要和老门禁的成绩**同口径可比**（v1–v4 都是从基座训的）。
# 数据 = `reports/roco/sft-v6`（老 train/valid/test 各加上新覆盖切片，脚本生成的）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"
ADAPTER="${ROOT}/.models/adapters/qwen35-4b-tool-v6"
LOG="${ROOT}/reports/roco/sft-v6/train.log"
mkdir -p "$(dirname "${LOG}")"
echo "=== v5 训练开始 $(date) ===" | tee "${LOG}"
.venv-mlx/bin/python -m mlx_lm.lora \
  --model "${ROOT}/.models/mlx/Qwen3.5-4B-4bit" \
  --data "${ROOT}/reports/roco/sft-v6" \
  --train --fine-tune-type lora --num-layers 8 --batch-size 1 \
  --iters "${ITERS:-900}" --learning-rate 1e-5 --max-seq-length 768 --mask-prompt \
  --seed 20260921 --steps-per-report 150 --steps-per-eval 450 \
  --save-every 450 --val-batches 25 \
  --adapter-path "${ADAPTER}" 2>&1 | tee -a "${LOG}"
echo "=== v5 训练结束 $(date) → ${ADAPTER} ===" | tee -a "${LOG}"
