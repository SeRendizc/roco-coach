# reports/roco/product-execution/01/ · 产物索引（**先读这一页**）

分计划 01（公开观察与决策快照契约）。**哪些读数算数、哪些已经作废**，逐条写在这里 ——
本轮我有三次探针写错并产出了**假绿读数**，作废件必须标出来，否则后人会拿它当证据。

## 权威读数（引用这些）

| 文件 | 是什么 | 关键数字 |
|---|---|---|
| `recon.md` | 01 的只读勘察报告（三条协议现状、缺口清单、实施清单、冲突登记、不确定点） | — |
| `step-log.md` | 01 步骤 A/B 的改动日志 + 那 3 条「新红」的定位 + **我写错的四处自查** | — |
| `raw-align-verified-before.json` | 改动前：泄漏与后备键集（**最终口径**） | 对手技能 UI 可见回收率 **0.75** |
| `raw-align-verified-after.json` | 改动后：同上 | **0.00**；`ui.legal` 只剩 `player` |
| `raw-legacy-athead.json` / `raw-legacy-withchange.json` | 六局 + 短局的 F1–F5 指纹对照（证明只动观察载荷、不动结算） | F1/F2/F3 六局全同；仅 F4/F5 变 |
| `raw-golden-athead.json` / `raw-golden-withchange.json` | 黄金指纹改钉用的精确值 | — |
| `raw-fields.json` | 三条协议顶层/逐行键名（recon §1 的依据） | — |
| `raw-foe-legal-leak.json` | 六宠**镜像队伍**下 `ui.legal.enemy` 的回收率 | 1.000（9/9）——见下方警告 |
| `raw-leaks.json` | 隐藏真值扫描 + 不变性预演 Q1–Q4 | — |
| `raw-event-seq-baseline.txt` | `state_version` 唯一写入点 + 恒等于 `len(state.events)` | — |
| `unittest-after-01AB.txt` | 全量 Python 套件日志 | Ran 847 · 2 failures（均为 00 既有欠账） |
| `regression-rebuild.log` | 回归产物重建日志 | exit=0 |

### 01.2 / 01.3 / 01.6（引擎侧 + Node 转发，2026-09-30 傍晚）

| 文件 | 是什么 | 关键数字 |
|---|---|---|
| `01.3-reveal-and-contract.md` | **本轮的读数与证据主文**（契约字段 / 开局预览事件 / 01.6 反例 / 指纹处置 / Node 转发 / 未做项） | — |
| `raw-contract.json` | 契约字段探针（`match_id`/`rules_version`/`decision_id`/`event_seq`） | 三面同源 `true`；`match_id` 与真实 seed 无关 `true`；同队同规则两局**相同**（已知性质） |
| `raw-preview.json` | 开局预览探针（无预览 / 有预览 / 推进后 / 重复登记） | 无预览：无 `opening_reveal` 键、后备 `['fainted','slot']`；有预览：后备带 `pet_id`+来源、`revealed_skills` |
| `raw-regression-narrowing.json` | 证明「本轮只有 `history` 动」的三次构建对照 | 关掉新块重建 29 场景与磁盘产物**一条不差**；开/关的「剔除 history」指纹 **29/29 相同** |
| `raw-regression-before-after.json` | 回归集重建前后逐场景对照（审计用） | `state_digest_moved=29`（口径本身）·**其它字段 0 个变** |
| `regression-rebuild-01-3.log` / `regression-check-01-3.log` | 收窄 `state_digest` 后的产物重建与校验 | exit=0 / exit=0（`✔ 一致`） |
| `unittest-targeted-01ABCDE.txt` | 定向 5 模块（Lead 指定命令） | **Ran 122 · OK**（基线 99 ⇒ +23 全是新增用例） |
| `unittest-full-01ABCDE.txt` | 全量（收尾树：`TREE 2c5da5f9…`） | **Ran 872 · 1F** · skipped=2（唯一红 = 00 既有欠账 `tier_verdict`） |
| `probe-07-regression-narrowing.py` / `probe-08-regression-before-after.py` | 上面两份对照的**可复跑**探针 | — |

> **作废/不要引用**：`raw-align-*.json` 等三条作废件同上（见下一节）。
> `unittest-after-01AB.txt` 是**步骤 A/B 之前**的那一轮读数，只用于「那 2 条 00 欠账当时就是红的」这条对照。


### ⚠ 关于 `raw-foe-legal-leak.json` 的 1.000

那个 1.000 是**镜像队伍**（对手 = 己方六只的排列）下的读数。它本身没错，但**不可与
`raw-align-verified-*` 的 0.75 直接比较**：镜像队伍下「对手真实配招」与「引擎给的合法技能」
恰好重合。可比的是 `verified-*`（两组**不相交**的六只）。

## 作废件（**不要引用**，保留只为留痕）

以下文件是 `probe-04` / `probe-05` / `probe-06` **早期有缺陷版本**的输出。每一版都产出了
一个看起来正常、实则错误的读数；缺陷与修法记在 `step-log.md` §4。

| 文件 | 作废原因 | 错在哪 |
|---|---|---|
| `raw-align-before.json` / `raw-align-after.json` | 探针 v1：度量只看 `ui.legal.enemy[].skill_id`，那条路径一被删，度量就退化成恒 0 | 度量随被测对象一起消失 |
| `raw-align-before-v2.json` / `raw-align-after-v2.json` | 探针 v2：递归收集器只在 dict 分支判定字符串 ⇒ 恒返回空集 | 度量恒 0（假绿） |
| `raw-align-before-v3.json` | 探针 v3：控件拿真实配招 id 注入，被 `- own_all` 扣掉 ⇒ 控件自己失真 | `metric_can_detect_leak=False` |

> 判定真伪的最短路径：权威件的 `A_foe_loadout_recovery.control.metric_can_detect_leak`
> 必须是 `true`。作废件的这一格是 `false`（或压根没有这一格）。
>
> `raw-legacy-*.json` 与 `raw-golden-*.json` **不在**作废清单里：它们由 `probe-05` /
> `probe-06` 产出，那两支脚本没被改过。唯一要留意的是 `probe-05` 里
> `short_scripted` 那一段用的是**近似**夹具（不是测试真正的 `_fresh_state` +
> `pick_action`），所以它的短局指纹只可用于「同脚本内 A/B 比较」，
> **绝对值不可用于改钉** —— 改钉用的绝对值由 `probe-06` 与测试自身助手给出。

## 探针（可复跑）

```sh
cd /Users/serendizc/Developer/roco-coach/roco
PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-01-fields.py          # 三条协议键名
PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-02-leaks.py           # 隐藏真值扫描
PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-03-foe-legal.py       # 镜像队伍回收率
PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-04-align-before-after.py <标签>  # ★ 口径对齐前后对照
PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-05-legacy-evidence.py <标签>      # 结算 vs 观察载荷
PYTHONPATH=src python3 ../reports/roco/product-execution/01/probe-06-golden-digests.py <标签>       # 黄金指纹精确值
```

`probe-04/05/06` 的 `<标签>` 决定输出文件名（`raw-align-<标签>.json` 等），
所以要复现上面的权威件，用标签 `verified-before` / `verified-after` / `athead` / `withchange`。
