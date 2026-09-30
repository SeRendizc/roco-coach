# 交接：Roco Coach 执行计划（给下一台电脑 / 下一个 DSH 会话）

**写于** 2026-09-30 17:0x（Asia/Shanghai）· **分支** `wip/roco-coach-2026-09-30-1418` · **远端** Gitee
**接手第一件事**：读 `docs/roco/execution/START-HERE.md` → `MASTER-PLAN.md` → `STATE.json` → 当前 `active_plan` 的分计划；再读本文件（它只讲"现在在哪、为什么、下一步"）。

---

## 0 · 一句话现状

**产品已从"Python 服务不可用"恢复到可用**（8765 `available:true`、隔离实例 health/battle_new/legal/advance/技能详情 6/6 通过、427 并集档位↔判据 **0 打架**）；
**分计划 00 仍 `in_progress`**，只剩 **2 条**已知红（台账总数 313 vs 钉 306；反证闸覆盖面 6<8）。01 已开工（只读勘察完成，写域已批准）。

---

## 1 · 交接时的硬读数（都可复跑，别信叙述）

| 项 | 读数 | 命令 |
|---|---|---|
| 分支 / 远端 | `wip/roco-coach-2026-09-30-1418`（Gitee） | `git ls-remote --heads gitee wip/roco-coach-2026-09-30-1418` |
| 引擎入口 | `import roco_env.service` 无输出 | `cd roco && PYTHONPATH=src python3 -c "import roco_env.service"` |
| 全量判据 | **`Ran 847 · 2 failures + 0 errors`**（本次会话开始时是 `669 · 2F + 83E`，12 个模块 import 就挂） | `cd roco && PYTHONPATH=src python3 -m unittest discover -s tests -q` |
| 427 并集 档位↔判据 | **0 打架**（硬指标，别弄红） | 见 §5 命令 |
| 台账可模拟总数 | **313**，判据钉 **306**（差 +7） | 同上 |
| 隔离验收工具 | `python3 scripts/roco/isolated-acceptance.py` → **exit 0（6/6）**；`--fault-inject missing-export` → **exit 2**；`--fault-inject missing-capability` → **exit 1** | 直接跑 |
| 启动烟测 | `python3 scripts/roco/smoke-service-import.py` → 正常 `exit 0`；临时副本删导出 → `exit 1` | 直接跑 |
| 玩家 8765 | `available:true`、`health` 有效、`last_error:null` —— **只证明探活**，不证明常驻版本/整局 | `curl -s localhost:8765/api/roco/status` |

**三条必须分开写**：`code` 已修 / `isolated` 已通过 / `player` 仅探活。不许把隔离通过写成"玩家已生效"。

---

## 2 · 这次到底修了什么（别再重做）

**根因三条**（都实测）：
1. 一次 WIP 快照把 `service.py` 的新写法提交了，同一批 `coverage.py` 新写法**没提交** ⇒ 缺 **8 个名字**（不是交接文档说的 5 个）：`settlement_verdict` `classify_skill_declared` `_CAPABILITY_TO_FLAG` `residual_mechanic_spans` `RESPOND_POWER_SETTLED_RE` `compound_clause_gaps` `respond_clause_gaps` `UNSETTLED_WORDS`。
2. `coverage.py` 硬读 `initiative_power['pct']`，而 `parse.py:2096` 已支持 `hits` 形状 ⇒ `build_coverage` 必崩。
3. `declared_capabilities_of` 缺 `element_use_ramp` 等新叶子。

**已落地**：`coverage.py` 增量补回（唯一映射表 `_CAPABILITY_TO_FLAG`、共用闸 `claimed_mechanic_words`/`residual_mechanic_spans`/`respond_clause_gaps`/`diagnostic_shape_gaps`/`compound_clause_gaps`、`settlement_verdict`、`classify_skill_declared`）+ 两处独立缺陷 + 逐族收窄。

**关键设计（改之前先读，别推翻）**：
- `classify_skill_declared` = 把 caps 展开成 flags 交 `classify_skill`，再**单向**与 `settlement_verdict` 对齐（只允许 SIM→PARTIAL）。反方向**故意不动** —— 那是反证判据要测的。
- `resolve_claims` 是**唯一的认领链**（九步既有 + 扩展族），`settlement_verdict` 与判据都吃它。
- 认领**只由证据算**：效果自带 `evidence` 覆盖那段文本 ⇒ 不算残余；**不许另抄机制词表**（会漂，判据侧就抄漂过一次）。
- `_FAMILY_CLAIM_ORDER`：基础子句（`element_power_ramp`）必须排在覆盖体（`respond_override`）**之前**。
- 号位/传动的认领 effect 必须在**两条链的链尾都补**（只补一条 ⇒ 并集立刻打架）。

---

## 3 · 剩下 2 条红（下一台电脑从这里开始）

### R-00-a 台账总数 313 vs 钉 306（差 +7）
- **真基线在仓库里**：`reports/roco/rc401/effect-coverage.json`（丢失那层留下的台账产物，`totals=306`，**逐行**可对照）。
  ⚠ **不要**拿 `reports/roco/rc401/rebuild-drafts/coverage.head-cc3de2ba.bak.py`（782 行 HEAD）当 306 那一版 —— 它太旧（302），上一轮我就是栽在这，把判据错误地改钉成 328，**已撤回**。
- 逐行审计（`reports/roco/product-execution/00/ledger-delta-audit.txt`，含子代理的运行时探针表）：相对 306 是 **24 翻正 / 2 翻负**。24 翻正里只有 **3 条有运行时报据**（313/581/762），其余 21 条是"把未结算说成已结算"，分四族：
  - **① 诊断形状缺（11 行）**：**本轮已修**（`_DIAGNOSTIC_SHAPE_PATTERNS` 补回 生命阈值/体重/面板比值/混血/固定能耗/使用次数/无视抵抗/效果未定义/迸发/应对后半），328 → **313**。
  - **② `RESPOND_POWER_SETTLED_RE` 整句跳步（2 行：398/637）**：只许跳命中那一段（「应对…：本次技能威力…」），同句其余（「赋予灼烧翻倍」「无视系别抵抗」）仍须被 evidence 覆盖，否则记 `respond_clause_gaps`。**未做**。
  - **③ `global_skill_mods` 认领不看 env 写点（6 行：430/441/531/532/534/682）**：防御支/敌方方向/无条件子句都没有 `global_skill_mod_applied`。要么接写点，要么把认领收到"env 真消费"。**未做**。
  - **④ `elif claimed` 只凭 `传动×1` 放行（2 行：473/489）**：已收窄（要求有产出/纯伤害/已结算类）。
- 另有一条**判据侧陈旧**（不是档位过宽）：`762 小型打劫` 真发 `foe_team_energy_loss`，但 `SETTLED_PATTERNS` 缺「扣能」类 ⇒ 若要动 `build_coverage` 改走 `classify_skill_declared`，**必须同时**给 `SETTLED_PATTERNS` 补「回复生命/回能/吸取能量/扣能」类，否则 273/344/346/472/756/762 会被误降（实测都真结算）。
- **规矩**：**不许为凑 306 反向拟合**；收窄要逐族做，每族做完跑「并集打架（必须 0）+ totals + 全量」；真要改判据数字，必须给逐行运行时报据 + 原值留档（改钉不删）。

### R-00-b 反证 6 < 8
`test_tier_verdict_agreement.test_counter_proof_disabling_the_shared_gates_brings_them_back`：把 `respond_clause_gaps` 与 `UNSETTLED_WORDS` 关掉后，打架只回来 **6** 条，判据要 **≥8**。已确认不是恒真（确实有 6 条回来）。**只登记、不拟合**：要先查清"少的那 2 条是被别的闸兜住了"再决定，别为凑数量放宽/收紧闸。

---

## 4 · 01 的状态（已开工，别重启）
- 勘察完成：[recon.md](reports/roco/product-execution/01/recon.md)（428 行）+ 7 份原始读数 + 4 个探针。
- **结论**：Codex 点名的链成立且更宽 —— 引擎有**三条**公开投影（`public_planner_state` / `ui_public_view` / `observation_for`）对"对手后备"给出三种答案；**最大泄漏是 `ui.legal.enemy`**（9/9 seed、回收率 1.000 可复原对手真实四招，而 `env.py:4370` 注释还写着"不在公开视图里"）。`opening_roster_revealed`/`match_id`/`event_seq` 全仓 0 命中。
- **已裁决**：预览事件发在 `service.battle_new`（回执必须拿得到）+ `state.events` 留同源记录；`event_seq` 可由 `state_version`（= `len(state.events)`）派生，不必新计数器。
- **写域已批准**：`env.py`、`schema.py`、`service.py` 归 01 执行者（`coverage.py` 仍归 00 执行者）。
- **待办**：先修 `ui.legal.enemy` 泄漏 → 三协议对齐 → 两条**互相矛盾**的 `pet_id` 断言（`test_public_planner.py:43-48` 要「后备必须带 pet_id」、`test_ui_public_view` 要「后备不许有秘密」）**必须一起改钉**，并给"仅改对手隐藏个体 ⇒ 公开输入逐字段相同"的反例读数。

---

## 5 · 可复跑命令（原样可贴）
```sh
cd /Users/serendizc/Developer/roco-coach            # 换机后改成你的仓库路径
git fetch gitee && git checkout wip/roco-coach-2026-09-30-1418 && git pull gitee wip/roco-coach-2026-09-30-1418
git log --oneline -3 && git status --short

# 引擎 + 全量判据
cd roco && PYTHONPATH=src python3 -c "import roco_env.service; print('IMPORT OK')"
PYTHONPATH=src python3 -m unittest discover -s tests -q          # 期望 Ran 847 · 2F + 0E

# 并集打架（必须 0）+ totals
PYTHONPATH=src python3 -c "
import json;from roco_env import coverage as C, data as D, service as S
RS=D.load_ruleset(); svc=S.RocoService(); SIM=(C.SUPPORT_SIMULATABLE_UNVERIFIED,C.SUPPORT_FULL_VERIFIED)
ids=[r['skill_id'] for r in json.load(open('tests/data/pets100-skills-census.json',encoding='utf-8'))['rows']]
bad=[s for s in ids if s in RS.skills and ((svc._skill_record(RS,RS.skills[s],with_tier=True)['support_tier'] in SIM) != C.settlement_verdict(RS.skills[s])['resolved'])]
print('union mismatches', len(bad), '| totals', C.build_coverage(RS)['totals']['simulatable_entities'], '(pin 306)')"
cd ..

# 隔离验收（自起端口，只在 finally 关自己起的进程）+ 反例
python3 scripts/roco/isolated-acceptance.py
python3 scripts/roco/isolated-acceptance.py --fault-inject missing-export   # 期望非 0
python3 scripts/roco/smoke-service-import.py

# 玩家服务：只读，不许重启
curl -s localhost:8765/api/roco/status
```

---

## 6 · 纪律与边界（继承，不许松）
- **不得**：重启用户 8765 · 清理真实数据（`data/**` 训练/评测数据）· 训练（4B 由用户亲自启动，27B 暂缓）· 擅自联系试用者 · 改 `README.md` 与 `docs/roco/PRODUCT-VISION-AND-ROADMAP.md`（归 codex-planner）· `data/roco/rulesets/*.json` 只能由生成器写 · 强推 master。
- **改判据**：仅在**确证陈旧**时，附独立证据（运行时/解析读数）+ 最小修订 + 原值留档（改钉不删）。**不许**为了让测试绿而改。
- **提交**：只加自己拥有的文件；推送 Gitee 当前 wip 分支并核对远端 SHA；失败如实登记，不伪造。
- **真人数据/授权缺失** ⇒ 记 `waiting_external`，继续允许的隔离工作。

## 7 · 一条未解释的观察（给分计划 10）
`test_turn_order_fail_closed` 的 **两条 legacy 黄金指纹** + `test_regression_set.test_disk_artifact_matches_a_fresh_build` 在**全量运行**时红、**单模块隔离运行 3/3 绿**。
受控 A/B：把事故前 `coverage.py` 换回后**仍红** ⇒ 与本批改动无关；`src` 树 git-clean、`data/` 无 15:00 后改动、清 `.pyc` 后仍红。⇒ 记 `O-1 open`，归 10（异常恢复与运行版本验收）。

## 8 · 团队与写域（新会话要重建团队）
本轮队友（**不随会话转移**，新会话需重新 spawn）：
- `harness-verifier` → `scripts/roco/isolated-acceptance.py` + `reports/roco/product-execution/harness/**`
- `plan01-recon` → 01 勘察；已获 `env.py`/`schema.py`/`service.py` 写域
- 写域总表见 `STATE.json.write_owners`（Lead 独占 `STATE.json`）

---

## 9 · 补记（交接前最后一刻，来自 01 执行者步骤 A/B）

**01 步骤 A/B 已完成并入库**（`env.py` / `schema.py` / 三条判据 / `regression-set.json` 产物）：
- **最大泄漏已灭**：`env.py` 的 `ui.legal` 删掉 `"enemy"` 公开副本 ⇒ 递归扫描整个 UI 载荷，**对手技能可见回收率 0.75 → 0.00**，且**控件证明度量有效**（合成 id 能被扫到，不是恒 0 假绿）。`ui.legal` 键 `['enemy','player'] → ['player']`；`cpu_legal_count` 读的是私有域，Node 20/20 通过。
- **四条判据按规矩改钉**（原断言逐字 + 独立证据 + 最小修订）：
  1. `test_turn_order_fail_closed` 两条黄金指纹：**根因不是 legacy 被误改** —— 指纹钉的 `serialize()` 里**含 `history`**，而 `history` 装的正是决策前观察载荷；A/B/A 六局读数：**实际动作序列全同 · `state.events` 全同 · 剔除 `history` 后 `serialize()` 全同**，只有 `history`/`observation_for` 变（预期）。处置：结算指纹收窄为剔除 `history`（原值留档 `GOLDEN_*_PRIOR_2026_09_30`），**另立**一枚 `history` 指纹 ⇒ 收窄没制造盲区；并加强必红反证（新增 3 条敏感性断言）。
  2. `test_regression_set`：先证明 **29/29 场景只有 `state_digest` 变、其余字段 0 变化** ⇒ 产物过期而非引擎变；按测试指路重建后 `--check` exit=0。
  3. 两条**互相矛盾**的 `pet_id` 断言：一起改钉到同一口径（**后备 `{slot, fainted}`；场上那只仍带 `pet_id`**），并新增一条测试正面证明「重建不需要后备身份」。
  4. `observation_for` 后备去掉 `pet_id`/`name`。
- 证据：`reports/roco/product-execution/01/step-log.md`（**含它自己写错的四处自查**）· `README-INDEX.md`（哪些读数权威、哪些作废）· `raw-legacy-{athead,withchange}.json` · `raw-align-verified-{before,after}.json`。
- 命令：`cd roco && PYTHONPATH=src python3 -m unittest tests.test_public_planner tests.test_ui_public_view tests.test_turn_order_fail_closed tests.test_regression_set tests.test_opponents -q` → **exit 0 · Ran 99 · OK**；`PYTHONPATH=roco/src python3 -m roco_env.regression --check` → **exit 0**。

**Lead 已裁决两件**：
- **A（授权）**：`roco/src/roco_env/regression.py` 写域**批准**给 01 执行者 —— 其 `:284` 的 `state_digest` 同样吸收了 `history`，属同一设计病；应像判据那样**剔除 `history`**（否则改观察边界就要重建产物，真正的引擎回归会淹没在噪声里）。⚠ 改时要留「剔除前后 29 场景对照」读数，证明**只有 `history` 相关项变**。
- **B（已执行）**：Lead 此前误入库的 5 份**早期有缺陷探针产物**（含恒 0 的假绿度量）**已 `git rm` 并删除**；`README-INDEX.md` 里保留"作废、不要引用"的登记。
- ⚠ **不要入库** `reports/roco/product-execution/01/.work-backup/`（A/B 对照副本，含 `env.py.head`/`schema.py.head`/`regression-set.json.before`）。

**01 仍未开始**（下一台电脑的 01 待办）：`opening_roster_revealed` 事件（已裁决发在 `service.battle_new` + `state.events` 留同源记录）· `match_id`/`event_seq`/`decision_id` 契约字段 · Node 转发 · 前端开局预览与"已见阵容"回看入口 · 反作弊对照（`U1` 仍 `blocked:needs_injection_entry`：引擎没有对局内改对手个体的入口，**不猜**）。
