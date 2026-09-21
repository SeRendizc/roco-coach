# 大负载模拟与混合规划链：**设计**（不实现）

> 第 46 轮 · 只出设计与接口，**不实现**。所有阈值都必须给出**来源**：
> 有实测依据的写依据；没有的写「**无来源 → 跑之前预注册**」，不给拍脑袋的数。
>
> 现状锚点（本轮实测，用来定基线而不是定目标）：
> - 单局 3v3（48 只名单，随机双方，5 类对手策略）：**1000/1000 完赛、0 截断、0 异常**，
>   单局 **p50 13 ms / p95 29 ms**，战斗回合 **p50 24 / p95 50**（max 78），
>   `unsupported` 每局 p50 0 / p95 4 / max 18。
>   产物 `reports/roco/coverage/roster-48-smoke.json`。
> - 规划器现成旋钮：`beam=4`（上限 8）、`depth=2`（上限 3）、`budget_ms=2000`
>   —— `roco/src/roco_env/planner.py:32-36`。
> - 页面延迟预算（已有判据）：首屏 **< 1500 ms**（实测 154）、每回合渲染 **< 100 ms**（实测 p50 0.1 ms）、
>   一步往返 p50 4 ms / p95 7 ms —— `docs/roco/DEMO-PERF.md` §0、`reports/roco/demo-perf.json`。
> - 本地模型（Qwen3.5-4B-4bit）：p50 363 ms / p95 1054 ms —— `docs/roco/PROGRESS.md` W4-03。

---

## 1. 离线阵容空间：先检索 Top-K，再组合评估

### 1.1 为什么禁止暴力枚举（算个账）

| 名册规模 | 三元组数 `C(n,3)` | 本轮实测单组校验耗时 | 全枚举估计 |
|---:|---:|---|---|
| 48 | 17,296 | 全部跑完 < 1 s（`roster-48-smoke.json#team_legality`） | 可行 |
| 60 | 34,220 | 同上（`roster-60-smoke.json`） | 可行 |
| 100 | 161,700 | — | 校验可行，**评分**不可行 |
| 250 | 2,573,900 | — | 不可行 |
| 400 | 10,586,800 | — | **禁止** |
| 622 | 39,942,020 | — | **禁止** |

> 注意：**枚举合法**与**枚举后逐个精确评分**是两件事。上面 48/60 的「可行」指的是
> `validate_team`（`data.py:239-241` 的可学性 + 3 只不重复），不是指把 34,220 组都做终局模拟。

### 1.2 检索层设计

```text
输入：候选名册 P（|P| = 100 / 250 / 400+）
锚点：anchor ∈ {role × primary_type × speed_tier}  ← 与「精确层」特征集**不相交**
第 1 步  对每个 anchor a，取满足 a 的精灵按 (pool_size, stat_total, pet_id) 排序，取前 K → S_a
第 2 步  候选三元组 = ∪_a { t : t ⊆ S_a, |t| = 3 }   ← 只在 S_a 内组合，不做全局组合
第 3 步  去重 + `validate_team` 过滤（非法直接丢，不修）
第 4 步  对候选三元组做精确层评分（规则特征 6 项 / 或 learned value）
第 5 步  输出 Top-N 推荐 + 每个推荐的可解释分项
```

**K 怎么定（不许拍脑袋）**

`K` 由**召回率目标**反推，而不是先选一个数：

1. **地面真值只能在小子集上精确算**。用 60 只池（`C(60,3)=34220` 全合法，已有实测）
   把 34,220 组按精确层评分**全排序**，取 Top-100 作为 `G_60`。
2. 在同一 60 只池上跑检索层（anchor 只用 role/type/speed，**不用**精确层的伤害/能量/缺口特征），
   得到候选集 `R_60(K)`。
3. `recall(K) = |R_60(K) ∩ G_60| / 100`。取满足 `recall ≥ R*` 的**最小 K**。
4. **`R*` 必须在测量之前预注册**（做法照 `docs/roco/W4-04-SFT-PREREGISTRATION.md`：
   判据写死在跑之前，跑完不许改）。建议预注册 `R* = 0.95`，理由是检索在这里的作用是
   **缩小搜索空间**而不是替代精确层，漏掉的 Top-100 由精确层在候选池内补；
   0.95 这个值本身**没有游戏机制依据**，所以必须作为「产品参数 + 预注册」对待，不是事实。
5. **规模外推只能在子池上验证**：在 40 / 50 / 60 三档子池上分别测 `recall(K)`，
   若三档曲线在 K 上是稳定的（互差 ≤ 0.03），才允许把 K 用到 100/250/400；
   否则按子池规模**线性放大 K** 并重新预注册。
6. **反作弊检查（必做）**：检索层与精确层必须使用**不相交的特征集**。
   若把精确层的伤害/能量特征也塞进检索层，`recall` 会虚高到接近 1，K 会失去意义。
   验证方式：把精确层特征逐个加进检索层，测 `recall(K)` 的抬升；
   抬升 > 0.05 即判检索层与精确层**耦合**，设计作废重做。

**检索层 vs 精确层的对照口径（三条，缺一不可）**

| 对照 | 量什么 | 判据 |
|---|---|---|
| 召回 | `recall@K`（Top-100 交集 / 100） | 预注册的 `R*` |
| 序 | 候选集内 `Spearman ρ`（检索分 vs 精确分） | **只报不判**：检索分与精确分不可比，ρ 用来发现「检索层其实在优化另一个目标」 |
| 代价 | 候选三元组数、`validate_team` 调用数、精确评分次数、端到端耗时 P50/P95 | 候选数必须 `≪ C(n,3)`；`n=400` 时候选数 ≤ 5,000（无来源 → 预注册） |

> **不比较胜率**。任何「检索层赢了多少局」的说法都建立在本轮已判定为未核验的伤害公式上。
> 这一节只回答「检索层找回来的候选，和精确层自己找的是不是同一批」。

### 1.3 接口草图

```python
# roco/src/roco_env/retrieval.py（设计，不实现）
def anchors(rs, pool: Sequence[str]) -> List[Anchor]:
    """anchor = (role, primary_type, speed_tier)；role/tier 规则见 docs/roco/COVERAGE-LAYERS.md §4.2。"""

def retrieve_candidates(rs, pool, *, k: int, anchors=None) -> Retrieved:
    """返回 {candidates: List[Tuple[str,str,str]], stats: {anchors, union_size, triples}}。
    只用 role/type/speed 三个 bucket 字段，**不读** team.py 的评分特征。"""

def evaluate_candidates(rs, candidates, *, loadouts, scorer) -> List[Ranked]:
    """scorer ∈ {rule_features(team.py), learned_value(未开工)}；返回带分项的解释。"""

def recall_protocol(rs, pool, *, k, ground_truth: List) -> RecallReport:
    """只在小池上跑：recall@K、ρ、候选数、耗时。"""
```

---

## 2. 在线 3v3：只用双方已知的 6 只

### 2.1 信息边界

| 允许 | 不允许 | 现状 |
|---|---|---|
| 双方各 6 只的**公开**字段（真名/属性/六维/已公开技能） | 对手未执行的行动、真实 seed、对手私有状态、对手备战席细节 | `public_planner_state`（`env.py:893`）只吐公开字段；隐藏键清单 `data/roco/hidden-keys.json`（由 `scripts/roco/export-hidden-keys.py` 从 `service.py` 导出） |
| 合法技能 / 换宠 / 道具 / 撤离 | 学习表全池（那不等于这场带得上） | `legal_actions` 按**配招**枚举（`env.py:178-188`） |

**已有守卫（可复核）**：`roco/tests/test_public_planner.py`
—— schema 不带 seed/pending/备战席细节、`find_hidden_keys` 正反两向、
「公开状态在内部 seed 变化下逐字段相同」、「推荐在内部 seed 变化下相同」。
另有 60 局 observation 泄漏扫描（`roco/tests/test_replay_invariants.py`）。

### 2.2 搜索预算

`beam=4 / depth=2 / budget_ms=2000` 继续（`planner.py:32-36`），上限 `beam=8 / depth=3`。
超时**如实上报**（`planner.py:540` 的 `clock()-start > budget_s`），不假装搜完。

### 2.3 要量什么

| 指标 | 定义 | 判据 / 来源 |
|---|---|---|
| 决策延迟 P50/P95 | 一次 `plan_actions` 的墙钟 | **P95 < 100 ms**（来源：`docs/roco/DEMO-PERF.md` 的「每回合渲染 < 100 ms」是同一条交互预算；实测一步往返 p50 4 ms / p95 7 ms，余量充足） |
| 超时覆盖率 | ① 触发 budget 的决策比例；② `reached_depth < 请求 depth` 的比例；③ 超时后仍返回可用推荐的比例 | ①②**预注册**（无来源）；③ 现状：`planner` 超时仍返回最佳已知分支，需实测确认「可用」定义 |
| 非法动作率 | `step_joint` 抛错 / `legal_actions` 外动作 | **必须 = 0**（来源：`reports/roco/pilot-1000/` 已实测 1000 局非法 0、截断 0、异常 0） |
| 完赛率 | 未截断且无异常的局比例 | 本轮 48 只 1000 局 **1.0**；压测时不得低于这个基线 |
| 搜索深度分布 | `depth_searched` 直方图 | 只报不判 |

---

## 3. 隐藏阵容：belief 采样，且 planner **不许**读未知信息

### 3.1 采样设计

```text
未知量 U = 对手 6 只里「哪 3 只首发/后手」+ 每只的 4 技能 + 对手策略
belief b(U) = 对手池先验 × 公开观测量（已出场精灵、已用技能、已用换宠）
              ← 已公开的部分是**条件**，不是采样对象
采样 M 个假设 h_1..h_M ~ b(U)      M 由 §4 的延迟预算反推
规划目标 = 对混合对手的稳健目标：max_a min_m  score(a | h_m)  或 max_a E_m[score(a|h_m)]
                （两种都跑，报告两者推荐差异；差异大说明目标函数本身不稳）
```

**对手池先验**来自已有资产：`roco/src/roco_env/opponents.py` 的 5 条策略
（`random_legal` / `greedy_damage` / `conservative_switch` / `status_control` / `shallow_search`）
+ `data/roco/lineup-legality.jsonl` 的 169 套真实阵容台账
（**注意**：其中 **0 套可原样执行**——名册只有 12 只、140/169 来自 2026-04 早于 S4，
见 `docs/roco/LINEUP-LEGALITY.md`，所以它只能当**先验形状**，不能当可直接跑的阵容）。

### 3.2 「planner 不许读未知信息」怎么**反证**

三条独立反证，缺一条不算：

1. **同一公开状态、不同隐藏状态 → 推荐必须逐字相同。**
   固定 public state，用 3 组不同的隐藏（对手备战席/未执行动作/seed）各跑一次，
   断言三次推荐的 `action` 与 `score` 逐字段一致。
   *反证输入（必红）*：把对手未执行动作塞进 planner 输入 → 上述断言必须失败；
   若仍通过，说明这条守卫是空的。
2. **隐藏键扫描在两个方向都要对。**
   正向：干净的公开载荷 `find_hidden_keys(...) == []`；
   反向：含 `pending_enemy_action` / `seed` 的载荷必须被点到
   （`roco/tests/test_public_planner.py:76-88` 已实现这个形状）。
3. **跨语言镜像一致。**
   `data/roco/hidden-keys.json` 是唯一事实来源，Node 桥与浏览器工具层从它派生；
   `tests/evals/roco/plan-e2e.test.js` 对三份词表做跨文件比对。
   *反证*：只改 Python 侧的词表而不改 JSON → 该测试必须红。

---

## 4. 压测矩阵

### 4.1 矩阵

| 轴 | 取值 | 格子数 |
|---|---|---:|
| 可检索名册 | 100 / 250 / 400+（+ 现有 48/60 作对照） | 3–5 |
| 可模拟池 | 24 / 48 / 60+ | 3 |
| 对手策略 | `random_legal` / `greedy_damage` / `conservative_switch` / `status_control` / `shallow_search` | 5 |
| 局数 | **≥ 10,000** | — |

> 本轮**没有**跑这个矩阵（只跑 1000 局冒烟 ×2）。冒烟的价值是给出**基线**：
> 单局 p50 13 ms → 10,000 局的理论墙钟 ≈ 130 s（单进程、无并行）；
> 加上检索与精确评分后要重新量，不许用这个数当结论。

### 4.2 指标、判据与**阈值来源**

| 指标 | 判据 | 阈值来源 |
|---|---|---|
| 吞吐（局/s、决策/s） | 只报不判 | 无来源。给机器规格（CPU/内存/Python 版本）一起报，换机器就作废 |
| 决策延迟 P50/P95 | **P95 < 100 ms** | `docs/roco/DEMO-PERF.md` §0 的「每回合渲染 < 100 ms」交互预算；实测基线 p95 7 ms |
| 单局耗时 P50/P95 | 只报不判 | 无来源。它随对手策略与回合数变化，不是质量指标 |
| 超时率（budget 触发） | **depth=2 时 = 0；depth=3 时 ≤ 1%** | **预注册**（无来源）。预注册必须写：机器规格、预算值、depth/beam、种子集 |
| 非法动作率 | **= 0** | `reports/roco/pilot-1000/`（1000 局非法 0/截断 0/异常 0）+ 本轮 1000 局 0 |
| 完赛率（未截断且无异常） | **= 1.0** | 本轮 2000 局（48 与 60 各 1000）实测 1.0 |
| unsupported 率 | **只报不判，禁止设上限** | 理由：设上限会激励实现者把 unsupported 藏起来——那正是「未核验机制 fail closed」要防的事。报告口径：每局条数 P50/P95/max + 按 `what` 分类 |
| 推荐稳定性 | **只报不判**，但必须与「深度 +1 翻转率」一起报 | 已有实测：深度 +1 后推荐 **44% 会翻**（`docs/roco/W5-04-ADJUDICATION.md`）。这是**负结论基线**，不能当成「稳定性通过」 |
| 正确性（对局结果） | 只在**配对协议**下报 | `docs/roco/BENCHMARKS.md` §2：旧协议（80 对 40 + 区间重叠当差异检验）已判定 INVALID；新协议要求**两座位样本数相等 + 配对检验** |

> **每条指标必须在跑之前落一份预注册文件**（形状照 `docs/roco/W4-04-SFT-PREREGISTRATION.md`：
> 判据、口径、种子集、机器规格、回滚开关全写死），跑完只许补充结果，不许改判据。

---

## 5. 混合规划链：四臂对照

### 5.1 一条请求的数据流

```text
公开局面 public_state（env.public_planner_state）
   │
   ├─(1) LLM 提议：战术意图 + 候选动作（可含换宠）+ 对手假设      ← 只输出「意图/候选/假设」
   │        约束：JSON schema；不许输出伤害数值
   │
   ├─(2) legal mask：候选 ∩ legal_actions(state)                  ← 非法候选直接丢弃并计数
   │
   ├─(3) 引擎真实转移：env.step_joint / rollout（唯一状态来源）
   │
   ├─(4) learned value 评叶节点（W6-01，未开工；在此之前用现有 rule evaluate）
   │
   └─(5) beam/MCTS 比长期分支 → 推荐 + 回执 → LLM 依**回执**解释（不许自己算数）
```

**硬约束**：LLM 的输出**永不**直接成为动作。它进 (2) 之前只是候选；
(3)(4)(5) 里没有任何 LLM 调用；解释阶段只能引用回执里的字段。

### 5.2 四臂

| 臂 | LLM 的作用 | 决策来源 | 证明什么 |
|---|---|---|---|
| `rule-only` | 无 | `planner.plan_actions`（beam/depth/timeout） | 基线。已有三把尺子（`docs/roco/BENCHMARKS.md`）：top1 0.59（一步推演口径）、整局胜负量具**已作废**、`expected` 与胜负**不显著**（Welch t=0.873） |
| `LLM-only`（**仅负对照**） | 直接给动作 | LLM 输出，**不过** legal mask | 证明「合法掩码 + 引擎转移」不是装饰：预期非法率显著 > 0。**只用来说明组件必要，绝不作产品路径** |
| `engine+value` | 无 | 引擎转移 + learned value 评叶 + beam | 证明「值函数」相对 `rule-only` 的增益；必须与 `rule-only` 在**同一批种子**上配对 |
| `LLM-prior+engine+value` | 提意图/候选/对手假设 | (1)→(2)→(3)→(4)→(5) | 证明「LLM 先验」在**候选召回**上的增益（而不是在最终正确率上的增益）；同时必须有 (2) 的非法丢弃计数 |

### 5.3 报告口径（每臂都要给）

| 项 | 定义 | 判据 |
|---|---|---|
| 正确性 | 与 `rule-only` 在**同一批种子**上的配对比较 | 必须报「退化 / 扳回」逐条计数（照 W4-02 的做法），不是只报均值 |
| 非法率 | 被 legal mask 丢弃的候选 / 总候选（`LLM-only` 臂则是不合法动作 / 总动作） | `LLM-only` 预期 > 0；其余三臂**必须 = 0**（掩码后） |
| 延迟 | P50/P95（LLM 段与引擎段分开报） | LLM 段参考本地模型实测 p50 363 ms / p95 1054 ms（`W4-03`）；引擎段参考 p95 < 100 ms（§2.3） |
| 长期回报 | **配对**对局胜负，两座位样本数相等 | `docs/roco/BENCHMARKS.md` §2 的修正协议 |
| 回滚 | 开关默认 `off`，`off` 下不加载模型 | 照 `src/coach/intervention-model.js` 的既有形状（默认 off、off 下不加载） |

### 5.4 接口草图

```ts
// ① LLM 提议（唯一允许 LLM 出现的阶段）
type Proposal = {
  intent: string;                       // 战术意图，自然语言，用于解释
  candidates: Array<{ kind: 'skill'|'switch'|'item'; skill_id?: string; target_index?: number; why: string }>;
  opponent_hypotheses: Array<{ note: string; public_evidence: string[] }>;  // 必须引用公开字段
};
// 校验：JSON schema + 「不得包含数值型伤害/概率」+ 「public_evidence 必须能在 public_state 里找到」

// ② legal mask
type Masked = { kept: Candidate[]; dropped: Array<{ c: Candidate; reason: 'not_in_legal_actions' }> };

// ③–⑤ 引擎 + 值 + 搜索
type PlanRequest = {
  public_state: unknown;                // env.public_planner_state 的输出，**不含**隐藏键
  depth: number; beam: number; budget_ms: number;
  prior?: Proposal;                     // 只有第 4 臂给
  value: 'rule' | 'learned';
};
type PlanResult = {
  action: Action; score: number;        // score 的来源必须写清（rule_features / learned / mixture）
  reached_depth: number; branches: number; elapsed_ms: number;
  used_prior: boolean; masked_dropped: number;
  assumptions: string[];                // 「未核验」逐条透出
};
```

---

## 6. 与「不许自行设计机制」的关系

- 环境要素只做**有手游证据**的机制。本轮名单里没有天气/场地；
  `parse.py:89` 能认出「将天气改为X」但 `env.py:683-684` 拒绝结算——
  正确做法是继续拒绝并登记，**不是**补一个天气层。
- 机制交叉（例如「印记 × 换宠 × 应对」）与 OOD 切分**只能在有证据的机制之间**做；
  没有证据的组合只能进「待实测」清单，不进压测矩阵的判据。
- 压测里任何「机制覆盖率」都只是**描述统计**，不能当通过条件。
