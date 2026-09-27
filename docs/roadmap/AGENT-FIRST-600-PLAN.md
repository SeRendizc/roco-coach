# agent-first：600 只精灵 · 以 agent 为重心（2026-09-25 人类方向）

> 人类口径逐字：「我希望模拟的是**600 只精灵数据量很大机制很复杂**的情况，**尽可能不要只依赖脚本计算和预制数据，
> 更多依赖模型和 agent 本身**，当然可以结合，以及**加上 RAG 等**，但是**依旧重心在 agent 上不在游戏系统**。」
> 另：「最近 agentic JEV 和 JEV 很火，你可以看看是否有用」（见 §6）。
> 本文件是**方向与验收设计**；状态与实测进 `DSH-EXECUTION-STATE.md`。

---

## 1. 这句话在否定什么、要求什么

| | 现状（游戏系重心） | 要求（agent 系重心） |
|---|---|---|
| 复杂度从哪来 | 预制的推算产物把复杂度**提前算完**：`on-demand-builds.json`（574 只推算配招）、`support-matrix`（48 只规范配招）、`meta-prior`、候选 Beam、五轴比较 | 复杂度**留在运行时**，由 agent 用工具 + RAG 现场解决 |
| LLM 的角色 | 只解释（plan/generate 两段），决策全在规则里 | **决策也由 agent 做**（该查什么、查哪只、怎么比、要不要再查一次） |
| 加一只新精灵 | 要跑生成器、补产物、过一遍判据 | **不用改代码**：RAG 里能查到、工具能核验即可 |
| 判据 | 产物逐字节一致（强，但锁死了「预制」这条路） | 仍然逐字节一致的只有**引擎与事实**；agent 侧改为**指标 + 预注册用例** |

**红线不动**：伤害/胜负/合法性**永远由 Python 规则引擎算**；LLM 只解释与调度；不造胜率/概率/百分数；
未知一律 fail closed；`data/roco/normalized/**` 不进不必要的改动。

---

## 2. 现状盘点（哪些已经是 agent 的、哪些还是预制）

**已经是 agent 的**（可直接放大）
- `src/coach/runtime.js::gatherAgentEvidence`：唯一真 agent 循环（政策首枪 → 每轮喂回执 → 3 步上限 → **2026-09-25 起允许一次纠错**）；
- 工具面 `src/coach/toolbox.js` 的 `TOOL_CONTRACTS`（read_state / compare_actions / simulate_branch / search_rules / read_evidence / read_match / inspect_training …）；
- RAG：`src/coach/rag-index.js`（1678 文档）+ `data/roco/rag/heldout-queries.json`（45 条 held-out + 13 探针）；
- 云臂：`/api/coach`（planner 160tok/2500ms + generate 320tok/8000ms）；**服务端事实守卫** `validation`（2026-09-25 补齐）；
- 预注册评测：`scripts/eval-live-s04.js`（49 例，四类）+ 离线录制回放门禁 `src/coach/cloud-replay.mjs`（2026-09-25 新增）。

**还是预制的**（要逐步让 agent 接手）
- `data/roco/derived/on-demand-builds.json`：**574 只的配招是推算出来的表**（而且已发现过期）；
- `data/roco/owned/owned-pets.json` 的 48 只四技能：现在逐位等于引擎 loadout（**启发式**，台账无配招证据）；
- `roster-48.json` / `support-matrix.json`：冻结快照（**不许动**，但可以「只作为已知基线」而不是唯一入口）；
- `meta-prior`：体系先验（`available:false` 占多数）；
- 候选生成/五轴比较：规则启发式（`team-candidates.mjs` / `team-compare.mjs`）。

---

## 3. 目标形态：一只 agent 面对 600 只

**一次真实提问**（例：「我有这 6 只，想练一只能抗龙系的，配哪四招？」）应当这样被解决：

```
玩家提问
  → agent 决定查什么（planner：needs_tool? which_tool?）           ← 可换 Jev / 4B 做这一步（§6）
  → 工具：search_catalog(属性=龙/抗性)      ← 全量 622，**现场查**，不查预制表
  → 工具：read_learnset(species)            ← 冻结 learnsets（只读）
  → 工具：check_legality(species, skills)   ← **引擎**回答「这四招合法吗」
  → RAG：拉这几只的特性/技能描述卡片（解释用，不产生数字）
  → 工具：simulate_branch(...)              ← 需要比较时，**引擎**算结果
  → 服务端守卫：正文里每个数字必须可追溯    ← 已实装（validation）
  → 输出：结论 + 依据 + 不确定性（不知道就弃答）
```

**分工原则（写死，别漂）**
1. **数**由引擎算（伤害/胜负/合法性/回合顺序）；
2. **文**由 RAG 给（技能/特性/描述），检索不到就说不知道；
3. **决策**由 agent 做（查什么、比什么、够不够、要不要再查）；
4. **守**在服务端（数字白名单 + 引用 + 拒答），不通过就降级成规则结论。

---

## 4. 需要新增的能力（按优先级，每条带判据）

| # | 能力 | 落点 | 判据（+ 必红反证） |
|---|---|---|---|
| P0-a | **工具面覆盖全量 600+**：`search_catalog` / `read_learnset` / `check_legality` 三个只读工具。**进度（2026-09-25）**：`search_catalog` 这一半**已接** —— 引擎新增 `kind:"catalog"`（`element`/`resist`/`weak`/`beats` 四筛法 + 分页），教练新政策 `catalog-ask`，真机实测「我想练一只抗龙系的伙伴」从 **0 次工具** 变成查引擎并本地成句（38 只，0 次模型调用）。`read_learnset` 已由 `query_rules{kind:'learnset'}` 覆盖（走引擎学习表）；`check_legality` **也已接**（同日第二轮）：引擎 `kind:"legality"` 逐招对照学习表三列（native/blood/stones），`legal` 三态（true/false/**null**=有技能认不出来）；教练政策 `legality-ask`，真机实测「小翼龙带抓挠、震击合法吗？」→ 逐招点名 + 出处 + 0 次模型调用。**P0-a 三个工具面完成**。 | `src/coach/toolbox.js` + 服务端路由（复用既有 `/api/roco/box`、`/api/roco/roster?support=all`） | 对任意物种都能给出「属性/学习表/合法性」且与冻结数据逐字一致；反证：给一个不存在的 skill_id 必须回执「不存在」而不是猜 |
| P0-b | **RAG 覆盖全量**：把 622 只 / 824 技能 / 245 特性的描述都进语料（现在 1678 文档，需核对覆盖） | `src/coach/rag-index.js` + `eval-rag-retrieval.mjs` | held-out 45 条 + 13 探针的 R@1/MRR 不掉；**新增**「600 只里随机抽 50 只：它的技能/特性都能被检索到」；反证：删掉某只的描述必须红 |
| P1-a | **agent 决策链**：把「练哪只/配哪四招」拆成多步工具调用（含**一次纠错**） | `gatherAgentEvidence` + planner 提示 | 预注册用例（见 §5）里「事实必须来自工具/证据」的比例；反证：把工具回执抽掉后仍给出具体数值 ⇒ 必须红 |
| P1-b | **弃答与不确定**：证据不足时明确说不知道（不许给像结论的句子） | 提示 + 守卫 | 构造「库里没有」的问题 ⇒ 必须弃答；反证：无证据给结论必须红 |
| P2 | **600 只场景评测**：把 49 例扩到覆盖全量（含冷门物种/机制） | `scripts/eval-live-s04.js` + 离线回放 | 三个率（工具选择/事实守卫/弃答正确）+ 延迟 P95；两遍逐字节（录制回放） |
| P3 | **路由与决策模型实验**：Jev / 4B 做「要不要调、调哪个」 | 见 §6 | 与云端 planner 同提示集对照（同一批预注册用例），三个率 + 延迟 + 成本 |

---

## 5. 验收指标（替代「产物逐字节」的新尺子）

1. **工具选择正确率**（现在是 **33/49 = 0.673**，且已查清其中 15 条是**口径冲突**不是模型弱 —— 见 `reports/roco/agent-line-2026-09-25/REPORT.md` §二；口径定了以后这个数才是真指标）；
2. **事实守卫通过率**（服务端 `validation.valid=true` 的比例）与**越权数字拦截数**；
3. **弃答正确率**（该弃答的弃答、不该弃答的不弃答）；
4. **延迟**：规则段 ≤300ms（实测 10.5–14.5ms）+ LLM 段 ≤2.5s（合计 ≤3s）；
5. **可复现**：云臂跑一遍录制 → 之后每次门禁**离线回放**（`cloud-replay.mjs`），
   判据 = 同指纹两遍逐字节相同 + 未命中必须抛错 + 反证（改 provider / 塞未登记数字必须红）。

---

## 6. Jev（System One / 决策模型）在我们这里的用法（调研结论）

**它是什么**：TypeSafe AI 的「System One」模型，**不生成文本**；输入 `state` + `questions`
（三类：`choice` 选项概率 / `score` 有序打分 / `noul` 是否概率），返回**类型化、可校准**的答案与置信；
官方称分类任务上比同类 LLM **快约 200×、便宜约 400×**，一次请求里问多个问题几乎不加时间。
LangChain 已提供 `TypeSafeClassifier` 与两种现成中间件：**模型路由**与**工具风险门控**。
来源：[LangChain：Building a Harness with Jev](https://www.langchain.com/blog/building-a-harness-with-jev)、
[TypeSafe：Introducing System One Models and Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)。

**对口的三处（都是**分类**决策，不是生成）**
1. **planner 的「要不要调工具 / 调哪个」**：现在是一次云端 LLM 调用（每例 0.4–2.1s）。
   Jev 形状 = `state`(玩家原话 + receipts 摘要) + `questions{needs_tool: noul, which_tool: choice}`。
   **我们已经有 ground truth（49 例预注册用例）可以直接对照**——这是最该先试的一处。
2. **模型路由（RC-901）**：三档（4B / DeepSeek / 27B）由谁选？Jev 的 `choice` 天生就是干这个的。
3. **干预门控**：`decideRegister` / `policyFor` 现在是**代码策略**（因为实测「模型该不该开口」只有 ~50% 准）。
   一个**校准过的**决策模型可能同时好于「代码阈值」与「聊天 LLM」——但必须先量，不许当结论。

**边界与成本**
- 它是**云 API**（`TYPESAFE_API_KEY`），要么申请 key，要么找**开源复现**（有报道称已有跨平台开源复现）本地跑；
- 它**只做决策**：不产生事实、不算伤害 ⇒ 与红线不冲突；但**概率不许当玩家可见的胜率**（只在内部路由/门控用，界面照旧不出现百分数）；
- 落点建议：**先只做 planner 的决策位**（可 A/B：Jev vs DeepSeek planner vs 规则政策），用一个预注册用例集对照三个率。

---

## 7. 分阶段（不打断现有工作，按文件单写者排）

1. **P0**（工具面 + RAG 覆盖）：`src/coach/toolbox.js` / `rag-index.js` 一条线；
2. **P1**（agent 决策链 + 弃答）：`src/coach/runtime.js` 一条线（A4 刚改完，接着做）；
3. **P2**（600 只评测 + 离线回放扩到全量）：`scripts/eval-live-s04.js` + `cloud-replay.mjs`；
4. **P3**（Jev / 4B 路由实验）：需要 key（Jev）或本地模型（4B，**本机已有 LoRA 适配器 v1–v3**，见 `DSH` C6.85）；
5. **反目标**：不再扩预制推算表（例如给 `on-demand-builds.json` 加更多派生字段）；它只保留「已知基线」身份。
