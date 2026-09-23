# Roco Coach 48 精灵双状态立绘

- `cropped/*-default.png`：待机/默认立绘
- `cropped/*-action.png`：行动中立绘
- 每张 384×512 RGBA PNG
- `manifest.json`：槽位、名字、属性、职责与资源 key
- `sheets/`：12 张原始四宠素材板

资源以 `asset_key` 绑定，不用显示名称做主键。战斗页根据 `pet_id` 切换 `default/action`，行动结算后恢复 `default`。

说明：这是基于项目 48 条练习名单生成的原创概念立绘，不是官方素材复刻。当前数据第 38 与第 48 槽同名“棋契陛下”，已分别使用不同变体 key 保留两个槽位，待规则数据最终确认后再改名或合并。
