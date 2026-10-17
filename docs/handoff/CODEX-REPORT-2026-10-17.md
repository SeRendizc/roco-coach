# 给 Codex 的交接报告 · 2026-10-17（DS 侧 → Codex，联合优化）

> **锚点**：腾讯 IEG《洛克王国：世界》「斯嘉丽」Coach Agent 二面 + 你的 Agent/LLM 能力学习。
> 不是产品运营材料。本文只写**可核查事实**：每条都有分支/提交/命令/文件路径；未验证的会标「未验证」。
> 建议 Codex 先读 §0–§2，再按 §5 挑一个任务开工；每轮把结果写回 `output/…/codex-review-2026-10-17/`。

---

## 0. 一句话现状

DS 侧已完成五项面试目标（规则修复/官方 Bad Case 回归/材料台账/双分支推送/演示+模拟面试），
并在用户配好 key 后跑通「**修复分支 + 真实 DeepSeek**」的局内联调；现在进入
**联合优化阶段**：Codex 负责深度验证与 Agent 工程化（评测、路由、上下文隔离），
DS 负责面试叙事与证据整合。**master/wip 未动；公开分支 `interview/2026-10-17` 已推。**

---

## 1. 代码与运行基座

| 项 | 值 |
|---|---|
| 仓库 | `/Users/serendizc/Developer/roco-coach`（公开主干 `2e62a73b`，2026-10-06） |
| 工作分支 | `interview/2026-10-17` @ **`20d71a5f`**（= fix 分支 + 材料/修复） |
| 修复分支 | `fix/typechart-official-3x` @ `f9ac7e06` |
| 远端 | gitee + GitHub 同名两分支；tag `interview-2026-10-17`、`typechart-3x-fix` 已推 |
| 演示实例 | `:8910`（本分支，`ROCO_RAG_MODE=legacy`）；`key 在 macOS Keychain`（service `roco-deepseek`），重启由 `scripts/interview/start-demo.sh 8910` 自动加载 |
| 用户正常实例 | `:8765`（Oct 11 树，已接 DeepSeek；**不要动**） |
| 测试 | 分支 `test:unit` **2094 / 2079 过 / 14 红 / 1 skip**（失败集合与公开主干逐条相同 ⇒ 零新增红）；`test:env` 仅 1 条 pre-existing（tier 反证，主干同样红）；`test:roco-quality` 77/77 |

### 1.1 不要碰

- `master` / `wip`；`:8765` 实例；`docs/interview/cv/`（已 gitignore，含个人联系方式）；Keychain/文件里的 key（**不要打印**）。
- 不要为让测试变绿而删弱旧断言；规则类改动必须「改钉 + 留痕 + 金标送审」。
- 不要发起未获用户批准的付费调用（当前 8910 已配 key，`/api/coach` 会走 DS 计费）。

---

## 2. DS 侧这半天做了什么（可核查）

| # | 改动 | 提交 | 证据 |
|---|---|---|---|
| 1 | 双属性相性改回快照 **3×**（引擎 + RAG 语料；旧 41 格裁决留痕） | `731273c5` `835ae605` | `roco/tests/test_type_multiplier_ruling.py` 8/8；`tests/roco-rag-typechart.test.js` 11/11 |
| 2 | 状态免疫（火免灼烧/毒免中毒/草免寄生；技能 + 每驱散层两条路径） | `a972f57b` | `roco/tests/test_scarlett_bad_cases.py`（6 + 2 服务读口 = **8/8**） |
| 3 | grounded 等级词守卫（「强力克制」=3；「×4」判退役；证据 ×2 时 2 倍不误伤） | `f9ac7e06` | `tests/roco-scarlett-tier-grounding.test.js` **7/7** |
| 4 | **官方 Bad Case 问句直查 type_multiplier**（新增 `typeMultiplierAsk`，政策 `type-multiplier-ask`） | `a0d6f8bc` | `tests/roco-type-multiplier-ask.test.js` **3/3** |
| 5 | **服务层读口收口**：`_answer_type_multiplier` 曾是「第四份独立算术」（双弱 ×4），现走 `rs.type_chart.multiplier` | `a0d6f8bc` | 服务读口 2 条（含 fail closed） |
| 6 | 真实 DeepSeek 联调（修复分支） | `e46be5f0` / `20d71a5f` | `docs/goal/evidence/real-ds-verification.md` |
| 7 | 战斗复盘细节验证（真 13 回合局） | `20d71a5f` | `docs/goal/evidence/review-detail-verification.md` |
| 8 | 材料/简历/台账/分支/tag | 见 git log | `docs/interview/`、`reports/interview-2026-10-17/` |

### 2.1 真实链路实测（最重要的两条）

- **官方 Bad Case 问句**（8910，真 DS）：`query_rules` 回执 `multiplier=3`，provider=deepseek，1,433ms，正文
  「电系打翠顶夫人（翼系+水系）是 3 倍伤害，属于强力克制」。
- **局内建议**（8910，真 DS + 引擎 plan）：provider=deepseek，4,093ms，`simulate_branch×2`，
  正文正确引用 plan 的「使用能量果」+ 96 分支 + 主要风险「诡刺」。
- **复盘**（本地函数，0 付费）：13 回合局产出回合号/伤害值/合法替代（第 8 回合可「换上第2位」）/
  资源账（换人 0、道具 1、能量最低 1）/ 关键片段（第 11 回合 241 点）。

### 2.2 已知边界（不要替 DS 掩盖）

- `test:env` 的 tier 反证红是**基线已有**，未修（不扩大范围）。
- 真实模型在 44+4 条评测里**没有观察到多工具链**（toolTrace 最大 1）；多步只有确定性测试。
- 浏览器逐屏点击未重做（Chrome headless 在 sandbox 挂起）；页面 HTTP 200 + 同源构建函数已验证。
- 8765 与 8910 **不是同一份代码**：8765 是 Oct 11 树，8910 才是修复分支。

---

## 3. 面试锚点（报告要服务的目标）

- **一句话**：证据约束的六宠对战 Coach Agent——规则引擎算事实，模型只理解/查证/措辞；
  每句话可追证据、旧建议会失效、无证据不编。
- **最能打的三段故事**：① 有界工具循环（22 种 stops，真实模型未多步）；② 信息边界（双层拦截 + 反作弊对照）；
  ③ 今天这个：官方 Bad Case → 发现自仓**四层**口径不一致（引擎/RAG/客户端/服务层读口）→ 一手证据推翻旧裁决 →
  改钉留痕 + 金标重建 + 回归判据 → 公开分支可 clone 复查。
- **面试材料入口**：`docs/interview/README-2026-10-17.md`（速记卡/情报/作战包/代码追踪/深挖演练/模拟面试）。

---

## 4. Agent 学习目标（联合优化的「长期收益」部分）

用户要的不是更多功能，而是三种可验证能力：**trace（定位）· predict（边界）· modify（独立改）**；
以及模型服务侧的实测能力（首 token/延迟/成本/评测分母）。Codex 适合负责深验证与工程化，
DS 负责把结果压成面试可讲的东西。每周产出应至少包含：一条红→绿判据、一次独立复跑、一段 90 秒口述。

---

## 5. 请你（Codex）优先做的 4 件事（按 ROI）

### 任务 A：对「四层口径」做**对抗式复核**（最高优先，0 付费）

> **DS 已先做了一版**：见 `docs/goal/evidence/rule-arithmetic-audit.md`（发现并修掉**第五处**：
> `_answer_weakness_summary` 的逐属性相乘；`_answer_type_chart` 自检口径也改为「引擎 vs 快照 0 格 + 41 格历史」）。
> 你可以**独立复跑并挑战这版结论**，或直接做 B/C/D。
- 复跑：`cd roco && PYTHONPATH=src python3 -m unittest tests.test_type_multiplier_ruling tests.test_scarlett_bad_cases`；
  `node --test tests/roco-rag-typechart.test.js tests/roco-scarlett-tier-grounding.test.js tests/roco-type-multiplier-ask.test.js`。
- 检查是否还有**第五处**独立算术/口径（grep `_single_multiplier`、`combination_rule`、`snapshot_value`、
  `typeChartBody`、`fallback_multiplier`；重点看 RAG 语料与服务层、客户端 `type-affinity`）。
- 产出：`codex-review-2026-10-17/rule-audit.md`：每条 = 位置 / 现状 / 是否与 `TypeChart.multiplier` 同源 / 证据。
- 反证要求：故意把某一处改回相乘，必须有一条测试变红（说明判据有牙）。

### 任务 B：Agent 路由与上下文隔离（0 付费，先做设计 + 单测）
- 现状：`typeMultiplierAsk` 只覆盖「显式属性/带括号双属性」问句；`camp` 上下文问洛克问题时仍会混用两套规则
  （实测 camp 问洛克宠物 → 模型按自研小兽「雷克风 1.5」答）。建议：
  ① 给 `policyFor` 加「洛克上下文 + 显式相性问句 ⇒ 必调 type_multiplier」的覆盖面回归（更多句式）；
  ② 设计与实现 **camp/洛克 上下文隔离**：洛克问题在 camp 前必须明确「现在没有对局/这是训练场规则差异」，
     不许拿自研引擎的 1.5/0.75 冒充洛克相性；③ 加一组红→绿判据（先让旧行为红）。
- 产出：`codex-review-2026-10-17/Routing-and-context.md` + 最小补丁 + 测试。

### 任务 C：给「Agent 能力」建一个可复跑的小评测（0 付费，离线桩）

> **DS 已先做 v1**：`npm run eval:agent-policy`（16 任务/计分 14/known-gap 2，14/14 通过；
> `tests/roco-agent-policy-eval.test.js` 含「改坏期望必红」反证）。建议你把它扩到 25–30 条并加「该不调」反例。
- 规模建议 20–30 条：相性问句（含官方 Bad Case 同族）/ 该调工具与不该调 / 证据不足时降级 /
  camp 与洛克混淆 / 旧建议过期。指标：工具选择正确率（分桶）、答案是否引用回执、错误类型分布、分母=全部任务。
- 产出：`codex-review-2026-10-17/agent-eval/`（任务集 + runner + 一页报告），并接一条 `test:unit` 或独立 npm script。

### 任务 D：面试对抗追问的「打假」
- 读 `docs/interview/AGENT-DRILL-2026-10-17.md` 与 `SECOND-ROUND-PACK`，挑 10 个最可能被追问的点，
  用仓库事实核对，列出「说过头/对不上代码」的句子并给安全改法。
- 产出：`codex-review-2026-10-17/interview-claims.md`。

---

## 6. 协作协议（建议）

1. 只写 `output/roco-next-20261017/codex-review-2026-10-17/`（或你自己的工作树），**不要直接改 `interview/2026-10-17`**；
   给补丁 + 红/绿日志，DS 侧整合后再提交。
2. 每个任务必须给：命令原文 + 输出摘要 + 判定（verified/stale/unverified）；无付费调用。
3. 结论优先「发现了什么/哪里错了」，不要把 DS 已写的再抄一遍。
4. 完成后把 3 行摘要 + 文件路径发回；DS 会把它并进 `docs/goal/` 与面试材料。

## 7. 决策/边界（需要用户或双方拍板）

- [ ] 是否允许 Codex 在 8910 上做真实 DS 调用（当前已配 key，会计费）——建议默认不。
- [ ] `tier` 反证红是否列入下一阶段修复（目前判定 pre-existing，不阻塞面试）。
- [ ] 是否把 camp/洛克 上下文隔离作为面试前最后一个功能（若时间不够，只做「识别并如实说明」）。

## 8. 证据索引

- 数字台账：`reports/interview-2026-10-17/EVIDENCE-LEDGER.md`（+ 附录 Z）
- 真实 DS：`docs/goal/evidence/real-ds-verification.md`
- 复盘细节：`docs/goal/evidence/review-detail-verification.md`
- 干净克隆验收：`docs/goal/evidence/clean-clone-verification.md`
- 启动器冒烟：`docs/goal/evidence/launcher-smoke.md`
- 规则真源对账：`docs/interview/SCARLETT-BAD-CASE-REPLAY-2026-10-17.md`
- 20 轮执行报告：`docs/goal/GOAL-REPORT.md`

## 11. Codex 审计已整合（2026-10-17 深夜，DS/Lead 回复）

Codex 的 `rule-audit.md`（A1–A5）已逐条验收并落地；原文、补丁、命令记录归档在
`docs/goal/evidence/codex-audit-2026-10-17/`，逐条处置见 `docs/goal/evidence/codex-audit-acceptance.md`。

| 编号 | 处置 |
|---|---|
| A1 活动台账仍写 ×4、检索返回旧 claim | ✅ 已修：claim/notes/sources 改新口径；旧全文进 `retired_*`（不渲染）；`user-in-game-reports` 增复核留档；M07 anchors 改 ×3；meta-prior 生成器同步重建 |
| A2 服务回执文字仍解释相乘 | ✅ 已修：`weakness_summary.multiplier_rule`、`type_row.note` 改快照口径；吸收 Codex 的 4 条契约测试 |
| A3 bridge 测试仍钉 4/multiply | ✅ 已改钉为 3/true/snapshot_row（旧断言留注释）；确认该文件此前不在 `test:unit` 里 |
| A4 等级词守卫无对象绑定 | ✅ 已修：攻击属性+防守属性/对象绑定；同对象冲突倍率 fail closed；无关 ×2 不再抵账；新增 3 条正反控制 |
| A5 meta-prior/M07/注释旧口径 | ✅ 已修生成器+派生件+M07；服务文案已修；`data.py`/`opponents.py` 旧裁决注释按「改钉不删」保留并标注复核 |

**实施中新踩到的一条链**（Codex 审计未覆盖）：改台账会让 `derived_from_ledger_sha256` 失效，
必须重建 rulesets → pack → readiness → owned-pets → rag-eval，再重建 meta-prior + rc602 报告。
`node scripts/roco/rebuild-derived-chain.mjs --check` 现已 5 环全过。

**整合后读数**：`test:unit` 2101/2088/12/1（失败集合 = 基线 14 条里**修好 2 条派生报告红**，
无新增红）；`test:env` 仅 1 条 pre-existing；quality 77/77；RAG 语料 8/8；
Codex gate 两条自然问句 PASS；bridge 单跑 10/11（剩 1 条在未改 HEAD 上同样红）。
**0 次付费调用。** Codex 侧后续可做的仍是 B（camp/洛克上下文隔离）与 D（面试说法打假），
以及把 bridge 全量并入 `test:unit` 前先修那条 pre-existing。
