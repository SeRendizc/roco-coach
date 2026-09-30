# 退役单位词清零 S3：`content.js` 的知识卡（真源在别处）+ 检索别名表

- 执行者：`plan00-closer` · 2026-10-01 · task-42 · 已入库（Lead 核过 11 个哈希）
- 上游：[横切审计](player-text-audit.md)（H2 同族）· [语料器材](player-text-corpus.mjs) · task-35（teacher.js）· task-36（engine.js / rules.js）
- 口径（Lead 定）：行文用 **`血`** · 面板/属性名用 **`血量`** · 能量类唯一叫法 **`能量`** · 退役词 **`HP` / `生命` / `豆`**

## 0. 一页结论

| 项 | 结果 |
|---|---|
| 真源迁移 | `knowledge/tactics.json` 12 处 + `scripts/build-knowledge.js` 模板 2 处 ⇒ 退役词 **HP/生命 清零**、`豆` 只剩 4 处（**有意保留**的检索别名） |
| 产物 | 按序重跑后 `content.js` 与手改版**逐字节相同**（`7634e9109f82526f`）；`source_sha256` 对齐 |
| 门禁覆盖 | 语料 **230 → 503**（新增 `knowledgeCards×273`，只收 title/principle/counterexample）· 覆盖审计 ok · 失败渲染器 0 |
| 判据 | 门禁 6/6 · alias 4/4 · knowledge 11/11 · rules 17/17 · rag-tactic-cards 5/5（全绿）；`rag-eval` 20/24、`corpus-verification` 8/9 **既存红未变** |
| 检索别名表 | **保留**，但**不声称召回收益** —— 实测 0/14 差异（见 §4） |

## 1. ⚠️ 本刀最重要的发现：`content.js` 是**生成物**

`src/game/content.js:26` 有生成标记（编辑前必查）：

```
// Generated local tactical cards; edit knowledge/tactics.json then regenerate.
```

**真源 → 产物链**（O-52 要求的整条列清）：

```
knowledge/tactics.json ─┐
                        ├─► npm run build-knowledge ─► src/game/content.js          （产品源文件，被整体重写）
scripts/build-knowledge.js（模板）┘                    ├─► knowledge/semantic-corpus.json
                                                       └─► knowledge/reference.generated.json
src/game/content.js ───────► node scripts/roco/build-tactic-cards.mjs ─► data/roco/derived/tactic-cards.json
                                                                          （内含 content.js 的 source_sha256）
```

**顺序错了就会重现漂移**：先跑 `build-tactic-cards` 再跑 `build:knowledge` ⇒ content.js 被重写 ⇒ 产物指纹立刻过期（本次亲身踩到，`rag-tactic-cards` 4/5 红）。

**早期事故留档**：本刀第一版把迁移**打在生成物** `content.js` 上；`npm run build:knowledge` 一跑即被整体覆盖（退役词回到 生命 24 · 豆 29）。修法是迁到两个真源，再按序重跑。

## 2. 迁移明细（真源）

**`knowledge/tactics.json`（12 处）**：`恢复28生命。`→`恢复 28 血。` · `当前生命、道具库存`→`当前血量…` · `治疗后的生命`→`治疗后的血量` · `剩余生命`→`剩余血量` · `少量生命`→`少量血量` · `先回复45生命`→`先回复 45 血` · `生命上限限制`→`血量上限限制` · `缺失生命`→`缺失血量` · `当前生命和对手攻击分支`→`当前血量…` · `自身剩余生命`→`自身剩余血量` · `清风消耗1豆`→`1能量` · `恢复2豆`→`2能量`
**`scripts/build-knowledge.js`（2 处模板）**：`` `消耗${s.cost}豆` ``→`` `消耗${s.cost}能量` `` · `` `Lv.1未培养时生命${p.maxHp}` ``→`` `…血量${p.maxHp}` ``
**有意保留**：4 处 `keywords` 里的旧说法「豆」（`防御 回豆 能量 溢出` 等）—— 它是**检索别名**，不是玩家可见正文。

## 3. 读数与哈希

| 文件 | sha256 前16 | 字节 |
|---|---|---|
| `knowledge/tactics.json`（真源） | `31f8d50ae150beea` | 30735 |
| `scripts/build-knowledge.js`（真源） | `b9ee3d6236f5a463` | 4289 |
| `src/coach/rag-index.js`（别名表） | `4e1f386f92199b9b` | 76813 |
| `tests/roco-player-text-alias.test.js` | `ca87e9dd5934e8f6` | 7065 |
| `tests/knowledge.test.js`（2 条改钉） | `b09d6c2ee137c64c` | 6256 |
| `package.json`（登记 1 条判据） | `c75b43e7379d5dd1` | 14485 |
| `reports/…/crosscut/player-text-corpus.mjs` | `c3f9d29e4cad44e0` | 20055 |
| 生成物 `src/game/content.js` | `7634e9109f82526f` | 57619 |
| 生成物 `knowledge/semantic-corpus.json` | `e8f5321199fa72a8` | 65142 |
| 生成物 `knowledge/reference.generated.json` | `9230e749082c1896` | 32455 |
| 生成物 `data/roco/derived/tactic-cards.json` | `1697b53cb6a8cbb9` | 56006 |

- **登记（O-25）**：`test:unit` 判据路径 **183 → 184**（只加 `tests/roco-player-text-alias.test.js`）；`JSON.parse` 合法、其余字段逐字不变、diff 1 行。
- **改钉 2 条**（`tests/knowledge.test.js:66/67`，原断言逐字留档在文件内）：`消耗N豆`→`消耗N能量`、`生命NN`→`血量NN`（同语义只换词）。
- **门禁侧变异**：控制组 6/6 绿 → `content.js` 换回旧词 ⇒ **exit=1**，失败用例 `④ …退役单位词`，命中原文 `knowledgeCards@content.js ⇒ retired-unit 命中「生命」：…恢复28生命…`。

## 4. 检索别名表：**保留，但不声称召回收益**（负结果留档）

**做了什么**：`src/coach/rag-index.js` 新增 `LEGACY_QUERY_ALIASES`（`豆 → 能量`，**全仓唯一一处定义**）+ `expandLegacyQuery()`；`searchIndex` 用「原文 + 归一化变体」做分词与别名匹配（原文保留 ⇒ `keywords` 里的旧说法照旧命中）。

**四条判据**（`tests/roco-player-text-alias.test.js`）：① 旧说法「豆」的查询命中该卡（含**展开契约**断言）② 新说法「能量」命中同一张卡 ③ 玩家可见**正文**无退役词、且 **`keywords` 的例外必须存在** ④ 别名表**只有一处定义**（结构判据）。

**变异矩阵**（4 配置 × alias 判据）：
| 配置 | 判据 | 红的是 |
|---|---|---|
| base（表 + keywords 豆） | 4/4 | — |
| 删别名表 | 2/4 | ①（展开契约）+ ④（结构） |
| 删 keywords 里的「豆」 | 3/4 | ③（有意例外消失） |
| 两边都删 | 1/4 | ① + ③ + ④ |

**负结果（关键）**：四组配置下跑 14 个含旧说法的问句，**检索结果与分数逐位相同（0/14 差异）**，例如「回豆怎么用」四组都是 `tactic:guard-energy:2070`。
⇒ 在这套索引上，**「豆」这个信号不是召回的决定因素**：命中由「防御 / 上限 / 怎么用」等 token 与卡片正文承担。

**为什么仍然保留（Lead 裁决的三条理由）**：
1. **查询侧归一化契约显式化** —— 以后真清理 `keywords` 里的旧说法时，不必再改检索代码；
2. **判据本身有判别力** —— ①（展开契约）与 ④（单一定义）在变异下必红，能防住"两边一起删"；
3. **负结果本身就是资产** —— 它写明「这套索引的命中由正文 token 承担」，省得后人再做一个"以为改别名能救召回"的实验。

⚠️ **读这份文件的人请注意**：别名表是**保险**，不是召回修复；任何"它提升了召回"的说法都与 §4 的实测不符。

## 5. 规则沉淀（本轮踩出来的两条）

- **O-51｜跑生成器前先读生成器代码、列出它写哪些路径**。本次踩点：批准窄例外时假定 `build:knowledge`「只写 `data/roco/derived/**`」，实际它写 4 个路径（含 `src/game/content.js` 与两个 `knowledge/*.json`）。⇒ **窄例外的边界由生成器的实际写入清单决定，不由描述决定**。
- **O-52｜改任何文件前先查生成标记**（`Generated … edit X then regenerate`）。本次踩点：盘点只看了"含退役词的行"，而生成标记那行不含退役词 ⇒ 整条真源→产物链没查，迁移打在生成物上被覆盖。⇒ **有标记的文件，真源在别处，必须把链整条列出来**。

## 6. 边界与未覆盖（如实登记）

- **`src/client/**` 的 30 处退役词不在门禁视野内**（验收方发现，登记 **O-53**）⇒ 已派 task-43（`plan02-front` 迁移，`roco.js` 除外）。**待他交付「玩家可见文案的生产者清单」后，由本目录的主人把 client 生产者收进语料/门禁**，第 5 类判据才算覆盖面板文案。
- `rag-eval`(20/24) 与 `corpus-verification`(8/9) 的 4+1 条红是**既存红**：迁移前后逐条比对未变差。
- 本刀**未**动 `data/**` 的原始数据；只由生成器写入派生产物（`data/roco/derived/**`、`knowledge/*.json`、`src/game/content.js`）。
