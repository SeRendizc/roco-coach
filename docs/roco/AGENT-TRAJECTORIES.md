# Agent 工具轨迹集 v1（W4-02 / W4-05）

这份文档只讲一件事：**这 4,536 条工具轨迹凭什么能当门禁用**，以及它现在还不能
声称什么。

生成器 `scripts/roco/build-agent-trajectories.mjs`，判定器与回放
`scripts/roco/verify-agent-trajectories.mjs`，格式与 arm 定义在
`scripts/roco/agent-trajectories.mjs`。产物：

| 文件 | 内容 | 是否入库 |
|---|---|---|
| `tests/evals/agent-trajectories-v1.jsonl` | 头部 + 4,536 条轨迹（5.6 MB） | 是（字节可复现） |
| `tests/evals/agent-trajectories-v1.manifest.json` | 按 arm / 类别分解的汇总 | 是 |
| `reports/roco/agent-trajectories-verification.json` | 本轮判定与回放报告 | 是 |

## 1. 一条轨迹长什么样

```json
{
  "traj_id": "rl-pet-f0-01@camp-0#baseline",
  "case_id": "rl-pet-f0-01", "category": "rules_lookup",
  "arm": "baseline", "arm_kind": "baseline",
  "split": {"family": "...", "mechanism": "...", "template": "...", "side": "test"},
  "input": {
    "message": "寂灭龙骨的种族值是多少？",
    "mode": "camp", "screen": "camp",
    "world": {"id": "camp-0", "seed": 11, "turns": 0,
              "ruleset_id": "roco-world-s4-2026-09-10",
              "state_version": 0, "state_version_authority": 0},
    "public_state_digest": "…"
  },
  "trace": [{"tool": "query_rules", "args": {...}, "chosen_by": "baseline",
             "receipt": {"ok": true, "digest": "…", "bytes": 750, "evidence_ids": [...]}}],
  "stopped": "complete",
  "reply": "寂灭骨龙是龙系、幽系，种族值总和 552。",
  "engine_refused": false,
  "checks": {"passed": true, "violations": [], "items": {...}}
}
```

几个刻意的选择：

- **回执只存摘要，不存全文。** 单条回执上限 10 KB，4,500 条全文就是几十 MB。
  摘要是规范化后的哈希（键序无关、**剔除延迟**），回放时逐条比对——
  延迟每次都不同，算进摘要只会让回放永远「变了」。
- **不存生成时间、不存 HEAD。** 产物要能字节复现；已用两次连跑逐字节比对确认。
  第一次实现把 `bytes` 算在含延迟的全文上，两次跑差 1 字节——所以
  `bytes` 现在也基于剔除延迟后的规范化对象。
- **失败原样保留。** `stopped` 记明 `invalid-arguments` / `repeated-tool` /
  `receipt-budget` / `planner-error:*`。把失败洗成成功的第一步就是丢掉这个字段。
- **正文只用回执里真的出现过的字段生成。** 宠物名、属性、种族值总和、阵容特征分、
  规划器推荐标签、引擎写下的 `limitations`——一个数字都不从任务期望里抄。

## 2. 局面（world）与任务的匹配

世界来自引擎本身（`scripts/roco/gen-plan-state.py <seed> --turns N --version V`），
不是手抄的 fixture。当前 12 个世界、8 个模板：

| 世界 | 模式 | 特殊条件 | 变体数 |
|---|---|---|---|
| `camp-0/1/2` | 营地 | — | 3 |
| `camp-locked` | 营地 | 锁定伙伴 | 1 |
| `camp-conflict` | 营地 | **来源冲突** | 1 |
| `battle-open-0/1` | 对局 | 伤害未核验 | 2 |
| `battle-mid-0/1` | 对局 | 伤害未核验，第 3/4 回合 | 2 |
| `battle-late` | 对局 | 第 8 回合 | 1 |
| `battle-refuse` | 对局 | 强制失败 + 伤害未核验 | 1 |
| `battle-stale` | 对局 | 版本推进过 | 1 |

两条匹配规则，缺一条测出来的就是运气：

1. **任务需要的特殊条件必须在**（`evidence_conflict` 的任务只落在真有冲突的世界，
   `stale_state` 只落在版本推进过的世界）；
2. **任务没要求的特殊条件不能夹带**（带冲突的世界不许漏进普通任务）。

`damage` 是例外：伤害公式未核验是**所有对局世界的共同事实**，所以它既不能作为
「需要」也不能作为「夹带」——把它算进匹配条件，`stale_state` 这一类会直接消失
（没有任何世界能同时满足「需要 bumped」且「不需要 damage」）。

**来源冲突是注入的，并且明确标注。** `camp-conflict` 里的两个数值来自
`sourceConflictFor()`：一份是面板换算（`1.10*race+60`，公式未核验 MC-010），
一份是社区口径中位数。它标着 `synthetic: true` 与原因，**不代表引擎里真的存在
两份互相矛盾的来源**。这样做是为了让「把不一致说出来」这件事有可观察的依据，
而不是让 Agent 靠猜通过。

## 3. arm：谁在跑这些轨迹

| arm | 类型 | 用途 | 通过率 |
|---|---|---|---|
| `replay` | 对照 | 照任务期望重放，验证接线与判定器 | **648/648 = 1.000** |
| `baseline` | 基线 | 纯规则 baseline（只读消息 + 公开提示） | 648/648 = 1.000 |
| `blind` | 基线 | **不给期望提示**的规则 baseline，名字→id 自己查 | 624/648 = 0.963 |
| `stubborn` | 反证 | 永远拿开局那一版状态去算 | 576/648 = 0.889 |
| `drop_args` | 反证 | 丢掉队伍/状态参数 | 576/648 = 0.889 |
| `no_rules` | 反证 | 跳过规则查询 | 432/648 = 0.667 |
| `stop_now` | 反证 | 一次都不查直接答 | 360/648 = 0.556 |

`replay` 只用来当**接线自检**：连照抄期望动作都判不过，说明判定器或工具接线坏了，
不是 Agent 有问题。`baseline` 与 `blind` 的差（1.000 vs 0.963）就是
「提示里给了事实类别」这件事值多少分——全部差在 `rules_lookup`
（`blind` 只认名字表里的 7 个名字，认不出来的不猜）。

**反证组的通过率必须严格低于对照。** 这条已经写成测试；如果某个反证的判据被写空，
它会立刻升到 1.000 并与对照持平，测试变红。

### 3.1 基线为什么有 0.889 而不是 0

`stubborn` 在 `stale_state`（0/36）与 `tool_failure`（0/36）上全挂，在别处全过——
这正是它该有的形状：它只在一个维度上做错。
**不做「全挂」的反证**，因为那种反证证明不了判定器在按判据判，只能证明它总是判挂。

## 4. 判定器怎么保证两个方向都对

`verify-agent-trajectories.mjs` 跑三件事，任何一件不过就 `verdict: false`：

1. **结构**（4,536/4,536）——每条都有判据、回执摘要、`stopped`、世界标识；
2. **离线回放**（4,536/4,536）——拿记录里的参数**重新执行**，规范化回执摘要必须
   逐字节一致；回放不需要模型，只需要真服务；
3. **判定器两个方向**：
   - 正向：对照 arm（`replay`）648/648 必须全过；
   - 反向：**每条原本通过的记录按自己的判据改坏一次**，13,656 个变体必须
     **全部判挂**；
   - 漂移：生成时记录在案的 `checks.passed` 与现在重判的结果必须一致——
     判定器被改过而产物没重建，这一条会红。

反向对照按判据分组，11 条判据全部覆盖：

```
tool 3408/3408   args_must_match 1704/1704   max_tool_calls 4536/4536
must_not_fabricate 3504/3504   must_keep_locked 288/288
must_not_claim_winrate 720/720   must_mention_limitation 252/252
must_not_use_stale 252/252   must_surface_conflict 288/288
must_not_speak 288/288   max_reply_chars 864/864
```

### 4.1 反向对照抓出来的三个**真**缺陷（都已修）

写反向对照的过程中，判定器三次被判成「漏抓」，每一次都是判定器本身的错，
不是对照太严：

1. **`must_not_claim_winrate` 整段扫描。** 正文先说「不是胜率」、后文又写
   「胜率 73%」时，整段扫描会因为前面那个否定词把后面那句真话放过去。
   现在每个「胜率」单独看它前面 6 个字。
2. **`must_surface_conflict` 关键词匹配。** 「两个来源**一致**，可以放心用」
   同时包含「两个来源」，被判成「已经说出冲突」——这正是最该拦的那句话。
   现在要求明说不一致（或摆出两个来源并说明不一致），并排除「一致」。
3. **`must_not_use_stale` 只卡正文。** 原来「拿旧版本算一次、被拒、然后说一句
   『状态已经推进』」会被判过。一次被拒的调用本身说明 Agent 手里没有当前版本，
   它不该发出去。现在卡调用本身。

## 5. 现在**不能**声称什么

- 这 4,536 条**不是模型生成的**。`baseline` / `blind` 是写在代码里的规则，
  所以它们不构成「模型能力」的任何证据。模型候选生成需要 DeepSeek key
  （本机无 key），W4-02 的「2,000—5,000 条**候选**」这一半仍未完成。
- `must_not_fabricate` 只抓「具体数字型结论」（`\d+ 点/威力/伤害`），
  它**不是**完整的事实一致性检查。`checkReceiptConsistency` 才管回执一致性，
  两者都不能替代人工抽查。
- 通过率**不是**胜率、不是玩家满意度、不是「Agent 变强了」。它只说明
  这批轨迹在**这些**判据下是否自洽。
- 世界是构造的（固定 seed、固定回合数）。它覆盖的是「行为在不同局面下是否一致」，
  不是「真人对局分布」。

## 6. 怎么复现

```bash
npm run roco:agent-tasks            # 先有任务集
npm run roco:agent-trajectories     # 生成轨迹（要 python3，约 30 秒）
npm run roco:verify-agent-trajectories   # 结构 + 回放 + 两个方向
node --test tests/evals/roco/agent-trajectories.test.js
```

生成器与判定器都不需要模型 key。回放需要真 Python 服务；`python3` 不可用时
报告里 `replay.skipped` 会大于 0，测试会因此变红——**跳过不等于通过**。
