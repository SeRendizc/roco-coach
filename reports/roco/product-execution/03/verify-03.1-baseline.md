# 独立复核：03.1 勘察的基线声称（harness-verifier）

**对象**：`plan03-belief` 的 `03.1-recon.md` §0 结论 3（「起点就是红的（1 条）」）
**方式**：我自己在工作树上跑，**只读**；原始输出 `E:\roco-scratch\vfy02\belief-test.log`

---

## §1 声称 → 我的独立读数（**逐条相符**）

| 它的声称 | 我的实测 | 判定 |
|---|---|---|
| `node --test tests/roco-opponent-belief.test.js` ⇒ **12 pass / 1 fail, exit 1** | `exit=1 · tests=13 · pass=12 · fail=1` | ✓ **逐字相符** |
| 红的不是实现，是**磁盘报告陈旧** | 唯一失败断言是报告 byte 比对：`AssertionError: 报告不一致：跑 RC604_WRITE_REPORT=1 node --test … 重写` | ✓ |
| 唯一差异是 `filter.opponent_speed_tier` 的 `basis` 文案 | 差异行共 **4 条有效**（2 对，字段全是 `basis`，分别位于 `rules[]` 与 `rule_ledger[]`）；其余是 assert 输出的截断标记（`... more characters`），不是差异 | ✓ **精确相符** |
| 报告路径不在其写域 | 文件存在：`reports/roco/rc604/opponent-belief.json` · **104678 B** · mtime **17:10:40**（早于当前实现文案） | ✓ 陈旧属实 |

**具体差异原文**（⚠ 已按 Lead 指正更正读法，见 §1.1）：

```
[+] = actual   = **磁盘报告**（assert.equal(disk, text) 的第一个实参）:
      "速度档来自 RC-303 的 `speedBandFor()`（在候选宇宙内按三分位分档），本模块不另立分档。…"
[-] = expected = **当前代码新生成的文本**（beliefReport()）:
      "**亮明的那只的**速度档是公开面上看得到的（引擎公开视图给的 `speed_band`）；档位本身来自 RC-303 的 `speedBandFor()`…"
```
⇒ 差别是**领头那一句**在**当前代码**里有、**磁盘报告**里没有（两处：`rules[]` 与 `rule_ledger[]` 同源）。
即：**当前实现新写了「引擎公开视图给的 `speed_band`」这句自述，而引擎公开面里根本没有 `speed_band`** ——
所以那句是**不实自述**；磁盘报告是**旧文案**、还没有这句。

### §1.1 我原来的读法错在哪（留档）

我第一版写成「磁盘版有这句 / 当前代码版没有」——**读反了**。错因：node 的 assert 差异头是
`+ actual - expected`（`+` 永远跟着**第一个实参**），而**这个测试把 `disk` 传给第一实参**：

```js
// tests/roco-opponent-belief.test.js:958
assert.equal(disk, text, '报告不一致：跑 RC604_WRITE_REPORT=1 node --test … 重写');
```

我没去看这行就把 `+` 当成了「当前代码」，于是把两侧对调。
**更正后与 Lead 的指正一致**：**当前代码里有那句不实 `basis`，磁盘报告没有**。
（教训：读 assert 差异前先确认 `assert.x(actual, expected)` 的实参顺序 —— 头里的 `+ actual/- expected`
只说明「第一个实参」，不说明谁是"被测对象"。）

## §2 它的「未被在线接线」声称：**方向上成立，清单可补全**

我自己全仓扫 `opponent-belief`（排除 `node_modules`/`.git`/`product-execution` 产物）命中：

```
src/coach/opponent-belief.mjs          ← 自身
tests/roco-opponent-belief.test.js     ← 本测试
scripts/roco/rebuild-derived.mjs       ← 产物重建
package.json                           ← test 脚本入口（**它没列**）
docs/roco/execution/STATE.json         ← 状态文档（**它没列**）
reports/roco/rc604/opponent-belief.json← 产物本身（**它没列**）
```
⇒ 它说的「只命中自身 / 本测试 / rebuild-derived」在**代码路径**上成立（没有任何在线入口 import 它），
只是清单少了 3 个非代码命中。**不影响结论**，登记以免后人对不上数。

## §3 结论

**03.1 的基线声称（起点 1 条红 = 陈旧报告）独立复现，逐字相符。** 03 的每一步都可以放心在这条基线上做。
**我没有改任何东西**；`RC604_WRITE_REPORT=1` 那条重写命令我**没有**执行（它写 `reports/roco/rc604/**`，不在我的写域，
且属实现者动作）。

## §4 复跑

```powershell
cd E:\roco-coach; $env:Path="C:\Program Files\nodejs;"+$env:Path
node --test tests/roco-opponent-belief.test.js          # ⇒ exit 1 · tests 13 · pass 12 · fail 1
Select-String -Path <log> -Pattern 'AssertionError' -Context 0,30   # ⇒ 只有 basis 文案差异
```
