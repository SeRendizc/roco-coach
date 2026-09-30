# Node 套件差分：`83ed968`（接手基线）→ `3d910c4`（修前 HEAD）→ `8462d70`（修后）

**执行**：harness-verifier · **方法**：每份都是**整仓 `git archive`** 的不可变副本，跑**同一套** Node 测试
**目的**：回答「我们三笔提交（`2e30a4f`/`5002433`/`59e55df`）有没有在 Node 侧引入回归」——
此前只跑过 4 个契约件 + `server.test.js` + PVP 一件，**漏掉了 `roco-plain-speak` 的棘轮回归**（task-10 已修）。

---

## §1 选取规则（先写清楚，再谈结论）

- **纳入**：`tests/*.test.js` 全部（本轮共 **147** 个），执行方式 `node --test <file>`，
  **一文件一进程**、`120s` 超时、`ROCO_PYTHON=C:\Users\ASUS\anaconda3\python.exe`、并发 4。
- **排除 6 个**（并按三个方向写明理由）：

| 文件 | 排除理由 |
|---|---|
| `browser.test.js` · `replace.test.js` · `roco-team-cards-layout.test.js` | 需要**真浏览器**（playwright/puppeteer/CDP/CHROME_PATH） |
| `roco-model-wiring-honesty.test.js` · `roco-packet-vs-gold.test.js` · `roco-xiaoya-context.test.js` | 需要**本地模型或外网**（ollama/OPENAI/API_KEY/外部 URL） |

- 判据：`EXCLUDED` 三份副本一致（各 6 个），且**不计入**任何结论。

## §2 三份副本的总读数

| 副本 | SHA | 文件数 | ok | bad | excluded | 耗时 |
|---|---|---|---|---|---|---|
| 基线 | `83ed968` | 146 | 105 | 35 | 6 | 109s |
| 修前 HEAD | `3d910c4` | 147 | 104 | 37 | 6 | 114s |
| 修后 | `8462d70` | 147 | **107** | **34** | 6 | 104s |

副本路径：`E:\roco-scratch\node-diff-base` / `node-diff-head` / `fix-8462d70`
JSON：`E:\roco-scratch\vfy02\node-suite-{base,head,fix}.json`

## §3 差分表

### §3.1 基线 → **修前** `3d910c4`：**新红 2**（我们引入的回归）

| 文件 | `83ed968` | `3d910c4` | 判读 |
|---|---|---|---|
| `roco-plain-speak.test.js` | 12/12 OK | **11/12，1 fail** | **真回归**（01 把棘轮 2→4）⇒ 已由 `6279afd` 修（见 §3.2） |
| `roco-standard-pvp-battle.test.js` | 15/15 OK（7.6s） | **status=1，只跑出 12 条、11 pass、0 fail**（8.2s） | **不是断言失败，是进程被中途打断** ⇒ 这是 **P0（Ctrl+C 广播）在 Node 套件里的显形**（该用例经 `roco-client.js` 起带 `--parent-pid` 的真服务） |

**新绿 0** · **两侧都红 35**（预先存在）· **只在 HEAD 有 1**：`roco-observation-contract.test.js`（01 新增，OK）。

### §3.2 基线 → **修后** `8462d70`：**新红 0**

| 文件 | `83ed968` | `8462d70` | 判读 |
|---|---|---|---|
| **新红** | — | — | **无** ⇒ Node 侧无遗留回归 |
| `roco-plain-speak.test.js` | 12/12 | **12/12** | 回归已被 `6279afd` 修掉 ✓ |
| `roco-standard-pvp-battle.test.js` | 15/15 | **15/15** | P0 修好后**不再被打断** ✓ |
| `roco-gold-review-gate.test.js` | status=1（t=1 p=0 f=0，50.3s） | **11/11 OK**（46.3s） | ⚠ **未解释的翻转**：它在修前 `3d910c4` 也红（t=1 p=0 f=0，53.3s，同样是"跑不完"的形态）。**不主张**是本轮修复之功，按**不稳定/待查**登记 |

**两侧都红 34**（预先存在，见 §4）。

### §3.3 三个关键文件在三个副本上的逐条读数（避免"只看一列"）

```
文件                         83ed968            3d910c4            8462d70
roco-standard-pvp-battle     status=0 t=15 p=15 f=0  status=1 t=12 p=11 f=0  status=0 t=15 p=15 f=0
                             (7.6s)                  (8.2s，被中断)             (7.3s)
roco-plain-speak             status=0 t=12 p=12 f=0  status=1 t=12 p=11 f=1  status=0 t=12 p=12 f=0
roco-gold-review-gate        status=1 t=1 p=0 f=0    status=1 t=1 p=0 f=0    status=0 t=11 p=11 f=0
                             (50.3s)                 (53.3s)                 (46.3s)
```

## §4 §4 「两侧都红」34 个＝预先存在（不属本轮回归）

它们**意图上**与基线同态（同一文件、同样的 tests/pass/fail 三元组）。
⚠ 其中相当一部分是**归档副本的环境效应**（副本里没有本机生成物/模型/外网），
**不是**"产品坏了"的证据 —— 本报告不对这 34 个逐个定性（超出本次范围），
只声明：**它们不是本轮三笔提交引入的**（基线同样红、同样数字）。

## §5 边界（如实登记）
2. 排除的 6 个文件**没有**被验证，结论只覆盖纳入的 141 个。
3. 并发 4 ⇒ 负载相关的偶发（如 PVP 被打断）**在修前**可能被放大；修后三跑全绿（§6）。
4. 本次差分**不评价**那 34 个预先存在的红该不该修。

## §6 修后定向复跑（`8462d70` 副本）

```
plain-speak            : exit=0 tests=12 pass=12 fail=0
contract54             : exit=0 tests=54 pass=54 fail=0   （4 契约件 + server.test.js）
pvp-run1/2/3           : exit=0 tests=15 pass=15 fail=0   （3 连跑）
```
日志：`E:\roco-scratch\vfy02\fix-*.log` · `node-fix-checks.txt`

## §7 最小复现

```powershell
# 1) 两份整仓副本
wsl -d Ubuntu-22.04 -- bash -lc "git -C /mnt/e/roco-coach archive 83ed968 | tar -x -C /mnt/e/roco-scratch/node-diff-base"
wsl -d Ubuntu-22.04 -- bash -lc "git -C /mnt/e/roco-coach archive 8462d70 | tar -x -C /mnt/e/roco-scratch/fix-8462d70"
# 2) 同一套跑法（Windows 侧 node；ROCO_PYTHON 指向可用解释器）
$env:ROCO_PYTHON='C:\Users\ASUS\anaconda3\python.exe'
node E:\roco-scratch\vfy02\run-node-suite.mjs E:\roco-scratch\node-diff-base E:\roco-scratch\vfy02\node-suite-base.json 4
node E:\roco-scratch\vfy02\run-node-suite.mjs E:\roco-scratch\fix-8462d70   E:\roco-scratch\vfy02\node-suite-fix.json 4
# 3) 差分表
node E:\roco-scratch\vfy02\node-suite-diff.mjs E:\roco-scratch\vfy02\node-suite-base.json E:\roco-scratch\vfy02\node-suite-fix.json
```

## §8 结论（一句话）

**`83ed968` → `8462d70`：新红 0、新绿 1（未解释，且修前也红）⇒ 本轮三笔提交在 Node 侧没有遗留回归**；
且这张表**独立抓到了** `roco-plain-speak` 的棘轮回归与 `roco-standard-pvp-battle` 的 P0 中断 —— 两条都已在 `8462d70` 转绿。
