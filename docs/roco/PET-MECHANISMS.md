# 精灵「机制首层」（pet-mechanisms）

> 产物：`data/roco/derived/pet-mechanisms.json`（622 只，729 KB）
> 构建：`node scripts/roco/build-pet-mechanisms.mjs`（`--check` 逐字节复核）
> 检查：`node scripts/roco/verify-pet-mechanisms.mjs`（`--selftest` 9 条自带用例）
> 守卫：`tests/roco-pet-mechanisms.test.js`（15 条，含 8 条必红方向）

## 为什么有这个东西

人类在真实试玩后直说：选宠卡片用「最狠一招 + 速度档」当特点**是模板、没意义**；
「看体系的吧」「基本属性为啥不单独拉出来说」「证据不足就写机制资料待确认」。

问题不在排版，在**来源**：那句话是前端现编的，仓库里没有任何地方能核对它。
而冻结数据里其实**有**可核对的机制文字——`full-catalog.json` 每只精灵都有 `feature_skill_id`，
`skills.json` 里 824 条技能/特性**全部**带 `desc`。实测 **622/622** 都能解析到非空 desc，
所以「机制首层」不需要编：把特性/招牌技能的名字与**逐字** desc 摊到卡片第一层即可。

## 字段含义（卡片该怎么读）

| 字段 | 含义 | 玩家层怎么用 |
|---|---|---|
| `feature.name` | 特性/招牌技能名（如「氧循环」） | 卡片首层显示 |
| `feature.desc` | **逐字**冻结 desc（如「使用草系技能后，回复10%生命。」） | 卡片首层显示；检查器比对子串，润色即红 |
| `mechanism_line` | 压成一行的机制文案（≤60 字，只取第一句） | 卡片首层**唯一**允许出现的机制句 |
| `mechanism_status` | `FROZEN_DESC` / `MECHANISM_UNCONFIRMED` | 后者时首层必须显示「机制资料待确认」 |
| `mechanism_tags` | 该精灵学招表里出现过的机制标签及条数（应对/连击/印记/异常/回能…） | 作为「体系」线索；标签只来自冻结 `pack.json`，不新造 |
| `types` / `pet_class` / `stage` | 属性 / 类（猫咪类精灵…）/ 阶段 | 属性与体系分组 |
| `feature.power` + `power_status` | 威力与来源状态 | **只进展开详情**：来源没给就是 `null`，页面不显示、绝不补 0 |
| `unverified[]` | 两条固定说明 | 展开详情里如实写「效果未实机核验」 |

## 三条不许越过的线（都由机器钉住）

1. **逐字**：`feature.desc` 必须是冻结 `skills.json` 那条 desc 的原文子串——改写、润色、翻译、拼接都变红
   （实测反证：把 `-40%` 改成 `40%` ⇒ `[desc_not_verbatim]`；换成**另一条**技能的 desc 也红）。
2. **不知道就说不知道**：解析不到 desc 时 `mechanism_status = MECHANISM_UNCONFIRMED`、
   `feature.desc = null`、`mechanism_line = "机制资料待确认"`；此时若给出任何机制句一律红
   （模板句「速度档 33，最狠一招抓挠」正是被这条挡住的）。
3. **不显示没给的数**：威力来源没给就不进玩家层；`mechanism_line` 里不出现任何数值强度或胜率。

## 如实边界（不要把它读大）

- `summary.feature_resolved = 622` 的意思是「**冻结导入里有非空 desc**」，**不是**「机制已验证」。
  冻结 `skills.json` 自己对每条都写着 `effect_support: unsupported` + 「效果原语未实现」，
  触发条件与时序都没有实机证据；对应 microcase（`MC-E07/E08/E09` 等）**尚未录制**。
- 因此卡片首层是**资料**（「这只精灵的特性文字是什么」），不是**结论**（「它强不强」）。
  强度类口径仍然只能来自 RC-302/303/304，且在没有真实环境分布时必须是 `unknown`。
- `mechanism_tags` 统计的是**学招表里标签出现次数**，是「这只精灵偏什么机制」的线索，
  不是强度排序；标签词表本身来自社区快照（`pack.json` 的 `tags_live`），等级按台账口径是候选。
- 学招表覆盖面：冻结 `learnsets.json` 只覆盖一部分，`learnable_skills` 为空的精灵
  `mechanism_tags` 就是空数组（不是「没有机制」）。

## 与前端/接口的接法（集成时照做）

- 读盘方**只读这份产物**，不要在前端另算一遍（两份判据会各自漂移）。
- 接口层把它附在 roster/box 的**详情**字段里（`mechanism`），列表层只带 `name` + `mechanism_line`
  + `types` + `pet_class` + 基础六维，保证首层不挤。
- 页面首层显示顺序：名字 → 属性 → 体系/定位 → `mechanism_line`；基础面板单独成组；
  四技能、能耗、威力、类别、效果与 `unverified[]` 进展开详情。
