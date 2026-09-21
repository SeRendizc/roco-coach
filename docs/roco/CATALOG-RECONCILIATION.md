# RC-201 公网快照对账（BWIKI 索引页 vs 冻结目录）

产物：

| 文件 | 内容 | 入库 |
|---|---|---|
| `data/roco/live/2026-09-21/public-index.json` | 公网快照**派生结果**（计数 + 实体清单 + 抽取口径 + 抓取元数据） | ✅ 提交 |
| `reports/roco/reconciliation/catalog-reconciliation.json` | 对账报告（计数表 + 四个桶 + 口径说明 + 逐条 evidence） | ✅ 提交 |
| `data/roco/raw/extracted/live-bwiki/2026-09-21/*.html` | 三张索引页的**原始 HTML** | ❌ 忽略（`.gitignore` 第 25 行 `data/roco/raw/extracted/`） |

脚本：`scripts/roco/fetch-live-snapshot.mjs`（抓 + 抽）、`scripts/roco/reconcile-catalog.mjs`（对账）
守卫：`tests/roco-catalog-reconciliation.test.js`（8 条，已进 `test:unit`）

---

## 0. 一句话结论

**公开快照是 621 / 579 / 242；冻结目录是 622 / 824。两组数字的差全部可以指名到 id，没有一条是靠删记录凑出来的。**

| 比较组 | 冻结（声明） | 公网（声明） | 差 | 差在哪（逐条） |
|---|---|---|---|---|
| `pet` | 622 | 621 | **1** | `pet_000532`「幽影树（突变的样子）」 |
| `battle_skill` | 579 | 579 | **0** | 逐条对齐，无差异 |
| `trait` | 245 | 242 | **3** | `skill_000164`「腾挪」、`skill_000165`「保卫」、`skill_000166`「好象坏象」 |
| （文件级总称） | 824 | 579 | 245 | **不是差异，是口径**：824 = 579 战斗技能 + 245 特性；公网把特性放在**另一张页** |

`reconciled: true`（报告里带完整判据链）。

---

## 1. 怎么复跑

```bash
# 抓公网快照（会写 HTML 到忽略目录 + 派生 JSON 到 data/roco/live/<date>/）
node scripts/roco/fetch-live-snapshot.mjs

# 只校验不改写：与盘上 result 段逐字节比对
node scripts/roco/fetch-live-snapshot.mjs --check
# 确定性版本：从已落地 HTML 重抽再比对（不打网）
node scripts/roco/fetch-live-snapshot.mjs --check --offline

# 对账（读冻结目录 + 最新公网快照，写报告）
node scripts/roco/reconcile-catalog.mjs

# 判据
node --test tests/roco-catalog-reconciliation.test.js
npm run test:unit
```

退出码：

| 脚本 | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| `fetch-live-snapshot.mjs` | 三页全 `ok` | `--check` 不一致 | 仍有 `blocked`/`unparsed` 页面（**JSON 照常产出**） | 运行异常 |
| `reconcile-catalog.mjs` | `reconciled: true` | — | `reconciled: false`（**报告照常产出**） | 运行异常 |

---

## 2. 本次抓取的事实

抓取时刻（盘上这一份）：`2026-09-21T14:43:27Z`。UA 固定为
`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36`。

| 页面 | URL | http | bytes | sha256 | 页面自己声明的计数 | 抽出的卡片数 | 状态 |
|---|---|---|---|---|---|---|---|
| 精灵图鉴 | `https://wiki.biligame.com/nrc/%E7%B2%BE%E7%81%B5%E5%9B%BE%E9%89%B4` | 200 | 1 382 704 | `812f5c7dfe81d55978f89c69ba1667aedb6bb669af0468ab031fd2f00d0af107` | 621 个结果 | **621** | ok |
| 技能图鉴 | `https://wiki.biligame.com/nrc/%E6%8A%80%E8%83%BD%E5%9B%BE%E9%89%B4` | 200 | 1 575 409 | `171c0d5be2eaf354a06ea00845228a463c9c0ed513b18e3ef0be870f6a7da27a` | 579 / 579 个技能 | **579** | ok |
| 特性图鉴 | `https://wiki.biligame.com/nrc/%E7%89%B9%E6%80%A7%E5%9B%BE%E9%89%B4` | 200 | 805 953 | `0c19b59d37c62cc6f77d520a03953dbe6a06ddd985f308a39e02ea136d12afae` | 242 / 242 个特性 | **242** | ok |

**当天多次抓取（14:34 / 14:36 / 14:43 UTC）三张页的 sha256 完全相同** —— 页面字节稳定，
所以 `result` 段在多次运行之间逐字节一致。

派生 JSON 的主结果指纹：`result_sha256 = a6cbea14f4cbf256bd7ffded741c1e45673a0f775a9232b27ab21b81acc5f869`
（这是 `result` 段的内容指纹；盘上 `metadata` 段每次运行的 `fetched_at` 会变，指纹不变）。

**抽出来的计数与 621 / 579 / 242 完全一致**，且三者都与页面自己渲染的计数相等（脚本要求两个数必须相等，否则记 `unparsed`）。

交叉印证：特性页页首自己写着「收录 **242** 个公开特性 / 关联 **621** 个精灵形态」——
和另外两张页的计数一致（这份文本被抽进 `result.pages[trait-index].cross_checks`）。

### 2.1 实测到的反爬（如实记录）

**三张页不是每次都一次就 200。** 当天多次运行里实测撞到过
**精灵图鉴页连续 4 次 567 才成功**、**特性图鉴页连续 3 次 567（那一轮被正确记成 `blocked`）**。
下面是一次真实运行的 stdout（`--attempts` 默认 5，退避 2s/4s/8s/16s）：

```
[fetch] pet-index    status=ok  declared=621 entities=621 record_kind=pet_record http=200 attempts=[567,567,567,567,200] bytes=1382704 sha256=812f5c7dfe81d559
[fetch] skill-index  status=ok  declared=579 entities=579 record_kind=battle_skill http=200 attempts=[200]               bytes=1575409 sha256=171c0d5be2eaf354
[fetch] trait-index  status=ok  declared=242 entities=242 record_kind=trait_record  http=200 attempts=[200]               bytes=805953  sha256=0c19b59d37c62cc6
```

盘上这一份（14:43 UTC）三页都一次 200，`attempts` 都是 `[200]`；逐轮 http 码完整保存在
`public-index.json#metadata.pages[*].attempts` 里。**这不是「我们猜它会被拦」，是实测撞上的。**

---

## 3. 抽取口径（算数的是什么、排除了什么）

三张页都**只认页面自己渲染出来的卡片元素**（带 `data-*` id 的那个 `div`），不认链接。

| 页面 | 算作实体的元素 | id 来源 | 页面声明计数的位置 |
|---|---|---|---|
| 精灵图鉴 | `<div class="npc-card" data-id="pet_XXXXXX" …>` | `data-id`（与冻结 `pet_id` 同一命名空间） | `<div class="npc-results" role="status">621 个结果</div>` |
| 技能图鉴 | `<div class="nrc-skill-catalog-card" data-skill-catalog-id="skill_XXXXXX" …>` | `data-skill-catalog-id`（与冻结 `skill_id` 同一命名空间） | `<div class="nrc-skill-catalog-result-count" role="status">579 / 579 个技能</div>` |
| 特性图鉴 | 同时带 `nrc-skill-catalog-card` **与** `nrc-feature-catalog-card` 两个 class 的卡 | 同上 | `<div class="nrc-skill-catalog-result-count" role="status">242 / 242 个特性</div>` |

**为什么不用链接数**：技能图鉴页实测有 **593** 个唯一 `/nrc/` href，精灵页 **635** 个，特性页 **256** 个
（都记在 `result.pages[*].href_diagnostics`）。这些 href 里绝大多数是导航、`index.php?action=history`、
`特殊:贡献者`、`特殊:导出RDF`、单技能/单精灵详情页。把链接数当实体数会得到 593 而不是 579。
所以链接数只作为**诊断量**记录，计数只用卡片元素。

各页排除项（原样写进产物 `extraction_rules.per_page`）：

- 精灵页：导航/侧栏/页脚的 `/nrc/` 链接；功能链接（history / 贡献者 / 导出RDF）；CSS 与 `<script>` 内的字面量；筛选按钮（`class` 含 `npc-filter-chip`，不是 `npc-card`）。
- 技能页：特性卡（两个 class 同时出现的那种，本页不出现）；技能详情页链接；导航/历史/特殊页链接。
- 特性页：卡的持有者头像（`nrc-feature-card-owner-avatar`）不是实体；页首 hero 的「关联 621 个精灵形态」只作交叉印证，不作特性计数。

---

## 4. 可重跑与 fail-closed 方案（写进代码注释，也写在这里）

### 4.1 派生 JSON 的两段结构

```
data/roco/live/<YYYY-MM-DD>/public-index.json
├── schema_version / snapshot_date / extractor_version
├── stability_rule      ← 字节稳定性判据的原文
├── extraction_rules    ← 抽取口径（上面第 3 节）
├── result              ← **主结果**：计数 / 实体清单 / 交叉印证 / 链接诊断
└── metadata            ← **抓取元数据**：fetched_at / user_agent / http_status / bytes / sha256 /
                          每轮 attempts / HTML 落地路径 / result_sha256
```

**字节稳定性判据**：同一天重复运行，`result` 段必须逐字节相同；
`metadata` 段含 `fetched_at` 等每次都会变的值，**不参与**判据。
`metadata.result_sha256` 是 `result` 段 `JSON.stringify(…, null, 2)` 的 SHA256，一行就能验证主结果没漂。

实测（本次）：

```
result byte-identical（两次联网运行）: true
result_sha256 第一次 = a6cbea14f4cbf256bd7ffded741c1e45673a0f775a9232b27ab21b81acc5f869
result_sha256 第二次 = a6cbea14f4cbf256bd7ffded741c1e45673a0f775a9232b27ab21b81acc5f869
$ node scripts/roco/fetch-live-snapshot.mjs --check --offline   → rc=0，result 段逐字节一致
```

`--check --offline` 是**确定性**的那条证明路径：它从已落地 HTML（sha256 已固定）重抽，不依赖网络。

### 4.2 fail closed 的三道闸

1. **非 200 → `blocked`**。记 http 码、前 200 字节片段、原因；`declared_count` 记 `null`（**不是 0**），`entity_count` 记 0。
2. **抽不到声明计数，或卡片数 ≠ 声明计数 → `unparsed`** + 原因。同样不产出数字。
3. **本轮有非 ok 页面且盘上已有完整产物 → 主产物不动**，本次结果写到
   `data/roco/raw/extracted/live-bwiki/<date>/public-index.failed-<UTC>.json`（忽略目录），stderr 说明。
   —— 一次网络抖动不允许把已经对好的证据文件盖成残缺快照。

对账侧同样 fail closed：**某组对应的公网页不是 `ok` ⇒ 该组整体不做逐条比对**，
`live_count` 与 `delta` 记 `null`，只写一条 `unresolved` 诊断。
**绝不把「抓不到 242 条特性」写成「公网缺 245 条」**（这条有专门的反证，见第 8 节注入 C）。

---

## 5. 计数表（文件级与页面级并列）

报告 `count_table` 同时给「**声明数**」与「**解析数**」两列——两者不相等本身就是一条 `unresolved`。

| 层 | 来源 | 产物 | `record_kind` | 比较组 | 声明 | 解析 | 声明出处 |
|---|---|---|---|---|---|---|---|
| 文件 | `frozen_l1` | `full-catalog.json` | `pet_record + pet_form` | `pet` | 622 | 622 | `#coverage.pets_total` |
| 文件 | `frozen_l1` | `skills.json` | `frozen_skills_file_records`（= `battle_skill` + `trait_record`） | — | 824 | 824 | `#counts.total` |
| 文件 | `frozen_l1` | `skills.json` | `battle_skill` | `battle_skill` | 579 | 579 | `#counts.total - #counts.traits` |
| 文件 | `frozen_l1` | `skills.json` | `trait_record` | `trait` | 245 | 245 | `#counts.traits` |
| 页面 | `live_bwiki` | `pet-index` | `pet_record + pet_form` | `pet` | 621 | 621 | 页面自己渲染的计数 |
| 页面 | `live_bwiki` | `skill-index` | `battle_skill` | `battle_skill` | 579 | 579 | 页面自己渲染的计数 |
| 页面 | `live_bwiki` | `trait-index` | `trait_record` | `trait` | 242 | 242 | 页面自己渲染的计数 |

**`record_kind` 词表**（逐条产物只使用其中 4 个）：

| 值 | 含义 |
|---|---|
| `pet_record` | 精灵图鉴条目（基础形态） |
| `pet_form` | 精灵的形态/分支记录（首领形态、地区形态、突变的样子……） |
| `battle_skill` | 战斗技能（攻击/防御/状态） |
| `trait_record` | 特性（技能记录里 `category=特性` 的那些） |
| `skill_record` | **逐条产物里不使用**。它是 `skills.json` 的**文件级**总称（824 = 579 + 245），只在计数表里以 `frozen_skills_file_records` 出现。理由：逐条时它什么也没说清，还会与上面两个值重叠。 |

**两侧的形态标注口径不同，已在报告里显式登记**（`convention_notes`，34 条）：

- 冻结侧：`title !== name` ⇒ `pet_form`（实测 622 条里 162 条，且这 162 条的 title 全部是括号后缀，0 例外）。
- 公网侧：`data-form !== 'main'` ⇒ `pet_form`（实测 `main` 426 / `lord` 32 / `main|regional` 40 / `regional` 91 / `lord|regional` 32）。

两边一致的 587 条（161 都算形态 + 426 都算基础），**34 条只有公网侧把 `data-form` 标成非 `main`**
（例如 `pet_000199`「黑化加尔」`main|regional`、`pet_000535`「彩虹独角兽」`lord`）。
这些 id 的名字、编号、属性全部一致，**因此不算 `changed`**，只作为标注习惯差异登记。

---

## 6. 四个桶怎么读

| 桶 | 含义 | 本次规模 |
|---|---|---|
| `only_in_frozen` | 冻结目录里有、公网索引里没有（**身份按 id**） | **4** |
| `only_in_live` | 公网索引里有、冻结目录里没有 | **0** |
| `changed` | 两侧同 id 但名字或编号不一致 | **0** |
| `unresolved` | **不是第五类实体**，而是「无法判定归属 / 有歧义」的诊断项，每条必须有 `reason` | **4** |

每条都带：

- `record_kind`、`group`（比较组）、`id`、`name`、`source_scope`
- `evidence`：冻结侧是 `{file, pointer, id_field}`（例：`full-catalog.json` 的 `pets[531]`）；
  公网侧是 `{page, url, html_sha256, selector}`（例：`div.npc-card[data-id="pet_000532"]`）

### 6.1 `only_in_frozen`（4 条，逐条列出）

| id | 名字 | `record_kind` | 说明 |
|---|---|---|---|
| `pet_000532` | 幽影树（title：幽影树（突变的样子）） | `pet_form` | 冻结侧多出的那 1 条精灵记录 |
| `skill_000164` | 腾挪 | `trait_record` | game_id `200281` |
| `skill_000165` | 保卫 | `trait_record` | game_id `200282` |
| `skill_000166` | 好象坏象 | `trait_record` | game_id `200283` |

### 6.2 `changed`（0 条）

在 621 个两侧都有的精灵 id 上，名字、编号（`data-number` vs `number`）、属性
（`data-type` vs `types`，去掉「系」字后比较）**全部一致**；579 个战斗技能与 242 个特性 id 上名字也全部一致。
没有为了「看起来有差异」而放宽阈值。

### 6.3 `unresolved`（4 条）

这 4 条与上面 4 条**不是重复计数**，而是同一批 id 的**身份歧义**：
公网侧存在**同名但 id 不同**的实体，因此无法完全排除「公网把它并进了那条」的可能。

| id | 公网侧同名实体 | 为什么不能按名字对齐 |
|---|---|---|
| `pet_000532`「幽影树」 | `pet_000056`「幽影树」 | 冻结侧**本身**就有 162 条形态记录与基础记录同名 |
| `skill_000164`「腾挪」 | `skill_000134`「腾挪」 | 冻结侧技能表里 `腾挪`/`保卫`/`好象坏象` **各有两条同名不同 id 的记录**（`skill_000134`/`skill_000164` 等，两两 game_id 不同） |
| `skill_000165`「保卫」 | `skill_000135`「保卫」 | 同上 |
| `skill_000166`「好象坏象」 | `skill_000136`「好象坏象」 | 同上 |

报告把判定结果记在 `only_in_frozen`（按 id 严格判定），同时把这份不确定性显式留在 `unresolved`——
既不假装确定，也不把不确定性当成「已解释」。

另外单独有 `name_collision_diagnostics`（本次 **61 组，全部在 `pet` 组**）：公网侧同一比较组内归一化后同名但 id 不同的组
（例：`圣代甜甜` 9 个 id、`棋契陛下` 8 个、`鸭吉吉` / `鸭吉吉国王` / `晶石蜗` / `钻石蜗` 各 6 个）。
它们按 id 各自对齐，所以**不是** `unresolved`；这一段只是用来证明「按名字对齐会出错」——
如果按名字对齐，这 9 个「圣代甜甜」会变成 1 条，对账结果会凭空少 8 条。

---

## 7. 622/621 与 824/579 的差异解释（可核对）

### 7.1 824 vs 579：口径不同，不是缺数据

```
skills.json  824 条记录
  ├─ category ∈ {攻击, 防御, 状态}   579 条  ← 与公网「技能图鉴」逐条对齐（579 = 579，差 0）
  └─ category = 特性                 245 条  ← 公网放在**另一张页**「特性图鉴」（242 条）
```

核对方法（任何人在本仓库可复跑）：

```bash
node -e "const s=require('./data/roco/normalized/roco-world-s4-2026-09-10/skills.json');
const v=Object.values(s.skills); const t=v.filter(x=>x.is_trait);
console.log(v.length, t.length, v.length-t.length)"   # 824 245 579
```

`skills.json#counts` 自己就写着 `{total: 824, traits: 245}`，两者相减即 579。
对账脚本用的就是这个**声明计数**，不是从数组长度反推的。

### 7.2 622 vs 621：只差 1 条，且可指名

**冻结侧多出的那一条**：`pet_000532`

- `name` = 幽影树，`title` = **幽影树（突变的样子）**，`game_id` = 3777，`number` = 035
- 原始 Lua：`data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/Catalog.lua`
  里该条 `form="突变的样子"`、`image.illustration="PetPortrait_youlingshu.png"`

**公网侧的证据链**：

1. 精灵图鉴页一共 621 张 `npc-card`，**没有** `data-id="pet_000532"` 这张卡（实测 `grep` 0 次命中）。
2. 页面上编号 035 的卡是 `pet_000056`「幽影树」，`data-form="main"`。
3. 这张卡的 `data-search` 检索词里**含 `PetPortrait_youlingshu.png`** ——
   与冻结侧 `pet_000532` 的 `image.illustration` 是同一个文件名。
   （该卡 `data-search` 原文节选：`035 PetPortrait_youlingshu.png PetPortrait_youyingshu_shouling.png … 幽影树 幽影树`）

**能说的**：公网精灵图鉴把这张形态的立绘并进了编号 035 基础卡（`pet_000056`）的检索词与分组，
没有给它单独一张卡；冻结快照把它算成一条独立记录。差异额 = 1，落在 `pet_000532`。

**不能说的**：不能说「WIKI 删了这条记录」，也不能说「冻结侧多算了一条」。
`reconciled: true` 只表示「差异已逐条归位、每个计数差都有可核对解释」，
不表示两边的**语义粒度**已经统一（那是 RC-202 统一 `GameDataPackV2` 的事）。

### 7.3 245 vs 242：只差 3 条，全部指名的特性

| 冻结 id | 名字 | game_id | 效果（冻结侧原文节选） |
|---|---|---|---|
| `skill_000164` | 腾挪 | 200281 | 攻击技能应对 1 次后，回满能量和生命，变为棋绮后。 |
| `skill_000165` | 保卫 | 200282 | 防御技能应对 2 次后，回满能量和生命，变为棋绮后。 |
| `skill_000166` | 好象坏象 | 200283 | 状态技能应对 1 次后，回满能量和生命，变为棋绮后。 |

**公网侧的证据**：

- 特性图鉴页一共 242 张卡，`data-skill-catalog-id` 覆盖 `skill_000001`…`skill_000245`，
  **恰好缺 `skill_000164` / `skill_000165` / `skill_000166`** 这三个（其余 242 个 id 与冻结侧完全一致）。
- 这三个 `game_id`（`200281` / `200282` / `200283`）在**整页 HTML 里出现 0 次**
  （用 `String.prototype.split()` 计数，不是模糊匹配）。
- 公网侧确实有它们的基础版本：`skill_000134`「腾挪」(`200236`)、`skill_000135`「保卫」(`200237`)、
  `skill_000136`「好象坏象」(`200238`)。也就是说公网**保留了基础特性，只没有这三个条件变体**。

**能说的**：这三个 game_id 在公网特性索引里**不存在**（既没有独立卡片，也没有在别处被引用）。
**不能说的**：不能说「WIKI 把它们合并了」——索引里没有任何字段指向它们，把「不存在」解释成「合并」
需要额外证据（例如单特性详情页）。

---

## 8. 判据与必红反证

`node --test tests/roco-catalog-reconciliation.test.js` → **8 passed / 0 failed**。
判据复用 `scripts/roco/*.mjs` 的真实实现（测试与脚本各写一遍就会各自漂移）。

| # | 判据文本 | 实际值 |
|---|---|---|
| 1 | 三张页都 ok 时 `reconciled` 必须 true，四个桶要逐条给出 id | `reconciled=true`；`bucket_sizes={"only_in_frozen":4,"only_in_live":0,"changed":0,"unresolved":4}`；`only_in_frozen` = `pet_000532「幽影树」/ skill_000164「腾挪」/ skill_000165「保卫」/ skill_000166「好象坏象」` |
| 2 | ① 删掉一条公网实体 ⇒ `only_in_frozen` 必须**指名**列出它 | 删掉 `skill_000246`「抓挠」+ `pet_000004`「迪莫」后桶变成 `pet_000004 / pet_000532 / skill_000164 / skill_000165 / skill_000166 / skill_000246`；命中条目 `[{id:skill_000246,name:抓挠,kind:battle_skill},{id:pet_000004,name:迪莫,kind:pet_record}]`。同时声明 621 ≠ 解析 620 → `reconciled=false` |
| 3 | ② 快照标 blocked ⇒ `reconciled` 必须 false；完整快照 ⇒ true | 完整：`reconciled=true`；把 `trait-index` 标 `blocked`：`reconciled=false`，reason = 「公网快照被拦或未解析：trait-index=blocked（HTTP 567；…）」；`trait` delta `{"frozen_count":245,"live_count":null,"delta":null,"only_in_frozen":0}` |
| 4 | ② fail closed：被拦组不许倒进 `only_in_frozen` | 实际 0 条；反证：若把 blocked 当 0 条，会误报 **245** 条「公网缺失」 |
| 5 | ③ 名字归一化不许合并不同形态 | `normalizeName("幽影树")="幽影树"` vs `normalizeName("幽影树（突变的样子）")="幽影树(突变的样子)"` → 不相等；编码差异（`&nbsp;`、全角空格、零宽字符）必须合并 → `"迪莫"`；`skill_000134`/`skill_000164` 归一化后同名但 `entityKey` 不同 |
| 6 | ④ 计数差必须给出**非空且可核对**的解释 | `pet`：`冻结侧多出 1 条…pet_000532「幽影树」；差值 = 冻结声明 622 - 公网声明 621 = 1，与桶内条目数（1 - 0 = 1）一致。`；`trait`：提到 3 个 id。构造「冻结声明 623 / 公网 621」⇒ `delta=2` 但桶只有 1 条 ⇒ `explained=false`、`explanation=""`、`unexplained_gap.missing=1`、`reconciled=false` |
| 7 | fetch fail-closed：非 200 记 blocked 且不产出数字 | 567 ⇒ `status=blocked declared=null entities=0 reason="HTTP 567；未取到 200 响应，不产出任何计数。"` |
| 8 | fetch fail-closed：声明计数 ≠ 卡片数记 unparsed | 声明 5 / 实际 3 张卡 ⇒ `status=unparsed declared=5 entities=3`；抽不到计数 ⇒ `declared=null`（不是 0） |

### 8.1 必红反证（注入实测，不是声明）

给实现注入一个**真实的违规**，跑判据，看它会不会红；跑完无论成败都恢复并校验 SHA256。

| 注入 | 改了什么 | 判据原文 | 注入后 rc | 报错原文（节选） |
|---|---|---|---|---|
| A | `onlyInFrozen.push(entry)` → 不写进桶 | ① 桶里必须**指名**列出缺失实体 | 1（5 failed） | `AssertionError: only_in_frozen 必须包含被删掉的 skill_000246` |
| B | `notOkPages` 清空（假装没有非 ok 页面） | ② blocked ⇒ `reconciled` 必须 false | 1（2 failed） | `AssertionError: 有页面 blocked 时 reconciled 必须 false` |
| C | 去掉可比性守卫（被拦组也参与比对） | ② 被拦组不许倒进 `only_in_frozen` | 1（1 failed） | `AssertionError: 被拦的那一组不许倒进 only_in_frozen —— 「抓不到」不等于「公网没有」` |
| D | 归一化里剥掉括号后缀 | ③ 不许把两个不同形态并成一条 | 1（1 failed） | `AssertionError: 只差一个形态后缀的名字不许被归一化合并` |
| E | 解释永远写成「差值 N 条。」 | ④ 解释不了时必须是空字符串 | 1（1 failed） | `AssertionError: 桶解释不了时必须留空，不许编一句「差 2 条」把数字抄一遍` |
| F | `analyzePage` 把 `blocked` 写成 `ok` | fetch 非 200 必须记 blocked | 1（1 failed） | `AssertionError: Expected values to be strictly equal` |

恢复后复跑：`rc=0`，`ℹ tests 8 / ℹ pass 8 / ℹ fail 0`，两个脚本文件 SHA256 与注入前一致。

> 诚实的边角：注入 A 同时弄红了判据 ② 与 ④。原因是桶是它们的前置输入（②断言桶里不许有被拦组、
> ④从桶里取 id 写解释），桶一空就连带失败。这不是误报，但说明**这 6 条判据不是完全正交的**。

---

## 9. 这次对账**还不足以**让 `GameDataPackV2` 变成 `ready`

本次只交付「对账」这一半。`GameDataPackV2` 要从 `draft` 变 `ready`，至少还缺下面这些。
（每一条都写明「缺什么」和「怎么算做完」，不含糊地表态。）

| # | 缺什么 | 现状 | 算做完的标准 |
|---|---|---|---|
| 1 | **统一 schema** | 现在是三份不同形状的产物：`full-catalog.json`（`pets[]`）、`skills.json`（`skills{}` 字典，特性混在里面）、`public-index.json`（三张页各自的 `entities[]`）。没有一份能把「精灵 / 形态 / 战斗技能 / 特性」放进同一命名空间的契约。 | 出一份带 `$schema` / 版本号 / 字段级必填与可空声明的 `GameDataPackV2` schema；`record_kind` 词表（本报告第 5 节）进 schema 的 enum；用同一份校验器同时校验冻结产物与派生快照。 |
| 2 | **许可（license）逐条落到实体** | `sources.yaml` 里主快照是 `CC-BY-NC-SA-4.0` / `DERIVE_WITH_ATTRIBUTION_NONCOMMERCIAL`，另外两个是 `REFERENCE_ONLY`；但具体到**某一条实体**（例：`pet_000532` 只有主快照一个来源）没有机器可读的许可字段。 | 数据包里每条（至少每个 `source_scope`）带 `license` + `redistribution`；`REFERENCE_ONLY` 的来源**不得**进入任何可分发产物；用一个守卫把「REFERENCE_ONLY 出现在公开数据包」变成红。 |
| 3 | **逐实体 provenance** | 冻结侧目前是**层内统一**的 provenance（每只都指向同一个 `rocom-wiki-data` 快照 + sha256），不是按实体记录「这一条来自哪份快照的哪一行」。公网侧这次做到了逐条（`file`+`pointer` / `page`+`url`+`html_sha256`+`selector`），两边粒度不对等。 | 冻结侧也补到 `{source_id, artifact_path, artifact_sha256, pointer}` 的逐条粒度；两份产物用同一套 provenance 结构。 |
| 4 | **冲突处理策略** | 现在只有 `conflicts.jsonl` 与「不合并、如实记」的纪律，没有可执行的仲裁规则（谁赢、什么时候必须 fail closed、什么时候只标注）。本次的 `unresolved` 就是这类问题的现成样本（4 条同名不同 id 的歧义）。 | 写明冲突分类与判定（`IDENTITY_CONFLICT` / `VALUE_CONFLICT` / `GRANULARITY_CONFLICT`），并让数据包生成器在冲突未解决时**拒绝**产出 `ready`，而不是默默取一边。 |
| 5 | **形态（`pet_form`）口径统一** | 本次实测：两侧对「这条算不算形态」有 **34 条**标注不一致（第 5 节 `convention_notes`）。差异不影响名字/编号/属性，但会影响任何按形态做的特征工程。 | 定一份两侧都能映射到同一个「形态轴」（基础 / 首领 / 地区 / 突变 / 其它）的对照表，并把 34 条不一致逐条落表。 |
| 6 | **覆盖证明（不只是计数）** | 本次证明了「计数差 = 4 条可指名实体」，但没证明「同 id 的**内容**一致」——只比了名字、编号、属性标签。种族值、可学技能、效果文本都没比。 | 把两份产物在**字段级**比一遍（带容差与「快照没有这个字段」的显式分支），逐字段给出覆盖率与冲突数。 |
| 7 | **版本/新鲜度字段** | 冻结侧有 `ruleset_id` + `revision`；公网侧现在有 `snapshot_date` + `result_sha256`。两者之间没有「这份公网快照对应哪个 ruleset / 哪个赛季」的显式绑定。 | 数据包带 `ruleset_id` 与 `as_of`；跨来源的时间一致性可用守卫检查（例：公网快照日期必须晚于冻结 revision 日期，否则标 `STALE`）。 |
| 8 | **不可得字段的显式清单** | 冻结侧已有 `unknown_fields`（`traits` / `skill_timing` / `panel_formula` / `season_strength` 全部 622/622 为 unknown），公网索引页**根本没有这些字段**（它是导航页，不是数据导出）。 | 数据包显式声明「本包含什么、不含什么」并在消费侧 fail closed（`docs/roco/FULL-CATALOG.md` 已有 `claims.is / is_not` 的先例，把它提成契约级字段）。 |
| 9 | **对账自动化进闸门** | 本次是手工触发脚本。 | 把 `fetch --check --offline` + `reconcile` + 判据进 `verify-release.mjs` 的登记表（**本轮没有动 `verify-release.mjs`**，这是刻意的：该文件由主线程串行维护）。 |

---

## 10. 没做到 / 有风险（如实）

1. **公网索引页不是数据导出，只是导航页。** 三张页只给「卡片 + id + 名字 + 标签」。
   种族值、可学技能、效果数值**在索引页里没有**，所以本次对账**没有**校验字段级数值一致性
   （第 9 节第 6 条）。凡是「公网页面能核对」的说法，都仅限 id / 名字 / 编号 / 属性标签。
2. **反爬是真实存在的，不是假想。** 精灵图鉴页实测连续 4 次 567 才成功；另一轮特性页连续 3 次 567。
   默认重试 5 次仍可能整轮失败——那种情况下脚本会记 `blocked` 并在**不覆盖已有完整产物**的前提下
   写一份 `public-index.failed-<UTC>.json`。**代价**：`blocked` 会让 `reconciled=false`，
   这是有意的（宁可说「没对上」也不说「已对账」）。
3. **HTML 落在 `data/roco/raw/extracted/live-bwiki/`，不是任务示例里的 `data/roco/raw/live/`。**
   原因：`.gitignore` 只忽略 `data/roco/raw/extracted/`（第 25 行），
   而本任务允许改动的文件清单**不含 `.gitignore`**，所以刻意复用已有忽略规则。
   已用 `git check-ignore -v` 确认：`.gitignore:25:data/roco/raw/extracted/ … → rc=0`。
4. **`unresolved` = 4 不是「4 条没解决」，是 4 条身份歧义。** 判定结果已在 `only_in_frozen` 里给出，
   `unresolved` 保留的是「公网存在同名不同 id 实体」这一不确定性。读报告时不要把两者相加。
5. **`skill_000164/165/166` 为什么在公网不存在，只有否证没有正证。** 我能证明它们在这三张页里
   0 次出现，**不能**证明 WIKI 是有意合并还是尚未收录。第 7.3 节已按这个限度措辞。
6. **`name_collision_diagnostics` 有 61 组，报告体积 60 KB。** 这是刻意保留的原始信息
   （它证明「按名字对齐」是错的），不是噪声；如需精简可按需过滤，但**不建议**在生成侧丢弃。
7. **本次没有碰**：`src/**`、`roco/src/**`、`docs/roadmap/**`、`data/roco/evidence/**`、
   `data/roco/rulesets/**`、`data/roco/normalized/**`（冻结目录只读）、`verify-release.mjs`。
   没有 `git add`，没有 commit，没有生成任何轨迹 / SFT / 模型产物。
8. **没有向 `data/roco/sources.yaml` 追加来源条目——这是刻意的，不是漏了。**
   任务是「可选」，而追加一条来源会**弄红一条现有判据**，那条判据所在的文件不在本次允许改动的清单里：

   ```
   $ node -e "…parseSources(现在)…"                → 现在 parseSources 条数 = 4
   $ node -e "…parseSources(追加一条来源后)…"       → 追加后 parseSources 条数 = 5
   tests/evals/provenance.test.js:22  assert.equal(report.sources.length, 4, 'sources: 节里应当是 4 条来源')
   tests/evals/provenance.test.js:31  assert.equal(sources.length, 4)
   ```

   `parseSources()` 按 `role` 字段筛选中来源条目，所以任何新来源都会被计入这 4。
   本次允许改动的文件只有 4 项交付物 + `package.json` 的 `test:unit` 行 +（可选）`sources.yaml`，
   **不含** `tests/evals/provenance.test.js`。与其偷偷动一条别人的判据，不如把这件事写在这里：

   - 本次公网快照的**全部出处**已经在 `data/roco/live/2026-09-21/public-index.json#metadata.pages`
     （url / http_status / bytes / sha256 / fetched_at / user_agent / extractor_version）
     与 `reports/roco/reconciliation/catalog-reconciliation.json#inputs.live`（含 `page_sha256`）里，
     取证能力没有因为缺这一条而下降。
   - 接手的人若要把它登记进 `sources.yaml`，需要**同时**把 `tests/evals/provenance.test.js` 的
     4 → 5 改掉（并说明新增的是哪一条）。建议的条目字段：
     `source_id: wiki-nrc-live-index-2026-09-21` / `role: public_index_snapshot` /
     `kind: live_web_index` / `revision_kind: content_addressed` /
     `revision: "sha256:<三张页 sha256 拼接>"` / `snapshot_date: "2026-09-21"` /
     `derived_artifact: data/roco/live/2026-09-21/public-index.json` /
     `license: REFERENCE_ONLY` / `redistribution: REFERENCE_ONLY` /
     `verification_status: reconciled_against_frozen_l1`。
     注意本文件规则 2 要求「固定 revision，不得写『最新』」——公网页没有 commit SHA，
     用页面内容的 SHA256 当 revision 是满足这条规则**意图**的做法（固定、可复现、可核对）。

### 10.9 许可与再分发：已随快照一起登记（本轮补上）

上面第 8 条说的是「没有往 `sources.yaml` 追加**新来源**」。**许可登记本身不能省** ——
复核这份对账的第一个人会问「这份公网内容是什么许可、能不能再分发」。所以本轮补上的是：

- `data/roco/live/2026-09-21/public-index.json#metadata.licence`：
  `basis: SAME_SITE_AS_REGISTERED_SOURCE` / `source_id: wiki-rocom-snapshot` /
  `license: CC-BY-NC-SA-4.0` / `redistribution: DERIVE_WITH_ATTRIBUTION_NONCOMMERCIAL` /
  `license_evidence: data/roco/raw/extracted/rocom-wiki-data/LICENSE` /
  `fetched_content_committed_to_git: false`。
  **值是从 `sources.yaml` 搬运的，不是新发明的**：抓的是**同一个站点**（`wiki.biligame.com/nrc`），
  而该站点内容的许可登记在 `wiki-rocom-snapshot` 那一条上。`basis_note` 里明写
  「本仓库**没有**在站点页面上独立取证」——不把推断说成取证。
- `reports/roco/reconciliation/catalog-reconciliation.json`：顶层 `licence_ok`，
  且 `inputs.live.licence` 与快照**逐字一致**（一处事实，两个读者）。
  `licence_ok` 与 `reconciled` **刻意分开**：对账能不能做，与内容能不能再分发，是两件事。
- 判据（`tests/roco-catalog-reconciliation.test.js`，本轮 8 → **10** 条）：
  快照许可必须登记且与 `sources.yaml` 逐字一致；`license_evidence` 指向的文件必须真实存在；
  HTML 落地路径必须落在被忽略的 `raw/extracted/` 下。**必红反证**（实测）：
  抹掉许可 → `metadata.licence 缺失…`；把再分发改成 `UNLIMITED` →
  `与 sources.yaml 的 DERIVE_WITH_ATTRIBUTION_NONCOMMERCIAL 不一致`；
  证据指向不存在的文件 → `指向的文件不存在`；把 HTML 路径挪出忽略目录 → `不在被忽略的 raw/extracted/ 下`。

**仍然不改 `sources.yaml`**（理由同上一条 8）；如果接手的人要新增来源条目，
建议的字段与本轮采到的许可值就是上面这些。
