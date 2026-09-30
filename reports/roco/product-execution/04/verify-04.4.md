# 独立复验：04.4 冻结版 `9a405ac`（harness-verifier）· **合格** + O-39 已独立测量

**冻结件 sha256（8 个路径，我逐一核过，与 Lead 声称全部吻合）**

| 文件 | sha16 | 字节 |
|---|---|---|
| `roco/src/roco_env/planner.py` | `9542ab0a17957798` | 67781 |
| `roco/src/roco_env/service.py` | `54c2d129a46b4a1c` | 206879 |
| `roco/tests/test_plan_ranking.py`（新） | `9a1fe222110d265a` | 14360 |
| `roco/tests/test_plan_scenarios.py` | `b16a71e5c8d245d6` | 92367 |
| `src/coach/toolbox.js` | `1a0a402466c8f9b9` | 106720 |
| `tests/roco-plan-context.test.js` | `28dcee0e8e8d9db4` | 37268 |
| `reports/roco/product-execution/04/04.4-robust-ranking.md` | `5b9d86bd4fab8c2c` | 14757 |
| `docs/roco/RC-604-OPPONENT-BELIEF.md` | `e840d425264a9fe4` | 32493 |

**方式**：`git archive 9a405ac` → `E:\roco-scratch\verify-044`（3527 文件）；只读；
Node 侧驱动**真** `executeTool('plan_actions')`；改坏版只在副本内做，每轮还原并复核 sha
（收尾 `toolbox.js` `1a0a402466c8f9b9` = 冻结件）。

---

## §0 判定

| # | 判据 | 判定 | 一句话依据 |
|---|---|---|---|
| 1 | 稳健排序口径可逐条解释 + 允许并列 | **合格** | `MATERIAL_LOSS=1.2`；每条被压下的动作带 `why`；`tie_epsilon`/`tied_with_top` 支持并列 |
| 2 | 必做反例② 数字复算 + 代价如实 | **合格** | 我复算出 **+0.4417 / -1.5177** 与 **换上第3位 -0.8878**，逐字吻合；阈值调 1.6 ⇒ 反例不触发 |
| 3 | `is_probability` 机器可检（R1/R2） | **合格** | 顶层 `is_probability:false`/`is_winrate:false` + 7 个子字段各带 `is_probability/unit/basis` |
| 4 | `plan_clock` 接缝 | **合格（1 处措辞更正）** | 默认是**真时钟**；不传 == 传真时钟（逐字段相同）；固定时钟 5 次相同；8 核负载下 6 次相同、无超时 |
| 5 | 金标旧字段零改动 | **合格** | 独立 diff：`added=61/96/162/232 · removed=0 · changed=0` |
| 6 | Node N9/N10 有牙 | **合格** | 我自己造 2 条变异 ⇒ `⑧d` **1 红** / `⑧b+⑧d` **2 红**；还原后 17/17 |
| — | **O-39**（8 核满载余量） | **已测** | 空载 median 453ms；**满载 median 660ms · max 786.7ms ⇒ 余量 6.36×**（与它声称的 698–791ms/6.3× 一致） |

---

## §1 稳健排序口径（逐条可解释 + 允许并列）

```
MATERIAL_LOSS = 1.2（产品参数；运行时读的全局 —— 我把它改成 1.6 立刻生效）
robustness 键 = [candidates_ranked, is_probability, material_loss_actions, material_loss_threshold,
                 note, ordering, primary_rule_applied, tie_epsilon, tied_with_top, top]
逐候选留痕（反例②那一局）:
  换上第3位  expected=-0.8878 worst=-1.0051 material_loss=false
  使用能量果 expected=+0.4417 worst=-1.5177 material_loss=true
  诡刺       expected=-0.5314 worst=-1.5138 material_loss=true
  使用回复药 expected=-0.6610 worst=-1.7177 material_loss=true
material_loss_actions[0] 的 why 逐字:
  「有证据的最坏分支 -1.5138 ≤ -1.2（那一支是**算出来的**，不是 fail closed 哨兵）」
note: 「…稳健排序：3 个候选有**有证据的重大损失**（最坏 ≤ -1.2），按「先避重大损失」规则未获推荐…」
⇒ 排序口径 = ①先排掉「有证据的重大损失」②其余按期望降序（资源与后手都在期望里）；
  并列由 `tie_epsilon` + `tied_with_top` 表达（本局 `tied_with_top=[]`）⇒ **没有硬造单一最优**
```

## §2 必做反例②：我自己复算（**逐字吻合**）

```
夹具：COUNTER_TEAM = 寂灭骨龙/海豹船长/黑猫巫师 对同阵容，己方场上那只 hp=1，seed=1
      plan_actions(..., depth=2, beam=4, budget_ms=800, clock=lambda: 0.0)

旧口径（max by (expected, worst)）首选 = **使用能量果**
    expected = **+0.4417**（我实测 0.4417）   worst = **-1.5177**（我实测 -1.5177）
    material_loss = true · worst_computed = true
稳健口径首选 = **换上第3位**
    expected = **-0.8878**（我实测 -0.8878） worst = -1.0051 · material_loss = **false**
primary_rule_applied = True · 被压下去那一手留在 material_loss_actions 里 · note 写明「有证据的重大损失」
代价如实：旧首选期望 **+0.4417 >** 新首选 **-0.8878**（我断言了这条）⇒ 这是**换偏好**，不是「更准」
阈值实验：把 MATERIAL_LOSS 改成 1.6 ⇒ 推荐**回到「使用能量果」**（反例不再触发）
   ⚠ 精确化：此时 `primary_rule_applied` 仍是 **true** —— 因为 `使用回复药 -1.7177 ≤ -1.6` 仍算重大损失，
   规则照样生效；反例（「使用能量果 vs 换上第3位」这组冲突）确实不触发了 ⇒ 与判据一致，不矛盾。
```

## §3 `is_probability` 机器可检（R1/R2）

```
declarations.顶层: is_probability=false · is_winrate=false
子字段（7 个，各自 is_probability=false + unit + basis）:
  expected  {unit:'score', basis:'启发式局面分对**启发式**对手分布取期望；权重没有实测频率数据'}
  worst / best / first_second_margin / risk / opponent_weights …
  coverage  {is_probability:false, is_confidence:false, unit:'count_ratio', basis:'计数比（…）'}
⇒ 声明**落在字段上**，不是只在人读 limitations 里
```

## §4 `plan_clock` 接缝

```
签名（inspect 实测）: plan_actions(state, rs, *, side, depth=2, beam=4, budget_ms=2000,
                                  clock: Callable[[], float] = time.perf_counter,
                                  opponent_scenarios=None)
① 不传 clock  vs  传 clock=time.perf_counter ⇒ **逐字段相同**（接缝不改默认语义）✓
   ⚠ 措辞更正：默认值是 **time.perf_counter**，不是 `None`；显式 `clock=None` 会 **TypeError**
   （`start = clock()`）—— 这是个小瑕疵：None 不是合法值、也没有兜底。若文档写成「默认 None」需改。
② 固定时钟（lambda: 0.0）5 次 ⇒ **逐字段相同**（零挂钟依赖）✓
③ 8 个 CPU 自旋负载下：真时钟 6 次结果**相同**（无抖动）· 固定时钟 6 次相同 ·
   耗时 [69.1, 95.4, 94.4, 88.8, 106.3, 92.8] ms（预算 800ms）**无超时** ✓
```

## §5 金标「旧字段零改动」（独立按键路径 diff `3bb4356` → `9a405ac`）

```
PLANNER_DEFAULT_GOLDEN_TEXT        added=61   removed=0  changed=0
PLANNER_DEFAULT_BEAM8_GOLDEN_TEXT  added=96   removed=0  changed=0
SERVICE_DEFAULT_GOLDEN_TEXT        added=162  removed=0  changed=0
SERVICE_DEFAULT_BEAM8_GOLDEN_TEXT  added=232  removed=0  changed=0
合计 added=551 · **removed=0 · changed=0**（与 Lead 声称 61/96/162/232 逐数吻合）
新增键全是 04.4 的 `declarations.*` 一族（样例 declarations.coverage.is_confidence、
declarations.expected.basis、declarations.best.unit…）
```

## §6 Node 侧 N9/N10（我自己造的等价变异）

```
控制（未变异）  ⇒ exit=0 · tests 17 · pass 17 · fail 0
M-N9  不搬运引擎 robustness（robustness:plan?.robustness ⇒ null）
      ⇒ exit=1 · 16 pass / 1 fail · 红：⑧d 04.4：引擎的 robustness/declarations 带出来…
M-N10 忽略引擎自带 declarations（用工具层回退那份）
      ⇒ exit=1 · 15 pass / 2 fail · 红：⑧d … · ⑧b 回执带出 R3/R5/R8 与 `is_probability:false` 声明…
还原 ⇒ toolbox.js sha16 `1a0a402466c8f9b9` = 冻结件 ✓
```

## §7 O-39：8 核满载余量（我自己的读数）

```
环境: WSL Ubuntu-22.04 · mp.cpu_count()=16（8 个 CPU 自旋进程制造负载）
命令: PYTHONPATH=src python3 /mnt/e/roco-scratch/vfy-044-o39.py
      每档 8 轮 plan_actions(depth=2, beam=8, budget_ms=5000)
空载     逐轮 ms = [487.9, 452.5, 454.7, 481.9, 448.5, 447.3, 450.4, 454.3]
         min=447.3 median=453.4 max=487.9 ⇒ 余量 median 11.03× / max 10.25×
8 核满载 逐轮 ms = [594.6, 648.2, 655.2, 658.9, 661.0, 694.3, 786.7, 688.0]
         min=594.6 median=660.0 max=786.7 ⇒ 余量 median 7.58× / **max 6.36×**
timed_out = 全 False（两档 16 轮均未超预算）；nodes = **119（两档完全相同）**
⇒ 与它声称的「698–791ms / 5000 ⇒ 6.3×」一致（我 max 786.7ms ⇒ 6.36×）
⇒ **加固不靠余量的证据**：`nodes` 在两档下**一模一样**（119）⇒ 搜索结果与挂钟无关，
   负载只改变耗时；6.36× 余量决定的是「能不能算完」，不是「算成什么」。
```

## §8 诚实边界与提醒

- **O-38/O-42 已按你的交代执行**：我**没有**在 `/mnt/e` 归档副本上跑全量 `discover`（本机会卡住，我已遇两次），
  本报告所有 Python 读数都是**定向命令 + 明确入口**（见各节命令行）；`npm run test:unit` 我**没有**跑，
  不把它的 83 红当回归。
- Node 侧我只跑了 `tests/roco-plan-context.test.js`（17/17），**没有**跑全量 Node 套件。
- 我的 `clock=None` 检查是**我自己加的过严断言**（接缝并不承诺 None 合法）⇒ 报告里按「小瑕疵/措辞更正」登记，
  不计为判据失败。
- 阈值 1.6 那条我原先期望 `primary_rule_applied=false`，实测为 true —— 我核对代码后确认**判据与实现一致**，
  是我期望写错（已在上文更正）。

## §9 复跑

```powershell
git archive 9a405ac | tar -x -C E:\roco-scratch\verify-044
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-scratch/verify-044/roco && PYTHONPATH=src python3 /mnt/e/roco-scratch/vfy-044-probe.py"
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-scratch/verify-044/roco && PYTHONPATH=src python3 /mnt/e/roco-scratch/vfy-044-probe2.py"
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-scratch/verify-044/roco && PYTHONPATH=src python3 /mnt/e/roco-scratch/vfy-044-o39.py"   # O-39
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-scratch && python3 vfy-044-golden.py"                                            # 金标 diff
# 变异：E:\roco-scratch\vfy-044-mutate.sh {n9|n10|restore}
```
