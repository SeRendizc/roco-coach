# F03 · 数据卡（DATA CARD）— 洛克王国：世界 手游 S4 规则快照

> 本文每一个数字都来自**实际读过的文件或实际跑过的命令**，逐项标「证据」。
> 机器可读台账：`data/roco/sources.yaml`、`data/roco/provenance.jsonl`、`data/roco/conflicts.jsonl`、
> `data/roco/normalized/roco-world-s4-2026-09-10/import-report.json`。

---

## 1. 一句话摘要

| 项 | 值 | 证据 |
|---|---|---|
| 游戏 | `roco_world_mobile`（《洛克王国：世界》**手游**；页游数据完全排除） | `data/roco/sources.yaml` 的 `game` / `excluded_source_classes` |
| 规则集 id | `roco-world-s4-2026-09-10` | `pets.json` 的 `ruleset_id`；`support-matrix.json` |
| 赛季 | S4「月涌狂想」，`epoch_start = 2026-09-10` | `sources.yaml` 的 `ruleset.season` / `ruleset.epoch_start` |
| 抓取（capture）时间 | **2026-09-20T16:15:30Z**（本轮归档下载时间）；台账生成 `2026-09-20T16:16:00Z` | `import-report.json` 的 `fetched_at`；`sources.yaml` 的 `generated_at` |
| 来源数量 | **4 条台账条目**（3 个仓库 + 1 个赛季名单文件） | `sources.yaml` 的 `sources:` 列表（逐条 `- source_id:`） |
| 许可结论（最重要一条） | **没有任何来源允许进入「可商用 / 可公开分发的数据包」** | `docs/roco/LICENSE-MATRIX.md` §3「结论」 |
| 规范化实体 | 精灵 12 / 技能 824 / 学习表 12 / 属性行 120 / 术语 54 | 见 §4，逐项标文件 |
| 交叉核验 | 12 只全部解析成功；**8 只有两源差异、4 只只在主来源**；未解决 **0** | `reports/roco/m1-data/cross-check.log`；`import-report.json` 的 `cross_check` |
| 冲突台账 | `conflicts.jsonl` **26 行**，全部 `severity:"info"`、全部 `auto_resolved:true` | `wc -l data/roco/conflicts.jsonl`；逐行解析 `kind`/`severity`/`auto_resolved` |

---

## 2. 来源明细（revision + SHA256 + 许可）

### 2.1 `wiki-rocom-snapshot`（主数据源）

| 项 | 值 | 证据 |
|---|---|---|
| 仓库 | `JayeGT002/rocom-wiki-data`，上游 `wiki.biligame.com/nrc` | `sources.yaml` |
| 固定 revision | `aff808eb60003457fe8a260d1ac3c9bd95d53872`（`revision_date` 2026-09-10T08:46:18Z） | `sources.yaml` |
| 归档 | `data/roco/raw/rocom-wiki-data.tar.gz`，**860,689 bytes** | `ls -l`；`sources.yaml` 的 `archive_bytes` |
| 归档 SHA256 | `5cc6822a4bb7a2c7b37f535b9b22f78880d04f12056a8e5ee6e185b92883b0cc` | **实跑** `shasum -a 256`，与 `sources.yaml.archive_sha256`、`reports/roco/m1-data/raw-sha256.txt` 三者一致 |
| **许可** | **CC BY-NC-SA 4.0**（署名—非商业性—相同方式共享） | 仓库内 `LICENSE` 正文首行实读：`Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International` |
| 再分发等级 | `DERIVE_WITH_ATTRIBUTION_NONCOMMERCIAL` | `sources.yaml`；`LICENSE-MATRIX.md` §1 定义表 |
| 商用 | **禁止**（`commercial_use: prohibited`） | `sources.yaml` |
| 核验状态 | `cross_checked_2_sources` | `sources.yaml` |

> 上游 WIKI 内容同为 CC BY-NC-SA 4.0；GitHub API 该仓库返回 `NOASSERTION`，是因为其 LICENSE 是中文全文而非 SPDX 模板
> ——`docs/roco/LICENSE-MATRIX.md` §2.1 专门写了这条易误判点。

### 2.2 `nrc-ai-sqlite`（交叉核验第二来源）

| 项 | 值 | 证据 |
|---|---|---|
| 仓库 | `ColinHong10/NRC_AI` | `sources.yaml` |
| 固定 revision | `9b5801b08d349c6505a233c513faa5075f427035`（2026-04-20） | `sources.yaml` |
| 归档 | `data/roco/raw/NRC_AI.tar.gz`，**180,349,494 bytes** | `ls -l` |
| 归档 SHA256 | `22139197ccc004a39d719d9917f0f1524778e88ea9c862b5fb5d80618336e9e3` | **实跑** `shasum -a 256`，与台账一致 |
| 是否入库归档 | **否**（`archive_committed_to_git: false`，理由：172MB 永久留在 git 历史里，代价大于收益） | `sources.yaml` 的 `archive_committed_reason` |
| **许可（仓库代码）** | **MIT** | 仓库内 `LICENSE` 首行实读：`MIT License / Copyright (c) 2026 ColinHong` |
| **上游游戏数据许可** | **未单独声明** | `sources.yaml` 的 `license_note`；`LICENSE-MATRIX.md` §2.2 |
| 再分发等级 | **`REFERENCE_ONLY`** | `sources.yaml` |
| 核验状态 | `parsed_and_cross_checked` | `sources.yaml` |

**为什么代码 MIT ≠ 数据可用**：MIT 覆盖作者写的**代码**；`data/nrc.db` 里的
（`pokemon: 461` / `skill: 491` / `pokemon_skill: 20433` / `evolution: 206`，见 `sources.yaml.tables`）
来自游戏与社区 WIKI，未单独声明权利。因此它的数值**不进入** `normalized/`。

### 2.3 `rocom-data-lineups`（交叉核验第三来源 + 历史阵容频次）

| 项 | 值 | 证据 |
|---|---|---|
| 仓库 | `AofeiLi-code/rocom-data`，上游 BWIKI 阵容广场 | `sources.yaml` |
| 固定 revision | `d2c0533aad9a0480d39e3fbc5c37507a47958251`（2026-05-09） | `sources.yaml` |
| 归档 | `data/roco/raw/rocom-data.tar.gz`，**4,196,321 bytes** | `ls -l` |
| 归档 SHA256 | `92345dfb99ca03739f6c157fb432e8bec556f27efb450e5f36915b723cf212cc` | **实跑** `shasum -a 256`，与台账一致 |
| **许可** | **未声明**（仓库根目录**没有任何 LICENSE / COPYING 文件**） | `sources.yaml` 的 `license: NONE_DECLARED`；`LICENSE-MATRIX.md` §2.3；本文实跑 `find … -iname 'LICENSE*' -o -iname 'COPYING*'` **无输出** |
| 再分发等级 | **`REFERENCE_ONLY`** | `sources.yaml` |
| 商用 | `prohibited_pending_clarification` | `sources.yaml` |
| 核验状态 | `parsed_frequency_only` | `sources.yaml` |
| 阵容计数 | `lineups_total: 169`（PVP 148 / PVE 21） | `sources.yaml.counts` |

### 2.4 `wiki-rocom-s4-season-file`

| 项 | 值 | 证据 |
|---|---|---|
| 位置 | `data/roco/raw/extracted/rocom-wiki-data/S4Season.lua` | `sources.yaml` |
| 许可 / 再分发 | 同 2.1（CC BY-NC-SA 4.0 / `DERIVE_WITH_ATTRIBUTION_NONCOMMERCIAL`） | `sources.yaml` |
| 用途 | **只**用于判定「S4 新精灵」这一**身份**，不用于判定热门或强度 | `sources.yaml` 的 `notes` |

### 2.5 明确排除的来源类别

`sources.yaml` 的 `excluded_source_classes` 三类：页游 `roco.qq.com` / 页游 wiki；宝可梦 / Pokémon 数据；未标版本的二手攻略转载。
由 `tests/evals/roco/data-acceptance.test.js`（15/15 通过，我实跑 `npm run test:roco`）断言：
来源 URL 不得含 `roco.qq.com`、`bulbapedia|pokemon.com|wiki.52poke`，且台账必须显式写出 `excluded_source_classes` 与「页游」。

### 2.6 许可汇总（本轮结论）

| 来源 | 许可 | 再分发 | 可入库 | 可进公开数据包 | 可商用 |
|---|---|---|---|---|---|
| `wiki-rocom-snapshot` | CC BY-NC-SA 4.0 | `DERIVE_WITH_ATTRIBUTION_NONCOMMERCIAL` | ✅ | ❌ | ❌ |
| `nrc-ai-sqlite` | MIT(代码) / 未声明(数据) | `REFERENCE_ONLY` | ❌ | ❌ | ❌ |
| `rocom-data-lineups` | 未声明 | `REFERENCE_ONLY` | ❌ | ❌ | ❌ |
| `wiki-rocom-s4-season-file` | CC BY-NC-SA 4.0 | `DERIVE_WITH_ATTRIBUTION_NONCOMMERCIAL` | ✅ | ❌ | ❌ |

**证据**：`sources.yaml` 的 `license_summary`；`docs/roco/LICENSE-MATRIX.md` §3 汇总矩阵与「结论」。

---

## 3. 导入（import）计数

| 实体 | 本轮导入（进入 `normalized/`） | 快照里总数 | 证据 |
|---|---:|---:|---|
| 精灵 pets | **12** | 622 | `pets.json` 的 `pet_count = 12`；`import-report.json` 的 `counts.pets_total_in_snapshot = 622` |
| 技能 skills | **824** | 824 | `skills.json` 的 `counts.total = 824`；`import-report.json` 的 `counts.skills_total_in_snapshot = 824` |
| 学习表 learnsets | **12** | 312 | `learnsets.json` 的 `learnset_count = 12`；`import-report.json` 的 `counts.learnsets_total_in_snapshot = 312` |
| 属性行 type rows | **120** | 120 | `types.json` 的 `counts.total = 120` |
| 术语 terms | **54** | 54 | `terms.json` 的 `counts.total = 54` |
| 目标解析 | **12 / 12** | — | `import.log`：`[import] targets resolved 12/12` |
| 孤儿技能引用 | **0** | — | `import.log`：`[import] orphan skill refs total 0` |
| 改动历史 | 620 只精灵有记录、9 个版本节点 | — | `provenance.jsonl` 首行 `change_history entity_count 620`；`history.json` 的 `versions`(9) / `pets_with_history`(620) |

技能细分（`skills.json.counts`）：有静态威力 **358**、无静态威力 **466**、特性（trait）**245**。
> 重要口径：`power` 缺失表示**该来源未给出静态威力，不等于 0 伤害**——`provenance.jsonl` 的 skill 行 note 原文即此。

来源文件级 SHA256（`import-report.json.source_files`，逐条实读）：

| 源文件 | SHA256 | bytes |
|---|---|---:|
| `…/Pets/data/Catalog.lua` | `537fba5e8cb779c1ef3e231342c2a196e85d0ecb2ee072186adb6e9f727a83d7` | 929,115 |
| `…/Pets/data/Skills.lua` | `ed9132e1a3fd7f0cf287c8acbeb57e830ba0cfe2dc1f11946a72ef6329772f33` | 187,055 |
| `…/Pets/data/Learnsets.lua` | `740e84def6f142fca15b74d58c9851c18eb578ce004fd8a5991243300eef058e` | 539,068 |
| `…/Pets/data/Types.lua` | `22999381d35c64ba50a71e695a9de5c6a45d0fb486fd6541ba6c785d70c2ab57` | 35,441 |
| `…/Pets/data/Terms.lua` | `f1830685d31732d3634f8857e14eec75b85ea56b923ceef218ede18182056488` | 6,555 |

normalized 各文件的磁盘 SHA256（**实跑** `shasum -a 256`，与 `Ruleset.files` 逐字节相同）：

| 文件 | SHA256 |
|---|---|
| `pets.json` | `8ba09fd7a05e1d023a6add5e79a81408e7890606b3067da4d15662f7f48fcdb0` |
| `skills.json` | `9d01a6476a529be750973b4b3e8eb939112773f6a8b685e15e67516092e278e4` |
| `learnsets.json` | `0a68366b6624f94efec43b6ee036152bbb37f84e396024f3e63fb868220f3052` |
| `types.json` | `d2b4d0eaebd466905871cd7d55fc9a54e545b3ea676ae6d8c53e3e60d371defc` |
| `terms.json` | `1b12b19993c05d901218942c0223a638bdd91194343e2817e559c59c5593bc6f` |
| `support-matrix.json` | `803058f17ed53bc8ef51d3b9b0851114c6e6cacdb58ec07235350bd0e7f4278b` |

规则集运行时指纹 `Ruleset.snapshot_fingerprint()`（对上面这些文件名 + 文件哈希再哈希）：
**`affa4273ae5fb87578d038084e7a30dc6f5e2fd5e59d11049f0aa989c40a1f7a`**
—— 实跑 `cd roco && PYTHONPATH=src python3 -c "…rs.snapshot_fingerprint()"`。

### 3.1 溯源记录（provenance.jsonl）

18 行，逐行读出的 `(entity_type, entity_count, source_id, verification_status)`：

| entity_type | entity_count | source_id | verification_status |
|---|---:|---|---|
| `change_history` | 620 | `wiki-rocom-snapshot` | `parsed` |
| `skill` | 824 | `wiki-rocom-snapshot` | `parsed` |
| `type_chart` | 120 | `wiki-rocom-snapshot` | `parsed` |
| `term` | 54 | `wiki-rocom-snapshot` | `parsed` |
| `pet` × 12 | —（每只一行，带 `entity_id`） | `wiki-rocom-snapshot` | `parsed` |

每行都带 `importer: "m1-importer/1"`、`ruleset_id`、`game`、`source_file` 与 `source_file_sha256`。

---

## 4. 交叉核验（cross-check）结果与冲突计数

**实跑命令**：`cat reports/roco/m1-data/cross-check.log` →

```text
cross-check: match=0 with_differences=8 not_present=4
```

| 指标 | 值 | 证据 |
|---|---:|---|
| 尝试比对的精灵 | 12 | `import-report.json` → `cross_check.attempted = 12` |
| 逐字段完全一致 | **0** | `cross-check.log` 的 `match=0`；`import-report.json` 的 `cross_check.matched = 0` |
| 有差异但全部有解释 | **8** | `cross-check.log` 的 `with_differences=8` |
| 交叉来源里不存在（单一来源） | **4** | `cross-check.log` 的 `not_present=4`（化蝶、银月狼王、圣凯布米龙、月使鹭纳） |
| 已解释的差异条目 | **24** | `import-report.json` → `cross_check.explained_by_rebalance = 24` |
| **未解决（需人工核验）** | **0** | `import-report.json` → `cross_check.unresolved = 0`；`DATA-CONFLICTS.md` §0「未解决：0 处」 |
| 冲突记录行数 | **26** | 实跑 `wc -l data/roco/conflicts.jsonl` = 26 |

`conflicts.jsonl` 逐行解析（实跑 Python）得到的 `kind` 分布：

| kind | 行数 | 含义 |
|---|---:|---|
| `cross_source_value_mismatch` | 24 | 跨来源数值不一致（逐字段） |
| `same_name_multiple_forms` | 1 | 同名多形态（化蝶 4 形态，选定 `pet_000124`「化蝶（平常的样子）」） |
| `type_field_scope_difference` | 1 | 字段口径差异（`NRC_AI.pokemon.element` 只存主属性） |
| 合计 | **26** | 全部 `severity="info"`、全部 `auto_resolved=true`、未解决 0 |

> 口径差异说明（诚实记录）：`docs/roco/DATA-CONFLICTS.md` §1 的分类表把 26 条写成
> 「`version_rebalance` 24 / `(unclassified)` 1 / `field_scope_difference` 1」，
> 而 `conflicts.jsonl` 里的实际 `kind` 值是 §4 表中所列三个。
> 两份记录的**总数与「未解决 = 0」一致**，差异只在分类标签命名上。本文以 `conflicts.jsonl` 为准。

核验方法论（`DATA-CONFLICTS.md` §0，原文要点）：**不做多数票**。两个更早的社区快照一致不足以推翻当前赛季数据
（可能同源，且都早于后续调整）；凡主快照的值没有改动记录支撑、又被更早来源「票数压过」的情况，
一律记为待核验而不是自动采用。判定依据是主快照自带的 `History.lua` 逐字段 `before → after` 记录。

「单一来源」的 4 只：`import-report.json` 里 `status: "not_present_in_cross_source"`，
`reason` 原文——「NRC_AI 快照为 2026-04，晚出的 S4 精灵不在其中；该精灵本轮只有单一来源，不能声明交叉核验通过」。
**单一来源 ≠ 已核验，也 ≠ 数据错误**，只是本轮无法互证。

---

## 5. 明确的口径与警告（Caveats）

1. **没有任何来源允许商业再分发。**
   `LICENSE-MATRIX.md` §3 结论原文：「本轮**没有任何**来源允许进入『可商用 / 可公开分发的数据包』」。
   主源是 CC BY-NC-SA 4.0（禁止商用 + 必须同许可 + 必须署名 + 须说明修改），
   另两条是 `REFERENCE_ONLY`（许可未声明或未澄清）。`data/roco/normalized/**` 与 `docs/roco/**`
   属于**演绎作品**，受 NC + SA 约束；任何未来发布的模型权重或数据集**不得**包含原始材料。
2. **社区阵容出现频次不是胜率。**
   `sources.yaml` 的 `rocom-data-lineups.caveats` 原文：「169 套阵容全部写有 6 只成员，但**没有**段位、样本量、胜率或对局数。」
   「数据主要来自 2026-04 至 2026-05 的 WIKI 阵容广场，早于 S4（2026-09-10）」。
   因此它**只能**支撑「历史社区阵容出现频次」，**不得**表述为胜率、T0 或当前 Meta
   （`LICENSE-MATRIX.md` §2.3「明确禁止的用法」）。
3. **S4 新精灵不等于热门、不等于强。**
   `sources.yaml` 的 `wiki-rocom-s4-season-file.notes` 原文：「用于判定「S4 新精灵」这一**身份**，
   不用于判定「热门」或「强」——新版本登场不等于强度或使用率。」
   本轮的 C 组三只（银月狼王 / 圣凯布米龙 / 月使鹭纳）同时是**单一来源**，没有交叉核验。
4. **模拟胜场数不是天梯强度。**
   引擎的对手只是五种启发式策略（`STRATEGIES = ['random_legal','greedy_damage','conservative_switch','status_control','shallow_search']`，
   证据 `src/server/roco-service.js:42`；实现在 `roco/src/roco_env/opponents.py`），
   且伤害公式是**未核验假设**（见 `STATUS-LABELS.md`）。任何「赢了多少局」只描述
   「在这个本地启发式对手池 + 这个未核验公式下赢了多少局」，**不是**天梯强度，也不是胜率。
   页面与接口也据此措辞：`team.py:248` 的 `evaluate_team` 明确不输出胜率；
   `roco-service.js` 的 `planBattle` 回执 `note` 写「真实对局 seed 没有参与」，且不声称胜率。
5. **全部来源都是社区归档，不是官方配置导出。**
   `sources.yaml` 的 `ruleset.caveat` 原文：「这是**社区归档**，不是官方配置导出。官方端内数值不可得，
   因此「与官方一致」的任何结论都不在本轮范围内。」
   `LICENSE-MATRIX.md` §6 末句：「本项目**不能**声称与游戏内数值一致；
   只能说「在固定 revision 的社区归档上一致」。」
6. **`skills.json` 的 `effect_support` 全部是 `unsupported`。**
   实跑：`collections.Counter` = `{'unsupported': 824}`。这是**数据侧**字段：
   它登记的是「本轮导入没有为任何技能背书效果原语」，与引擎里后来实现的部分（见 `RULE-COVERAGE.md`）是两件事，
   不可互相替代。
7. **道具与等级。**
   `_make_pet()` 注释写明「假设：等级 1 时面板 = 种族值」；`env.py` 对 `level != 1` 抛 `UnsupportedEffect`；
   `DEFAULT_ITEM_STOCK` / `ITEM_EFFECTS` 是引擎自定的假设值（`env.py:50-51`）。这些都不是数据。

---

## 6. 署名（Attribution，CC BY-NC-SA 4.0 要求）

本项目在**非商业**前提下使用下列社区整理成果（`LICENSE-MATRIX.md` §5 原文署名）：

1. **洛克王国世界 WIKI** — https://wiki.biligame.com/nrc
2. **JayeGT002/rocom-wiki-data** — https://github.com/JayeGT002/rocom-wiki-data ，revision `aff808eb`
3. **ColinHong10/NRC_AI** — https://github.com/ColinHong10/NRC_AI ，revision `9b5801b0`
4. **AofeiLi-code/rocom-data** — https://github.com/AofeiLi-code/rocom-data ，revision `d2c0533a`

**修改说明**：本项目把上述 Lua 数据表解析并重新组织为 JSON 规范化数据
（`data/roco/normalized/roco-world-s4-2026-09-10/`），并额外记录了来源、哈希、抓取时间、核验状态与冲突。
这属于**演绎**行为，不是原样转载。第三方 Lua 只作**文本解析**（`scripts/roco/lua-safe-parse.mjs` 的逐字符扫描器），**从不执行**。
