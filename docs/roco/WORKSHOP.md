# WORKSHOP —— RC-305 六槽阵容工作台（数据契约 + 可挂载模块）

> 路由：`GET /api/roco/workshop`（`src/server/roco-service.js` 的 `workshop()`，只读、无 CSRF、**不经 Python**）
> 模块：`src/client/team-workshop.js`（`mountTeamWorkshop(rootEl, opts)`，纯原生 ES module）
> 产品页挂载点：`src/client/roco.html` 的 `#team-workshop`
> 开发夹具：`src/client/workshop.html` + `src/client/workshop-fixture.js`（薄壳，**不是产品页**）
> 浏览器验收：`scripts/roco/browser-workshop-acceptance.mjs` → `reports/roco/workshop-acceptance/`
> 单测：`tests/roco-workshop.test.js`（13 组，含 12 条必红反证）
> 上游：RC-301 `src/coach/team-request.js`、RC-302 `src/coach/team-gaps.js`、
> RC-303 `src/coach/team-candidates.mjs`、RC-304 `src/coach/team-compare.mjs`
> 设计依据：`/tmp/roco-coach-handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md` §2/§5/§6；
> 版式依据：`docs/roco/ui-mockup-six-slot.html`（定稿 mockup）

---

## 0. 一句话

**这是产品页 `roco.html` 上的「选阵容」工作台**：六个槽位、候选池是全量图鉴、
选 2～5 只时常驻给「缺口 + 恰好三个下一只候选 + 取舍」，选满六只给五轴与一个最小替换。
它**不另写一套评价**——所有判断都来自 `GET /api/roco/workshop`，而那条路由内部直接调
RC-301 合同 → RC-302 七维缺口 → RC-303 候选生成 → RC-304 环境先验/五轴。

---

## 1. 页面结构（模块渲染的 DOM）

模块把整块版式渲染到 `#team-workshop` **自己的 shadow root** 里，宿主页的 CSS/DOM 不被改写。
四块区域（`.tw-` 前缀）：

| 区域 | class | 内容 |
|---|---|---|
| 队伍 | `.tw-team` | 六个槽位（`.tw-slot`）、三枚徽记、「只看收藏 / 最多替换 / 清空阵容」 |
| 候选池 | `.tw-cand` | 全量图鉴搜索 + 分页 + 列表（`.tw-row`，标「已拥有 / 图鉴条目」） |
| 阵容评估 | `.tw-eval` | 0～1 只=体系入口；2～5 只=缺口口径 + 恰好三个下一只；6 只=五轴 + 一个最小替换 + 未知清单 |
| Coach | `.tw-coach` | **选阵容阶段的短结论**（下一步做什么 / 为什么 / 代价） |

桌面端栅格：`[队伍 | 候选池] [评估 | Coach]`（`grid-template-columns:repeat(4,1fr)`，各占两列）。
移动端（≤620px）单列，DOM 顺序即视觉顺序：
**队伍槽位 → 候选池 → 当前评估 → Coach 短提示**（有机器判据）。

### 与 mockup 的对应关系

| mockup 里定的 | 本模块落在哪 |
|---|---|
| 六个槽位（不是「已选 3 只固定栏」） | `.tw-team` 的六个 `.tw-slot`，判据钉 `data-tw-slots == 6` |
| 三枚徽记：标准 PVP · 六宠 / 候选规则（待实机核对）/ 匹配前对手未知 | `.tw-badges` 里逐字渲染，文本来自服务端的 `WORKSHOP_BADGES`（**只有一份**） |
| 候选入口是全量 600+ | `.tw-cand` 读 `GET /api/roco/box?kind=catalog`（622 条），判据钉 `≥600` 且 `> 已有个体数` |
| 「推荐下一只」三个候选 + 取舍标签 | `.tw-eval` 的 `.tw-card[data-tw-next]`，标签「强度 / 稳定 / 偏好保留」 |
| 选满六只后的「环境价值 / 最差体系 / 容错 / 最小替换」 | `.tw-eval` 的 `.tw-axis`（五轴）+ `#tw-replacement` |
| 工程字段只在默认折叠的开发者抽屉 | **不在这里**：本模块的可见文本一个工程词都没有；工程回执在路由的 `dev` 段，挂在 `#team-workshop` 的 `data-tw-payload` **属性**上（不在可见文本里） |

---

## 2. 路由契约

`GET /api/roco/workshop?mode=&selected=&locked=&must_include=&must_exclude=&favourites_only=&max_replacements=&stage=`

* `stage=first` 只跑**初判**那一段（召回 + 缺口 + 槽位/候选/Coach 摘要），
  `axes` 是 `null`、`axes_status` 是 `'not_requested'`；省略或 `stage=full` 是今天的完整载荷；
* 白名单外的键、形状不对的 id、非十进制整数的 `max_replacements`、`stage` 取别的值 → **400 + 点名**（`ok:false`）；
* 再把参数交给 RC-301 `validateRecommendationRequest()` 做**合同层**校验（模式 / 槽位数 / 约束矛盾），
  失败同样 400，错误文本就是 RC-301 的 `[CODE] field：detail` 原话；
* 状态码取自回执（与 RC-205 盒子同一条先例）。

回执形状（`ok:true` 时）：

```text
{ ok, status, schema:'roco-workshop/v1', mode_id, badges,
  request,                       // RC-301 校验并规范化后的请求
  player,                        // 玩家层：名字 / 系别 / 取舍标签 / 玩家可读的未知说明
  dev,                           // 工程层：pet_id / instance_id / confidence / provenance / unknown_reason / ranker_status / ruleset
  candidates, next_candidates, entrance_candidates,
  axes, replacement, structure, constraints, team_members, facts,
  gaps_by_team, gaps_error, axes_status, selection_mode }
```

### 五种形态

| 已选 | 回执关键字段 | 口径（13 号文档 §6） |
|---:|---|---|
| 0 | `player.entrance` + `entrance_candidates`（3 只参考） | 体系入口；`next_candidates` 是**空**（0～1 只没有「下一只」这件事） |
| 1 | 同上 | 说明这一只可承担多个职能，不锁死答案 |
| 2～5 | `player.next_candidates`（**恰好 3**）+ `gap_dimension_notes` / `unknown_dimension_notes` | 强度 / 稳定 / 偏好保留三种取舍；已在队里的个体与物种**不再推荐** |
| 6 | `axes`（5 条）+ `replacement`（**恰好一个**） | 能算的算；算不出的 `available:false` + `value:null` + `unknown_reason` |

**下一只候选的两条产品口径**（都在路由里，页面不重算）：

1. 已经在队里的个体 / 物种不再推荐（玩家刚点进去的那只又出现在「推荐下一只」里是明显的错）；
2. 去重或回落导致凑不满三个时，**不在页面层补假候选**：从同一份 RC-303 召回池补位，
   并如实标 `source:'recall_tail'`、`tradeoff_label:'候选参考'`。

### 参数示例

```bash
curl 'http://127.0.0.1:8765/api/roco/workshop?selected=own-0001,own-0002'
curl 'http://127.0.0.1:8765/api/roco/workshop?selected=own-0001,own-0002,own-0003,own-0004,own-0005,own-0006'
curl 'http://127.0.0.1:8765/api/roco/workshop?mode=zzz'          # → 400，点名 mode
curl 'http://127.0.0.1:8765/api/roco/workshop?zzz=1'             # → 400，点名 zzz
```

---

## 3. 两层分界

| 只允许出现在 `player`（玩家读得到） | 只允许出现在 `dev` / `data-tw-payload` |
|---|---|
| 名字、系别、取舍标签（强度 / 稳定 / 偏好保留 / 候选参考） | `pet_id` / `species_id` / `instance_id` / `candidate_key` |
| 「现在算不出来」「台账里标未核实」「未产出」 | `confidence` / `unknown_reason` / `unverified` / `machine_evidence` |
| 缺口**口径名**（属性覆盖 / 速度层次 / 能量曲线 / 应对手段 / 换入换出 / 队内互补 / 资源消耗） | `gaps_by_team`（RC-302 原始诊断，含成员键与系数） |
| 最小替换的**名字**与结构理由 | 最小替换的原始 `why`（里有 `instance:` / `catalog:` 键）与 `evidence` |
| 相对分（带上「0～1 的序数标度，不是胜率」的量纲说明） | `ranker_status` / `ruleset_config_id` / `gates` / `provenance` / `coverage` |
| **机制行** `mechanism.line`（冻结 `desc` 原文，逐字）与 `mechanism.tags` 的标签名 | `mechanism.status` 枚举原文（`FROZEN_DESC` / `MECHANISM_UNCONFIRMED`）、`tags[].skills` 计数 |

判据：
* `playerLayerProblems()`：遍历 `player` 段，按键名与 id 形状两条抓违规；
* 模块的**可见文本**（shadow root 去掉 `<style>/<script>` 之后）不许出现
  `pet_id|instance_id|state_version|coverage|provenance|unknown_fields|ranker_status|ruleset|{…}|"x":`；
* 工程回执挂在 `#team-workshop` 的 `data-tw-payload` 属性上——**属性不是可见文本**，
  本机测试读它，页面永远不渲染它。

---

## 4. 现在还是 unknown 的轴，以及为什么

`data/roco/meta-prior/v1.json` 的 `distribution_source = "unknown"`、每条 `distribution[].value = null`，
所以 RC-304 的**前四轴**现在都无定义（`available:false`、`value:null`、`unknown_reason` 点名缺什么）：

| 轴 | 现在的状态 | 为什么 | 需要什么才能算 |
|---|---|---|---|
| 环境价值（`expected_meta_value`） | unknown | 缺版本对手分布：没有真实对局数据，分母不存在 | 逐体系占比 + 逐体系相对表现（离线联赛 / matchup bank 产物） |
| 最怕的体系 | unknown | 同上 | 同上 |
| 对局离散度 | unknown | 同上 | 同上 |
| 操作容错 | unknown | 缺可复跑的对局采样（`distribution[].tolerance`） | 离线回放 / 联赛产物 |
| 覆盖置信 | **能算**（例如 `0.851852`，`confidence=COMMUNITY_CURRENT`） | 它只依赖队里已有的构建与结构事实，**不依赖对手分布** | —— |

覆盖置信的 `value` 是 `(criterion + evidence + build_data) / 3` 三个可复算因子的均值，
`unit` 明写「相对分（0～1 的序数标度，不预测胜负）」。
**它不是实力判断**：它描述的是「我们自己知道多少」。

因此：**选满六只时，工坊能给的完整评估实际只有「覆盖置信 + 结构理由 + 一个最小替换」**，
其余四轴如实写「现在算不出来」并点名缺什么。**绝不给胜率、绝不给伪精确百分数**。

---

## 4b. 机制原文（冻结 `desc`）怎么上卡

数据源：`data/roco/derived/pet-mechanisms.json`（构建器与读取层共用 `src/coach/pet-mechanisms.js`
的同一份规则）。服务端在 `player` 段里**加性**给出三处 `mechanism` 字段：

| 位置 | 字段 | 空值形态 |
|---|---|---|
| `player.slots[]` | `mechanism: {line, status, name, tags}` | **空槽位是 `null`**（那里没有精灵） |
| `player.next_candidates[]` | 同上 | —— |
| `player.entrance.candidates[]` | 同上 | —— |

模块的渲染规则（`.tw-mech`，三条硬规则）：

1. `mechanism.status === 'FROZEN_DESC'` 且 `line` 非空 ⇒ 卡**首层**逐字显示这一行
   （`.tw-mech-line`，小字；**不截断**——窄屏宁可折成三行也不砍半句）；
2. 取不到 / `MECHANISM_UNCONFIRMED` / 形状不对 ⇒ 显示「机制资料待确认」；**空槽位什么都不显示**；
3. **枚举原文永不上页面**（`FROZEN_DESC` / `MECHANISM_UNCONFIRMED` 一个都不出现在可见文本里）。

`mechanism.tags` 渲染成一行「机制线索：应对 · 回能 · 印记」（只印 `tag` 名，不印 `skills` 计数）——
它是**体系线索**，不是强度排序，页面上也不能被读成排序。

**伪精确判据的豁免**：冻结 `desc` 里本来就可能有百分数（例如「入场首回合，获得物攻+100%」）。
判据不靠放宽正则，而是把**能追溯回产物**的原文换成占位符再扫：
`playerCopyProblems(text, {sourcedLines: sourcedMechanismLines(player 载荷)})`。
核不回产物的一律不豁免——把「胜率 62%」塞进 `mechanism.line` 照样判红（有必红反证）。

---

## 4c. 两阶段交付（RC-306）：初判先到，依据后补

模块**分两次问同一份数据**（不改服务端）：

```text
① GET /api/roco/workshop?...&stage=first    ← 服务端**不跑**证据段
   立刻渲染：槽位 / 下一只候选 / 缺口口径 / Coach 短结论
   （`axes:null`、`axes_status:'not_requested'`、`serving.full_withheld:'NOT_REQUESTED'`）
② GET /api/roco/workshop?...                ← 完整载荷，无条件再取一次
   **原地升级**：补上五轴 / 最小替换 / 完整依据；初判画出来的东西位置不变
```

失败方向：

* 第一次失败（400/500）⇒ 进错误态，与以前一样（`data-tw-state='bad-request'|'failed'`）；
* 第二次失败 ⇒ **只影响「依据」那一块**：`data-tw-full-state='failed'`，
  评估区如实写「这一次五个口径与最小替换没有回来；上面那些结论不受影响」，
  **已经渲染好的初判一个字都不清空**。

`serving` 信封（契约 `roco-serving/v1`）里 `full === null` + `full_withheld === 'NOT_REQUESTED'`
= **调用方主动不要证据段**；`degraded === true` 才是真的降级（超时/失败）。两者在
`data-tw-withheld` 与 `data-tw-degraded` 上分开记，页面上不混为一谈。

### dataset 钩子（全在 `#team-workshop` 的属性上，可见文本里一个都不出现）

| 属性 | 含义 |
|---|---|
| `data-tw-stage` | 最近一次渲染的阶段：`first` / `full` |
| `data-tw-fetches` | 这一轮的取数顺序，两阶段就是 `first|full`（少一个就说明初判没发） |
| `data-tw-first-ms` / `data-tw-full-ms` | 两段各自的**外部渲染耗时**（ms） |
| `data-tw-rendered-after-first` | 完整载荷到达之前槽位是否已经画出来（`yes`/`no`） |
| `data-tw-full-state` | `loading` / `ok` / `failed`（第二次请求的结局） |
| `data-tw-ready` | 两阶段都回来了（`yes`）；与 `data-tw-state` 分开，便于量测中间态 |
| `data-tw-serving` / `data-tw-degraded` / `data-tw-withheld` / `data-tw-elapsed-ms` | 服务端 `serving` 信封的可核对投影 |

---

## 5. 与主线程的挂载契约

```js
import {mountTeamWorkshop} from '/src/client/team-workshop.js';
const workshop = mountTeamWorkshop(document.getElementById('team-workshop'), {
  onTeamChange: ({team, locks, favourite, maxReplacements, coachSummary, payload}) => { /* … */ },
});
// workshop.getTeam() / getPayload() / coachSummary() / reload() / addCandidate() / destroy()
```

* 容器：`#team-workshop`（产品页 `roco.html` 里的空 `<section>`，渲染全部发生在它的 shadow root 里）；
* 事件：每次队伍变化派发 `team-workshop:change`（`bubbles:true`），`detail` 与 `onTeamChange` 同一份；
* `coachSummary()` 是**纯数据**的短结论（`phase` / `headline` / `gaps` / `unknowns` / `next_candidates` /
  `replacement` / `has_win_rate:false`）：想让别的小芽面板复用这句话就直接读它，
  **不要** import 本文件的内部函数。

### 边界（第 92 轮裁定）

* **模块内 = 选阵容阶段的 Coach 栏**（`.tw-coach`）：短结论 + 缺口口径 + 下一只候选 + 指向评估区的依据；
* **模块外 = 页头「✦ 小芽」入口与聊天/记忆抽屉**（陪练对话、偏好记忆、主动提示浮条）——
  全局的，不属于本模块：这里**没有**输入框、**没有**记忆列表、页面底部也**没有**小芽表单。
* 三个层级写清楚，避免三块重复信息：**阵容评估**=结构诊断；**Coach 栏**=短决策；
  **军师**=局中两行浮条（属对战阶段，不在本模块）。

---

## 6. 验收

```bash
node scripts/roco/browser-workshop-acceptance.mjs      # = npm run roco:workshop-acceptance
node --test tests/roco-workshop.test.js
```

浏览器验收在**产品页 `roco.html`** 上跑（真实键鼠），产物在 `reports/roco/workshop-acceptance/`：
`browser-workshop-acceptance.json` + 1440×900 / 390×844 两档截图。
判据（41 条）覆盖：产品页挂载、六个槽位、三枚徽记、候选池 ≥600（含「我没有的图鉴物种」可点）、
**两阶段交付（初判不含证据段 + 初判先于完整载荷渲染）**、
真实键鼠连续选入 2 / 5 / 6 只、评估随阵容变化、满六只五轴与一个最小替换、
**冻结机制原文逐字上卡（且枚举原文不上卡）**、玩家可见文本无工程词、无胜率与百分数、
未知说明在玩家层、非法参数一律 400、两档无横向溢出、移动端区块顺序、
390px 触控目标 ≥44px、控制台干净；另有 27 条**必红反证**
（含「把机制行从卡上抹掉 ⇒ 红」「把 `FROZEN_DESC` 印上页面 ⇒ 红」「把「胜率 62%」塞进 `mechanism.line` ⇒ 红」
「让 first 那一次也带上五轴 ⇒ 红」「把两阶段退化成一次性请求 ⇒ 红」）。

---

## 7. 明确声明：本 RC 没有把工具接进模型可见列表

**本 RC（RC-305）只交付「六槽工坊的数据契约 + 可挂载工作台模块 + 浏览器证据」，
没有把任何工具接进模型可见的工具列表。** 具体地：

* 没有改 `TOOL_CONTRACTS`；
* 没有改 `src/coach/shadow-tools.js` 的标签；
* 没有改已发布评测里的 13 个工具名与提示 SHA-256 钉子。

那三处必须**一起**改（否则模型看得到工具名却拿不到同一个合同），留给下一个 RC。

另外两条如实说明：

* RC-304 的**四轴仍 unknown**（见 §4），所以工坊在选满六只时只能给「覆盖置信 + 结构理由 + 一个最小替换」；
* `docs/roco/ui-mockup-six-slot.html` 里画的「阵容诊断」（输出核心 / 速度线 / 联防 / 高费技能）
  是**版式**，不是本 RC 的数据：本 RC 呈现的是 RC-302 的七维**口径名**与未核实标记，
  没有把七维折成一个「诊断分数」。
