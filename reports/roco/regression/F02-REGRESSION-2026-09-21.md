# F02 全链路回归报告

> 路线图任务：**F02 全链路回归**
> 报告日期：2026-09-21（本机时区 +08:00）
> 规则集：`roco-world-s4-2026-09-10`，快照指纹 `affa4273ae5fb87578d038084e7a30dc6f5e2fd5e59d11049f0aa989c40a1f7a`
> 代码：`git HEAD = b5c245363e44526c6d0482863bfe4bb833e0ee70`（工作区有未提交改动，见 §2.4）
> 原始日志：`reports/roco/regression/logs/*.log`（每条命令一份，真实捕获，未修剪）

**本报告里的每一个数字都来自本轮真实执行的命令。** 没有跑过的命令不写结论；
跑失败的命令把错误原文贴出来，不改测试、不放宽断言。写入范围仅限
`reports/roco/regression/`；`roco/src/`、`src/`、`tests/` 一个字节都没有改动
（见 §2.4 的 `git status` 证据）。

---

## 0. 结论摘要（先看这一段）

| 项 | 结果 |
|---|---|
| 功能 | `npm test`（unit 421 + browser 17/18，1 条件跳过）、`test:smoke` 7/7、`test:bridge` 11、`test:toolbox-roco` 17、`test:plan-e2e` 8、`test:env` 122、浏览器验收 9/9、演示验收 16/16、先导 1000 局 —— **全部通过，0 失败** |
| 失败 | **0 条测试失败**；1 条浏览器用例因局面条件不成立而**按测试自身写好的守卫跳过**（§5.2）；路线图书面命令 `python -m pytest roco/tests` **无法执行**（本机无 pytest，§2.2）；`test:smoke` 有一个未写进 npm 脚本的前置条件（§5.6） |
| P50 / P95 | `/battle/plan` 往返 **P50 36.29ms / P95 57.68ms**（真搜索路径 P50 38.28 / P95 57.68，n=19）；`/battle/advance` **P50 1.89 / P95 2.58ms**（n=30）；`/rules/query` **P50 0.20 / P95 0.26ms**（n=40） |
| 规则覆盖 | 12 只精灵 **全部 `KNOWLEDGE_ONLY`**（0 只可进战斗）；A 组候选配招去重 19 个技能，解析层完全覆盖 3 个（15.8%）；21 条 microcase **通过 0 / 未执行 21** |
| 未支持机制 | 已核实并逐条给出失败方式（§6）：引擎不变量 6 类 + 数值假设 4 类 + 解析器未覆盖标记 9 类 + 服务端 fail-closed 端点 5 类（含 1 处能力声明与实际不符，§5.3） |
| 需要协调者注意 | ① `/battle/plan` 在「只有换人可做」的局面**不搜任何分支**、直接返回 `coverage=1.0` 的换人推荐（§5.1）；② 服务 `/health` 的 `capabilities` 把 `team.evaluate`/`team.compare`/`battle.plan` 报成 `false`，但这三个端点实际可用（§5.3）；③ `NOT_IMPLEMENTED` 是空字典，任何「未实现端点」都落成 `not_found` 而不是 `not_implemented` 501（§5.4）；④ `npm run test:smoke` 依赖外部常驻的 8765 服务，命令本身不自举（§5.6） |

---

## 1. 环境与口径

```text
（原始记录：reports/roco/regression/logs/environment.log）
uname: Darwin serendizc-mbp 27.0.0 Darwin Kernel Version 27.0.0 ... RELEASE_ARM64_T6050 arm64
host: serendizc-mbp        cpus: 15        mem: 51539607552
python3: Python 3.9.6      node: v24.20.0  npm: 11.19.0
chrome : /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
date   : 2026-09-21T03:17:19+08:00
```

口径说明：

- **延迟是单机数字。** 全部采样在 `127.0.0.1` 上、同一台 MacBook 上完成，
  服务是本地 Python 子进程。它们**不是生产环境数字**，也不能外推到任何线上容量规划。
- 所有 Node 测试用 `node --test`，Python 用标准库 `unittest`。
- 每套件的耗时口径分两种，都在日志里：Node 自报 `duration_ms`，以及外层
  `/usr/bin/time -p` 的 `real`（含 Node 进程启动与 npm 包装开销）。
  报告表格用后者（端到端墙钟），并在括号里给 Node 自报值。

---

## 2. 计划命令与实际执行

### 2.1 实际执行的命令（完全一致地照抄自日志第一行）

| # | 命令 | 原始日志文件 | 退出码 | 墙钟 real |
|---|---|---|---|---:|
| 1 | `npm test` | `logs/npm-test.log` | 0 | 158.11s |
| 2 | `python3 -m pytest roco/tests` | `logs/pytest-substitution.log` | **1** | 0.02s |
| 3 | `npm run test:env`（= `cd roco && PYTHONPATH=src python3 -m unittest discover -s tests`） | `logs/npm-run-test-env.log` | 0 | 1.55s |
| 4 | `npm run test:smoke` | `logs/test-smoke.log` | 0 | 20.76s |
| 5 | `npm run test:bridge` | `logs/test-bridge.log` | 0 | 4.00s |
| 6 | `npm run test:toolbox-roco` | `logs/test-toolbox-roco.log` | 0 | 0.23s |
| 7 | `npm run test:plan-e2e` | `logs/test-plan-e2e.log` | 0 | 1.92s |
| 8 | `npm run test:roco-all` | `logs/npm-run-test-roco-all.log` | 0 | 7.93s |
| 9 | `node scripts/roco/browser-acceptance.mjs` | `logs/browser-acceptance.log` | 0 | 19.79s |
| 10 | `node scripts/roco/demo-acceptance.mjs` | `logs/demo-acceptance.log` | 0 | 5.51s |
| 11 | `python3 roco/run_pilot.py --games 1000 --quiet` | `logs/run_pilot-1000.log` | 0 | 21.61s |
| 12 | `python3 roco/run_pilot.py --games 200 --quiet`（冒烟用） | `logs/run_pilot.log` | 0 | 4.29s |
| 12b | `npm run test:roco-experience` | `logs/test-roco-experience.log` | 0 | 0.17s |
| 13 | `node /tmp/f02-latency.mjs <repoRoot> /tmp/f02-latency.json`（`/tmp` 一次性脚本） | `logs/latency-harness.log` | 0 | — |
| 14 | `python3 /tmp/f02-unsupported-probe.py`（`/tmp` 一次性脚本） | `logs/unsupported-mechanism-probe.stdout.log` | 0 | — |

### 2.2 `python -m pytest roco/tests`：命令不可执行（如实报告，不做替代声明）

路线图书面命令是 `python -m pytest roco/tests`。本机**没有 pytest**，且项目规则
禁止安装依赖。原始输出（`logs/pytest-substitution.log` 全文）：

```text
$ python -m pytest roco/tests   # 路线图书面命令（本机无 pytest，预期失败）
# started: 2026-09-20T19:17:19Z
/Library/Developer/CommandLineTools/usr/bin/python3: No module named pytest
real 0.02
user 0.01
sys 0.00
# exit=1 finished: 2026-09-20T19:17:19Z
```

**替代方案（已执行，不是声称）**：Python 测试是标准库 `unittest`，跑法为
`npm run test:env`，它展开成 `cd roco && PYTHONPATH=src python3 -m unittest discover -s tests`。
原始输出：

```text
> test:env
> cd roco && PYTHONPATH=src python3 -m unittest discover -s tests
..........................................................................................................................
----------------------------------------------------------------------
Ran 122 tests in 1.263s

OK
real 1.55
# exit=0
```

即：**122 条 Python 测试全部通过。** 报告里不会出现「pytest 通过」这种说法。

### 2.3 `npm run test:smoke`：跑通，7/7 通过（但有一个未写入命令的前置条件）

`npm run test:smoke` = `node scripts/browser-smoke.mjs`。原始输出全文
（`logs/test-smoke.log`）：

```text
$ npm run test:smoke
# started: 2026-09-20T19:18:24Z

> test:smoke
> node scripts/browser-smoke.mjs

✓ 营地渲染出伙伴卡  (14 张)
✓ 属性筛选真的在过滤
✓ 进入对局
✓ 播放速度已设为最快
✓ 对局能打到结束  (15 次出招)
✓ 过程中没有卡死  (非动画期最长连续无可点 0 次)
✓ 控制台零报错

全部通过
real 20.76
# exit=0 finished: 2026-09-20T19:18:45Z
```

**前置条件是真实的，必须写清楚**：该脚本第 27–29 行先探测
`http://127.0.0.1:8765/api/bootstrap`，探测不到就
`console.error('冒烟测试需要 127.0.0.1:8765 已在运行（npm start）'); process.exit(2)`。
本轮执行时 8765 上已有一个可用的教练服务在响应，所以脚本正常跑完并全绿；
**这不是由本任务启动的**（本任务没有起任何常驻服务），脚本自己不打印它连到的是谁。
换言之：`npm run test:smoke` **在满足前置条件的机器上通过**；
在一台「什么都没起」的干净机器上它会以退出码 2 直接拒绝跑。
这条前置条件没有写进 `package.json` 的脚本里，是本轮发现的一个可改进点（§5.6）。

浏览器端的另两条独立证据（自带 headless Chrome 驱动，不依赖 8765）：

- `node scripts/roco/browser-acceptance.mjs` → `[acceptance] checks 9/9 pass`
- `node scripts/roco/demo-acceptance.mjs` → `结果：16 通过 / 0 失败`

### 2.4 附加单独执行：`npm run test:roco-experience`（不重复计数）

`npm run test:roco-experience` = `node --test tests/roco-experience.test.js`。
这个文件**已经在** `npm run test:unit` 的 23 个文件列表里，所以单独再跑一次
**不增加覆盖**，只作为交叉确认（原始输出 `logs/test-roco-experience.log`）：

```text
> test:roco-experience
> node --test tests/roco-experience.test.js
ℹ tests 9   ℹ pass 9   ℹ fail 0   ℹ skipped 0
real 0.17
# exit=0
```

### 2.5 「没有改代码」的证据

```text
$ git status --porcelain
 M reports/roco/acceptance/04-battle-end.png
 M reports/roco/acceptance/browser-acceptance.json
 M reports/roco/demo-acceptance/01-battle-started.png
 M reports/roco/demo-acceptance/demo-acceptance.json
 M reports/roco/pilot-1000/README.md
 M reports/roco/pilot-1000/manifest.json
 M reports/roco/pilot-1000/metrics.json
?? docs/roco/mvp/            （本任务开始前已存在）
?? reports/roco/regression/  （本报告新增）
?? scripts/roco/build-team-dataset.py   （本任务开始前已存在）
?? scripts/roco/train-team-model.py     （本任务开始前已存在）
```

`roco/src/`、`src/`、`tests/` **零改动**（`git status` 里对这三处的匹配数为 0）。
被改动的 `reports/**` 是第 9、10、11 号命令自己的产物（验收脚本与先导本来就写在那里）。
没有 `git reset` / `git checkout` / `git stash`，没有提交。

---

## 3. 汇总表（命令 → 通过/失败）

| # | 命令 | 测试数 | 通过 | 失败 | 跳过 | 套件自报 duration | real |
|---|---|---:|---:|---:|---:|---:|---:|
| 1a | `npm run test:unit`（`npm test` 第一步，23 个文件） | 421 | **421** | 0 | 0 | 14.91s | — |
| 1b | `npm run test:browser`（`npm test` 第二步，真 Chrome） | 18 | **17** | 0 | **1**（条件守卫） | 142.85s | 158.11s（含 1a） |
| 3 | `npm run test:env`（Python `unittest`） | 122 | **122** | 0 | 0 | 1.263s | 1.55s |
| 4 | `npm run test:smoke` | 7 checks | **7** | 0 | 0 | — | 20.76s（前置：8765 已在跑） |
| 5 | `npm run test:bridge` | 11 | **11** | 0 | 0 | 3.73s | 4.00s |
| 6 | `npm run test:toolbox-roco` | 17 | **17** | 0 | 0 | 0.058s | 0.23s |
| 7 | `npm run test:plan-e2e` | 8 | **8** | 0 | 0 | 1.65s | 1.92s |
| 8 | `npm run test:roco-all`（3+5+6+7 的组合） | 158 | **158** | 0 | 0 | — | 7.93s（不计入合计） |
| 8b | `npm run test:roco-experience`（已含在 1a 内） | 9 | **9** | 0 | 0 | 0.058s | 0.17s（不计入合计） |
| 9 | `browser-acceptance.mjs` | 9 checks | **9** | 0 | 0 | — | 19.79s |
| 10 | `demo-acceptance.mjs` | 16 checks | **16** | 0 | 0 | — | 5.51s |
| 11 | `run_pilot.py --games 1000` | 1000 局 | **1000**（0 非法动作/0 截断/0 异常/0 无结局） | 0 | 0 | 21.488s | 21.61s |
| 12 | `run_pilot.py --games 200` | 200 局 | **200**（同上全 0） | 0 | 0 | 4.166s | 4.29s |
| — | **合计（去重后：1a+1b+3+4+5+6+7，按「用例/检查项」计）** | **604** | **603** | **0** | **1** | — | — |

注：第 8 行是第 3+5+6+7 行的再组合（158 = 122+11+17+8）；第 8b 行的 9 条已包含在 1a 的 421 条里。两者都不重复计入合计。

逐条真实结果行（照抄，未改写）：

```text
[1a] ℹ tests 421   ℹ pass 421   ℹ fail 0   ℹ skipped 0   ℹ duration_ms 14909.741416
[1b] ℹ tests 18    ℹ pass 17    ℹ fail 0   ℹ skipped 1   ℹ duration_ms 142846.716875
[3]  Ran 122 tests in 1.263s
     OK
[4]  全部通过（7 项 ✓）
[5]  ℹ tests 11    ℹ pass 11    ℹ fail 0   ℹ skipped 0   ℹ duration_ms 3865.832667
[6]  ℹ tests 17    ℹ pass 17    ℹ fail 0   ℹ skipped 0   ℹ duration_ms 68.742167
[7]  ℹ tests 8     ℹ pass 8     ℹ fail 0   ℹ skipped 0   ℹ duration_ms 1746.702542
[9]  [acceptance] checks 9/9 pass
[10] 结果：16 通过 / 0 失败；报告见 reports/roco/demo-acceptance/
[11] 完成：1000 场 / 21.5s = 46.5 局每秒
     非法动作 0，截断 0，异常 0，无结局 0
     隐藏字段读取 0
```

---

## 4. 延迟：P50 / P95（真实采样）

### 4.1 采样方法

一次性脚本 `/tmp/f02-latency.mjs`（**放在 `/tmp`，没有进仓库**）通过仓库自带的桥
`src/coach/roco-client.js` 启动真实 Python 服务 `src/server/roco-service.js` →
`roco_env/service.py`（`python3 .../service.py --port 0`），再对真实 HTTP 端点采样：

- **`/battle/plan`（`planActions` 往返）**：n=25。请求体是 `env.public_planner_state()`
  的真实产物（1155–1169 字节），参数 `depth=2, beam=4, analysis_seeds=[11,29,47]`。
- **`/battle/advance`（`battleAdvance`）**：n=30，跨 3 局（seed 20260921…20260923），
  每局用 `player_strategy=greedy_damage` 双方代打，避免人肉出招污染样本。
- **`/rules/query`（rules query）**：n=40，轮询 6 种 kind（pet / skill / learnset /
  term / type_multiplier / ruleset）。

两条延迟都记录：客户端实测往返 `latency_ms`（含 HTTP），以及服务端自测
`service_latency_ms`（不含网络）。原始样本：`logs/latency-samples.json`。

### 4.2 结果（毫秒）

| 端点 | 口径 | n | min | **P50** | **P95** | max | mean |
|---|---|---:|---:|---:|---:|---:|---:|
| `/battle/plan`（planActions 往返） | 客户端往返 | 25 | 0.71 | **36.29** | **57.68** | 57.79 | 31.95 |
| `/battle/plan` — 真搜索结果 | 客户端往返 | 19 | 25.43 | **38.28** | **57.68** | 57.79 | 41.72 |
| `/battle/plan` — 立即返回（无分支可搜） | 客户端往返 | 6 | 0.71 | **0.93** | **1.77** | 1.77 | 1.00 |
| `/battle/plan` | 服务端自测 | 25 | 0.22 | 35.64 | 56.18 | 56.64 | 31.29 |
| `/battle/advance` | 客户端往返 | 30 | 0.78 | **1.89** | **2.58** | 2.82 | 1.87 |
| `/battle/advance` | 服务端自测 | 30 | 0.40 | 1.31 | 2.10 | 2.14 | 1.28 |
| `/rules/query` | 客户端往返 | 40 | 0.17 | **0.20** | **0.26** | 0.58 | 0.22 |
| `/rules/query` | 服务端自测 | 40 | 0.01 | 0.014 | 0.046 | 0.40 | 0.027 |
| `/battle/new`（参考，n=1） | 客户端往返 | 1 | — | — | — | 1 | — |

读法（必须一起读，否则会读错）：

1. **`/battle/plan` 的双峰是真实行为，不是噪声。** `branches_evaluated > 0` 的样本
   走完整搜索（P50 38.28ms）；`branches_evaluated == 0` 的样本是「这一步只有换人
   可做」的局面，规划器**一个分支都不搜**就返回（P50 0.93ms）。两者相差约 40 倍，
   所以不分层的「总 P50」没有意义。见 §5.1 的发现。
2. 服务端自测与客户端往返的差（P50 约 0.7ms）就是本地 HTTP + JSON 的固定开销。
3. `/rules/query` 是纯静态数据查询，P50 0.2ms 说明它没有触及任何机制计算。
4. 这些数字**只属于本机**（15 核 arm64 MacBook，Python 3.9.6，本地回环）。
   换机器、换解释器、换并发都会变；不能当容量规划依据。

---

## 5. 失败与发现的问题

### 5.1 发现：`/battle/plan` 在「只有换人可做」的局面会返回 `coverage=1.0` 的零分支结论

- **事实（真实调用）**：n=25 的采样里有 6 次 `branches_evaluated == 0`，
  `timed_out=false`，`coverage=1.0`，`recommended_label` 是「换上第2位 / 换上第3位」。
  复现方式：`node /tmp/f02-latency.mjs <repoRoot> /tmp/f02-latency.json`，
  看 `logs/latency-samples.json` 的 `plan_diagnostics`（每次 `branches:0` 都记了）。
- **为什么**：`planner.plan_actions()` 先取 `_my_candidates()`；若候选为空，
  走 `if not my_candidates:` 分支返回 `coverage=0.0`。而「只换人」时 `_my_candidates`
  仍然能挑出换人动作，于是进入正常路径，对手分布为空时逐候选只做一次估值、
  不数任何分支（`branches_evaluated` 保持 0），最后 `coverage = len(results)/len(my_candidates) = 1.0`。
- **风险**：调用方若只看 `coverage==1.0` 且不看 `branches_evaluated`，会把
  「没搜过」误读成「搜完了」。当前演示页与 `demo-acceptance` 都通过，
  说明现有消费方没有被这一点影响；但这是一个契约上的歧义。
- **定位文件（供协调者决定，本报告不改代码）**：`roco/src/roco_env/planner.py`
  （`plan_actions` 的 `_my_candidates` 空判与末尾的 `coverage` 计算）。

### 5.2 跳过的那 1 条浏览器用例：是测试自带的守卫，不是我放宽的

`npm run test:browser`：`ℹ tests 18 / pass 17 / fail 0 / skipped 1`。唯一跳过项：

```text
﹣ ④ 换到 1 号位后再打倒对手首发：对手补位必须落地，界面必须能继续 (91540.060792ms)
   # 1 号位在 60 个回合内没有倒下（当前「芽角鹿5HP · 5能量」），本次跳过
```

守卫原文在 `tests/replace.test.js:577`：
`if(!/已倒下/.test(s.myBench[1]))return t.skip(...)`。
这是仓库里**既有的**条件跳过（局面没打到那个状态就不测这一条），
`tests/` 未被本任务修改（§2.4）。如实记录：该场景本轮**没有被验证**。

### 5.3 发现：`/health` 的能力清单与实际可用性不符

- **事实（真实调用）**：`GET /health`（以及 `kind=ruleset` 的 `/rules/query`）返回
  `"capabilities": {"rules.query_catalog": true, "rules.query_type_chart": true,
  "mechanics.resolve_effect": false, "team.evaluate": false, "team.compare": false,
  "battle.plan": false}`，同时 `"mechanics_coverage": 0.0`。
- 但同一次会话里 `POST /team/evaluate` 返回 `ok:true, coverage:1.0` 且带完整特征列表；
  `POST /battle/plan` 返回 `ok:true, coverage:1.0`、`branches_evaluated=96`；
  `POST /team/compare` 同理（`test:bridge` 有 11 条真服务测试覆盖这三条路径）。
- **定位文件**：`roco/src/roco_env/service.py` 的 `CAPABILITIES`（第 146–153 行）
  未随引擎接线更新；`NOT_IMPLEMENTED`（第 156–157 行）已是空字典。
  消费方若信 `capabilities`，会误判这三个端点为不可用。

### 5.4 发现：没有任何端点会返回 `not_implemented`(501)

- **事实（真实调用）**：`NOT_IMPLEMENTED = {}`，`ROUTES` 8 条
  （`/health`、`/rules/query`、`/team/evaluate`、`/team/compare`、`/battle/plan`、
  `/battle/new`、`/battle/legal`、`/battle/advance`）。
  `POST /battle/summary` → **404 `not_found`**、`error: "未知端点：/battle/summary"`、
  `routes:[...]`，而**不是** 501 `not_implemented`。
  原因：`do_POST`（以及 `_dispatch`）先按 `ROUTES` 白名单过滤，不在白名单里走
  `unknown_path()`；`not_implemented()` 这个处理函数在 `NOT_IMPLEMENTED` 为空时永远
  不会被调用。
- 客户端侧 `summarizeBattle()` 是**本地**合成 `not_implemented`（不发请求），
  所以「复盘摘要未实现」这条结论仍然成立，只是它不是服务端给的。
- **定位文件**：`roco/src/roco_env/service.py` 的 `ROUTES` / `NOT_IMPLEMENTED`
  与 `RocoRequestHandler.do_POST`。

### 5.5 发现：`/battle/plan` 的 `unsupported` 数组为空但结论不可用

`kind=damage` 之类显式请求效果原语会拿到 422 + `unsupported_effect`（正确）。
但 `/battle/plan` 在 §5.1 的零分支情形下 `unsupported: []` 且 `coverage=1.0`，
上层拿不到「本次没有搜索」的结构化提示。与 §5.1 同源，列在这里是为了让
「未支持机制」章节的边界完整：**不是所有「没算」都会进 `unsupported`。**

### 5.6 发现：`npm run test:smoke` 的前置条件没有写进 npm 脚本

- **事实（真实执行）**：`node scripts/browser-smoke.mjs` 第 27–29 行先探测
  `http://127.0.0.1:8765/api/bootstrap`，探测不到就 `process.exit(2)` 并打印
  `冒烟测试需要 127.0.0.1:8765 已在运行（npm start）`。
  本轮它跑通（7/7）是因为 8765 上**本来就有一个可用服务** ——
  那个服务不是本任务启动的，脚本也不打印它连到的是谁。
- **风险**：`package.json` 的 `test:smoke` 看起来像一条自洽的测试命令，实际依赖
  一个外部常驻服务与硬编码端口 8765；在干净机器上它会以退出码 2「拒绝跑」，
  而不是给出可执行的自举步骤。对比：`scripts/roco/browser-acceptance.mjs` 与
  `scripts/roco/demo-acceptance.mjs` 都在**进程内**起服务（不依赖 8765），
  这两条在本轮是真正自包含地跑过的。
- **定位文件**：`scripts/browser-smoke.mjs`（第 11 行注释已声明前置条件，
  但命令本身不检查/不启动）。本报告不改代码，只登记。

---

## 6. 规则覆盖

### 6.1 12 只精灵的支持等级

来源：`data/roco/normalized/roco-world-s4-2026-09-10/support-matrix.json`
（`schema_version=1`）+ `docs/roco/PET-SUPPORT-MATRIX.md`。

| 支持等级 | 只数 | 占比 |
|---|---:|---:|
| `CATALOG_ONLY` | 0 | 0% |
| **`KNOWLEDGE_ONLY`** | **12** | **100%** |
| `SIM_PARTIAL` | 0 | 0% |
| `SIM_VERIFIED` | 0 | 0% |
| `EVAL_ELIGIBLE` | 0 | 0% |

按组：A 组 6 只、B 组 3 只、C 组 3 只，**当前等级一律 `KNOWLEDGE_ONLY`**。
矩阵自带 caveat 原文：`支持等级 current 一律为 KNOWLEDGE_ONLY：本轮未实现任何效果原语，未通过任何 microcase。`

交叉核对（真实计算）：`skills.json` 里 **824/824** 条技能的 `effect_support` 都是
`"unsupported"`（`collections.Counter` 结果：`{'unsupported': 824}`）。
**数据字段齐全 ≠ 机制可模拟**：没有任何一只精灵有资格进入战斗或强度结论。

### 6.2 A 组候选配招技能池：完全解析 vs 未完全解析

调用真实 `roco_env.parse.coverage_report()`（`logs/unsupported-mechanism-probe.json`
的 `status_skill_stats` 与本节的人工核对脚本）：

```text
A 组候选配招去重技能数: 19
coverage_report(A 组并集): total 19, fully_supported 3, partial 0, unsupported 16
```

| 分类 | 数量 | 说明 |
|---|---:|---|
| **完全可解析（`parse_skill().fully_supported`）** | **3** | 焚烧烙印（`foe_status+cleanse`）、水泡盾（`self_stat`）、集中（`escape`） |
| 部分解析（有 effects 但有 `unparsed`） | **0** | — |
| **完全未覆盖（无 effects）** | **16** | 12 条攻击 + 4 条防御（见下） |

但 16 这个数**不能**直接读成「16 个技能不能用」，因为 `parse_skill()` 的
`fully_supported` 只对**状态技能**有意义：攻击走伤害路径、防御走减伤路径，
两者都不经过 `parse.py`。按实际结算路径拆开：

| 结算路径 | 数量 | 引擎怎么处理 | 真实可信度 |
|---|---:|---|---|
| 攻击（12） | 12 | `effects.effective_power()` + `COMMUNITY_HYPOTHESIS_V1` 公式结算 | 公式**未核验**（每次伤害事件都带 `formula_verified:false`） |
| 防御（4） | 4 | `effects.parse_defense_reduction()` 从描述读「减伤 N%」 | 4 条描述都读得出，可结算；「减伤无条件生效」是假设（MC-020） |
| 状态（3） | 1 完整 / 2 完全未覆盖 | `_apply_status_effects()`：解析不出就 `_note_unsupported` + `status_unsupported` 事件，**不应用** | 2 条（取念、啮合传递）在真实对局里 fail closed |

作为对照（同样是真实计算）：

| 技能集合 | total | fully_supported | partial | unsupported |
|---|---:|---:|---:|---:|
| A 组候选配招（去重） | 19 | 3 | 0 | 16 |
| 12 只精灵学习表并集 | 264 | 62 | 2 | 200 |
| 全库 `skills.json` | 824 | 164 | 20 | 640 |
| 全部**状态**技能 | 167 | 77 | 9 | 81 |

### 6.3 microcase：通过 / 失败 / 未验证

来源：`roco/tests/test_microcases.py`（122 条 Python 测试中的一部分）、
`tests/evals/roco/cases/microcases-v1.jsonl`、`docs/roco/MICROCASE-PLAN.md`。

| 状态 | 条数 |
|---|---:|
| **通过（`verification.passed == true`）** | **0** |
| **失败（`verification.passed == false` 且已尝试执行）** | **0** |
| **未验证 / 未执行（`status: PLAN_ONLY_NOT_EXECUTED`）** | **21** |
| 合计 case | **21** |

证据等级分布（`verification.level`）：`planned` 19 条、`documented_text_only` 2 条。
21 条的 `expected_event_sequence` **全部为 `null`**，即「我们不知道正确答案」。

`roco/tests/test_microcases.py` 的 docstring 已经写明了它是什么、不是什么（原文）：

> **这些不是「microcase 已通过」的证明。** microcase 是要用**游戏内实测**回答的问题，
> 本文件测的是「引擎的行为与它自己声明的依据一致」。

即：这 122 条 Python 测试通过，说明**引擎与它自己声明的依据自洽**，
**不**说明任何一条游戏规则被证实。两者必须分开读。

### 6.4 A 组 6 只特性的实现状态（真实调用 `traits.implementation_summary()`）

| 状态 | 只数 | 特性（精灵） |
|---|---:|---|
| `FULL` | 3 | 身经百练（海豹船长）、泛音列（圆号鱼）、专注力（音速犬） |
| `PARTIAL` | 2 | 预警（黑猫巫师）、捉迷藏（雪影娃娃） |
| `REFUSED` | 1 | 不朽（寂灭骨龙） |

注意：这是**特性实现状态**，不是支持等级。12 只精灵仍然一律 `KNOWLEDGE_ONLY`，
因为技能层的效果原语没有核验。

### 6.5 先导（pilot）实测

```text
$ python3 roco/run_pilot.py --games 1000 --quiet
先导：1000 场，种子 20260921…，回合上限 300
完成：1000 场 / 21.5s = 46.5 局每秒
非法动作 0，截断 0，异常 0，无结局 0
隐藏字段读取 0
```

| 指标 | 200 局 | **1000 局** |
|---|---:|---:|
| wall_seconds | 4.166 | 21.488 |
| games/s | 48.0 | 46.5 |
| 非法动作 | 0 | **0** |
| 截断 | 0 | **0** |
| 异常 | 0 | **0** |
| 无结局 | 0 | **0** |
| 隐藏字段读取 | 0 | **0** |
| 座位胜场 | — | player 500 / enemy 498 / 平 2 |
| 回合数 mean / P50 / max | — | 51.11 / 42 / 214 |
| 暴露平衡 | balanced=True | balanced=True（25 个策略对各 40 场、各 16 种队伍对、1 种暴露模式） |

**这份先导不是强度结论**（原文免责声明照抄）：`本报告的分组胜负计数是**环境自检，不是胜率、不是强度榜**。`
它只证明：引擎在 1000 局里没有崩、没有产生非法动作、没有偷看隐藏信息。

另一个实测结论（本报告新增，见 §6.6 与 `logs/unsupported-mechanism-probe.json`）：
在 A/B/C 三组各 15 局的 `play_match` 里，`MatchRecord.unsupported` 累计条目都是 **0**。
也就是说 fail-closed 登记机制在**当前这批规范配招 + greedy_damage 代打**下从未被触发。
这既说明数据侧没有断链，也说明**「未支持机制」在默认对局里没有被暴露出来** ——
它们是代码里的分支，还没有被真实对局压到。

### 6.6 服务端端点矩阵（真实调用）

| 端点 | 信任域 | 实测行为 | 覆盖 |
|---|---|---|---|
| `GET /health` | coach | `ok:true`，带 `capabilities`/`counts`/`engine_modules` | 1.0 |
| `GET|POST /rules/query` | coach | 静态事实 `ok:true`；`kind=skill` 时 `effective_power/damage` 恒为 `null` 且带 `unsupported` | 1.0 |
| `POST /rules/query kind=damage|effect|power|mechanic|resolve` | coach | **422 `unsupported_effect`**、`coverage 0`、`result null` | 0 |
| `POST /rules/query` 双属性缺行 | coach | **422 `unsupported_effect`**（`type_combination_missing`）；67/153 个双属性组合无显式行 | 0 |
| `POST /team/evaluate` | coach | `ok:true`，特征 + limitations，**不输出胜率** | 1.0 |
| `POST /team/compare` | coach | `ok:true`，改善/代价/对手池 | 1.0 |
| `POST /battle/plan` | coach | `ok:true`，跨分析种子聚合；**拒绝任何 seed / pending 键** | 1.0 或 0（见 §5.1/§5.5） |
| `POST /battle/new|legal|advance` | **local_sim（私有）** | `ok:true`，回执带私有 `state` + `public`，`trust_domain:"local_sim"` | 1.0（有 unsupported 时为 0） |
| `POST /battle/summary` 等未登记路径 | — | **404 `not_found`**（不是 501，见 §5.4） | 0 |

---

## 7. 未支持 / 未核验机制（逐条，含失败方式）

判定依据三处源码 + 真实探针：
`roco/src/roco_env/env.py`（模块 docstring 的不变量清单）、
`roco/src/roco_env/traits.py`（每个特性的 FULL/PARTIAL/REFUSED）、
`roco/src/roco_env/service.py`（`CAPABILITIES` / `NOT_IMPLEMENTED` / `EFFECT_KINDS`）。
探针脚本 `/tmp/f02-unsupported-probe.py` 的输出全文见
`logs/unsupported-mechanism-probe.json` 与 `logs/unsupported-mechanism-probe.stdout.log`。

**失败方式一共只有 4 种，先定义清楚**（后面的表只引用代号）：

| 代号 | 失败方式 | 谁看得见 |
|---|---|---|
| **F1** | 抛 `roco_env.effects.UnsupportedEffect`（正常控制流，不是 bug） | 调用方拿到异常，**没有数值** |
| **F2** | 记入 `GameState.unsupported`（不抛异常，继续推进；对局回执里变成 `unsupported_seen` / `unsupported[{code:"unverified_mechanics_seen"}]`，并让该回执 `coverage=0`） | 服务回执的结构化字段 |
| **F3** | 结构化响应 `unsupported_effect`(422) / `not_implemented`(501) / `not_found`(404)，`coverage=0`、`result=null` | HTTP 调用方 |
| **F4** | **静默不解析、不结算、不登记**（当前实现里最需要警惕的一类：调用方拿不到任何信号） | 只有读代码/读事件才能发现 |

### 7.1 引擎不变量：`env.py` docstring 声明的「未核验因而没有实现」

| # | 机制 | 源码位置 | 失败方式 | 实测证据 |
|---|---|---|---|---|
| U1 | **等级 → 面板换算公式未知**，只支持 `level=1` | `env._make_pet`（`env.py:64-67`） | **F1**：`未支持的机制：等级 2（等级→面板换算公式未知，本引擎只支持 level=1（M1 已登记为 unknown））` | 探针 A1 |
| U2 | **能量上限与回合末回能的精确规则**（MC-007） | `env.py:45-46`：`ENERGY_MAX=6`、`ENERGY_REGEN_PER_TURN=1` 明确标「假设」 | **F4**：按假设常量**静默**结算（`_end_of_turn` 每回合 +1、封顶 6；技能消耗先扣） | 读码 + `energy_regen` 事件 |
| U3 | **同速且同先手度时的裁决依据**（MC-002） | `env._rng_for`（`(seed<<20) ^ turn` 派生），docstring 写「**这是假设**」 | **F4**：用确定性随机**静默**裁决 | `order_actions` 的第 4 排序键 `tie` |
| U4 | **印记的叠加/替换规则**（MC-009） | `env._apply_status_effects` 的 `self_mark/foe_mark` 分支（`env.py:607-620`） | **F2**：既**应用**累加层数，**又**登记 `印记「攻击印记」的叠加/替换规则`（`evidence:"3010"`） | 探针 A7：`marks={"攻击印记":1}` + 1 条 unsupported |
| U5 | **「传动」的技能位移动**（术语 1033） | `parse.py` 的 `UNPARSED_MARKERS` 含 `传动`/`号位` | **F4**（技能在被使用时会先经 `_apply_status_effects` → `parse.unparsed` 非空 → 变成 **F2**） | 探针：`啮合传递` 全库共 16 处含「号位」、18 处含「传动」 |
| U6 | **天气、连击数、属性增减的层数语义** | `parse.py` 的 `UNPARSED_MARKERS`；`effects.py` 无天气层 | **F4**（解析层不产出这些效果）；天气另有 **F2** 路径：`_apply_status_effects` 的 `weather` 分支登记 `天气「X」`（`env.py:663-664`） | 全库描述含「天气」13 条、「连击」76 条 |
| U7 | **12 只精灵的特性效果**（MC-014…019） | `traits.py` 的 `TRAITS`（每个特性逐条标状态） | **F1/F4 混合**：`REFUSED` 的特性钩子直接 `return`（**F4** 静默不生效）；`PARTIAL` 的触发条件未实现（**F4**，只见于显式驱动） | §6.4：FULL 3 / PARTIAL 2 / REFUSED 1 |

### 7.2 数值假设：会算出数字、但数字**未核验**（不抛异常，靠标记暴露）

| # | 机制 | 源码位置 | 失败方式 | 实测证据 |
|---|---|---|---|---|
| U8 | **官方伤害公式没有一手来源**；用社区实现 `COMMUNITY_HYPOTHESIS_V1` 作候选 | `effects.py:57-99`（`verified=False`、`license_note` 写明「不是官方公式」） | **F4**：**照常算**，但每个伤害事件带 `damage_model:"community-hypothesis-v1"` 与 `formula_verified:false` | `env._execute` 的 `damage` 事件字段 |
| U9 | **本系加成（STAB）= 1.5**、取整方向、最小 1 | `effects.stab_multiplier`（docstring 写「未核验」） | **F4**：静默套用 | 读码 |
| U10 | **条件化威力的取值时机与取整**（MC-010） | `effects.effective_power` 只处理 4 种模式（每有1能量 / 阈值倍数 / 应对状态 / 迸发），其余标 `conditional=True` 并给 `reason` | **F1**：`power is None` 时抛 `未支持的机制：技能「X」没有静态威力`；**F2**：`_execute` 捕获后登记 `技能「X」的威力` + `power_unsupported` 事件；其余**F4**（用未核验公式算出来） | 探针 A2 |
| U11 | **百分比伤害/回复的取整方向与基数**（MC-011） | `effects.percent_of_max_hp`（`rounding="floor"`，docstring 写假设）；`decay_layers` 奇数向上取整 | **F4**：静默取整 | 读码 |
| U12 | **未实现回合末结算的状态**（如眩晕） | `effects.status_tick` 对不在 `END_OF_TURN_STATUS`（中毒/灼烧/寄生）表里的状态 | **F1**：`未支持的机制：状态「眩晕」（该状态没有实现回合末结算）`；`_end_of_turn` 捕获后 **F2** 登记 `状态「眩晕」` | 探针 A3 |
| U13 | **防御技能描述里读不出减伤比例** | `effects.parse_defense_reduction` | **F1**：`未支持的机制：防御技能「X」（描述里读不出减伤比例）` | 探针 A4 |
| U14 | **道具效果未实现** | `env.ITEM_EFFECTS` 只有 3 种（回复药/净化药/能量果）；`_use_item` 的 `else` 分支 | **F2**：`道具「神秘道具」，detail「未实现」` | 探针 A8 |
| U15 | **离场（脱离/返场）需要选择换上谁**（术语 3003/3009/3024） | `_apply_status_effects` 的 `escape` 分支 | **F2**：登记 `技能「X」的离场效果`，**不自动代选** | `env.py:659-662` |

### 7.3 解析器明确未覆盖（`parse.py` 的 `UNPARSED_MARKERS`），并给出全库命中数

探针实测（每条 marker 在 824 条技能描述里出现的条数）：

| marker | 含义 / 未覆盖机制 | 全库出现 | 失败方式 |
|---|---|---:|---|
| `随机` | 随机类（「每回合随机变成…」） | 18 | F2（状态技能解析不出 → `_note_unsupported`） |
| `选择` | 选择类（术语 3019「从 2 个效果中选择 1 个」） | 27 | F2 / F4 |
| `明` / `暗` | 术语 3019 的「明/暗」二选一 | 1 / 3 | F2 |
| `传动` | 术语 1033 技能位移动 | 18 | F2 |
| `号位` | 「位于 1 号或 3 号位时…」 | 16 | F2 |
| `连击` | 术语 3005 连击数语义 | 76 | F2 |
| `天气` | 「将天气改为…」；引擎没有天气层 | 13 | F2（`天气「X」`） |
| `眩晕` | 打断/眩晕结算 | 4 | F2 / F1（若真的挂上则该状态 tick 会 F1） |
| `沉默` | — | **0** | 标记存在、数据里无命中 |
| `封印` | — | **0** | 标记存在、数据里无命中 |

注意 `沉默`/`封印` 是「预留但无数据」；`明`（1 条）这个 marker 极易误命中
（单字），命中不等于该技能真有「明/暗」机制 —— 这是解析器用子串匹配的已知粗糙处。

### 7.4 特性层（`traits.py`）逐个精确定位

| 特性 | 精灵 | 状态 | 具体哪一部分没做 | 失败方式 |
|---|---|---|---|---|
| 不朽 | 寂灭骨龙 | **REFUSED** | 复活所需的「力竭后仍占回合计数位」状态不存在；4 回合起点、复活后 生命/能量/状态/印记 初始化、可否重复触发 四条都无一手证据（MC-014） | **F4**：`on_enter` 对 `REFUSED` 直接 `return`，**不登记**（`traits.py:143`） |
| 预警 | 黑猫巫师 | **PARTIAL** | 「速度+50」已实现；**触发条件**「敌方技能足以击败自己」未实现（依赖未核验伤害公式 MC-010/011） | **F4**：只有 `pet._predict_threat_confirmed` 被显式置位才生效，正常对局永不触发（`traits.py:176`） |
| 捉迷藏 | 雪影娃娃 | **PARTIAL** | 挂「全技能能耗+1」已实现；与 湿润印记(-1) / 聒噪(+2) 的**复合顺序与下限**未定义（MC-018） | **F4**：只登记标记，不结算复合（`traits.py:206-220`） |
| 身经百练 | 海豹船长 | FULL | 计数源与对象明确；但「每层 +20% 且可叠加」「入场时 = 换上的那个回合」是**假设** | F4（假设） |
| 泛音列 | 圆号鱼 | FULL | 「聒噪」效果来自数据（`skill_000274`）；实现为能耗修正标记 | F4（假设） |
| 专注力 | 音速犬 | FULL | 触发用 `entered_turn == 当前回合` 判定 | F4（假设） |

### 7.5 服务层 fail-closed（结构化拒绝）

| # | 机制 | 源码位置 | 失败方式 | 实测 |
|---|---|---|---|---|
| U16 | `kind ∈ {effect, power, damage, mechanic, resolve}` 需要效果原语 | `service.py` 的 `EFFECT_KINDS` + `_answer_effect` | **F3**：HTTP 422 `unsupported_effect`、`coverage:0`、`result:null`，附 `requested_kind`/`skill_id` | 真实调用：`kind=damage, skill_id=skill_000744` → 422 |
| U17 | 技能静态 `power` **不是**最终伤害 | `_skill_record`：`effective_power:null`、`damage:null`、`power_status`、`mechanics.resolved` | **F3（软）**：HTTP 200 但 `unsupported[{code:"effect_resolution"}]` 存在；`effective_power/damage` 恒为 `null` | 真实调用 `kind=skill` → 200 + unsupported |
| U18 | 双属性相性缺显式行（67/153 组合） | `_answer_type_multiplier` / `_answer_type_row`；`service.py` docstring 第 77–79 行 | **F3**：422 `unsupported_effect`（`type_combination_missing` / `type_row_missing`）；**拒绝用「两条单属性相乘」补** | `type_chart` 自检：singles 18、dual_rows 102、两单属性组合 153、缺行 **67** |
| U19 | `mechanics.resolve_effect` 能力未实现 | `CAPABILITIES["mechanics.resolve_effect"] = false`、`mechanics_coverage: 0.0` | **F3** | `GET /health` |
| U20 | `NOT_IMPLEMENTED` 端点 | `service.py:156-157`（**空字典**） | **F3 失效**：`not_implemented()` 从不被调用；未登记路径实际返回 **404 `not_found`**（§5.4） | 真实调用 `/battle/summary` → 404 |
| U21 | 隐藏信息防线（MC-013） | `service.find_hidden_keys` + `roco-client.js` 的 `HIDDEN_KEYS`（两份必须一一对应，`test:plan-e2e` 有测试钉着） | **F3**：400 `hidden_information`，任意深度、无例外（含 `seed`） | `test:bridge`/`test:plan-e2e` 各 1–3 条反证测试通过 |
| U22 | 规则集版本与指纹 | `resolve_ruleset` / `expected_fingerprint` | **F3**：409 `version_mismatch`；加载失败 404 `ruleset_unsupported` | `test:bridge` 2 条专用测试通过 |

### 7.6 结论：未支持机制的「可信度」自评

- **会抛异常、绝不给默认值**（F1）：U1、U10(无静态威力)、U12、U13。这几条在探针里
  都跑出了原文异常（`logs/unsupported-mechanism-probe.json` 的 `raised` 字段）。
- **会登记、绝不给默认值**（F2）：U4、U5/U6 的状态技能路径、U10(捕获后)、U14、U15，
  以及 12 只特性中 FULL/PARTIAL 的假设部分。探针 A5/A7/A8 各跑出了原文条目。
- **静默假设**（F4，最需要警惕）：U2、U3、U8、U9、U11、以及 6 只特性的「假设」部分。
  这些**不会**出现在 `unsupported` 里，只会以常量/公式/标记的形式留在代码与事件字段中。
  任何人读这份报告时都必须知道：**「没有 unsupported」不等于「机制已核验」。**
- **声明与实际不符**：U19/U20 相关的 `CAPABILITIES`/`NOT_IMPLEMENTED`（§5.3、§5.4）。
- 实测补充（§6.5）：A/B/C 三组各 15 局 `play_match` 的 `MatchRecord.unsupported` 均为 **0**。
  在当前默认配招与 `greedy_damage` 代打下，F1/F2 两条 fail-closed 路径**从未被触发**，
  所以「fail closed」在本轮回归里是**读码 + 探针**证据，不是对局证据。

---

## 8. 复现指令

```sh
cd /Users/serendizc/Developer/roco-coach

# 计划命令
npm test
python -m pytest roco/tests            # 本机必然失败：No module named pytest
npm run test:env                       # 实际使用的 Python 口径
npm run test:smoke                     # 需要 8765 上已有服务在跑，见 §2.3

# 追加套件
npm run test:bridge
npm run test:toolbox-roco
npm run test:plan-e2e
npm run test:roco-all
npm run test:roco-experience       # 已包含在 test:unit 里，交叉确认用

# 真浏览器验收
node scripts/roco/browser-acceptance.mjs
node scripts/roco/demo-acceptance.mjs

# 先导
python3 roco/run_pilot.py --games 1000 --quiet

# 延迟采样与未支持机制探针（一次性脚本，只放在 /tmp）
node /tmp/f02-latency.mjs /Users/serendizc/Developer/roco-coach /tmp/f02-latency.json
python3 /tmp/f02-unsupported-probe.py
```

逐条命令的完整原始输出（含 `# exit=` 与 `/usr/bin/time -p` 的 real/user/sys）在
`reports/roco/regression/logs/`：

| 文件 | 内容 |
|---|---|
| `npm-test.log` | 第 1 号命令全文 |
| `pytest-substitution.log` | 第 2 号命令（失败原文） |
| `npm-run-test-env.log` | 第 3 号命令 |
| `test-smoke.log` | 第 4 号命令 |
| `test-roco-experience.log` | 第 12b 号命令（附加交叉确认） |
| `test-bridge.log` / `test-toolbox-roco.log` / `test-plan-e2e.log` | 第 5/6/7 号命令 |
| `npm-run-test-roco-all.log` | 第 8 号命令 |
| `browser-acceptance.log` / `demo-acceptance.log` | 第 9/10 号命令 |
| `run_pilot-1000.log` / `run_pilot.log` | 第 11/12 号命令 |
| `latency-harness.log` + `latency-samples.json` | 延迟采样原始输出与全部样本 |
| `unsupported-mechanism-probe.stdout.log` + `unsupported-mechanism-probe.json` | 未支持机制探针 |
| `pilot-1000-metrics.json` | 1000 局先导的 metrics 快照 |
| `environment.log` | 主机 / 版本 / commit |

机器可读版本：`reports/roco/regression/F02-REGRESSION-2026-09-21.json`。

---

## 9. 本报告的边界（不声称什么）

1. 不声称任何**游戏规则**被证实。21 条 microcase 全部未执行（§6.3）；
   122 条 Python 测试只证明「引擎与它自己声明的依据自洽」。
2. 不声称任何**强度/胜率**结论。先导胜负计数是环境自检（§6.5）。
3. 不声称 **pytest 通过** —— 它没跑成（§2.2）。
4. `npm run test:smoke` 通过，但它连到的 8765 服务**不是本任务启动的**；报告只声称「在这个前置条件下 7/7 通过」（§2.3）。
5. 延迟数字只属于**本机**（§4.2 读法第 4 条），不是生产数字。
6. 未支持机制清单是「本轮未核验」的快照。机制一旦实现，这张表必须同步更新，
   且 `§7.6` 里 F4（静默假设）那几条应当优先补 microcase。
