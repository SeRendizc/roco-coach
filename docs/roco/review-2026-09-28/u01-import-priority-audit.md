# U01 导入字段来源优先级：独立审核（2026-09-29，T1 / task-06）

**审核对象**：`talentReadingOf(individual, {imported})` 的"哪一份说话"、导入字段的真实覆盖率、
"设为默认"的后果、以及"导入优先"的反证。

**审核结论只有一句（先说结论，后面每条都有命令与输出）**：

> **在这个仓库的数据里，"导入字段"根本不是抓包真值 —— 它就是 `rollNatureAndTalent(instance_id)`
> 这一份种子化掷点，与本机记录用的是同一个函数、同一个种子；原始数据集里 542/542 只的
> 「资质」都是 `null`。所以"导入优先"不是"真值优先"，而是"把服务端那一份掷点盖到本机那一份掷点上"：
> 在玩家没刷新过之前两者逐值相同（换了等于没换），在玩家刷新过之后**会把他刚刷出来的数盖掉**
> （正是 A7 刚修好的那个缺陷的另一半）。**

配套的三条副结论：

1. **导入字段只出现在两个地方**：`conflict`(不一致时把名单那一份也摆出来) 与
   `resetTalentFromImport()`（玩家点「用名单那一份重设资质」时的**可采纳来源**）。
   **它从不提供屏幕上的值** —— 现在的实现里"以本机记录为准"是**结构性**的，不是一句注释。
2. **覆盖率**：原始数据集 `data/roco/owned/owned-pets.json` 的 542 只里，`talent.value` 有值的 = **0**
   （`nature.value` 也是 0/542；只有 `bloodline.value` 有 12/542）。缺失的形状是
   **键在、值为 `null`**（`{value:null, value_source:null, effect:'UNKNOWN', …}`），不是空对象、也不是没有键。
   经服务端 `withIndividualGrowth()` 投影后 542/542 都有值，但 `talent_source` **全部**以 `rolled` 开头。
3. **反证成立（5 个）**：把"导入优先"当成假设实现跑起来，在 5 种合成形状上确实会出错（含"盖掉玩家刚刷的加成"、
   "同种多只显示同一份"、"旧口径掷点把有档名的一只打成未定档"）。另有 1 个**现有实现**的次要发现
   （导入是"部分项"时会把一致说成不一致），可达性有限，见 §4.2。

---

## 0. 审核快照与边界

```
$ git rev-parse HEAD
51c04fb1488c7c629e659d6619b094bb92c6570a

# 审核**起点**那一版（§1 的分支与行号先按它读的）
$ shasum -a 256 src/client/box-talent.js src/coach/individuals.js src/client/box.js data/roco/owned/owned-pets.json
4257e00b360f5cb658e6a6815cf853e19c2e7aa6e9e8e86564c5157c46de1921  src/client/box-talent.js   （261 行）
17a308c058650cb7aafb8e183442d98d54a979176b1657ab6c11a2f0ed6abd3f  src/coach/individuals.js   （560 行）
b8eb6ab459e3e4a6fa249f54fa6eca6b6530a8652e9d4c7e05bcc067f0c39f09  src/client/box.js
b1f7d0f9d4c35eb9b96ac1d539d36f11782fe26cabc0cd54bf82623292aee115  data/roco/owned/owned-pets.json

# 审核**收工**那一版（Lead 12:33:29 改过 box-talent.js；§1 的行号已按这一版重锚）
$ shasum -a 256 src/client/box-talent.js
ef6e9d8cbd96c30477bc73bec123319625c2062d51848517037b1e2b3e0fe149  src/client/box-talent.js   （271 行）
```

- **审核期间上游改过一次**：`src/client/box-talent.js` 于 12:33:29 被 Lead 改动（261 → 271 行）。
  **优先级语义没有变**（值仍全部来自本机记录，`imported` 仍只进 `conflict`；这一点我逐行核对过），
  变的是**措辞**：新的 `ROLLED_NOTE` / `remedy` 已经写出"名单那一份同样是建模掷点、这个仓里没有抓包来的资质真值"。
  ⇒ **本文 §1 的行号按收工版（ef6e9d8c…）给**；结论与 §2–§4 的命令输出都在**收工版**上重跑过。
- `individuals.js`（560 行）、`box.js`、`owned-pets.json` 两版相同；`box-individuals.js` 也读过（收工版 21fb3dca…）。
- **边界**：本轮**没有改动任何 src/、tests/、data/**（只有读）；没有写 localStorage；没有清玩家数据；
  **没有重启 8765**；没有提交 git。服务端行为全部在**我自己起的临时实例**（随机端口，跑完即杀）上读的，
  8765 只被 `GET /api/bootstrap` 读过一次（那是已知事实，不是本轮结论的依据）。
  **本轮不需要浏览器探针** ⇒ 没有产生浏览器 profile（若需要，按纪律用专用临时目录）。

---

## 1. Q1：优先级现状 —— 判定分支逐条（file:line + 逐字条件）

### 1.1 入口与两个来源的取法

| # | 位置 | 逐字 | 说明 |
|---|---|---|---|
| 1 | `src/client/box-talent.js:115` | `export function talentReadingOf(individual, {imported = null} = {}) {` | 唯一入口；`imported` 默认 `null` |
| 2 | `src/client/box-talent.js:116` | `const grown = cultivationOf(individual);` | **本机记录**那一份（tier / 指纹 / 来源） |
| 3 | `src/client/box-talent.js:117` | `const qualification = qualificationOf(individual);` | **本机记录**的六项（逐项读数） |
| 4 | `src/client/box-talent.js:118` | `const tier = grown?.tier ?? null;` | 档位只从本机记录来 |
| 5 | `src/client/box-talent.js:119` | `const importedOne = importedReadingOf(imported);` | 导入那一份**只在这里被归一化**，供 ⑦/⑧ 用 |
| 6 | `src/client/box-talent.js:131-132` | `const rolledSource = typeof individual?.talent_source === 'string'\n    && /^rolled/.test(individual.talent_source.trim());` | 来源是"掷的"（**只看本机记录**） |

### 1.2 状态分支（**值全部取自本机记录**；`imported` 一个字都不参与）

| # | 位置 | 逐字条件 | status | 谁说话 |
|---|---|---|---|---|
| ⑦ | `box-talent.js:137` | `if (tier?.label) {` | `tier` | **本机记录**（`cultivationOf().tier`） |
| ⑦a | `box-talent.js:141` | `if (rolledSource) {`（在 ⑦ 内） | — | 只加一句来源说明（`ROLLED_NOTE`）+ `remedy`「用名单那一份重设资质（换一份掷点；这不是游戏真值）」 |
| ⑧ | `box-talent.js:145` | `} else if (qualification.missing.length) {` | `missing` | **本机记录**（缺哪几项） |
| ⑨ | `box-talent.js:151` | `} else if (qualification.hasAny) {` | `unresolved` | **本机记录**（激活几项） |
| ⑨a | `box-talent.js:162` | `if (rolledSource) {`（在 ⑨ 内） | — | 掷点来源 ⇒ `remedy` = `用名单那一份重设资质（换一份掷点；这不是游戏真值）` |
| ⑨b | `box-talent.js:165-169` | `} else {`（在 ⑨ 内） | — | **非掷点来源**（含"名单导入"）⇒ `remedy` = `这一份来自名单（导入字段）—— 它与本机那一份**同样**是建模掷点，这个仓里没有抓包来的资质真值。…不要为了凑档位去改这几个数。` |
| ⑩ | `box-talent.js:171` | `} else {` | `empty` | 本机记录六项全空 |

### 1.3 导入那一份**唯一**会说话的地方（`conflict`）

| # | 位置 | 逐字条件 | 结果 |
|---|---|---|---|
| ⑪ | `box-talent.js:178` | `if (importedOne) {` | 没有导入那一份 ⇒ 整块跳过 |
| ⑫ | `box-talent.js:179` | `const sameLabel = Boolean(importedOne.label && tier?.label && importedOne.label === tier.label);` | 档名逐字相同 |
| ⑬ | `box-talent.js:180-182` | `const sameValues = importedOne.qualification.present.length === qualification.present.length\n      && importedOne.qualification.present.every(\n        (key) => importedOne.qualification.values[key] === qualification.values[key]);` | **项数相同**且导入的每一项都与本机逐值相同 |
| ⑭ | `box-talent.js:183` | `if (!(sameLabel && sameValues)) {` | 两条都相同 ⇒ 不置 conflict；否则置 |
| ⑮ | `box-talent.js:189-190` | `adoptable: status !== 'tier' && importedOne.qualification.activatedCount >= 1\n          && importedOne.qualification.activatedCount <= 3,` | 只决定"重设按钮能不能修好"，**不改值** |

**⇒ "哪一份在什么条件下说话"表**

| 屏幕上的东西 | 谁说话 | 导入那一份的作用 |
|---|---|---|
| 六项资质的数（`qualificationText` / `title`） | **本机记录**（`individual.talent`），**无条件** | 无 |
| 档名 / 激活几项（`tierLabel` / `status`） | **本机记录**（`cultivationOf().tier`，输入是 `talentBase` = 现值扣掉 `talent_boosts`） | 无 |
| 要标"这是掷的"吗（`rolled`） | **本机记录**的 `talent_source` | 无 |
| 「名单那一份：…」那一句 / `conflict` | — | **只在与本机不一致时**（⑭）出现 |
| `remedy` 里"用名单那一份重设资质" | — | 只在"本机是掷点来源"时（⑦a / ⑨a）出现 |
| 玩家点「用名单那一份重设资质」后**写进本机记录**的值 | — | `src/client/box.js:1316-1318` → `resetTalentFromImport()`（`box-individuals.js:177`）；**只改 `talent` 与来源标记**，不动性格/等级/次数 |

**页面实际传参**（不是猜的，是全仓 grep 的全部调用点）：

```
$ grep -rn "talentReadingOf(" src/client/*.js
src/client/box-drawer.js:185:  const reading = talentReadingOf(individual);          ← 不传 imported
src/client/box-drawer.js:275:  const reading = talentReadingOf(individual);          ← 不传
src/client/box-drawer.js:361:    const reading = talentReadingOf(one);               ← 不传
src/client/box.js:320:  const reading = talentReadingOf(one);                        ← 不传
src/client/box.js:941:  const reading = talentReadingOf(individual, {imported: build.importedTalent});   ← 唯一传的一处
```

`build.importedTalent` 来自 `box.js:664 importedTalentOf(player)`：它只读**详情回执** `player.traits`
里的「资质」（六项对象）与「天分档位」（字符串）。⇒ 即使这一处，导入那一份也只进 `conflict`，**不进值**。

---

## 2. Q2：导入字段的真实覆盖率（542 只）

### 2.1 两层都要量：原始数据集 / 服务端投影

```bash
# 复跑：/tmp/xy-t1/u01-coverage.mjs（全文见附录 A.2）
$ node /tmp/xy-t1/u01-coverage.mjs
A. 原始数据集 data/roco/owned/owned-pets.json
   instances=542  talent.value 有值=0  为 null=542  （值形状：{}）
   nature.value 有值=0/542
   specialty.value 有值=0/542
   bloodline.value 有值=12/542
   talent 里除 value 之外有任何非空键的实例 = 542
B. 经 individualsFromDataset() 投影（服务端就是这么算的）
   投影后带值的个体=542/542
   talent_source 前缀分布 = {"rolled":542}
C. 服务端 ?kind=mine 回执：cards=60  total=542  带 individual_label=60
   样本 individual_label = ["性格「稳重」 · 天分 魔攻 10 / 速度 9","性格「稳重」 · 天分 速度 7 / 生命 0","性格「悠闲」 · 天分 魔攻 10 / 物攻 8"]
   ?kind=catalog：cards=5 total=622  带 individual_label=0  带 traits=0
```

**读数**：

| 层 | 「资质」覆盖率 | 那一份是"导入真值"吗 |
|---|---|---|
| 原始数据集 `owned-pets.json`（导入侧） | **0 / 542** | — （值为 `null`） |
| 服务端投影 `withIndividualGrowth()` → `individualFromInstance()` | 542 / 542 **有值** | **不是**：`talent_source` 542/542 以 `rolled` 开头（种子化掷点） |
| 详情回执 `?detail=own-XXXX` 的 `traits.资质` | 有（六项对象） | **不是**：就是上面那一份掷点 |
| 列表卡 `?kind=mine` 的 `traits` | **没有这个键** | 同一份掷点被拼成了 `individual_label` 一句话 |
| 图鉴卡 `?kind=catalog` 的 `traits` / `individual_label` | **两个都没有** | — |

### 2.2 "缺失时是空对象还是没有键？"——逐层形状（逐字）

```bash
# 复跑：/tmp/xy-t1/u01-probe.mjs（全文见附录 A.3）
$ node /tmp/xy-t1/u01-probe.mjs
dataset own-0001 talent.value = {"value":null,"value_source":null,"effect":"UNKNOWN","effect_reason":"面板换算公式未校准（见 10 号文档 §13）","microcase_id":null}
individualFromInstance(dataset行) talent = {"hp":7,"spa":10,"spe":9,"atk":0,"spd":0,"def":0} | talent_source = rolled（原版随机生成；种子化掷点：先掷激活 1–3 条、激活的那几条 7–…
individualFromInstance(本机记录形状) talent = {"hp":7,"spa":10,"spe":9,"atk":0,"spd":0,"def":0}
两边逐值相等 = true
species_tier/seed/counts: overlay 20301 {"instances":542,"species":542,"species_in_layer_playable_48":530,"species_outside_layer_playable_48":12,"same_species_groups":0,"same_species_groups_with_difference":0,"battle_builds":542,"skills_referenced":181}
capabilities.rulesetId = roco-world-s4-2026-09-10

--- 详情 own-0001 HTTP 200 ---
traits: 性格="稳重"[known] | 资质={"hp":7,"spa":10,"spe":9,"atk":0,"spd":0,"def":0}[known] | 特长=null[unknown] | 血脉=null[unknown] | 天分档位="相当好的天分"[known]
card keys: kind,entity,name,group,art,level,badges,traits,skills,metrics,metrics_label,panel,effect_note,mechanism

--- 我的（前2条） HTTP 200 ---
traits: (无)
card keys: select,group,name,alias,types,level,badges,favourite,locked,role_label,support_label,has_moveset,art,has_metrics,effects_calibrated,mechanism,individual_label

--- 图鉴（前2条） HTTP 200 ---
traits: (无)
card keys: select,name,alias,types,form_label,role_label,support_label,has_moveset,art,level,has_metrics,mechanism
```

- 原始数据集：**键在、值是 `null`**（`{value, value_source, effect, effect_reason, microcase_id}` 五键齐、`value:null`）。**不是空对象**。
- 列表卡（我的）：`traits` **键不存在**（`card keys` 里没有 `traits`），只有拼好的 `individual_label`。
- 图鉴卡：`traits` 与 `individual_label` **都没有**。
- 详情回执：`traits` 键存在，`资质` 是六项对象、`status:"known"`（值来自掷点）。

### 2.3 542/542 两边逐值相等（同一个种子、同一个函数）

```bash
# 复跑：/tmp/xy-t1/u01-scale.mjs（全文见附录 A.4）
$ node /tmp/xy-t1/u01-scale.mjs
instances=542  两边 talent 逐值相等=542  不等=0
talent_source==='dataset' 的=0  以 'rolled' 开头的=542
不等样本（前 5）: []
  own-0001: {"hp":7,"spa":10,"spe":9,"atk":0,"spd":0,"def":0}  来源=rolled（原版随机生成；种子化掷点：…
  own-0325: {"hp":7,"spa":8,"atk":0,"spe":0,"spd":0,"def":0}  来源=rolled（原版随机生成；种子化掷点：…
  own-0542: {"hp":8,"atk":8,"spd":9,"spe":0,"spa":0,"def":0}  来源=rolled（原版随机生成；种子化掷点：…
```

**这一条为什么关键**：`individuals.js:116` 的 `const rolled = (nature === null || !rawTalent) ? rollNatureAndTalent(id) : null;`
—— "服务端那一份"与"本机那一份"走的是**同一个** `rollNatureAndTalent(instance_id)`。
542 只里 `rawTalent` 非空的有 **0** 只 ⇒ `dataset` 分支**一次都没被走过**（`talent_source==='dataset'` 的 = 0）。
`individuals.js:189-193` 的注释也写着这条等式（"没刷过的时候两份逐值相等"，实测 `own-0001` 两边都是
`稳重 / 生命7 物攻0 物防0 魔攻10 魔防0 速度9`）—— 本轮在 542 只上把这条等式**全量复验**了一遍。

### 2.4 抓包回执里到底有没有"资质"数据？（免得把"没有"说成"有"）

```bash
$ python3 - <<'PY'    # 全 data 树里找「资质」当 JSON 键、以及"资质 + 六项数值块"的同现
... (脚本见附录 A.5)
PY
data 树里「"资质":」作键的文件 = （无）
同时含「资质」与六项数值块的候选文件 = ['data/roco/derived/on-demand-builds.json', 'data/roco/derived/hke-2026-09-27/pets.json',
 'data/roco/normalized/roco-world-s4-2026-09-10/roster-48.json', 'data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/support-matrix.json',
 'data/roco/owned/owned-pets.json', 'data/roco/raw/extracted/NRC_AI/src/pokemon_db.py']

$ python3 - <<'PY'    # 1120 份抓包回执里，含「资质」两个字的有几份、里面是什么
raw receipts = 1120
含「资质」的回执 = 4
PY
# 那 4 份里「资质」的上下文（逐字）：
"feature": {"name": "“国王”的威严", "description": "鸭吉吉国王的种族资质大幅增加，能耗为1的技能威力+50%。", ...}
```

⇒ 1120 份抓包回执里含「资质」的 4 份，**都是物种特性描述里的"种族资质"四个字**，
不是个体的资质数值块；`data/roco/**` 里**没有任何** `"资质"` 作 JSON 键的记录。
（顺带：`data/roco/owned/owned-pets.json` 的 `source` 是 `"repo_generator_fixed_seed"`、
`generated_by: "scripts/roco/build-owned-pets.mjs"`、`seed: 20301` ⇒ 这 542 只是**固定种子生成的**，
不是抓包来的。）

---

## 3. Q3：若导入字段成为默认，哪些情形会**变差**（逐条具体场景）

> 前提：本文里的"导入字段"对**本仓当前数据**而言 = 服务端 `individualFromInstance()` 掷出来的那一份
> （§2.3）。所以下面既有"数据形状"上的后果，也有"语义/标签"上的后果。

| # | 场景 | 会变差成什么样 | 依据（可复跑） |
|---|---|---|---|
| **S1** | **玩家刷过天分**（本机有 `talent_boosts`；导入那一份没有这条账） | 屏幕「资质」从"刚刷出来的 物攻 9"退回"名单里的 物攻 7"；而同一屏的 60 级面板仍按本机记录算 ⇒ **同屏两个 物攻**。这正是 A7（人类 2026-09-29：「刷新天分没效果」）刚修好的那一族缺陷，只是换成"导入"来犯 | §4 案例 A 输出 |
| **S2** | **导入是旧口径抓包/旧掷点参数**（激活 4 项） | 有档名的一只（本机激活 2〜3 项 ⇒ 「相当好的天分」）会退成 `unresolved`「未定档（激活 4 项）」，并附一句「这一份来源是导入字段（真值）…不要为了凑档位去改这几个数」——**那句话在谎报来源**：这几个数也是掷的，只是掷点参数不同 | §4 案例 C 输出 |
| **S3** | **导入缺项而本机有值**（部分对象） | 六项齐全的一只会被显示成"只有 2 项 + 缺 4 项"（`status=missing`），补救句变成"把缺的补上就能判档" —— 提示玩家去补一份**应用本来就有**的数据 | §4 案例 B 输出 |
| **S4** | **同种多只共用一份（物种层）导入字段** | 两只不同个体显示**同一份资质、同一个档名**，各自的掷点被盖掉；本机记录里它们本来是不同的两只 | §4 案例 D 输出 |
| **S5** | **导入存在但六项全 0**（`values` 是 0 而不是 null） | 屏幕变成"六项全 0 ⇒ 激活 0 项"，看起来像这一只**没有天分**；本机那一份明明有 3 项激活 | §4 案例 E 输出 |
| **S6** | **上游数据重建/换种子** | `owned-pets.json` 是 `fixed_seed` 生成的；上游一旦重建（`build-owned-pets.mjs` 换 seed 或换图层），"导入真值"会**在玩家什么都没做的情况下整体变一遍** —— 而本机记录不会变 ⇒ 玩家看到自己的精灵"天分被改了" | §2.3 命令（`seed: 20301`、`generated_by`）+ §2.1 |
| **S7** | **"真值"标签本身失真** | 三处上屏的来源标记（§31–§33）会变成误导：掷点被标成"名单导入（真值）"，而玩家点「重设资质」正是把它**换成另一份掷点**（`resetTalentFromImport` 会写 `talent_source: 名单导入（…）`）⇒ 屏幕上从此多出一句"这份是真值"的谎 | `box-individuals.js:177-205` + §2.3 |

**反过来说，导入优先在本仓能买到的唯一好处**（我试着找过，只找到这一条）：
§3 S1 之前的状态下两者逐值相同 ⇒ **没有任何一只的初始显示会变**。
也就是说"设为默认"在本仓是**零收益、有明确损失**（S1–S5 至少 5 条）。

---

## 4. Q4：反证 —— "导入优先"确实会出错（纯函数 + 合成数据）

**做法**：定义一个**假设实现** `importedFirstReadingOf()`（导入有值就用导入，本机只当兜底），
复用生产函数 `importedReadingOf()` / `talentReadingOf()` 做读数比对；数据全部是**合成的**，
不读 localStorage、不碰玩家数据、不写文件。脚本：`/tmp/xy-t1/u01-audit.mjs`（全文见附录 A.1）。

```bash
$ node /tmp/xy-t1/u01-audit.mjs
== 案例 A：玩家刚刷过天分（本机有 talent_boosts，导入那一份没有加成的记录）==
  —— 现在的实现（本机为准 + 一致时摆出名单那一份）——
  屏幕资质那一段 = 生命 7 / 物攻 9 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 9
  现在值(cultivationOf.talent) = {"hp":7,"spa":10,"spe":9,"atk":9,"spd":0,"def":0}
  扣掉加成的基础值(talentBase) = {"hp":7,"spa":10,"spe":9,"atk":7,"spd":0,"def":0}
  屏幕会不会说"两边不一致" = true（名单那一份 = 生命 7 / 物攻 7 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 9）
  —— 假设实现（导入优先）——
  imported   source=imported status=unresolved tier=无档名 资质=生命 7 / 物攻 7 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 9 激活=4  rolled=true
             补救=用名单那一份重设资质（换一份掷点；这不是游戏真值）
  ⇒ 玩家刚刷出来的 物攻 9 被换成名单里的 7（屏幕资质 = 生命 7 / 物攻 7 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 9）
  ⇒ 而 60 级面板那一栏读的是本机记录（物攻仍 9）⇒ 同屏两个数

== 案例 B：导入只有部分项，本机六项齐全 ==
  local      source=local-record status=unresolved tier=无档名 资质=生命 7 / 物攻 5 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 9 激活=4  rolled=true
             补救=用名单那一份重设资质（换一份掷点；这不是游戏真值）
  imported   source=imported status=missing tier=无档名 资质=生命 7 / 魔攻 10 激活=2  rolled=true
             补救=把缺的 物攻、物防、魔防、速度 补上就能判档
  —— 现在这条形状在**现有实现**里会怎样（是不是"假冲突"）——
  conflict = true  名单那一份 = "生命 7 / 魔攻 10"
  （导入的 hp/spa 与本机逐值相同、只是项数少 4 项 ⇒ 页面照样说"名单那一份"，看起来像两边打架）

== 案例 C：导入那一份是**旧口径掷点**（激活 4 项），本机是新口径（激活 2 项）==
  local      source=local-record status=tier tier=相当好的天分 资质=生命 0 / 物攻 8 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 7 激活=3  rolled=true
             补救=用名单那一份重设资质（换一份掷点；这不是游戏真值）
  imported   source=imported status=unresolved tier=无档名 资质=生命 5 / 物攻 8 / 魔攻 10 / 物防 6 / 魔防 0 / 速度 0 激活=4  rolled=true
             补救=用名单那一份重设资质（换一份掷点；这不是游戏真值）
  —— 现有实现（本机为准）在这一形状上的补救句（逐字）——
  用名单那一份重设资质（换一份掷点；这不是游戏真值）
  ⇒ 导入优先会让这一只从"有档名"退成"未定档（激活 4 项）"；而现有实现的补救句现在已如实写出"它同样是建模掷点/不是游戏真值"（见上一行逐字）

== 案例 D：同种多只 + 物种层一份导入字段 ==
  D1·local   source=local-record status=tier tier=相当好的天分 资质=生命 0 / 物攻 8 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 7 激活=3  rolled=true
             补救=用名单那一份重设资质（换一份掷点；这不是游戏真值）
  D1·imported source=imported status=tier tier=相当好的天分 资质=生命 0 / 物攻 8 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 7 激活=3  rolled=true
             补救=用名单那一份重设资质（换一份掷点；这不是游戏真值）
  D2·local   source=local-record status=tier tier=还不错的天分 资质=生命 9 / 物攻 0 / 魔攻 0 / 物防 0 / 魔防 8 / 速度 0 激活=2  rolled=true
             补救=用名单那一份重设资质（换一份掷点；这不是游戏真值）
  D2·imported source=imported status=tier tier=相当好的天分 资质=生命 0 / 物攻 8 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 7 激活=3  rolled=true
             补救=用名单那一份重设资质（换一份掷点；这不是游戏真值）
  ⇒ 导入优先下两只不同个体显示**同一份资质/同一档名**（物种层那一份）；本机各自的掷点被盖掉

== 案例 E：导入存在但六项全 0（`values` 是 0 而不是 null）==
  local      source=local-record status=tier tier=相当好的天分 资质=生命 7 / 物攻 0 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 9 激活=3  rolled=true
             补救=用名单那一份重设资质（换一份掷点；这不是游戏真值）
  imported   source=imported status=unresolved tier=无档名 资质=生命 0 / 物攻 0 / 魔攻 0 / 物防 0 / 魔防 0 / 速度 0 激活=0  rolled=true
             补救=用名单那一份重设资质（换一份掷点；这不是游戏真值）

== 案例 F（试过但**没找到**反例的形状）==
  导入与本机逐值相同                  importedReading=reading 实际取源=imported 资质=生命 7 / 物攻 0 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 9 档名=相当好的天分
  导入 label 有、本机无档名（values 相同） importedReading=reading 实际取源=local-record 资质=生命 7 / 物攻 0 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 9 档名=相当好的天分
  导入 values 全 null           importedReading=reading 实际取源=local-record 资质=生命 7 / 物攻 0 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 9 档名=相当好的天分
  导入 values 是字符串数字           importedReading=reading 实际取源=imported 资质=生命 7 / 物攻 0 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 9 档名=相当好的天分
```

⇒ **5 个反证全部成立**：案例 A（盖掉玩家刚刷的加成，且同屏两个数）、B（把齐全的说成缺项）、
C（把有档名打成未定档；顺带核到收工版的补救句已如实写明"同样是建模掷点"）、D（同种多只被同一份盖住）、E（把掷点说成"没有天分"）。

### 4.1 试过但**没找到**反例的形状（如实列出）

（就是上面那段输出的最后 5 行，逐字：）

```text

== 案例 F（试过但**没找到**反例的形状）==
  导入与本机逐值相同                  importedReading=reading 实际取源=imported 资质=生命 7 / 物攻 0 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 9 档名=相当好的天分
  导入 label 有、本机无档名（values 相同） importedReading=reading 实际取源=local-record 资质=生命 7 / 物攻 0 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 9 档名=相当好的天分
  导入 values 全 null           importedReading=reading 实际取源=local-record 资质=生命 7 / 物攻 0 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 9 档名=相当好的天分
  导入 values 是字符串数字           importedReading=reading 实际取源=imported 资质=生命 7 / 物攻 0 / 魔攻 10 / 物防 0 / 魔防 0 / 速度 9 档名=相当好的天分
```

这四种**没有**产生可观测差异（前三种是因为"导入那一份"要么等于本机、要么不构成可用读数；
第四种 `numberOrNull()` 认非空数字串 ⇒ 逐值相同）。**不是"导入优先永远安全"，而是这四种形状恰好等价。**

### 4.2 顺带抓到的一个**现有实现**的次要发现（不是假设）

**导入是"部分项"时，会把"一致"说成"不一致"**：
`box-talent.js:180-182` 的 `sameValues` 先要求 `present.length` **相等**，再逐项比。
于是"导入只有 `{hp:7, spa:10}`、与本机这两项逐值相同"也会判 `conflict`，
屏幕会多印一句「名单那一份：生命 7 / 魔攻 10」，读起来像两边打架 —— 其实只是项数不同（案例 B 那两行读数）。

- **严重度：低**（只是多一句话，不误导数值；且"重设资质"按钮点了也只会写入导入那两项，`filled=2`）。
- **今天的可达性**：`importedTalentOf()`（`box.js:664`）读的是详情回执的 `traits.资质`，
  而那条回执由 `withIndividualGrowth()` 写，值来自 `individualFromInstance()` 的
  `{...zeroTalent(), ...rawTalent}` ⇒ **六项恒齐**（§2.2 实测 `{"hp":7,"spa":10,"spe":9,"atk":0,"spd":0,"def":0}`）。
  ⇒ 在**当前页面链路**上碰不到；只有将来换一个会漏键的抽取器才会碰到。
- **建议**：若要与"不一致"这个语义严格对齐，把 `sameValues` 改成"导入**每一个有值的项**都与本机相同"，
  并把项数差异放到另一句里说（"名单那一份只给了 2 项"）。**本轮不改**（审核任务，写域只有本报告）。

---

## 5. 给决策用的一句话建议（不改 src）

- **不要把导入字段设为默认**。在本仓它 `talent_source` 542/542 都是 `rolled`，与"真值优先"没有关系；
  设成默认的收益是 0（§3 末），代价是 S1–S5 至少 5 条**玩家看得见**的退步，其中 S1 正是 A7 刚修好的那一族。
- 若将来真的有**抓包真值**进入这条链路（`talent.value` 非 null 的实例、或 `rawReceipt` 里出现个体资质块），
  正确的形状也不是"把显示默认切过去"，而是**已有的那条路**：
  `conflict` 如实并列 + 玩家点「用名单那一份重设资质」→ `resetTalentFromImport()`（只改 `talent`、留 `talent_before_import`、不动次数）。
  那时"导入优先"才有意义 —— 而且应当是**"导入真值 + 一次可回滚的采纳"**，不是"读时静默覆盖"。
- **措辞这一条 Lead 已经改了**（12:33:29 那一版）：`box-talent.js:133-135` 的 `ROLLED_NOTE` 与
  `:143`/`:164` 的 remedy 现在写的是「换一份掷点；这不是游戏真值」，`:166-169` 那一支也如实写了
  「它与本机那一份**同样**是建模掷点，这个仓里没有抓包来的资质真值」—— 与本文 §2 的读数一致。
  ⇒ **剩下一条小的（加性、一行）**：`src/client/box-individuals.js:177` 的默认 `source` 仍是
  `'抓包回执的「资质」栏'`，写进记录的 `talent_source` 就是
  `` `名单导入（抓包回执的「资质」栏；这一只原来的资质是本机旧口径掷出来的）` ``（`:197`）。
  在那份数据里，"抓包回执的资质栏"装的是**掷点**（§2.3）⇒ 这句话本身在暗示"抓到过真值"。
  建议：采纳时把"这一份是**掷点**还是**真值**"一起记进去（由调用方带，取值只有这两种），
  ⑨b 那一支就能按它说话，而不用像现在这样从 `talent_source` 的中文前缀反推。

---

## 6. 未验证 / 边界说明

- **审核期间 `box-talent.js` 被上游改过一次**（12:33:29，261→271 行）：优先级语义未变，措辞按本文 §2 改了；
  本文 §1 的行号、§2–§4 的命令输出都是**收工版**上重跑/重读的（§0 有两版 sha256）。
- 本轮**没有**在真 8765 上重跑浏览器读数：§1 的分支与 §2 的覆盖率都是**纯函数 + 临时实例 HTTP** 就能定的，
  不需要浏览器。真 8765 上"三处来源标记"的读数见 BATCH-1 §31–§33（Lead 已有）。
- **没有**验证"玩家真实 profile 里的本机记录覆盖率"（那要读 localStorage / 玩家数据 —— 本轮边界禁止）。
  本文说的 542 是**数据集**那一侧；本机记录里有多少只是另一件事（`?kind=mine` 打开过几只就有几只）。
- §4 案例 D 的"物种层一份导入字段"在**当前链路**上不可达：实测 `?detail=pet_000004`（物种）**没有 `traits`**、
  `?kind=catalog` 卡也**没有** `traits` / `individual_label`
  （`/tmp/xy-t1/u01-species.mjs`，输出见下）。它是"如果将来加了物种层字段会怎样"的形状，不是今天的缺陷。
- `box-talent.js` / `individuals.js` 在收工时仍是开工时那两个 sha256（§0）⇒ 行号有效；若 Lead 之后再改，
  以 `talentReadingOf` 的函数名与逐字条件为准重新定位。

```bash
# 物种层有没有那一份（复跑：/tmp/xy-t1/u01-species.mjs，全文见附录 A.6）
$ node /tmp/xy-t1/u01-species.mjs
detail=pet_000004 HTTP 200 | player keys: kind,entity,name,alias,types,form_label,role_label,support_label,metrics,metrics_label,metrics_total,metrics_missing_reason,moveset,moveset_note,panel,effect_note,mechanism
   traits: (无)
detail=own-0004 HTTP 200 | player keys: kind,entity,name,group,art,level,badges,traits,skills,metrics,metrics_label,panel,effect_note,mechanism
   traits: 性格="专注" | 资质={"atk":7,"spd":7,"def":10,"spa":0,"hp":0,"spe":0} | 特长=null | 血脉=null | 天分档位="相当好的天分"
detail=own-0001 HTTP 200 | player keys: kind,entity,name,group,art,level,badges,traits,skills,metrics,metrics_label,panel,effect_note,mechanism
   traits: 性格="稳重" | 资质={"hp":7,"spa":10,"spe":9,"atk":0,"spd":0,"def":0} | 特长=null | 血脉=null | 天分档位="相当好的天分"
```

---

## 附录 A：复跑脚本（逐字，/tmp 目录会被清，脚本正文以此为准）

> 下文 `<repo>` = `/Users/serendizc/Developer/roco-coach`。

### A.1 `/tmp/xy-t1/u01-audit.mjs`（§4 反证，**全文**；输出已按收工版重跑）

```js
// U01 审核 ③④：把「导入优先」当成**假设实现**跑起来，看它在哪些合成形状上出错。
// 纯函数 + 合成数据；不读 localStorage、不碰玩家数据、不写任何文件。
import {talentReadingOf, importedReadingOf, qualificationOf} from '<repo>/src/client/box-talent.js';
import {cultivationOf} from '<repo>/src/coach/individuals.js';

/** 假设实现：**导入优先**（本机记录只当兜底）。判据只读它暴露的 reading，便于逐条比对。 */
function importedFirstReadingOf(individual, {imported = null} = {}) {
  const imp = importedReadingOf(imported);
  const useImported = Boolean(imp?.qualification?.hasAny);
  const basis = useImported ? {...individual, talent: {...imp.qualification.values}} : individual;
  return {source: useImported ? 'imported' : 'local-record',
    reading: talentReadingOf(basis, {imported: null})};
}
const show = (tag, r) => console.log(`  ${tag.padEnd(10)} source=${r.source === 'imported' ? 'imported' : 'local-record'}`
  + ` status=${r.reading.status} tier=${r.reading.tierLabel ?? '无档名'} 资质=${r.reading.qualificationText}`
  + ` 激活=${r.reading.activatedCount}  rolled=${r.reading.rolled}`
  + `\n             补救=${r.reading.remedy ?? '—'}`);

console.log('== 案例 A：玩家刚刷过天分（本机有 talent_boosts，导入那一份没有加成的记录）==');
// 本机：rolled 基线 + 刷出来的 +2 物攻（与 rollTalentStat 的写法同形：boosts 记录每一级）
const localA = {individual_id: 'own-A', level: 60, nature: '稳重', talent: {hp: 7, spa: 10, spe: 9, atk: 9, spd: 0, def: 0},
  talent_boosts: [{tier: 1, stat: 'atk', delta: 2}], talent_source: 'rolled（…非人工）', refreshes: {nature: 3, talent: 3}};
const importedA = {values: {hp: 7, spa: 10, spe: 9, atk: 7, spd: 0, def: 0}, label: '相当好的天分', source: '抓包名单（导入字段）'};
const localReadingA = talentReadingOf(localA, {imported: importedA});
console.log('  —— 现在的实现（本机为准 + 一致时摆出名单那一份）——');
console.log(`  屏幕资质那一段 = ${localReadingA.qualificationText}`);
console.log(`  现在值(cultivationOf.talent) = ${JSON.stringify(cultivationOf(localA).talent)}`);
console.log(`  扣掉加成的基础值(talentBase) = ${JSON.stringify(cultivationOf(localA).talentBase)}`);
console.log(`  屏幕会不会说"两边不一致" = ${Boolean(localReadingA.conflict)}（名单那一份 = ${localReadingA.conflict?.valuesText ?? '—'}）`);
console.log('  —— 假设实现（导入优先）——');
const impA = importedFirstReadingOf(localA, {imported: importedA});
show('imported', impA);
console.log(`  ⇒ 玩家刚刷出来的 物攻 9 被换成名单里的 7（屏幕资质 = ${impA.reading.qualificationText}）`);
console.log(`  ⇒ 而 60 级面板那一栏读的是本机记录（物攻仍 9）⇒ 同屏两个数`);

console.log('\n== 案例 B：导入只有部分项，本机六项齐全 ==');
const localB = {individual_id: 'own-B', level: 60, nature: '稳重', talent: {hp: 7, atk: 5, def: 0, spa: 10, spd: 0, spe: 9},
  talent_source: 'rolled（…非人工）'};
const importedB = {values: {hp: 7, spa: 10}, label: '相当好的天分', source: '抓包名单（导入字段）'};
show('local', {source: 'local', reading: talentReadingOf(localB)});
show('imported', importedFirstReadingOf(localB, {imported: importedB}));
console.log('  —— 现在这条形状在**现有实现**里会怎样（是不是"假冲突"）——');
const nowB = talentReadingOf(localB, {imported: importedB});
console.log(`  conflict = ${Boolean(nowB.conflict)}  名单那一份 = ${JSON.stringify(nowB.conflict?.valuesText)}`);
console.log('  （导入的 hp/spa 与本机逐值相同、只是项数少 4 项 ⇒ 页面照样说"名单那一份"，看起来像两边打架）');

console.log('\n== 案例 C：导入那一份是**旧口径掷点**（激活 4 项），本机是新口径（激活 2 项）==');
const localC = {individual_id: 'own-C', level: 60, nature: '稳重', talent: {hp: 0, atk: 8, def: 0, spa: 10, spd: 0, spe: 7},
  talent_source: 'rolled（…非人工）'};
const importedC = {values: {hp: 5, atk: 8, def: 6, spa: 10, spd: 0, spe: 0}, label: null, source: '抓包名单（导入字段）'};
show('local', {source: 'local', reading: talentReadingOf(localC)});
show('imported', importedFirstReadingOf(localC, {imported: importedC}));
const nowC = talentReadingOf(localC, {imported: importedC});
console.log(`  —— 现有实现（本机为准）在这一形状上的补救句（逐字）——\n  ${nowC.remedy}`);
console.log('  ⇒ 导入优先会让这一只从"有档名"退成"未定档（激活 4 项）"；'
  + '而现有实现的补救句现在已如实写出"它同样是建模掷点/不是游戏真值"（见上一行逐字）');

console.log('\n== 案例 D：同种多只 + 物种层一份导入字段 ==');
const oneD = {individual_id: 'own-D1', level: 60, nature: '稳重', talent: {hp: 0, atk: 8, def: 0, spa: 10, spd: 0, spe: 7}, talent_source: 'rolled（…非人工）'};
const twoD = {individual_id: 'own-D2', level: 60, nature: '悠闲', talent: {hp: 9, atk: 0, def: 0, spa: 0, spd: 8, spe: 0}, talent_source: 'rolled（…非人工）'};
const speciesImported = {values: {hp: 0, atk: 8, def: 0, spa: 10, spd: 0, spe: 7}, label: '相当好的天分', source: '抓包名单（物种层）'};
show('D1·local', {source: 'local', reading: talentReadingOf(oneD)});
show('D1·imported', importedFirstReadingOf(oneD, {imported: speciesImported}));
show('D2·local', {source: 'local', reading: talentReadingOf(twoD)});
show('D2·imported', importedFirstReadingOf(twoD, {imported: speciesImported}));
console.log('  ⇒ 导入优先下两只不同个体显示**同一份资质/同一档名**（物种层那一份）；本机各自的掷点被盖掉');

console.log('\n== 案例 E：导入存在但六项全 0（`values` 是 0 而不是 null）==');
const localE = {individual_id: 'own-E', level: 60, nature: '稳重', talent: {hp: 7, atk: 0, def: 0, spa: 10, spd: 0, spe: 9}, talent_source: 'rolled（…非人工）'};
const importedE = {values: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0}, label: null, source: '抓包名单（导入字段）'};
show('local', {source: 'local', reading: talentReadingOf(localE)});
show('imported', importedFirstReadingOf(localE, {imported: importedE}));

console.log('\n== 案例 F（试过但**没找到**反例的形状）==');
const shapes = [
  ['导入与本机逐值相同', {hp: 7, atk: 0, def: 0, spa: 10, spd: 0, spe: 9}],
  ['导入 label 有、本机无档名（values 相同）', null],
  ['导入 values 全 null', {hp: null, atk: null, def: null, spa: null, spd: null, spe: null}],
  ['导入 values 是字符串数字', {hp: '7', atk: '0', def: '0', spa: '10', spd: '0', spe: '9'}],
];
for (const [tag, values] of shapes) {
  const local = {individual_id: 'own-F', level: 60, nature: '稳重', talent: {hp: 7, atk: 0, def: 0, spa: 10, spd: 0, spe: 9}, talent_source: 'rolled（…非人工）'};
  const imported = values ? {values, label: '相当好的天分', source: '抓包名单（导入字段）'}
    : {values: null, label: '相当好的天分', source: '抓包名单（导入字段）'};
  const imp = importedReadingOf(imported);
  const r = importedFirstReadingOf(local, {imported});
  console.log(`  ${tag.padEnd(26)} importedReading=${imp ? 'reading' : 'null'} 实际取源=${r.source} 资质=${r.reading.qualificationText} 档名=${r.reading.tierLabel ?? '无'}`);
}
```

### A.2 `/tmp/xy-t1/u01-coverage.mjs`（§2.1）

```js
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {individualsFromDataset} from '<repo>/src/coach/individuals.js';
const ds = JSON.parse(readFileSync('<repo>/data/roco/owned/owned-pets.json', 'utf8'));
const rows = ds.instances;
const nonNull = (v) => v !== null && v !== undefined;
let rawHas = 0, rawNull = 0;
for (const r of rows) { const v = r.talent?.value ?? null; if (nonNull(v)) rawHas += 1; else rawNull += 1; }
console.log(`instances=${rows.length}  talent.value 有值=${rawHas}  为 null=${rawNull}`);
for (const field of ['nature', 'specialty', 'bloodline']) {
  let has = 0; for (const r of rows) if (nonNull(r[field]?.value ?? null)) has += 1;
  console.log(`${field}.value 有值=${has}/${rows.length}`);
}
const list = individualsFromDataset(ds, {level: 60});
const srcCount = {}; for (const one of list) srcCount[one.talent_source.slice(0, 6)] = (srcCount[one.talent_source.slice(0, 6)] ?? 0) + 1;
console.log(`投影后带值的个体=${list.filter((o) => o.talent && Object.values(o.talent).some((v) => v > 0)).length}/${list.length}`);
console.log(`talent_source 前缀分布 = ${JSON.stringify(srcCount)}`);
// 服务端回执：?kind=mine / ?kind=catalog 的 individual_label 覆盖率
const srv = spawn('node', ['/tmp/xy-t1/serve.mjs', '<repo>'], {cwd: '<repo>', stdio: ['ignore', 'pipe', 'pipe']});
let out = ''; srv.stdout.on('data', (d) => { out += String(d); });
for (let i = 0; i < 120 && !/PORT \d+/.test(out); i += 1) await new Promise((r) => setTimeout(r, 250));
const base = `http://127.0.0.1:${Number((out.match(/PORT (\d+)/) ?? [])[1])}/`;
const mine = await (await fetch(base + 'api/roco/box?kind=mine&limit=60', {cache: 'no-store'})).json();
const cards = mine.player?.cards ?? [];
console.log(`?kind=mine：cards=${cards.length} total=${mine.player?.total} 带 individual_label=${cards.filter((c) => c.individual_label).length}`);
const cat = await (await fetch(base + 'api/roco/box?kind=catalog&limit=5', {cache: 'no-store'})).json();
const catCards = cat.player?.cards ?? [];
console.log(`?kind=catalog：cards=${catCards.length} total=${cat.player?.total} 带 individual_label=${catCards.filter((c) => c.individual_label).length} 带 traits=${catCards.filter((c) => Array.isArray(c.traits)).length}`);
srv.kill('SIGKILL'); process.exit(0);
```

### A.3 `/tmp/xy-t1/u01-probe.mjs`（§2.2，**全文**）

```js
// U01 审核：导入字段到底从哪儿来（只读；临时实例，不碰 8765）
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {individualFromInstance} from '<repo>/src/coach/individuals.js';

// ① 纯函数层：把 dataset 里的原始实例喂进 individualFromInstance（服务端 withIndividualGrowth 用的就是它）
const ds = JSON.parse(readFileSync('<repo>/data/roco/owned/owned-pets.json', 'utf8'));
const raw = ds.instances.find((r) => r.instance_id === 'own-0001');
console.log('dataset own-0001 talent.value =', JSON.stringify(raw.talent));
const fromRaw = individualFromInstance({...raw, level: 60}, {level: 60});
console.log('individualFromInstance(dataset行) talent =', JSON.stringify(fromRaw.talent),
  '| talent_source =', fromRaw.talent_source.slice(0, 40) + '…');
// 本机记录那一份（localStorage 里存的形状）：nature/talent 的 value 都是 null
const fromLocalShape = individualFromInstance({...raw, nature: {value: null}, talent: {value: null}}, {level: 60});
console.log('individualFromInstance(本机记录形状) talent =', JSON.stringify(fromLocalShape.talent));
console.log('两边逐值相等 =', JSON.stringify(fromRaw.talent) === JSON.stringify(fromLocalShape.talent));
console.log('species_tier/seed/counts:', raw.species_tier, ds.seed, JSON.stringify(ds.counts));

// ② 服务端回执层：真 HTTP 读一条详情 + 一页图鉴卡（临时实例）
const srv = spawn('node', ['/tmp/xy-t1/serve.mjs', '<repo>'],
  {cwd: '<repo>', stdio: ['ignore', 'pipe', 'pipe']});
let out = ''; srv.stdout.on('data', (d) => { out += String(d); });
for (let i = 0; i < 120 && !/PORT \d+/.test(out); i += 1) await new Promise((r) => setTimeout(r, 250));
const base = `http://127.0.0.1:${Number((out.match(/PORT (\d+)/) ?? [])[1])}/`;
const boot = await (await fetch(base + 'api/bootstrap', {cache: 'no-store'})).json();
console.log('capabilities.rulesetId =', boot.capabilities?.rulesetId);
for (const [label, path] of [
  ['详情 own-0001', 'api/roco/box?detail=own-0001'],
  ['我的（前2条）', 'api/roco/box?kind=mine&limit=2'],
  ['图鉴（前2条）', 'api/roco/box?kind=catalog&limit=2'],
]) {
  const r = await fetch(base + path, {cache: 'no-store'});
  const d = await r.json();
  const row = label.startsWith('详情') ? d.player
    : (d.player?.cards ?? [])[0] ?? null;
  const traits = (row?.traits ?? []).map((t) => `${t.label}=${JSON.stringify(t.value)}[${t.status}]`);
  console.log('\n---', label, 'HTTP', r.status, '---');
  console.log('traits:', traits.join(' | ') || '(无)');
  console.log('card keys:', row ? Object.keys(row).join(',') : '(无)');
  if (row?.talent_tier) console.log('talent_tier:', JSON.stringify(row.talent_tier));
}
srv.kill('SIGKILL');
process.exit(0);
```

### A.4 `/tmp/xy-t1/u01-scale.mjs`（§2.3，**全文**）

```js
// 542/542 两边逐值相等？——数据集那一份与本机记录形状那一份喂进**同一个** individualFromInstance
import {readFileSync} from 'node:fs';
import {individualFromInstance} from '<repo>/src/coach/individuals.js';
const ds = JSON.parse(readFileSync('<repo>/data/roco/owned/owned-pets.json', 'utf8'));
let same = 0, diff = 0, datasetBranch = 0, rolledBranch = 0, diffs = [];
for (const row of ds.instances) {
  const a = individualFromInstance({...row, level: 60}, {level: 60});
  const b = individualFromInstance({...row, nature: {value: null}, talent: {value: null}}, {level: 60});
  if (JSON.stringify(a.talent) === JSON.stringify(b.talent)) same += 1; else { diff += 1; diffs.push(row.instance_id); }
  if (a.talent_source === 'dataset') datasetBranch += 1; else rolledBranch += 1;
}
console.log(`instances=${ds.instances.length}  两边 talent 逐值相等=${same}  不等=${diff}`);
console.log(`talent_source==='dataset' 的=${datasetBranch}  以 'rolled' 开头的=${rolledBranch}`);
console.log('不等样本（前 5）:', diffs.slice(0, 5));
// 同一个种子 ⇒ 值只由 instance_id 决定：抽 3 只打印
for (const id of ['own-0001', 'own-0325', 'own-0542']) {
  const row = ds.instances.find((r) => r.instance_id === id);
  const one = individualFromInstance({...row, level: 60}, {level: 60});
  console.log(`  ${id}: ${JSON.stringify(one.talent)}  来源=${one.talent_source.slice(0, 20)}…`);
}
```

### A.5 §2.4 的扫描脚本（Python，逐字）

```python
import json, glob, os, re
key_hits, six_hits = [], []
pat_key = re.compile(r'"资质"\s*:')
pat_six = re.compile(r'"(hp|生命)"\s*:\s*\d+\s*,\s*"[^"]*"\s*:\s*\d+')
for path in glob.glob('data/roco/**/*', recursive=True):
    if not os.path.isfile(path): continue
    if path.endswith(('.gz','.tar','.png','.jpg','.webp','.pyc','.db')): continue
    if os.path.getsize(path) > 60_000_000: continue
    try: txt = open(path, encoding='utf-8', errors='ignore').read()
    except Exception: continue
    if pat_key.search(txt): key_hits.append(path)
    if '资质' in txt and pat_six.search(txt): six_hits.append(path)
print('「"资质":」作键的文件 =', key_hits or '（无）')
print('同时含「资质」与六项数值块 =', six_hits or '（无）')
# 抓包回执那一份：
raws = sorted(glob.glob('data/roco/raw/hke-2026-09-27/raw/*.json'))
print('raw receipts =', len(raws), '含「资质」=', sum(1 for p in raws if '资质' in open(p, encoding='utf-8', errors='ignore').read()))
```

### A.6 `/tmp/xy-t1/u01-species.mjs`（§6，**全文**）

```js
import {spawn} from 'node:child_process';
const srv = spawn('node', ['/tmp/xy-t1/serve.mjs', '<repo>'],
  {cwd: '<repo>', stdio: ['ignore', 'pipe', 'pipe']});
let out = ''; srv.stdout.on('data', (d) => { out += String(d); });
for (let i = 0; i < 120 && !/PORT \d+/.test(out); i += 1) await new Promise((r) => setTimeout(r, 250));
const base = `http://127.0.0.1:${Number((out.match(/PORT (\d+)/) ?? [])[1])}/`;
for (const q of ['detail=pet_000004', 'detail=own-0004', 'detail=own-0001']) {
  const r = await fetch(base + 'api/roco/box?' + q, {cache: 'no-store'});
  const d = await r.json();
  const row = d.player ?? null;
  const traits = (row?.traits ?? []).map((t) => `${t.label}=${JSON.stringify(t.value).slice(0, 60)}`);
  console.log(q, 'HTTP', r.status, '| player keys:', row ? Object.keys(row).join(',') : `(error: ${d.error})`);
  console.log('   traits:', traits.join(' | ') || '(无)');
}
srv.kill('SIGKILL'); process.exit(0);
```

> 说明：`/tmp/xy-t1/serve.mjs` 是"起一个跑指定仓库树的临时实例（随机端口）"的小启动器
> （`createCoachServer({semantic:false}).listen(0,'127.0.0.1')` 并打印 `PORT n`）；正文见 BATCH-1 相关小节同一套做法。
