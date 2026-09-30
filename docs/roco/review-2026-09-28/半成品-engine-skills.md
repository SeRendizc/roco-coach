# 半成品排查 · `engine-skills` 的块：**判据诚实性**（2026-09-30）

> **我审的是哪一版（冻结修订）**：`roco/tests/**` 57 个文件 · `assert*` 共 **2512 条**；
> 引擎侧 `roco/src/roco_env/*.py`（19 个文件）。
> hash（读前记录，`shasum -a 256 | cut -c1-8`，按 `ls` 顺序）：
> `ff600607 737e9c21 d92786ef d703ff24 52119c3e 0b7db59a 0f89685e 4fbac1dc 8c6fcab6 96c766d5
> 978f07fa dbb5c80a c0ea06d9 1e53fd6b 74f53be5 c29c5cba b4e91196 a0a74d85 6c819d78`
> 台账基线：`747 OK (skipped=1)` · 四条闸 exit 0 · effect-coverage **299/824**。
> 扫描器：`tmp/judge-audit.py`（AST，不是正则）+ 两段只读探针（命令随每条给）。

## 一、一张表

| # | 文件:行 | 现象（一句话） | 证据（逐字 / 读数） | 判定 | 修复成本 | 优先级 |
|---|---|---|---|---|---|---|
| 1 | `coverage.py:212`（`SETTLED_PATTERNS` 文本表）+ 特性 `skill_000145/146/147` | 三条**特性**描述是「应对成功后，**下次**…」，引擎里**根本没有"下次"这类延迟效果机制**，但判据因为描述里有「应对」二字就判 `resolved=true` | 全仓 `grep -n "下次" roco/src/roco_env/*.py` ⇒ **只命中一条注释**（`coverage.py:222`）；`grep "next_attack\|pending_buff\|delayed\|_next_"` ⇒ **0 命中**；三条 `settlement_verdict` 均为 `resolved=True / settled=['应对'] / effects=[]` | **半成品 ⓕ**（只在解析层；运行时零结算） | 中（要新增"延迟效果"原语，或先把它们如实判 false） | **P0** |
| 2 | `coverage.py` 同上 + `skill_000383`（技能） | 同族：描述写「应对状态：**下次**攻击技能威力翻倍」，运行时实测 `power_used` 70 → **140**（**这一手**就被翻倍） | Lead/`engine-mechanics` 的运行时读数（`skill_000383` 基础威力 70，对手出状态招 ⇒ `power_used=140.0`；攻击招 ⇒ `70.0`）；判据判 `resolved=False` ✓（**方向对**），但**另一个机制被按错语义执行** | **半成品 ⓕ**（语义错，不是"没做"） | 中 | **P0** |
| 3 | `test_effect_coverage.py:36-38` | 只钉**总数**（`battle_skills=579` / `traits=245` / `entities=824`），改数据就能改数字 | `self.assertEqual(totals["battle_skills"], 579)` 等三行 | **弱判据**（不是半成品；但**单靠它**不构成"功能在"） | 低（已有 4 条更强的同文件判据兜底 ✓） | P3 |
| 4 | `test_effect_coverage.py:601`（`simulatable_entities`） | 只钉一个**派生计数**，没有同行的**逐条**判据 | `self.assertEqual(report["totals"]["simulatable_entities"], 287)` | **弱判据** | 低 | P3 |
| 5 | `test_six_pet_battle.py:544` | 唯一一条"恒真形态"命中：`assertEqual(renv.serialize(state), renv.serialize(state))` | 逐字见上 | **不是恒真**（它判**确定性**：`serialize` 若引入时间/随机/字典序漂移就会红）⇒ **保留** ✓ | — | — |
| 6 | `test_effect_coverage.py:162` / `225` / `test_learnset_lookup.py:91` 等 **21 处** | `assertGreater(x, 0)` / `assertGreaterEqual(x, 50)` —— 下限型 | 例：`assertGreater(ranking["连击"]["skills"], 0, …)` | **弱判据**（"非空"≠"对"）；但它们**都是同一文件里更强判据的补充**，不是唯一防线 | 低 | P3 |
| 7 | 全库 `assertIn` **201 处** | 逐条读过"容器是 dict/事件 detail"的 **23 处** ⇒ **22 处其实是值断言**（`assertIn("没有更换精灵", skipped[0].detail["reason"])` 读的是**值**）· 只有 1 处近乎只判"有键" | `test_mana_actions.py:529` `self.assertIn("surrender", [e.kind for e in state.events])`（判的是 kind 列表成员，**不是**事件 detail 的键） | **基本干净** ✓（**本类没有成规模的"只判有键"**） | — | — |
| 8 | 427 并集 · `tier ↔ verdict` | task-24 修到 0 之后**是否仍是 0** | 探针：`svc._skill_record(...)["support_tier"]` vs `C.settlement_verdict(...)["resolved"]` ⇒ **打架 = 0**（逐条比对 427 条） | **已完成** ✓ | — | — |
| 9 | 全库 `rs.skills`（860 条） · `resolved=true` 但**解析效果为空且无静态威力** | 4 条 —— 其中 3 条是上表 #1；第 4 条 `skill_000286 防御`「减伤70%，应对攻击」**是真结算**（读点不在 `parsed.effects`，而在 `effects.parse_defense_reduction()` / `respond_to()`，`env` 的防御支） | 探针输出：`skill_000145/146/147`（`settled=['应对'] effects=[]`）· `skill_000286`（`settled=['减伤','应对']`，但 `defense` 事件真发） | #1 是**半成品**；`286` 是**已完成** ✓（**假阳性，如实说明**） | — | — |

## 二、一句话总结

**判据这一块整体是诚实的** —— ③「恒真」**0 条真命中**（唯一形态命中是判确定性的，保留）、①「只判有键」**23 处逐条读过、22 处其实是值断言**、⑤「档位↔判据」**仍是 0** ✓ ；
**真正的半成品只有一族、但很硬**：`coverage.SETTLED_PATTERNS` 是一张**文本表**，`「应对」两个字一出现就判已结算**，
于是「**应对成功后，下次…**」这类**延迟效果**（特性 `skill_000145/146/147` + 技能 `skill_000383`）在**引擎里零实现**的情况下被判 `resolved=true` ——
号 **P0**：它与 Lead 已发现的 `383`「下次被按本次执行」是**同一族**，建议**一起修**（要么补"下次"原语，要么先把这 4 条如实判 false）。

## 三、方法与被排除的假阳性（**如实登记**）

- **② 计数类**：机械命中 51 处，逐类看过 —— 绝大多数是**行为判据的伴随断言**（如「`len(applied)==1`」旁边就有 `applied[0].detail[...]` 的值断言）；只有表中 #3/#4 是"**只有**总数"。
  ⇒ **不该一律当半成品** ✗（改数字能过 ≠ 它是唯一防线）。
- **⑥ 过宽类**：21 处下限断言里，`test_microcases.py:442-443`（`applied>0` + `registered>0`）**是刻意的**：它同时要求「有支持的」**和**「有如实登记未支持的」⇒ 比单侧更强 ✓。
- **④ 的探针口径**：「解析效果为空 + 无静态威力」只是**嫌疑**，不是判定 —— `skill_000286` 就是反例（读点不在 `parsed.effects`）。
  ⇒ 表里只把**逐条核实过**的写成"半成品" ✓。
- **0 命中就怀疑自己** ✓：① 类第一次粗扫得 201 处，我没有直接下结论，而是**收窄到"容器是 dict/事件 detail"** 再逐条读 ⇒ 23 处；**没有出现"连续两次 0 命中"**的情形。

## 四、复跑命令

```bash
python3 tmp/judge-audit.py                # ②③①⑥ 的机械候选（AST）

# ⑤ 档位↔判据（427 并集）
cd roco && PYTHONPATH=src python3 -c "
import json
from roco_env import data as rdata, coverage as C, service as S
rs=rdata.load_ruleset(); svc=S.RocoService(); SIM=(C.SUPPORT_SIMULATABLE_UNVERIFIED,C.SUPPORT_FULL_VERIFIED)
ids=sorted({r['skill_id'] for r in json.load(open('tests/data/pets100-skills-census.json'))['rows']})
bad=[(s,svc._skill_record(rs,rs.skills[s],with_tier=True)['support_tier'],C.settlement_verdict(rs.skills[s])['resolved'])
     for s in ids if s in rs.skills
     and ((C.settlement_verdict(rs.skills[s])['resolved']) != (svc._skill_record(rs,rs.skills[s],with_tier=True)['support_tier'] in SIM))]
print('打架 =', len(bad))"

# ④ 无依据的 resolved=true（全库）
#   同 §一 #9 的探针：settlement_verdict 的 parsed.effects 去掉 hit_count 后为空 **且** has_static_power 为假
# 「下次」有没有实现：
grep -rn "下次" roco/src/roco_env/*.py          # ⇒ 只有 coverage.py:222 一条注释
grep -n "next_attack\|pending_buff\|delayed\|_next_" roco/src/roco_env/env.py roco/src/roco_env/schema.py   # ⇒ 0 命中
```
