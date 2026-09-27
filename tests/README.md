# tests/ 怎么找、怎么加

> 这一页是**索引**，不是判据。2026-09-27 实测：本目录下 **119 个 `.test.js` 平铺在根上**（外加 `evals/` 子目录）。
> 目录审阅见 `docs/roco/REPO-LAYOUT-REVIEW.md`。

## 三条纪律（比找文件更重要）

1. **新判据必须注册**：`tests/evals/structure-contract.test.js` 会检查「每个 Node 测试文件都被某个 npm script 引用」——
   新加一个 `*.test.js` 之后，**必须**把它加进 `package.json` 的 `test:unit`（或 `guard-selftest.mjs` 的登记表），
   否则那条结构判据会红（实测踩过）。
2. **判据与反证共用一份纯函数**：同一个文件里既跑真判据、也喂坏样本（"必红方向"），
   不许把判据写两遍（写两遍必然漂）。
3. **静态判据会假绿**：只查字符串的判据抓不到"函数没定义""页面没接线"（本仓真踩过三次）。
   能跑行为就跑行为（真调那一层、看输出），静态只是补充。

## 命名约定（按被验对象取名）

| 前缀 | 验什么 | 例 |
|---|---|---|
| `roco-*.test.js` | 手游那一档（622 图鉴 / 盒子 / 工坊 / 教练） | `roco-box.test.js`、`roco-ask-coverage.test.js` |
| 无前缀（`engine` / `rules` / `coach`…） | 练习引擎那一档与教练核心 | `rules.test.js`、`coach.test.js` |
| `evals/**` | 评测与结构契约（不进单测清单的用各自 npm script） | `evals/structure-contract.test.js` |

## 跑法

```bash
npm run test:unit                # 手工清单（当前 1669 条通过）
node --test tests/roco-box.test.js   # 单跑一个文件
npm run verify:release           # 27 套总门禁（含真机浏览器套件）
```
