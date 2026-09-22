# RC-501 保留资产复验（不许静默退化）

> 脚本：`scripts/roco/revalidate-retained-assets.mjs`（`--check` / `--selftest`）
> 产物：`reports/roco/rc501/revalidation.json`
> 门禁：第 **19** 个套件 `retained-assets`（跑的是 `--check --selftest`）

## 为什么需要它

v3 红线写着一句：「**不得重写或退化**现有 Agent / RAG / Memory / 军师·老师·陪练三角色 /
game adapter / mock host / stale-result guard / release guard」。问题在于「保留」这两个字
**本身没有牙**：一个资产可以在之后的某一轮里悄悄失去它的判据 —— 脚本被删掉、产物不再生成、
从套件清单里掉出去、或者它压根没有「怎么才会红」的说法 —— 而**没有任何东西会红**，
因为「没红」和「没在跑」在 CI 里长得一模一样。

这个仓库真的吃过一次同形的亏（第 39 轮：`model-arm-identity.test.js` 与
`intervention-agreement.test.js` 从来没进过 `test:unit` 的显式清单，等于两条守卫从来没跑过）。

所以每一条保留资产必须同时具备四样东西，**缺一样就判红**：

| 要件 | 判据 |
|---|---|
| ① 判据 | 那个脚本/测试文件真的在磁盘上 |
| ② 接线 | 它真的被**会跑的入口**收着：套件必须在**门禁脚本自己**的清单里（不是「最近一次产物里有」——门禁有 `--quick`，产物天然会缺套件）；`test:unit` 的文件必须在**显式清单**里；npm 脚本必须真的存在。另外若最近一次产物里也有它，那一次必须是绿的 |
| ③ 证据 | 机器可读产物在场，且满足声明的那一类断言（见下表）+ **条数下限**（判据被删掉一半要红） |
| ④ 必红方向 | 要么判据脚本带 `--selftest` 这类反证入口，要么报告里有「负数样本」，要么那份报告**自己声明了每条阈值都能红**（`criteria_can_fail`） |

## 断言闭集（不是一段任意脚本）

`exists` / `verdict_pass` / `zero_failed` / `all_ok` / `batch_zero_failed` /
`all_values_true` / `gate_zero_violations` —— 每个都是一个小而明确的形状判断，
取值一律走**点号路径**（`grader.negative` 这种嵌套字段直接写路径）。

## 13 条保留资产（当前全绿）

| 资产 | 判据 | 证据 | 必红方向 |
|---|---|---|---|
| Agent 轨迹与工具协议 | 套件 `trajectories` | 三层批次逐条零失败（structural / replay / grader.positive） | `--selftest` + **17760 条负数样本全被抓到** |
| RAG 证据 | 套件 `rag-eval` | held-out 评测产物 | 测试里「冲突弃答」那一路 |
| Memory（偏好） | `tests/companion.test.js` | — | 偏好相关用例 |
| 军师（主动提示） | 套件 `plan-e2e` | demo-acceptance 119/0 | 真实键鼠报告的反证全命中 |
| 陪练（小芽） | `npm run roco:companion-nonintrusion` | 三个阈值门全过 | 报告自己声明 `*_can_fail` 全 true |
| 老师（局末复盘） | `tests/evals/teacher-review.test.js` | — | 局面回合复盘用例 |
| game adapter | `tests/evals/roco/game-adapter.test.js` | 浏览器适配验收零失败 | 「编数字/编动作都会被丢掉」用例 |
| mock host | `tests/evals/roco/mock-host-integration.test.js` | — | 「缺能力拒绝装配」用例 |
| stale-result guard | `tests/roco-experience.test.js` | demo-acceptance 119/0 | 「版本对不上就作废」用例 |
| release guard | 套件 `guard-selftest` | — | 注入真实违规的脚本本体 |
| PVP 门控 | `tests/roco-standard-pvp-battle.test.js` | 工作台浏览器验收逐条全过 | 真实键鼠报告的反证全命中 |
| 用户 P0 页面能力 | 套件 `roco-ux-acceptance` | 39 条真实键鼠判据逐条全过 | 报告的反证全命中 |
| 介入层硬门控 | `tests/evals/roco/intervention-agreement.test.js` | 门控 50/50 命中、门控窗口里开口 **0** 次 | 「不许把点估计写成区间」用例 |

## 自检（9 条必红方向，`--selftest`）

证明这一层不是恒绿 —— 逐条构造坏输入，判据必须报问题：

1. 判据文件不存在；
2. 判据文件在、但**不在** `test:unit` 的显式清单里（第 39 轮那个真缺陷）；
3. 套件掉出**门禁脚本**的清单；
4. 套件最近一次跑成红的；
5. 判据条数下限被抬到 10 万（证明下限真的在比）；
6. 批次里有 `failed > 0`；
7. 没有声明必红方向；
8. 必红方向的字段期望值**写反**；
9. 负数样本数低于下限（样本太少，证明不了「能红」）。

## 如实边界

- 这里验的是「这条资产**还在被判据守着**」，不是「它的行为一定对」——行为对错由各自的判据负责。
- 证据产物是**最近一次**跑出来的：产物陈旧（引擎改了但没重跑）这一层看不出来；
  阻挡那种情况的是各套件自己的判据，这一层只防「被悄悄摘掉」。
- `min_checks` 是**手写下限**，不是自动推导：判据被删到只剩一半会红，删几条看不出来。
- 「负数样本全过」证明的是**判据能红**，不证明负样本覆盖了所有坏法。
