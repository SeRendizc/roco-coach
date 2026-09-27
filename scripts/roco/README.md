# scripts/roco/ 脚本地图

> 索引页。2026-09-27 实测：**123 个 `.mjs` 平铺在根上**（目录审阅：`docs/roco/REPO-LAYOUT-REVIEW.md`）。
> ⚠ **本目录没有任何"每个脚本都被引用"的判据**（结构契约只管 `tests/**`）——
> 也就是说"写了但没人跑"的脚本在这里是可以悄悄堆积的，加脚本时请顺手在下面的表里登记。

## 四类（按用途分，不按字母）

| 类 | 认法 | 例子 |
|---|---|---|
| **真机验收套件** | `browser-*.mjs`，CDP 起 headless Chrome、自己起服务 | `browser-box-acceptance.mjs`（30 判据 + 12 反证）、`browser-mobile-sweep.mjs`（10 + 9） |
| **门禁编排** | `verify-release.mjs`（27 套）、`guard-selftest.mjs`（自检登记表） | 改门禁只改这两个 |
| **产物生成器** | `build-*.mjs` / `eval-*.mjs`，写 `data/roco/derived/**` 或 `reports/roco/**` | `build-hke-layer.mjs`（社区图鉴层）、`eval-rag-retrieval.mjs`（带 `--check`） |
| **排查/取景工具** | 一次性或按需 | `shoot-layout.mjs`（版式截图 + `--measure`）、`probe-answer-speak.mjs`（真机问句探针）、`reconcile-hke-capture.mjs`（抓包对账）、`triage-check-warnings.mjs`（假绿三件套） |

## 三个约定

1. **确定性**：产物生成器要能 `--check`（重算与磁盘逐字节比），不许写挂钟时间进正文。
2. **不越界**：脚本只写**仓库内**（`reports/`、`data/`）；临时目录用 `mkdtempSync`，收尾删 profile 必须带重试
   （裸 `rmSync` 会 ENOTEMPTY，结构契约会红）。
3. **起服务自己起**：验收脚本一律 `createCoachServer()` 监听 0 端口；**不要**去碰 8765/8766/3080 上别人的进程。
