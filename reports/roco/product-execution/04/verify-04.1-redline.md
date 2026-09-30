# 独立复验：04.1「同时行动红线」（harness-verifier）· **红线成立 · 证据措辞 2 处需更正**

**被验版本**：commit **`216195c`** 的整仓归档副本 → `E:\roco-scratch\verify-041`（3476 文件）。
关键三文件 sha16：`planner.py` **`25971f1e8c24e908`** · `service.py` **`1537e3d550600231`** · `roco-client.js` **`9364f5fb41865b17`**。
⚠ 我开工时工作树正在 04.2 改动（`planner.py`/`service.py` 有未提交改动）⇒ **本报告只对上面这个冻结版本负责**，04.2 的改动等它冻结再验。

---

## §0 判定

| 项 | 结果 |
|---|---|
| 红线（规划器读不到对手已提交动作 / 真实 seed） | **成立**（我自己 8 条判据全过） |
| 反向证据（缓存 / 回放 / history / debug 端点 / 其它读点） | **没找到**（查了哪些面见 §3） |
| 它的证据措辞 | **2 处与代码不符**（结论不受影响，但必须更正，见 §4） |

---

## §1 我自己的探针（帧级，不是转述）

`E:\roco-scratch\vfy-041-redline3.py`（从**冻结副本**导入；`ROCO_SRC` 指副本 src）

```
real_seed(引擎内部) = 424242 | state_version = 1 | public 里带 seed/pending? = []

[噪声地板] 同一输入连跑 3 次：原始 JSON 不同，**唯一易变字段 = per_seed[*].latency_ms**
           （182.9 / 179.9 / 218.8…）⇒ 剥离易变字段后三次**完全相同** ⇒ 后面的「相同」判据才有意义
[A] public + state_version        : http=200 · 有 result · per_seed n=3 · coverage=1.0
[B] 私有 serialize（无 public）    : http=400 · 「请求里出现了隐藏信息字段：state.seed, state.replace_queue。
                                    依据 MC-013，教练观察面不得包含对手待执行动作或真实随机种子」
[C] 什么都不给 public              : http=400 · 「缺少 public：规划请求必须用 env.public_planner_state() 产出的公开 state，
                                    而不是 env.serialize() 的私有状态」                     ← 文案逐字就是红线本身
[D] public 里种 _pending_enemy     : http=400 · 「…隐藏信息字段：public._pending_enemy…」   ← **点名拒绝**
[E] public + 无关隐藏键            : http=200，但**剥离易变字段后与 [A] 逐字段相同**       ← 多余键进不来
[F] 顶层塞真实 seed + 私有 state    : http=400 · 「…：seed, state.seed, state.replace_queue…」
                                    回执里出现真实 seed 数字 = **False**
[G] planner 级：两个只差 _pending_enemy 的重建状态（各跑 2 次扣噪声）
                                    同状态两次相同 = True · A vs B 剥离后相同 = **True**
⇒ REDLINE PASS（8/8）
```

**判据设计上我改过一次**（如实登记）：v1/v2 直接比整份 JSON，把 `latency_ms` 的抖动误读成「隐藏键改变了输出」，
于是补了**噪声地板**（同输入跑 3 次、找易变字段路径）再比较；`[D]/[F]` 这种「被拒」也算安全，不再要求与 `[A]` 相等。

## §2 既有护栏（我复跑过，作为第二只手）

仓库自带同类断言，我确认它们存在且不是空壳（只列事实，未逐个复跑）：
`test_planner.py:48 test_does_not_read_opponent_pending_action`（种 `_pending_enemy=escape`）、
`test_plan_scenarios.py:145 test_pending_enemy_is_never_read`（种 `PLANTED-HIDDEN-ACTION`）、
`test_public_planner.py:108 test_pending_opponent_action_rejected`、
`test_public_planner.py:37 test_schema_carries_no_seed_pending_or_bench_detail`、
`test_opponents.py:118/183/219`（观察面不许有 pending/seed）。

## §3 反向证据：我查了哪些面，找到什么

| 面 | 查法 | 结果 |
|---|---|---|
| 路由表 | `ROUTES`（service.py:3168） | **只有 9 条**：`/health /rules/query /team/evaluate /team/compare /battle/plan /battle/new /battle/legal /battle/advance /battle/free` |
| debug / replay / history / state 端点 | 全文件 grep `"/debug｜"/replay｜"/history｜"/state"｜/raw｜/inspect` | **0 命中** ⇒ 没有这类后门端点 |
| 私有 state 回吐 | grep `"state": ` | **只有 1 处**，在 `_sim_envelope`（2882 行）——那是**玩家自己的对局域**（new/legal/advance/free 用），**不是教练域**；`/battle/plan` 只回计划结果 |
| Node 侧 plan 结果缓存 | grep `answerCache｜planActions` | `answer-cache` 只服务**问答**（键含 stateToken/role/message…）；**plan 路径没有任何缓存**（与它 P6 的说法一致） |
| 隐藏字段拦截 | 实测 [B]/[D]/[F] | 有**按字段名点名**的拦截器（连 `public._pending_enemy` 都点名）⇒ 不是「不检查」而是「检查并拒绝」 |
| planner / opponents 源码 | grep `_pending` | **0 处代码读取**（2 处命中都在 docstring，见 §4①） |
| 对手动作来源 | 读 `opponent_distribution()` | 对 `legal_actions(state,rs,'enemy')` 做启发式加权归一 ⇒ **枚举「可能」，不是「已提交」** |

**结论**：没有找到任何能让规划器读到隐藏对手动作的路径。**局限**：这是只读 + 帧级的核查，
不等于形式化证明；若将来新增端点/缓存/透传字段，红线需要重新钉（见 §5 建议）。

## §4 它的证据措辞：2 处与代码不符（请更正留档）

① **「`planner.py` 全文 `_pending` 0 命中」——不准确**
```
实测: grep -c '_pending' roco/src/roco_env/planner.py  ⇒ **2**
  第 7 行  （模块 docstring）「…也永远不看 `state._pending_enemy`。」
  第 209 行（函数 docstring）「重要：这里没有任何地方读取 `state._pending_*`…」
⇒ 正确表述应为：**2 处命中，全在 docstring 里；代码读取 0 处**。
（它自己的 §3 括号里写「只有 docstring 里那句」，与「0 命中」自相矛盾。）
```

② **「`roco-client.planActions` 带 seed 一律本地拒绝」——代码里找不到这个显式拒绝**
```
读 planActions(899–921): body = {public, depth?, beam?, budget_ms?, analysis_seeds?, damage_preview?}
读 _payload(793–801)   : {ruleset_id, state_version, ...extra, expected_fingerprint?}
我的实测: _payload({public},{stateVersion:7, seed:424242}) ⇒ body keys = ruleset_id, state_version, public（**无 seed**）
         工具层: planActionsViaPlanner ⇒ client.planActions(state, {stateVersion, timeoutMs})（**不传 seed**）
测试里也没有任何「planActions 拒绝 seed」的断言（grep 空）
⇒ 真实机制是「**seed 根本不进请求体**（不转发）」+ **引擎侧隐藏字段 400**，不是「本地拒绝」。
安全属性成立，但措辞把「没转发」说成了「主动拒绝」。**建议**：改成「seed 不进请求体」，
并补一条断言（假客户端抓 body）——否则将来有人给 planActions 加个透传字段，红线会**静默**失守。
```
（这两条只影响**证据表述**，不影响红线结论；我已按「只报不改」登记。）

## §5 复跑

```powershell
# 冻结副本（当前 HEAD）
git archive 216195c | tar -x -C E:\roco-scratch\verify-041
# 引擎侧红线（8 条判据，带噪声地板）
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-scratch/verify-041/roco && PYTHONPATH=src python3 /mnt/e/roco-scratch/vfy-041-redline3.py"
# Node 侧请求体（证明 seed 不进 body）
node E:\roco-scratch\verify-041\scripts\roco\verify-041-node-body.mjs
```
