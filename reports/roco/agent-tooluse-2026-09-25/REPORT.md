# agent 用工具：本地 4B 臂的四个配置对照（2026-09-25）

**一句话**：`rules_lookup` / `roster_constraint` 这两类**该调工具**的任务，本地 4B 臂的病根是
**「该不该查」这个决策本身** —— 改写系统提示会把它打出分布（12/72 → 2/72），
把工具回执喂回去、允许多步也没有帮助（12/72 → 10/72）。**调提示与调管线都解决不了，这是模型/训练问题。**

## 实测数字（同一任务集、同一世界、同一判定器）

| 臂 | 配置 | `rules_lookup` | `roster_constraint` |
|---|---|---|---|
| `rule` | 确定性规则臂（参照） | **72/72** | **24/24** |
| `local_4b` | 冻结提示 + **单步**（改动前的现状） | **12/72** | **0/24** |
| `local_4b_receipts` | 冻结提示 + **回执/多步**（只动①） | **10/72** | **0/24** |
| `local_4b_agent` | **新判定提示** + 回执/多步（①+③） | **2/72** | **1/24** |

调用次数分布（`rules_lookup`，72 条）：

| 臂 | 0 次调用 | 1 次 | 2 次 |
|---|---|---|---|
| `local_4b` | 56 | 16 | 0 |
| `local_4b_receipts` | 58 | 14 | 0 |
| `local_4b_agent` | 61 | 10 | 1 |

**「一次都不查」是主因**：三种配置下都有 56–61/72 条任务全程零次工具调用。
通过的那几条，都是**提示里给了按名字查的路径**的那类（如 `query_rules{kind:'skill',name:'坟场搏击'}`）。

## 三个被证伪的假设（都留了产物，可复跑）

1. **「模型不知道要调工具，是提示没写清楚」** —— 不成立。
   把判定规则改写成「问具体规则事实必须先查证」，零调用反而从 56 涨到 61，通过率 12/72 → 2/72。
   **原因**：这个 adapter（`.models/adapters/qwen35-4b-tool-v3`）是对着**固定那一份**系统提示 SFT 的，
   提示一改就掉出训练分布。仓库里另有一次同源实测：把参数契约逐条写进提示，
   0.7847 → 0.7326、`rules_lookup` 31/72 → 13/72（见 `scripts/roco/agent-trajectories.mjs`
   的 `buildLocalToolSystem()` 注释与 `shadow-replay-local_4b-promptv2.json`）。
   ⇒ **对已训好的 adapter，「把提示写得更对」不是可用杠杆。**
2. **「多步管线没接上」** —— 不成立。
   `runArm`（`scripts/roco/agent-trajectories.mjs:877`）本来就把 `receipts`（含每条工具的 `result`）
   递给 planner；缺的是**用**它。补上之后（`local_4b_receipts`）通过率没有变化（12 → 10，噪声内），
   因为模型第 1 步就 stop，根本走不到第 2 步。
3. **「`pet_id` 无从得知，所以查不到」** —— 这一条**成立但不充分**。
   `rl-pet`/`rl-learn` 各 12 条确实需要 `pet_id`，而提示只说「精灵用 pet_id」，
   模型手上没有名字→id 的路（`rl-learn` 甚至调了 4 次 `kind:learnset` 却因 id 不对而无效）。
   但**给了路也没用**：`local_4b_agent` 里模型确实按名字查了一次
   （`query_rules{kind:'pet',name:'寂灭骨龙'}`，见 `raw-probe` 记录），
   随后仍然 stop、不走第二步。而且 `rl-ruleset`（`kind:ruleset` **不需要任何定位参数**）
   同样是 0/12 —— 说明问题不在「查得到查不到」，在「肯不肯查」。

## 与云端臂的关系（同一天的另一份实测）

云端 49 例（`deepseek-flash`，真跑）里 (乙) 现行为 28/49、(甲) 替代判定 27/49 几乎打平，
两者都错的 13 条中有 **10 条是 `cat3-cross-tool`**（金标 `expect.calls:[2,2]`：要两个不同来源）。
⇒ 云端那边缺的是**充分性判定**（回执覆盖了几个来源），云端模型**能**听懂这类规则；
本地 4B 这边缺的是**肯不肯发起第一次调用**，属于训练分布问题。**两边的下一步不是同一件事。**

## 复现命令

```bash
# 任务集/世界/判定器都不变，只换「谁在选工具」；--category 只跑一类
node scripts/roco/shadow-replay.mjs --arm rule                --category rules_lookup --out /tmp/arm-rule-rules_lookup.json
node scripts/roco/shadow-replay.mjs --arm local_4b            --category rules_lookup --out /tmp/arm-local_4b-rules_lookup.json
node scripts/roco/shadow-replay.mjs --arm local_4b_receipts   --category rules_lookup --out /tmp/arm-receipts-rules_lookup.json
node scripts/roco/shadow-replay.mjs --arm local_4b_agent      --category rules_lookup --out /tmp/arm-agent-rules_lookup.json
# 本地臂需要网关：ROCO_LOCAL_ADAPTER="$PWD/.models/adapters/qwen35-4b-tool-v3" node scripts/model/local-gateway.mjs
```

模型原始输出（单条探针）：`/tmp/roco-recon/raw-probe.mjs`（三者都是 `{"stop":true}`）。

## 产物

- `arm-<臂>-<类别>.json`：八份完整回放产物（含每条任务的 trace、violations、判定）。
- 相关代码：`scripts/roco/agent-trajectories.mjs`（`AGENT_TOOL_SYSTEM` / `localAgentPlanner`）、
  `scripts/roco/shadow-replay.mjs`（臂分支 + `--category`）。

## 边界（这份报告**没有**说的话）

- 没有动判定器（`checkTask`）一个字，也没有放宽任何判据；四臂用的是同一条判据。
- 没有声称「4B 不行」：只说了**这三个配置在这两类任务上**不work，以及被证伪的三个假设。
- 没有把 288 条里的其余类别算进来（这份只覆盖 `rules_lookup` 72 条 + `roster_constraint` 24 条）。

---

# 附：云端臂的「充分性规则」A/B（同一天，负结果）

**动机**：`cat3-cross-tool` 10 条金标要求 `expect.calls:[2,2]`（两个不同来源各一份回执），
而现提示里「receipts 里已经有的事实不要再调」「不要为了用完预算而继续查」会被读成「有一份就够」。

**做法**：给 planner 提示加一条可开关的**充分性规则**（`ROCO_PLANNER_SUFFICIENCY=1`，
默认关；`src/server/index.js` 的 `SUFFICIENCY_RULE`），同一批 `cat3`+`cat4` 共 18 例，
两个影子服务（8931 无开关 / 8932 有开关）各真跑一遍。

**结果（`deepseek-flash`，18/18 执行成功，0 报错）**：

| 指标 | 基线 | 充分性规则 ON |
|---|---|---|
| 工具选择正确 | **11/18** | **11/18** |
| 失败用例 | c25（首个工具选错）、c26/c28/c29/c30/c33（**该调却一次没调**） | **完全相同的一批** |
| 最终回答措辞 | — | **18/18 条都变了** |

**开关确实生效**（不是没读到）：`SUFFICIENCY_RULE` 长度 154 vs 0；逐条 diff 显示 18/18 的
`text` 都不同（`c26` 基线「…能量果恢复4点并占用一整个行动…」vs 开关「…能量果恢复 4 点，但会占用…」）。

**结论**：这条规则改变了**措辞**，没有改变**行为** —— 「该不该调工具」在云端臂上同样
不是提示能撬动的。两条臂各自被证伪的杠杆合起来是一句话：
**「把提示写得更对」在本地 4B（12/72 → 2/72）与云端（11/18 → 11/18）都不work。**

**下一步的杠杆在编排层，不在提示**：`gatherAgentEvidence`（`src/coach/runtime.js`）里已经有
**确定性强制**的先例 —— `mustCall` 首枪政策（`:330-344`）在模型开口前就执行必需工具；
而 `requiredTool()`（`:204`）目前只作为 `hardRequired` **建议**给 planner。
要补的是「**回执覆盖度**」判定：问题涉及几个来源、已有回执覆盖了几个，不足就**强制**下一次调用
（与 `cat3` 的 `[2,2]` 金标对齐），而不是请求模型自觉。

**产物**：`/tmp/roco-recon/eval-baseline.json`、`/tmp/roco-recon/eval-sufficiency.json`
（仓库里的 `reports/live-model-eval*.json` 是跑前备份、跑后原样还原的，未被本次实验覆盖）。
复现：`PORT=8931 DEEPSEEK_API_KEY=… node src/server/index.js` 与
`PORT=8932 ROCO_PLANNER_SUFFICIENCY=1 … node src/server/index.js`，
再各自 `ROCO_EVAL_ORIGIN=http://127.0.0.1:893x node scripts/eval-live-s04.js --only c25,…,c42`。
