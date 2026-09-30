# 独立复验：O-53（client 文案无门禁）+ 器材自检修正 + ① `/api/coach` 进度

**版本**：工作树态（`src/client/*` 迁移**未提交**，`git status` 显示 5 个 client 文件为 `M`）；
副本 = `tar` 复制工作树的 `src/tests/reports/knowledge/roco/package.json`（1543 文件），变异只在副本内做。

---

## §1 O-53：`src/client/**` DOM 文案**不在任何判据/门禁覆盖内** → **成立（实证）**

**变异**：`src/client/app.js:147`（模板串，真渲染）里 `血量` → `生命`（改回退役词）。

```
控制（不改）10 个最相关判据 ⇒ 红 4 / 10
  roco-player-text-gate exit=0 · rules exit=0 · knowledge exit=0 · roco-rag-tactic-cards exit=1 ·
  roco-page-ux exit=0 · roco-standard-pvp-battle exit=1 · roco-battle-panel-static exit=0 ·
  roco-box-drawer exit=1 · copy exit=0 · roco-plan-context exit=1
变异后同一批 ⇒ **红 4 / 10，逐文件 exit 码与上面一字不差**
⇒ **变异没有让任何判据变色**（红的仍红、绿的仍绿）—— delta = 0
语料门禁（同一副本）：语料条目 = 503 · 覆盖审计 ok · **退役词命中 = 0 处**（改了也看不见）
```
**结论句（可直接引用）**：**`src/client/**` 的 DOM 文案当前不在任何判据/门禁的覆盖内 —— 改回去也不会红。**
依据：①10 个最相关判据对同一变异**零响应**；②真渲染语料门禁（503 条、覆盖审计 ok）**看不到**它，因为
`collectCorpus()` 的生产者只有 `src/game/*` + `src/coach/*` 九模块，`src/client/**` 不在其中
（`player-text-audit.md:133` 亦自述「`src/client/**` 的 DOM 文案」属未覆盖）。

**接线后的预期（`plan00-closer` 把 client 生产者收进语料之后）**：同一个变异应当**必红**，
且红在 `tests/roco-player-text-gate.test.js` 的
「④ 渲染语料里不许有：长浮点 / 脏值 / 内部 ID / 内部术语 / 退役单位词」，报错形如
`<api>@src/client/app.js ⇒ retired-unit（退役单位词（HP/生命/豆））命中「生命」：<原文>` ——
这正是我在 9b43bc1 上对 `engine.js`/`rules.js` 渲染串做同型变异时见到的形状（当时 25 条命中、必红）。

⚠ **一处与 `plan02-front` 读数的差异（如实登记）**：我这套控制组**本来就有 4 个红**
（`roco-rag-tactic-cards` / `roco-standard-pvp-battle` / `roco-box-drawer` / `roco-plan-context`）——
来自工作树的**在飞态**（O-49 漂移、client 迁移做了一半等），**与 client 文案无关**（变异前后完全相同）。
所以我的表述是「**变异让 0 个判据变色**」，而不是「10 个全绿」。他们那边大概是在更干净的工作树上跑的。

## §2 器材自检修正（Lead 点名）

`scripts/roco/verify-text-vocab.mjs` 原来钉死「语料条数 = 230」⇒ 语料涨到 **503** 后**恒 FAIL**。
已改成**不钉死具体条数**：
```js
const minExpected = CORPUS_PRODUCERS.reduce((n, r) => n + (Number(r.min) || 0), 0);   // = 46
check(`语料条数 ≥ 登记下限 ${minExpected}（不钉死具体条数）`, entries.length >= minExpected);
```
在 503 条的副本上实测：`OK 语料条数 ≥ 登记下限 46（不钉死具体条数） 实际 503` ✓（覆盖审计仍单独断言 ok）。

## §3 ① `/api/coach` 真 HTTP：**部分推进**（未完成，如实登记）

我用**自己的入口**（`scripts/roco/verify-coach-http.mjs`，配方照 `tests/server.test.js:12-18`）：

| 步骤 | 读数 |
|---|---|
| 自建引擎（`createRocoService`，不碰 8765） | `startBattle.ok=true`、真公开面 15 键 |
| 进程内 coach server `listen(0)` | `http://127.0.0.1:10197` |
| `GET /api/bootstrap` | **200**，csrf ✓，`configured=false` |
| RSA-OAEP `POST /api/connect` | **200**（`configured:true, provider:"deepseek"`） |
| 第一次 `POST /api/coach` | **200**（`provider:"local"`、`route:"strategist"`、text 26 字）—— 但**没配模型**时走本地，`planActions` 调用 **0** 次 |
| 配好模型后再 `POST /api/coach` | **502** `{"error":"DeepSeek 未返回有效正文"}` —— **我的假模型协议写错**（`tools=0`，我回的是 OpenAI 风格 `tool_calls`，而本仓是 **JSON-in-content**：`{"tool":"<名>","args":{…}}`／`{"stop":true}`） |
| 桥侧 `planActions` 调用次数 | **0**（所以 HTTP 体里自然没有 `opponent_scenarios`） |

**卡在哪一步**：`/api/coach` 的**取证阶段**才向模型要工具决策（提示里讲怎么挑工具），我还没把假模型这一段对齐
（含「什么时候进入取证阶段、系统提示里那句触发词是什么」——我在 `src/` 里 grep「选择只读工具」**0 命中**，
说明该串来自拼装或另一处）；因此**尚未拿到**「200 + `executeTool(plan_actions)` 真跑通 + 真 HTTP 体带
`opponent_scenarios`」的读数。**我不主张这一条**。下一步只需把假模型改成 JSON-in-content 协议再跑一次
（脚本已就绪，改一行响应即可）。

**自曝一处我自己的事故（已修复）**：我用 PowerShell `Set-Content -Encoding utf8` 改这个探针的一行文案，
把 UTF-8 中文**重编码成乱码**（`鎷夸笉鍒扮湡鍏紑闈?`），Node 直接 SyntaxError —— 这正是我自己记过的
「**绝不用 PowerShell 改文本文件**」。已用 write 工具按 UTF-8 重写并恢复；仓库里那份现在正确。

## §4 未完成（下一轮）

- **② `d4cdef8` 文本整刀**（真源→产物链 7634e910、alias 0/14 负结果、`knowledge.test.js` 两条改钉只换词）——
  本轮**未做**。
- **③ 三个判据修复**（`56c517e` `node --check` + `d3b03db` 四条解封 + `global_skill_mods` 行为零变化）——
  本轮**未做**。
- **① 收尾**：把假模型协议换成 JSON-in-content（见 §3）。

## §5 复跑

```powershell
$env:ROCO_PYTHON="C:\Users\ASUS\AppData\Local\Programs\Python\Python310\python.exe"
node E:\roco-coach\scripts\roco\verify-coach-http.mjs          # ①（当前到 502 那一步）
wsl -d Ubuntu-22.04 -- bash /mnt/e/roco-scratch/vfy-o53-mutate.sh {mutate|restore}   # O-53 变异
node E:\roco-coach\scripts\roco\verify-text-vocab.mjs          # 器材（已改成下限断言）
```
