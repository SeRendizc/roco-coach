# reports/roco/ 里哪些是结论、哪些是一次性

> 索引页。2026-09-27 实测：**89 个子目录 + 64 个平铺文件**，合计约 458 个文件 / 100.8 MB。
> 目录审阅（含"被引用/未被引用"的粗算）见 `docs/roco/REPO-LAYOUT-REVIEW.md`。

## 入库规矩（`.gitignore` 已经在执行）

- **每次跑都变的不入库**：`*-run.json`、`reports/roco/**/*.png`、`reports/roco/verification/failures/`、
  `local-model/*.log|*.pid|responses.jsonl`、`trajectories/*.jsonl`（只留 manifest）。
- **结论入库**：`verification/{latest,last-green}.json`、各套件的 `*.json` 计数与判据原文、
  `hke-reconcile.{md,json}`、`layout-review/manifest.json`、`difficulty-holdout.json`。

## 常看的几个

| 文件 | 是什么 |
|---|---|
| `verification/last-green.json` | **最近一次全绿**的门禁（27 套的名单 + head + 时间）——"门禁绿了吗"看它 |
| `verification/latest.json` | 最近一次跑的（可能是红的），失败套件的 tail 在这里 |
| `answer-speak-probe.json` | 真机问句探针（14 条：正文黑话 / 加点退役 / 进化） |
| `hke-reconcile.md` | 小黑盒抓包 ↔ 仓内 622 的逐只对账（含"下一轮抓哪些 id"） |
| `box-acceptance/browser-box-acceptance.json` | 盒子真机 30 判据 + 12 反证的原文 |
| `layout-review/manifest.json` | 版式取景器的产物清单（图不入库，可重跑 `shoot-layout.mjs`） |
