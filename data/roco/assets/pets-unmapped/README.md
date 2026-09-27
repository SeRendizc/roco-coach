# 未归属立绘（名单外）

- `pet-unnamed-云灵-{default,action}.png`：2026-09-23 立绘对齐审计中发现的多余资产。
  它是深蓝/黑的小云灵（大发光黄眼、周身白云、头顶金环、金色闪电），48 条名单里没有对应名字，
  游戏数据（`roco/raw/extracted/rocom-data/data/sprites.json` 1132 个名字）里也搜不到「云灵」。
- 同时，名单第 25 槽「蹦蹦种子」在素材集里**没有**立绘（素材集从第 25 张起整体错位一格，
  多出来的正是这张云灵）。所以槽 25 现在故意没有图片文件：战斗页 `img.onerror` 会留空，
  不画占位、不猜（见 `src/client/roco.js` 的 `data-b3-sprite="none"`）。
- 补图后把两张文件改名成 `pet-25-蹦蹦种子-{default,action}.png` 放回 `data/roco/assets/pets/`，
  再跑 `node scripts/roco/verify-pet-sprites.mjs --write` 更新摘要即可。
