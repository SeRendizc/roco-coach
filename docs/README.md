# 小芽 · AI Coach（洛克王国：世界）

> 面向腾讯 IEG 宠物对战 LLM Agent 题的面试项目：**一个嵌在游戏里、自己看局面、只在值得时开口的教练**。
> 核心原则：**就算玩家从不打开聊天，小芽也应有用；玩家越熟练，提示越少可以是成功。**（`docs/COACH-PLAN.md` §1）

## 现在是什么（数字都是实测，可现场复算）

| 项 | 数字 | 怎么复算 |
|---|---|---|
| 图鉴条目 | **622 条** | `node -e "console.log(require('./data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json').pets.length)"` |
| 六维采用抓包的 | **540 只**（522 按 game_id + 18 首领同名） | `full-catalog.json` 的 `provenance.stats_override.matched` |
| **能出战的（可模拟）** | **48 只**（36 冻结层 + 12 基线） | `npm run roco:status`，或数 `layer-playable-48/learnsets.json` |
| 判据 | **157 个文件 / 1714 条** | `npm run test:unit` |
| 发版门禁 | **27 套件**（真实鼠标浏览器验收 + 真实 Python 引擎 + 金标闸门 + 注入自检） | `npm run verify:release` |
| 一条命令看现状 | **`npm run roco:status`**（只读） | —— |

**为什么只有 48 只能出战、"500 多只能不能全做"**：见
[547 只可行性评估](../roadmap/FEASIBILITY-547-ALL.md)（结论：547 只里 **542 只脚本可直接生成**、
5 只要人判形态；数据组装实测 **120.6 毫秒**；真正的卡点是执行引擎目录名写死 + 6 个测试文件把"48"钉死）。

## ⚠ 这份入口文档曾经断档（2026-09-28 修）

它和两份面试材料停在 **2026-09-21**，写的是"14 宠"那一版：只数错、且**完全没提**这七天做的东西
（抓包采用 622/540、四层口径、盒子与个体比较、天分四档、547 可行性评估、金标闸门与注入自检）。
旧文字**改钉保留**在 `docs/roadmap/PROJECT-GOAL-CHECK.md` §2 的对照表里（不删）。
「最近做了什么」那一节的待补清单在同一份文档。

## 优先阅读

- [当前状态](IMPLEMENTATION-STATUS.md) ・ [逐项清单](CHECKLIST.md) ・ [演示与验收](DEMO-ACCEPTANCE.md)
- [目录结构与约定](STRUCTURE.md) ← **新文件该放哪看这份**
- [整体方案](COACH-PLAN.md) ・ [证据与权限](EVIDENCE-SCHEMA.md) ・ [实验报告](EXPERIMENTS.md)
- [面试讲述](INTERVIEW-GUIDE.md) ・ [追问演练](INTERVIEW-DRILL.md) ・ [灵宝调研](LINGBAO-RESEARCH.md)
- [四层口径（种族值 / 资质 / 天分 / 性格）](roco/PET-LAYERS.md) ・ [性格与天分](roco/TALENT-NATURE.md)
- [547 只可行性评估](../roadmap/FEASIBILITY-547-ALL.md) ・ [对照最初目标核对](../roadmap/PROJECT-GOAL-CHECK.md)

## 这一层东西怎么自证

演示服务：`node src/server/index.js` → `http://127.0.0.1:8765/`（盒子页 `/box.html`，培养页 `/nurture.html`）。
自证顺序：`npm run roco:status` → `npm run test:unit` → `npm run verify:release`
（后两条**后台跑，别在前台等**，一条要 3～8 分钟）。

判据的纪律：**只许改钉不许删**（改一条期望必须带日期 + 人类原话 + 原因）；数字只来自引擎/数据层；
缺数据写"未确认"，**不许编**。逐轮台账在 `docs/roadmap/DSH-EXECUTION-STATE.md`（含每轮的"没做到"）。

可提交 PDF 在 `output/pdf/xiaoya-coach-report.pdf`。报告区分实装、实验与未完成项；
检查点不是 DeepSeek 权重，模拟收益不是玩家研究，检索卡片数不是回答质量。
