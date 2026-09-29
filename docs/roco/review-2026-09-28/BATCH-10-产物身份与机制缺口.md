# BATCH-10 · 产物身份（`policy_first` + 引擎/源码版本）与机制缺口复核

> **任务**：`task-17`（阶段 3 · C）｜**负责人**：`battle-smoke`｜**日期**：2026-09-29
> **产物绑定**：生成器那份跑在 `278cd978`、影子那份跑在 `6692b665`（两次运行之间仓库落了别人的提交）；
> **行为相关的五个文件 hash 逐条相同**（见 §5.2）。交付时 HEAD：`32c23880`。
> 两份产物里都写着 `dirty: true`（用未提交的工作区跑的）—— 入库后重跑这两支命令会翻成 `false`。
> **这一份回答两件事**：① 两份轨迹产物的 header 里**终于能查出**「这是哪个口径、哪个版本跑的」；
> ② 三条阻塞机制的缺口**当前**读数（三列分开、一个数都不许往下调）。

---

## 1. 为什么要做这一条（上一轮乌龙的病根）

B5 那一整轮走了三步、每步都被证据推翻一次：

| 步骤 | 结论 | 被什么推翻 |
| --- | --- | --- |
| Lead 定位 | 「影子回放的 `passed` 判得太松」 | 132 条零调用**全部**是 `expect.tool === null` 的窗口（本就不要求调用） |
| 我第一步 | 「判据的标准不成立（两次独立运行不可能逐窗口相同），要加噪声底」 | 同 arm 重跑逐窗口翻面 **0/288** ⇒ 是确定性的，不是抽样 |
| 我第二步 | **归档的生成器产物过期** | 生成器**自己的代码路径**今天重跑同一批窗口 vs 影子回放 = **0/288** |

**病根**：两份产物**互相不可区分** —— header 里既没有 `policy_first`、也没有引擎版本、也没有源码 hash。
「哪份是哪个口径跑的」只能靠人记，记错了就演一轮乌龙。这一张就是把这三样钉进 header。

---

## 2. ① 两份产物 header 的改前 / 改后

### 2.1 生成器 `tests/evals/agent-trajectories-model-v1.jsonl`

| 字段 | 改前 | 改后 |
| --- | --- | --- |
| `policy_first` | **没有这个键** | `false`（在 `provenance.policy_first`） |
| `provenance` | **没有这个键** | 有（见下） |
| `model_identity` | 有（model / adapter / `adapter_sha256` / `identity_digest` / `prompt_digest`） | 沿用，一字不动 |
| `ruleset_id` | 有（但只有 id，没有快照指纹/引擎版本） | `provenance.engine` 里补齐 |
| arm / limit | `arms: ["local_4b"]`，**没有 limit** | `provenance.arms` + `provenance.limits`（`{"local_4b": 3}`） |
| 源码版本 | **没有** | `provenance.source.head` + `files{路径: sha256 前 16}` + `dirty` |
| `disciplines` 里那条自述 | 「产物确定性：无时间戳、**无 HEAD**、无随机」 | 改成「无时间戳、无随机；**登记** HEAD 与源码 hash（只登记不参与计算）」——**旧原文以注释留在脚本里**，不静默改 |

### 2.2 影子回放 `reports/roco/shadow-replay-sft-v8.json`

| 字段 | 改前 | 改后 |
| --- | --- | --- |
| `policy_first` | **没有这个键** | `false`（`provenance.policy_first`） |
| `provenance` | **没有这个键** | 有（同一个 `buildProvenance`） |
| `identity` | 有（模型/适配器/`adapter_sha256`/`identity_digest`） | 沿用 |
| arm / limit | `arm: "sft-v8"`（顶层），**没有 limit** | `provenance.arms` + `provenance.limits`（`{"sft-v8": 3}`） |
| 引擎版本 | **没有** | `provenance.engine` |
| 源码版本 | **没有** | `provenance.source` |

### 2.3 身份块长什么样（都是**确定性**字段，没有挂钟）

```json
"provenance": {
  "policy_first": false,
  "arms": ["sft-v8"],
  "limits": {"sft-v8": 3},
  "engine": {
    "ruleset_id": "roco-world-s4-2026-09-10",
    "snapshot_fingerprint": "4d5c169fd528874cb629d0b8224504f151b5f8870aceffd7722bbdb2f52760bc",
    "protocol_version": 1,
    "service_version": "0.1.0",
    "loaded": true
  },
  "source": {
    "head": "<git rev-parse HEAD>",
    "dirty": true,
    "dirty_files": ["scripts/roco/agent-trajectories.mjs", "scripts/roco/shadow-replay.mjs"],
    "files": {
      "scripts/roco/agent-trajectories.mjs": "1922d647cb369754",
      "src/coach/roco-client.js": "559157faf12d34d6",
      "roco/src/roco_env/env.py": "b51f5cc7cd1767e6",
      "roco/src/roco_env/service.py": "85f05fd03c999706",
      "roco/src/roco_env/data.py": "d92786ef8c1a9584"
    }
  }
}
```

**实现只有一处**：`scripts/roco/agent-trajectories.mjs` 的 `buildProvenance` / `engineProvenance` /
`sourceProvenance`，生成器与影子回放**都调它**（各写一份必然漂 —— 本仓反覆踩过的坑）。
`/health` 里的 `pid`、`uptime_s` 一律**不抄**（那会变成挂钟）。

---

## 3. ② 一致性证明（**重建之前**做的，不是「应该一致」）

**做法**：把**生成器自己的代码路径**在当前代码上按**同一批 288 个窗口**跑一遍
（`ROCO_TRAJ_WORLDS=1`，arm `local_4b`），与**刚重建好、带身份块的影子产物**逐窗口对拍。
**这一步在任何「重新生成」之前做**，所以它不是「拿重建产物对齐数字」。

```bash
ROCO_TRAJ_WORLDS=1 node scripts/roco/build-agent-trajectories.mjs --arms local_4b --quiet \
  --out reports/roco/shadow-replay-proof-generator-1world.jsonl
node scripts/roco/shadow-replay.mjs --arm sft-v8          # 影子那份（自带身份块）
```

| 读数 | 值 |
| --- | --- |
| 可对拍窗口 | **288 / 288**（影子那 288 个 key 在证明产物里**一个不缺**） |
| **判定不一致** | **0 / 288** |
| 通过数 | 证明 **283/288** ／ 影子 **283/288** |
| 两边 `provenance.source.head` | **都是 `6692b6653a106142df889f66d3dd5efc538a7f27`**（同一份源码） |
| 两边 `provenance.policy_first` | **都是 `false`**（同一个口径） |
| 产物 | `reports/roco/shadow-replay-consistency-proof.json` |

⇒ 「两份产物一致」这次是**量出来的**：0/288，而且**身份块自己就能证明**它们跑的是同一份源码、同一个口径。

---

## 4. ③ 机制缺口复核（三列分开，**一个数都没往下调**）

### 4.1 三列

| 列 | 读数 | 复验命令 |
| --- | --- | --- |
| **① 基础可玩**（引擎侧全量） | **542 / 542**（blocked 0、settled 542、四格都用上 536、换人进出各 542） | `python3 scripts/roco/battle-smoke-summary.py` |
| **① 基础可玩**（HTTP 入口侧） | **542 / 542**（select/start/loadout 透传/结算全 542） | 同上（`entry-sweep.json`） |
| **② 机制核验 · 引擎侧已实现** | **8 / 542**（`FULL 8`；另有 `PARTIAL 3`、`REFUSED 4`、**引擎未登记 527**） | 同上（`engine-trait-status.json`） |
| **② 机制核验 · 实机核验** | **0 / 542**（`pet-mechanisms.json` 里 542 只**全部** `FROZEN_DESC`，每只两条 `unverified`） | 同上 |
| **② 机制核验 · 战斗中未结算** | **295 / 542**（自己出手时引擎把某条已解析效果登记为「没有结算」） | 同上 |
| 技能档位（全库 860 条，**与服务同一口径**） | `PARTIAL 539` / `SIMULATABLE_UNVERIFIED 305` / `KNOWLEDGE_ONLY 16` | 见 §4.4 |
| 技能档位（**玩家够得到**的 181 条去重） | `SIMULATABLE_UNVERIFIED 106` / `PARTIAL 72` / `KNOWLEDGE_ONLY 3` ⇒ **75/181（41.4%）不是全可模拟** | 见 §4.4 |

**口径说明（不许混着比）**：`①=542/542` 与 `②=8/542` 是**两件事** —— 能开局、能结算**不等于**
机制被结算了。这一列从 task-6 起就没拿①顶替②。

### 4.2 三条阻塞缺口（当前 id / 条件 / 引擎原文 / 复现）

**缺口 1 —— `skill_000494`「绞轮」的负能耗（持有者 `pet_000482` 溯源钟）**

- **触发条件**：能耗修正把它压到 **0**（此时仍在合法动作表里）之后，同回合先出手的一次**属性抵抗**命中再压到 **-1**（基础 5）。
- **引擎原文**：`未支持的机制：技能「绞轮」的有效能耗（能耗修正把它压到 -1（基础 5）—— 负能耗的下限在术语里没有定义（MC-018），不猜一个 0，也不按负数回能）`
- **现状（不是「支持了」）**：整局**不再炸**（改前炸在第 6 回合）；负能耗那一手变成一条可结算的 `action_cancelled{reason: energy_cost_unresolved, base_energy: 5, effective_cost: -1, microcase_id: MC-018}`，整局打到 **第 37 回合结算**（`loss`）。**缺口本身仍在**（引擎没给负能耗定下限，MC-018 未录制）。
- **复现**：`python3 scripts/roco/battle-smoke-repro-negative-cost.py` → `reports/roco/battle-smoke/negative-energy-cost-repro.json`

**缺口 2 —— 「能耗永久-N」这一**类**（12 条会减能耗的技能）**

- **触发条件**：有效能耗 = 基础 + ramp + 能耗修正 + 每层中毒 + 天气，**任一项**把总数压到 < 0 都走同一条路。
- **判据 A/B/C**：A 有效能耗 < 0 ⇒ `legal_actions` 不提供这一手；B 直接 `_execute` 仍 `UnsupportedEffect`（fail closed，不猜 0、不扣能量）；C 走 `step_joint` 时（合法表算完之后才被压负）不炸整局，产出 1 条 `action_cancelled` 且回合走完。
- **现状**：14 例 → **ok 12 / skipped 2 / failed 0**；skipped 的两条是 `skill_000037` 洄游、`skill_000105` 机械变式（学习表里**没有任何物种**学得到 ⇒ 够不到入口）。
- **复现**：`python3 scripts/roco/battle-smoke-negative-cost-scan.py` → `reports/roco/battle-smoke/negative-cost-scan.json`

**缺口 3 —— `skill_000671`「硬门」这一类 `PARTIAL`/`KNOWLEDGE_ONLY` 技能**

- **触发条件**：描述里读不出决定性效果（例：「应对攻击：打断被应对技能，并造成 90 威力物伤」读不出减伤比例）。
- **引擎原文**：`未支持的机制：防御技能「硬门」（描述里读不出减伤比例）`
- **现状**：不再炸整局 —— 走产品路径时变成一条可结算的取消（`player_path_status 200`、`action_cancelled` 文本「我方这一手没有打出去（这条机制还没有实现）。」），且**点之前**界面上就标出「这招有一部分效果引擎还不会算」。
- **复现**：`node scripts/roco/battle-smoke-support-marker.mjs`（判据：真回执 **绿**）

### 4.3 本轮**新列出来**的两类缺口（同样是 ② 那一列的，按同样格式）

这两类**不是**崩溃型，而是「引擎登记了未结算 + 按一条写明的口径兜底」——
以前没单独列过，本轮从同一份复现产物里枚举出来（**只增不减**）：

| # | id | 触发条件 | 引擎原文（节选） | 复现 |
| --- | --- | --- | --- | --- |
| 4 | `EV-ENERGY-CHARGE`（本轮该局出现 **11** 次，是出现最多的一类） | 「聚能」与能量上限的先后顺序 | 「描述『聚能回复 5 点』按配置结算；但『聚能是否可突破上限』与『无合法技能时是否自动聚能』台账明说未定（**MC-E02 未录制**），本引擎按『夹到 `energy.max`』处理」 | `python3 scripts/roco/battle-smoke-repro-negative-cost.py` |
| 5 | `skill_000246` 抓挠 / `skill_000378` 火苗 / `skill_000418` 甩水（自带**回能时序**，本轮合计 **7** 次） | 技能自带回能 vs 回合末回能 vs 能量上限的先后 | 「描述『自己回复 1 能量』机械可读，因此按 1 点结算；但『技能回能 vs 回合末回能 vs 能量上限』的先后顺序无一手证据（**MC-007**），本引擎按『出手结算时立即回能』处理」 | 同上 |

### 4.4 技能档位怎么复算（必须有命令，不能只给数字）

```bash
# 与服务**同一个**分类器口径：coverage.declared_capabilities_of() + classify_skill
python3 - <<'PY'
import sys, collections, json
sys.path.insert(0,'roco/src')
from roco_env import data as D, coverage as C
from roco_env.coverage import classify_skill
rs=D.load_ruleset(); caps=C.declared_capabilities_of()
kw={k+'_declared': caps.get(k, False) for k in
    ('multi_hit','slot_condition','position_shift','foe_energy_loss','initiative_condition',
     'per_layer_cost','foe_switch_condition','per_use_ramp','on_hit_ramp')}
print(collections.Counter(classify_skill(s, **kw)['support'] for s in rs.skills.values()))
PY
```

**口径提醒**：task-6 当时报的 `290/313/12` 是在**另一批**技能上数的（615 条），与今天的 860 条
**不是同一个分母**，两者不能直接相减。今天这一份三档分别 **≥** 当时的三档，没有一档往下调。

---

## 5. 两份产物一起重建（读数）

两道命令都跑完了（都是**当前代码 + 同一个口径**；`policy_first` 两边都是 `false`）：

```bash
node scripts/roco/shadow-replay.mjs --arm sft-v8                      # 影子：288 窗口，写回原路径
ROCO_TRAJ_WORLDS=9 node scripts/roco/build-agent-trajectories.mjs \
  --arms local_4b --quiet --out tests/evals/agent-trajectories-model-v1.jsonl   # 生成器：1752 条
node scripts/roco/agent-metrics.mjs        # 派生产物记着源产物 sha256，源一变必须跟着变
```

| 产物 | 规模 | 通过 | `provenance.policy_first` | `provenance.limits` | 引擎快照指纹 |
| --- | --- | --- | --- | --- | --- |
| 生成器（1752 条 / 9 世界） | 1752 | **1695** | `false` | `{"local_4b": 3}` | `4d5c169f…` |
| 影子回放（288 窗口） | 288 | **283** | `false` | `{"sft-v8": 3}` | `4d5c169f…` |

### 5.1 重建之后仍然对得上（这条判据就是靠它绿的）

| 读数 | 值 |
| --- | --- |
| 对拍窗口 | **288** |
| **判定不一致** | **0 / 288** |
| 两边在这 288 个窗口上的通过数 | **283 / 283** |
| `assert.equal(mismatched.length, 0)` | **断言一个字都没改**（测试文件只多了一段日期注释） |

### 5.2 身份块**当场**证明了两件事（这正是它存在的意义）

1. **口径相同**：两份产物的 `provenance.policy_first` 都是 `false`、引擎快照指纹都是
   `4d5c169fd528874cb629d0b8224504f151b5f8870aceffd7722bbdb2f52760bc`
   —— 以前这两样**一个都查不到**，「两个口径互比」就是这么做出来的。
2. **行为相关的源码逐字节相同**（虽然两次运行的 HEAD 不同）：

   | 文件 | 生成器那份 | 影子那份 |
   | --- | --- | --- |
   | `scripts/roco/agent-trajectories.mjs`（harness + 判定器） | `1922d647cb369754` | `1922d647cb369754` ✅ 同 |
   | `src/coach/roco-client.js` | `559157faf12d34d6` | `559157faf12d34d6` ✅ 同 |
   | `roco/src/roco_env/env.py` | `b51f5cc7cd1767e6` | `b51f5cc7cd1767e6` ✅ 同 |
   | `roco/src/roco_env/service.py` | `85f05fd03c999706` | `85f05fd03c999706` ✅ 同 |
   | `roco/src/roco_env/data.py` | `d92786ef8c1a9584` | `d92786ef8c1a9584` ✅ 同 |
   | 各自那一支脚本 | `build-agent-trajectories.mjs 4296555233d0aa97` | `shadow-replay.mjs 03332990db150168` |

   **两边的 `source.head` 不同**（`278cd978…` vs `6692b665…`）——因为两次运行之间仓库又落了
   别人的提交。**HEAD 不同不等于口径不同**：行为相关的五个文件 hash 逐条相同。
   这正是这一块要**同时**记 `head` 与 `files` 的原因：只记 HEAD 会让人以为对不上，
   只记 files 又说不清跑的是哪一版仓库。

### 5.3 判据读数

```
node --test tests/evals/roco/model-trajectories.test.js      → 6 / 6 过
node --test tests/roco-agent-metrics.test.js                 → 7 / 7 过（源一变就重算派生产物）
```

证据文件：`reports/roco/shadow-replay-consistency-proof.json`（含 `before` / `after_rebuild` 两段）。

---

## 6. 未完成项（如实列，不粉饰）

1. **`policy_first` 只做到「记下来」，没做到「两种口径都跑过」**：两份产物这次都是 `false`
   （与改前的实际口径一致）。**没有**生成 `policy_first: true` 的那一版 —— 因为一旦只给一份开，
   就又会造出「两个口径的产物」；要开就两份一起开、一起重建（那时这一块会自动写明 `true`）。
   政策的覆盖面读数（政策在 **918/1752** 个窗口上「有意见」，其中 **404** 条正落在「零调用判失败」的 512 条里）
   是**用 `policyFor` 静态算的**，不是跑出来的，别当成通过率。
2. **`engine_modules` 在这一版是 `null`**：`/health` 的回执里没有这个键（本机这一版的引擎不报），
   所以如实写 `null` 而不是编一个空数组。
3. **`dirty: true`**：两次重建都是用**未提交**的工作区跑的（本轮这几支脚本还在工作区）。
   口径有效，但**复现时要对上同一份工作区**；入库之后重跑这两支命令，`dirty` 会翻成 `false`。
4. **机制缺口那两列（④ 实机核验）仍然是 0/542** —— 本轮**没有**做实机校准，也没有把任何一只
   标成「已核验」。要动的是一手录像/实测，不是这里。
5. `EV-ENERGY-CHARGE` / 自带回能时序这两类**新列出来**的缺口，只给了「引擎按什么口径兜底」，
   **没有**去核这两个口径本身对不对（MC-E02 / MC-007 未录制）。
