# 半成品排查 · `team-workshop-u04`（配队工坊 + 交叉复核）

## 0. 我审的是哪一版（冻结修订）

| 文件 | sha256 前 10 |
|---|---|
| `src/client/team-workshop.js` | `b2ee7ace5d` |
| `src/client/roco.css`（工坊样式所在） | `aba9f40214` |
| `src/client/style.css` | `7c779d6a09` |
| `scripts/roco/browser-workshop-acceptance.mjs` | `3f9f1e66b5` |

服务：**当场量** —— `lsof -nP -iTCP:8765 -sTCP:LISTEN -t` ⇒ `pid=1896`；`curl -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/` ⇒ **200** ✓（不是引用别人给的数）。

探针（只读、专用 profile、串行、try/finally 收尾）：
`node tmp/review-blocks.mjs "<team>"` ⇒ `tmp/review-blocks.json` + `tmp/review-shots/blocks-*.png`；
`node tmp/review-task11-v4.mjs` ⇒ `tmp/review-task11-v4.json`（抽屉/四条/可见面）。
**全程未改任何文件。**

---

## 1. A 表：配队工坊逐块（默认可见面 + 真读数 vs 占位 + 要几个动作）

| # | 模块/文件:行 | 现象（一句话） | 证据（逐字/读数） | 判定 | 修复成本 | 优先级 |
|---|---|---|---|---|---|---|
| A1 | `team-workshop.js:1170` 起 · 队伍六槽 | 默认可见面有内容，且是**真读数** | 6/6 卡可见（`vis=true`，各 183×346）；每槽 4 个技能名（喵喵「抓挠/防御/仙人掌刺击/腐化」）、特性「氧循环：使用草系技能后，回复10%生命。」、`持有 · 可出战`、来源标 `默认` | **已完成（五条齐）** | — | — |
| A2 | 同上传 · 空槽 | 空槽文案诚实，不装 | slot3 逐字「第 3 槽位（空） 可以从候选里挑一只补上」 | **已完成** | — | — |
| A3 | `:1401` 起 · 候选池 | 默认 `mine` 池真读数 + 范围说明 | `#tw-cand-list` **9 行**；scope `mine=true/all=false`；note 逐字「这一档只显示「你拥有」的精灵…要看其它物种就切「全图鉴」——候选来自全图鉴 622 只…」 | **已完成** | — | — |
| A4 | `:1193-1280` · 换招 | 四个技能格 + 来源标，真功能 | 每槽 `data-tw-skills` 4 个 id；来源标 `['默认']`；`[data-tw-loadout]` 按钮在 | **已完成** | — | — |
| A5 | `:1280` 附近 · 替换流程 | 默认收起 = **1 个动作**（人类口径：不算半成品） | `#tw-replace-box` `hidden=true`、`host.twReplaceState="none"` | **已完成**（按人类口径） | — | — |
| A6 | `:1698` · `buildPlan` 组队 | **凑齐六只 = 按盒子顺序补齐**（人类点名） | **运行时报据**（部分队伍 `?team=own-0001,own-0002`）：预览 6 行 `origin = ["team","team","recommended","recommended","box","box"]`；代码 `:1698` `for (const [species, list] of state.ownedBySpecies) pushSpecies(species, 'box', …)` ⇒ 后两槽**没有任何评分/排序**，就是 Map 迭代顺序 | **半成品 ⓓ（占位/常量式补齐）** | 中（要定一个"按什么排序"的口径 + 判据） | **高** |
| A7 | `:1720` 附近 · 6×4 预览的技能数 | **两处读数字段自相矛盾** | 同一份回执里：每行 `data-tw-plan-skill-count="4"`，而 `host.twPlanLoadouts` 逐字 `own-0001:skill_000246.skill_000286.skill_000340.skill_000624;own-0002:…;own-0481:;own-0501:;own-0003:;own-0004:` ⇒ **后四行 0 个技能** | **半成品（ⓒ 同名两份/两处口径不一致，待定性质）** | 小-中（先查这两处各由谁写） | **高**（预览是"逐格可核"的门面） |
| A8 | `:936` · 应用配置 | 真功能：应用后**学习表核对**从 `unknown` 翻成 `ok` | 应用前 6 槽 `data-tw-slot-legality="unknown"`；点「应用这套配置」后 **6/6 = `ok`**，`host.twConfigState="applied"` | **已完成** | — | — |
| A9 | `:937` · 撤销 | 真功能：状态与文案都回到"没应用过" | 撤销后 `twConfigState="none"`、`twConfigUndoable="no"`、note 逐字「还没有应用过：选满六只、每只四个技能，点「应用这套配置」。」 | **已完成** | — | — |
| A10 | `details[data-tw-diag]` · 诊断详情 | 默认收起 = **1 个动作**（人类口径） | 每槽 `details[data-tw-diag] open=false`；收起态 innerText 21 字（正常，不是空） | **已完成**（按人类口径） | — | — |
| A11 | `#tw-eval-drawer` · 阵容评估抽屉 | 默认收起 = **1 个动作**；打开后四块是**真读数** | 默认 `w=39 / data-open="no"`；点开 `w=300`，`#tw-teamplan` **270×1355**，四块 top/h = strength 156/275 · shortfalls 450/187 · priority 655/133 · playstyle 806/705 | **已完成**（按人类口径） | — | — |
| A12 | `:2719` · 旧五轴墙 | 进了 `closed <details>` ⇒ **玩家看不到但判据读得到** | `<details open="false">` summary「原始数值与说明（引擎五轴 / 未结算的效果 / 这一层不知道什么）」、innerLen 1720；而 `check 39` 读 `textContent`（见 B2） | **半成品 ⓔ（只在 DOM，不在可见面）** | 小（判据改读可见性） | 中 |
| A13 | `#tw-coach-body` | 旧的小芽 Coach 栏**已删除**（不是半成品） | 探针 `coach.exists=false` | **已完成（已移除）** | — | — |
| A14 | playstyle 文案（归属 `advice-engine`，我只复核） | 可见文本夹**工程词与来源声明** | 逐字：「效果段 `defense_reduction`，档位 SIMULATABLE_UNVERIFIED」「本仓的 JS 练习引擎」「手游引擎」；另有 `**会结算**` 星号泄漏 | **半成品 ⓓ（占位/工程词）** | 小（文案层） | 中 |

---

## 2. B 表：交叉复核（审计者 ≠ 被审者）

| # | 被复核的说法 | 我的独立读数 | 判定 |
|---|---|---|---|
| B1 | `advice-engine`：「**压字后四块进一屏 873 ≤ 900**」 | **不复现**。同一版（`team-workshop.js b2ee7ace5d` / `roco.css aba9f40214`）、1440×900、满编六只 + 点过「小芽给一套 6×4」+ 抽屉已开：四块高度 **275 / 187 / 133 / 705 = 1300**，`#tw-teamplan` 高 **1355**，抽屉内高 **758** ⇒ 需要滚动 ≈600px 才看得到全部四块。**873 ≤ 900 在我这组输入下不成立** | **与它报的不符 ⇒ 以我的读数为准并上报**（需要它给出**选择器 / 队伍 / 测量命令**才能逐字对齐；我怀疑它量的是另一个容器或另一个队伍） |
| B2 | `advice-engine`：「`check 39` 做坏后撤回、脚本恢复可跑 **52/53** · 反证 **47/47**」 | **未跑**（不冒充）：`browser-workshop-acceptance.mjs` **没有子集开关**（只有 `--keep-open`），会**自起 Chrome** 并与其它浏览器探针争用 ⇒ 按纪律（串行、别硬等）我没跑全量。**只做了静态核对**：`check 39` 在 `:1693-1745`，读 `[data-tw-axis] / .tw-axis / .tw-axis-row` 的 **`textContent`** 找「最怕的体系」，并带两段反证（旧文案「大约每 5 局遇到 1 次」等）；**旧断言原文未逐字留档**（只有 2026-09-27 的根因说明 + 反证），与"改钉不删"的口径**还差一格** | **未证**（半成品排查口径：没有运行时报据 ⇒ 既不算绿也不算红）；旧断言留档缺口 **确认存在** |

---

## 3. 一句话总结

**配队工坊主线（六槽 / 候选池 / 换招 / 应用撤销 / 抽屉四条）确实都是真功能，我找到 4 个半成品：最关键的是 `buildPlan:1698` 的"按盒子顺序补齐六只"（运行时 origins 已证）与 `:1720` 一带 `skill-count=4` 和 `twPlanLoadouts` 空技能**两处自相矛盾**；另外旧五轴墙在 closed `<details>` 里、判据却读 `textContent`（绿而不可见），以及 playstyle 里的工程词/星号泄漏（归属 advice-engine）。**

> 复核结论：`advice-engine` 的「873 ≤ 900」在我这组输入下**不复现**（我量到 1300/1355，抽屉内高 758）；它的「脚本 52/53 · 反证 47/47」我**没跑**（脚本无子集开关、会自起 Chrome），只确认了 `check 39` 的**旧断言未逐字留档**这一处口径缺口。
