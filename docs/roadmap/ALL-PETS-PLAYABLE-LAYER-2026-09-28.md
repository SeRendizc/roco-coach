# 「所有精灵实装」落地记录（2026-09-28）

> 人类拍板（逐字）：「就用现在抓包得到的数据吧，别的不找不要了，问题数据也不要了。**所有精灵实装**，
> 这样就不需要我的精灵了，直接全筛选」。
> 口径依据：`docs/roadmap/FEASIBILITY-547-ALL.md` §⑩（含逐个核过的剔除名单）。
> 本文只记**实测到的数字**；没测到的一律写「未验证」。

---

## ① 一句话结论

抓包 547 只 − 剔除 8 只 = **539 只全部进了可玩层**；其中 **9 只**（音速犬 / 雪影娃娃 / 化蝶 /
海豹船长 / 寂灭骨龙 / 圆号鱼 / 黑猫巫师 / 秩序鱿墨 / 画间沉铁兽）在 M1 基线 12 只里已有冻结条目，
按引擎「同一 pet_id 不许两处定义」的 fail-closed 规则**不重复落库** ⇒ 本层写 **530 只**，
合并后冻结档 **542 只**（`12 + 530`），候选池仍是 **622 只**（另 80 只走按需推算档）。

| 量 | 实测 |
|---|---:|
| 抓包 raw 文件 | 560（去重后 **547** 只） |
| 剔除（人类点名） | **8** |
| 目标 | **539** |
| 本层写入 | **530** |
| 合并后冻结档 | **542** |
| 候选池（引擎 `RS.pets`） | **622** |
| 按需推算档 | **80** |

---

## ② 生成器：为什么新开一个脚本，而不是改旧那个

新脚本：**`scripts/roco/build-all-pets-engine-inputs.mjs`**；旧脚本
`scripts/roco/build-roster-48-engine-inputs.mjs` **保留**（历史可复现），但**默认拒绝写盘**。

理由（三条，都可核对）：

1. **口径不同**。旧脚本的输入是「48 只登记层」`roster-48.json` + `tmp/roco-full-catalog.json`，
   输出只可能是 36 只；本轮是「抓包 539 只、抓包为准」。硬塞进同一个脚本，两套口径会互相污染
   （旧脚本还带「合并后必须正好 48」与审计产物一致性断言）。
2. **「这一层归谁写」必须先定死**。本轮开工前实测：`node scripts/roco/build-roster-48-engine-inputs.mjs --verify`
   **exit 1**，三条
   （`pets.json` 75609 vs 82540 字节；`learnsets.json` sha `939b5862` vs `beb10e37`；
   `support-matrix.json` sha `b9a58b72` vs `2eda2700`）——
   成因是 `apply-capture-to-engine.mjs:96/:113` 用 1 空格缩进重写过 `pets.json`，
   且基线 `pets.json` 自己漂移过。两个写入者同时存在 = 没人说得清磁盘那一份是谁写的。
   ⇒ 本轮**只留一个写入者**：
   · 旧脚本：默认拒绝写盘（要复现历史版本加 `--legacy-48`），见其 `main()` 顶部；
   · `apply-capture-to-engine.mjs`：**不再把本层列为改写目标**（`TARGETS` 只剩基线 `pets.json`）——
     本层的六维本来就取自抓包，不需要事后打补丁；它那种 1 空格 + `stats_previous` 的写法正是漂移源。
3. **数值来源单一**。本层每一个数值都从抓包原始响应读，不依赖 `tmp/`（gitignore 的本地文件）。

---

## ③ 数据从哪来（逐一可核）

| 字段 | 来源 | 实测 |
|---|---|---|
| 名字 / 属性 / 六维 / 特性 / 三桶技能 | `data/roco/raw/hke-2026-09-27/raw/pet-<id>-<ts>.json#result.pet_detail` | 539/539 齐全 |
| 技能名 → `skill_id` | `skills.json` 名字回查 | 547 个名字 **0 个查不到**、抓包用到的名字里 **0 个同名多 id** |
| 特性名 → `feature_skill_id` | 同上，且要求 `is_trait=true` | 539/539 命中且为特性 |
| 引擎 `pet_id` | 图鉴层 `full-catalog.json` 的 id 桥 | 521 走 `game_id` 直连 + 18 走「名字（剥零宽字符）+ 六维全等」唯一命中；**0 处多命中、0 处零命中** |
| 六维交叉核对 | 抓包清单 `pets.csv`（同一批抓包的另一份产物） | 539/539 逐值一致、**0 处不一致** |
| `title/number/class/stage/release` | 图鉴层（**标签元数据**，抓包没有这几项） | 记录里逐条标了出处 |

⚠ 上游 `sum_race` **不采信**（抓包清单自述 547 里 521 条与六维之和不符）——本层只存六维。

**技能石缺口（如实标注，不假装齐全）**：抓包 `skill_list.machine` 是 wiki `skill_stones` 的
**真子集**（少 314 条槽位 / 102 个名字 / 187 只，见 FEASIBILITY-547-ALL §7.4）⇒
`learnsets.json#skill_stones_gap` 写了 `status: KNOWN_SUBSET_NOT_FAKED` 与后果
（只会少给、不会多给 ⇒ 引擎的「学得到」集合偏窄，挡的是少数合法配招，不会放过非法配招）。

---

## ④ 配招（4 技能位）怎么来的

与 48 只名单**同一套规则**（`reports/roco/coverage/roster-48.json#selection_rules.moveset_rule`），
但每个技能位加了**降级阶梯**（48 只那套允许「填不满就落选」，本轮要求每只都能上场）：

| 技能位 | 用到第 0 级（严格规则） | 用到第 1 级（降级） | 第 2 级 |
|---|---:|---:|---:|
| `free_attack` | 430 | **109** | 0 |
| `reactive_defense` | 539 | 0 | 0 |
| `main_attack` | 539 | 0 | 0 |

- 降级只放宽「选哪一招」，**不放宽**「必须 4 个互不重复、且都在本只自己的池子里」；
- 每条降级都逐条写进 `candidate_moveset.skills[].ladder_rung / ladder_why`（可复核）；
- 技能池大小：min **34** / 中位 **49** / max **58**（539 只都不缺 4 个可用技能）；
- 三桶合计：level 7601 + blood 9702 + machine(技能石) 8890；
- 抓包同一个桶里会出现**同名重复**（实测 2 只、共丢 18 条，例：3234 牵线木偶的 level 桶里
  「借用」出现 4 次）——抓包不给等级、不区分来源，**去重但如实计数**，不猜。

---

## ⑤ 实测读数

### 5.1 生成（真跑）

```
$ node scripts/roco/build-all-pets-engine-inputs.mjs
OK layer-playable-48 → data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/{pets,learnsets,support-matrix}.json
   抓包 547 只 − 剔除 8 = 目标 539 只；基线已有 9 只（不重复落库）⇒ 本层 530 只，合计 542 只
   id 桥：game_id 521 / 名字+六维 18
   技能池 7601(level) + 9702(blood) + 8890(machine)；池子 34–58（中位 49）
   槽位降级使用：{"free_attack":{"0":430,"1":109},"reactive_defense":{"0":539},"main_attack":{"0":539}}
   pets.json            1407261 B  sha256 1a8dc3dc6b32e699…
   learnsets.json       3168565 B  sha256 7586c4bdfd67208a…
   support-matrix.json  3234973 B  sha256 9be4a49cc768b339…
   摘要 → reports/roco/coverage/playable-all-pets-engine-inputs.json
```

- 耗时：**0.281 s**（`time` 实测，含读 560 个抓包文件 + 图鉴 + skills + 组装 + 写盘）；
- `--verify`（重新生成 + 逐字节比对 + 6 个输入未漂移）：**exit 0**，耗时 **0.294 s**；
- 与旧层对比：旧 3 份合计 491,089 B（75609 + 220041 + 195439）⇒ 新 3 份合计 **7,810,799 B**（约 15.9 倍）。

### 5.2 引擎真的能加载（Python 侧实测）

```
pets 622  learnsets 622  skills 860    加载 0.051 s
FULL_VERIFIED 542   SIMULATABLE_UNVERIFIED 80
配招不是 4 个的 0    有学习表但空池的 0
layer 三份都进快照指纹
```

---

## ⑥ 一条必须记下来的连锁反应：按需配招的「冻结那一档」换了来源

把可玩层从 48 扩到 542 之后，`on-demand-builds.json` 里那 7 只**从候选池整个消失**
（实测 `RS.pets` 622 → **615**）：它们的 `support` 仍是 `FULL_VERIFIED`（旧产物是拿
`owned-pets.json#battle_builds` 当冻结来源），而引擎对 `FULL_VERIFIED` 的行直接 `continue`
（它假定冻结层会管）——结果既不在冻结层、也不会被按需补上。
消失的是：`pet_000139 古啦多 / pet_000485 学院呱呱 / pet_000542 祭礼巨像 / pet_000556 棋契陛下 /
pet_000575 棋契陛下 / pet_000609 新月鹭 / pet_000613 智辉章脑`。

修法（也正是人类那句「这样就不需要我的精灵了」的字面落实）：**按需产物的冻结来源改成冻结层本身**
（基线 `support-matrix.json` + 可玩层 `support-matrix.json`），不再读 `owned-pets.json`。
改完实测：`530 → 542 冻结 / 92 → 80 推算`，`RS.pets` 回到 **622**，`配招不是 4 个的 = 0`。

- `scripts/roco/build-on-demand-builds.mjs`：`frozenBuildsFrom()` → `frozenBuildsFromLayers()`（旧值注释保留）；
- `scripts/roco/on-demand-builds-lib.mjs`：新增 `combinedFrozenHash()`（两份上游合成一个 sha，
  生产者与校验器共用同一个函数）；`derived_from.frozen_learnsets.path` 不再写死 owned-pets；
- `scripts/roco/verify-on-demand-builds.mjs`：跟着换成同一个 hash（否则「产物过期」这条判据拿错上游 = 假绿）。

---

## ⑦ 改钉清单（**旧值一个都没删**）

| 文件:行 | 旧值 | 新值 | 为什么 |
|---|---|---|---|
| `roco/tests/test_microcases.py:91-95` | 冻结 48 / 按需 574 / 池 622 | 冻结 **542** / 按需 **80** / 池 622 | 人类拍板「所有精灵实装」；判据（不相交、并集=池）没放宽 |
| `roco/tests/test_roster_evidence.py:130-133` | 默认名单 48 只 / 192 条技能出处 | **542 只 / 2168 条** | 同上 |
| `roco/tests/test_roster_evidence.py:154-155` | FULL 48 / SIM 574 | FULL **542** / SIM **80** | 同上 |
| `roco/tests/test_on_demand_builds.py:56-57` | 48 / 574 | **542 / 80** | 同上 |
| `roco/tests/test_on_demand_builds.py:98` | `checked == 48` | **542** | 同上 |
| `roco/tests/test_on_demand_builds.py:120` | `checked == 574` | **80** | 同上 |
| `roco/tests/test_on_demand_builds.py:143` | `checked == 574*4` | **80*4** | 同上 |
| `tests/roco-team-gaps.test.js:140-142` | `known:48, unknown:574` / `validated_species:48` | `known:**542**, unknown:**80**` / **542** | 同上 |
| `tests/roco-team-gaps.test.js:335-336` | `instances_with_validated_spe == 48` / `validated_species == 48` | **41** / **542** | 41 是因为盒子里 7 只的物种不在新冻结层（见 ⑥ 那 7 只），如实记 unknown |
| `tests/roco-team-gaps.test.js:340` | `learnset_variant_species['应对攻击'] == 48` | **542**（且等于现算的 `learnset_species_total`） | 基准不再写死 |
| `tests/roco-team-gaps.test.js:375` | 反证消息「不是 48 必须红」 | 「不等于学招表物种数（542）必须红」 | 判据本身没放宽（仍是改小 1 就红） |
| `tests/roco-pool-summary.test.js:33/85` | `roster_total: 48` / 说明里要出现 48 | **542** | 页面概况夹具跟着新口径 |
| `tests/roco-ask-coverage.test.js:801/820/834` | 夹具 48 只 /「48 只」/「还有 36 只没列出来」 | **542 只** /「542 只」/「还有 **530** 只没列出来」 | 夹具换成新规模，判据（本地作答、0 次模型调用）没放宽 |
| `tests/roco-ask-coverage.test.js:920/941` | 铠甲虫 stub 回执 `stones:17,total:48` / 「学习表 48 条」 | `stones:**16**,total:**47**` / 「学习表 **47** 条」 | 合成回执改成与磁盘真实产物一致（抓包三桶 13+18+16=47） |
| `tests/roco-on-demand-builds.test.js:60-98` | frozen sha = `owned-pets.json` / count 48 / 622=48+574 | frozen sha = **冻结层两份** / count **542** / 622=**542+80** | 见 ⑥ |
| `tests/roco-on-demand-builds.test.js:130` | `574*4` | **80*4** | 同上 |
| `tests/roco-owned-pets.test.js:128` | 「不在 layer-playable-48 的 species 数量下限」 | **未改**（该断言仍绿） | 它数的是「基线那一档」（`MIN_OUTSIDE_LAYER=12`），本轮没动基线 |
| `tests/roco-team-candidates.test.js` RC-303 全族 | —（**没有改钉**） | — | 见 ⑧：它红是因为模块自己的禁键 `tier` 被自己命中，改的是**代码**不是判据 |

**代码侧跟着改的（不是放宽判据）**：

- `src/coach/team-gaps.js`：`buildGapIndex()` 的「验证层」来源从 `roster-48.json`（48）
  换成基线 `pets.json` + 可玩层（**542**）；证据指针改成逐条指到**它真正来自的那一份文件**；
  `respondSeparationHolds()` 的基准从写死的 48 改成现算的 `learnset_species_total`；
  `buildReportCriteria()` 里那条 `ok: index.roster.size === 542`。
- `src/coach/team-candidates.mjs`：证据值的键 `tier` → `learnset_tier`——
  本模块自己的 `BANNED_CLAIM_KEYS` 把 `tier` 列为伪精确禁键（`:1810`），
  冻结学招表一扩到 542，带学招表的候选从个位数变几百个，这个自伤就现形了。
  **改键名，不是放宽禁键表。**
- 两份报告已按各自的口径重新生成：
  `reports/roco/flagship-upgrade/rc-302-team-gaps.json`（`RC302_WRITE_REPORT=1`）、
  `reports/roco/flagship-upgrade/rc-303-team-candidates.json`（`RC303_WRITE_REPORT=1`）。

---

## ⑧ 没做到 / 未验证（这一栏不许空着）

1. **甲案已落地（2026-09-28 下半场）**：人类在两份口径里选了**甲案** —— 盒子跟着扩到可玩层的物种数
   （盒子 = 可玩层镜像），不再有「我的精灵」这个独立概念。实测落地：
   `data/roco/owned/owned-pets.json` = **542 实例 / 542 物种 / 0 组同种**
   （`species_in_layer_playable_48 = 530` + `species_outside_layer_playable_48 = 12` = 542，
   与可玩层逐数对得上）；`owned-pets-lib.mjs` 的 `INSTANCE_TARGET 48 → 542`、`MIN_SPECIES 40 → 542`，
   `MIN_OUTSIDE_LAYER = 12` 一字未动（仍是有牙的实判据）；生成器新增**三条交叉判据**
   （层物种数必须恰好等于常量、有 learnset 的一只都不许被静默跳过、基线档必须恰好 12 只）；
   每个 overlay 实例多一条 provenance，**逐只指向抓包原始响应**（`pet-<id>-<ts>.json#result.pet_detail.skill_list`
   + 该文件 sha256，许可标 UNKNOWN / REFERENCE_ONLY）。
   ⚠ 这一条**推翻**了本文 ⑧.1 原先「原样保留 49 条实例记录」的说法（那一版是甲案之前的记录，不删）。
2. **`tests/evals/roco/agent-trajectories.test.js` 红，且按台账**禁止**重跑**：
   回放报 `query_rules 的回执与记录不一致（记录 b4aec4a7bf34，现在 0eea3f6a5e82）`——
   快照指纹含本层三份的 sha256（`roco/src/roco_env/data.py:477`），层一变指纹必变，
   已录制的回执必然对不上。重建轨迹是 `rebuild-derived.mjs` 的第 14 步，但
   `data/roco/artifact-registry.json#traj-rule-arm-v1` 的 `status` 是 **legacy**，
   台账规则第 3 条写着「status=legacy 的产物**禁止重跑生成**（那只会再生产一批绑定旧规则的产物）」
   ⇒ **不许硬来**。要重跑得先由人类决定采纳 `roster.universe` 这个 rule candidate。
   影响面：`tests/evals/roco/agent-trajectories.test.js` 及其派生产物（SFT / 覆盖切片 / 奖励报告）。
3. **没有重跑整条 `npm run roco:rebuild`**：它包含上面第 2 条那几步（禁止重跑）+ 会重写
   一批与本题无关的产物。本轮只重跑了「按需配招」这一份必须跟着动的。
4. **没有跑 `verify:release`**、没有跑 `roco:pipeline`（都会写产物，且不在任务书点名的四条命令里）。
5. **技能石缺口的 13 个名字为什么全库不出现，仍未确认**（照抄 FEASIBILITY §7.4 的结论：
   没有版本号可证 ⇒ 既不写成「抓包漏收」，也不写成「版本差」）。
6. **本层技能的 `level` / `stage` / 血脉名一律是 `null`**：抓包每条技能只有 8 个键
   （name/cost/power/category/desc/图标），**没有 id、没有等级**（A 文档 B-2 全量实测：
   27482 条里 `level`/`skill_id` 出现 0 次）⇒ 写 `not_provided_by_capture`，**不猜**。
7. **`apply-capture-to-engine.mjs --check` 对基线 `pets.json` 仍是红**（3 条，**本轮之前就是红的**）：
   实测 `pet_000062 音速犬` 的 `atk` 执行域 116 vs 抓包 128、`spa` 38 vs 46，
   且基线 `pets.json` 里**根本没有** `capture_override` 块（旧层那份也没有）。
   证据链：抓包 raw `phy_attack_race=128` / `spe_attack_race=46`、`pets.csv` 同值、
   `full-catalog.json` 已按抓包采用（`stats_source: capture-2026-09-27`，旧值留在 `stats_previous`）。
   ⇒ 基线 12 只里至少这一只**没有跟上人类 2026-09-27 的「以抓包为准」**。
   本轮没动基线（它是 M1 验收基线，逐字节不动是既有纪律），**如实报出来**。
8. **本轮没有逐只人工复核 539 只的配招合理不合理**：只保证「4 个互不重复、都在自己的池子里、
   在 `skills.json` 里解析得到」这三条硬约束（引擎加载期还会再校验一遍）。

### ⑧.1 命令读数（全部本机实测）

| 命令 | 读数 | 耗时 |
|---|---|---|
| `node scripts/roco/build-all-pets-engine-inputs.mjs` | OK：本层 530 / 合计 542 | **0.281 s** |
| `node scripts/roco/build-all-pets-engine-inputs.mjs --verify` | **exit 0**（逐字节一致 + 6 个输入未漂移） | **0.294 s** |
| `node --test`（§⑥ 点名的 4 个 JS 文件） | 91 条：84 通过 / **7 红**（全在 `roco-owned-pets.test.js`，见 ⑧.2） | —— |
| `python3 -m unittest`（§⑥ 点名的 3 个 Python 文件） | 74 条：**全部通过**（1 skip） | 0.32 s |
| `npm run test:unit` | 1752 条：**1729 通过 / 23 红** | **3 分 01.9 秒** |
| `node scripts/roco/eval-five-minute-chain.mjs` | **exit 0**：判据 **19/19**、反证 **19/19**；总 11257ms / 预算 300000ms | 13.2 s |
| `node scripts/roco/browser-box-acceptance.mjs` | **exit 0**：判据 **38/38**、反证 **22/22** | 55.1 s |

> 两条真机验收都是**单独跑**的（没有与别的重活并发）；`test:unit` 也是单独跑的。

### ⑧.2 `test:unit` 那 23 条红的逐文件归属（哪条是我的、哪条不是）

| 文件 | 红 | 根因 | 状态 |
|---|---:|---|---|
| `tests/roco-owned-pets.test.js` | 7 | `owned-pets.json` 里钉着**旧层的 sha256 与数组下标** | **卡在口径决定**（见 ⑧.1 第 1 条） |
| `tests/roco-team-ranker.test.js` | 6 | 盒子里那 **7 只**（见 ⑥）没有冻结学招表 ⇒ 成对特征（`respond_coverage` 等）算不出 | 同一个口径决定的另一面：盒子要不要继续装这 7 只 |
| `tests/roco-rag-eval.test.js` | 4 | RAG 语料里 `owned::own-0001` 的 sha256 对不上磁盘（就是 `owned-pets.json` 的 provenance） | 同上 |
| `tests/roco-hke-layer.test.js` | 2 | ① 「抓包不许并进 `normalized/**`」这条**许可边界**判据与人类「用抓包数据实装全部精灵」直接冲突（而 `data.py:22` 要求这一层必须待在 `normalized/` 里）；② `KNOWN_DIVERGENCE` 表登记的执行域旧值（铠甲虫 atk 95）现在按抓包变成 88 | **要人判**：这条守卫属于许可边界，我不单方面放宽 |
| `tests/roco-weather-pvp.test.js` | 1 | 探针里写死的 (精灵, 技能) 对（如 智辉章脑→落雨）在新的抓包池里学不到 | 可改钉（换一组池内技能）；本轮**没做完** |
| `tests/evals/roco/agent-trajectories.test.js` + `model-trajectories.test.js` | 2 | 快照指纹变了 ⇒ 已录制的 `query_rules` 回执对不上 | **台账禁止重跑**（见 ⑧.2 第 2 条） |
| `tests/roco-human-todo.test.js` | 1 | `docs/roco/HUMAN-REVIEW-CHECKLIST.md:38` 写「49 个个体」，`owned-pets.json` 里是 **48** | **本轮之前就是红的**（两个文件我都没碰；`git diff --stat data/roco/owned/owned-pets.json` 为空） |

### ⑧.3 更正：`--verify` 的「基线漂移」检查覆盖了哪些文件

`generated_from` 记了 **6** 个输入的 sha256（基线 `pets.json`/`learnsets.json`/`support-matrix.json`、
`skills.json`、`types.json`、`full-catalog.json`），`--verify` 逐个比对 ⇒
**任何**一个上游变了（包括 `full-catalog.json` 重导）都会让本层报红，提示重跑一次。
抓包原始目录的 sha256 用「文件名 + 逐个文件 sha256」拼出来再取 sha（目录没法直接取哈希）。

---

## ⑩ 甲案落地后的复核读数（2026-09-28 下半场）

| 命令 | 读数 | 耗时 |
|---|---|---|
| `node scripts/roco/build-owned-pets.mjs --check` | **逐字节相同**（542 实例 / 542 物种 / 0 组同种 / 542 battle_builds） | —— |
| `npm run test:unit`（改钉前那次） | 1756 条：1748 通过 / **8 红** | **3 分 30.4 秒** |
| 其中「派生报告过期」3 条 → 重生成后 | `roco-team-request` 17/17、`roco-team-compare` 14/14、`roco-opponent-belief` 13/13 **全绿** | —— |
| 4 个已知红套件单独跑 | 27 条：22 通过 / **5 红**（= 全部已知红，一条不多） | —— |
| 受影响的 15 个套件（owned/盒子/RC-301..604/RAG） | **223 条全绿** | —— |

**改钉（这一轮新增，旧值都留在注释里）**：`tests/roco-box.test.js`（分页上界写死 200）、
`tests/roco-v3-redirect.test.js`（RC-203 诚实条款 48/574/true/0 → 542/80/false/501）、
`tests/roco-team-gaps.test.js`（41/7/48 → 542/0/542；⑪/⑮ 的「不在盒子里的物种」样例改成现挑）、
`tests/roco-team-candidates.test.js`（`must_include` 撞物种、短欠样例的排除条数）、
`tests/roco-workshop.test.js`（5 只样例）、`tests/roco-owned-pets.test.js`（444/542/3 只漂移/80）、
`tests/roco-team-ranker.test.js`（542 / C(542,2)=146611，队伍切分改成按实例数现算）、
`data/roco/rag/heldout-queries.json`（E07 锚点）、`docs/roco/HUMAN-REVIEW-CHECKLIST.md`（49 → 542）。

**代码侧两处**（都不是放宽判据）：`src/coach/team-gaps.js` 的 `respondSeparationHolds()` 第②条
（`build == 0` → **严格不等式** `0 < build < learnset`；三条反证照样红）、
`scripts/roco/build-rc602-report.mjs` 的 `Math.min/max(...)` → `minMax()`（146611 个参数会撑爆调用栈）。

**本轮仍未做**：`browser-box-acceptance.mjs` 与 `eval-five-minute-chain.mjs` **没跑**
（同一工作区有人在跑真机验收，避免互相干扰）；`docs/roadmap/DSH-EXECUTION-STATE.md` 的台账段**没写**
（与另一位 agent 约好：写之前先报备）。
