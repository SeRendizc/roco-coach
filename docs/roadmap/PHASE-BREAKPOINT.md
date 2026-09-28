# 阶段断点（2026-09-29 01:45 → 阶段 2 起点）

> Codex 即时监工确认：上一阶段（近期双优先级）目标已标记完成，团队全部 inactive，后台任务全部结束。
> 本文件是**阶段 2 的起点快照**，供上下文不足时交接接续。

## 1. 现在的真实状态（实测，非叙述）

| 项 | 值 |
|---|---|
| **HEAD** | `e5b71d2` |
| 演示服务 | 8765 在跑，`box.html` **HTTP 200** |
| 健康检查 | **降级**（http / data / engine / sprite 全绿，**只有云端模型未连**）—— 这是**用户配置依赖**，记录并继续独立工作，不据此停摆 |
| 浏览器锁 | 空闲 |
| 未提交 | 只有 Codex 自己的巡检文件 `长线计划与监工规则.md` + 两个 report JSON |
| 契约 | `structure-contract 28/28`、`plain-speak 12/12`、`state-doc 7/7`、`server 25/25` |

## 2. 上一阶段已完成并取证的（**不要重复做**）

- **立绘**：官方图优先（539 官方 + 3 策展，那 3 只抓包确实没有）；两档尺寸
  `thumb/` 256px + `battle/` 512px（战斗页 `img.naturalWidth=512` 实测）；手机 390×844 不溢出；
  千棘盔两形态 sha256 不同。**`battle/` 93MB 未进仓库**（回落链保证缺它不坏）。
- **B 段**：基础可玩 **542/542**（引擎侧 + HTTP 入口侧），**精确失败 ID 0 条**；
  机制核验单独一列（引擎已实现 **8/542**、**实机核验 0/542**）。
  绞轮负能耗炸局已修（**缺口计数 1→2，只增不减**）。
- **信任修复**：A7 刷新真的改屏幕数值 + 一处真值（本机记录）；小芽知道我在看谁、同一份配置、可见历史；
  **培养→战斗查实**：技能通（542/542 配招传递），性格/资质**不进**（引擎无 `nature`/`talent`）。
- **界面机制标记**：机制没实现的那一手，玩家点之前看得见（不动 `legal_actions` 语义）。

## 3. 阶段 2 的四条分发（写域互不重叠）

| 谁 | 做什么 | 写域要点 |
|---|---|---|
| `coach-context` | **A**：P0-01 —— 无模型密钥仍能走**服务端真实资料工具**；能力状态与模型状态分开；失败说明缺哪项 | `src/client/xiaoya.js`、`src/coach/client.js`、`src/coach/runtime.js`、`src/server/**`（**只读优先**）、`tests/roco-*xiaoya*` |
| `build-snapshot` | **B**：完整**迪莫 6×4** 任务与配置链路（锁定迪莫、六只各四技能合法、建议有依据、应用/撤销/再读取一致） | `src/client/box.js`、`src/client/team-workshop.js`、`src/coach/**`、`tests/roco-box-*` |
| `battle-smoke` | **C**：旧 `#actions` 与 b3 **实时配招一致**（换技能后不许再出现旧冻结四格） | `src/client/roco.js`、`src/server/roco-service.js`、`scripts/roco/battle-smoke*` |
| `art-finish` | **D**：独立 UI/上下文验收（六槽选中焦点、默认图鉴、手机、小芽回答层次），**只报不改已交资产** | `reports/roco/ui-context/**`、`docs/roco/review-2026-09-28/shots/ui-context/**` |

**Lead 自己**：4B 训练前置（统一训练/推理共享提示词与 token 模板、清失效 `inspect_training`、
分组数据、冻结执行级测试；**先 50–100 条真实样本可审核再扩**）、跨模块集成、
重点失败问句回归。**不自动训练 / 不下载模型 / 不新增强制模型·RAG·RL。**

## 4. 阶段 2 明确**不做**

- 不重启主服务（要新服务用独立端口 + 独立数据，主服务不受影响）；
- 不找 / 打印 / 持久化任何密钥；云端连接是**用户的配置依赖**；
- 不宣称全项目完成；不机械刷目标轮次；临近 40 轮上限时**保存交接并接续**。

## 5. 已知未完成（不在本轮范围，但别忘）

- 行动坞 `#actions` 口径不一致（已有精确复现，见台账 §十七）→ 本轮 **C** 接；
- 机制实机核验 0/542；图鉴 47 条无图；3 只继续策展；授权 UNKNOWN/REFERENCE_ONLY；
- `test:unit` 基线红 4 条：`roco-experience`（系别配色）、`model-trajectories`（双路径一致）、
  `roco-team-cards-layout`（两个视口）—— **不是本轮引入**（队友做过 baseline 对照）。

## 6. 在飞（阶段 2 进行中）—— 交接必读

### 6.1 一条**已修但未提交**的实况故障（2026-09-29 凌晨）

`src/client/team-workshop.js` 的 WIP 引用了 6 次 `SHARED_LOADOUT_SLOTS` 却**没导入**它
⇒ `ReferenceError` 抛在 `renderTeam → legalityRowHtml` ⇒ **点候选项什么都不发生、六槽永远空**。
（`art-finish` 在 D 组验收撞到，Lead 复核 + 真机实测。）

**根因**：`loadout-store.js:26` 有定义，而 `team-workshop.js:288` 只导入了另外两个。

**修复（已在工作区，8765 已生效）**：
```js
import {readSharedLoadouts, writeSharedLoadout, SHARED_LOADOUT_SLOTS} from './loadout-store.js';
```
真机复核：六槽 = `own-0001…own-0006`、全合法、互不相同 ✔。

⚠ **为什么没提交**：这个文件里同时有 `build-snapshot`（task-8）的 **+459/-12 行 WIP**，
我的改动**和他们的 WIP 在同一个 hunk 里**（`@@ -143,7 +285,12 @@`）⇒ 不能只提交我那一行。
**整文件 `git add` 会把队友在飞的改动扫进提交** —— 这个错本轮已经在 `src/server/index.js` 上犯过一次，
不再犯。⇒ **等 task-8 落地时一起提交**（提交时必须保住这一行 import）。

### 6.2 一条**待判**的改钉请求（`coach-context` 提的）

`tests/offline.test.js:158` 现在钉的是「无密钥时**不发** `/api/coach`」——
而那正是 **P0-01 要根除的行为**：不发 `/api/coach` ⇒ 服务端资料工具用不上 ⇒ 事实问落到
与洛手无关的模板。**意图（不花一个模型调用）要保留，钉子（不发请求）要换。**
Lead 正在核"服务端无凭据时是否真的 0 次云端调用"，核完再定。
