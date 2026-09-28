# 任务书 · 「能不能把现有 500 多只全做出来，难度多大」（人类 2026-09-28 亲口点的）

> 人类逐字：
>
> > 「记得让下个 agent 思考下能不能吧现有 500 多只全做出来，难度多大」
>
> **要交付的是一份"评估"，不是一次开工。** 结论先给人类看；他点头之后才动数据。
> 纪律：**每一句难度判断后面都要挂一个可核对的数字或文件路径**；不许写"大约/可能/估计"。

---

## 1. 先读这三条（否则会把"没构建"误当成"没数据"）

**① "全"至少要分成三层，工作量差一个数量级**（现状数字都是实测）：

| 层 | 现状 | 缺口 |
|---|---|---|
| A. **查得到**（图鉴六维/属性/技能池问答） | 图鉴 **622 条**；抓包覆盖六维 **540 只** | 基本已通（回答层读 L1 图鉴） |
| B. **模拟得动**（六宠链 / 出招建议 / 合法性） | 有**冻结配招层**的只有 **48 只** | **574 只**被跳过，reason 全是 `no_frozen_learnset` |
| C. **算得出面板**（等级换算后的六维） | 种族值 540 + 资质/性格（掷点层）+ 星级（只做了**资质刻度**） | 「升星抬种族值」那层仍未建（见 `docs/roco/MECHANICS-VS-POKEMON.md` 主表第 3 行） |

数字出处：`data/roco/game-data-pack/v2/pack.json`、`full-catalog.json` 的 coverage、
`node scripts/roco/build-owned-pets.mjs` 的实测输出（每次重建都打印 `skipped 574 / no_frozen_learnset`）。

**② 关键发现（2026-09-28 交接前实测）：那 574 只不是"没数据"，是"没构建"**。
抓包原始文件在 `data/roco/raw/hke-2026-09-27/raw/`（**1,120 个 JSON**），逐个数下来：

```
不同 pet id ............ 547
有 skill_list 的 ........ 547 / 547   （三个桶：level / machine / blood 都在）
技能条目 ≥ 4 的 ......... 547 / 547   （光是 level 桶 ≥4 条的也是 547 / 547）
有 feature（特性） ...... 560 / 560 个样本文件
有 base_race_params ..... 560 / 560
有 evolution_chain ...... 560 / 560
抓包里出现的不同技能名 .. 547 个
skills.json 里没有的 .... 0 个（skills.json 共 821 个技能名）
```

⇒ **抓包已经把配招所需的东西带回来了**（每个 pet 的 `skill_list.level / machine / blood` 三桶 + 特性 + 种族值 + 进化链），
而且**技能名 100% 能在 `skills.json` 里对上**。所以 B 层的 574 只缺口，性质是**构建管线**问题，
不是"数据源没有"。（对比：性格/天分/星级/学习力/突破次数这些**抓包确实没有**，清单见 `CAPTURED-LIST.md`。）

**③ 已有一份"目标格式"的样本，照着抄就行**：
`data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/learnsets.json`
（顶层键 `schema_version / ruleset_id / game / layer / source_id / source_revision / generated_by / generated_from / level_status / note / learnset_count / learnsets`；
单条形状 `{learnset_id, pet_id, feature_skill_id, native_skills:[{skill_id, level, stage, level_status}], …}`，**36 条**），
另有 `.../normalized/roco-world-s4-2026-09-10/learnsets.json`（**12 条**）—— **36 + 12 = 48**，正好是现在能模拟的那一批。

---

## 2. 要回答的问题（逐条给数字）

1. **48 → 547 的构建缺口到底是什么？** 把那 48 条的 `learnsets.json` 是**从哪来的**查清楚
   （`generated_by` / `generated_from` 字段 + `scripts/roco/` 里对应的构建脚本）；
   然后回答：同一个脚本**能不能直接吃抓包的 `skill_list`**？不能的话，差哪几个映射？
   - `machine`（技能机）与 `blood`（血脉）两桶在现有 48 条里是怎么落进 `native_skills` 的？
   - `feature_skill_id`（特性技能）在抓包里对应哪个字段（`feature`?）——**用一条已知的 48 只做对照验证**。
2. **合法性口径**：引擎侧的 `is_learnable`（native ∪ blood ∪ stones）与抓包三桶怎么对齐？
   **执行域（引擎的 pet 文件）不许改**（Python 逐比特一致是冻结契约）⇒ 扩层必须做成**新的 layer 文件**，
   走现在 layer-48 同一条读入路径。把那条路径点出来（文件 + 行号）。
3. **数量对账**：为什么是 547 / 540 / 622 三个数？逐条说清差在哪：
   - 547（抓包 pet id）vs 540（采用抓包的六维）——**7 只差在哪**（首领同名 1:1 的 18 只怎么算的）；
   - 622（图鉴）vs 547 —— 那 75 条是什么（形态/首领 4xxx/别名 25 组覆盖的 32 条…），**列表点名**。
4. **难度分级**（这一条是给人类看的结论）：把 547 只按"能不能自动生成"分档，例如
   - 甲档：抓包三桶齐全、技能名全能对上 ⇒ 写脚本就能生成（**给出只数**）；
   - 乙档：能生成但需要人判（例如 `level` 桶里的等级信息抓包是否给了、`stage` 怎么定）⇒ **给出只数**；
   - 丙档：抓包也没有 ⇒ 做不出来（**给出只数**，并说明缺的是哪个字段）。
   **禁止**在没有把 547 只逐只跑过一遍之前写任何百分比。
5. **工作量估计要用"步数 + 每步实测耗时"**：比如"生成一份 547 条 learnsets 实测 X 秒 / 跑一次判据 Y 秒 /
   会顶红哪几条判据"。**不许**写"大约需要几天"这种没有产物的估计（人类明确讨厌编数字）。
   ⚠ **语料形状**（49 实例 / 48 物种）一改会顶红 14 处判据 + 2 套验收（见交接 §3.3）——
   评估阶段**只读**，别把 547 只灌进 `owned-pets.json`。

---

## 3. 建议的只读侦察命令（先跑这些，再写结论）

```bash
# 抓包到底有什么（1,120 个 JSON；上面那组数字就是这么数出来的）
ls data/roco/raw/hke-2026-09-27/raw/*.json | wc -l
node -e "const fs=require('fs');const d='data/roco/raw/hke-2026-09-27/raw';const f=fs.readdirSync(d).filter(x=>x.endsWith('.json'));const p=JSON.parse(fs.readFileSync(d+'/'+f[0],'utf8')).result.pet_detail;console.log(Object.keys(p));console.log(Object.keys(p.skill_list));"

# 冻结层现在有几条、长什么样
node -e "const l=require('./data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/learnsets.json');console.log(l.learnset_count,Object.keys(l.learnsets).length,JSON.stringify(Object.values(l.learnsets)[0]).slice(0,200));"

# 那 48 条是谁生成的
node -e "const l=require('./data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/learnsets.json');console.log(l.generated_by,l.generated_from,l.source_id);"

# 跳过的 574 只是怎么算出来的（重建时会打印）
node scripts/roco/build-owned-pets.mjs | tail -5

# 抓包字段清单（哪些层抓包确实没有）
sed -n '1,60p' data/roco/raw/hke-2026-09-27/CAPTURED-LIST.md
```

---

## 4. 交付格式（写进 `docs/roadmap/` 一份新文档，并在交接文档 §0.5 回填链接）

1. **一句话结论**：能 / 不能 / 能但有代价（哪一档多少只）。
2. **三层拆分表**（A 查得到 / B 模拟得动 / C 算得出面板）各自"现在多少 → 全做要多少"。
3. **逐档只数表**（甲/乙/丙 + 每档的判定依据 + 判定脚本路径）。
4. **工作量**：步数 + 每步实测命令与耗时 + 会顶红的判据清单。
5. **卡点**：哪些是"数据根本没有"（列字段名 + 抓包文件为证），哪些是"要人判"。
6. **没做到**：你自己没验的部分，逐条写清（这一栏不许空着）。
