# task-10 证据：plain-speak 棘轮 2 → 4 的回归修复（01 那笔 `5002433` 引入）

**执行**：`plan01-engine` · **时间**：2026-09-30 19:3x–19:5x · **处置**：**改文案，不动棘轮**（默认处置）
**改动文件**：`src/server/roco-service.js`（blob `14d4240…` → `23f041332379480f5e26f0c9d0e2ecedfcf68c5c`）
**未改**：`tests/roco-plain-speak.test.js`（棘轮一个字节没动）· `src/coach/plain-words.js`（词表没动）

---

## 1 · 复现（改前原始输出与退出码）

```sh
node --test tests/roco-plain-speak.test.js        # 原始输出：plain-speak-before.txt
```
```
✖ ② 工程语气的欠账只许降（棘轮） (4.5449ms)
ℹ tests 12
ℹ pass 11
ℹ fail 1
AssertionError [ERR_ASSERTION]: src/server/roco-service.js 的工程语气从 2 涨到了 4（只许减）：
  :552  未知参数 ${key}（白名单：${BOX_PARAM_KEYS.join('/')}）          ← 既有欠账
  :667  未知参数 ${key}（白名单：${WORKSHOP_PARAM_KEYS.join('/')}）     ← 既有欠账
  :1570 这一局的标识对不上（本地记录 ${bound}，引擎回执 ${got}）：        ← 本批新加
  :1576 这一局的规则版本对不上（本地记录 ${boundRules}，引擎回执 ${gotRules}）： ← 本批新加
```
**退出码 1**（`BEFORE_EXIT=1`）。

## 2 · 根因

1. 那两句把**内部 id 直接拼进给玩家看的句子**（`m-one` / `m-two` / `roco-…/legacy_sim_v1`）；
2. 「引擎**回执**」命中词表 `ENGINEER_TONE_WORDS`（`回执/判据/台账/兜底/降级/守卫/归一化/白名单`，见 `src/coach/plain-words.js:75`）
   ⇒ 每个文件的中文串字面量计数 +2，`roco-service.js` 由 2 涨到 4。

**这是我的锅**：D-5（串局 fail closed）功能是对的，但**文案没按仓库既有规范写**；
而 01 的验收当时只跑了 4 个契约件 + `server.test.js`，**没跑 plain-speak 棘轮**，所以漏到 plan02-front 才抓到（见 §6）。

## 3 · 改法（改文案 + 结构化字段，可调试性不丢）

`matchMismatch` 由「返回**字符串**」改成「返回 `{error, error_context}`」：

| 位置（改后行号） | 现在返回 |
|---|---|
| `src/server/roco-service.js:2040-2047` | `{error:'这一局和本地记的对不上：不把两局混在一起，请重新开一局。', error_context:{field:'match_id',local:bound,engine:got}}` |
| `src/server/roco-service.js:2048-2053` | `{error:'这一局用的规则版本和本地记的对不上：规则变了以后旧建议不适用，请重新开一局。', error_context:{field:'rules_version',local:boundRules,engine:gotRules}}` |

三个调用点把结构化字段**摊进回执**（`error` 仍是人话，`error_context` 给日志/调试台/调用方自己比对）：
`advanceBattle:2484` · `freeAction:2522` · `planBattle:2934` —— 均由
`{ok:false,status:409,error:mismatch,…}` 改为 `{ok:false,status:409,...mismatch,error_type:'match_mismatch'}`。

**为什么不动棘轮**：棘轮是玩家可读性的守卫（`docs/roco/PLAIN-SPEAK.md` 的静态执行层），
`roco-service.js` 剩下的 2 条是**既有欠账**（两处「白名单」参数校验提示），与本批无关；
为一次文案回归去抬棘轮，等于把守卫调松来迁就实现 —— 默认不做。本案用「改文案」完全能解决，故未申请改棘轮。

**一处有意的耦合（如实登记）**：`tests/roco-observation-contract.test.js` 的 ⑦ 断言
`assert.match(bad.error, /对不上/)`。新文案**保留**了「对不上」这个大白话词（而不是写成「不是同一局」），
所以那条断言不用改（它不在本任务写域内）。**若将来再改这句文案，必须同步那条断言**。

## 4 · 可调试性读数（`probe-12-match-mismatch-plain.mjs` → `raw-match-mismatch.json`，exit 0）

```json
"other_match": {
 "ok": false, "status": 409, "error_type": "match_mismatch",
 "error": "这一局和本地记的对不上：不把两局混在一起，请重新开一局。",
 "error_context": {"field": "match_id", "local": "m-one", "engine": "m-two"},
 "jargon": {"hard": [], "soft": []},
 "mentions_raw_ids": false
},
"other_rules": {
 "error": "这一局用的规则版本和本地记的对不上：规则变了以后旧建议不适用，请重新开一局。",
 "error_context": {"field": "rules_version",
   "local": "roco-world-s4-2026-09-10/legacy_sim_v1",
   "engine": "roco-world-s4-2026-09-10/legacy_sim_v1-changed"},
 "jargon": {"hard": [], "soft": []}
},
"same_match_ok": true,
"legacy_no_match_id": {"ok": true, "note": "读不到 match_id ⇒ 跳过守卫（不假装知道）"}
```
⇒ **句子**里既没有内部 id，也没有任何硬禁词/工程语气词；**id 一个没丢**，都在 `error_context` 里。

## 5 · 改后读数（命令 + 退出码 + 计数）

| # | 命令 | 退出码 | 读数 |
|---|---|---|---|
| 1 | `node --test tests/roco-plain-speak.test.js` | **0** | **tests 12 · pass 12 · fail 0**（`plain-speak-after.txt`；棘轮 ② 由 ✖ 转 ✔） |
| 2 | `node --test tests/roco-observation-contract.test.js tests/roco-battle-context.test.js tests/roco-coach-context-contract.test.js tests/roco-server-side-guard.test.js tests/server.test.js` | **0** | **tests 54 · pass 54 · fail 0**（`node-contract-after-plain-speak.txt`） |
| 3 | `node reports/roco/product-execution/01/probe-12-match-mismatch-plain.mjs` | **0** | 上面 §4 的 `raw-match-mismatch.json` |
| 4 | `node reports/roco/product-execution/01/probe-13-tone-count.mjs` | **0** | `raw-tone-count.json`：`src/server/roco-service.js` **soft_count=2**（= 登记欠账，两条都在 `:552`/`:667` 的既有提示）、`hard_count=0`；其余文件与 `DEBT` 表登记的数值一致 |

> 命令 2 里同时含 D-5 的两条反向用例（串局 409 `match_mismatch`、老回执跳过守卫），
> 全绿 ⇒ 改文案**没有**弄坏守卫行为。

## 6 · 验收清单缺口（为什么 01 没抓到它，以及补上之后长什么样）

**事实**：01 的 Node 验收只跑了
`tests/roco-battle-context.test.js` + `roco-coach-context-contract.test.js` + `roco-server-side-guard.test.js`
+ `roco-observation-contract.test.js`（4 个契约件）+ `tests/server.test.js`，
**没有跑 `tests/roco-plain-speak.test.js`** —— 而 `src/server/roco-service.js` 正被这份棘轮扫。
于是「功能绿、文案红」这条回归漏到了 plan02-front 跑客户端文件时才暴露。

**修正后的 Node 验收清单（本次 task-10 起适用）**：

```sh
# ① 契约与守卫（含 D-5 反向用例）
node --test tests/roco-observation-contract.test.js tests/roco-battle-context.test.js \
  tests/roco-coach-context-contract.test.js tests/roco-server-side-guard.test.js
# ② 服务端
node --test tests/server.test.js
# ③ **玩家可读性棘轮（新增，必跑）** —— 任何改动 src/server/roco-service.js 的提交都要跑
node --test tests/roco-plain-speak.test.js
# ④（需要起真引擎时）ROCO_PYTHON=<win python> node --test tests/roco-standard-pvp-battle.test.js
```

判据：① 28/28 · ② 26/26 · ③ **12/12**（棘轮 ② 必须 ✔）· ④ 15/15。

## 7 · 边界 / 未做

1. **棘轮保持 2**（`DEBT.soft['src/server/roco-service.js'] = 2`），两条既有欠账
   （`:552`/`:667` 的「白名单」参数提示）**本轮未动** —— 它们不是本任务引入的，且它们的提示对象是**调用方**（开发者），
   改它们要先想清楚「参数名要不要给调用方看」；留待需要时单独一轮。
2. 结构化字段叫 `error_context`：回执里**只在串局时出现**（正常路径一个键都不多），
   与「引擎给才给」的既有口径一致。
3. 本次**没跑**全量 Python 套件（本任务只碰 Node 文案与一个 Node 探针；`roco/src` 未改）。
