# 分计划 00 验收（步骤 00.1–00.6）

## 一条最硬的读数
- **427 条技能并集：档位 ↔ 判据 打架 = 0**（`union-mismatch.txt`）。
- 全量：`Ran 846 · 4 failures + 0 errors`（修复前 `Ran 669 · 2 failures + 83 errors`，12 个模块 import 就挂）。

## 三个独立根因（都实测，非推断）
1. 缺接口族 8 个（交接文档写 5 个）：`b5a8d51` 提交了 `service.py` 新写法、漏了 `coverage.py` 同批写法。
2. `initiative_power['pct']` 硬读：`parse.py:2096` 已支持 `hits` 形状 ⇒ `build_coverage` 必崩。
3. `declared_capabilities_of` 缺 `element_use_ramp` 等新叶子。

## 三段区分（不许含混）
| 栏 | 状态 | 证据 |
|---|---|---|
| code | fixed | `import roco_env.service` 无输出；8 个导出在位 |
| isolated | passed | 自起 `:8899`：health；`battle_new` 200 ok 12 合法动作；`legal` 200 ok 12；`advance` 200 ok，事件 `turn_start/defense/damage`；`kind=skill` 详情 `support_tier=SIMULATABLE_UNVERIFIED` + `mechanics.resolved=True` |
| player | observed_healthy_pending_resident_version | **只读**：`available:true` `health:true` `last_error:null` `roco.html=200`。**未重启** ⇒ 不宣称常驻版本与整局验收 |

## 反例（必红方向，已实测）
- 烟测在**临时副本**里改名 `classify_skill_declared` ⇒ `exit=1`（ImportError）；正常副本 `exit=0`。共享源码与玩家实例未被注入。

## 残余 4 红（未通过，继续修在 00）
见 `result.json` 的 `residual_failures`；其中第 1 条正是"未支持机制不得被当作完整支持"的红线，故 00 记 `in_progress`，不标 passed。
