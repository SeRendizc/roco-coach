# FEASIBILITY-547-A：冻结配招层（48 条）的构建链 —— 只读侦察事实清单

> 本文全部结论来自**只读**命令（`read` / `grep` / `node -e` / `node ... --verify`），
> 没有修改任何仓库文件（唯一新增文件就是本文）。所有数字都是本次实测输出，不是估算。
> 时间：2026-09-28 侦察轮。

---

## ① 一句话结论

**48 条不是一个脚本生成的，是两条链拼的**：12 条来自 `scripts/roco/import-snapshot.mjs`（直接读
wiki 快照 Lua，**带等级**），36 条来自 `scripts/roco/build-roster-48-engine-inputs.mjs`（读的是
`tmp/roco-full-catalog.json`，而那份导出**把等级/阶段/血脉名丢掉了**，所以 36 条全是 `null`）；
生成脚本**不能直接吃抓包 `skill_list`**——抓包那条路**每条技能根本没有 id、也没有等级**，
只有一个 `name`，必须靠「技能名 → `skills.json` 的 `skill_id`」补一层映射（本次实测这层映射
在抓包现有 27,482 条技能 / 547 个不同技能名上是 1:1 可行的，0 个查不到、0 个重名）；
跳过 574 只**不是数据没有**，主要是**没构建**（540/547 只抓包精灵能对到图鉴里带完整学招表的那一条，
等级信息从 wiki 侧拿得到），但**执行域的读入路径被硬编码成唯一一个目录名**
（`roco/src/roco_env/data.py:22`），这才是「扩到 547」真正的结构性卡点。

---

## A. 48 条是谁、用什么脚本、从什么源生成的

### A-1 结论

| 层 | 条数 | 生成脚本 | 直接输入 | 最终源 |
|---|---:|---|---|---|
| 基线 | **12** | `scripts/roco/import-snapshot.mjs` | `data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/{Catalog,Learnsets}.lua` | wiki 快照 `wiki-rocom-snapshot` |
| 叠加层 | **36** | `scripts/roco/build-roster-48-engine-inputs.mjs` | `tmp/roco-full-catalog.json` + 基线三份 + `skills.json` + `roster-48.json` + 审计产物 | 同上（`tmp/roco-full-catalog.json` 由 `scripts/roco/export-full-catalog.mjs` 从同一份 Lua 导出） |

- 12 + 36 = 48，且**两边 pet_id 完全不重叠**（实测 `overlap = 0`，并集 48）。
  命令与输出：

  ```
  $ node -e "...读两份 learnsets.json 取键集合..."
  base= 12 layer= 36 overlap= 0
  union= 48
  ```

- wiki 快照**还在仓库里**，没丢。路径见 A-4。

### A-2 叠加层脚本的入参 / 技能池 / native_skills 算法（逐行）

文件：`scripts/roco/build-roster-48-engine-inputs.mjs`（563 行）

**入参（7 个路径，全部先做存在性检查）**——`:50-58` 定义、`:81-106` `loadInputs()`：

| 行 | 常量 | 实际路径 |
|---|---|---|
| `:52` | `NORM` | `data/roco/normalized/roco-world-s4-2026-09-10` |
| `:53` | `LAYER_DIR` | `…/layer-playable-48` |
| `:54` | `STORE` | `data/roco/normalized/<ruleset>/roster-48.json` |
| `:55` | `AUDIT` | `reports/roco/coverage/roster-48.json` |
| `:56` | `CATALOG` | `tmp/roco-full-catalog.json` |
| `:83-86` | 基线三份 + 技能表 | `…/{pets,learnsets,support-matrix,skills}.json` |
| `:58` | `TRAIT_STATUS` | `data/roco/engine-trait-status.json`（可选） |

- `:91-95`：任一输入缺失即 `problemsOrExit()` → **退出 1**，并提示用 `npm run roco:full-catalog` 重导。
- `:97-105`：读入后按 `{path, text, json}` 保存（`text` 后面用来算 sha256）。

**技能池 `poolOf()`**——`:108-113`：

```js
108: /** 每只精灵自己的技能池（固有 + 血脉 + 技能石）。 */
109: const poolOf = (learnset) => new Set([
110:   ...(learnset?.native ?? []),
111:   ...(learnset?.blood ?? []),
112:   ...(learnset?.stones ?? []),
113: ]);
```

⇒ 就是 `native ∪ blood ∪ stones`，和引擎侧 `Learnset.all_skill_ids`（见 C）**同口径**。

**`native_skills` 到底怎么算出来的**——`:289-341`（组装循环），关键三行：

```js
295:     const native = [...(catLearnset.native ?? [])];
296:     const blood  = [...(catLearnset.blood  ?? [])];
297:     const stones = [...(catLearnset.stones ?? [])];
...
337:     native_skills: native.map((sid) => ({skill_id: sid, level: null, stage: null, level_status: 'not_provided_by_source'})),
338:     blood_skills:  blood.map((sid) => ({skill_id: sid, blood: null, level: null, blood_status: 'not_provided_by_source'})),
339:     skill_stones:  stones,
```

其中 `catLearnset` = `tmp/roco-full-catalog.json` 的 `learnsets[entry.learnset_id]`（`:294`）。
⇒ **等级写 `null` 不是"源没有"，是这一层输入里就没有**：`:37-38` 的纪律注释与 `:460-461` 的 `note`
说的都是「全量图鉴导出里没有」。

**为什么"导出里没有"（根因）**——`scripts/roco/export-full-catalog.mjs`：

```js
19: const RAW = ROOT + 'data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/';
27: const catalogPath   = RAW + 'Catalog.lua';
28: const learnsetsPath = RAW + 'Learnsets.lua';
29: const catalog   = parseLuaTable(readFileSync(catalogPath, 'utf8'),   { file: 'Catalog.lua' }).root;
30: const learnsets = parseLuaTable(readFileSync(learnsetsPath, 'utf8'), { file: 'Learnsets.lua' }).root;
...
53:     native: arr(l.native_skills).map((x) => x.skill).filter(Boolean),   // ← 只取 skill，丢掉 level/stage
54:     blood:  arr(l.blood_skills).map((x) => x.skill).filter(Boolean),    // ← 丢掉 blood/level
55:     stones: arr(l.skill_stones).filter(Boolean),
```

**上游 Lua 里其实是有等级的**（实测，`Learnsets.lua` 全文只有 1 行，`learnset_5ccca003e3ca` 位于第 1 行、
字符偏移 190,629；同一文件里 `native_skills={{level=1,skill="skill_000472",stage=1},…}` 的写法到处都在）：

```
learnset_5ccca003e3ca={blood_skills={{blood="普通",level=15,skill="skill_000287"},{blood="草",level=15,…}},…
```

对照：基线 12 条走的是 `import-snapshot.mjs` → `schema.mjs:102-120` 的 `normalizeLearnset()`，
它**保留了** `level` / `stage` / `blood`：

```js
112:     native_skills: arr(learnset.native_skills).map((e) => ({
113:       level: e.level ?? null, skill_id: e.skill ?? null, stage: e.stage ?? null,
114:     })),
115:     blood_skills: arr(learnset.blood_skills).map((e) => ({
116:       blood: e.blood ?? null, level: e.level ?? null, skill_id: e.skill ?? null,
117:     })),
```

⇒ **36 条 layer 的 `null` 是导出环节的字段裁剪造成的，不是快照缺失。** 想让 36 条带上等级，
把 `export-full-catalog.mjs:53-55` 的裁剪改成保留对象即可（本次只读，未改）。

### A-3 48 条的落库位置与自证字段

- `data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/learnsets.json`
  - `:4` `"layer": "layer-playable-48"`
  - `:5` `"source_id": "wiki-rocom-snapshot"`
  - `:6` `"source_revision": "aff808eb60003457fe8a260d1ac3c9bd95d53872"`
  - `:11` `"generated_by": "scripts/roco/build-roster-48-engine-inputs.mjs"`
  - `:12-20` `"generated_from"`：7 个输入的 sha256
  - `:21` `"level_status": "not_provided_by_source"`
  - `:24` `"learnset_count": 36`
  - 单条形状：`{learnset_id, pet_id, feature_skill_id, native_skills[], blood_skills[], skill_stones[], orphan_skill_refs[]}`（实测 36 条键集完全一致）
- `data/roco/normalized/roco-world-s4-2026-09-10/learnsets.json`：无 `generated_by`（只有 `schema_version/ruleset_id/game/source_id/source_revision/learnset_count/learnsets`，`:1-7`），`learnset_count: 12`；写入点是 `scripts/roco/import-snapshot.mjs:271-275`，来源文件登记在 `:279` 与 `:486`。

### A-4 源在不在？——在

实测命令与输出：

```
$ find . -maxdepth 6 -name "*wiki-rocom*" -not -path "./.git/*"
（空 —— 没有以名字命名的目录）
$ ls -la data/roco/raw/rocom-wiki-data.tar.gz
-rw-r--r--  860689  data/roco/raw/rocom-wiki-data.tar.gz
$ find data/roco/raw/extracted/rocom-wiki-data -type f | wc -l
21
```

- 快照定义：`data/roco/sources.yaml:35-51`（`source_id: wiki-rocom-snapshot`，仓库 `JayeGT002/rocom-wiki-data`，
  `revision: aff808eb…`，`archive_path: data/roco/raw/rocom-wiki-data.tar.gz`，`archive_sha256: 5cc6822a…`，
  `extracted_to: data/roco/raw/extracted/rocom-wiki-data`）。
- 解包目录（21 个文件）里三份关键 Lua 都在：
  `…/wiki_modules/Pets/data/{Catalog.lua, Learnsets.lua, Skills.lua}`（另有 `Types/Terms/History/SkillStoneTopics/…`）。
- `Learnsets.lua` 里学招表总数 **312** 张（实测 `tmp/roco-full-catalog.json` 的 `learnsets` 键数 = 312）。

### A-5 一条顺带实测到的事实：现在这层已经跟自己的生成器对不上了

```
$ node scripts/roco/build-roster-48-engine-inputs.mjs --verify
✖ 叠加层与磁盘不一致（重新运行不带 --verify 即可刷新）
  · data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/pets.json 与重新生成的结果不一致
    （75609 vs 82540 字节；sha256 666f5d3d7d30 vs 79fce430d0aa）
  · …/layer-playable-48/learnsets.json 与重新生成的结果不一致
    （220041 vs 220041 字节；sha256 939b586256fd vs beb10e377c10）
  · …/layer-playable-48/support-matrix.json 与重新生成的结果不一致
    （195439 vs 195439 字节；sha256 b9a58b7230dd vs 2eda270000cc）
```

逐条查到两个原因（都是实测，不是推测）：

1. **基线 `pets.json` 已经漂移**：`layer-playable-48/learnsets.json` 里记录的 7 个输入哈希，
   6 个与磁盘一致、`…/pets.json` **不一致**（记录 `8ba09fd7a05e1d02…` vs 磁盘 `59ae9e186847a023…`）。
   这解释了「learnsets / support-matrix 字节数一样、sha 不同」——那两个文件里只有内嵌的
   `generated_from` 变了，而 sha256 是定长。
2. **`layer-playable-48/pets.json` 被另一个脚本用另一种缩进重写过**：
   实测第 2 行缩进 `layer-playable-48/pets.json = 1 空格`、`…/layer-playable-48/learnsets.json = 2 空格`、
   基线 `pets.json = 1 空格`、`full-catalog.json = 1 空格`；而本层生成器写的是 **2 空格**
   （`build-roster-48-engine-inputs.mjs:69`：`JSON.stringify(doc, null, 2)`）。
   1 空格 ↔ 2 空格的差别正好解释 `75609 → 82540` 这 6,931 字节。改用 1 空格写盘的是
   `scripts/roco/apply-capture-to-engine.mjs:96` / `:113`，它的 `TARGETS`（`:27-30`）就是基线 `pets.json`
   与 `layer-playable-48/pets.json` 这两份；该脚本头注 `:15-20` 明说它**不动** `generated_from`。

> 这不是「数据被改坏」：我逐只比对过两边的六维，36 只的 `stats` 与 wiki 源
> （`tmp/roco-full-catalog.json`）**0 处不一致**。只是**格式化写法**与 `generated_from` 记录
> 让 `--verify` 这种逐字节判据必然报红。要让 `--verify` 变绿，得先决定「谁负责写这一层」。

---

## B. 同一个脚本能不能直接改吃抓包 `skill_list`

### B-1 结论

**不能直接吃，但缺的是一层薄适配器，不是重写。** 抓包给的是「**只有技能名的三桶**」，
现有管线要的是「**按 `learnset_id` 组织、技能写成 `skill_000XXX`、带等级字段**」。
两者差 **5 个映射**（B-3），其中 2 个（技能 id、等级）是**信息量缺失**，不是格式差异。

### B-2 抓包 `skill_list` 的真实形状（3 个具体文件，实测打印）

`data/roco/raw/hke-2026-09-27/raw/` 下共 **1,120 个 `.json`** = 560 份原始响应 + 558 份
`.normalized.json` + 2 份 `.meta.json`（实测 `ls | sed | uniq -c`）。

挑的 3 个文件：

| 文件 | `pet_detail.id` | `name` | level 桶 | machine 桶 | blood 桶 |
|---|---|---:|---|---:|---:|---:|
| `pet-3001-1790537111.json` | `"3001"` | 喵喵 | 16 | 17 | 18 |
| `pet-3454-1790537205.json` | `"3454"` | 地鼠 | 14 | 16 | 18 |
| `pet-4074-1790537285.json` | `"4074"` | 霜翼领主 | 13 | 16 | 18 |

三个文件的 `skill_list` 桶名都是 `['level','machine','blood']`，且**每条技能的键完全一致**：

```
per-skill keysets: {"category|category_icon|cost|desc|element_icon|icon|name|power": N}
entry[0] = {"cost":0,"desc":"造成物伤，自己回复1能量。","name":"抓挠",
            "icon":"https://heyboxbj.max-c.com/…/7020360.png",
            "element_icon":"https://imgheybox.max-c.com/…/1.png",
            "category":"物攻","category_icon":"https://static.max-c.com/…/f8c876…png",
            "power":35}
```

**全量实测（560 份原始响应 / 27,482 条技能）**：

```
raw files scanned: 560 with pet_detail.skill_list: 560
bucket presence counts: {"level":560,"machine":560,"blood":560}
per-skill keysets across ALL raw files:
   27482 × category|category_icon|cost|desc|element_icon|icon|name|power
skills with element_icon: 27482  category_icon: 27482  level: 0  skill_id/id: 0
```

⇒ 两条硬事实：
1. **抓包的技能没有 id**（`skill_id` / `id` 出现 **0** 次）；
2. **抓包的技能没有等级**（`level` 字段出现 **0** 次）—— `level` 只是**桶的名字**。

`.normalized.json` 那 558 份里的 `pet.skill_list` 形状**完全相同**（实测抽 `pet-3001-…normalized.json`），
所以走哪一份都一样，不会多出 id。

### B-3 现有源形状 ↔ 抓包形状：差的 5 个映射

| # | 维度 | 现有管线（wiki 源） | 抓包 | 差什么 / 可行性实测 |
|---|---|---|---|---|
| 1 | **技能 id 体系** | `skill_000XXX`（wiki 自身体系） | **只有 `name`**，无任何 id | 必须加「名字 → `skill_id`」映射。实测**可行**：抓包全量 27,482 条 → **547 个不同技能名**；`skills.json` 里查不到的 **0** 个；同名多 id 的 **0** 个；名里含零宽字符的 **0** 个（`skills.json` 共 824 条，其中 `is_trait=true` 245 条） |
| 2 | **桶名** | `native` / `blood` / `stones`（`export-full-catalog.mjs:53-55`） | `level` / `machine` / `blood` | 名字不同、语义基本对得上，但**不是完全相等**（见 B-4 实测） |
| 3 | **等级信息** | `native_skills[].level/stage`、`blood_skills[].blood/level`（`Learnsets.lua` 里有，`schema.mjs:112-117` 保留） | **没有**（每条技能只有 8 个键，无 level） | 抓包**补不了**等级。等级只能从 wiki `Learnsets.lua` 补 —— 实测 547 只抓包精灵里 **540 只**能映射到图鉴中「有 `learnset_id` 且该 learnset 在 wiki 312 张表里」的那一条，**7 只**（`4012,4019,4020,4074,4079,4086,4101`）在图鉴侧没有 `capture_id` |
| 4 | **pet id** | `pet_000XXX`（引擎），另有 `game_id`（册子号，如 3619） | `pet_detail.id` 是**字符串** `"3001"` | 映射靠图鉴的 `capture_id`，不是公式。实测 `full-catalog.json` 622 只里 **540** 只有 `capture_id`（`capture_matched_by` 分布：`game_id` 522 / `lord_name` 18，`build-full-catalog.mjs:122-129`）。⚠ 类型坑：`"3001"`(string) vs `3001`(number)（`scripts/roco/recon-547-classify.mjs:50-52` 记了这条踩坑） |
| 5 | **组织单位 / 特性** | 按 `learnsets[learnset_id]`；特性是 `feature_skill_id`（一个 skill id） | 逐 pet 一份 `skill_list`，**没有 `learnset_id`**；特性是 `feature{name,description,icon}`，**没有 id** | `learnset_id` 要新造（或直接令 `learnset_id = pet_id`）；特性靠名字回查（D 段实测 39/39 对得上） |

**给脚本的落点**：真正需要改的只有 `build-roster-48-engine-inputs.mjs:294-297`（取 `catLearnset.native/blood/stones`
那三行）与 `:337-339`（写 `native_skills/blood_skills/skill_stones` 那三行）——`poolOf()`（`:108-113`）与
合法性口径一个字都不用动，因为它只认 `skill_id` 集合。

### B-4 桶映射的实测对账（39 条能对上的 48 只做样本）

按「技能名集合」比较（wiki 侧 id 先经 `skills.json` 翻成名字）：

```
可对照条数(有 capture_id 且有抓包文件): 39   无 capture_id/无文件: 9
wiki native 名集合 vs 抓包 level   名集合 → 完全相等: 37  部分重叠: 1  零重叠: 1
wiki stones 名集合 vs 抓包 machine 名集合 → 完全相等: 22  其余: 17
wiki blood  名集合 vs 抓包 blood   名集合 → 完全相等: 38  其余: 1
```

- `level ↔ native`、`blood ↔ blood` 基本就是同一份东西（各 1 条例外，见下）。
- `machine ↔ stones` **只有 22/39 完全相等**：38/39 的关系是 **`machine` ⊊ `stones`**
  （合计 `machine` 独有 **16** 条名、`stones` 独有 **44** 条名；`machine` 总 898 条、`stones` 总 926 条）。
  例：`pet_000012` 铠甲虫 `stones` 多 1 条「迁飞扩散」；`pet_000328` 声波缇塔多「拖拉机 / 蒸汽进行曲」。
  ⚠ 这是**第一次实测出来的**：`machine` 桶**不等于** wiki 的 `skill_stones`，扩层时不能当作同一份照抄。
- 两个已知例外（与既有交接文档一致，本次复核为真）：
  - `pet_000137` 多多（capture 3151）：`level` 16 条 vs wiki `native` 17 条 → `partial`
  - `pet_000542` 祭礼巨像（capture 4084）：三桶**全部对不上**（`native` 零重叠、`blood` 也不等）

### B-5 附：抓包规模实测（回答「547 到底够不够」）

```
抓包不同 pet id 数: 547
有 skill_list 的: 547     level 桶 >= 4 条: 547     < 4 条: 0
抓包有、图鉴 capture_id 里没有的: 7  → 4012,4019,4020,4074,4079,4086,4101
图鉴 622 只里，有 learnset_id 且在 wiki learnsets 里的: 622 / 622
抓包 547 只里，能映射图鉴且图鉴有 wiki 学招表的: 540
```

⇒ 「547 只做不出来」的原因**不是缺技能池**（547/547 的 `level` 桶都 ≥4 条），
而是 **① 7 只没有图鉴映射**、**② 等级只能从 wiki 侧取**、**③ 执行域只认一个硬编码的层目录（见 C-4）**。

---

## C. 合法性口径

### C-1 `is_learnable` 定义在哪（引擎侧只读，未改）

定义：`roco/src/roco_env/data.py:362-364`

```python
362:     def is_learnable(self, pet_id: str, skill_id: str) -> bool:
363:         ls = self.learnsets.get(pet_id)
364:         return bool(ls) and skill_id in ls.all_skill_ids
```

### C-2 用的是不是 `native ∪ blood ∪ stones`？——是

口径在 `roco/src/roco_env/data.py:133-135`：

```python
133:     @property
134:     def all_skill_ids(self) -> FrozenSet[str]:
135:         return frozenset(self.native) | frozenset(self.blood) | frozenset(self.stones)
```

`Learnset` 三元的构造在同文件 `:533-540`：

```python
533:     learnsets: Dict[str, Learnset] = {}
534:     for pid, ls in raw["learnsets"]["learnsets"].items():
535:         learnsets[pid] = Learnset(
536:             pet_id=pid,
537:             native=tuple(e["skill_id"] for e in ls.get("native_skills", []) if e.get("skill_id")),
538:             blood=tuple(e["skill_id"] for e in ls.get("blood_skills", []) if e.get("skill_id")),
539:             stones=tuple(s for s in ls.get("skill_stones", []) if s),
540:         )
```

⇒ **`native_skills[].skill_id` ∪ `blood_skills[].skill_id` ∪ `skill_stones[]`，等级不参与合法性**
（`level` 在这三行里根本没被读）。这与 layer-48 里 `level: null` 仍能通过校验是一致的。

**Python 侧的点名（本次一个字都没改，`git status -- roco/` 为空）**：

| 文件:行 | 角色 |
|---|---|
| `roco/src/roco_env/data.py:362-364` | **定义处**（唯一） |
| `roco/src/roco_env/env.py:481` | 调用：对局前校验配招每一招是否学得到（`:475-483` 收集 problems） |
| `roco/src/roco_env/team.py:90` | 调用：评分时过滤配招 `[s for s in loadouts[pid] if rs.is_learnable(pid, s)]` |

另有 Python/测试侧的非引擎读点（也全未改）：`scripts/roco/build-lineup-legality.py:118`、
`roco/tests/test_on_demand_builds.py:128`。

### C-3 layer-48 是怎么被读进来的（文件 + 行号）

全部在 `roco/src/roco_env/data.py`：

| 行 | 做的事 |
|---|---|
| `:22` | `LAYER_DIRNAME = "layer-playable-48"` —— **目录名硬编码常量** |
| `:23` | `LAYER_FILES = ("pets", "learnsets", "support-matrix")` |
| `:413-426` | `_layer_files(base)`：`os.path.join(base, LAYER_DIRNAME)`（`:419`），逐个 `if os.path.exists` 才收（`:422-425`） |
| `:464-465` | `load_ruleset()` 里调 `_layer_files()` 并读成 `layer = {name: json}` |
| `:466-477` | 校验 `ruleset_id` / `game` / `layer` 三个字段；并把三个文件的 sha256 记进 `files`（`:477`）→ 进 `snapshot_fingerprint()` |
| `:488-489` | `_merge_layer_collection(raw["pets"], layer.get("pets"), …)` / `(raw["learnsets"], layer.get("learnsets"), …)` |
| `:429-449` | `_merge_layer_collection()`：**同一个 id 在两层都出现即抛 `RulesetError`**（`:443-448`），只允许新增 |
| `:533-540` | 合并后的 `raw["learnsets"]["learnsets"]` 才被建成 `Learnset`（C-2） |

### C-4 由此得到的结构性卡点（结论）

`_layer_files()` **只认 `LAYER_DIRNAME` 这一个目录名**（`:419`），没有「第二个层」的机制。
所以「给 547 只扩一层」只有三条路：

1. 改 `data.py:22`（新增/改成可配置）—— **被纪律禁止**（执行域冻结）；
2. 往现有 `layer-playable-48/` 目录里加 —— 但该目录被
   `build-roster-48-engine-inputs.mjs:266-269` 的「合并后必须正好 48 只 / 登记层必须 48 只」断言、
   以及 `:520-539` 的 `--verify` 逐字节判据钉着（现状见 A-5，**已经报红**）；
3. 新目录名 + 复用 `layer` 字段（如 `layer-playable-547`）—— 一样要动 `data.py:22`。

⇒ **这是「547 全量」最硬的一处**：不是数据问题，是执行域读入路径的唯一性设计。

---

## D. `feature_skill_id` 在抓包里对应 `feature` 吗（对照验证）

### D-1 结论：对得上，实测 39/39

48 条 layer 的 `feature_skill_id` **全部非空**（48/48）。其中 39 条能对到抓包文件，
这 39 条的 **`result.pet_detail.feature.name` 与 `skills.json` 里该 `feature_skill_id` 的名字
39/39 完全一致**（0 不一致，9 条因图鉴没有 `capture_id` 而无法对照）。

命令与输出（节选）：

```
feature_skill_id 非空条数: 48
抓包 feature.name 一致: 39 / 不一致: 0 / 找不到 capture_id: 9
```

### D-2 点名一条（完整证据链，可复核）

**`pet_000484` 迷迷箱怪**：

1. layer-48 条目：`data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/learnsets.json`
   → `learnsets.pet_000484.feature_skill_id = "skill_000133"`（同条 `learnset_id = "learnset_5ccca003e3ca"`）。
2. 引擎技能表：`data/roco/normalized/roco-world-s4-2026-09-10/skills.json:2929-2931`
   → `"skill_000133"`，`"name": "虚假宝箱"`，且 `is_trait = true`（实测 48 条的 `is_trait` 全为 `true`）。
3. 抓包同一只：图鉴 `full-catalog.json` 里 `pet_000484.capture_id = 3619`
   → 文件 `data/roco/raw/hke-2026-09-27/raw/pet-3619-1790537226.json`
   → `result.pet_detail.feature.name = "虚假宝箱"`（另有 `description` / `icon`）。
4. 比对结果：**一致**。

再抽 2 条同样对上的（不同分支、可复核）：

| 引擎 pet_id | 名字 | `feature_skill_id` | `skills.json` 名字 | 抓包 capture_id / 文件 | 抓包 `feature.name` | 判定 |
|---|---|---|---|---|---|---|
| `pet_000225` | 寂灭骨龙 | `skill_000129` | 不朽 | 3269 / `pet-3269-1790537183.json` | 不朽 | ✅ |
| `pet_000451` | 秩序鱿墨 | `skill_000158` | 绝对秩序 | 3579 / `pet-3579-1790537219.json` | 绝对秩序 | ✅ |

### D-3 但必须写清的边界

- 抓包 `feature` **只有 `name` / `description` / `icon`，没有 id**（实测 3 份样本 + 560 份全量）。
  ⇒ 映射方向只能是 **抓包名 → `skills.json` 名 → `feature_skill_id`**，与 B-3 的第 1 条同一个坑。
- 抓包里 `feature` 是**每份原始响应都有**的，且键集**只有一种**。全量实测：

  ```
  原始响应文件: 560   有 feature.name 的: 560
  feature 键集分布: {"description|icon|name":560}
  ```

  ⇒ 560/560 有 `feature`，每条**恰好 3 个键** `name` / `description` / `icon`，**没有 id**。
- 9 条对照不上的（图鉴没有 `capture_id`）：
  `pet_000608` 银月狼王、`pet_000601` 圣凯布米龙、`pet_000611` 月使鹭纳、`pet_000609` 新月鹭、
  `pet_000613` 智辉章脑、`pet_000545` 千棘海针、`pet_000556` 棋契陛下、`pet_000575` 棋契陛下、`pet_000139` 古啦多。
  （`pet_000556` 与 `pet_000575` 同名「棋契陛下」——这与 `tests/roco-hke-layer.test.js` 记的
  「首领同名 1:1」是同一片区域，本次**没有**定因。）

---

## ③ 没做到 / 未确认（这一栏不许空着）

1. **没有逐字段比对「磁盘上的 `layer-playable-48/pets.json`」与「脚本重新生成的内容」**（A-5）。
   已确认的差异来源只有两个（基线哈希、1 空格 vs 2 空格缩进），但**没有证到"内容全等"**。
2. **没有查 `machine` 桶为什么是 wiki `stones` 的真子集**（B-4：`stones` 独有 44 条名）。
   只观察到现象，没去读 `wiki_modules/Pets/data/SkillStoneTopics.lua` 或游戏内「技能机」定义。
   ⇒ 扩层时「`machine` 能不能直接当 `skill_stones`」**仍未确认**。
3. **`pet_000542` 祭礼巨像三桶全不对上、`pet_000137` 多多缺 1 条**：本次只复核了现象为真，
   **没有查到成因**（是抓包版本不同、还是 wiki 侧另有来源）。
4. **只对 48 只做了对照**，547 只的「桶 → 三键」映射**没有逐只跑过**；
   本文里 547 相关的数字只有：不同 pet id 547、level 桶 ≥4 的 547、能对到 wiki 学招表的 540、
   无图鉴映射的 7、抓包技能名 547（全部可在 B-5 的命令里复现）。
5. **没有验证抓包侧 547 只与 `skills.json` 的名字映射在"全部 547 只逐只组配招"时是否仍然 0 冲突**
   （《任务书》要求"禁止在没跑过一遍之前写百分比"，本文因此**不给任何百分比**）。
6. **没有评估工作量**（步数 / 耗时 / 会顶红哪些判据）—— 不在本次 A–D 的范围内。
7. **没有跑任何会写盘的命令**：`--verify` 是只读分支（`build-roster-48-engine-inputs.mjs:520-541`
   在写盘前 `return`），其余全是 `read` / `grep` / `node -e` 内存计算。
   仓库里 `roco/**` 与四个相关脚本的 `git status --porcelain` 输出为空。
8. 侦察期间同一工作区有**其他 agent 在并发改动**（两次 `git status` 之间出现了
   `scripts/roco/recon-547-classify.mjs` 新增、`scripts/roco/gold-review.mjs` 修改）。
   本文没有引用这两个文件的内容作为结论依据。
