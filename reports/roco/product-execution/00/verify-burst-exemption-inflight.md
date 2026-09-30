# 迸发豁免（钉子 306 → 309）· 独立复验：**在飞快照**（harness-verifier）

> ⚠ **性质声明**：本文件记录的是 **在飞快照**（`coverage.py = 0c3ae80be4789edf`）。Lead 随后告知
> 该文件在其后又被改过（`e3e33009…`）⇒ **不得当权威读数**。权威读数以 D-8 切片
> `59e55df2fa1a32d18ceb816f591e06ee82b18ed1` 的整仓副本复验为准
> （见 `harness/verify-slice-59e55df.txt`）。本文件保留的价值：**口径与守卫读数**，以及两条
> Lead 点名要留档的细节。

---

## 1 · 在飞快照读数（`scripts/roco/verify-burst-skills.py --runtime`）

```
BURST_SKILLS 7
TIER_SUMMARY 313=SIM · 581=SIM · 584=SIM · 583=PARTIAL · 587=PARTIAL · 598=PARTIAL · 607=PARTIAL
CTL power_type_bonus_applied        ['313','581','584']        ← 正控件：夹具真量到迸发加成
CTL non_power_type_still_unresolved ['583','587','598','607']  ← 反控件：没有被顺带放行
CTL non_power_type_wrongly_resolved []                          ← 必须为空，实测为空
totals 309 · union_mismatches 0 · GATES_OFF_MISMATCHES 5（同组 412/510/539/671/694）
CONTROL_FLIPS 23（改前 25）
```

逐条运行时报据（我这边独立取到，非引用实现者）：
`313 60→90（"迸发 → 威力 +30.0"）` · `581 80→120（+40.0）` · `584 35→55（+20.0）`。

逐行台账 vs `rc401` 的 **306** 钉：`翻正 = 313 / 581 / 762` · `翻负 = 0` · `同带内变更 = 684`
⇒ `306 + 3 = 309`，账自洽（`584` 由改前的「翻负」回到与基线一致）。

## 2 · Lead 点名要留档的两条

### 2.1 「有威力变化 ≠ 该放行」：`587 雷暴`

```
587 雷暴  desc=造成魔伤，迸发：本技能获得所有生效过的迸发，每获得1种，本技能能耗+1，威力+10。
          tier=PARTIAL · resolved=False · settled=['伤害']
          真打一手 power_used 55 → 65（conditional_reason="迸发 → 威力 +10.0"）
```

- 它的迸发子句**自带**「威力+10」，所以运行时**确实**有威力变化 —— 但**另有残余缺口**
  （「获得所有生效过的迸发」「每获得1种，能耗+1」都没有实现）⇒ **仍判 PARTIAL 是对的**。
- ⇒ 判据不能建立在「有没有威力变化」上，只能建立在「**整条子句**是否都有产出」上。
  `583 超导`（能耗-2）/`598 双联脉冲`（使用次数+1）是真·零产出；`607 踏雷`没有静态威力
  ⇒ 豁免的形状守卫（`has_static_power`）把它们挡住。
- ⚠ 探针第一版把「非威力型却 `power_used` 非 0」当异常 —— 那是**我的期望写错**（`587` 本来就会加威力）。
  已改成「非威力型的迸发行**是否仍判未结算**」这一条真正想问的控件，并在代码注释里写明原因。

### 2.2 `CONTROL_FLIPS` 25 → 23：数字与「控件仍非 0」一起留档

```
改前（2e30a4f 之前的状态）: CONTROL_FLIPS 25
改后（本次在飞快照）      : CONTROL_FLIPS 23
```

- **解释（已登记为预期）**：`CONTROL_FLIPS` = 关掉 `respond_clause_gaps` + `UNSETTLED_WORDS` 后
  `resolved` **翻正**的技能数。`313/581/584` 三行在豁免后**本来就已结算**，不再参与「关闸后翻正」
  ⇒ 少 2 条（另外 1 条的差来自 `587` 的 `unsettled` 集合变化）是**预期下降**。
- **关键：控件仍非 0（23）** ⇒ 这次 monkeypatch **不是空转**、度量不恒 0；反证判据
  `GATES_OFF_MISMATCHES = 5` 也仍然成立（同组 id）⇒ 豁免没有把那条判据变成假绿。

## 3 · 我的探针期望修正（Lead 裁定后复核：**同意，是我的期望写错**）

| 我的第一版期望 | 实际契约 | 处置 |
|---|---|---|
| 事件里应有 `event_seq` 键 / 回执顶层应有 `event_seq` | `event_seq` 是**每个事件行上的 `seq`**，由 `_sim_envelope` 统一加；顶层没有这个键 | 已改：改查信封行的 `seq` 是否等于它在 `state.events` 里的下标（浅探针 + 深探针 D2b 都过） |
| 回执里的预览事件应在 `result.events` 里 | 在 **`result.opening_reveal`**；`battle_new` 一跳没有新增事件行，`result.events` 是空数组（按设计） | 已改：回执侧取 `opening_reveal`，与 `state.events` 比 `kind/turn/detail` 实质载荷（`same_source=True`，回执只多 `seq`/`text` 两个信封键） |
| 浅探针不请求 `opening_preview` 却把 `opening_roster_revealed` 记为「尚未实现」 | 预览事件**只在显式请求时产生** | 已改：浅探针默认带 `opening_preview: true`，并新增 `--no-preview` 模式；标签改成 `ABSENT/NOT-REQUESTED` |

修正后两种模式均 `CONTRACT_FAILS 0`：
- 请求预览：`C6 kinds receipt=['opening_roster_revealed'] state=['opening_roster_revealed']` ·
  `same_source(kind/turn/detail)=True` · `receipt_extra_keys=['seq','text']` ·
  `preview_skill_ids=[]` · `forbidden_keys=[]`；后备带身份（**预期**，已亮明）。
- 不请求：`C6 kinds receipt=[] state=[]` · `receipt_opening_reveal=absent` ·
  `C7 preview_emitted=False bench_identity_free=True bench_keys=['fainted','slot']`。

> 探针自身缺陷我记两条：**「选择性抽取漏 docs」（见 `harness/verify-slice-2e30a4f.txt` 首跑）** 与
> **上面两条契约期望**。都在我的写域内改完并留了注释；实现者这两处没有问题。
