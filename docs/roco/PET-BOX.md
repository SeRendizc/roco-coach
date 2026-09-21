# 精灵盒子：我的 / 全图鉴（RC-205）

这一页讲清楚四件事：

1. **页面结构**：两个主标签、搜索、筛选、分页、个体详情、两个个体比较；
2. **路由契约**：`GET /api/roco/box` 的四种模式、参数白名单、错误码；
3. **玩家层与工程层的分界**：什么进玩家区、什么只进默认收起的开发者抽屉；
4. **能显示什么、不能显示什么**：622 里只有 48 只有配招与种族值，养成效果一律 UNKNOWN。

页面文件：`src/client/box.html` / `box.js` / `box.css`（`box.css` 只放本页差异，
框架样式先加载 `src/client/style.css`）。URL 是 `/box.html`（`PAGE_ALIASES` 里的短路径，
和 `/roco.html` 一样属于对外契约）。路由实现：`src/server/roco-service.js` 的 `box()`
（GET 只读的先例来自同文件的 `roster()`），接线在 `src/server/index.js`。

---

## 1. 页面结构

```text
小芽 · 精灵盒子  [数据快照 S4] [重置筛选] [关于这一页（来源与快照）]   ← 抽屉默认收起
──────────────────────────────────────────────────────────────────
[ 我的盒子 80 ] [ 全图鉴 622 ]                                      ← 两个主标签
──────────────────────────────────────────────────────────────────
[搜索名字] [系别 ▾] [定位 ▾] [支持等级 ▾] [只看收藏] [只看锁定]  …计数
──────────────────────────────────────────────────────────────────
[卡片] [卡片] [卡片] …                                              ← 每页 24 张
                          [加入比较] / [详情 ▸]
──────────────────────────────────────────────────────────────────
[上一页] 1 / 4 [下一页]

选两只同种伙伴 → [比较这两只]  →  逐字段：相同 / 不同 / 未知
点卡片 → 右侧个体详情抽屉（等级 / 性格 / 资质 / 特长 / 血脉 / 四个有序技能）
```

* **卡片首层只有**：自制头像符号（系别 emoji + 底色）、名字、系别，
  以及有就用、没有就不印的：形态标记、定位、支持等级、（我的盒子里）等级与收藏/锁定。
* **个体详情抽屉**：等级 / 性格 / 资质 / 特长 / 血脉 / 四个有序技能，
  外加「效果未校准」的玩家可读说明。没有取值的栏目写「本仓库没有这一项」。
* **两个个体比较**：先选两只**同种**个体，再逐字段给「相同 / 不同 / 未知」；
  未知必须说清为什么（哪一侧没登记 + 养成效果未校准）。
  不同种在页面上会被直接劝住，路由也会 400。
* 390px 无横向溢出；页面上每一个可点元素（按钮 / summary / 输入框）都 ≥44×44。

筛选菜单刻意用页内折叠按钮组而不是原生 `<select>`：原生下拉在无头浏览器里打不开也按不动，
那样「筛选」这一条就写不出**真实键鼠**判据（训练场页踩过同一个坑）。

---

## 2. 路由契约：`GET /api/roco/box`

只读、公开数据、**不需要 CSRF**（与 `GET /api/roco/roster` 同一条先例）。
它读的是磁盘上的冻结产物，**不经过 Python**：规则服务没起来也照样能查盒子。
状态码取自回执本身（非法参数就是 400），这是与 `roster()` 唯一的一处行为差别。

### 参数（白名单，别的键一律 400）

| 参数 | 取值 | 说明 |
|---|---|---|
| `kind` | `catalog` / `mine` | 两种列表模式，二选一 |
| `q` | ≤40 字 | 名字 / 称号 / 类别 / 编号的子串（catalog）；物种名的子串（mine） |
| `type` | 系别词表里的值（如 `草系`） | 数据里出现过的系别，别的取值 400 |
| `role` | `attacker` / `tank` / `recovery` / `control` / `support` | 定位（登记层标注，只有 48 只有） |
| `support` | 支持等级词表（当前只有 `KNOWLEDGE_ONLY`） | 同上，只有 48 只有 |
| `record_kind` | `pet_record` / `pet_form` | 精灵 / 形态 |
| `favourite` / `locked` | `true` / `false` | 仅 `kind=mine` |
| `species_id` | `pet_` + 6 位数字 | 仅 `kind=mine` |
| `offset` | 十进制非负整数，≤100000 | 分页 |
| `limit` | 十进制整数，1..60（默认 24） | 分页 |
| `detail` | `pet_000000` 或 `own-0000` | 单实体详情（与 `kind`/`compare` 互斥） |
| `compare` | `own-0001,own-0002` | 两个**同种**个体的逐字段比较（与 `kind`/`detail` 互斥） |

**没有任何一步是「容错」**：`limit=1e3` / `-1` / `1.5` / `abc` 都是 400（**不静默取整**），
`limit=61` 也是 400（不夹紧），白名单外的键点名拒绝（不静默忽略），
`kind` / `detail` / `compare` 同时出现也是 400。

### 返回

```text
成功：200 { ok:true, status:200, mode:'catalog'|'mine'|'detail'|'compare', player:{…}, dev:{…} }
参数错：400 { ok:false, status:400, error:'…（点名是哪个参数、实际值是什么）' }
找不到：404 { ok:false, status:404, error:'找不到这个精灵或个体：…' }
读盘失败：500 { ok:false, status:500, error:'精灵盒子数据读取失败：…' }
```

`player` 是玩家层，`dev` 是工程层——两段**同一次查询一起回**，页面把 `dev` 塞进默认收起的抽屉。
`compare` 两个不同种返回 `400`，理由来自 `scripts/roco/owned-pets-lib.mjs` 的
`OwnedPetSpeciesMismatchError`：路由不另写一套「哪些字段算同种」。

---

## 3. 玩家层 / 工程层的分界

| 玩家层（`player`，屏幕上看得见） | 工程层（`dev`，只在默认收起的抽屉里） |
|---|---|
| 显示名、别名、系别、形态标记 | `pet_id` / `species_id` / `record_kind` |
| 定位 / 支持等级的**中文标签** | 定位 token（`attacker`）、支持等级枚举（`KNOWLEDGE_ONLY`） |
| 种族值（迁移层 48 只）、四个技能 | `refs` 指针、`skills_source`、`build_hash` |
| 等级、个体属性、收藏 / 锁定 | `provenance` / `source_scope` / `licence_ref` |
| 「本仓库没有这一项」「效果未校准」 | `unknown_fields` / `coverage` / `state_version` / `dataset_hash` |
| 页面内部选择用的 `select` / `group` | 原始查询参数与原始比较器回执（`compare_raw`） |

两条机械判据把这条分界钉住（实现只有一份，
在 `scripts/roco/browser-box-acceptance.mjs` 里，单测直接 import 它）：

* `playerLayerProblems()`：`player` 段里不许出现工程键，也不许出现 id 形状的**展示值**
  （`select` / `group` 这两个「页面内部选择键」是唯一例外，它们不出现在屏幕上）；
* `FORBIDDEN_PLAYER`：玩家可见**文本**里不许出现
  `pet_id` / `state_version` / `coverage` / `provenance` / `unknown_fields` / 裸 JSON。

开发者抽屉展开后必须**真的**能看到 `provenance` / `unknown_fields` / `state_version` /
`coverage` / 许可——「藏起来」不等于「删掉」：要核对的时候得核得动。

---

## 4. 能显示什么、不能显示什么

数据事实（只读，见 `docs/roco/GAME-DATA-PACK.md` 与 `docs/roco/OWNED-PETS.md`）：

```text
pack.json            622 条 pet 实体（460 精灵 + 162 形态）——只有 refs 与逐实体 provenance，
                     **没有面板数值**
full-catalog.json    622 条都带静态种族值与可学技能表（族群值，不是等级换算后的面板）
roster-48.json       48 只迁移层：配招（四个技能）+ 种族值 + 定位 + 速度档
owned-pets.json      80 个 owned 个体：等级 / 四个有序技能 / 收藏 / 锁定；
                     性格 / 资质 / 特长 / 血脉**取值一律没有登记**（血脉 12 只 baseline 例外），
                     面板数值 `panel_stats` 全为 null
```

所以盒子里的规则是：

* **`kind=catalog` 的总数必须是 622**，不是 48。48 只迁移层只体现为一个覆盖数字
  （`dev.coverage.with_moveset_layer`）与「哪些条目点开有配招」。
* **有配招与数值的 48 只**才显示种族值与四个技能；其余 574 条点开详情就写
  「本仓库没有这一项：这只精灵不在有配招与数值的 48 只迁移层里」。
* **面板数值（等级换算后）本仓库一条都没有**：`panel.available === false`，
  页面上写「换算公式未校准」，**不给伪精确的成品数值**。
* **没给威力的技能**显示「本仓库没有这一项」，**绝不补 0**。
* **养成效果一律 UNKNOWN**：性格 / 资质 / 特长 / 血脉只是标签，
  比较里未知的那几栏必须带上「养成效果未校准」这句说明。
* **图片 / 向量素材没做**：卡片上是自制 emoji + 色块（按主系别），不是官方美术，
  也没有做素材缓存或向量检索。

### 已知缺口（如实列）

* 622 里只有 48 只有配招与种族值可展示；其余只有名字、系别、形态与索引字段。
* 162 条形态（`pet_form`）与所属精灵的展示名靠 `title` 区分（如「鸭吉吉（蓬松的样子）」）。
* 比较只覆盖 `compareOwnedPets` 的八个字段（等级 / 性格 / 资质 / 特长 / 血脉 / 技能 / 收藏 / 锁定）；
  面板、队伍影响与战力差**没有**可比的数据，页面上也不假装有。
* 「可模拟程度」目前只有登记层给的那一档（`KNOWLEDGE_ONLY`），
  还没有接 RC-403 的 Capability Compiler——那一档接上之后筛选词表会自动多出新的等级。

---

## 5. 怎么跑判据

```bash
node --test tests/roco-box.test.js                 # 路由契约 / 参数白名单 / 玩家层，含 6 条必红反证
npm run roco:box-acceptance                        # 浏览器验收（真实键鼠 + 两档截图 + 机器可读报告）
node --test tests/evals/structure-contract.test.js # 页面 / 白名单 / 相对 import 的结构契约
```

产物：

| 文件 | 是什么 |
|---|---|
| `reports/roco/box-acceptance/browser-box-acceptance.json` | 逐条判据：判据文本 + **实际值原文** + 截图名 + 两档 `clientW/scrollW` |
| `reports/roco/box-acceptance/box-0*.png` | 1440×900 与 390×844 两档截图（我的盒子 / 全图鉴 / 搜索 / 详情 / 比较） |

反证方向（每条判据都有一条，报告里贴实际命中原文）：

| 反证 | 同一条判据必须报出 |
|---|---|
| 把 `pet_id` 放进玩家层卡片 | `玩家层出现工程键 cards[0].pet_id` |
| 把 `unknown_fields` 混进玩家字段 | `玩家层出现工程键 cards[0].unknown_fields` |
| `compare` 接受不同种（200） | `不同种比较必须 HTTP 400 + ok:false` + `必须给出「不是同一种」的原因` |
| 非法 `limit=1e3` 被静默取整 | `静默取整：接受了 limit="1e3" 并返回 limit=1` |
| 把 catalog 总数写成 48 | `catalog 总数必须 == 622，实际 48` |
| 把工程词写进卡片渲染函数 | `box.js 的玩家区代码里出现工程词「provenance」` |
