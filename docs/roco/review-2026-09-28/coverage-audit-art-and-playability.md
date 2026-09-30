# 覆盖审查：已拥有基础立绘 / 完整 6×4 可玩范围 / 动作倒下不丢图

> 独立审查任务（T-y）。**只读产品**：不改 `src/`、`tests/`、`data/`，不重启 8765，不清玩家数据，不提交 git。
> 生成时间：2026-09-29T05:34:20.180Z｜真服务：`http://127.0.0.1:8765`｜HEAD：`51c04fb`
> 本文件由 `tmp/coverage-audit/make-report.mjs` 从实测 JSON 生成（数字不手抄）：
> `a-art.json` / `b-play.json` / `b-teams.json` / `c-faint.json`，脚本见 `tmp/coverage-audit/`。

## 0. 三列总表

| 机制 | 覆盖到什么程度 | 证据（命令/截图） |
|---|---|---|
| A1 已拥有**基础立绘** | **542/542 全有**（HTTP 200、PNG、>1KB；539 只 256px 抓包缩略图 + 3 只 384px 策展图） | `node tmp/coverage-audit/a-art.mjs`（EXIT=0）→ `a-art-list.txt` 逐只清单；样本图 `shots/coverage-audit/a-01-default-喵喵-256px.png` / `a-02-battle-喵喵-512px.png` |
| A2 **动作帧**（攻击/受击/倒下/技能） | **不存在**。只有 48 张策展「动作立绘」（`-action.png`，已拥有里命中 41 只）；抓包 539 只只有一张静态图（thumb/battle/original 只是三档尺寸）；客户端**已不请求**动作立绘 | 静态：`ls data/roco/assets/pets/*-action.png`=48；运行时：`c-faint.json` 每一帧 `img.src` 只有 `v=default&size=battle`；代码：`roco.js:2779/2831` 注释「舍弃动作立绘、保留动效」 |
| A3 同种多形态**是否共用一张图** | 53 族 144 只里 **1 族共用**（幽影树 / 幽影树（突变的样子）同 sha），其余 52 族各自有图 | `a-art.json.summary.families`（逐族聚类 sha256）；两张图落盘可逐字节比：`a-04-form-幽影树-基础.png` 与 `a-05-form-幽影树-突变.png`（都是 61471B / sha256 a9f6fc2d1db43ac2） |
| B1 6×4 **可玩范围**（引擎学习表口径） | **542/542**（严格＝规范四个全在引擎学习表且都有登记名，与宽松口径同数） | `node tmp/coverage-audit/b-play.mjs`（EXIT=0）→ `b-play-list.txt` 逐只判定 |
| B2 凑不出「四个合法+已登记」的分类计数 | **全 0**（no-build 0 / learnset-fail 0 / canonical-illegal 0 / unnamed 0）——但判据**不是恒真**：反证见 §2.3 | `b-play.json.summary.byKind`=`{"ok":542}` |
| B3 队伍层（六只×四招） | 三支样例队伍（冻结层 6 / 仅图鉴 6 / 混合）走 `/api/roco/workshop?stage=first`：**200 + ok + 6 槽 × 每槽 4 个技能** | `node tmp/coverage-audit/b-teams.mjs`（EXIT=0）→ `b-teams.json` |
| C1 己方倒下（HP 归零）那一刻立绘 | **保留基础图**：img.src / naturalWidth 512 / opacity 1 / 无类名变化；唯一倒下信号是飘字「倒下」；**没有倒下帧** | `node tmp/coverage-audit/c-faint.mjs`（EXIT=0）→ 截图 `shots/coverage-audit/c-01-self-faint-1440x900.png` |
| C2 对方倒下那一刻立绘 | **保留基础图**，随后（约 200ms 内）**直接换成下一只**的基础图；**没有「倒下」飘字**（全量普查 faintSelf=4 / faintFoe=0） | 截图 `c-02b-foe-hp-zero-1440x900.png` / `c-04-foe-swapped-1440x900.png`；`c-faint.json`（`floats` 全量飘字 / `engineTurns` 服务端事件） |
| C3 倒下帧 / 倒地动画 | **未实现**（无资源、无 CSS、无代码路径） | CSS 只有 `.b3-float--faint`（飘字颜色）；立绘只有 `.b3-attack` 前冲 / `.b3-hit` 抖动；无 `faint` 类 |

**未实现清单**：动作帧（攻击/受击/倒下/技能四种都没有）；倒下帧与倒地动画；对方倒下的「倒下」提示（飘字缺失，见 §3.3）。
**只在静态数据里成立、没实机核验**：B 的 542/542（引擎学习表口径，**不是**打过 542 场）；A 的 542/542（只是"这张静态图 HTTP 200"，不含任何动作/动画）；队伍层三支样例只到 `workshop` 组装，**没有**对 542 只逐一开局。

---

## 1. A｜已拥有基础立绘

### 1.1 口径（先把两件事分开）
- **基础立绘**= `GET /api/roco/sprite?id=<物种id>&v=default` 返回的那**一张静态图**（列表/详情/候选池/六槽/战斗都用它）。
- **动作帧**= 攻击 / 受击 / 倒下 / 技能 各自的**独立图**。本次逐字核对：**没有任何一套动作帧资源**（见 §1.4）。
- 「有基础图」**不等于**「动作齐」——本报告不把前者写成后者。

### 1.2 读数：542/542 有基础立绘，0 缺
- 请求口径：逐只 `id=<pet_id>&v=default`；判定＝HTTP 200 ∧ `Content-Type: image/png` ∧ PNG 魔数 ∧ 字节 > 1024。
- 缺的：**无**（[]）。
- 来源分布：{"capture-2026-09-27":539,"(无头)":3}（`X-Roco-Sprite-Source` 头；无头那 3 只是策展 48 槽：pet_000601 圣凯布米龙、pet_000608 银月狼王、pet_000611 月使鹭纳）。
- 尺寸：256px 539 只 / 384px 3 只；体积 30117B ～ 534847B。
- 战斗档（`&size=battle`）：542/542 200；服务端变体分布 {"battle":539,"(无头)":3}（539 只 512px，3 只回落到策展图）。
- 逐只清单见 **§6 附录**（`tmp/coverage-audit/a-art-list.txt` 同内容）。

### 1.3 同种多形态抽查（≥5 族，实际 8 族 41 只 + 全量 53 族普查）
「形态」= 同一基础名、不同 `title`（如「鸭吉吉（蓬松的样子）」），在数据里是**不同 pet_id**。

| 族 | 形态数 | 不同图张数 | 是否共用 |
|---|---|---|---|
| 圣代甜甜 | 9 | 9 | 否 |
| 鸭吉吉 | 6 | 6 | 否 |
| 晶石蜗 | 6 | 6 | 否 |
| 蹦蹦种子 | 4 | 4 | 否 |
| 蹦蹦草 | 4 | 4 | 否 |
| 蹦蹦花 | 4 | 4 | 否 |
| 冬羽雀 | 4 | 4 | 否 |
| 岚鸟 | 4 | 4 | 否 |

逐族聚类（sha256 前 16 位）：

- **圣代甜甜**（9 个形态）→ 9 张不同图
  - `3b8ea834e30dca77` 圣代甜甜（樱桃巧克力口味）
  - `eaa45305bf3279e0` 圣代甜甜（樱桃草莓口味）
  - `dc8cef93bb07ff8b` 圣代甜甜（樱桃抹茶口味）
  - `34de98e47e8d0512` 圣代甜甜（蓝莓巧克力口味）
  - `00c40f79700580f6` 圣代甜甜（蓝莓草莓口味）
  - `1ada7ff38307b906` 圣代甜甜（蓝莓抹茶口味）
  - `0e3da88477ecb4dc` 圣代甜甜（杨桃巧克力口味）
  - `44fa16a385f3b133` 圣代甜甜（杨桃草莓口味）
  - `9376296b9765dce1` 圣代甜甜（杨桃抹茶口味）
- **鸭吉吉**（6 个形态）→ 6 张不同图
  - `1c198f459a6d2ccb` 鸭吉吉（蓬松的样子）
  - `59342608e338e4bc` 鸭吉吉（紧实的样子）
  - `a25696e6fd32904a` 鸭吉吉（急急急鸭）
  - `5c04afa644065a96` 鸭吉吉（等一等鸭）
  - `d227c6b6f883db25` 鸭吉吉（燃了鸭）
  - `83645d32e2cbcf25` 鸭吉吉（起来鸭）
- **晶石蜗**（6 个形态）→ 6 张不同图
  - `7859498f1529c463` 晶石蜗（西瓜碧玺的样子）
  - `2f7fabe749390de6` 晶石蜗（莲花刚玉的样子）
  - `978a32920b9d799e` 晶石蜗（星彩榴石的样子）
  - `5347e53082d92147` 晶石蜗（火山琉璃的样子）
  - `84fa6a97a0306bbd` 晶石蜗（蓝锥矿的样子）
  - `8ef37bc01a3d551b` 晶石蜗（烧蓝黄金的样子）
- **蹦蹦种子**（4 个形态）→ 4 张不同图
  - `7a8ae28888053686` 蹦蹦种子（海神球形态）
  - `c345a037fca0ffa8` 蹦蹦种子（彩玉球形态）
  - `3c9a4622abfeafa8` 蹦蹦种子（短毛球形态）
  - `1b100042662508af` 蹦蹦种子（象牙球形态）
- **蹦蹦草**（4 个形态）→ 4 张不同图
  - `19209485acea13d7` 蹦蹦草（海神球形态）
  - `7b45fdc30fdb0e58` 蹦蹦草（彩玉球形态）
  - `938bd46670130f6c` 蹦蹦草（短毛球形态）
  - `5ae586b8d57f9d3d` 蹦蹦草（象牙球形态）
- **蹦蹦花**（4 个形态）→ 4 张不同图
  - `f25832a489e05e60` 蹦蹦花（海神球形态）
  - `2e1fce92401e8648` 蹦蹦花（彩玉球形态）
  - `2d1a5289624bd915` 蹦蹦花（短毛球形态）
  - `8db9f04a0ec14ca8` 蹦蹦花（象牙球形态）
- **冬羽雀**（4 个形态）→ 4 张不同图
  - `d0c54dd8339d00e2` 冬羽雀
  - `cefa7ef5acb77ab3` 冬羽雀（春天的样子）
  - `5fd8b75163ad2c9a` 冬羽雀（夏天的样子）
  - `c5e13306218c11b7` 冬羽雀（秋天的样子）
- **岚鸟**（4 个形态）→ 4 张不同图
  - `a1d9a39c0903bcc2` 岚鸟
  - `90660c2946a2c1c6` 岚鸟（春天的样子）
  - `22d15a51cdd280c0` 岚鸟（夏天的样子）
  - `63463aec526d03bc` 岚鸟（秋天的样子）

**全量普查（53 族 / 144 只）**：只有 **1 族**出现「两个形态共用同一张图」——（两张图已落盘，可直接逐字节比对：`shots/coverage-audit/a-04-form-幽影树-基础.png` 与 `a-05-form-幽影树-突变.png`，同 61471 字节 / 同 sha256）
- **幽影树**：幽影树=`a9f6fc2d1db43ac2`，幽影树（突变的样子）=`a9f6fc2d1db43ac2` ⇒ 同一个 sha，**没有各自的立绘**
其余 52 族（含圣代甜甜 ×9、鸭吉吉 ×6、晶石蜗 ×6、蹦蹦种子/草/花 ×4、冬羽雀 ×4、岚鸟 ×4）**每形态一张不同的图**。

### 1.4 动作帧：**不存在**（这是本任务最容易被一句话糊过去的地方）
三份独立证据：
1. **资源层**：`data/roco/assets/pets/` 只有 48 张 `*-default.png` + 48 张 `*-action.png`；`capture-pets/manifest.json` 的 565 条只给 `thumb_file`（256px）/ `battle_file`（512px）/ `original_file`（1024px）——**同一张静态图的三档尺寸**，手册里没有任何 attack/hit/faint 字段（`grep -i 'attack|hit|faint' manifest.json` 只命中 "attacker" 这个 role 值）。
   - 唯一的「动作」资源是策展那 48 张 `-action.png`（另一个**姿态**，不是逐动作帧）；已拥有的 542 只里只有 **41 只**能取到 `v=action`（其余 501 只 404）。
2. **代码层**：`src/client/roco.js:2779`「⚠ 2026-09-28（人类逐字：舍弃动作立绘、保留动效）：**永远只要 default 那一张**」；`b3SwapVariant()` 现在**只写 `data-b3-variant` 标记，不碰 img.src**（`roco.js:2831` 注释留档了旧实现：换 `v=action` → 404 → onerror 删 img → **立绘在出招后消失**）。
3. **运行时**：本次真实对局 28 拍、全部帧采样（`c-faint.json`）里两侧 `img.src` **始终**是 `v=default&size=battle`，`data-b3-variant` 只在 `default`/`action` 之间变成**标记**，图片本身没换、也没 404（`data-b3-sprite=ok`）。

---

## 2. B｜完整 6×4 可玩范围

### 2.1 口径（写死，可复跑）
对**全部已拥有**（542 个体 = 542 物种，1:1）逐只：
1. 取 `GET /api/roco/loadout/options?pet=<own-XXXX>` 的 `learnable[]`（**引擎自己的学习表**，与开局时 `battle/new` 校验用的是同一张）；
2. **严格口径**：owned 产物里登记的「规范四个技能」（`skills[]`，4 个）**全部**出现在 `learnable` 里，且四个都有登记名；
3. **宽松口径**：能从 `learnable` 里凑出**四个有名技能**（即这只可以换招配出合法 6×4 的一份）；
4. **队伍层**：六只**互不同种**（RC-301），走 `GET /api/roco/workshop?stage=first&selected=…` 读回执。

### 2.2 读数
- **严格：542/542**（判据：规范四个技能全部在引擎学习表里 + 四个都有登记名）
- **宽松：542/542**（判据：能从引擎学习表里凑出四个「有登记名」的技能）
- 判定分布：`{"ok":542}`
- 层归属（数据层）：`{"inLayer":530,"notInLayer":12}`（`layer-playable-48/learnsets.json` 里有条的算冻结层）

### 2.3 反证（证明上面这个 542/542 不是"恒真判据"）
把**别的物种的技能**塞进这一只的学习表判定：`own-0001`（喵喵）的学习表里**没有** `skill_000418`（取自另一只的规范配招）⇒ 判定为不合法。反证成立：外来技能被判为不在学习表里。命令：`node tmp/coverage-audit/b-teams.mjs`。

### 2.4 「凑不出」的分类计数与例子
| 类 | 计数 | 例子（各 3 个） |
|---|---|---|
| 缺配招（规范四个 ≠ 4） | 0 | 无 |
| 查不到学习表（路由失败/空表） | 0 | 无 |
| 规范技能不在学习表 | 0 | 无 |
| 四个技能有学不到的且凑不出四个合法 | 0 | 无 |
| 技能无登记名 | 0 | 无 |

**如实说明**：这四类**一个都没量到**（不是我没查，是 542 只全都通过）。所以「凑不出的物种清单」是**空集**。

### 2.5 但有一处**产品口径与数据口径不一致**（缺口，不在本任务修复范围）
| 轴 | 冻结层 530 只 | 仅图鉴 12 只 |
|---|---|---|
| `layer-playable-48/learnsets.json` 有条目 | 有 | **无** |
| owned 产物 `skills_source.artifact_path` | `layer-playable-48/support-matrix.json` | `support-matrix.json`（**顶层**） |
| owned `species_tier` | overlay | **baseline** |
| 盒子物种详情 `role_label` | 有（如「回复」） | **null** |
| 盒子物种详情 `support_label` | 「仅图鉴资料」 | 「仅图鉴资料」 ← **不区分** |
| 盒子物种详情 `role_label` | 有（如「回复」） | **null（12/12）** ← 唯一区分得开的玩家可见字段 |
| 盒子物种详情 `moveset` | 4 | 4 ← 不区分 |
| 工作台槽位 `build_tier_label` | 「有具体构建（算得出高低）」 | 「有具体构建（算得出高低）」 ← **不区分** |
| 引擎学习表 4/4 合法 | ✓ | ✓（同样通过） |

- **542 只全量普查**（`node tmp/coverage-audit/b-support.mjs`，EXIT=0）：`support_label` 分布 = {"inLayer":{"仅图鉴资料":530},"catalogOnly":{"仅图鉴资料":12}}；`role_label` 为 null 的：冻结层 0 只 / 仅图鉴 12 只；`moveset` 长度分布 = {"inLayer":{"4":530},"catalogOnly":{"4":12}}。
- 结论：玩家**看得见**的字段里只有「定位」这一栏把 12 只区分开了（显示「定位未登记」）；`support_label` 全 542 只都写「仅图鉴资料」（连冻结层的喵喵也一样），工作台的「有具体构建」对 12 只照给 ⇒ **"哪 12 只没有冻结迁移层构建"这件事在产品上是看不出来的**（数据层分得清：`species_tier` / `skills_source.artifact_path` / 层归属）。
- 12 只逐字（`b-play.json.summary.notInLayerList`）：pet_000062 音速犬、pet_000112 雪影娃娃、pet_000124 化蝶（平常的样子）、pet_000190 海豹船长、pet_000225 寂灭骨龙、pet_000417 圆号鱼、pet_000445 黑猫巫师、pet_000451 秩序鱿墨、pet_000474 画间沉铁兽、pet_000601 圣凯布米龙、pet_000608 银月狼王、pet_000611 月使鹭纳
- 命令：`node -e`（见 §5 第 6 条）。

### 2.6 队伍层实测（三支样例）
- **A-全冻结层6只**：HTTP 200、`ok=true`、`selected_count=6`、槽位 6 个，每槽四个技能名：
  - 1. 喵喵（未锁）｜抓挠、防御、仙人掌刺击、腐化｜有具体构建（算得出高低）
  - 2. 水蓝蓝（未锁）｜甩水、防御、水炮、多维击打｜有具体构建（算得出高低）
  - 3. 火花（未锁）｜火苗、防御、火云车、龙之利爪｜有具体构建（算得出高低）
  - 4. 迪莫（未锁）｜光刃、防御、棘突、抽枝｜有具体构建（算得出高低）
  - 5. 水灵（未锁）｜甩水、防御、水炮、多维击打｜有具体构建（算得出高低）
  - 6. 火神（锁定）｜火苗、防御、火云车、龙之利爪｜有具体构建（算得出高低）
- **B-全仅图鉴资料6只**：HTTP 200、`ok=true`、`selected_count=6`、槽位 6 个，每槽四个技能名：
  - 1. 音速犬（未锁）｜火苗、防御、火云车、焚烧烙印｜有具体构建（算得出高低）
  - 2. 雪影娃娃（未锁）｜风吹雪、防御、超级糖果、啮合传递｜有具体构建（算得出高低）
  - 3. 化蝶（未锁）｜蛰针、防御、打鼾、取念｜有具体构建（算得出高低）
  - 4. 海豹船长（未锁）｜气波、水泡盾、一拳、取念｜有具体构建（算得出高低）
  - 5. 寂灭骨龙（未锁）｜诡刺、龙血、坟场搏击、集中｜有具体构建（算得出高低）
  - 6. 圆号鱼（未锁）｜甩水、防御、许愿星、啮合传递｜有具体构建（算得出高低）
- **C-混合4+2**：HTTP 200、`ok=true`、`selected_count=6`、槽位 6 个，每槽四个技能名：
  - 1. 魔力猫（未锁）｜抓挠、防御、仙人掌刺击、腐化｜有具体构建（算得出高低）
  - 2. 草头鸭（锁定）｜一拳、防御、顶端优势、马步｜有具体构建（算得出高低）
  - 3. 恶魔叮（未锁）｜抓挠、防御、扇风、连续毒针｜有具体构建（算得出高低）
  - 4. 恶魔狼（未锁）｜诡刺、防御、撕裂、恶意逃离｜有具体构建（算得出高低）
  - 5. 音速犬（未锁）｜火苗、防御、火云车、焚烧烙印｜有具体构建（算得出高低）
  - 6. 雪影娃娃（未锁）｜风吹雪、防御、超级糖果、啮合传递｜有具体构建（算得出高低）

### 2.7 B 的诚实边界（不许拿它冒充"都能玩"）
- 上面全部是**引擎学习表 + 组装回执**级读数；**没有**对 542 只逐一开局（`battle/new`），**没有**逐只实机打完一场。C 只真打了 **1 场** 6×4 对局（用其中 6 只）。
- `battle/new` 用的是同一张学习表（`Ruleset.is_learnable`），所以"能开局"的概率很高，但**这是推断，不是本次量到的事实**。

---

## 3. C｜动作倒下不丢图

### 3.1 怎么量的
真 8765、1440×900、专用 profile、真对局（`?team=own-0001,own-0325,own-0327,own-0328,own-0481,own-0501`），脚本 `tmp/coverage-audit/c-faint.mjs`：
- 每拍 80ms 轮询整份战场 DOM：两侧立绘框 `data-b3-pet-id / data-b3-sprite / data-b3-variant(-now)`、`img.src / naturalWidth / opacity / visibility / transform`、HP 文本、点数、飘字；
- 另有**页面内 MutationObserver 全量记录**每一条 `.b3-float`（不靠轮询，短命元素也漏不掉）；
- 截图：开战 / 己方倒下 / 对方 HP=0 / 对方换人 / 己方补位 / 结束。

### 3.2 己方倒下（实测 4 次，逐次同一形状）
```
HP: 生命 332/332 → … → 生命 0 / 332        （HP 归零那一帧）
立绘框: class="b3-free b3-spritebox"  data-b3-pet-id="pet_000001"  data-b3-sprite="ok"
        data-b3-variant="default"  data-b3-variant-now="default"   ← 没有 faint 类
img:    src=/api/roco/sprite?id=pet_000001&name=喵喵&v=default&size=battle
        naturalWidth=512  opacity=1  visibility=visible  display=block  transform=none
飘字:   ["-40" b3-float--strong, "倒下" b3-float--faint, "未击中" b3-float--miss]
```
⇒ **保留基础图**（不是倒下帧，也不是空白）。补位之后，同一个立绘框换成新上场的**基础图**（`c-03-self-replaced-1440x900.png`）。

### 3.3 对方倒下
对方 HP 归零那一帧：`pet_000002`（水蓝蓝）`data-b3-sprite=ok`、`img.src` 仍是 `pet_000002`、`naturalWidth=512`、`opacity=1` ⇒ **保留基础图**；
**约 165–250ms 后**同一格已经变成下一只 `pet_000003`（火花，340/340）的基础图 ⇒ **没有留白、没有破图**，也**没有倒下帧**。

**缺口（如实报）**：对方倒下**没有「倒下」飘字**。全量普查（MutationObserver，28 拍）：
- 己方 `b3-float--faint` = **4**；
- 对方 `b3-float--faint` = **0**（对方卡**确实**收到飘字，共 24 条：["b3-float b3-float--shield","b3-float b3-float--hit","b3-float b3-float--weak"]）；
- 代码路径本来是通的：`env.py:1247` 对**承受伤害那一方**发 `faint`（`side=foe_side`），客户端 `b3BuildFxCues()` 把 `side==='enemy'` 映射到 `[data-b3-foe-card]` 并画「倒下」（`roco.js:2873-2950`）。
⇒ 现象与代码不一致：**对方倒下这一拍玩家看不到任何提示**（只看到立绘被换掉）；根因**已定位到客户端渲染侧**（见下面的服务端事件普查：引擎发了 `side=enemy` 的 faint，页面没画）。**不是**"基础图顶上就算通过"——这一条按缺口记。

**服务端事件普查**（页面内给 `fetch` 打桩，抄下每拍 `/api/roco/battle/{new,advance,free}` 回执里的 `view.events`）：拍到 29 次回执，事件种类计数 `{"turn_start":24,"defense":6,"damage":38,"energy_gain":25,"effects_registered_unsupported":30,"per_use_ramp":5,"faint":6,"mana_loss":6,"replacement":5,"action_cancelled":4,"game_end":1}`；其中 `faint` 的 `side` 取值：["enemy","player","player","enemy","player","player"]。
⇒ **引擎确实发了 2 条 `side=enemy` 的 faint**（对方倒下），而页面侧一条 `b3-float--faint` 都没落到对方卡上（4 条落到己方卡）⇒ **缺口在客户端渲染侧，不在引擎事件侧**。可疑机制（未定论）：`b3PlayActionFx` 的时间线在下一拍（`replacement` → 下一次渲染）到来时被 `b3CancelActionFx()` 整段撤掉，排在最后的对方 faint 飘字还没到点就被清掉。

### 3.4 结论
- 三种问法的答案：**不是倒下帧**（没实现）、**不是空白/占位**、**是保留基础图**（己方一直保留到补位；对方保留约 0.2 秒后被下一只替换）。
- 立绘在倒下/补位/换人全程 **没有出现破图**（`naturalWidth` 始终 512，`data-b3-sprite=ok`，没有触发过的 `onerror`）。
- **倒下帧与倒地动画：未实现**（资源、CSS、代码三处都没有）。

---

## 4. 未实现 / 只在静态数据里成立

**未实现（本次实测确认）**
1. 动作帧：攻击 / 受击 / 倒下 / 技能四种**都没有独立图**；只有 48 张策展「动作立绘」（另一个姿态，且客户端已不请求）。
2. 倒下帧 / 倒地动画：无资源、无 CSS、无代码路径；倒下时立绘原样保留。
3. 对方倒下的提示：**no 「倒下」飘字**（己方有 4 次，对方 0 次，而对方卡其它飘字 24 条都在）。
4. （旁证）对方倒下后立绘被**直接替换**成下一只——没有任何「这一只倒下了」的视觉停留。

**只在静态数据里成立、本次没有实机核验**
1. B 的 542/542：只到「引擎学习表 + 组装回执」；**没有** 542 次 `battle/new`、没有 542 场对局。
2. A 的 542/542：只到「这一张静态图 HTTP 200 且是 PNG」；不含任何动画/动作/交互。
3. A 的多形态结论：到「形态之间图不同/相同（sha256）」；**没有**逐形态在页面上的视觉核对（144 只只做了哈希比对）。
4. B 的 12 只「仅图鉴」：引擎学习表口径与冻结层同样通过，**没有**实机验证它们在正式 PVP 里能不能打（本任务不拿单场/样例代表全量）。
5. C 只覆盖 **1 场** 6×4 对局、28 拍、己方 4 次倒下 + 对方 2 次倒下；不同队伍/技能组合下是否还有别的倒下形状，未核验。

---

## 5. 复跑命令（全部只读；退出码为实测）

```bash
# 1) A：542 只基础立绘 + battle 档 + action 档（约 1626 次 GET，本地 ~20s）→ a-art.json / a-art-list.txt
node tmp/coverage-audit/a-art.mjs                                     # EXIT=0
# 2) B：542 只逐只引擎学习表判定 → b-play.json / b-play-list.txt（约 2 分钟）
node tmp/coverage-audit/b-play.mjs                                    # EXIT=0
# 3) B 续：反证 + 支持等级 + 三支样例队伍走 /api/roco/workshop → b-teams.json
node tmp/coverage-audit/b-teams.mjs                                   # EXIT=0
# 4) C：真打一场，逐帧采 DOM + 全量飘字普查 + 服务端事件打桩 → c-faint.json + 6 张截图
node tmp/coverage-audit/c-faint.mjs                                   # EXIT=0（U04_ACTIONS=30 控制拍数）
# 5b) A 的视觉证据（样本图 + 两张"共用同一张图"的形态图）→ shots/coverage-audit/a-*.png + a-samples.txt
node tmp/coverage-audit/a-samples.mjs                                 # EXIT=0
# 6) 报告再生成（数字全部来自上面几份 JSON）
node tmp/coverage-audit/make-report.mjs                               # EXIT=0
# 6) §2.5：542 只的 support_label / role_label / moveset 全量普查 → b-support.json
node tmp/coverage-audit/b-support.mjs                                 # EXIT=0
```

---

## 6. 附录 A｜已拥有基础立绘逐只清单（542/542 有）

列：`pet_id | 形态名(title) | 层 | default(HTTP/字节/宽/来源) | battle 档(HTTP/字节/变体) | action 档`

```
pet_000001 | 喵喵                 | overlay | default 200/41530B/256px/capture-2026-09-27 | battle 200/136763B/battle | action 404（无动作帧）
pet_000002 | 水蓝蓝                | overlay | default 200/46975B/256px/capture-2026-09-27 | battle 200/146831B/battle | action 404（无动作帧）
pet_000003 | 火花                 | overlay | default 200/60066B/256px/capture-2026-09-27 | battle 200/190492B/battle | action 404（无动作帧）
pet_000004 | 迪莫                 | overlay | default 200/45357B/256px/capture-2026-09-27 | battle 200/149192B/battle | action 404（无动作帧）
pet_000005 | 水灵                 | overlay | default 200/71399B/256px/capture-2026-09-27 | battle 200/232065B/battle | action 404（无动作帧）
pet_000006 | 火神                 | overlay | default 200/75316B/256px/capture-2026-09-27 | battle 200/244643B/battle | action 404（无动作帧）
pet_000007 | 魔力猫                | overlay | default 200/49178B/256px/capture-2026-09-27 | battle 200/156602B/battle | action 404（无动作帧）
pet_000008 | 草头鸭                | overlay | default 200/39956B/256px/capture-2026-09-27 | battle 200/122827B/battle | action 404（无动作帧）
pet_000009 | 恶魔叮                | overlay | default 200/48350B/256px/capture-2026-09-27 | battle 200/162669B/battle | action 404（无动作帧）
pet_000010 | 恶魔狼                | overlay | default 200/51858B/256px/capture-2026-09-27 | battle 200/160081B/battle | action 404（无动作帧）
pet_000011 | 鸭吉吉（蓬松的样子）         | overlay | default 200/36845B/256px/capture-2026-09-27 | battle 200/115475B/battle | action 404（无动作帧）
pet_000012 | 铠甲虫                | overlay | default 200/71024B/256px/capture-2026-09-27 | battle 200/231970B/battle | action 200/515187B
pet_000013 | 阿米亚特               | overlay | default 200/52956B/256px/capture-2026-09-27 | battle 200/159988B/battle | action 404（无动作帧）
pet_000014 | 阿米樱                | overlay | default 200/53794B/256px/capture-2026-09-27 | battle 200/176498B/battle | action 404（无动作帧）
pet_000015 | 罗隐                 | overlay | default 200/73886B/256px/capture-2026-09-27 | battle 200/234204B/battle | action 404（无动作帧）
pet_000016 | 蹦蹦种子（海神球形态）        | overlay | default 200/30919B/256px/capture-2026-09-27 | battle 200/99671B/battle | action 404（无动作帧）
pet_000017 | 蹦蹦草（海神球形态）         | overlay | default 200/52381B/256px/capture-2026-09-27 | battle 200/165335B/battle | action 404（无动作帧）
pet_000018 | 蹦蹦花（海神球形态）         | overlay | default 200/60730B/256px/capture-2026-09-27 | battle 200/192035B/battle | action 404（无动作帧）
pet_000019 | 地鼠（枯水期的样子）         | overlay | default 200/39441B/256px/capture-2026-09-27 | battle 200/123836B/battle | action 404（无动作帧）
pet_000020 | 遁鼠（枯水期的样子）         | overlay | default 200/43649B/256px/capture-2026-09-27 | battle 200/137663B/battle | action 404（无动作帧）
pet_000021 | 遁地鼠（枯水期的样子）        | overlay | default 200/47555B/256px/capture-2026-09-27 | battle 200/146441B/battle | action 404（无动作帧）
pet_000022 | 喵呜                 | overlay | default 200/54738B/256px/capture-2026-09-27 | battle 200/176338B/battle | action 404（无动作帧）
pet_000023 | 绿草精灵               | overlay | default 200/51793B/256px/capture-2026-09-27 | battle 200/167199B/battle | action 404（无动作帧）
pet_000024 | 蒲公英娃娃              | overlay | default 200/68432B/256px/capture-2026-09-27 | battle 200/223603B/battle | action 404（无动作帧）
pet_000025 | 冬羽雀                | overlay | default 200/37912B/256px/capture-2026-09-27 | battle 200/117275B/battle | action 404（无动作帧）
pet_000026 | 奇丽草                | overlay | default 200/34395B/256px/capture-2026-09-27 | battle 200/105078B/battle | action 404（无动作帧）
pet_000027 | 奇丽叶                | overlay | default 200/42853B/256px/capture-2026-09-27 | battle 200/133500B/battle | action 404（无动作帧）
pet_000028 | 奇丽花                | overlay | default 200/48585B/256px/capture-2026-09-27 | battle 200/149483B/battle | action 404（无动作帧）
pet_000029 | 焰火                 | overlay | default 200/60354B/256px/capture-2026-09-27 | battle 200/194850B/battle | action 404（无动作帧）
pet_000030 | 波波拉                | overlay | default 200/61284B/256px/capture-2026-09-27 | battle 200/200366B/battle | action 404（无动作帧）
pet_000031 | 蒲公英                | overlay | default 200/55695B/256px/capture-2026-09-27 | battle 200/184035B/battle | action 404（无动作帧）
pet_000032 | 魔草巫灵               | overlay | default 200/54486B/256px/capture-2026-09-27 | battle 200/171155B/battle | action 404（无动作帧）
pet_000033 | 鸭吉吉（紧实的样子）         | overlay | default 200/35738B/256px/capture-2026-09-27 | battle 200/108410B/battle | action 404（无动作帧）
pet_000034 | 岚鸟                 | overlay | default 200/46051B/256px/capture-2026-09-27 | battle 200/146106B/battle | action 404（无动作帧）
pet_000035 | 小甲虫                | overlay | default 200/51993B/256px/capture-2026-09-27 | battle 200/166566B/battle | action 404（无动作帧）
pet_000036 | 叮叮恶魔               | overlay | default 200/42180B/256px/capture-2026-09-27 | battle 200/130466B/battle | action 404（无动作帧）
pet_000037 | 丢丢（草地附近的样子）        | overlay | default 200/46939B/256px/capture-2026-09-27 | battle 200/152411B/battle | action 404（无动作帧）
pet_000038 | 卡卡虫（草地附近的样子）       | overlay | default 200/52124B/256px/capture-2026-09-27 | battle 200/164780B/battle | action 404（无动作帧）
pet_000039 | 卡瓦重（草地附近的样子）       | overlay | default 200/46960B/256px/capture-2026-09-27 | battle 200/144632B/battle | action 404（无动作帧）
pet_000040 | 伊贝儿                | overlay | default 200/47388B/256px/capture-2026-09-27 | battle 200/143040B/battle | action 404（无动作帧）
pet_000041 | 伊贝粉粉               | overlay | default 200/35104B/256px/capture-2026-09-27 | battle 200/106632B/battle | action 404（无动作帧）
pet_000042 | 锥尾羊                | overlay | default 200/38612B/256px/capture-2026-09-27 | battle 200/126501B/battle | action 404（无动作帧）
pet_000043 | 铃兰羊                | overlay | default 200/47932B/256px/capture-2026-09-27 | battle 200/149545B/battle | action 404（无动作帧）
pet_000044 | 花影羚羊               | overlay | default 200/41489B/256px/capture-2026-09-27 | battle 200/126005B/battle | action 404（无动作帧）
pet_000045 | 白发懒人               | overlay | default 200/57299B/256px/capture-2026-09-27 | battle 200/182325B/battle | action 404（无动作帧）
pet_000046 | 记忆石                | overlay | default 200/46094B/256px/capture-2026-09-27 | battle 200/151664B/battle | action 404（无动作帧）
pet_000047 | 板板壳                | overlay | default 200/52418B/256px/capture-2026-09-27 | battle 200/171615B/battle | action 404（无动作帧）
pet_000048 | 咔咔壳                | overlay | default 200/49257B/256px/capture-2026-09-27 | battle 200/161822B/battle | action 404（无动作帧）
pet_000049 | 水泡壳                | overlay | default 200/53886B/256px/capture-2026-09-27 | battle 200/169124B/battle | action 404（无动作帧）
pet_000050 | 一窝蜂                | overlay | default 200/52075B/256px/capture-2026-09-27 | battle 200/163487B/battle | action 404（无动作帧）
pet_000051 | 黄蜂后                | overlay | default 200/56997B/256px/capture-2026-09-27 | battle 200/175392B/battle | action 404（无动作帧）
pet_000052 | 小灵面                | overlay | default 200/49715B/256px/capture-2026-09-27 | battle 200/158238B/battle | action 404（无动作帧）
pet_000053 | 暗影灵面（睁眼的样子）        | overlay | default 200/50984B/256px/capture-2026-09-27 | battle 200/159622B/battle | action 404（无动作帧）
pet_000054 | 小独角兽               | overlay | default 200/56007B/256px/capture-2026-09-27 | battle 200/174304B/battle | action 404（无动作帧）
pet_000055 | 白金独角兽              | overlay | default 200/57490B/256px/capture-2026-09-27 | battle 200/183851B/battle | action 404（无动作帧）
pet_000056 | 幽影树                | overlay | default 200/61471B/256px/capture-2026-09-27 | battle 200/199622B/battle | action 404（无动作帧）
pet_000057 | 忽幽狸                | overlay | default 200/44665B/256px/capture-2026-09-27 | battle 200/147885B/battle | action 404（无动作帧）
pet_000058 | 影狸                 | overlay | default 200/54539B/256px/capture-2026-09-27 | battle 200/174031B/battle | action 404（无动作帧）
pet_000059 | 卷毛鸭                | overlay | default 200/37064B/256px/capture-2026-09-27 | battle 200/116031B/battle | action 404（无动作帧）
pet_000060 | 锤头鹳                | overlay | default 200/43116B/256px/capture-2026-09-27 | battle 200/136346B/battle | action 404（无动作帧）
pet_000061 | 护主犬                | overlay | default 200/46201B/256px/capture-2026-09-27 | battle 200/149721B/battle | action 404（无动作帧）
pet_000062 | 音速犬                | baseline | default 200/66611B/256px/capture-2026-09-27 | battle 200/201431B/battle | action 200/569407B
pet_000063 | 格兰种子               | overlay | default 200/38716B/256px/capture-2026-09-27 | battle 200/124609B/battle | action 404（无动作帧）
pet_000064 | 格兰花                | overlay | default 200/44976B/256px/capture-2026-09-27 | battle 200/143344B/battle | action 404（无动作帧）
pet_000065 | 格兰球                | overlay | default 200/46787B/256px/capture-2026-09-27 | battle 200/149869B/battle | action 404（无动作帧）
pet_000066 | 灵狐                 | overlay | default 200/42291B/256px/capture-2026-09-27 | battle 200/137900B/battle | action 404（无动作帧）
pet_000067 | 九尾狐                | overlay | default 200/40746B/256px/capture-2026-09-27 | battle 200/126901B/battle | action 404（无动作帧）
pet_000068 | 尖嘴狐仙               | overlay | default 200/52361B/256px/capture-2026-09-27 | battle 200/164384B/battle | action 404（无动作帧）
pet_000069 | 烈钻鸟                | overlay | default 200/49683B/256px/capture-2026-09-27 | battle 200/143692B/battle | action 404（无动作帧）
pet_000070 | 长尾火鸟               | overlay | default 200/42443B/256px/capture-2026-09-27 | battle 200/125798B/battle | action 404（无动作帧）
pet_000071 | 火羽                 | overlay | default 200/59100B/256px/capture-2026-09-27 | battle 200/178972B/battle | action 404（无动作帧）
pet_000072 | 治愈兔                | overlay | default 200/46882B/256px/capture-2026-09-27 | battle 200/147165B/battle | action 404（无动作帧）
pet_000073 | 红丝绒                | overlay | default 200/62381B/256px/capture-2026-09-27 | battle 200/193246B/battle | action 404（无动作帧）
pet_000074 | 可爱猿                | overlay | default 200/60611B/256px/capture-2026-09-27 | battle 200/189116B/battle | action 404（无动作帧）
pet_000075 | 炽热猿                | overlay | default 200/55772B/256px/capture-2026-09-27 | battle 200/174792B/battle | action 404（无动作帧）
pet_000076 | 火焰猿                | overlay | default 200/63918B/256px/capture-2026-09-27 | battle 200/192141B/battle | action 404（无动作帧）
pet_000077 | 可立鸡                | overlay | default 200/60415B/256px/capture-2026-09-27 | battle 200/190772B/battle | action 404（无动作帧）
pet_000078 | 晕晕鸡                | overlay | default 200/54243B/256px/capture-2026-09-27 | battle 200/168585B/battle | action 404（无动作帧）
pet_000079 | 绅士鸡                | overlay | default 200/51450B/256px/capture-2026-09-27 | battle 200/157865B/battle | action 404（无动作帧）
pet_000080 | 武者鸡                | overlay | default 200/51087B/256px/capture-2026-09-27 | battle 200/161575B/battle | action 404（无动作帧）
pet_000081 | 火尾瓦特               | overlay | default 200/53156B/256px/capture-2026-09-27 | battle 200/167452B/battle | action 404（无动作帧）
pet_000082 | 火尾战士               | overlay | default 200/55228B/256px/capture-2026-09-27 | battle 200/170085B/battle | action 404（无动作帧）
pet_000083 | 烈火守护               | overlay | default 200/70117B/256px/capture-2026-09-27 | battle 200/222221B/battle | action 404（无动作帧）
pet_000084 | 呆小路                | overlay | default 200/39839B/256px/capture-2026-09-27 | battle 200/124015B/battle | action 404（无动作帧）
pet_000085 | 舞动路路               | overlay | default 200/48029B/256px/capture-2026-09-27 | battle 200/155069B/battle | action 404（无动作帧）
pet_000086 | 白发路路               | overlay | default 200/47001B/256px/capture-2026-09-27 | battle 200/148143B/battle | action 404（无动作帧）
pet_000087 | 绿耳松鼠               | overlay | default 200/48480B/256px/capture-2026-09-27 | battle 200/152521B/battle | action 404（无动作帧）
pet_000088 | 抱枕松鼠               | overlay | default 200/57561B/256px/capture-2026-09-27 | battle 200/173877B/battle | action 404（无动作帧）
pet_000089 | 蹦床松鼠               | overlay | default 200/54961B/256px/capture-2026-09-27 | battle 200/165350B/battle | action 404（无动作帧）
pet_000090 | 动力猿                | overlay | default 200/70394B/256px/capture-2026-09-27 | battle 200/229307B/battle | action 404（无动作帧）
pet_000091 | 瞌睡王                | overlay | default 200/63333B/256px/capture-2026-09-27 | battle 200/205671B/battle | action 404（无动作帧）
pet_000092 | 布是石                | overlay | default 200/43469B/256px/capture-2026-09-27 | battle 200/142649B/battle | action 404（无动作帧）
pet_000093 | 布是岩                | overlay | default 200/44691B/256px/capture-2026-09-27 | battle 200/140574B/battle | action 404（无动作帧）
pet_000094 | 布克棱岩               | overlay | default 200/60844B/256px/capture-2026-09-27 | battle 200/197841B/battle | action 404（无动作帧）
pet_000095 | 石肤蜥                | overlay | default 200/67867B/256px/capture-2026-09-27 | battle 200/217220B/battle | action 404（无动作帧）
pet_000096 | 石刺蜥                | overlay | default 200/58146B/256px/capture-2026-09-27 | battle 200/190878B/battle | action 404（无动作帧）
pet_000097 | 石冠王蜥               | overlay | default 200/59341B/256px/capture-2026-09-27 | battle 200/193758B/battle | action 404（无动作帧）
pet_000098 | 仪使者                | overlay | default 200/60687B/256px/capture-2026-09-27 | battle 200/194409B/battle | action 404（无动作帧）
pet_000099 | 仪式之星               | overlay | default 200/70055B/256px/capture-2026-09-27 | battle 200/230957B/battle | action 404（无动作帧）
pet_000100 | 仪式巨像               | overlay | default 200/75881B/256px/capture-2026-09-27 | battle 200/246193B/battle | action 200/557080B
pet_000101 | 甜田螺                | overlay | default 200/44487B/256px/capture-2026-09-27 | battle 200/150073B/battle | action 404（无动作帧）
pet_000102 | 壳乙螺                | overlay | default 200/61181B/256px/capture-2026-09-27 | battle 200/197786B/battle | action 404（无动作帧）
pet_000103 | 卡洛儿                | overlay | default 200/55537B/256px/capture-2026-09-27 | battle 200/174624B/battle | action 404（无动作帧）
pet_000104 | 风铃鲨                | overlay | default 200/45904B/256px/capture-2026-09-27 | battle 200/143835B/battle | action 404（无动作帧）
pet_000105 | 蓝蝶鲨                | overlay | default 200/39317B/256px/capture-2026-09-27 | battle 200/119874B/battle | action 404（无动作帧）
pet_000106 | 彩蝶鲨                | overlay | default 200/46579B/256px/capture-2026-09-27 | battle 200/142585B/battle | action 404（无动作帧）
pet_000107 | 果冻                 | overlay | default 200/74174B/256px/capture-2026-09-27 | battle 200/230746B/battle | action 404（无动作帧）
pet_000108 | 翡翠水母               | overlay | default 200/70631B/256px/capture-2026-09-27 | battle 200/224184B/battle | action 404（无动作帧）
pet_000109 | 琉璃水母               | overlay | default 200/60111B/256px/capture-2026-09-27 | battle 200/188803B/battle | action 404（无动作帧）
pet_000110 | 大耳帽兜               | overlay | default 200/34817B/256px/capture-2026-09-27 | battle 200/112421B/battle | action 404（无动作帧）
pet_000111 | 帽兜娃娃               | overlay | default 200/39471B/256px/capture-2026-09-27 | battle 200/126332B/battle | action 404（无动作帧）
pet_000112 | 雪影娃娃               | baseline | default 200/69897B/256px/capture-2026-09-27 | battle 200/218736B/battle | action 200/549412B
pet_000113 | 脆筒甜甜               | overlay | default 200/30117B/256px/capture-2026-09-27 | battle 200/94535B/battle | action 404（无动作帧）
pet_000114 | 香草甜甜（樱桃饰品）         | overlay | default 200/33163B/256px/capture-2026-09-27 | battle 200/102404B/battle | action 404（无动作帧）
pet_000115 | 圣代甜甜（樱桃巧克力口味）      | overlay | default 200/52051B/256px/capture-2026-09-27 | battle 200/166349B/battle | action 404（无动作帧）
pet_000116 | 小狮鹫（崖间地的样子）        | overlay | default 200/53071B/256px/capture-2026-09-27 | battle 200/172058B/battle | action 404（无动作帧）
pet_000117 | 神圣狮鹫（崖间地的样子）       | overlay | default 200/40108B/256px/capture-2026-09-27 | battle 200/124915B/battle | action 404（无动作帧）
pet_000118 | 皇家狮鹫（崖间地的样子）       | overlay | default 200/41699B/256px/capture-2026-09-27 | battle 200/130062B/battle | action 200/587249B
pet_000119 | 圆眼蜘蛛               | overlay | default 200/60016B/256px/capture-2026-09-27 | battle 200/193639B/battle | action 404（无动作帧）
pet_000120 | 尖角蜘蛛               | overlay | default 200/67366B/256px/capture-2026-09-27 | battle 200/212793B/battle | action 404（无动作帧）
pet_000121 | 芋香巨角蛛              | overlay | default 200/62071B/256px/capture-2026-09-27 | battle 200/196542B/battle | action 404（无动作帧）
pet_000122 | 毛毛                 | overlay | default 200/61892B/256px/capture-2026-09-27 | battle 200/220888B/battle | action 404（无动作帧）
pet_000123 | 爬爬                 | overlay | default 200/49903B/256px/capture-2026-09-27 | battle 200/167001B/battle | action 404（无动作帧）
pet_000124 | 化蝶（平常的样子）          | baseline | default 200/50007B/256px/capture-2026-09-27 | battle 200/153715B/battle | action 200/559636B
pet_000125 | 小草虫                | overlay | default 200/42244B/256px/capture-2026-09-27 | battle 200/130090B/battle | action 404（无动作帧）
pet_000126 | 草衣虫                | overlay | default 200/52574B/256px/capture-2026-09-27 | battle 200/166809B/battle | action 404（无动作帧）
pet_000127 | 花衣蝶                | overlay | default 200/46801B/256px/capture-2026-09-27 | battle 200/144324B/battle | action 404（无动作帧）
pet_000128 | 小夜                 | overlay | default 200/46226B/256px/capture-2026-09-27 | battle 200/146625B/battle | action 404（无动作帧）
pet_000129 | 紫夜                 | overlay | default 200/46905B/256px/capture-2026-09-27 | battle 200/150118B/battle | action 404（无动作帧）
pet_000130 | 朔夜伊芙               | overlay | default 200/55719B/256px/capture-2026-09-27 | battle 200/176953B/battle | action 200/543485B
pet_000131 | 小灵菇                | overlay | default 200/62294B/256px/capture-2026-09-27 | battle 200/200587B/battle | action 404（无动作帧）
pet_000132 | 幻灵菇                | overlay | default 200/49044B/256px/capture-2026-09-27 | battle 200/155138B/battle | action 404（无动作帧）
pet_000133 | 幻影灵菇               | overlay | default 200/48858B/256px/capture-2026-09-27 | battle 200/151904B/battle | action 404（无动作帧）
pet_000134 | 空空颅                | overlay | default 200/56982B/256px/capture-2026-09-27 | battle 200/176555B/battle | action 404（无动作帧）
pet_000135 | 夜宿颅                | overlay | default 200/57276B/256px/capture-2026-09-27 | battle 200/176931B/battle | action 404（无动作帧）
pet_000136 | 夜枭                 | overlay | default 200/66271B/256px/capture-2026-09-27 | battle 200/204113B/battle | action 404（无动作帧）
pet_000137 | 多多                 | overlay | default 200/58192B/256px/capture-2026-09-27 | battle 200/191119B/battle | action 200/551670B
pet_000138 | 多啦多                | overlay | default 200/50514B/256px/capture-2026-09-27 | battle 200/161379B/battle | action 404（无动作帧）
pet_000140 | 裘洛                 | overlay | default 200/40718B/256px/capture-2026-09-27 | battle 200/126763B/battle | action 404（无动作帧）
pet_000141 | 裘力                 | overlay | default 200/40416B/256px/capture-2026-09-27 | battle 200/120952B/battle | action 404（无动作帧）
pet_000142 | 裘卡                 | overlay | default 200/44167B/256px/capture-2026-09-27 | battle 200/136216B/battle | action 404（无动作帧）
pet_000143 | 花魁蜂后               | overlay | default 200/51949B/256px/capture-2026-09-27 | battle 200/165561B/battle | action 200/471085B
pet_000144 | 春团                 | overlay | default 200/54818B/256px/capture-2026-09-27 | battle 200/172610B/battle | action 404（无动作帧）
pet_000145 | 春兔                 | overlay | default 200/68600B/256px/capture-2026-09-27 | battle 200/210716B/battle | action 404（无动作帧）
pet_000146 | 伏地兽                | overlay | default 200/38361B/256px/capture-2026-09-27 | battle 200/120423B/battle | action 404（无动作帧）
pet_000147 | 贪食鼹                | overlay | default 200/49339B/256px/capture-2026-09-27 | battle 200/154729B/battle | action 404（无动作帧）
pet_000148 | 巨噬针鼹               | overlay | default 200/67636B/256px/capture-2026-09-27 | battle 200/216853B/battle | action 404（无动作帧）
pet_000149 | 石石                 | overlay | default 200/62652B/256px/capture-2026-09-27 | battle 200/197680B/battle | action 404（无动作帧）
pet_000150 | 巨灵石                | overlay | default 200/86159B/256px/capture-2026-09-27 | battle 200/282134B/battle | action 404（无动作帧）
pet_000151 | 雪豆丁                | overlay | default 200/41719B/256px/capture-2026-09-27 | battle 200/129857B/battle | action 404（无动作帧）
pet_000152 | 雪蛮人                | overlay | default 200/63148B/256px/capture-2026-09-27 | battle 200/204598B/battle | action 200/581913B
pet_000153 | 雪巨人                | overlay | default 200/42970B/256px/capture-2026-09-27 | battle 200/132927B/battle | action 200/586081B
pet_000154 | 咔咔羽毛               | overlay | default 200/56493B/256px/capture-2026-09-27 | battle 200/179424B/battle | action 404（无动作帧）
pet_000155 | 咔咔雀                | overlay | default 200/57998B/256px/capture-2026-09-27 | battle 200/180824B/battle | action 404（无动作帧）
pet_000156 | 咔咔鸟                | overlay | default 200/58755B/256px/capture-2026-09-27 | battle 200/181037B/battle | action 404（无动作帧）
pet_000157 | 矮脚爬爬               | overlay | default 200/58031B/256px/capture-2026-09-27 | battle 200/184762B/battle | action 404（无动作帧）
pet_000158 | 恶魔红钻               | overlay | default 200/55250B/256px/capture-2026-09-27 | battle 200/175842B/battle | action 404（无动作帧）
pet_000159 | 小帕尔                | overlay | default 200/47999B/256px/capture-2026-09-27 | battle 200/156692B/battle | action 404（无动作帧）
pet_000160 | 帕尔萨斯               | overlay | default 200/67953B/256px/capture-2026-09-27 | battle 200/217338B/battle | action 404（无动作帧）
pet_000161 | 龙息帕尔               | overlay | default 200/48341B/256px/capture-2026-09-27 | battle 200/157769B/battle | action 404（无动作帧）
pet_000162 | 瑰眼仔                | overlay | default 200/52154B/256px/capture-2026-09-27 | battle 200/156267B/battle | action 200/554421B
pet_000163 | 耳翎瑰魅               | overlay | default 200/64418B/256px/capture-2026-09-27 | battle 200/199722B/battle | action 200/517679B
pet_000164 | 邪眼巨魔               | overlay | default 200/62030B/256px/capture-2026-09-27 | battle 200/191829B/battle | action 404（无动作帧）
pet_000165 | 拉特                 | overlay | default 200/52303B/256px/capture-2026-09-27 | battle 200/170435B/battle | action 404（无动作帧）
pet_000166 | 酷拉                 | overlay | default 200/56068B/256px/capture-2026-09-27 | battle 200/176201B/battle | action 404（无动作帧）
pet_000167 | 电咩咩                | overlay | default 200/55671B/256px/capture-2026-09-27 | battle 200/178955B/battle | action 200/499387B
pet_000168 | 粉咩咩                | overlay | default 200/45076B/256px/capture-2026-09-27 | battle 200/137045B/battle | action 404（无动作帧）
pet_000169 | 电球咩咩               | overlay | default 200/54689B/256px/capture-2026-09-27 | battle 200/175149B/battle | action 404（无动作帧）
pet_000170 | 小星光（星光能量的样子）       | overlay | default 200/37817B/256px/capture-2026-09-27 | battle 200/121152B/battle | action 404（无动作帧）
pet_000171 | 星光狮（星光能量的样子）       | overlay | default 200/43635B/256px/capture-2026-09-27 | battle 200/137447B/battle | action 404（无动作帧）
pet_000172 | 闪电环                | overlay | default 200/67138B/256px/capture-2026-09-27 | battle 200/212654B/battle | action 200/497641B
pet_000173 | 刺电环                | overlay | default 200/71335B/256px/capture-2026-09-27 | battle 200/221530B/battle | action 404（无动作帧）
pet_000174 | 荆棘电环               | overlay | default 200/61039B/256px/capture-2026-09-27 | battle 200/191214B/battle | action 404（无动作帧）
pet_000175 | 粉粉星                | overlay | default 200/60981B/256px/capture-2026-09-27 | battle 200/189020B/battle | action 404（无动作帧）
pet_000176 | 小皮球                | overlay | default 200/38938B/256px/capture-2026-09-27 | battle 200/125417B/battle | action 404（无动作帧）
pet_000177 | 机械方方               | overlay | default 200/54097B/256px/capture-2026-09-27 | battle 200/170432B/battle | action 404（无动作帧）
pet_000178 | 多彩方方               | overlay | default 200/57044B/256px/capture-2026-09-27 | battle 200/175738B/battle | action 404（无动作帧）
pet_000179 | 立方人                | overlay | default 200/60251B/256px/capture-2026-09-27 | battle 200/184179B/battle | action 404（无动作帧）
pet_000180 | 贝瑟                 | overlay | default 200/56976B/256px/capture-2026-09-27 | battle 200/185754B/battle | action 404（无动作帧）
pet_000181 | 贝加尔                | overlay | default 200/62914B/256px/capture-2026-09-27 | battle 200/201516B/battle | action 404（无动作帧）
pet_000182 | 贝古斯                | overlay | default 200/67799B/256px/capture-2026-09-27 | battle 200/216200B/battle | action 404（无动作帧）
pet_000183 | 多西                 | overlay | default 200/43751B/256px/capture-2026-09-27 | battle 200/132443B/battle | action 404（无动作帧）
pet_000184 | 库多西                | overlay | default 200/49853B/256px/capture-2026-09-27 | battle 200/161395B/battle | action 404（无动作帧）
pet_000185 | 波多西                | overlay | default 200/64840B/256px/capture-2026-09-27 | battle 200/205782B/battle | action 404（无动作帧）
pet_000186 | 小翼龙                | overlay | default 200/46739B/256px/capture-2026-09-27 | battle 200/150000B/battle | action 404（无动作帧）
pet_000187 | 翼龙                 | overlay | default 200/66600B/256px/capture-2026-09-27 | battle 200/212038B/battle | action 404（无动作帧）
pet_000188 | 伊雷龙                | overlay | default 200/54519B/256px/capture-2026-09-27 | battle 200/171314B/battle | action 404（无动作帧）
pet_000189 | 海豹战士               | overlay | default 200/60296B/256px/capture-2026-09-27 | battle 200/195348B/battle | action 404（无动作帧）
pet_000190 | 海豹船长               | baseline | default 200/56793B/256px/capture-2026-09-27 | battle 200/179897B/battle | action 200/617585B
pet_000191 | 古钟蛇                | overlay | default 200/53136B/256px/capture-2026-09-27 | battle 200/164497B/battle | action 404（无动作帧）
pet_000192 | 寒音蛇                | overlay | default 200/67201B/256px/capture-2026-09-27 | battle 200/218538B/battle | action 404（无动作帧）
pet_000193 | 菊花梨                | overlay | default 200/58261B/256px/capture-2026-09-27 | battle 200/185558B/battle | action 404（无动作帧）
pet_000194 | 友爱天天               | overlay | default 200/58287B/256px/capture-2026-09-27 | battle 200/183514B/battle | action 404（无动作帧）
pet_000195 | 友爱星飞               | overlay | default 200/72581B/256px/capture-2026-09-27 | battle 200/228057B/battle | action 404（无动作帧）
pet_000196 | 加灵                 | overlay | default 200/44878B/256px/capture-2026-09-27 | battle 200/143701B/battle | action 404（无动作帧）
pet_000197 | 加益                 | overlay | default 200/55623B/256px/capture-2026-09-27 | battle 200/169298B/battle | action 404（无动作帧）
pet_000198 | 加尔                 | overlay | default 200/66921B/256px/capture-2026-09-27 | battle 200/210431B/battle | action 404（无动作帧）
pet_000199 | 黑化加尔               | overlay | default 200/53907B/256px/capture-2026-09-27 | battle 200/170443B/battle | action 404（无动作帧）
pet_000200 | 牵线木偶               | overlay | default 200/57760B/256px/capture-2026-09-27 | battle 200/182346B/battle | action 404（无动作帧）
pet_000201 | 帅帅魔偶               | overlay | default 200/57738B/256px/capture-2026-09-27 | battle 200/186378B/battle | action 404（无动作帧）
pet_000202 | 小怂猫                | overlay | default 200/74122B/256px/capture-2026-09-27 | battle 200/230443B/battle | action 404（无动作帧）
pet_000203 | 怒目怂猫               | overlay | default 200/71009B/256px/capture-2026-09-27 | battle 200/226757B/battle | action 404（无动作帧）
pet_000204 | 哭哭菇                | overlay | default 200/36249B/256px/capture-2026-09-27 | battle 200/112232B/battle | action 404（无动作帧）
pet_000205 | 怖须菇                | overlay | default 200/51293B/256px/capture-2026-09-27 | battle 200/162347B/battle | action 404（无动作帧）
pet_000206 | 怖哭菇                | overlay | default 200/59181B/256px/capture-2026-09-27 | battle 200/185120B/battle | action 404（无动作帧）
pet_000207 | 绒绒                 | overlay | default 200/37483B/256px/capture-2026-09-27 | battle 200/118083B/battle | action 404（无动作帧）
pet_000208 | 小绒茧                | overlay | default 200/51395B/256px/capture-2026-09-27 | battle 200/162384B/battle | action 404（无动作帧）
pet_000209 | 绒仙子                | overlay | default 200/49167B/256px/capture-2026-09-27 | battle 200/157325B/battle | action 404（无动作帧）
pet_000210 | 小鹬                 | overlay | default 200/38811B/256px/capture-2026-09-27 | battle 200/121439B/battle | action 404（无动作帧）
pet_000211 | 鄙目鹬                | overlay | default 200/31802B/256px/capture-2026-09-27 | battle 200/97514B/battle | action 404（无动作帧）
pet_000212 | 高脚鹬                | overlay | default 200/37465B/256px/capture-2026-09-27 | battle 200/117571B/battle | action 404（无动作帧）
pet_000213 | 奔波鼠                | overlay | default 200/55073B/256px/capture-2026-09-27 | battle 200/167315B/battle | action 404（无动作帧）
pet_000214 | 流浪鼠                | overlay | default 200/69644B/256px/capture-2026-09-27 | battle 200/227002B/battle | action 404（无动作帧）
pet_000215 | 布鲁斯                | overlay | default 200/45456B/256px/capture-2026-09-27 | battle 200/143848B/battle | action 404（无动作帧）
pet_000216 | 雪顶布鲁斯              | overlay | default 200/54891B/256px/capture-2026-09-27 | battle 200/180617B/battle | action 404（无动作帧）
pet_000217 | 冰钻布鲁斯              | overlay | default 200/54256B/256px/capture-2026-09-27 | battle 200/175881B/battle | action 404（无动作帧）
pet_000218 | 呼呼猪                | overlay | default 200/44023B/256px/capture-2026-09-27 | battle 200/142232B/battle | action 200/444793B
pet_000219 | 獠牙猪                | overlay | default 200/55321B/256px/capture-2026-09-27 | battle 200/180766B/battle | action 200/518269B
pet_000220 | 卡波                 | overlay | default 200/40189B/256px/capture-2026-09-27 | battle 200/126184B/battle | action 404（无动作帧）
pet_000221 | 卡拉波斯               | overlay | default 200/50883B/256px/capture-2026-09-27 | battle 200/159340B/battle | action 404（无动作帧）
pet_000222 | 胆小鳗鱼               | overlay | default 200/69515B/256px/capture-2026-09-27 | battle 200/224692B/battle | action 404（无动作帧）
pet_000223 | 闪电鳗鱼               | overlay | default 200/80809B/256px/capture-2026-09-27 | battle 200/261360B/battle | action 404（无动作帧）
pet_000224 | 大头骨龙               | overlay | default 200/73007B/256px/capture-2026-09-27 | battle 200/228966B/battle | action 404（无动作帧）
pet_000225 | 寂灭骨龙               | baseline | default 200/68955B/256px/capture-2026-09-27 | battle 200/221241B/battle | action 200/522688B
pet_000226 | 绿翼鸟                | overlay | default 200/45585B/256px/capture-2026-09-27 | battle 200/141995B/battle | action 404（无动作帧）
pet_000227 | 魔翼鸟                | overlay | default 200/46814B/256px/capture-2026-09-27 | battle 200/149642B/battle | action 404（无动作帧）
pet_000228 | 魔眷鸟                | overlay | default 200/44839B/256px/capture-2026-09-27 | battle 200/141595B/battle | action 404（无动作帧）
pet_000229 | 雪绒鸟（春天的样子）         | overlay | default 200/38548B/256px/capture-2026-09-27 | battle 200/120550B/battle | action 404（无动作帧）
pet_000230 | 雪绒鸟（夏天的样子）         | overlay | default 200/38361B/256px/capture-2026-09-27 | battle 200/120587B/battle | action 404（无动作帧）
pet_000231 | 雪绒鸟（秋天的样子）         | overlay | default 200/39154B/256px/capture-2026-09-27 | battle 200/122339B/battle | action 404（无动作帧）
pet_000232 | 冬羽雀（春天的样子）         | overlay | default 200/38450B/256px/capture-2026-09-27 | battle 200/120048B/battle | action 404（无动作帧）
pet_000233 | 冬羽雀（夏天的样子）         | overlay | default 200/38379B/256px/capture-2026-09-27 | battle 200/119423B/battle | action 404（无动作帧）
pet_000234 | 冬羽雀（秋天的样子）         | overlay | default 200/38322B/256px/capture-2026-09-27 | battle 200/119250B/battle | action 404（无动作帧）
pet_000235 | 岚鸟（春天的样子）          | overlay | default 200/46897B/256px/capture-2026-09-27 | battle 200/148705B/battle | action 404（无动作帧）
pet_000236 | 岚鸟（夏天的样子）          | overlay | default 200/45644B/256px/capture-2026-09-27 | battle 200/146740B/battle | action 404（无动作帧）
pet_000237 | 岚鸟（秋天的样子）          | overlay | default 200/46658B/256px/capture-2026-09-27 | battle 200/148890B/battle | action 404（无动作帧）
pet_000238 | 丢丢（火山附近的样子）        | overlay | default 200/43744B/256px/capture-2026-09-27 | battle 200/135818B/battle | action 404（无动作帧）
pet_000239 | 丢丢（沙地附近的样子）        | overlay | default 200/41610B/256px/capture-2026-09-27 | battle 200/131193B/battle | action 404（无动作帧）
pet_000240 | 丢丢（雪山附近的样子）        | overlay | default 200/41936B/256px/capture-2026-09-27 | battle 200/133055B/battle | action 200/489650B
pet_000241 | 卡卡虫（火山附近的样子）       | overlay | default 200/47643B/256px/capture-2026-09-27 | battle 200/146116B/battle | action 404（无动作帧）
pet_000242 | 卡卡虫（沙地附近的样子）       | overlay | default 200/49041B/256px/capture-2026-09-27 | battle 200/154421B/battle | action 404（无动作帧）
pet_000243 | 卡卡虫（雪山附近的样子）       | overlay | default 200/46881B/256px/capture-2026-09-27 | battle 200/145176B/battle | action 200/526646B
pet_000244 | 卡瓦重（火山附近的样子）       | overlay | default 200/44145B/256px/capture-2026-09-27 | battle 200/132365B/battle | action 404（无动作帧）
pet_000245 | 卡瓦重（沙地附近的样子）       | overlay | default 200/44894B/256px/capture-2026-09-27 | battle 200/137206B/battle | action 404（无动作帧）
pet_000246 | 卡瓦重（雪山附近的样子）       | overlay | default 200/44983B/256px/capture-2026-09-27 | battle 200/135305B/battle | action 404（无动作帧）
pet_000247 | 蹦蹦种子（彩玉球形态）        | overlay | default 200/31885B/256px/capture-2026-09-27 | battle 200/102171B/battle | action 404（无动作帧）
pet_000248 | 蹦蹦种子（短毛球形态）        | overlay | default 200/30815B/256px/capture-2026-09-27 | battle 200/98647B/battle | action 200/177452B
pet_000249 | 蹦蹦种子（象牙球形态）        | overlay | default 200/32219B/256px/capture-2026-09-27 | battle 200/102502B/battle | action 404（无动作帧）
pet_000250 | 蹦蹦草（彩玉球形态）         | overlay | default 200/49044B/256px/capture-2026-09-27 | battle 200/154150B/battle | action 404（无动作帧）
pet_000251 | 蹦蹦草（短毛球形态）         | overlay | default 200/47775B/256px/capture-2026-09-27 | battle 200/149474B/battle | action 404（无动作帧）
pet_000252 | 蹦蹦草（象牙球形态）         | overlay | default 200/49033B/256px/capture-2026-09-27 | battle 200/154582B/battle | action 404（无动作帧）
pet_000253 | 蹦蹦花（彩玉球形态）         | overlay | default 200/64252B/256px/capture-2026-09-27 | battle 200/202506B/battle | action 404（无动作帧）
pet_000254 | 蹦蹦花（短毛球形态）         | overlay | default 200/57431B/256px/capture-2026-09-27 | battle 200/179652B/battle | action 404（无动作帧）
pet_000255 | 蹦蹦花（象牙球形态）         | overlay | default 200/64500B/256px/capture-2026-09-27 | battle 200/202499B/battle | action 404（无动作帧）
pet_000256 | 矿晶虫                | overlay | default 200/45187B/256px/capture-2026-09-27 | battle 200/145388B/battle | action 404（无动作帧）
pet_000257 | 晶石蜗（西瓜碧玺的样子）       | overlay | default 200/81298B/256px/capture-2026-09-27 | battle 200/261244B/battle | action 404（无动作帧）
pet_000258 | 犀角鸟                | overlay | default 200/53906B/256px/capture-2026-09-27 | battle 200/167628B/battle | action 404（无动作帧）
pet_000259 | 光纤兽                | overlay | default 200/68281B/256px/capture-2026-09-27 | battle 200/223544B/battle | action 404（无动作帧）
pet_000260 | 疾光千兽               | overlay | default 200/61722B/256px/capture-2026-09-27 | battle 200/193551B/battle | action 404（无动作帧）
pet_000261 | 小鼠獭                | overlay | default 200/43236B/256px/capture-2026-09-27 | battle 200/137701B/battle | action 404（无动作帧）
pet_000262 | 燕尾獭                | overlay | default 200/51036B/256px/capture-2026-09-27 | battle 200/162761B/battle | action 404（无动作帧）
pet_000263 | 卷胡巨獭               | overlay | default 200/53750B/256px/capture-2026-09-27 | battle 200/169854B/battle | action 404（无动作帧）
pet_000264 | 粉星仔                | overlay | default 200/68758B/256px/capture-2026-09-27 | battle 200/220236B/battle | action 404（无动作帧）
pet_000265 | 粉耳星兔               | overlay | default 200/68349B/256px/capture-2026-09-27 | battle 200/214728B/battle | action 404（无动作帧）
pet_000266 | 觅觅蝠                | overlay | default 200/61181B/256px/capture-2026-09-27 | battle 200/192764B/battle | action 404（无动作帧）
pet_000267 | 翻翻蝠                | overlay | default 200/59546B/256px/capture-2026-09-27 | battle 200/188159B/battle | action 404（无动作帧）
pet_000268 | 夜游魔                | overlay | default 200/57801B/256px/capture-2026-09-27 | battle 200/179781B/battle | action 404（无动作帧）
pet_000269 | 海盔虫                | overlay | default 200/56853B/256px/capture-2026-09-27 | battle 200/176265B/battle | action 404（无动作帧）
pet_000270 | 刺盔虫                | overlay | default 200/63085B/256px/capture-2026-09-27 | battle 200/199591B/battle | action 404（无动作帧）
pet_000271 | 千棘盔                | overlay | default 200/56970B/256px/capture-2026-09-27 | battle 200/180936B/battle | action 404（无动作帧）
pet_000272 | 雪娃娃                | overlay | default 200/64383B/256px/capture-2026-09-27 | battle 200/203943B/battle | action 404（无动作帧）
pet_000273 | 冰封怨灵               | overlay | default 200/57082B/256px/capture-2026-09-27 | battle 200/180685B/battle | action 404（无动作帧）
pet_000274 | 雪灵                 | overlay | default 200/63095B/256px/capture-2026-09-27 | battle 200/194098B/battle | action 404（无动作帧）
pet_000275 | 雪灵兽                | overlay | default 200/36876B/256px/capture-2026-09-27 | battle 200/114289B/battle | action 404（无动作帧）
pet_000276 | 幻雪兽                | overlay | default 200/48906B/256px/capture-2026-09-27 | battle 200/149934B/battle | action 404（无动作帧）
pet_000278 | 乖乖鹄                | overlay | default 200/46883B/256px/capture-2026-09-27 | battle 200/150630B/battle | action 404（无动作帧）
pet_000279 | 蓝珠天鹅               | overlay | default 200/46706B/256px/capture-2026-09-27 | battle 200/143948B/battle | action 404（无动作帧）
pet_000280 | 翠顶夫人               | overlay | default 200/56985B/256px/capture-2026-09-27 | battle 200/179638B/battle | action 404（无动作帧）
pet_000281 | 芽眼魔                | overlay | default 200/50011B/256px/capture-2026-09-27 | battle 200/155777B/battle | action 404（无动作帧）
pet_000282 | 叶眼魔                | overlay | default 200/57671B/256px/capture-2026-09-27 | battle 200/172941B/battle | action 404（无动作帧）
pet_000283 | 障眼魔                | overlay | default 200/59327B/256px/capture-2026-09-27 | battle 200/186730B/battle | action 404（无动作帧）
pet_000284 | 红绒十字               | overlay | default 200/63560B/256px/capture-2026-09-27 | battle 200/200590B/battle | action 404（无动作帧）
pet_000285 | 霹雳宝宝               | overlay | default 200/52317B/256px/capture-2026-09-27 | battle 200/165225B/battle | action 404（无动作帧）
pet_000286 | 雷鸣小子               | overlay | default 200/53813B/256px/capture-2026-09-27 | battle 200/175744B/battle | action 404（无动作帧）
pet_000287 | 雷神之子               | overlay | default 200/72042B/256px/capture-2026-09-27 | battle 200/231306B/battle | action 404（无动作帧）
pet_000288 | 电动长颈鹿              | overlay | default 200/55021B/256px/capture-2026-09-27 | battle 200/170440B/battle | action 404（无动作帧）
pet_000289 | 奔乐鹿                | overlay | default 200/43815B/256px/capture-2026-09-27 | battle 200/139434B/battle | action 404（无动作帧）
pet_000290 | 爵士鹿                | overlay | default 200/49609B/256px/capture-2026-09-27 | battle 200/153297B/battle | action 404（无动作帧）
pet_000291 | 蝴蝶陶陶               | overlay | default 200/37450B/256px/capture-2026-09-27 | battle 200/113993B/battle | action 404（无动作帧）
pet_000292 | 铆钉毛毛               | overlay | default 200/38053B/256px/capture-2026-09-27 | battle 200/119356B/battle | action 404（无动作帧）
pet_000293 | 徘徊爪爪               | overlay | default 200/44019B/256px/capture-2026-09-27 | battle 200/136046B/battle | action 404（无动作帧）
pet_000294 | 嘟嘟煲                | overlay | default 200/49478B/256px/capture-2026-09-27 | battle 200/163065B/battle | action 404（无动作帧）
pet_000295 | 嘟嘟锅                | overlay | default 200/55408B/256px/capture-2026-09-27 | battle 200/182039B/battle | action 404（无动作帧）
pet_000296 | 幽星光                | overlay | default 200/47488B/256px/capture-2026-09-27 | battle 200/159158B/battle | action 404（无动作帧）
pet_000297 | 曜星光                | overlay | default 200/56258B/256px/capture-2026-09-27 | battle 200/186210B/battle | action 404（无动作帧）
pet_000298 | 暮星辰                | overlay | default 200/70748B/256px/capture-2026-09-27 | battle 200/230634B/battle | action 404（无动作帧）
pet_000299 | 春花兔                | overlay | default 200/52169B/256px/capture-2026-09-27 | battle 200/164581B/battle | action 404（无动作帧）
pet_000300 | 逗逗                 | overlay | default 200/50935B/256px/capture-2026-09-27 | battle 200/164092B/battle | action 404（无动作帧）
pet_000301 | 气球猫                | overlay | default 200/58802B/256px/capture-2026-09-27 | battle 200/188100B/battle | action 404（无动作帧）
pet_000302 | 梦想三三               | overlay | default 200/67943B/256px/capture-2026-09-27 | battle 200/220649B/battle | action 404（无动作帧）
pet_000303 | 旋叶虫（金黄的样子）         | overlay | default 200/45146B/256px/capture-2026-09-27 | battle 200/142665B/battle | action 404（无动作帧）
pet_000304 | 风滚暮虫（金黄的样子）        | overlay | default 200/65828B/256px/capture-2026-09-27 | battle 200/205487B/battle | action 404（无动作帧）
pet_000305 | 菇菇丁                | overlay | default 200/37203B/256px/capture-2026-09-27 | battle 200/111245B/battle | action 404（无动作帧）
pet_000306 | 多菇丁                | overlay | default 200/54527B/256px/capture-2026-09-27 | battle 200/168610B/battle | action 404（无动作帧）
pet_000307 | 九幽菇                | overlay | default 200/62326B/256px/capture-2026-09-27 | battle 200/194532B/battle | action 404（无动作帧）
pet_000308 | 深蓝鲸                | overlay | default 200/49886B/256px/capture-2026-09-27 | battle 200/159712B/battle | action 200/528670B
pet_000309 | 双灯鱼                | overlay | default 200/48338B/256px/capture-2026-09-27 | battle 200/146859B/battle | action 404（无动作帧）
pet_000310 | 利灯鱼                | overlay | default 200/62933B/256px/capture-2026-09-27 | battle 200/194602B/battle | action 404（无动作帧）
pet_000311 | 豆丁鱼                | overlay | default 200/49184B/256px/capture-2026-09-27 | battle 200/159145B/battle | action 404（无动作帧）
pet_000312 | 快鳍鱼                | overlay | default 200/42573B/256px/capture-2026-09-27 | battle 200/136419B/battle | action 404（无动作帧）
pet_000313 | 龙鱼                 | overlay | default 200/47812B/256px/capture-2026-09-27 | battle 200/148454B/battle | action 404（无动作帧）
pet_000314 | 凡雀                 | overlay | default 200/35032B/256px/capture-2026-09-27 | battle 200/113535B/battle | action 404（无动作帧）
pet_000315 | 紫翎鹰                | overlay | default 200/51334B/256px/capture-2026-09-27 | battle 200/168292B/battle | action 404（无动作帧）
pet_000316 | 凡鹰                 | overlay | default 200/50047B/256px/capture-2026-09-27 | battle 200/158361B/battle | action 404（无动作帧）
pet_000317 | 里奥                 | overlay | default 200/62101B/256px/capture-2026-09-27 | battle 200/201254B/battle | action 404（无动作帧）
pet_000318 | 灵羽勇士               | overlay | default 200/47983B/256px/capture-2026-09-27 | battle 200/150809B/battle | action 404（无动作帧）
pet_000319 | 圣羽翼王               | overlay | default 200/53636B/256px/capture-2026-09-27 | battle 200/171871B/battle | action 404（无动作帧）
pet_000320 | 星尘虫                | overlay | default 200/56498B/256px/capture-2026-09-27 | battle 200/185386B/battle | action 404（无动作帧）
pet_000321 | 落星虫                | overlay | default 200/59396B/256px/capture-2026-09-27 | battle 200/192166B/battle | action 404（无动作帧）
pet_000322 | 陨星虫                | overlay | default 200/65741B/256px/capture-2026-09-27 | battle 200/215202B/battle | action 404（无动作帧）
pet_000323 | 碎晶蝎                | overlay | default 200/43258B/256px/capture-2026-09-27 | battle 200/133732B/battle | action 404（无动作帧）
pet_000324 | 晶尾蝎                | overlay | default 200/41432B/256px/capture-2026-09-27 | battle 200/118770B/battle | action 404（无动作帧）
pet_000325 | 蝎子王                | overlay | default 200/51733B/256px/capture-2026-09-27 | battle 200/156726B/battle | action 404（无动作帧）
pet_000326 | 幽冥眼（睁眼的样子）         | overlay | default 200/57712B/256px/capture-2026-09-27 | battle 200/175573B/battle | action 404（无动作帧）
pet_000327 | 缇塔                 | overlay | default 200/61549B/256px/capture-2026-09-27 | battle 200/196106B/battle | action 404（无动作帧）
pet_000328 | 声波缇塔               | overlay | default 200/51772B/256px/capture-2026-09-27 | battle 200/162035B/battle | action 200/564120B
pet_000329 | 权杖-Ⅱ               | overlay | default 200/51087B/256px/capture-2026-09-27 | battle 200/163269B/battle | action 404（无动作帧）
pet_000330 | 权杖-V               | overlay | default 200/62398B/256px/capture-2026-09-27 | battle 200/199074B/battle | action 200/495746B
pet_000331 | 伊兰亚龙               | overlay | default 200/54524B/256px/capture-2026-09-27 | battle 200/173146B/battle | action 404（无动作帧）
pet_000332 | 厉毒小萝               | overlay | default 200/45013B/256px/capture-2026-09-27 | battle 200/145582B/battle | action 404（无动作帧）
pet_000333 | 厉毒修萝               | overlay | default 200/53121B/256px/capture-2026-09-27 | battle 200/165805B/battle | action 404（无动作帧）
pet_000334 | 海枝枝（碧蓝珊瑚）          | overlay | default 200/50930B/256px/capture-2026-09-27 | battle 200/162533B/battle | action 404（无动作帧）
pet_000335 | 海枝枝（杏黄百合）          | overlay | default 200/59775B/256px/capture-2026-09-27 | battle 200/190982B/battle | action 404（无动作帧）
pet_000336 | 海枝枝（洋红沙丁）          | overlay | default 200/51698B/256px/capture-2026-09-27 | battle 200/164198B/battle | action 404（无动作帧）
pet_000337 | 海枝枝（翠绿纶布）          | overlay | default 200/56651B/256px/capture-2026-09-27 | battle 200/177755B/battle | action 404（无动作帧）
pet_000338 | 小电企鹅               | overlay | default 200/38541B/256px/capture-2026-09-27 | battle 200/116155B/battle | action 404（无动作帧）
pet_000339 | 电企鹅                | overlay | default 200/49245B/256px/capture-2026-09-27 | battle 200/146542B/battle | action 404（无动作帧）
pet_000340 | 柴渣虫                | overlay | default 200/51907B/256px/capture-2026-09-27 | battle 200/164589B/battle | action 404（无动作帧）
pet_000341 | 燃薪虫                | overlay | default 200/41437B/256px/capture-2026-09-27 | battle 200/127082B/battle | action 404（无动作帧）
pet_000342 | 梦游（穿旧睡衣的样子）        | overlay | default 200/40828B/256px/capture-2026-09-27 | battle 200/132494B/battle | action 404（无动作帧）
pet_000343 | 梦悠悠（穿旧睡衣的样子）       | overlay | default 200/50514B/256px/capture-2026-09-27 | battle 200/152176B/battle | action 404（无动作帧）
pet_000344 | 梦游（穿星星睡衣的样子）       | overlay | default 200/41767B/256px/capture-2026-09-27 | battle 200/131281B/battle | action 404（无动作帧）
pet_000345 | 梦悠悠（穿星星睡衣的样子）      | overlay | default 200/54249B/256px/capture-2026-09-27 | battle 200/166750B/battle | action 404（无动作帧）
pet_000346 | 小星光（月光能量的样子）       | overlay | default 200/37633B/256px/capture-2026-09-27 | battle 200/119283B/battle | action 404（无动作帧）
pet_000347 | 星光狮（月光能量的样子）       | overlay | default 200/44122B/256px/capture-2026-09-27 | battle 200/136372B/battle | action 404（无动作帧）
pet_000348 | 噼啪鸟                | overlay | default 200/41646B/256px/capture-2026-09-27 | battle 200/125420B/battle | action 404（无动作帧）
pet_000349 | 晶石蜗（莲花刚玉的样子）       | overlay | default 200/70249B/256px/capture-2026-09-27 | battle 200/225763B/battle | action 404（无动作帧）
pet_000350 | 晶石蜗（星彩榴石的样子）       | overlay | default 200/64398B/256px/capture-2026-09-27 | battle 200/207546B/battle | action 404（无动作帧）
pet_000351 | 晶石蜗（火山琉璃的样子）       | overlay | default 200/67316B/256px/capture-2026-09-27 | battle 200/213633B/battle | action 404（无动作帧）
pet_000352 | 晶石蜗（蓝锥矿的样子）        | overlay | default 200/66145B/256px/capture-2026-09-27 | battle 200/211800B/battle | action 404（无动作帧）
pet_000353 | 鸭吉吉（急急急鸭）          | overlay | default 200/55955B/256px/capture-2026-09-27 | battle 200/170907B/battle | action 404（无动作帧）
pet_000354 | 鸭吉吉（等一等鸭）          | overlay | default 200/47079B/256px/capture-2026-09-27 | battle 200/154432B/battle | action 404（无动作帧）
pet_000355 | 地鼠（储水时的样子）         | overlay | default 200/51251B/256px/capture-2026-09-27 | battle 200/164869B/battle | action 404（无动作帧）
pet_000356 | 遁鼠（储水时的样子）         | overlay | default 200/57767B/256px/capture-2026-09-27 | battle 200/182111B/battle | action 404（无动作帧）
pet_000357 | 遁地鼠（储水时的样子）        | overlay | default 200/60350B/256px/capture-2026-09-27 | battle 200/187850B/battle | action 404（无动作帧）
pet_000358 | 月牙雪熊               | overlay | default 200/49699B/256px/capture-2026-09-27 | battle 200/162912B/battle | action 404（无动作帧）
pet_000359 | 圣代甜甜（樱桃草莓口味）       | overlay | default 200/55998B/256px/capture-2026-09-27 | battle 200/178454B/battle | action 404（无动作帧）
pet_000360 | 圣代甜甜（樱桃抹茶口味）       | overlay | default 200/55115B/256px/capture-2026-09-27 | battle 200/174062B/battle | action 404（无动作帧）
pet_000361 | 圣代甜甜（蓝莓巧克力口味）      | overlay | default 200/51179B/256px/capture-2026-09-27 | battle 200/163747B/battle | action 404（无动作帧）
pet_000362 | 圣代甜甜（蓝莓草莓口味）       | overlay | default 200/55165B/256px/capture-2026-09-27 | battle 200/176395B/battle | action 404（无动作帧）
pet_000363 | 圣代甜甜（蓝莓抹茶口味）       | overlay | default 200/54194B/256px/capture-2026-09-27 | battle 200/171363B/battle | action 404（无动作帧）
pet_000364 | 圣代甜甜（杨桃巧克力口味）      | overlay | default 200/51148B/256px/capture-2026-09-27 | battle 200/163334B/battle | action 404（无动作帧）
pet_000365 | 圣代甜甜（杨桃草莓口味）       | overlay | default 200/54999B/256px/capture-2026-09-27 | battle 200/175676B/battle | action 404（无动作帧）
pet_000366 | 圣代甜甜（杨桃抹茶口味）       | overlay | default 200/54183B/256px/capture-2026-09-27 | battle 200/171186B/battle | action 404（无动作帧）
pet_000367 | 星云旅者               | overlay | default 200/45825B/256px/capture-2026-09-27 | battle 200/137879B/battle | action 404（无动作帧）
pet_000368 | 小狮鹫（高山地的样子）        | overlay | default 200/53614B/256px/capture-2026-09-27 | battle 200/170332B/battle | action 404（无动作帧）
pet_000369 | 神圣狮鹫（高山地的样子）       | overlay | default 200/47050B/256px/capture-2026-09-27 | battle 200/143228B/battle | action 404（无动作帧）
pet_000370 | 皇家狮鹫（高山地的样子）       | overlay | default 200/51586B/256px/capture-2026-09-27 | battle 200/159630B/battle | action 404（无动作帧）
pet_000371 | 化蝶（幽冥眼的样子）         | overlay | default 200/55905B/256px/capture-2026-09-27 | battle 200/172594B/battle | action 404（无动作帧）
pet_000372 | 化蝶（喵喵的样子）          | overlay | default 200/51842B/256px/capture-2026-09-27 | battle 200/163141B/battle | action 404（无动作帧）
pet_000373 | 化蝶（奇丽花的样子）         | overlay | default 200/49687B/256px/capture-2026-09-27 | battle 200/156156B/battle | action 404（无动作帧）
pet_000374 | 布瓜蝌                | overlay | default 200/32345B/256px/capture-2026-09-27 | battle 200/99766B/battle | action 404（无动作帧）
pet_000375 | 上岸蛙                | overlay | default 200/48479B/256px/capture-2026-09-27 | battle 200/149387B/battle | action 404（无动作帧）
pet_000376 | 海盔虫（磨损的样子）         | overlay | default 200/44451B/256px/capture-2026-09-27 | battle 200/139202B/battle | action 404（无动作帧）
pet_000377 | 刺盔虫（磨损的样子）         | overlay | default 200/53054B/256px/capture-2026-09-27 | battle 200/166598B/battle | action 404（无动作帧）
pet_000378 | 千棘盔（磨损的样子）         | overlay | default 200/48900B/256px/capture-2026-09-27 | battle 200/158568B/battle | action 404（无动作帧）
pet_000379 | 香草甜甜（杨桃饰品）         | overlay | default 200/32249B/256px/capture-2026-09-27 | battle 200/99161B/battle | action 404（无动作帧）
pet_000380 | 香草甜甜（蓝莓饰品）         | overlay | default 200/32079B/256px/capture-2026-09-27 | battle 200/99594B/battle | action 404（无动作帧）
pet_000381 | 暗影灵面（闭眼的样子）        | overlay | default 200/50840B/256px/capture-2026-09-27 | battle 200/158847B/battle | action 404（无动作帧）
pet_000382 | 幽冥眼（闭眼的样子）         | overlay | default 200/56998B/256px/capture-2026-09-27 | battle 200/173522B/battle | action 404（无动作帧）
pet_000383 | 蓬叶虫（金黄的样子）         | overlay | default 200/40078B/256px/capture-2026-09-27 | battle 200/127014B/battle | action 404（无动作帧）
pet_000384 | 螺旋帕帕               | overlay | default 200/56696B/256px/capture-2026-09-27 | battle 200/180659B/battle | action 404（无动作帧）
pet_000385 | 落陨星兔               | overlay | default 200/60594B/256px/capture-2026-09-27 | battle 200/197116B/battle | action 404（无动作帧）
pet_000386 | 晶石蜗（烧蓝黄金的样子）       | overlay | default 200/69016B/256px/capture-2026-09-27 | battle 200/220499B/battle | action 404（无动作帧）
pet_000387 | 小丑豆豆               | overlay | default 200/41815B/256px/capture-2026-09-27 | battle 200/130684B/battle | action 404（无动作帧）
pet_000388 | 小丑兔                | overlay | default 200/52215B/256px/capture-2026-09-27 | battle 200/165464B/battle | action 404（无动作帧）
pet_000389 | 小丑公爵               | overlay | default 200/56362B/256px/capture-2026-09-27 | battle 200/177844B/battle | action 404（无动作帧）
pet_000390 | 吸泥鸥                | overlay | default 200/45869B/256px/capture-2026-09-27 | battle 200/141703B/battle | action 404（无动作帧）
pet_000391 | 泥吼牙                | overlay | default 200/49606B/256px/capture-2026-09-27 | battle 200/156571B/battle | action 404（无动作帧）
pet_000392 | 兽花蕾                | overlay | default 200/55150B/256px/capture-2026-09-27 | battle 200/175036B/battle | action 404（无动作帧）
pet_000393 | 鸭吉吉（燃了鸭）           | overlay | default 200/55840B/256px/capture-2026-09-27 | battle 200/180259B/battle | action 404（无动作帧）
pet_000394 | 旋叶虫（枯叶的样子）         | overlay | default 200/43368B/256px/capture-2026-09-27 | battle 200/136637B/battle | action 404（无动作帧）
pet_000395 | 蓬叶虫（枯叶的样子）         | overlay | default 200/39055B/256px/capture-2026-09-27 | battle 200/123187B/battle | action 404（无动作帧）
pet_000396 | 风滚暮虫（枯叶的样子）        | overlay | default 200/61303B/256px/capture-2026-09-27 | battle 200/192905B/battle | action 404（无动作帧）
pet_000398 | 石肤蜥（球球尾巴的样子）       | overlay | default 200/64440B/256px/capture-2026-09-27 | battle 200/206270B/battle | action 404（无动作帧）
pet_000399 | 石刺蜥（球球尾巴的样子）       | overlay | default 200/59405B/256px/capture-2026-09-27 | battle 200/194756B/battle | action 404（无动作帧）
pet_000400 | 石冠王蜥（球球尾巴的样子）      | overlay | default 200/60492B/256px/capture-2026-09-27 | battle 200/197209B/battle | action 404（无动作帧）
pet_000401 | 花怨鳗                | overlay | default 200/50064B/256px/capture-2026-09-27 | battle 200/157525B/battle | action 404（无动作帧）
pet_000402 | 鳗尾兽                | overlay | default 200/76905B/256px/capture-2026-09-27 | battle 200/246073B/battle | action 404（无动作帧）
pet_000403 | 波波螺                | overlay | default 200/57773B/256px/capture-2026-09-27 | battle 200/182770B/battle | action 404（无动作帧）
pet_000404 | 消波螺                | overlay | default 200/42998B/256px/capture-2026-09-27 | battle 200/132962B/battle | action 404（无动作帧）
pet_000405 | 嗜波螺                | overlay | default 200/48979B/256px/capture-2026-09-27 | battle 200/152753B/battle | action 404（无动作帧）
pet_000406 | 波波螺（被污染的样子）        | overlay | default 200/61227B/256px/capture-2026-09-27 | battle 200/207047B/battle | action 404（无动作帧）
pet_000407 | 消波螺（被污染的样子）        | overlay | default 200/48811B/256px/capture-2026-09-27 | battle 200/167297B/battle | action 404（无动作帧）
pet_000408 | 嗜波螺（被污染的样子）        | overlay | default 200/57577B/256px/capture-2026-09-27 | battle 200/199468B/battle | action 404（无动作帧）
pet_000409 | 板板壳（蜕皮时的样子）        | overlay | default 200/52454B/256px/capture-2026-09-27 | battle 200/170686B/battle | action 404（无动作帧）
pet_000410 | 咔咔壳（蜕皮时的样子）        | overlay | default 200/50677B/256px/capture-2026-09-27 | battle 200/165796B/battle | action 404（无动作帧）
pet_000411 | 水泡壳（蜕皮时的样子）        | overlay | default 200/56865B/256px/capture-2026-09-27 | battle 200/177980B/battle | action 404（无动作帧）
pet_000412 | 里拉鳐                | overlay | default 200/43620B/256px/capture-2026-09-27 | battle 200/139251B/battle | action 404（无动作帧）
pet_000413 | 抹茶布丁               | overlay | default 200/54818B/256px/capture-2026-09-27 | battle 200/172683B/battle | action 404（无动作帧）
pet_000414 | 椰浆布丁               | overlay | default 200/76591B/256px/capture-2026-09-27 | battle 200/234776B/battle | action 404（无动作帧）
pet_000415 | 熔岩布丁               | overlay | default 200/52865B/256px/capture-2026-09-27 | battle 200/166581B/battle | action 404（无动作帧）
pet_000416 | 号儿鱼                | overlay | default 200/50493B/256px/capture-2026-09-27 | battle 200/160048B/battle | action 404（无动作帧）
pet_000417 | 圆号鱼                | baseline | default 200/62626B/256px/capture-2026-09-27 | battle 200/197877B/battle | action 200/448697B
pet_000418 | 小雪人                | overlay | default 200/53552B/256px/capture-2026-09-27 | battle 200/166572B/battle | action 404（无动作帧）
pet_000419 | 雪怪                 | overlay | default 200/69919B/256px/capture-2026-09-27 | battle 200/222806B/battle | action 404（无动作帧）
pet_000420 | 雪绒鸟                | overlay | default 200/39017B/256px/capture-2026-09-27 | battle 200/123730B/battle | action 404（无动作帧）
pet_000421 | 斑斑                 | overlay | default 200/48910B/256px/capture-2026-09-27 | battle 200/152539B/battle | action 404（无动作帧）
pet_000422 | 斑枭                 | overlay | default 200/48084B/256px/capture-2026-09-27 | battle 200/151552B/battle | action 404（无动作帧）
pet_000423 | 乌达（极昼的样子）          | overlay | default 200/54624B/256px/capture-2026-09-27 | battle 200/172633B/battle | action 404（无动作帧）
pet_000424 | 迷你乌（极昼的样子）         | overlay | default 200/68688B/256px/capture-2026-09-27 | battle 200/213003B/battle | action 404（无动作帧）
pet_000425 | 乌拉塔（极昼的样子）         | overlay | default 200/71957B/256px/capture-2026-09-27 | battle 200/226133B/battle | action 404（无动作帧）
pet_000426 | 乌达（极夜的样子）          | overlay | default 200/57972B/256px/capture-2026-09-27 | battle 200/182384B/battle | action 404（无动作帧）
pet_000427 | 迷你乌（极夜的样子）         | overlay | default 200/66352B/256px/capture-2026-09-27 | battle 200/205861B/battle | action 404（无动作帧）
pet_000428 | 乌拉塔（极夜的样子）         | overlay | default 200/75820B/256px/capture-2026-09-27 | battle 200/237661B/battle | action 404（无动作帧）
pet_000429 | 圣剑侍从               | overlay | default 200/61080B/256px/capture-2026-09-27 | battle 200/202233B/battle | action 404（无动作帧）
pet_000430 | 圣剑-X               | overlay | default 200/61914B/256px/capture-2026-09-27 | battle 200/212776B/battle | action 404（无动作帧）
pet_000431 | 帕帕斯卡               | overlay | default 200/56805B/256px/capture-2026-09-27 | battle 200/177561B/battle | action 404（无动作帧）
pet_000432 | 棋棋（白子）             | overlay | default 200/33046B/256px/capture-2026-09-27 | battle 200/102424B/battle | action 404（无动作帧）
pet_000433 | 棋骑士（白子）            | overlay | default 200/40936B/256px/capture-2026-09-27 | battle 200/133024B/battle | action 404（无动作帧）
pet_000434 | 棋绮后（白子）            | overlay | default 200/36794B/256px/capture-2026-09-27 | battle 200/115846B/battle | action 404（无动作帧）
pet_000435 | 棋齐垒（白子）            | overlay | default 200/43511B/256px/capture-2026-09-27 | battle 200/139802B/battle | action 404（无动作帧）
pet_000436 | 棋祈督（白子）            | overlay | default 200/41202B/256px/capture-2026-09-27 | battle 200/132510B/battle | action 404（无动作帧）
pet_000437 | 棋棋（黑子）             | overlay | default 200/32237B/256px/capture-2026-09-27 | battle 200/103775B/battle | action 404（无动作帧）
pet_000438 | 棋骑士（黑子）            | overlay | default 200/39229B/256px/capture-2026-09-27 | battle 200/125479B/battle | action 404（无动作帧）
pet_000439 | 棋绮后（黑子）            | overlay | default 200/36968B/256px/capture-2026-09-27 | battle 200/115984B/battle | action 404（无动作帧）
pet_000440 | 棋齐垒（黑子）            | overlay | default 200/42137B/256px/capture-2026-09-27 | battle 200/134766B/battle | action 404（无动作帧）
pet_000441 | 棋祈督（黑子）            | overlay | default 200/41929B/256px/capture-2026-09-27 | battle 200/132082B/battle | action 404（无动作帧）
pet_000442 | 栗鼠                 | overlay | default 200/35925B/256px/capture-2026-09-27 | battle 200/113237B/battle | action 404（无动作帧）
pet_000443 | 壳栗丝鼠               | overlay | default 200/51323B/256px/capture-2026-09-27 | battle 200/160654B/battle | action 404（无动作帧）
pet_000444 | 小黑猫                | overlay | default 200/46000B/256px/capture-2026-09-27 | battle 200/146470B/battle | action 404（无动作帧）
pet_000445 | 黑猫巫师               | baseline | default 200/46408B/256px/capture-2026-09-27 | battle 200/145427B/battle | action 200/486013B
pet_000446 | 黑羽夫人               | overlay | default 200/68826B/256px/capture-2026-09-27 | battle 200/222404B/battle | action 404（无动作帧）
pet_000447 | 爆焰仔                | overlay | default 200/49403B/256px/capture-2026-09-27 | battle 200/155739B/battle | action 404（无动作帧）
pet_000448 | 爆焰喷喷               | overlay | default 200/54256B/256px/capture-2026-09-27 | battle 200/170323B/battle | action 200/514545B
pet_000449 | 墨鱿士                | overlay | default 200/32761B/256px/capture-2026-09-27 | battle 200/102884B/battle | action 404（无动作帧）
pet_000450 | 混乱鱿彩               | overlay | default 200/43336B/256px/capture-2026-09-27 | battle 200/129070B/battle | action 200/555290B
pet_000451 | 秩序鱿墨               | baseline | default 200/42413B/256px/capture-2026-09-27 | battle 200/133551B/battle | action 200/513445B
pet_000452 | 刺轮砣（上弦的样子）         | overlay | default 200/42127B/256px/capture-2026-09-27 | battle 200/134760B/battle | action 404（无动作帧）
pet_000453 | 月亮砣（上弦的样子）         | overlay | default 200/46676B/256px/capture-2026-09-27 | battle 200/150159B/battle | action 404（无动作帧）
pet_000454 | 刺轮砣（下弦的样子）         | overlay | default 200/38143B/256px/capture-2026-09-27 | battle 200/124285B/battle | action 404（无动作帧）
pet_000455 | 月亮砣（下弦的样子）         | overlay | default 200/45163B/256px/capture-2026-09-27 | battle 200/145433B/battle | action 404（无动作帧）
pet_000456 | 十字蝌蚪               | overlay | default 200/38307B/256px/capture-2026-09-27 | battle 200/127217B/battle | action 200/510104B
pet_000457 | 十字蛙                | overlay | default 200/59443B/256px/capture-2026-09-27 | battle 200/188613B/battle | action 404（无动作帧）
pet_000458 | 深渊蛙                | overlay | default 200/54370B/256px/capture-2026-09-27 | battle 200/171140B/battle | action 200/585831B
pet_000459 | 松仔                 | overlay | default 200/57244B/256px/capture-2026-09-27 | battle 200/182322B/battle | action 404（无动作帧）
pet_000460 | 松叶羊                | overlay | default 200/52336B/256px/capture-2026-09-27 | battle 200/165901B/battle | action 404（无动作帧）
pet_000461 | 针叶巡林               | overlay | default 200/65693B/256px/capture-2026-09-27 | battle 200/211511B/battle | action 404（无动作帧）
pet_000462 | 水滴蛇                | overlay | default 200/53832B/256px/capture-2026-09-27 | battle 200/166222B/battle | action 404（无动作帧）
pet_000463 | 水蛇锁                | overlay | default 200/39415B/256px/capture-2026-09-27 | battle 200/123040B/battle | action 404（无动作帧）
pet_000464 | 游蛇魔使               | overlay | default 200/33481B/256px/capture-2026-09-27 | battle 200/103077B/battle | action 404（无动作帧）
pet_000465 | 小勇狮                | overlay | default 200/53278B/256px/capture-2026-09-27 | battle 200/168469B/battle | action 404（无动作帧）
pet_000466 | 炽焰狮                | overlay | default 200/54254B/256px/capture-2026-09-27 | battle 200/171704B/battle | action 404（无动作帧）
pet_000467 | 炽心勇狮               | overlay | default 200/59618B/256px/capture-2026-09-27 | battle 200/192329B/battle | action 404（无动作帧）
pet_000468 | 毛头小蛛               | overlay | default 200/41520B/256px/capture-2026-09-27 | battle 200/131381B/battle | action 404（无动作帧）
pet_000469 | 捕尘长绒               | overlay | default 200/38665B/256px/capture-2026-09-27 | battle 200/125048B/battle | action 404（无动作帧）
pet_000470 | 食尘短绒               | overlay | default 200/35894B/256px/capture-2026-09-27 | battle 200/113199B/battle | action 404（无动作帧）
pet_000471 | 画精灵                | overlay | default 200/50349B/256px/capture-2026-09-27 | battle 200/165320B/battle | action 404（无动作帧）
pet_000472 | 画像守护               | overlay | default 200/60310B/256px/capture-2026-09-27 | battle 200/194640B/battle | action 404（无动作帧）
pet_000473 | 画间法师手              | overlay | default 200/59126B/256px/capture-2026-09-27 | battle 200/190598B/battle | action 200/445287B
pet_000474 | 画间沉铁兽              | baseline | default 200/52682B/256px/capture-2026-09-27 | battle 200/173238B/battle | action 200/550911B
pet_000475 | 书魔虫                | overlay | default 200/49345B/256px/capture-2026-09-27 | battle 200/157531B/battle | action 404（无动作帧）
pet_000476 | 书卷守护               | overlay | default 200/58544B/256px/capture-2026-09-27 | battle 200/186581B/battle | action 404（无动作帧）
pet_000477 | 古卷执政官              | overlay | default 200/91184B/256px/capture-2026-09-27 | battle 200/298160B/battle | action 404（无动作帧）
pet_000478 | 古卷匣魔像              | overlay | default 200/60169B/256px/capture-2026-09-27 | battle 200/195300B/battle | action 404（无动作帧）
pet_000479 | 嗜光嗡嗡               | overlay | default 200/43398B/256px/capture-2026-09-27 | battle 200/137660B/battle | action 200/532196B
pet_000480 | 窃光蚊                | overlay | default 200/60933B/256px/capture-2026-09-27 | battle 200/195819B/battle | action 404（无动作帧）
pet_000481 | 不咕钟                | overlay | default 200/42025B/256px/capture-2026-09-27 | battle 200/127832B/battle | action 404（无动作帧）
pet_000482 | 溯源钟                | overlay | default 200/46065B/256px/capture-2026-09-27 | battle 200/139723B/battle | action 404（无动作帧）
pet_000483 | 小箱怪                | overlay | default 200/45175B/256px/capture-2026-09-27 | battle 200/142405B/battle | action 404（无动作帧）
pet_000484 | 迷迷箱怪               | overlay | default 200/45943B/256px/capture-2026-09-27 | battle 200/145683B/battle | action 200/459675B
pet_000486 | 加油海葵               | overlay | default 200/45961B/256px/capture-2026-09-27 | battle 200/148454B/battle | action 404（无动作帧）
pet_000487 | 加油蟹（两只海葵的样子）       | overlay | default 200/54670B/256px/capture-2026-09-27 | battle 200/171282B/battle | action 404（无动作帧）
pet_000488 | 守夜烛                | overlay | default 200/47460B/256px/capture-2026-09-27 | battle 200/147314B/battle | action 404（无动作帧）
pet_000489 | 流明坎德拉              | overlay | default 200/56515B/256px/capture-2026-09-27 | battle 200/178786B/battle | action 404（无动作帧）
pet_000490 | 烟花团                | overlay | default 200/68443B/256px/capture-2026-09-27 | battle 200/219536B/battle | action 404（无动作帧）
pet_000491 | 烟花伯爵               | overlay | default 200/77513B/256px/capture-2026-09-27 | battle 200/246513B/battle | action 404（无动作帧）
pet_000492 | 咕咕帽                | overlay | default 200/52575B/256px/capture-2026-09-27 | battle 200/162145B/battle | action 404（无动作帧）
pet_000493 | 咕德帽帽               | overlay | default 200/54402B/256px/capture-2026-09-27 | battle 200/169006B/battle | action 404（无动作帧）
pet_000494 | 稻草人                | overlay | default 200/49702B/256px/capture-2026-09-27 | battle 200/156940B/battle | action 404（无动作帧）
pet_000495 | 稻草守护者              | overlay | default 200/59689B/256px/capture-2026-09-27 | battle 200/189279B/battle | action 404（无动作帧）
pet_000496 | 优优                 | overlay | default 200/56661B/256px/capture-2026-09-27 | battle 200/179181B/battle | action 404（无动作帧）
pet_000497 | 绒光优优               | overlay | default 200/43658B/256px/capture-2026-09-27 | battle 200/136572B/battle | action 404（无动作帧）
pet_000498 | 蜜果骸                | overlay | default 200/60292B/256px/capture-2026-09-27 | battle 200/187973B/battle | action 404（无动作帧）
pet_000499 | 半朽蜜果灵              | overlay | default 200/54868B/256px/capture-2026-09-27 | battle 200/169112B/battle | action 404（无动作帧）
pet_000500 | 小鼓象                | overlay | default 200/73537B/256px/capture-2026-09-27 | battle 200/237668B/battle | action 404（无动作帧）
pet_000501 | 巨鼓象                | overlay | default 200/77065B/256px/capture-2026-09-27 | battle 200/254106B/battle | action 404（无动作帧）
pet_000502 | 咬咬小子               | overlay | default 200/66489B/256px/capture-2026-09-27 | battle 200/214111B/battle | action 404（无动作帧）
pet_000503 | 胡桃王子               | overlay | default 200/51816B/256px/capture-2026-09-27 | battle 200/167928B/battle | action 404（无动作帧）
pet_000504 | 足尖元件               | overlay | default 200/72739B/256px/capture-2026-09-27 | battle 200/229290B/battle | action 404（无动作帧）
pet_000505 | 离心舞者               | overlay | default 200/44651B/256px/capture-2026-09-27 | battle 200/145578B/battle | action 404（无动作帧）
pet_000506 | 猴麦仔                | overlay | default 200/49797B/256px/capture-2026-09-27 | battle 200/161492B/battle | action 404（无动作帧）
pet_000507 | 音碟吼                | overlay | default 200/59105B/256px/capture-2026-09-27 | battle 200/192695B/battle | action 404（无动作帧）
pet_000508 | 钨丝贝贝               | overlay | default 200/74488B/256px/capture-2026-09-27 | battle 200/237262B/battle | action 404（无动作帧）
pet_000509 | 辉光幕机               | overlay | default 200/77291B/256px/capture-2026-09-27 | battle 200/251362B/battle | action 404（无动作帧）
pet_000510 | 机幕方舟               | overlay | default 200/71813B/256px/capture-2026-09-27 | battle 200/236055B/battle | action 404（无动作帧）
pet_000511 | 炫光迪迪               | overlay | default 200/60923B/256px/capture-2026-09-27 | battle 200/195128B/battle | action 404（无动作帧）
pet_000512 | 霹雳迪迪               | overlay | default 200/63427B/256px/capture-2026-09-27 | battle 200/207154B/battle | action 404（无动作帧）
pet_000513 | 鸭吉吉（起来鸭）           | overlay | default 200/48701B/256px/capture-2026-09-27 | battle 200/140948B/battle | action 404（无动作帧）
pet_000515 | 火红尾                | overlay | default 200/48344B/256px/capture-2026-09-27 | battle 200/152823B/battle | action 404（无动作帧）
pet_000516 | 雅丹鬃                | overlay | default 200/55917B/256px/capture-2026-09-27 | battle 200/178639B/battle | action 404（无动作帧）
pet_000530 | 苞米仔                | overlay | default 200/66547B/256px/capture-2026-09-27 | battle 200/213909B/battle | action 404（无动作帧）
pet_000531 | 炮米花                | overlay | default 200/57091B/256px/capture-2026-09-27 | battle 200/182795B/battle | action 404（无动作帧）
pet_000532 | 幽影树（突变的样子）         | overlay | default 200/61471B/256px/capture-2026-09-27 | battle 200/199622B/battle | action 404（无动作帧）
pet_000534 | 钻石蜗（西瓜碧玺的样子）       | overlay | default 200/85953B/256px/capture-2026-09-27 | battle 200/274432B/battle | action 404（无动作帧）
pet_000535 | 彩虹独角兽              | overlay | default 200/59405B/256px/capture-2026-09-27 | battle 200/192802B/battle | action 404（无动作帧）
pet_000536 | 叶冕魔力猫              | overlay | default 200/48455B/256px/capture-2026-09-27 | battle 200/154539B/battle | action 404（无动作帧）
pet_000537 | 蹦蹦果（海神球形态）         | overlay | default 200/71038B/256px/capture-2026-09-27 | battle 200/228489B/battle | action 404（无动作帧）
pet_000538 | 奇丽果                | overlay | default 200/60910B/256px/capture-2026-09-27 | battle 200/192776B/battle | action 404（无动作帧）
pet_000539 | 鸭吉吉国王（蓬松的样子）       | overlay | default 200/51388B/256px/capture-2026-09-27 | battle 200/166493B/battle | action 404（无动作帧）
pet_000541 | 迷嶂布莱克              | overlay | default 200/72980B/256px/capture-2026-09-27 | battle 200/240538B/battle | action 404（无动作帧）
pet_000543 | 圣水守护               | overlay | default 200/86523B/256px/capture-2026-09-27 | battle 200/284056B/battle | action 404（无动作帧）
pet_000544 | 神谕鲨                | overlay | default 200/57568B/256px/capture-2026-09-27 | battle 200/183204B/battle | action 404（无动作帧）
pet_000545 | 千棘海针               | overlay | default 200/63085B/256px/capture-2026-09-27 | battle 200/202212B/battle | action 200/588756B
pet_000547 | 霜翼领主               | overlay | default 200/49544B/256px/capture-2026-09-27 | battle 200/155444B/battle | action 404（无动作帧）
pet_000548 | 女王蜂                | overlay | default 200/57245B/256px/capture-2026-09-27 | battle 200/180577B/battle | action 200/502930B
pet_000549 | 恶魔狼王               | overlay | default 200/55693B/256px/capture-2026-09-27 | battle 200/176997B/battle | action 404（无动作帧）
pet_000550 | 烈火战神               | overlay | default 200/78740B/256px/capture-2026-09-27 | battle 200/257951B/battle | action 404（无动作帧）
pet_000551 | 风暴战犬               | overlay | default 200/59015B/256px/capture-2026-09-27 | battle 200/190061B/battle | action 404（无动作帧）
pet_000552 | 幻影荆棘               | overlay | default 200/66562B/256px/capture-2026-09-27 | battle 200/207961B/battle | action 404（无动作帧）
pet_000553 | 波普鹿                | overlay | default 200/62131B/256px/capture-2026-09-27 | battle 200/194262B/battle | action 404（无动作帧）
pet_000554 | 圣剑骑士               | overlay | default 200/69075B/256px/capture-2026-09-27 | battle 200/226240B/battle | action 404（无动作帧）
pet_000555 | 伊兰龙                | overlay | default 200/73448B/256px/capture-2026-09-27 | battle 200/233908B/battle | action 404（无动作帧）
pet_000558 | 圣光迪莫               | overlay | default 200/43181B/256px/capture-2026-09-27 | battle 200/134148B/battle | action 404（无动作帧）
pet_000559 | 圣草迪莫               | overlay | default 200/56231B/256px/capture-2026-09-27 | battle 200/171462B/battle | action 404（无动作帧）
pet_000560 | 圣火迪莫               | overlay | default 200/105920B/256px/capture-2026-09-27 | battle 200/343650B/battle | action 404（无动作帧）
pet_000561 | 圣水迪莫               | overlay | default 200/72056B/256px/capture-2026-09-27 | battle 200/232778B/battle | action 404（无动作帧）
pet_000595 | 宝藏小狐               | overlay | default 200/64159B/256px/capture-2026-09-27 | battle 200/200089B/battle | action 404（无动作帧）
pet_000596 | 宝藏沙狐               | overlay | default 200/63712B/256px/capture-2026-09-27 | battle 200/202889B/battle | action 404（无动作帧）
pet_000601 | 圣凯布米龙              | baseline | default 200/508803B/384px/策展(48槽) | battle 200/508803B/策展 | action 200/541704B
pet_000608 | 银月狼王               | baseline | default 200/534847B/384px/策展(48槽) | battle 200/534847B/策展 | action 200/551378B
pet_000611 | 月使鹭纳               | baseline | default 200/510703B/384px/策展(48槽) | battle 200/510703B/策展 | action 200/549141B
```

（同内容文本文件：`tmp/coverage-audit/a-art-list.txt`；B 的逐只判定：`tmp/coverage-audit/b-play-list.txt`。）
