# 独立复验：文本口径批次（harness-verifier）· **合格 + 2 条范围外发现**

**被验版本**：`git archive 9b43bc1` → `E:\roco-scratch\verify-text`（3533 文件）。冻结 sha16：

| 文件 | sha16 | 备注 |
|---|---|---|
| `src/game/engine.js` | `8ae4e3c8f826539f` | d02635c 后未再变 |
| `src/game/rules.js` | `8f5247d0b8d7a8dd` | 同上 |
| `src/game/content.js` | `7634e9109f82526f` | c397527 改的 |
| `tests/roco-player-text-gate.test.js` | `469d01d4fa810b5a` | 含第 5 类 `retired-unit` |
| `tests/rules.test.js` | `3e1dfc48fe1521a1` | 4 条改钉 |
| `reports/.../crosscut/player-text-corpus.mjs` | `a45f67e1b5025018` | 语料 230 |

⚠ **在飞态另记**：工作树里 `src/game/content.js`=`25ba50b0…`、`data/roco/derived/tactic-cards.json`、`knowledge/semantic-corpus.json`、`player-text-corpus.mjs`、`src/coach/rag-index.js` **都有未提交改动**（plan00-closer）⇒ 本报告结论**只对上面这份 `9b43bc1` 成立**。

---

## §0 判定

| # | 判据 | 判定 | 一句话依据 |
|---|---|---|---|
| 1 | 口径落地：语料里退役词为 0 | **合格（限已审范围）** | 230 条语料里 `HP/生命/豆` **0 命中**；`血/血量` 67 条、`能量` 64 条 |
| 1b | `keywords` 4 处是有意保留的别名 | **合格** | content.js：`生命` 0 · `HP` 0 · **`豆` 4**，全部在**行 27** 的 `"keywords"` 串里 |
| 1c | 无语义漂移 | **合格（未发现）** | 残留处指的都是同一个「血量/能量」概念，没有把别的概念硬套成「血」 |
| 2 | 门禁第 5 类有牙 | **合格** | 变异 ⇒ 必红（给用例名 + 命中原文）；不改 ⇒ 绿 |
| 3 | 语料审计不可绕过（O-44） | **合格** | 三条各红；控件绿 |
| 4 | 真源→派生产物漂移（O-49） | **确认存在**（判据如实红） | HEAD 上 `content.js 7634e910` vs 产物 `de9638ec` ⇒ 两条判据红 |

**两条范围外发现**（不算本次冻结件的缺陷，但要登记）：见 §1.3（`src/client/**` 30 处退役词且不在门禁视野）与 §5（工作树仍在漂移）。

---

## §1 ① 口径落地

### 1.1 已审范围（真渲染语料，230 条）
```
node scripts/roco/verify-text-vocab.mjs
  语料条目 = 230 | 失败渲染器 = 0 | 覆盖审计 ok = true
  按 API：reviewMatch×33 · rulesSections×79 · skillLesson×… · makeQuiz×… · practiceQuestion×15 …
  **玩家可见正文明细命中 = 0 处**（HP / 生命 / 豆）
  含「血/血量」的条目 = 67 | 含「能量」的条目 = 64   ⇒ 不是空语料造成的假 0
```
⇒ 门禁扫的是**真渲染**（`collectCorpus()`，进程内真引擎、不绑端口），不是 grep 源码 —— 这条我在 §2 用变异反证了。

### 1.2 `keywords` 别名（有意保留）
```
src/game/content.js（7634e910）：生命 0 处 · HP 0 处 · 豆 **4 处**
  4 处全在同一行（第 27 行 TACTIC_CARDS 数组）的 "keywords":"…" 串里
  样例：\"keywords\":\"残血 秒掉 收尾 溢出 火花 追猎\" ⇒ 是**检索别名**，不是行文
⇒ 与裁决一致：别名保留、且**不出现**在玩家可见正文里（§1.1 的 0 命中即证据）
```

### 1.3 ⚠ 范围外发现：`src/client/**` 仍有 30 处退役词，且不在门禁视野
```
src/client/app.js        10 处   例：app.js:191 `<span>生命 ${p.maxHp}</span>`（面板属性名，按裁决应为「血量」）
                                  app.js:335 `${s.cost} 豆`（技能消耗单位）· app.js:398 `${q.hp}/${q.maxHp} HP · ${q.energy} 能量`
src/client/roco.js        9 处   例：roco.js:471 `['hp','生命']`（STAT_FIELDS）· roco.js:753 `<span>生命</span>`
                                  roco.js:1562 `HP ${hp}` · roco.js:2299 `生命 ${pet.hp} / ${pet.max_hp}`
src/client/box.js         5 处   例：box.js:737 `STAT_LABELS = {hp:'生命', …}`
src/client/xiaoya.js      3 处   例：xiaoya.js:1227 「按当前生命、能量和队伍比这一手」
src/client/box-drawer.js  2 处   box-drawer.js:49 `STAT_ORDER = [['hp','生命'], …]`
src/client/box-loadout.js 1 处
合计 30 处
```
**为什么这不算本次冻结件的缺陷**：`player-text-audit.md:133` **自己写明**了这一块**未覆盖**：
「`src/client/**` 的 DOM 文案（浏览器侧拼串）…」列在未覆盖清单里。语料生产者（`collectCorpus` 的 `imp()`）只含
`src/game/*` 与 `src/coach/*` 九个模块，**没有 `src/client/**`** ⇒ 第 5 类门禁**结构上看不到**面板文案。
**但请裁决时注意**：这批的判据原文是「面板/属性名用**血量**…退役词应为 0」，而面板文案恰恰在未覆盖那半边
（`生命` 作属性名、`豆` 作能量单位），⇒ 建议要么把 client DOM 文案纳入语料/门禁，要么在报告里把「0」明确标成
**「已审范围（game/coach 渲染器）内为 0」**。**我没有改任何东西**，等你裁决。

**语义漂移**：我把残留处逐条看了上下文，**没有发现**「生命」被用来指别的概念（都是 HP 属性本身，只是用了退役词）；
`豆` 也都是能量单位。⇒ 本项**未发现**语义漂移（若有，我会按你要求报你）。

---

## §2 ② 门禁第 5 类真有牙（我自己做的变异）

```
控制（不改）⇒ node --test --test-concurrency=1 tests/roco-player-text-gate.test.js
  exit=0  # tests 6 · pass 6 · fail 0（绿）
变异（**只改字符串/模板字面量**，跳过注释）：
  src/game/rules.js  ' 能量'  ⇒ ' 豆'          （rulesSections 渲染串）
  src/game/engine.js `的血量` ⇒ `的生命量`      （skillLesson(drain) 渲染串）
  ⇒ exit=1 · fail 1 · **失败用例名**：
     「④ 渲染语料里不许有：长浮点 / 脏值 / 内部 ID / 内部术语 / 退役单位词」
     AssertionError: 玩家可见文本命中门禁 **25 条**，逐条给出 API@文件 + 命中词 + 原文，例如：
       skillLesson(drain)@teacher.js:116 ⇒ retired-unit 命中「生命」：「生息藤」是草系技能，消耗 2 能量…吸取实际伤害 40% 的生命量。
       rulesSections@rules.js ⇒ retired-unit 命中「豆」：蓄势：普通系 · 消耗 2 豆 · 无直接伤害 …
还原 ⇒ engine=8ae4e3c8f826539f · rules=8f5247d0b8d7a8dd，门禁 exit=0 绿
```
**附带反证（我自己先踩的坑，值得记）**：我第一版变异改的是**注释**里的「血/能量」⇒ 门禁**照样绿**。
这恰好证明它**不是 grep 源码**的工具（注释不进正文），也说明变异必须打在真的渲染串上。

---

## §3 ③ 语料审计不可绕过（O-44）

直接驱动导出的 `auditProducerCoverage({entries, attempted})`（18 登记 + 7 可选 + 31 attempted）：
```
控件（真语料）          ⇒ ok=true · missing=0 · unregistered=0
① 已登记生产者静默 0 条  ⇒ 抹掉 reviewMatch 全部条目 ⇒ ok=false · missing=[{api:"reviewMatch",min:1,got:0}]
② 新增渲染调用不登记     ⇒ attempted 里加 brandNewRenderer ⇒ ok=false · unregistered=["brandNewRenderer"]
③ 只登记不渲染           ⇒ reviewMatch 的 min 抬到 999（实际 33）⇒ 不足项=[{api:"reviewMatch",min:999,got:33}]
```
CLI 侧（`player-text-corpus.mjs` 主入口）在 `strict:true` 下审计不过就**抛错 + exitCode=1**（我读到实现，
并在真语料上确认 `coverage.ok=true` ⇒ 当前为绿）。⇒ **三条绕过路径各有读数，器材不可绕过**。

---

## §4 ④ 真源→派生产物漂移（O-49）

```
各 commit 的 content.js sha16 vs 产物 source_sha256：
  d02635c  content=de9638ec  artifact=de9638ec  一致=YES
  c397527  content=7634e910  artifact=de9638ec  **一致=NO**   ← 漂移从这里开始
  9b43bc1  content=7634e910  artifact=de9638ec  **一致=NO**
  HEAD(898f731) content=7634e910  artifact=de9638ec  **一致=NO**   ← 已登记的 O-49
  工作树   content=25ba50b0  artifact=7634e910  **一致=NO**（产物刚被刷到上一版真源，真源又变了）
```
**两条判据确实红**（我在 `9b43bc1` 副本上跑，Node 侧）：
```
tests/roco-rag-tactic-cards.test.js  ⇒ exit=1
   红：✖ 判据③（漂移守卫）：产物记的 source_sha256 == 当前 content.js 的 sha
tests/knowledge.test.js              ⇒ exit=1
```
⇒ 与 O-49 的登记一致：**改真源必须同刀刷产物**，判据抓住了。
**待办（我下次复核）**：plan00-closer 跑完生成器后，请点名我做「回绿 + 产物 diff 只有文案与 sha」那一轮。

---

## §5 诚实边界

- **在飞态**：工作树里 5 个相关文件有未提交改动 ⇒ 本报告不代表工作树现状；`rag-index.js` legacy 别名表我**没有**验。
- **范围**：我把「语料/门禁」的判据验透了，但 §1.3 的 client 面板文案**不在**该门禁视野内（审计文档自己写了未覆盖）。
- **子集口径（O-42）**：Node 侧我只跑了 `roco-player-text-gate.test.js`（6/6）、`roco-rag-tactic-cards.test.js`、
  `knowledge.test.js`、以及语料器材探针；**没有**跑全量 Node 套件；Python 侧本轮未跑（文本口径不涉及引擎 Python）。
  `--test-concurrency=1` 已按你的口径使用。
- 我踩的两个坑（都自己纠正了）：① 在 WSL 里调 `node`（Permission denied）⇒ Node 一律在 Windows 侧跑；
  ② 变异第一版打在注释上（门禁正确地保持绿）⇒ 改为打在渲染串上。

## §6 复跑

```powershell
git archive 9b43bc1 | tar -x -C E:\roco-scratch\verify-text
node E:\roco-coach\scripts\roco\verify-text-vocab.mjs        # 语料 0 命中 + 审计三条 + 漂移
node --test --test-concurrency=1 tests/roco-player-text-gate.test.js
node --test --test-concurrency=1 tests/roco-rag-tactic-cards.test.js
# 变异：E:\roco-scratch\vfy-text-mutate2.sh {mutate|restore}
```
