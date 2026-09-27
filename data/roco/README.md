# data/roco/ 分层

> 索引页。2026-09-27 实测：**158 个文件 / 62.3 MB**（其中 `assets/` 45.8 MB）。
> 目录审阅（含"同名不同物"等坑）见 `docs/roco/REPO-LAYOUT-REVIEW.md`。

| 层 | 是什么 | 谁在读 | 纪律 |
|---|---|---|---|
| `raw/` | 上游原始快照（wiki 归档、社区接口抓包 `raw/hke-2026-09-27/`） | 生成器 | **只读**；体积大的进 `.gitignore`；许可未确认的标 `REFERENCE_ONLY` |
| `normalized/` | **唯一一份**可用的归一化图鉴（`roco-world-s4-2026-09-10/`：622 图鉴 / 技能 / 学习表 / 相性 / 术语） | 引擎 + 教练 + 判据 | **不许**混进外部抓包；改它要跑对应判据 |
| `derived/` | 派生产物（`hke-2026-09-27/` 社区图鉴层 547 只） | 教练（进化/技能清单） | 必须**可复算**（生成器带 `--check`）+ 带 manifest 写清来源与许可 |
| `evidence/` | 台账（每条结论的来源、等级、引文） | 教练（依据等级）+ 判据 | 只增不改；改要留 superseded |
| `owned/` | 玩家拥有（48 实例） | 盒子 / 配对 | 人类拍过"重复的删掉"，schema 里钉着 `max_same_species_groups: 0` |
| `systems/` | 规则表（性格/天分那几张） | `src/coach/talent.js` | 数字只从这里来 |
| `assets/` | 贴图（宠物立绘等） | 页面 | 体积大，别在判据里全量读 |

⚠ 两处**同名不同物**（审阅点名）：`normalized/<ruleset>/layer-playable-48/*.json` 与父目录同名文件不是一份东西；
`data/roco/{conflicts.jsonl,lineup-legality.jsonl}` 这类平铺文件没有归属层。
