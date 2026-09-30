# 真实工具执行评测：冻结题接入报告

**交付人**：advice-engine　**时间**：2026-09-29　**入口**：`scripts/roco/eval-tool-execution.mjs`（Lead 交付）
**适配器**：`training/prep-2026-09-29/router-v9/evaluator/build-cases.mjs`

## 1. 接入方式（题源与 `tool-tasks.mjs#loadTasks()` **同一批文件、同一套字段**）
```
node training/prep-2026-09-29/router-v9/evaluator/build-cases.mjs        # 生成下面四个文件
node scripts/roco/eval-tool-execution.mjs <cases>.jsonl --out <report>.json
```
| 文件 | 条数 | 说明 |
|---|---|---|
| `cases-dev.jsonl` | 92 | 开发题（`agent-tasks-v3-difficulty/*`） |
| `cases-frozen.jsonl` | 8 | **冻结题**（v2 coverage 的 `split==='held_out'` 18 条里，期望"调工具"的那 8 条） |
| `cases-stop.jsonl` | 41 | 负向/停止题（**本评测器口径外** ⇒ 分开交，不混算通过率） |
| `cases-excluded.jsonl` | 5 | **本机不评**：`plan_actions` 实测 >12 分钟 ⇒ 不硬等，如实登记 |

⚠ **这里的"模型输出"是按题目期望合成的** ⇒ 它证明的是**评测链路能真的跑通**，
**不是模型成绩**（成绩要人类把模型真实输出喂进来才成立）✓

## 2. 冻结题逐条读数（报告：`report-frozen.json`）
| case | 工具 | 分 | 判定 | 六步依据 |
|---|---|---|---|---|
| `cov-read_state-yes` | read_state | 4/6 | pass | ① 形状可解析 · ② 工具名合法 · ③ 参数合法（宿主补版本后） · ④⑤ 真执行 + 真回执（7 个键） · ⑥ 这个 case 不带动作 ⇒ 不判动作合 |
| `cov-search_rules-yes` | search_rules | 4/6 | pass | ① 形状可解析 · ② 工具名合法 · ③ 参数合法（宿主补版本后） · ④⑤ 真执行 + 真回执（6 个键） · ⑥ 这个 case 不带动作 ⇒ 不判动作合 |
| `cov-compare_actions-yes` | compare_actions | 4/6 | pass | ① 形状可解析 · ② 工具名合法 · ③ 参数合法（宿主补版本后） · ④⑤ 真执行 + 真回执（2 个键） · ⑥ 这个 case 不带动作 ⇒ 不判动作合 |
| `cov-simulate_branch-yes` | simulate_branch | 2/6 | **fail** | ① 形状可解析 · ② 工具名合法 · ③ 参数没过 validToolArgs |
| `cov-read_match-yes` | read_match | 4/6 | pass | ① 形状可解析 · ② 工具名合法 · ③ 参数合法（宿主补版本后） · ④⑤ 真执行 + 真回执（1 个键） · ⑥ 这个 case 不带动作 ⇒ 不判动作合 |
| `cov-read_evidence-yes` | read_evidence | 4/6 | pass | ① 形状可解析 · ② 工具名合法 · ③ 参数合法（宿主补版本后） · ④⑤ 真执行 + 真回执（4 个键） · ⑥ 这个 case 不带动作 ⇒ 不判动作合 |
| `cov-read_last_turn-yes` | read_last_turn | 4/6 | pass | ① 形状可解析 · ② 工具名合法 · ③ 参数合法（宿主补版本后） · ④⑤ 真执行 + 真回执（2 个键） · ⑥ 这个 case 不带动作 ⇒ 不判动作合 |
| `cov-summarize_battle-yes` | summarize_battle | 4/6 | pass | ① 形状可解析 · ② 工具名合法 · ③ 参数合法（宿主补版本后） · ④⑤ 真执行 + 真回执（14 个键） · ⑥ 这个 case 不带动作 ⇒ 不判动作 |

**通过率：7 / 8**（阈值 4/6）· 报告 `report-frozen.json` · 退出码 0

## 3. 跑不过的那一条：**是题的问题，不是模型问题** ✓
`cov-simulate_branch-yes` ⇒ `③ 参数没过 validToolArgs`。逐字证据（`validToolArgs` 实测）：
```
{"candidates":["skill:guard"]}                 → true    （新式那一支）
{"actionIndex":0,"opponentIndex":0}            → true    （legacy 那一支）
{"candidates":["skill:guard"],"actionIndex":0} → **false**（两支同时给 ⇒ 互斥）
```
而原题的 `expect.args_keys = ["candidates","opponent","unresolved","actionIndex","opponentIndex"]`
—— **同时要求互斥的两支** ⇒ **按题目期望合成的参数必然过不了 ③** ⇒ **题坏了**（人类已裁定「重新出」✓）。

**重出后的候选新题**（只留新式支）：`cases-frozen-v2.jsonl`
```
cov2-simulate_branch-yes | simulate_branch | 4/6 | pass      ← 同一条问句，只把互斥的键去掉
```
⇒ 报告 `report-frozen-v2.json`。**旧题保留**（改钉不删）；勘误件里请注明「已按人类裁定重出，新题见
`cases-frozen-v2.jsonl` / id `cov2-simulate_branch-yes`；旧的 `cov-simulate_branch-yes` 作废原因是
`args_keys` 同时列了新式与 legacy 两支」。

## 4. 开发题读数
`cases-dev.jsonl` **92 / 92 通过**（阈值 4/6，报告 `report-dev.json`，退出码 0）。

## 5. 三条纪律的落实
① **没手搓 context**：全程用评测脚本自己的 `makeContext()`（`createGame` 造真 JS game）✓
② **`plan_actions` 不硬等**：单独登记为"未评"（`cases-excluded.jsonl`），**不拿超时当通过/失败** ✓
③ **判"真执行了"看"回执有真数据"**：六步里的 ④⑤ 就是这条（`receiptKeys` 记在报告里）✓

## 6. 还给 Lead 的两件事
- `READY.json` **不由我填** ✓ —— 第 5 项能否变 true 的证据（本报告 + 两份 report json）已齐；
- **发现一处评测器的口径边界**（不是缺陷，供你判断要不要写进 README）：评测器只评"期望调工具"的题；
  **停止题**（41 条）它会按形状判 0 分 ⇒ 我**没有**把它们混进通过率，而是单独放在 `cases-stop.jsonl` ✓
