# agent / LLM 主线：2026-09-25 两轮实测与规划（汇总）

> 这份文件是**给人看的汇总**（细节在 `docs/roadmap/DSH-EXECUTION-STATE.md` 的 C6.82 / C6.83 与
> `docs/roadmap/MODEL-ROUTING-PLAN.md`）。所有数字都是真跑出来的，标注了复算命令。

---

## 一、这一轮 agent 线落地了什么

| # | 事 | 实测 / 证据 |
|---|---|---|
| 1 | **服务端事实守卫**（原来只在浏览器里） | `src/coach/runtime.js` 用**同一份** `checkGroundedAnswer` 在服务端再判一次，命中即降级并如实写 `validation{...}`（只加字段）。`npm run test:unit` **1051/1051**；新判据 `tests/roco-server-side-guard.test.js` **4/4**；轨迹摘要 `verdict:true`；**真跑反证**：短路 `ungrounded` ⇒ 判据当场红 |
| 2 | **模型三档分工规划** | `docs/roadmap/MODEL-ROUTING-PLAN.md`（295 行）：规则算事 / 4B 说话快（≤500ms）/ DeepSeek 说得好（≤2500ms 可选段）/ 27B 只离线；建议新起 RC-901（三档路由与降级链）、RC-902（配队解释的 3 秒增量段） |
| 3 | **配队评估延迟实测** | `reports/roco/team-serving/latency-live-2026-09-25.json`：`stage=first` 中位 **10.99ms**、`stage=full` 中位 **12.18ms**（各 5 次）。⇒ 3 秒预算**几乎全留给 LLM 解释段**（RC-306 的 `first≤300ms / full≤3000ms` 合同不变） |
| 4 | **模型面板诚实性** | 面板新增 `wired` + `wired_evidence`：4B=true（调用点 `src/coach/local-model.js`）、**27B=false**（全仓无调用路径，只有一处 `stat`）。新判据 `tests/roco-model-wiring-honesty.test.js` **2/2**，其中一条是**结构守卫**：将来真有人给 27B 接线，它会红，逼着改标签 |
| 5 | **真云臂评测（真 key，49 例）** | `node scripts/eval-live-s04.js` → 产物 `reports/live-model-eval.json`：执行 **49/0**；参数 **5/5**、证据 **5/5**、一致性 **47/49**、stale **1/1**；token（API 侧）input **104 926** / output **2 432** |

## 二、云臂「工具选择 33/49 = 0.673」到底说明什么（重要，别读成模型弱）

16 条失败里 **15 条**是「期望调用工具、实际没调」。逐条查证后，**这是评测期望与产品提示的口径冲突**：

- 用例的 `why`：「当前血量与能量是实时局面事实，需要读局面」（`scripts/eval-live-s04.js:139-149`，`cat1-needs-lookup`，期望 `calls:[1,1]`）；
- 而 `buildContext`（`src/coach/runtime.js:23`）把**整份局面**都放进 receipts：`battle:{player:structuredClone(...), enemy:structuredClone(...)}`
  ⇒ **血量 / 能量 / 道具 / 合法行动本来就在上下文里**；
- 而 planner 提示逐字写着「**默认是停止**……不需要调用的情况：……以及**任何你已经能从 receipts 答出来的问题**」；
- 旁证：这些用例的回答里**引用了正确事实**（c01「55/132 血，2 豆能量」、c02「药水2、净化2、充能2」）⇒ 它是**照提示做**。

**两条出路（不许偷偷选一边，已记档等人类拍板）**
- **（甲）产品口径 = 必须查证**：实时状态一律走工具（receipts 不预装实时状态，或提示改成「实时状态必须查」）。代价：每次多一轮往返（实测每例 0.4–2.1s）。
- **（乙）产品口径 = 不浪费调用**（现状提示）：把 `cat1` 的期望按「事实在不在 receipts 里」二分 ——
  「不在」必须调（保持红），「已在」调用可选、但**答案的数字必须被证据守住**（今天已由新的服务端守卫覆盖 ⇒ 是**加严**不是放松）。

## 三、本轮踩到并修掉的真缺陷（顺手，非计划）

- **新局会自己走一手**：`src/client/roco.js` 的 `startBattle()` 没清上一局的补位定时器
  （对手补位挂的 420ms `foeReplaceTimer`）⇒ 上一局刚进过补位就开新局时，那个定时器对新局调了一次 `autoTurn()`。
  表现之一就是门禁 `demo-acceptance` 的「同一批输入两遍逐字节相同」偶发红（唯一差异 =
  局面 `08-switch-low-hp-mid` 的 `battle_inputs.turn` 两遍 1/2）。已修 + 两条新判据（含必红反证），`demo-acceptance` **123/0**。

## 四、可复算命令

```bash
# 云臂评测（真 key；服务需在跑）
DEEPSEEK_API_KEY="$(security find-generic-password -s pet-coach-deepseek -a "$USER" -w)" node src/server/index.js &   # 或 ./scripts/start.sh
node scripts/eval-live-s04.js                       # 产物 reports/live-model-eval.json
# 配队评估延迟
curl -s -o /dev/null -w '%{time_total}\n' "http://127.0.0.1:8765/api/roco/workshop?selected=own-0001,own-0002,own-0003,own-0004,own-0005,own-0006&stage=first"
# 服务端守卫 / 面板诚实性
node --test tests/roco-server-side-guard.test.js tests/roco-model-wiring-honesty.test.js
# 全量门禁（约 25 分钟，必须在冻结树上跑）
node scripts/roco/verify-release.mjs
```

## 五、待人类一句话

1. 云臂「工具选择」那条口径：选（甲）必须查证，还是（乙）不浪费调用 + 数字必须被守卫守住？
2. 愿力强化「不占行动」的引擎通道已在做（自由动作 + 解除语义 + 3 回合冷却）。
3. 换招基准（引擎 loadout 是否为规范四技能）以子代理的核验结论为准，落地前会再报一次。
