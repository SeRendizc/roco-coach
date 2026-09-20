# P05 统一规则数据源（实现与验收）

清单项：`P05 定义统一规则数据源，驱动 UI、引擎、工具、知识库；加入版本迁移。验收：数值修改不会造成提示与结算不一致。`

本轮完成时间：2026-09-17。产物：`src/game/engine.js`（新增 `RULES`）、**新增 `src/game/rules.js`**、`src/client/index.html`、`src/client/app.js`、**新增 `tests/rules.test.js`**、`src/server/index.js`（模块白名单）。

---

## 一、改之前的问题（先确认，再动手）

改之前，规则数字散落在至少四个地方，而且互相之间没有任何自动校验：

| 位置 | 当时的写法 | 风险 |
|---|---|---|
| `src/client/index.html` 规则弹窗 | 整段手写散文：`克制 ×1.5`、`减伤 65%`、`攻击×0.6 − 防御×0.4`、`45 HP`、`回 4 能量`、`80 回合`、`经验 +24 / +12 / +16`、`等级×30`、`生命 +12 / 攻击 +4 / 速度 +3` | 改引擎数值时没人会记得改这里 |
| `src/client/app.js` | `b.stacks*15`、`${p.energy}/6`、`'○'.repeat(6-p.energy)`、`Math.min(game.turn,80)`、`首次 10 回合内…`、`v.level*30`、`生命+5 攻防+1` | 同上 |
| `src/game/engine.js` | 结算函数里直接写 `1.5`、`.75`、`.6`、`.4`、`.65`、`45`、`6`、`8`、`<=1`、`80` | 数值与同文件的 `desc` 文案也是两份 |
| `src/coach/runtime.js`（工具层） | `energyLimit:6` | 工具层自己抄了一份能量上限 |

`src/game/engine.js` 的 `SKILLS[*].desc` 也是手写字符串，与同对象的 `power/cost/slow/burnBonus/recoil/drain/heal` 字段各写一份。

## 二、改法：一个数字只写一次，界面文案从它派生

### 1. `src/game/engine.js` 新增 `RULES`，结算函数改为引用它

```js
export const RULES={
 typeAdvantage:1.5, typeResist:.75,
 damage:{atkCoefficient:.6,defCoefficient:.4,min:1},
 buff:{perStack:.15,maxStacks:2,turns:3},
 guard:{reduction:.65,energy:2},
 priority:{switch:5,item:4},
 energy:{start:5,max:6,perTurn:1},
 status:{burn:{tick:6,turns:2},poison:{tick:8,turns:3}},
 slow:{turns:2}, shellCharm:{reduction:.15}, energySeed:{threshold:1,restore:2},
 recoil:{rounding:'ceil'}, drain:{rounding:'round'},
 turnLimit:80, learnset:6, loadout:4, level:{hp:5,atk:1,def:1}, training:{hp:12,atk:4,speed:3},
};
```

`damage()` 与 `resolveTurn()` 里原来那些字面量全部换成 `RULES.*`。**结算行为逐字节不变**：改完后 151 项既有测试全绿（见第五节）。

`SKILLS` / `ITEMS` / `HELD_ITEMS` / `ENVIRONMENTS` 的 `desc` 改为"从自己的字段派生"：

```js
export const SKILLS = Object.fromEntries(Object.entries({
  ember:{...power:27, cost:2, status:'burn', desc:()=>`火系攻击；施加灼烧 ${RULES.status.burn.turns} 回合`},
  pursuit:{..., burnBonus:18, desc:s=>`对灼烧目标威力 +${s.burnBonus}，适合火花后追击`},
  guard:{..., desc:()=>`本回合减伤 ${percent(RULES.guard.reduction)}，阻挡新异常，额外恢复 ${RULES.guard.energy} 能量；不可连续使用`},
}).map(([id,s])=>[id,withDesc(s)]));
```

`withDesc` 让 `desc` 在导出时仍是字符串（`src/client/app.js`、`build-knowledge.js` 的用法不变），生成出来的文案与改前逐字相同。开局日志里的 `火克草，草克水，水克火` 也改为由 `typeChartLine()` 从 `TYPE_ADVANTAGES` 生成，与规则弹窗共用同一句。

### 2. 新增 `src/game/rules.js`：**不写任何规则数字**的界面文案生成器

`src/game/rules.js` 生成 11 节规则页正文（`rulesSections()`），并把机器可读的数值一起导出（`ruleFacts()`）。它的关键做法是：**凡是写在 `src/game/progression.js` 里的数值，用引擎自己的函数现场量出来，而不是再抄一份。**

| 界面要显示的 | 来源 |
|---|---|
| 属性倍率、防御减伤、公式系数、状态跳数、能量、道具、携带物、环境、回合上限、等级成长、技能数值 | 直接读 `src/game/engine.js` 的 `RULES` / `SKILLS` / `ITEMS` / `HELD_ITEMS` / `ENVIRONMENTS` / `SPECIES` |
| 胜负经验与训练点（24/3、16/2、12/1） | `probeReward()`：构造一局、设 `result`、调用 `settle()`，读它实际返回的 `reward` |
| 升级所需经验（等级×30） | `probeXpThreshold()`：二分找"最小的起始经验，使一次胜利结算后等级提高"，再加回这次结算给的经验 |
| 等级上限（Lv.5） | `probeMaxLevel()`：反复结算直到等级不再变化 |
| 每级成长（生命+5/攻防+1） | `probeGrowth()`：比较 `createGame({pets:{level:1}})` 与 `level:2` 的实际面板差 |
| 每次培养收益（+12/+4/+3） | 同上，比较加点 0 次与 1 次的实际面板差 |
| 速胜阈值（10 回合） | `probeSwiftLimit()`：二分找"仍能拿到 `reward.swift` 的最大回合数" |
| 培养格数、单项上限 | 直接读 `src/game/progression.js` 的 `trainingCapacity` / `MAX_STAT_TRAINING` |

因此 `src/game/rules.js` 里没有 `30`、`24`、`10`、`12` 这些数字，只有索引与判断。

### 3. 界面改为读生成结果

- `src/client/index.html`：规则弹窗正文整段删除，只留 `<div class="rules-body" id="rules-body">`；难度下拉的选项与说明也清空。
- `src/client/app.js`：新增 `renderRules()`（把 `rulesSections()` 渲染成 `<h3>+<p>`），启动时执行；难度选项由 `Object.entries(DIFFICULTIES)` 生成；强化层数百分比、能量上限、回合上限、速胜回合数、升级经验基数、每级成长数全部改成 `ruleFacts().*`。
- `src/server/index.js`：新增的 `src/game/rules.js` 加入 `publicAssets` 白名单——**这一步是既有测试发现的**：`tests/browser.test.js` 的 `the server allowlist covers every browser module plus the page shell`（**本文原引的是它的前缀**，未加省略号）直接失败，提示 `src/game/rules.js is imported by the browser but not in src/server/index.js publicAssets`。不修就会在浏览器里 404，页面直接白屏。

### 3.1 浏览器实测（端到端，无任何补齐）

`scripts/cdp-rules-check.js`（新增）：headless Chrome 152 + CDP 打开 http://127.0.0.1:8765/ ，读真实 DOM。实测结果（原始输出 `reports/p05-rules-browser-check.txt`，截图 `reports/p05-rules-dialog.png`）：

| 检查 | 实测值 |
|---|---|
| `/rules.js` HTTP 状态 | **200** |
| 网络层补齐的模块 | **无**（`shim.installed: []`）——这次是完整端到端，没有绕过任何东西 |
| 页面 JS 是否执行（营地卡片数） | 执行，`#camp-roster` 有 **12** 张卡片（该快照拍在宠物扩展之前，现在是 **14** 张） |
| 规则弹窗生成的节数 | **11**（标题顺序与 `rulesSections()` 一致） |
| 规则正文段落数 / 字符数 | **77** 段 / **4316** 字符（**DOM 快照值**；`src/game/rules.js` 之后又被改过，现场 `rulesSections()` 复算在写作时为 11 节 / 79 行正文、标题+正文 4440 字符——两个口径不同、且随代码变动，见 `docs/G08-RULES-IN-PLACE.md` 第三节末尾） |
| 必须出现的句子缺失数 | **0**（含 `伤害 = 四舍五入`、`克制 ×1.5`、`减伤 65%`、`每回合末扣 6 点，持续 2 回合`、`换到后备时暂停计时与扣血`、`80 回合仍未分出胜负记平局`、`不连接模型`） |
| 难度下拉选项 | `轻松 / 标准 / 挑战`（由 `DIFFICULTIES` 生成） |
| 规则弹窗是否真的打开 | `open:true`、`visible:true`、660×569、首个标题「这一局的目标」 |
| 控制台错误 | **0** |

> 过程记录（保留，因为它暴露了一个真实的部署问题）：本项刚落地时，**正在运行的 8765 进程仍是旧白名单**，`/rules.js` 返回 **404**，页面一行 JS 都不执行（同期的 C17 实测独立撞到同一问题，只能在 CDP 网络层用磁盘真文件补齐，见 `reports/c17-endgame-browser.md` 第 6 节）。该进程随后被重启，上表即为重启后的实测结果。**仓库状态一直是对的（白名单已改、既有测试通过），出问题的只是"运行中的旧进程"**——这也是本项要补一条真浏览器实测、而不只看单测的原因。

### 4. 版本迁移

- 规则版本仍只有一个常量 `RULES_VERSION`（当前 `0.6`），`createGame().version` 与知识卡 `rulesVersion` 都取自它；`tests/rules.test.js` 断言三者一致，且 `buildKnowledgePacket` 在版本不匹配时 `blocked=true`、`searchKnowledge` 返回 0 张卡（旧数值不会被展示）。
- 规则页新增一节说明版本与存档的关系：成长存档版本 1，旧版或损坏存档安全回退，不用猜测数值补齐（`loadProfile` 的既有行为）。
- 旧存档兼容由既有测试覆盖（`old six-pet saves preserve progress and unlock new loadouts without spending points`），本轮未改存档格式。

---

## 三、验收测试：不是比对两份常量，而是**实测**

`tests/rules.test.js`（16 项，已接入 `npm test`）。核心思路：把引擎**跑起来**，量到真实数字，再和界面上写的数字比对。

| 测试 | 怎么"实测" |
|---|---|
| `type multipliers … match measured engine damage` | 用放大探针（威力 600、攻 200/防 100，避开整数取整误差）算 `damage()`，用两个属性的**伤害比值**反推倍率，再和文案里的数字比；并遍历 `TYPE_ADVANTAGES` 的每一条克制关系都实测一次 |
| `guard reduction and piercing skills …` | 实测 `damage(...,guard=true)/damage(...,guard=false)`，与文案里的百分比比；并实测 `stonebreak`/`crush` 确实不吃这次减伤 |
| `damage formula coefficients … reproduce engine damage` | 把文案里的系数抄进一个重算函数，跑遍**全部攻击技能 × 攻强化 0/1/2 层 × 防强化 0/1/2 层 × 目标是否灼烧**（≥100 组）逐一比对 `damage()` |
| `status timing and ticks … real resolved turn` | 真的打一回合（火花 → 对手撞击），读日志里的实际伤害与剩余次数，验证回合末实扣等于文案里的跳数、剩余次数等于文案里的持续回合 |
| `energy, item and turn-limit …` | 真的结算：初始能量、回合末回能、上限封顶、回复药实际回复量（含只缺 10 血时只回 10）、能量果实际回复量 |
| `environment multipliers and durations …` | 用带环境的真实宠物面板实测倍率与持续回合 |
| `reward, xp and training numbers … real settle()` | 真的调用 `settle()` 读 win/draw/loss 奖励；真的连打 120 场验证等级停在 5；真的比较 1 级与 2 级面板差、加点前后面板差，并与 `src/game/progression.js` 的 `TRAINING` 文案数字对齐 |
| `swift-win threshold … settle()` | 真的构造 10 回合与 11 回合的胜利各结算一次，验证 `reward.swift` 分别是 1 和 0 |
| `every skill description states the same numbers as its own data fields` | 逐技能断言说明里的百分比/层数/回合数与字段一致；并断言每个技能都能生成含消耗（有威力时也含威力）的数值行 |
| `the tactics knowledge base states the same numbers as the engine` | 把引擎字段**拼成句子**（如 `防御减伤${percent(RULES.guard.reduction)}`、`每点敏捷加${RULES.training.speed}速度`），再到知识卡（写作时 90 张 = 49 张战术卡 + 41 张引擎参考卡；参考卡随 `SPECIES` 生成，本轮扩容后为 44 张）正文里找，找不到就失败——这是原来完全没有覆盖的一块。⚠️ **这条测试的覆盖面是"固定的数值短语清单"，不含属性清单、也不含"没有天气"这类句子**：`tests/rules.test.js:272` 的 `expected` 数组里只有 `克制1.5倍`、`中毒每次8伤害` 这一类句式。2026-09-17 因此出现过一次漏网——`knowledge/tactics.json` 的 `tactic:rules-boundary` 卡曾同时写错两件事（只列了 6 个属性、说"没有天气"），并且**通过了这条测试**；已在提交 `2406bc6` 修好卡片正文（改为"火、水、草、岩、雷、风七个技能属性，另有中性的普通系……环境机制是有的"）。**要守住这一条，测试清单本身也需要跟着扩。** |
| `the tool layer quotes the same rule numbers as the engine` | 断言 `buildContext().battle.energyLimit === RULES.energy.max`、`battle.version === RULES_VERSION`，并遍历 `REFERENCE_CARDS` 的版本号 |
| `the rules page is generated, not hand-written …` | 读 `src/client/index.html` 原文，断言规则弹窗里**不再出现** `×1.5`/`×0.75`/`65%`/`45 HP`/`80 回合`/`等级×30` 这些手写数字，且每个技能/道具/携带物都能在生成结果里找到 |
| `a rules-version mismatch blocks advice …` | 版本不匹配时不返回旧数值 |
| `species panels / difficulty list / legal actions` | 面板、难度、可用性说明都与引擎一致 |

另外 `tests/offline.test.js` 断言 `src/game/rules.js` 与 `src/game/engine.js` 的静态 import 图里**没有任何 `src/coach/` 模块**，所以规则页在未配置密钥、断网时照常可读。

**回归保护**：任何人把 `RULES.guard.reduction` 从 `.65` 改成 `.6`，会有 4 项测试同时失败（规则页文案、知识卡、伤害实测、防御实测），而不只是"某个常量不相等"。

---

## 四、仍然存在的硬编码副本（照实列出）

统一数据源没有做到 100%。以下是**知道但本轮没改**的地方，原因是它们都在本轮被限定为不可修改的文件里（`src/coach/*.js`），其中 `src/coach/companion.js` 同期还在被另一个并行任务重写：

| 位置 | 内容 | 现状 |
|---|---|---|
| `src/coach/runtime.js` | `energyLimit:6` | **已加测试锁住**（`the tool layer quotes the same rule numbers as the engine`），改引擎不改这里会失败 |
| `src/coach/experience.js` | `'防御能减伤、额外回2豆…'`、`'等回合末回1豆'` | 文案里的 2 和 1 是手写，无测试 |
| `src/coach/teacher.js` | `'一次培养：生命 +12 / 攻击 +4 / 速度 +3'`、`速度 ${p.speed+3}`、`生命 ${p.maxHp+12}` | 手写；`src/game/progression.js` 的展示常量 `TRAINING` 已有测试与引擎对齐，但这里又抄了一份 |
| `src/coach/strategist.js` | **本条归属点错了文件**：`'回复药优先级4'` 之类出现在检索词里 | `grep -rn "回复药优先级" src/coach/` → **0 命中**，该串实际在 `knowledge/tactics.json:91`（并同步进 `src/game/content.js` 的 `TACTIC_CARDS` 与语义语料）。基线提交 `e5417e8` 的 `src/coach/strategist.js` 同样没有过。低风险，未处理 |
| `src/game/content.js` 手写前缀（`STAGES` / `SCENARIOS`） | 场景文案 | 句子里目前没有规则数值；**如果以后加数值，需要纳入同一套校验** |
| `knowledge/tactics.json` | 手写战术卡 | 数值本身正确（已加测试），但它是**手写**的，靠测试守住而不是靠生成 |

其中 `src/coach/runtime.js` 一项已经用测试兜住；其余三项建议下一轮把 `src/coach/*.js` 也接进 `src/game/rules.js`（改成从 `RULES` / `TRAINING` 取数）。

## 五、测试结果

| 时点 | 测试数 | 结果 |
|---|---|---|
| 改动前（`git stash` 回到 HEAD，连跑两次确认） | 151 | 151 通过 / 0 失败 |
| 改动后（最新一次，含并行任务同期新增的用例） | **191** | 191 通过 / 0 失败 |
| `reports/test-output.txt`（22:04，此后入库） | **251** | 251 通过 / 0 失败 |
| 写这份修复报告时现场 `npm test` | **257** | **257 通过 / 0 失败**（核对过程中曾因并发的"新增两只普通系"改动短暂出现 255/2，最终全绿） |

改动后**当时**的逐文件分布（`node --test <file> \| grep '^ℹ tests'` 可复算）：`engine` 10、**`rules` 16（新增）**、**`offline` 5（新增）**、`mechanics` 6、`pvp` 8、`browser` 3、`features` 24、`coach` 25、`companion` 13（并行任务）、`server` 11、`knowledge` 10、`tests/evals/agent` 37、`tests/evals/regression` 17、**`tests/evals/slow-model` 6（新增）**，合计 191。其中本轮新增 27 项（16+5+6）。

⚠️ **这张分布表当时就漏了 4 个也在 `npm test` 里的文件**（`strategist` 24、`opponent` 27、`wiring` 3、`tests/evals/player-copy` 2），所以 191 只是"这批文件"的合计，不是全套。**现场复算（2026-09-17 晚）**：`engine` 10、`rules` 17、`offline` 5、`mechanics` 6、`pvp` 8、`browser` 5、`features` 24、`coach` 27、`companion` 17、`strategist` 24、`server` 11、`opponent` 27、`knowledge` 11、`tests/evals/agent` 37、`tests/evals/regression` 17、`tests/evals/slow-model` 6、`wiring` 3、`tests/evals/player-copy` 2 = **257**。变化集中在 `rules` 16→17、`browser` 3→5、`coach` 25→27、`knowledge` 10→11、`companion` 13→17。

`npm test` 命令与新增用例见 `package.json`（`npm run test:rules` 可单独重跑 P05/G08，`npm run test:slow-model` 重跑 S05）。

> 注：本轮第一次跑基线时读到的是 150 项，随后在 HEAD 上重复两次都稳定为 151 项；以可复现的 151 为准。

## 六、可核查命令

```bash
npm test                       # 全套（本文原先写"189 项"，与上文 191 自相矛盾；当时实际 191，现在现场 257——一律以实跑输出为准）
npm run test:rules             # 只跑 P05 + G08
node -e "import('./src/game/rules.js').then(m=>{for(const s of m.rulesSections())console.log('##',s.title);console.log(JSON.stringify(m.ruleFacts().rewards))})"
grep -n 'id="rules-body"' src/client/index.html      # 规则弹窗正文位置（生成）
grep -c 'RULES\.' src/game/engine.js               # 结算引用统一数据源的处数
```
