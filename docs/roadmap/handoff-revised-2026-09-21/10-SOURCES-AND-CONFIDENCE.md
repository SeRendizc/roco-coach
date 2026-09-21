# 外部来源与规则置信度矩阵

> 时间：2026-09-21。优先官方公告与录制实机证据；BWIKI、攻略与社区实测用于建立候选规则；冲突项保持 unknown。统一等级：`OFFICIAL_CURRENT / RECORDED_IN_GAME / COMMUNITY_CURRENT / CROSS_SOURCE_SUPPORTED / ENGINE_HYPOTHESIS / UNKNOWN`。

**重要订正**：网页“当前可见”不等于官方真值。BWIKI 的数量与条目可以标 `COMMUNITY_CURRENT`，不能仅因更新时间新就标 `VERIFIED_CURRENT_PUBLIC_DATA`。只有官方材料或项目自己保存的可复核实机 case 才能直接 promotion 为 current rule。

## 1. 当前版本

官方 TapTap 显示 S4「月涌狂想」于 2026-09-10 开启，赛季持续至 2026-11-05 附近；更新公告提到客户端 1.111。

来源：

- https://www.taptap.cn/app/188212/topic?page=3&type=official
- https://www.taptap.cn/moment/843861121864568519

置信：`OFFICIAL_CURRENT`

## 2. 当前技能规模

BWIKI 2026-09-09：

```text
579 个战斗技能
18 个系别
物攻 199 / 魔攻 159 / 防御 54 / 状态 167
应对 77 / 印记 43 / 先手 10 / 离场 24 / 天气 9
迅捷 8 / 传动 14 / 打断 8 / 其他
```

来源：https://wiki.biligame.com/nrc/技能图鉴

置信：`COMMUNITY_CURRENT`

注意：仓库 824 skill records 与这 579 个“当前战斗技能”不是可直接等同的统计口径，必须 diff。

## 3. 当前特性规模

BWIKI 2026-09-09：

```text
242 个公开特性
关联 621 个精灵形态
```

来源：

- https://wiki.biligame.com/nrc/特性图鉴
- https://wiki.biligame.com/nrc/特性列表

置信：`COMMUNITY_CURRENT`

注意：仓库 frozen catalog 是 622 records。先做 ID diff，不删数据凑 621。

## 4. 迅捷

BWIKI 小鹬页面说明：迅捷通过主动更换精灵入场时，使用第一个能量满足要求并带有迅捷的技能。

来源：https://wiki.biligame.com/nrc/小鹬

置信：`COMMUNITY_CURRENT`

工程影响：主动换入、技能槽有序、自动注入动作、能量合法性。

## 5. 印记

BWIKI：精灵下场后印记不消失，新入场继承；最多同时 1 种正面和 1 种负面印记。

来源：https://wiki.biligame.com/nrc/印记

置信：`COMMUNITY_CURRENT`

工程影响：mark 更像 SideState，不是普通 Pet buff。

## 6. 属性倍率

当前 BWIKI 条目可观察到 ×3、×2、×0.5、×0.25。

示例：

- https://wiki.biligame.com/nrc/深渊罗隐
- https://wiki.biligame.com/nrc/溯源钟

置信：`COMMUNITY_CURRENT`

不要沿用旧资料里“所有双弱 ×4”。

## 7. 能量

当前仓库：

```text
ENERGY_MAX=6
END TURN +1
initial=2
```

仓库自己标 HYPOTHESIS。

外部资料多处支持常规上限 10、聚能 +5；当前 BWIKI 还存在能耗 8 技能、“立即回复 10 能量”“突破能量上限”等文本。

参考：

- https://zhuanlan.zhihu.com/p/2040741873246024568
- https://www.douyin.com/video/7489841837251857673
- https://wiki.biligame.com/nrc/技能图鉴
- https://wiki.biligame.com/nrc/特性图鉴

当前判定：

```text
常规 max=10：CROSS_SOURCE_SUPPORTED
聚能 +5：CROSS_SOURCE_SUPPORTED
默认回合末 +1：ENGINE_HYPOTHESIS，且被多源材料反驳
首次入场具体能量：需实机/更强一手证据
```

开发要求：P0 建 candidate ruleset、双规则对照和实机 microcase；没有 RECORDED_IN_GAME/官方证据前不直接 promotion。

## 8. 应对 / 先手 / 换人 / 速度

可以确认：应对是真实核心机制、技能存在先手 +1、主动换精灵是战斗动作、速度参与同层级先后。

社区实测常概括：

```text
应对 > 换宠 > 先手 > 速度
```

但严格总排序本轮未找到同等强度官方文字。

```text
mechanisms existence = COMMUNITY_CURRENT / CROSS_SOURCE_SUPPORTED
strict total order = ENGINE_HYPOTHESIS / NEEDS_MICROCASE
speed tie = UNKNOWN
```

## 9. 离场语义

当前特性页面明确：“离场”包括主动更换或触发脱离效果，不包括力竭后下场。

示例：https://wiki.biligame.com/nrc/邪眼巨魔

置信：`COMMUNITY_CURRENT`

工程影响：`ACTIVE_SWITCH != SKILL_LEAVE != FAINT_REPLACEMENT`。

## 10. 特性复杂度

当前特性列表已包含入场、离场、回合结束、每受到攻击、克制后、按技能系别、按队伍组成、能量上限突破、迅捷赋予、印记、连击等。

说明全量精确模拟的主要工作量在 trigger/effect semantics，不是 pet table 行数。

## 11. 官方 AI “斯嘉丽”

官方 Bilibili 账号 2026-08-07 发布“智能配队 AI 伙伴「斯嘉丽」”。

来源：https://www.bilibili.com/video/BV1iMuh66EiP/

置信：`VERIFIED_OFFICIAL`

产品含义：“AI 配队助手”不能作为本项目唯一创新点。旗舰项目必须展示局中决策、主动触发、规则可验证、训练与评测。

## 12. BattleMode 必须参数化

官方 2026-09 领地试炼公告存在 2v2、特性共享、首领信物/首领化。

来源：

- https://www.taptap.cn/moment/849700086890891385
- https://www.taptap.cn/moment/809020453778620585

说明 `team_size / active_count / trait_sharing / boss_form` 不应全硬编码成一种 PVP 模式。

## 12.1 标准 PVP 六宠、魔力与可见性

已核到的证据分层如下：

```text
官方极速对决：3v3、2 点魔力 = OFFICIAL_CURRENT（限时活动模式）
官方 PVP 更新：随机精灵最多携带 6 只 = OFFICIAL_CURRENT
标准 PVP 六宠、通常 4 点魔力、力竭通常 -1 = CROSS_SOURCE_SUPPORTED
匹配前未知对手 = PRODUCT_CONTEXT / 待实机录屏固定
进入对局后可看对方精灵 = COMMUNITY_CURRENT / 待实机录屏固定
```

来源：

- https://www.taptap.cn/moment/838434682965067210
- https://news.17173.com/content/03182026/104940843.shtml
- https://www.gameres.com/forum/t/917446
- https://github.com/AofeiLi-code/rocom-data
- https://www.taptap.cn/moment/808879358071540062

工程结论：标准闪耀大赛、极速对决、领地试炼必须使用不同 `BattleMode`。在录制标准 PVP 的编队、匹配、开场、力竭和结算 microcase 前，不把 4 点魔力写成官方已确认事实。

## 13. 养成相关

当前精灵条目广泛展示性格、个体资质、特长、血脉技能来源、种族六维、首领形态；条目还明确出现“一般般的天分无法获得特长”。

示例：

- https://wiki.biligame.com/nrc/罗隐
- https://wiki.biligame.com/nrc/加尔

置信：`COMMUNITY_CURRENT`

具体面板换算公式仍需独立校准，不因字段存在就自造换算。

## 14. Repo 内部事实源

开发时优先读：

```text
docs/roco/PROGRESS.md
docs/roco/FULL-CATALOG.md
docs/roco/COVERAGE-LAYERS.md
docs/roco/EFFECT-PRIMITIVES.md
docs/roco/GAME-ADAPTER.md
docs/roco/COACH-ADVICE-DESIGN.md
reports/roco/
```

本轮检查到的关键事实：

```text
L1 frozen catalog: 622
current Roco UI: 48-pet pool
candidate L2 roster: 60
effect inventory: ~68 primitive categories
local model: Qwen3.5-4B family
stale plan guard + mock host + release guard already implemented
```

每次施工前从当前 HEAD 重新验证。
