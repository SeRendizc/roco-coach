# 独立复验：08·G01（同物种配招共用）与 05 关键缺陷（区间字段被丢弃）（harness-verifier）

两条都是**只读探针**；未改仓库任何文件、未动 `data/**`、未碰用户 8765。
器材：`scripts/roco/verify-claims-08-g01.mjs` · `scripts/roco/verify-claims-05.mjs` · `E:\roco-scratch\vfy-claims-receipt.py`

---

## ① 08 · G01：同物种两只个体共用配招 —— **能复现**（在提交态 `HEAD`）；**工作树已修**

### 版本与指纹（这是关键：两个版本行为不同）
```
HEAD    src/client/loadout-store.js  sha16 = 1b32a824b2b18504  ← 纯物种级 v1（导出面里**没有**个体级 API）
工作树   src/client/loadout-store.js  sha16 = ce928eef509968bf  ← 08·S1 在飞（v2 个体级 + resolveLoadout）
HEAD 版导出：isSharedLoadout / readSharedLoadouts / readSharedLoadout / clearSharedLoadout / writeSharedLoadout
工作树导出：以上 + readIndividualLoadouts / readIndividualLoadout / writeIndividualLoadout /
            clearIndividualLoadout / resolveLoadout / teamLoadouts
```

### 我自己的探针读数（内存假 storage，两只同物种不同个体，各配不同四招）
```
个体 A = own-0001（物种 pet_000012）· 个体 B = own-0002（同一物种）
两条 UI 路径写下去的是**同一个键**：盒子页写 state.petId（引擎回执 pet_id），工坊页写 row.species —— 都是 pet_000012

[HEAD 版]
  A 配 ["skill_a1".."skill_a4"] ⇒ 写入成功=true ；A 立刻读回 = A 的四招
  B 配 ["skill_b1".."skill_b4"] ⇒ 写入成功=true
  **A 现在读回 = ["skill_b1","skill_b2","skill_b3","skill_b4"]**   ← 被 B 覆盖
  storage 里只有 1 个键: ["roco.workshop.loadouts.v1"]
  ⇒ 无个体级 API，无法按个体分开存                        ⇒ **G01 复现**

[工作树版]
  A 写个体级=true · B 写个体级=true
  A 解析 = {ids:[a1..a4], scope:"individual", instance_id:"own-0001", species_id:"pet_000012", note:null}
  B 解析 = {ids:[b1..b4], scope:"individual", instance_id:"own-0002", species_id:"pet_000012", note:null}
  storage 键 = ["roco.workshop.loadouts.v2"]                ⇒ **不互相覆盖**

[工作树版 · 只有历史 v1 记录时]
  A/B 都解析到同一份，但 scope="species" 且 note="物种级（未区分个体）"   ← 如实标注，不冒充个体级

[工作树版 · v1 与 v2 并存]
  A（编辑过）= v2 的四招，scope=individual；B（没编辑过）= 落到 v1 + 物种级标注  ⇒ 个体级优先
```

### 结论
- **claim 成立**：在 `HEAD`（提交态 = 08 勘察所见的那一版）下，同物种两只个体**确实互相覆盖**；
  它引用的行号在该版本下也对得上（HEAD `team-workshop.js:1885/2003` 写 `writeSharedLoadout(null, row.species, …)`；
  `box-loadout.js:~1007` 写 `writeSharedLoadout(storageOf(), state.petId, ids)`）。
- **工作树（08·S1 在飞）已修**：改为个体级 v2 + 兼容读 v1 + 个体优先 + 如实标注。
  ⇒ 门槛例外（只放 S1）在**这条判据上是有依据的**；`state.petId` / `row.species` 的区别也解释了为什么两条路径会撞同一个键。
- ⚠ 行号提示：按**工作树**读，写入点已变成 `team-workshop.js:1926/2049/2136` 与 `box-loadout.js:1020`（`writeIndividualLoadout`），
  引用旧行号会找不到人。

### 最小复现
```powershell
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-coach && git show HEAD:src/client/loadout-store.js > /mnt/e/roco-scratch/g01-head-loadout-store.mjs"
node E:\roco-coach\scripts\roco\verify-claims-08-g01.mjs      # ⇒ G01 REPRODUCED AT HEAD · FIXED IN WORKTREE（exit 0）
```

---

## ② 05 关键缺陷：区间字段被 `Number.isFinite` 静默丢弃 —— **确认**（并多找到一处同源问题）

### 引擎侧：真 `/battle/plan` 回执（隔离副本 `216195c` 的引擎，非 8765）
```
battle_plan http = 200 ；回执顶层键 26 个
  expected             type=dict   keys=min,max,mean            Number.isFinite(该值)=False
  worst                type=dict   keys=min,max                 Number.isFinite(该值)=False
  first_second_margin  type=dict   keys=min,max,mean,scale,note Number.isFinite(该值)=False
  branches_evaluated   type=int    96                          Number.isFinite=True
  depth_searched       type=int    2                           Number.isFinite=True
原文: expected={"min":1.6645,"max":1.6645,"mean":1.6645}
      worst={"min":1.4508,"max":1.4508}
      first_second_margin={...,"scale":"one-ply-value","note":"…不是胜率、不是游戏机制的分差…"}
回执已落盘 E:\roco-scratch\plan-receipt.json
```
（这与 05 勘察探针读数 `{"isFinite_expected":false,"kept":{"branches_evaluated":24,"depth_searched":2}}` 的形态**一致**。）

### Node 投影后：三个字段**消失**
```
客户端 coachRocoPlan()（逐字抽自 src/client/roco.js:5577-5620，含第 5588 行那个 isFinite 循环）
  投影产出的键 = state_version, main_counter, branches_evaluated, depth_searched, recommendation_stable, risk
  expected            ⇒ **丢了**
  worst               ⇒ **丢了**
  first_second_margin ⇒ **丢了**
  branches_evaluated  ⇒ 96（保留）      depth_searched ⇒ 2（保留）
```

### **额外发现（比原 claim 更严重一处）**：服务端对「诚实的形状」是**拒收**
```
src/server/index.js:389（validateChat，**真 import 实测**）
  发标量形（页面现状）：**通过**
  发对象形（引擎真实的 expected/worst/first_second_margin）：**拒绝** → 「本回合规划无效：expected」
⇒ 就算客户端把这三个字段照实传上去，服务端也会 400。
而 src/coach/toolbox.js:1271-1272 又写着 `Number.isFinite(plan?.first_second_margin?.mean) ? …mean …`
  ⇒ **三层对同一字段的形状约定互相矛盾**：客户端丢对象 / 服务端拒对象 / 教练层等 `.mean`。
```
**建议**（供 Lead 裁决，我不改）：三处按同一份契约对齐 —— 要么引擎把区间拍平成标量（丢信息），
要么三处都改成读 `{min,max,mean}` 对象（保留范围与尾部，符合 04/05 的口径）。

### 最小复现
```powershell
# 1) 真引擎回执（隔离副本，WSL）
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-scratch/verify-041/roco && PYTHONPATH=src python3 /mnt/e/roco-scratch/vfy-claims-receipt.py"
# 2) 客户端投影 + 服务端校验
node E:\roco-coach\scripts\roco\verify-claims-05.mjs        # ⇒ CONFIRMED（exit 0）
```

---

## 诚实边界
- ① 的「工作树已修」是**在飞状态**（`src/client/{loadout-store,team-workshop,box-loadout}.js` 均未提交）：
  我验的是**模块级行为**（真 API + 内存 storage），**没有**驱动真实页面点按；UI 接线是否正确留待 08·S1 冻结后按常规口径复验。
- ② 的客户端函数是**逐字抽取**后在沙箱里执行的（`roco.js` 是浏览器脚本、非 ESM，无法直接 import）；
  抽取范围 `5577-5620` 已写进读数，函数首行与 `isFinite` 循环都在。服务端 `validateChat` 是**真 import**。
- 两条都只证明「我实测到的行为」，不外推到 08/05 的其它判据。
