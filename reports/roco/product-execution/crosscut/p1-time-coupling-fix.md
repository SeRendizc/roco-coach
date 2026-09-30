# P1 时间耦合修复：`companion-contextual` + `companion`（task-49）

- 执行者：`plan02-front` · 2026-10-01 · **未入库**（等 Lead 提交）
- 派发包：[`DISPATCH-P1-time-coupling.md`](file:///E:/agent-coop/verification/DISPATCH-P1-time-coupling.md)（lead-mac）
- 检测命令（等同验收）：`node E:\agent-coop\comms\tz-stability-check.mjs --product E:\roco-coach --file tests/<x>.test.js`（四时区各跑一次，读数不一致 ⇒ exit 1）
- 裁决：**D-31 选 (A)** —— 保留「深夜那支」的刻意产品行为，**不改产品代码**，判据侧显式注入固定时刻

## 0. 一页结论

| 项 | 文件 1 `tests/roco-companion-contextual.test.js` | 文件 2 `tests/companion.test.js` |
|---|---|---|
| 修法 | 用派发包自带的 `p1-tz-fix.py`：`Date.parse('…Z')` → `new Date(2026,8,21,22,0,0).getTime()`（**按本地字段构造**） | 5 个读点显式注入固定时刻：`REPLAY_NOW=atClock(22)` + `companionEvents/coachContext/proactiveText` 的 `now` |
| 四时区（修前） | **FAIL**：Shanghai 16/0 · **Kiritimati 13/3** · LA 16/0 · UTC 16/0 | **FAIL**：**Shanghai 86/4** · Kiritimati 90/0 · LA 90/0 · UTC 90/0 |
| 四时区（修后） | **OK**：16/0 / 16/0 / 16/0 / 16/0 | **OK**：89/1 ×4（唯一那条红是**并发的产品改动**，见 §5） |
| 三态 | **FAIL → OK → FAIL → OK（定稿）**，0 残留 | 变异：把注入改回墙钟 ⇒ **FAIL**（Shanghai 87/3 vs UTC 90/0），还原后 sha 逐位相同 |
| D-31 | — | **两向都有断言**：深夜（`atClock(2,10)`）⇒ 必须说「这么晚了。」+「到这儿也行」且**不许劝睡**；白天（`atClock(15,30)`）⇒ 同一个输入**一个字都不说** |

**根因（一句话）**：探针层 `companionEvents(game,{…})` 的 `now` 默认 `Date.now()` —— 回放上下文用了固定钟（`REPLAY_NOW`），**探针层却用挂钟** ⇒ 凌晨跑时 D-31 的 `late-night` 被提议并挤掉高光/血皮那一句（`priority:91`）。

## 1. 文件 1（三态实测，逐态读数）

```
python3 E:\agent-coop\verification\patches\p1-tz-fix.py --product E:\roco-coach --check|--apply|--revert
```
| 态 | 命令 | 读数 |
|---|---|---|
| ① 修前 | `tz-stability-check` | **FAIL**：16/0 · **13/3** · 16/0 · 16/0 |
| ② `--check` | patch 工具 | `锚点找到`（未改文件，exit 0） |
| ③ `--apply` | patch 工具 | 已应用；`L23: const NOW = new Date(2026, 8, 21, 22, 0, 0).getTime();` |
| ④ 修后 | `tz-stability-check` | **OK**：16/0 ×4（exit 0） |
| ⑤ `--revert` | patch 工具 | 已回滚 |
| ⑥ 回滚后 | `tz-stability-check` | **FAIL**（复现原缺陷） |
| ⑦ 再 `--apply` | 定稿 | **OK**：16/0 ×4 |

⇒ 与 lead-mac 的「FAIL → OK → FAIL（0 残留）」一致，并额外补了第 ⑦ 步（定稿态）。
- 只改了**这一个文件的一行**（`tests/roco-companion-contextual.test.js:23`）；未动产品代码。

## 2. 文件 2（裁决 A：注入固定时刻，不改产品）

**5 个读点 + 我按同因补的调用点**（全部是「把 `now` 显式传进去」，没有一处改语义）：

| 位置 | 改法 |
|---|---|
| `:94` `REPLAY_NOW` | `const REPLAY_NOW=(()=>{const d=new Date();d.setHours(22,0,0,0);return d.getTime();})();` → **`const REPLAY_NOW=atClock(22);`**（`atClock` 是文件里**已有**的固定本地时刻构造器：`new Date(2026,8,day,h,m,0,0).getTime()`）。旧写法逐字留档在注释里 |
| `:104`（`replay()` 内探针） | `companionEvents(g,{…,signals:context.signals})` → 追加 **`,now:REPLAY_NOW`**（**这是主因**：回放上下文用固定钟、探针层却用挂钟） |
| `:452-463`（7 处） | 每个 `companionEvents(…)` 追加 `now:REPLAY_NOW`；`:467` 的 `coachContext(g,newProfile(),history([…]))` 补第 4 参 `REPLAY_NOW`；`:468` 的提议调用补 `now` |
| `:492-493` | 同因（探针层挂钟）：`coachContext(g,profile,memory,REPLAY_NOW)` + `companionEvents(…,now:REPLAY_NOW)` —— 两侧**同一把钟**，保住「提议了就必须说得出来」这条不变式 |
| `:508/:513` | 同上（`ctx` 注入 `REPLAY_NOW` + 提议注入 `now`） |
| `:689` + test680 的 `proactiveText` 第 4 参 | `companionLedger({},null,Date.now())` → `(…,REPLAY_NOW)`；`proactiveText(event,bare,register)` → 追加 `,{now:REPLAY_NOW}`；'unknown-event' 那条同样补 |
| **新增（D-31 两向）** | 深夜 `atClock(2,10)`：`proactiveText('late-night',bare,'R4',{now:night})` **必须有话说**、含「这么晚了。」与「到这儿也行」、**不许出现劝睡词**；白天 `atClock(15,30)`：同一输入 **返回 null** |

- 既有的「半夜还在打」那条（`:1783`，用 `atClock(2,10)` + 白天 15:30 反向 + 陈旧记录反向）**原样保留**，它本来就是两向的；本刀只是让**其它**读点不再靠墙钟。
- **没有**改任何产品判定（`companion.js` 一行未动）。

## 3. 读数汇总（before → after）

| 文件 | 修前（四时区） | 修后（四时区） |
|---|---|---|
| `tests/roco-companion-contextual.test.js` | 16/0 · **13/3** · 16/0 · 16/0 ⇒ FAIL | **16/0 ×4 ⇒ OK** |
| `tests/companion.test.js` | **86/4** · 90/0 · 90/0 · 90/0 ⇒ FAIL | **89/1 ×4 ⇒ OK** |

修前那 4 条红（只在 Asia/Shanghai，因为当时本机≈凌晨 5:30）：`each companion event fires once per match…`（`actual: ['late-night']`）· `the proactive path stays silent…`（`late-night 在没有真实素材时不该说话`）· `moment 1 highlight`（`实际说了：late-night:0:0、soak:烬尾狐、milestone:冠军高地`）· `moment 3 clutch`（`实际说了：late-night:0:0、faint:烬尾狐:5、blunder…`）⇒ 全是同一根因（探针层挂钟 ⇒ D-31 的 late-night 挤掉场景句）。

## 4. 变异（验收 ③）

脚本 `E:\roco-scratch\t49-mutate.mjs`：把 `replay()` 里那一处 `now:REPLAY_NOW` 改回挂钟依赖（不动 `REPLAY_NOW` 本身 ⇒ 复原"上下文固定钟 + 探针挂钟"的原始缺陷形态）：
```
变异后 tz-stability-check：Shanghai 87/3 · Kiritimati 89/1 · LA 89/1 · UTC 90/0  ⇒ FAIL ✓
还原：文件 sha256 前16 回到 9fbe9c5ce51a2c32（与变异前逐位相同）
```
⇒ 「改回挂钟 ⇒ 必 FAIL」成立。

## 5. ⚠ 中途发现的那条红已被 owner 修好（记录在案）

修完注入后、跑完整套件之前，`tests/companion.test.js` 曾有 **1 条红**（四时区一致，89/1 ×4 ⇒ 不影响时区稳定性）：
```
✖ companion facts degrade to null instead of default values            (tests/companion.test.js:260)
actual 第 4 项 = facts.result = undefined（应为 null）
```
**归因（三条实测）**：① 该用例隔离单跑也红；② 产品直探 `companionFacts(freshMemory(),{mode:'camp'},Date.now())` 返回 `result: undefined`；
③ `src/coach/companion.js` 当时 `git status = M`、mtime 05:36:45（晚于我 05:30 的基线）⇒ **并发改动所致，不是本刀**（本刀一行产品代码未动）。
**结局**：05:53 复跑 `tests/companion.test.js` = **90/90 全绿** ⇒ 该并发回归已被它的 owner 修掉。

## 6. `npm run test:unit`（验收 ②）

```
npm run test:unit ⇒ exit 1 · 2059 tests · 1958 pass · 79 fail · 22 skip · 474s
失败文件 26 个
```
| 对照 | 文件数 | tests | fail | 失败文件 |
|---|---|---|---|---|
| task-39 基线（05:05，HEAD `26b5518`） | — | 1994 | 87 | 30 |
| 本刀（05:45–05:53） | — | 2059 | **79** | **26** |

- **本刀的两个文件都不在红名单里**（`tests/companion.test.js` 现在 90/90；`tests/roco-companion-contextual.test.js` 16/16 ×4 时区）⇒ **不新增红**；
- 红总数 87 → 79、失败文件 30 → 26：期间有并发修复（含 Lead 修的语法错误/weather-pvp、以及上面那条 `companionFacts`），**不是本刀的成绩**，如实并列；
- ⚠ **同期他人改动带来的新红（与本刀无关，登记）**：`tests/coach.test.js`（strategist 落点）· `tests/roco-answer-level-correction.test.js`（③ sha256 回归钉）· `tests/offline.test.js`（**见 §7**）。

## 7. ⛔ 本刀之外的一处**我自己**造成的附带红：`tests/offline.test.js`（task-43 漏网，需裁决）

```
tests/offline.test.js ⇒ exit 1 · 8 tests · 7 pass · 1 fail
✖ the rules page can be read without opening the coach, and in-battle cards explain skills in place
  AssertionError: actual: 'import {observe,…'   expected: /消耗 \$\{sk\.cost\} 豆/
```
- 这条判据**钉的是 `src/client/app.js` 的源码串**「`消耗 ${sk.cost} 豆`」，而我在 **task-43** 里按口径把它改成了「`消耗 ${sk.cost} 能量`」⇒ 判据没跟着改钉。
- **证据**：`tests/offline.test.js` **不在** task-39 基线（05:05）的 30 个失败文件里 ⇒ 那时它是绿的；task-43 于 05:2x 入库（`c5cf648`）⇒ 之后变红。
- **我 task-43 的 17 文件判据批没有覆盖到它**（那批是"引用 client 文件 + 含退役词"的交集，`offline.test.js` 恰好不在交集里）——这是我的漏项，如实登记；本刀已把 **整个 `tests/**` + `scripts/**`** 扫了一遍"钉住我改过的字面量"的地方，**只有这一处**硬钉。
- **建议的最小改钉（按规矩：原断言逐字留档 + 只换标签 + 两向变异）**：
  ```js
  // 2026-10-01（task-43 文本口径 S4）改钉：出招面板的消耗单位 `豆` ⇒ `能量`（原断言逐字留档在文件内）
  assert.match(app,/消耗 \$\{sk\.cost\} 能量/,'出招按钮必须内联消耗');
  ```
  语义不变（仍是「出招按钮必须内联消耗」）；变异：把 `app.js` 换回 `豆` ⇒ 本条必红。
- **写域**：`tests/offline.test.js` **不在 task-49 写域**（task-49 只含两个 companion 文件 + `crosscut/`）⇒ **等你批准**；批一句我就改（含两向变异读数），或你转给该文件 owner。

## 8. 冻结

| 文件 | sha256 前16 | 字节 |
|---|---|---|
| `tests/roco-companion-contextual.test.js` | `6903ff2d33d115c2` | 18157 |
| `tests/companion.test.js` | `9fbe9c5ce51a2c32` | 199015 |

- 产物：本文件 + `reports/roco/product-execution/crosscut/`（新增 1 个 md）。
- 未跑 git 写命令；**未改任何产品代码**；未动 `package.json` / `data/**`；未启动服务。
- 口径（O-42）：本刀声称的绿 = ① 两个文件四时区读数一致（16/0 ×4、89/1→90/0 ×4）；② `test:unit` 里这两个文件不新增红。**不**声称 `test:unit` 全绿。
