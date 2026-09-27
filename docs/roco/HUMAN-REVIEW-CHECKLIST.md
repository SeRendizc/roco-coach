# 人类待办清单（只有你能做的五件事）

> 2026-09-27 立的**常驻清单**：这份文档只写"需要人类出手"的事，每件都带**文件链接 + 你要做什么 + 达标标准**。
> 里面的数字**由判据钉住**（`tests/roco-human-todo.test.js` 会把下面那行注释与真源逐个数比对），
> 所以它不会烂掉 —— 数字变了却没人改这份文档，判据就红。
>
> 数字：<!-- TODO-NUMBERS gold_approved=0 gold_total=59 phase_e_cases=18 rolled_individuals=48 owned_individuals=48 -->

---

## 1. 金标 59 条送审（卡住 M1 北极星指标、C2、C3）

- **现状**：`data/roco/gold/review-state.json` 里 **已审 0 / 共 59**，`gate_eligible = false`（闸门逻辑见 `scripts/roco/gold-review.mjs`）。
  在审完之前，**任何"模型准确率"都不许当北极星指标引用**（判据 `tests/roco-gold-review-gate.test.js` 会拦）。
- **你要做什么**：逐条读题与标准答案。
  - 觉得对了 ⇒ 在 `data/roco/gold/review-state.json` 里把该条改成
    `"status": "approved"` + `"reviewed_by": "owner（人类持有者）"` + `"reviewed_at": "<今天的日期>"`；
  - 觉得不对 ⇒ **直接改标准答案**（答案本体在评测脚本里），改完重新送审（revision 变了会自动退回 draft）。
- **文件**：复核表 [`reports/roco/gold-review-2026-09-25/GOLD-REVIEW.md`](../../reports/roco/gold-review-2026-09-25/GOLD-REVIEW.md)｜
  状态 [`data/roco/gold/review-state.json`](../../data/roco/gold/review-state.json)｜
  闸门 [`scripts/roco/gold-review.mjs`](../../scripts/roco/gold-review.mjs)
- **达标标准**：**59/59 approved** 且每条 `revision` 与当前代码一致 ⇒ `gate_eligible: true`。
  在那之前，M1（北极星）与 C2/C3（证据够不够 / 弃答率）都**动不了** —— 不是"没人做"，是**判据本身没有标注数据**。

## 2. Phase E 的「困难类别」留出集

- **现状**：工具覆盖切片 **18 条**（9 个工具 × 正负各一 —— `inspect_training` 随加点一起退役后少了 2 条，`tests/evals/agent-tasks-v2-tool-coverage.jsonl`），
  与训练集零重叠；但它考的是"**工具选择**"，**困难类别**（多轮 / 冲突回执 / 长上下文 / 模糊指代）**一条都没有**。
- **你要做什么**：说一句「扩」，或指定你要哪几类。数据、判据、基线跑分都由我做（不需要你写数据）。
- **文件**：计划 [`docs/roadmap/AGENT-FIRST-AT-SCALE.md`](../roadmap/AGENT-FIRST-AT-SCALE.md)｜
  现有切片 [`tests/evals/agent-tasks-v2-tool-coverage.jsonl`](../../tests/evals/agent-tasks-v2-tool-coverage.jsonl)｜
  判据 [`tests/roco-tool-task-coverage.test.js`](../../tests/roco-tool-task-coverage.test.js)
- **达标标准**：**每个困难类别 ≥30 条**且与训练集**零重叠**；扩完**先跑基座看基线**再谈提升。
  在那之前，这 18 条算出来的比率**只当冒烟**，不许当泛化结论（v8 在旧 20 条切片上是 17/20，切片小了要重测才可比）。

## 3. 每只精灵的真实**性格** / **天分**

- **现状**：48 个个体**全部是掷点**（数据集里没有真值）—— `nature_source` / `talent_source` 都是
  `rolled（…非官方概率）`，页面上也已经写明「这是模拟掷点，不是官方概率」。
- **你要做什么**：把小黑盒（或任何一手来源）的那批导出发我。格式随便，够用就行：
  **一只一行：物种编号/名字 + 性格 + 六项天分（0–10）**（有突破次数更好）。
- **文件**：规则表 [`data/roco/systems/natures.json`](../../data/roco/systems/natures.json)｜
  掷点实现 [`src/coach/individuals.js`](../../src/coach/individuals.js) 的 `rollNatureAndTalent`｜
  口径与来源 [`docs/roco/TALENT-NATURE.md`](TALENT-NATURE.md) §一 / §八
- **达标标准**：有真值 ⇒ 替掉掷点（来源标 `dataset`，页面上就不再显示"模拟掷点"那句）；
  给不出 ⇒ **维持现状**（继续如实标注"非官方概率"，不许拿建模分布冒充实测）。

## 4. 成长口径冲突：×0.85/×0.55 与「每点 +6」

- **现状**：两条公式并存 —— 桌面笔记的小黑盒公式（生命 ×0.85、其他 ×0.55）与
  「个体值 pvp 中自动乘六倍，7-8-9-10 加 42/48/54/60」（每点 +6）。**PVP 默认走每点 +6**，
  成长口径保留；冲突由判据钉住"**不许悄悄合并**"。
- **你要做什么**：给我**一次实机读数**（同一只精灵、带/不带天分加成的面板值），或者直接定"走哪条"。
- **文件**：[`docs/roco/TALENT-NATURE.md`](TALENT-NATURE.md) §一「一处未解决的口径冲突」｜
  两条口径的实现 [`src/coach/talent.js`](../../src/coach/talent.js)（`PANEL_FORMULA` / `TALENT_PVP_STEP` / `pvpPanelOf`）
- **达标标准**：拿同一只用两条公式各算一遍，**能对上实测的那条为准**；两条都对不上，就继续留着冲突
  （继续标 `COMMUNITY_CURRENT` / 未确认），**不许挑一条好看的写进回答**。

## 5. 「隐藏个体值」那一层要不要建

- **现状**：**没有建模、也没有来源**（页面上遇到没有的项就如实写「游戏数据里没有这一项」）。
- **你要做什么**：确认这一层在原版里到底有没有、数据从哪来（小黑盒？实机？）。
- **文件**：[`docs/roco/DATA-CONFLICTS.md`](DATA-CONFLICTS.md)｜[`docs/roco/COMMUNITY-SOURCES.md`](COMMUNITY-SOURCES.md)
- **达标标准**：**没有来源就不建**（宁可少一层，也不许拿别的数顶格）。

---

## 附：另外两件等你点头的（不在上面五件里）

1. **引擎内部那一套要不要一起删**：
   - 常量：`src/game/progression.js` 的 `TRAINING`/`tokens`/`train()`、`src/game/engine.js` 的 `RULES.training`
     （结算里那份"训练点"奖励还在发，只是**没有任何地方再显示它**）；
   - 工具 `inspect_training`：**已按你说的删掉**（工具合同、执行分支、两张中文名映射、
     本地模型可用工具白名单、覆盖切片那两条用例）。切片因此从 20 条变 18 条 ⇒ v8 的
     「新切片」数字要重测才可比（老门禁那一份不受影响：`LOCAL_TOOL_SYSTEM` 里本来就没列它）。
   - ⚠ 金标 c09 / c34 的**期望工具**里仍写着 `inspect_training`（`scripts/eval-live-s04.js`）——
     金标只能你先审我再改，所以我**没动**，这两条现在会记成"期望的工具不存在"。
   - 现在它们是"内部还在、不再上屏"；要不要连引擎与工具一起退役，等你一句话。
2. **（A5）本机两个体的逐字段比较**：现在能做到"如实说清为什么比不了"（本机新养的个体不在服务端名单里）。
   要真能比，得在客户端本地算面板，约一轮工作量。
