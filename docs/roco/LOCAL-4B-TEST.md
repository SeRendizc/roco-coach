# 本机 Qwen3.5-4B 实测（2026-09-25，人类：「据称已经训练好了，你测试一下」）

## 结论一句话
**部分确认**：权重与 LoRA 适配器**都在**、**能加载**（2.32s / 峰值 2.2–2.47GB）、**能生成**（合法 JSON 与通顺中文）；
但「**已训好且可用**」这个结论**下不了** —— ① 文档里那条唯一的本地臂评测入口**当前是坏的**（一行 import 缺失，
`ReferenceError: gatewayAsk is not defined`）；② 因此**没能在任务集上重测**；③ 历史数字明确**劣于规则 baseline**（退化 42 / 扳回 0）。

## ① 权重在哪（实测）
| 项 | 值 |
|---|---|
| 主权重 | `.models/mlx/Qwen3.5-4B-4bit/model.safetensors` **3 034 300 695 B**（mtime 2026-09-21 05:57），同目录有 `config.json` / `tokenizer.json` / `chat_template.jinja` |
| LoRA 适配器 | `.models/adapters/qwen35-4b-tool-v1…v4`（合计 **217 MB**）——「训好的」那部分在这里 |
| 后端 | **MLX**（`scripts/model/serve_mlx.py`，常驻 stdio JSONL；`scripts/serve` 不联网、不写文件），网关 `src/coach/local-model.js`（`SERVE_SCRIPT` / `DEFAULT_MODEL_DIR` 见其 `:35-37`） |
| venv | `.venv-mlx`（`mlx` / `mlx_lm 0.31.3` / `numpy` 都在；python 指向 uv 装的 3.12） |
| 开关 | `ROCO_LOCAL_MODEL=off|shadow|on`（默认 off）；路径 `ROCO_LOCAL_MODEL_PATH`；超时 `ROCO_LOCAL_TIMEOUT_MS`；适配器 `ROCO_LOCAL_ADAPTER` |
| `models/` 目录本身 | 只有 `registry.json`（清单/占位），**权重不在那里** |

`serve_mlx.py --selftest`（不加载权重）实测：模型文件齐全、`"mlx_available": true`。

## ② 真跑（冒烟，两条请求，含 LoRA v4）
启动：`.venv-mlx/bin/python scripts/model/serve_mlx.py --model .models/mlx/Qwen3.5-4B-4bit --adapter .models/adapters/qwen35-4b-tool-v4`
| 量 | 实测 |
|---|---|
| 加载 | `{"event":"ready", "load_seconds": **2.32**, "peak_memory_gb": 2.205}` |
| r1（工具选择型：system=「只输出 {"tool":...} 或 {"stop":true}」，问「对手还剩多少药？我要不要换宠？」） | 输出 **`{"stop":true}`**（合法 JSON，**但选择不查证** —— 与云端臂那条「欠调用」同形）；`first_token_ms 3607.8` / `total_ms 3692.5` / **1.62 tok/s**（首跑含预热） |
| r2（纯问答：「能量不够时该不该硬出招」） | 通顺中文一句；`first_token_ms 324.0` / `total_ms 711.4` / **37.95 tok/s** |
| 峰值显存 | 2.474 GB |

原始产物：`reports/roco/local-4b-test-2026-09-25/{selftest.txt,smoke.jsonl,smoke.err}`

## ③ 跑不起来的那个入口（**真缺陷**，我没改）
```
$ npm run roco:shadow-replay -- --arm local_4b --out reports/roco/local-4b-test-2026-09-25/shadow-replay-local_4b.json
[shadow-replay] ReferenceError: gatewayAsk is not defined
    at main (file:///.../scripts/roco/shadow-replay.mjs:267:19)
```
- 根因：`scripts/roco/shadow-replay.mjs:267` **用了 `gatewayAsk` 却从没 import 它**；该函数定义在
  `scripts/roco/local-model-ask.mjs:13`，并由 `scripts/roco/model-identity.mjs:77` 再导出（`build-agent-trajectories.mjs:29` 就是那样引的）。
- 修法：**加一行** `import {gatewayAsk} from './local-model-ask.mjs';`（或从 `model-identity.mjs` 引）。
- 为什么我没修：本任务限定「不许改任何既有文件」。**这是当前唯一挡住「本地臂重测」的东西。**

## ④ 历史基线（先抄出来，供重测对照）
| 产物 | 任务 | 通过 | 通过率 | 停止分布 | 延迟 |
|---|---|---|---|---|---|
| `reports/roco/shadow-replay-local_4b.json` | 288 | **268** | **0.9306** | complete 264 / receipt-budget 12 / policy 12 | p50 **425ms** / p95 **889ms** |
| `reports/roco/shadow-replay-local_4b-promptv2.json` | 288 | 211 | 0.7326 | complete 189 / invalid-arguments 81 / receipt-budget 6 / policy 12 | p50 624 / p95 1096 |
| 与**规则 baseline** 逐条配对（`docs/roco/W4-02-MODEL-CANDIDATES.md:123-138`，864 个重合窗口） | — | — | 规则 **864/864**；**模型退化 42（roster_constraint 33 / rules_lookup 9）、扳回 0** | — | — |

## ⑤ 需要人类/主线程做的事（按优先级）
1. **修那一行 import**（`shadow-replay.mjs`）——否则本地臂永远跑不了；修完 `npm run roco:shadow-replay -- --arm local_4b --out <路径>` 就能拿新数字（历史 p50 425ms 说明**延迟不是问题**）。
2. 修好后**在任务集上重测**，与上面 288 条口径对照（同任务集、同判据）。
3. **与 DeepSeek 同提示集对照**要主线程做（需要 key + 跑着的服务；云端今天的数字见 `reports/live-model-eval.json`：49 例、工具选择 33/49）。
4. 若要「4B 进请求路径」，先看 `docs/roco/W4-02-MODEL-CANDIDATES.md` 的结论：**它在这套任务集上从没超过规则 baseline** —— 这与 `MODEL-ROUTING-PLAN.md` 给它的角色（提议/措辞/离线降级，不进结算）一致。

## ⑥ 我没有做到 / 不确定的
- **没能**在任务集上真跑本地臂（入口坏了，见 ③）；上表 ④ 是**历史产物**的数字，不是今天重测的。
- 冒烟只有 **2 条**请求，**不足以**谈「合法输出率」；要那个数字必须先修 ③。
- 首次调用 1.62 tok/s 明显偏慢，疑为**预热/首次编译**；r2（第二次）37.95 tok/s 更像稳态 —— 但样本只有 2 条，**不当结论**。
- 全程未改任何既有文件、未下载、未联网（除本机 stdio）。
