#!/usr/bin/env bash
# 生成 **结构正确** 的 READY.json（人类/Lead 在**手册目录**跑这一条；成员侧写不了那个目录 ✗）
#
# 背景（排查表 #4）：我们那份 READY.json 缺手册要的 `data_hashes` / `source_hashes` ✗，
# 而 `readiness.mjs check` 会**逐项比对**这三个结构键 ⇒ 只能用它自己的 `snapshot` 生成，
# **不许手改、不许放宽门禁**（监工明令）。
#
# ⚠ 两条实测更正（与 `一页说明` 附录三 的写法不同）：
#   ① `readiness.mjs snapshot` 实际写的是 **`READY.example.json`**（不是 `READY.json` ✗ 不覆盖我们那份 ✓）
#      —— 见 `readiness.mjs:14`：`writeFileSync(resolve(root,'READY.example.json'), …)`
#   ② `check` 要求**五个 checks 全 true** 且 `evidence[key]` 是**非空字符串**（`readiness.mjs:18`）
#      ⇒ 我们的四块里 `checks`/`evidence` 必须是"有证据的那些"，**不许为了过闸把 false 改 true** ✗
#
# 用法（在手册目录跑）：
#   bash 生成READY-一条命令.sh /path/to/roco-coach
set -euo pipefail

REPO="${1:-/Users/serendizc/Developer/roco-coach}"
MANUAL="/Users/serendizc/Codex/Internship/4b-training-2026-09-29"
DATA_SRC="$REPO/training/prep-2026-09-29/router-v9"
DATA_DST="$MANUAL/data/router-v9"
OURS="$REPO/training/prep-2026-09-29/训练前准备包/READY-四块-可合并.json"

echo "== ① 数据就位（三份 jsonl + 评测输入）到手册目录 =="
mkdir -p "$DATA_DST"
for f in train.jsonl valid.jsonl test.jsonl cases-for-gate.jsonl gate-report.json gen-trace.json; do
  [ -f "$DATA_SRC/$f" ] && cp -f "$DATA_SRC/$f" "$DATA_DST/$f" && echo "   ✓ $f"
done

echo "== ② 跑 snapshot（生成【结构正确】的三个结构键）=="
cd "$MANUAL"
node readiness.mjs snapshot data/router-v9
echo "   ⇒ 已生成 READY.example.json（结构键：data_dir / data_hashes / source_hashes ✓）"

echo "== ③ 把我们的四块并进去（⚠ 结构键一个字都不动）=="
python3 - "$MANUAL/READY.example.json" "$OURS" "$MANUAL/READY.json" <<'PY'
import json, sys
example, ours, out = sys.argv[1], sys.argv[2], sys.argv[3]
a = json.load(open(example)); b = json.load(open(ours))
struct = {k: a[k] for k in ('data_dir', 'data_hashes', 'source_hashes')}   # 原样带走
for k in ('checks', 'evidence', 'blocking', 'evaluator_entry', 'note', 'data_note'):
    if k in b: a[k] = b[k]
json.dump(a, open(out, 'w'), ensure_ascii=False, indent=2)
# 结构键**逐字**与 snapshot 的一致（顺序也要一致：JSON.stringify 比对）
json.dump(struct, open(out + '.struct-check', 'w'), ensure_ascii=False)
print('   已写', out)
print('   结构键未动：', [k for k in ('data_dir', 'data_hashes', 'source_hashes') if a.get(k) is not None])
missing = [k for k in ('runtime_contract_checked', 'training_serving_prompt_aligned', 'data_reviewed',
                       'test_frozen', 'task_evaluator_ready')
           if a.get('checks', {}).get(k) is not True or not str(a.get('evidence', {}).get(k, '')).strip()]
print('   ⚠ check 会拦的项（有证据才填 true；**不许手改**）：', missing or '无')
PY

echo "== ④ 门禁 check（必须退 0）=="
node readiness.mjs check data/router-v9 && echo "   ✓ READY 结构 + 指纹一致"

echo
echo "⚠ 注意：`source_hashes` 覆盖的 7 个源文件（含 src/coach/toolbox.js、src/server/index.js）"
echo "   只要有一个变了 ⇒ **必须重跑本脚本**（不能沿用旧 READY）。"
