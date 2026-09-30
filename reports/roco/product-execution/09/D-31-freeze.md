# D-31 冻结证据：路径家族第 12 例（判据在 Windows 上根本没跑）+「半夜还在打」文案层缺活跃闸

**执行**：`plan01-engine`（task-31） · **时间**：2026-09-30 23:30–23:45（Asia/Hong_Kong）
**授权**：Lead **D-31 窄例外**（两件都是**现有行为的缺陷**，且**不依赖 08 的任何产物**）
**写域**：`tests/evals/companion-nonintrusion.test.js` · `src/coach/companion.js` · `reports/roco/product-execution/09/`
（`tests/companion.test.js` / `tests/roco-companion-contextual.test.js` **批准可用但最终一个字没改** —— 见 §3）

---

## 1 · 本刀改了什么

| 文件 | sha256 前16 | 字节 | 改动 |
|---|---|---|---|
| `src/coach/companion.js` | `2231f8eeb5cafc26` | 240319 | 文案层加**活跃闸**（`staleOnly`，2 行）+ 一段说明注释；两条被判据钉住的原文**逐字未动** |
| `tests/evals/companion-nonintrusion.test.js` | `165481a657193eee` | 6495 | `import(pathToFileURL(SCRIPT).href)`（1 行）+ 旧写法逐字留档注释；**判据语义一字不改** |

`git status --porcelain` 里 `tests/companion.test.js` 与 `tests/roco-companion-contextual.test.js` **无输出**（零 diff）。

---

## 2 · A) 判据路径家族第 12 例

**改前（Windows）**：
```
Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data, and node are
supported by the default ESM loader. On Windows, absolute paths must be valid file:// URLs.
Received protocol 'e:'
✖ tests\evals\companion-nonintrusion.test.js (62.7851ms)   ℹ tests 1 · pass 0 · fail 1   exit=1
```
（测试体**一行都没跑到**：`SCRIPT = join(ROOT,'scripts','roco','verify-companion-nonintrusion.mjs')` 是绝对路径 → `E:\…`，ESM loader 把 `e:` 当 scheme）

**改后（Windows）**：`ℹ tests 7 · pass 7 · fail 0` · **exit=0**（文件真正跑起来，7 条判据全过）

**WSL 侧**：⚠ **WSL 里没有 node**（`command -v node` ⇒ `NO_NODE_IN_WSL`，退出码 1）⇒ 无法在 WSL 真跑。
改用**说明符读数**（python3 按 Node 的 `join()` 语义构造，等价物 `Path.as_uri()` = `pathToFileURL().href`）：
```
JOIN        = /mnt/e/roco-coach/scripts/roco/verify-companion-nonintrusion.mjs   （POSIX 上是绝对路径）
EXISTS      = True
AS_URI      = file:///mnt/e/roco-coach/scripts/roco/verify-companion-nonintrusion.mjs
```
⇒ 修法在两种平台上都产出**合法 URL**（Windows `file:///E:/…` / POSIX `file:///mnt/e/…`），
而改前的写法在 Windows 上必炸、在 POSIX 上恰好能work —— 这正是「本机跑不到」的根因。

**同形点扫描（`tests/**` + `scripts/**`，全仓只此一处是本刀要修的形态）**

| 位置 | 形态 | 判定 |
|---|---|---|
| `tests/evals/companion-nonintrusion.test.js:20` | `import(SCRIPT)`（绝对路径） | **本刀已修** |
| `tests/roco-rag-tactic-cards.test.js:49` | `import(pathToFileURL(join(...)).href)` | ✅ 正确形态（正例） |
| `tests/roco-experience-petof.test.js:10` · `tests/roco-panel-model-env-key.test.js:55` · `tests/evals/roco/agent-trajectories.test.js:70/146` | 相对说明符 / `JSON.stringify(module)` | ✅ |
| `scripts/roco/verify-03*.mjs`（6 个）· `verify-041/042` · `verify-claims-05.mjs` | 手工拼 `` `file:///${R}/…` `` + `.replace(/\\/g,'/')` | ⚠ 可用但非 `pathToFileURL`（同族弱形态）—— **登记，不在本刀** |
| `scripts/roco/verify-claims-08-g01.mjs:9-10` | **硬编码** `file:///E:/roco-scratch/…` | ⚠ 换机器即断（另一类：硬编码本机路径）—— **登记** |

---

## 3 · B)「半夜还在打」用陈旧记录说话（产品缺陷）

**根因**：读点层有活跃闸（`companion.js:446` `ledger.run.active && part.id==='late'`；`:437` `active` = 距最后一局 ≤ `SESSION_GAP` 90 分钟），
**文案层漏了**：原来 `if(night||nowLate)` 只问「现在是不是 0–6 点」，随后 `wave` 又从**陈旧**的 `ledger.run` 取到 3 ⇒ 把 11 天前的三局说成「这一波」。

**修法**：`if` 里面加一道闸（三种情形）——
| 情形 | 行为 |
|---|---|
| `night`（读点层给了 `lateNight`，人还在打、这一波跨了零点） | 说那几局（`过了零点你已经打了N局。`） |
| 凌晨 + **没有任何这一波的记录**（首页打开、还没开始打） | 只说「这么晚了。」（没有数字可引用） |
| 凌晨 + 记录**陈旧**（`run.active!==true`） | **一个字都不说** |

```js
990: const nowLate=dayPartAt(now).id==='late';   // ← 判据钉的原文，逐字未动
991: if(night||nowLate){                        // ← 判据钉的原文，逐字未动
992:  const staleOnly=!night&&Boolean(run&&run.active!==true);
993:  if(!staleOnly){                            // ← 新增的闸
```
**为什么把闸放在里面**：`tests/roco-companion-contextual.test.js:263-264` 用**源码正则**钉住上面两行的原文
（`/if\s*\(\s*night\s*\|\|\s*nowLate\s*\)/` 与 `/const nowLate=dayPartAt\(now\)\.id==='late'/`）。
把闸折进条件里会让第一条判据变红，而那个文件**不在写域** ⇒ 改为「条件不动、闸放里面」，
两条判据的**锚点与语义都不受影响**（实测 16/16 绿），也避免了一次不必要的改钉。

---

## 4 · 两向变异（隔离副本 `E:\roco-scratch\base2`，脚本 `p31_mutate.py`）

| 变异 | 内容 | 期望 | 实测 |
|---|---|---|---|
| **A** | `import(pathToFileURL(SCRIPT).href)` 退回 `import(SCRIPT)` | 必红 | `ℹ tests 1 · pass 0 · fail 1` · `ERR_UNSUPPORTED_ESM_URL_SCHEME … protocol 'e:'` · **exit=1** |
| **B** | 只去掉活跃闸（`staleOnly=false`） | 必红 | `companion.test.js` **90 · 89 pass · 1 fail**（✖ 半夜还在打）· actual `'这么晚了。这一局打完就到这儿也行。'` |
| **B2** | 完整回到**缺陷原状**（闸去掉 **+** `wave` 退回从陈旧 `run` 取） | 必红且原句复现 | **90 · 89 pass · 1 fail**；actual **`'这么晚了，这一波你已经打了3局。这一局打完就到这儿也行。'`** / expected `null` ⇒ **与判据抓到的原句逐字一致** |

⇒ 判据有牙：把修复撤销，指的正是同一条断言、同一句话。

---

## 5 · 副作用复跑（引 `companion.js` 的**全部** 10 个判据文件）

| 文件 | 改后 | 备注 |
|---|---|---|
| `tests/companion.test.js` | **90 · pass 90 · fail 0** | 改前 89/90（红的就是本刀修的这条） |
| `tests/roco-companion-contextual.test.js` | **16 · pass 16 · fail 0** | 改前 16/16；**文件零改动** |
| `tests/evals/companion-nonintrusion.test.js` | **7 · pass 7 · fail 0** | 改前 1 · 0 pass · 1 fail（文件都没加载起来） |
| `tests/evals/companion-contract.test.js` | 15 · pass 15 | — |
| `tests/roco-plain-speak.test.js` | 12 · pass 12 | 玩家可读性棘轮未触发 |
| `tests/roco-memory-three-classes.test.js` | 10 · pass 10 | — |
| `tests/roco-player-number-precision.test.js` | 6 · pass 6 | — |
| `tests/roco-review-body-fallback.test.js` | 4 · pass 4 | — |
| `tests/browser.test.js` | 14 · 12 pass · 0 fail | 2 skip |
| `tests/evals/structure-contract.test.js` | 28 · 26 pass · **2 fail** | **与本刀无关**（见下） |
| `tests/evals/player-copy.test.js` | 2 · 1 pass · **1 fail** | **与本刀无关**（见下） |

**两条既有红的点名**（都不是本刀文件）：
- `structure-contract`：① `docs/roco/review-2026-09-28/pending-judge/skill-support-fact.judge.js -> ../src/server/roco-service.js` 不存在；
  ② `tests/roco-player-number-precision.test.js` 没被任何 npm script/自检登记表引用。
- `player-copy`：`src/coach/teacher.js:329/350` 的「分支」（别人的在飞文件）。
（隔离副本对 `structure-contract` 不可比：副本只有 src/tests/scripts/reports，缺 `docs/**`/`tmp/**` ⇒ 副本 22/28 比仓库 26/28 更红；上表按**仓库**读数。）

---

## 6 · 命令与退出码

| # | 命令 | 退出码 | 读数 |
|---|---|---|---|
| 1 | 改前 `node --test tests/evals/companion-nonintrusion.test.js` | 1 | tests 1 · pass 0 · fail 1（`ERR_UNSUPPORTED_ESM_URL_SCHEME`） |
| 2 | 改后 同 #1 | **0** | tests 7 · pass 7 · fail 0 |
| 3 | 改前 `node --test tests/companion.test.js` | 1 | 90 · 89 pass · 1 fail |
| 4 | 改后 同 #3 | **0** | 90 · pass 90 · fail 0 |
| 5 | 改后 `tests/roco-companion-contextual.test.js` | **0** | 16 · pass 16 |
| 6 | 变异 A（隔离副本） | 1 | 1 · 0 pass · 1 fail（原错误复现） |
| 7 | 变异 B / B2（隔离副本） | 1 / 1 | 各 90 · 89 pass · 1 fail（B2 复现**原句**） |
| 8 | `wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/p31-wsl-reading.sh` | 0 | `NO_NODE_IN_WSL` + 说明符读数（见 §2） |
| 9 | `node --check src/coach/companion.js` | **0** | 语法通过 |
| 10 | 副作用复跑 11 个文件（见 §5） | 见上 | 除两条既有红外全绿 |

**未做**：Python 全量（本刀只碰一个 coach 模块 + 一个判据）；浏览器真机（不需要）；`data/**` 未动；未用 git 写命令。
