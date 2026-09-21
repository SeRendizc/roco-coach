# 作废的产物（保留，但不得再被引用）

这里的文件**不是垃圾**：它们是「当时确实这么记过」的证据。留着的意义是让后来的人
看得见事故的形状，而不是让它们继续被当成有效数据。

## shadow-replay 系列：模型臂的成绩**存档错位**（第 37 轮发现）

| 文件 | 里面实际是什么 | 名字声称是什么 | 为什么作废 |
|---|---|---|---|
| `shadow-replay-sft-v1.json` | **v1** 的成绩（229/288） | v1 ✅ | 内容其实是对的——但它没有 `identity` 字段，「这份是 v1 跑出来的」只靠文件名声称、无法核对；已由带身份的重测产物取代 |
| `shadow-replay-sft-v2.json` | **v1** 的成绩（229/288） | v2 | 存档时复制错了文件 |
| `shadow-replay-sft-v3.json` | **v2** 的成绩（268/288） | v3 | 同上 |
| `shadow-replay-local_4b.json` | 最后一次跑的那个（**v2**，268/288） | 基座 | 运行器每次都覆盖这个名字，基座那一份早没了 |
| `shadow-replay-local_4b-promptv2.json` | 早期提示实验的结果（211/288） | — | 提示已定稿（`prompt_digest a5cb0fbcc53fbecd`），这一份是定稿前的 |

**根因**（不修根因就还会再错一次）：

1. 报告里**没有模型身份**——没有「这份是哪个适配器产出的」，错位无从发现；
2. 运行器每次把结果写到同一个 `shadow-replay-local_4b.json`，再由人工 `cp` 改名，手一滑就错位；
3. `scripts/model/stop-mac.sh` 找的 pid 文件名（`serve.pid`）**从来没被任何代码写过**，
   所以「停网关」是个空操作：换适配器时上一个还在跑，下一个 arm 其实用的还是旧权重。

**已做的修复**：报告新增 `identity`（模型 / 适配器 / `adapter_sha256` / 提示摘要）；
`--out` 显式指定产物路径；`stop-mac.sh` 改认 `gateway.pid` 并按端口兜底；
新增守卫 `tests/evals/roco/model-arm-identity.test.js` 把「文件名 ↔ 适配器」钉死
（两个方向都测：正向自洽、反向注入必红）。

**重测结果**（`docs/roco/W4-04-SFT-PREREGISTRATION.md` §6，判据跑之前就写好了）：

| arm | 通过 | 通过率 | 适配器 sha256（前 12 位） |
|---|---|---|---|
| 基座 | 225/288 | 0.7813 | 无 |
| v1 | 229/288 | 0.7951 | `3856e1d367a2` |
| v2 | 268/288 | 0.9306 | `75d610923085` |
| v3 | 204/288 | 0.7083 | `e09a52f23e1a` |
| v4 | 275/288 | 0.9549 | `362cc0208717` |

作废的这一批**没有 `identity` 字段**，这是它们与本轮重测产物最直接的区别。

## planner-matches-2026-09-21-invalid.json

更早的一次对局基准：两边局数不等（planner 80 局 vs 基线 40 局）且拿区间重叠当显著性检验。
已改为双方各坐两边、配对 McNemar 精确检验 + 配对 bootstrap。细节见
`docs/roco/BENCHMARKS.md` 与 `docs/roadmap/DSH-EXECUTION-STATE.md`。
