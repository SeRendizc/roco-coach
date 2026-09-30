# 独立复核：03.1 收尾（harness-verifier）· **部分合格 · 两项因工作树已前进而无法在「03.1 版本」上复验**

**对象**：`03.1-wrapup.md`（mtime **20:46:58**）+ `raw-03.1-*` + `src/coach/opponent-belief.mjs` + `tests/roco-opponent-belief.test.js`
**结论一句话**：**能验的都验了且相符**；但**工作树在我复验期间已经进入 03.2**（硬证据见 §0），
所以「18 ✔ / 0 ✖」「新断言非恒真」「报告只由生成器写」这三条**无法在 03.1 的冻结版本上复验** ——
我不拿 03.2 的中间态去判 03.1 的账，也**不替它背书**。

---

## §0 为什么有两项验不了（硬证据，先看这个）

| 证据 | 数值 |
|---|---|
| `03.1-wrapup.md` mtime | **20:46:58** |
| `src/coach/opponent-belief.mjs` mtime | **20:51:03**（晚于 wrapup **4 分钟**） |
| `tests/roco-opponent-belief.test.js` mtime | **20:52:43** —— **在我案例 1 跑起来 15 秒后被改写** |
| 测试文件里的 `test(` 数量 | 现在 **24** 个；他们 `raw-03.1-tests-after.txt` 记的是 **18**；`git HEAD` 版是 **13** |

⇒ 我案例 1 跑出的是 `tests=24 pass=22 fail=2` —— **那是 03.2 的中间态，不是 03.1 的读数**。
我**没有**把这 2 条失败当成 03.1 的问题上报。（若 Lead 要复验这三条，需要把 03.1 的两个文件冻结成
commit 或快照；否则只能采信他们的 raw 留档。）

---

## §1 能验的：**逐条相符**

| # | 判据 | 我的独立读数 | 判定 |
|---|---|---|---|
| 1 | **原断言逐字留档** | 把 wrapup §2.1/§2.2 引的两段代码拿去与 `git show HEAD:tests/roco-opponent-belief.test.js` **机器比对**：两段都**逐字存在** | ✓ |
| 2 | 他们的 raw 读数真的写着 18/0 | `raw-03.1-tests-after.txt`（UTF-16）里确有 `tests 18` · `pass 18` · `fail 0` | ✓ 留档存在 |
| 3 | **两条审计码真的会红**（red_proofs） | 我自己的探针 `scripts/roco/verify-03-redproof.mjs`：**控件**（未改报告）两条码都不出现 → 非恒红；**A** 把一行 `numerator` 压 0 ⇒ `ASSUMPTION_ZEROES_CANDIDATE` **红**（detail 点名 `pet_000001`）；**B** 把**带 `weights.rows` 那条信念**的 `basis` 改成 `ad_hoc_basis` ⇒ `WEIGHT_BASIS_NOT_DECLARED` **红**（detail 列出允许集合） | ✓ PASS |
| 4 | **Q2 键路径**（三面 dump，Lead 点名） | 我自己用真引擎 dump：`ui_public_view.opponent.field` = **16** 键（与它列的 16 个**完全一致**）· `public_planner_state.opponent.field` = **10** 键（一致）· `observation_for.opponent`（active 行）= **11** 键（一致）；`hp/max_hp/energy/statuses/marks` **三面全有**；**反向**：`speed`/`speed_band` 在**三面递归扫描（含字符串值）里 0 命中** | ✓ |
| 5 | 旧断言 vs 新实现会红（改钉必要性） | 旧测试（`git HEAD`，sha16 `0a087fb55d658712`）+ 当前实现 ⇒ `tests=13 pass=6 fail=7` **红** | ✓ 方向成立（见 §3 注） |

## §2 一条**审计覆盖面**观察（登记，不判失败）

我的探针额外测了：把 **uniform 信念**（有 `weights`、但**没有 `rows`**）的 `basis` 改成 `ad_hoc_basis`
⇒ `WEIGHT_BASIS_NOT_DECLARED` **不触发**。
原因（读码可见）：`buildProblems` 里那段 R2 检查挂在「`weights.rows` 非空」分支内（`opponent-belief.mjs` 约 1935–1956 行），
所以**只约束带逐条权重的那条信念**。影响有限（uniform 的语义另有 `declared_semantics`/`red_lines` 审计兜着），
**但若 R2 的意图是「凡带 weights 的信念都要声明依据」，这里是个缺口** —— 请 Lead 与实现者定口径。

## §3 我自己犯错的两处（如实登记）

1. **读反 assert 方向**（已在 `verify-03.1-baseline.md` §1.1 更正）：node 的 `+ actual - expected` 里
   `+` 跟的是**第一个实参**，而该测试是 `assert.equal(disk, text)` ⇒ `+`=磁盘、`-`=新生成。
   更正后与 Lead 的指正一致：**当前代码里有那句不实 `basis`，磁盘报告没有**。
2. **一条无效探针（已删除）**：我写的 `scripts/roco/verify-03-report-identity.mjs` 直接
   `beliefReport()` **不注入 catalog/publicFacts** ⇒ 生成的是退化报告（`universe.size=0`、`match_id` 缺失），
   于是打印出 `BYTE_IDENTICAL=false` —— **那是我探针的错，不是「报告被手工改过」的证据**。
   该文件已删；「磁盘报告 == 生成器输出」这条**应以测试自身的 `assert.equal(disk, text)` 为准**（我未在 03.1 版本上复验）。

## §4 判定

| 判据 | 判定 |
|---|---|
| 原断言逐字留档 | **合格**（git 机器比对） |
| 两条 red_proofs 真会红 | **合格**（我自己的探针，含控件） |
| Q2 键路径 + 反向零命中 | **合格**（我自己 dump 真引擎） |
| 改钉必要性（旧断言会红） | **合格（方向性）** |
| 「18 ✔ / 0 ✖」在 03.1 版本上复现 | **未验（工作树已进 03.2）** |
| 新断言**非恒真**（改坏版必红） | **未验**（同上；且我的案例 3 已被 03.2 中间态污染，不作为依据） |
| 报告「只由生成器写」/ 改前后数据面 0 差异 | **未验**（同上；我的探针方法错误，已删除） |

**给 Lead 的处置建议**：这三条「未验」要么 (a) 把 03.1 冻结成 commit/快照让我补验，要么
(b) 在 STATE 里记为「有 raw 留档、未经独立复现」，**不要写成「已独立复验」**。
03.2 落地后我再按你的点名复验 —— 那时**请在改钉/改实现前先 commit**，否则同样的问题会重演。

## §5 复跑

```powershell
node scripts/roco/verify-03-redproof.mjs        # ⇒ REDPROOF PASS（控件干净 + 两条都红）
# Q2 键路径：见 E:\roco-scratch\vfy-03-keys.py（WSL 真引擎 dump）
# 临时副本三案例：E:\roco-scratch\vfy02\verify-03-wrapup.ps1 + case-prep.sh（只动副本，不动工作树）
```
