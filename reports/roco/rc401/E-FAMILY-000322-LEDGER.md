# E 族缺口一 · `skill_000322 消毒法`「驱散敌方5层增益」—— 实现台账

> 作者：`engine-mechanics` · 日期：2026-09-30 · 写域：`roco/src/roco_env/**` + `roco/tests/**` + `reports/roco/rc401/**`

## 0. 当前状态（**先写状态，防"红/绿着过夜没人知道"**）

```
命令（必须从 roco/ 跑 ✗ 否则出假 ImportError）：
  cd roco && python3 -m unittest discover -s tests -t .
读数（逐字）：Ran 839 tests in 42.379s
              OK (skipped=1)
退出码：0  ✅
```

**曾在 2026-09-30 中途红过一次，已收口**（过程留档，改钉不删）：
```
Ran 839 tests in 42.768s
FAILED (failures=1, skipped=1)   exit=1
FAIL: test_report_has_no_simulatable_with_unclaimed_mechanic_spans
AssertionError: 304 != 303 : 可模拟总数变了，先核对再改这条
归因：000322 变 resolved=True ⇒ 可模拟 +1（303→304）⇒ 而 legacy _EXTRA_MECHANIC 里仍有
      「驱散：驱散敌方5层增益」「层：…」两条残余 ⇒ "可模拟 ∧ 有残余" ⇒ 必红
收口：coverage.py 两处「已声明能力覆盖的 kind 白名单」加 "cleanse_buffs_layers"（照
      cleanse_buffs_one / cleanse_marks 同一套做法，未另发明）⇒ 转绿 ✅
```

## 1. 实现（3 处 · 2 个文件）

| 文件:行 | 改动 |
|---|---|
| `roco/src/roco_env/parse.py:191-198` | 新增 `_CLEANSE_BUFFS_LAYERS = re.compile(r"驱散敌方\s*(\d+)\s*层\s*(增益\|减益)")`（**不碰 `_EXTRA_MECHANIC`** ⇒ golden 指纹不动） |
| `roco/src/roco_env/parse.py:673-682` | `resolve_cleanse_marks` 内产出 `Effect(kind="cleanse_buffs_layers", …)` |
| `roco/src/roco_env/env.py:2263-2303` | 运行时新支 + **Δ=0 对照**；本地规则 `ENGINE_HYPOTHESIS`：**一层 = 一个非零增益键，按 abs(百分比) 从大到小最多清 N 层**（事件带 `basis` 如实标注、与原始资料区分） |
| `roco/src/roco_env/coverage.py:162,1046` | 两处认领白名单加 `cleanse_buffs_layers`（**这是那条红的收口** ✅） |

⚠ **未动**：`rule_config.py`（复用既有 `damage_cleanse_dispatch` 位 ⇒ 未新开位）· `scripts/roco/build-rule-configs.mjs`（无新位 ⇒ 无 `reason` 需改）· `data/roco/rulesets/*.json`（只由生成器写）

## 2. 判据：实现前 → 实现后

| | `settlement_verdict(skill_000322)` |
|---|---|
| **实现前** | `resolved=False` · `unsettled=['驱散：驱散敌方5层增益','层：驱散敌方5层增益']` · **`parse_skill` 连一条 effect 都不产出** |
| **实现后** | **`resolved=True`** · `settled=['伤害','持续状态层数/回合','驱散']` · `unsettled=[]` |

## 3. 运行时报据（正例 · Δ≠0）

```
_cast("skill_000322", foe_buffs={"spa":70,"def":30})
事件：{'side':'player','what':'增益','cleared':['spa','def'],'layers_requested':5,
       'layers_cleared':2,'picked_deltas':[70,30],'basis':'一层 = 一个非零增益键，按 abs(百分比)
       从大到小最多清 N 层（本地规则：ENGINE_HYPOTHESIS…）','from':'cleanse_buffs_layers'}
快照：snap['foe_buffs'] = {}   ⇒ 两个增益真的被清掉 ⇒ Δ≠0 ✅
排序规则被验证：请求 5 层、实际 2 层、picked_deltas=[70,30] ⇒ 先清绝对值大的 ✅
```

## 4. Δ=0 反证（⚠ 本轮偏弱，待加强）

```
_cast("skill_000322", foe_buffs={})
事件：{'cleared':[],'layers_requested':5,'layers_cleared':0,'picked_deltas':[],
       'basis':'对手身上没有这一极性的增益/减益层','from':'cleanse_buffs_layers'}
⇒ Δ=0 且如实说"什么都没发生"（不静默）✅
⚠ 弱点：敌方一开始就没有增益 ⇒ "没变"是平凡的。
  待做（更强）：极性不符 —— 敌方挂【减益】、请求驱散【增益】 ⇒ 应 cleared=[] 且减益存活。
```

## 5. 台账增量（+1 已核对、旧值留档）

```
roco/tests/test_effect_coverage.py:832-843
  改钉 303 → 304（**先核对、后改数** —— 不是"改黄金答案刷绿"）：
    核对读数：新增正则 _CLEANSE_BUFFS_LAYERS 在 824 条里**只命中 skill_000322 一条** ✅
              settlement_verdict 由 False → True ✅
              而 env 新支真的结算它（cleared=['spa','def'] · layers_cleared=2）✅
    ⇒ 恰好 +1 ⇒ 台账必须跟着涨（人类口径「每条做完台账 + 判据双涨、零降档」）
  ⚠ 旧值 303 逐字留档（改钉不删）：它 = 000322 实现之前的口径
```

## 6. 未做项（如实点名 ✗ · 不凑数）

1. ✗ **对照实验**（真改坏 `parse.py` 那条正则 ⇒ 判据翻回 `False` ⇒ 复原 ⇒ hash 逐字回 `1247c2dbab…`）
2. ✗ **`test_cleanse_marks.py` 用例**（正例 + Δ=0 目前**没有判据钉住**）
3. ✗ **更强的 Δ=0 对照（极性不符）**
4. ✗ **`skill_000446`（E 族缺口二：自己每有1层减益 ⇒ 本技能能耗-1）** —— **可达口径已完成（路 B）· 结算口径待人类拍板** ✓ ⇒ ⚠ **`resolved=True` 对本条**不可达**** ✓：**4 条 `unsettled` 全来自 legacy 表**（`unclaimed_mechanic_spans` ✓），且**「变：巧变」不属 E 族** ✓ ⇒ **E 族改动**原理上**翻不动它**；**清 legacy 表是 golden 指纹红线** ✗（详见 `E-FAMILY-000446-LEDGER.md` §4 三态实测 ✓）
5. ⚠ **偏离待裁**：复用既有 `damage_cleanse_dispatch` 位、未新开位、未动生成器 `reason`

## 7. hash 对照（连被测产品文件一起记）

| 文件 | 实现前 | 实现后 |
|---|---|---|
| `roco/src/roco_env/env.py` | `043d8dcacbcd256e5fae45f3f688a6ffdb3bb2d36d3eda9bc1910963e4af4e2d` | `35971ebd22f6f2444dda95721549cb793e73aab166b5e22b68c092c56953da29` |
| `roco/src/roco_env/parse.py` | `3c5e54f01014d1b23335ee1a44682dfec33013f705401439a37c8e84acab8d8a` | `1247c2dbab705d4ea46d4ea3e820d029dbd05bc2c2d37a476c22f599940cb5c5` |
| `roco/src/roco_env/rule_config.py` | `e1f710f972e6cd24cfa5f7a96846369efad9c3123d44f0e4e898945dc1194c60` | 未变 |
| `roco/tests/test_cleanse_marks.py` | `0719653024f4610dd404813b092c9c8b272c7d704dc3296e40bf0266fd4b5f4a` | 未变 |

## 8. E 族分母（实测口径，**脚本自断言**）

```
描述含「驱散」的技能：16 条 = resolved=True 8 条 + resolved=False 8 条
  （assert 总数==16 ✓ · assert len(yes)==8 and len(no)==8 ✓）
真 E 缺口（8 条未通里扣掉 6 条别族）：**2 条** = skill_000322（本轮已实现）+ skill_000446（**可达口径已完成（路 B）** ✓ · 结算口径待拍板 ✓）
已通清单（8）：000325 000407 000408 000409 000415 000628 000652 000719
未通清单（8）：000152 000322★ 000332 000333 000441 000446 000650 000703
```

---

# 附录 A（2026-09-30 收尾 · 三条全部完成）

## A1. 对照实验（改坏 ⇒ 判据必红 ⇒ 复原 ⇒ hash 逐字）

| 阶段 | `parse.py` hash | `settlement_verdict(skill_000322)` |
|---|---|---|
| **改坏前**（正常） | `1247c2dbab705d4ea46d4ea3e820d029dbd05bc2c2d37a476c22f599940cb5c5` | `resolved=True` · `unsettled=[]` · `effects=['cleanse_buffs_layers']` |
| **改坏时**（把 `:198` 的 `层` 去掉） | `e0f5adf8681227eee7605383de56f180caed54345992d921ad8e94acffeb9b32` | **`resolved=False`** · `unsettled=['驱散：驱散敌方5层增益','层：驱散敌方5层增益']` · **`effects=[]`** |
| **复原后** | **`1247c2dbab705d4ea46d4ea3e820d029dbd05bc2c2d37a476c22f599940cb5c5`** ✅ **逐字相同** | `resolved=True` · `unsettled=[]` · `effects=['cleanse_buffs_layers']` |

⇒ ✅ **对照成立**：判据**确实**由那条正则驱动（红 = 控制实验的**故意**红，不是产品坏）。
⚠ 教训：**"在内存里拿掉 effect"这条捷径不通** —— `settlement_verdict` **内部重新 parse**（吃 `skill`，不吃调用方那份 `parsed`）⇒ **必须真改文件**。

## A2. 新增用例（`roco/tests/test_cleanse_marks.py` · 14 → **16** 条）

```
Ran 16 tests in 0.010s
OK                      exit=0        ← test_cleanse_marks（单文件）
```
- **正例** `test_dispel_n_layers_positive`：`_cast("skill_000322", foe_buffs={"spa":70,"def":30})` ⇒
  断言 `from=cleanse_buffs_layers` · `cleared=['spa','def']` · `layers_requested=5` · **`layers_cleared=2`**（**不许凑成 5**）·
  `picked_deltas=[70,30]`（**按 abs 从大到小**）· **`snap['foe_buffs']=={}`**（Δ≠0）✅
- **Δ=0（更强的那个 · 极性不符）** `test_control_polarity_mismatch_delta_is_zero`：
  `_cast("skill_000322", foe_buffs={"atk":-40})` ⇒ 断言 **`cleared==[]`** · `layers_cleared==0` ·
  **`snap['foe_buffs']=={"atk":-40}`（那个减益必须原样存活）** ✅
  ⇒ 这比"传空输入"强：它同时证明**不会多清** ✅

## A3. hash 对照表（补 `coverage.py` —— 上一版缺它）

| 文件 | 实现前 | 收口后（当前） |
|---|---|---|
| `roco/src/roco_env/env.py` | `043d8dcacbcd256e5fae45f3f688a6ffdb3bb2d36d3eda9bc1910963e4af4e2d` | `35971ebd22f6f2444dda95721549cb793e73aab166b5e22b68c092c56953da29` |
| `roco/src/roco_env/parse.py` | `3c5e54f01014d1b23335ee1a44682dfec33013f705401439a37c8e84acab8d8a` | `1247c2dbab705d4ea46d4ea3e820d029dbd05bc2c2d37a476c22f599940cb5c5` |
| **`roco/src/roco_env/coverage.py`** | （未记 ✗） | **`9bb3a345f6ffef8951e44ecefea9772e66032f33274e96cd073b761786f61ea5`** ✅ |
| `roco/src/roco_env/rule_config.py` | `e1f710f972e6cd24cfa5f7a96846369efad9c3123d44f0e4e898945dc1194c60` | **未变** ✅ |
| `roco/tests/test_cleanse_marks.py` | `0719653024f4610dd404813b092c9c8b272c7d704dc3296e40bf0266fd4b5f4a` | **已变**（+2 用例 ⇒ 见 A2）⚠ |
| `roco/tests/test_effect_coverage.py` | （未记 ✗） | 已变（期望值 303→304 + 核对注释）⚠ |

## A4. ⚠ 两条**运行口径**警告（**别留着误导下一个人** ✗）

```
★ **全量引擎套件必须从 `roco/` 跑**：
     cd roco && python3 -m unittest discover -s tests -t .
   ❌ 从**仓库根**用 `-s roco/tests -t .` ⇒ `from tests import …` 解析到**仓库根的 JS `tests/`**
      ⇒ **假 `ImportError: cannot import name 'test_turn_order_fail_closed' from 'tests'`**
      ⇒ 那不是回归，是**命令口径**错（本会话已因此误判过一次）。
★ **该判据不依赖任何产物** ✅（`test_effect_coverage.py:28` ⇒ `self.report = cov.build_coverage(RS)` **测试内现算**）
   ⇒ **"须在产物新鲜时读"这条警告作废** ✗（上一版曾据此怀疑假红 ⇒ 已更正）
★ **看清单别用 `tail`** ✗ —— 会静默切掉条目（本会话中招两次：`git diff --stat | tail -12` 把
   `coverage.py` 切掉 ⇒ 误判"未动"）。

## A5. E 族 +1 · 零降档（成段）

```
🔴 **改钉（2026-09-30 ✓ `#114` 产物带日期）—— 下面两行**旧值逐字保留、一个字未删**** ✓：
  旧：E 族分母（实测）：描述含「驱散」= **16 条 = 8 通 + 8 未通**（脚本自断言 ✓）
  旧：真 E 缺口 = 8 未通 − 6 条别族 = **2 条**：`skill_000322`（本轮**已实现** ✅）+ `skill_000446`（**可达口径已完成（路 B）** ✓ · 结算口径待拍板 ✓）
  ⚠ **旧值写在 `000322` 实现**之前**** ✓ —— **台账自己那句「`000322` **本轮已实现**」就是**时间戳**** ✓（这正是 `#114`：台账的数会过期 ✓）
  ✅ **新读数（2026-09-30 ✓）**：描述含「驱散」= **15 条 = 9 通 + 6 未通** ⇒ **真缺口 = 6**
     未通逐字：`skill_000332 倾泻` · `skill_000333 吹散` · `skill_000441 洗礼` · `skill_000446 清洗` · `skill_000650 翅刃` · `skill_000703 飞羽`
  ✅ **依据**：**逐条表 15 条（含"命中正则名"列）** + 🔴 **静态 `resolved` 与**活服务** `resolved` **15/15 完全一致**（分母 15）**
  ⚠ **`16` 的数法**找不到**** ✗：`grep -rn 驱散 roco/tests/` 命中 4 文件（`test_tier_verdict_agreement` / `test_event_text` /
     `test_cleanse_marks` / `test_effect_coverage`）**均非那个计数脚本** ⇒ **`#63`：判不了是欠账** ✓
  🔑 **`#113` 的现场（保留）**：**11 条 `kinds=[]` 里 6 条 `resolved=True`** ⇒ **按 `kinds` 判会误报 11 条没实现** ✗
台账 +1：`simulatable_entities` **303 → 304**（**先核对后改数** ✓ · 旧值 303 逐字留档 ✓）
零降档（硬判据）：`cd roco && python3 -m unittest discover -s tests -t .`
   ⇒ **`Ran 839 tests` · `OK (skipped=1)` · exit=0** ✅（收口前同命令为 `FAILED (failures=1, skipped=1)` ✗）
单文件：`test_cleanse_marks` **14 → 16** · `OK` · exit=0 ✅
```

## A6. 仍未做（如实 ✗）

1. ✗ **`skill_000446`**（E 族缺口二：自己每有1层减益 ⇒ 本技能能耗-1）—— **可达口径已完成（路 B）** ✓ · **结算口径待人类拍板** ✓ ⇒ ⚠ **`resolved=True` 对本条**不可达**** ✓：**4 条 `unsettled` 全来自 legacy 表**（`unclaimed_mechanic_spans` ✓），且**「变：巧变」不属 E 族** ✓ ⇒ **E 族改动**原理上**翻不动它**；**清 legacy 表是 golden 指纹红线** ✗（详见 `E-FAMILY-000446-LEDGER.md` §4 三态实测 ✓）
2. ⚠ **偏离待裁**：复用既有 `damage_cleanse_dispatch` 位 · 未新开能力位 · 未动生成器 `reason`

## A7. 五条读数一条不落（**对照实验 · 同回合做齐** ✓ · 2026-09-30 收尾）

> 做法：`read` `parse.py:191-198` ⇒ `edit` **只去掉 `:198` 的「层」一个字** ⇒ 立刻取读数 ⇒ 立刻 `edit` 复原 ⇒ 复绿。
> ⚠ 硬红线遵守情况：**未留改坏态** ✓（复原后 hash 逐字回基线 ✓）。

| # | 读数 | 逐字值 |
|---|---|---|
| 1 | **改坏态 hash** | `e0f5adf8681227eee7605383de56f180caed54345992d921ad8e94acffeb9b32` |
| 2 | **判据红（单文件）** | `Ran 16 tests in 0.011s` · **`FAILED (errors=2)`** · **exit=1** · 红的**正是新增那两条**（**零连带** ✓）：`ERROR: test_control_polarity_mismatch_delta_is_zero` · `ERROR: test_dispel_n_layers_positive`（**都在 `BuffsLayersCleanseTest`** ✓） |
| 3 | **`resolved` 翻回** | **`resolved = False`** ✓ · **`unsettled = ['驱散：驱散敌方5层增益', '层：驱散敌方5层增益']`** ✓（**回到实现前那两条** ✓）· `effects = []` ✓ |
| 4 | **复原 hash** | **`1247c2dbab705d4ea46d4ea3e820d029dbd05bc2c2d37a476c22f599940cb5c5`** ✅ **与基线逐字相同** |
| 5 | **复绿** | `Ran 16 tests in 0.010s` · **`OK`** · **exit=0** ✅ |

⇒ ✅ **五条定义的第⑤条（对照实验）补齐**：**改坏 ⇒ 判据必红（且只红那两条）⇒ 复原 ⇒ hash 逐字相同 ⇒ 复绿** ✓
⇒ 🔑 **"改坏时的红"是**故意**的** ✓ —— **判据红 ≠ 产品坏**；**且它是"判据真的钉住了这条实现"的证据** ✓
⇒ ⚠ **同时实证**：`settlement_verdict` **内部重新 parse** ⇒ **"在内存里拿掉 effect"这条捷径不通** ✗（必须真改文件 ✓）


> **Lead 裁定（§698.5 / §706.5）：复用既有 `damage_cleanse_dispatch` 位 ⇒ **通过**。**
> 理由：`coverage.py:162/1046` 两处文本本来就相同 ⇒ 两条链本就该同改；新开位反而多一处要同步的地方；
> `rule_config.py`/`rulesets` 未动 ⇒ legacy/v2 逐字不变 ⇒ 生成器 `reason` 无需改。

## A8. 台账行数

```
A7 之前 173 行 ⇒ 本段追加后 **见 `wc -l`**（人类口径：**台账 + 判据双涨** ✓）
```

## A9. Lead 裁定（2026-09-30）：**复用既有 `damage_cleanse_dispatch` 位 ⇒ 通过** ✅

> 裁定原文要点：**这不叫偏离，是正确的最小改动** ✓。写在台账里，免得下一个人再问一遍。

① 收口走的**正是既有那套映射表** ✓（`coverage.py:162` 与 `:1046` **两处文本本来就相同** ⇒ **两条链本就该同改** ✓）
② **新开位反而多一处要同步的地方** ✗（**多一处 = 多一个会走偏的点** ✓）
③ `rule_config.py` **未动** ⇒ **legacy/v2 逐字不变** ✓ · `data/roco/rulesets/*.json` **未动** ✓
④ ⇒ **生成器 `reason` 确实无需改** ✓ ⇒ **"声称范围与实现一致"仍成立** ✓

---

## 附录 B（2026-09-30 · E 族总账收口 · **2/2 都有交代** ✓）

```
**E 族分母 = 16** ✓（描述含「驱散」的技能数 ✓ · `assert 总数 == 16` ✓）
  · **8 通** ✓ · **8 未通** ✓
  · **8 未通里扣掉 6 条别族 ⇒ 真缺口 = 2** ✓（`skill_000322` + `skill_000446` ✓）
⇒ ✅ **2/2 都有交代** ✓ —— **但两笔的性质**不同**，别混 ✗**：
  · **`skill_000322`「消毒法」= **5/5 完成** ✓**（**翻得动、且已翻** ✓ —— `resolved` `False→True` ✓ ·
    台账 `E-FAMILY-000322-LEDGER.md` ✓ · 对照实验三态 ✓）
  · **`skill_000446`「清洗」= **可达口径已完成（路 B）** · 结算口径待人类拍板** ✓**
    （**翻不动、且已证明为什么** ✓ —— `resolved=True` 对本条**不可达** ✗；见其台账 §4 ✓）
⇒ 🔑 **"一门两笔"** ✓ —— **能翻的翻到位、翻不动的把"为什么翻不动"证到位** ✓；
  **两者都不许记成对方的样子** ✗（**记错就是假报** ✗ —— 产品口径「不许假报」✓）
```
