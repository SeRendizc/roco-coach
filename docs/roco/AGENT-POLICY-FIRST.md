# 消融：工具调用「该不该调」交给代码（policy-first） vs 交给模型

**一句话**：同一批 288 个窗口、同一个 4B 模型、同一套提示与工具契约，
只把「第一步要不要调工具」从**模型手里**挪到**代码手里**，通过率 **232/288 → 288/288**，
**56 条由挂转过、0 条由过转挂**。

这份文档存在的理由：这个数字此前只活在 `tmp/probe/*.jsonl` 里，而 `tmp/` 被 `.gitignore:6`
忽略（`git check-ignore -v tmp/probe/traj-pf2.jsonl` 可复现），`git clean` 一次就没了。
产物已复制到 `reports/roco/agent-policy-first/`，哈希见下。

## 1. 两种配置是什么

| | 谁决定第一步调不调工具 | 后面的每一步 |
|---|---|---|
| **模型自己决定**（默认） | 模型。提示里放了工具契约，它自己判断该不该调、调哪个 | 模型看着 receipts 继续决定 |
| **policy-first**（`--policy-first`） | `src/coach/runtime.js` 的 `policyFor()`。它给出 `need` 就直接调，选什么工具、参数是什么都由代码定（`defaultArgsFor()`） | 仍然交回模型 |

`--policy-first` 默认**关**。它只接管**第一步**：`scripts/roco/agent-trajectories.mjs:1027-1030`
在 `i===0` 时先问 `policyFirstChoice()`，命中就把 `chosenBy` 记成 `'policy'`；
后面每一轮还是走同一个 planner。所以这不是「用规则替代模型」，而是**把模型测不准的那一半拿走**。

这符合仓库本来的纪律（`runtime.js:1945` 上方那段）：「模型选**哪个**工具很准，
**该不该调**只有 50%」——策略层从 2026-09-25 起就是这么设计的，这份文档量的是它值多少。

## 2. 数字

三种配置，**同一份 `task_set_digest`**（`f0b5d51a9142b09e43138e4dcf924698880c032bc8f9650cc5db77abc52ef975`）：

| 产物 | 世界/任务 | 轨迹数 | 通过 | 通过率 |
|---|---|---|---|---|
| `tests/evals/agent-trajectories-model-v1.jsonl`（模型自己决定） | 9 | 1752 | 1240 | 70.8% |
| `reports/roco/agent-policy-first/traj-policyfirst-run1.jsonl` | 1 | 288 | 286 | 99.3% |
| `reports/roco/agent-policy-first/traj-policyfirst-run2.jsonl` | 1 | 288 | **288** | **100%** |

⚠️ **上面三行不能直接横向比**：模型那份每个 case 跑了 9 个世界（1752 条），
两份政策各跑 1 个世界（288 条）。要可比必须按**同一个 case × 同一个 world** 配对。

### 2.1 配对后的对照（我实测，可复算）

`traj_id` 的形状是 `case_id@world_id#arm`（`traj-pf2.jsonl` 第 2 行的 `traj_id` 是
`rl-pet-f0-01@camp-locked-1#local_4b`），所以「同一个 case、同一个 world、同一个 arm」
可以精确配起来。拿 policy 那份的每一条去模型那份里找同 key 的记录：

```
配对窗口 288 | 判定相同 232 | 挂->过 56 | 过->挂 0
模型自己决定通过 232 / 288 = 80.6%
政策定第一步通过 288 / 288 = 100.0%
```

**56 条翻转的分类**：`rules_lookup` 32 + `roster_constraint` 24。
**模型在那 56 次里是怎么停的**：`stopped` 全是 `complete`——也就是说它不是崩了、不是参数不合法、
不是回执超预算，而是**自己判断「不用查」然后收口**。这正是策略层要接管的那种错。

**0 条由过转挂**：policy-first 没有把任何一条原本通过的弄红。这条比 56 更重要——
它说明接管第一步的代价是 0，而不是「换一批错法」。

### 2.2 多步：1752 条里 `>=2` 次工具调用的有 0 条

模型那一份的 `trace` 长度分布实测：`{"0": 1332, "1": 420}`——**没有一条到过两次调用**。

原因是任务集：288 条里 `expect.tool` 非空的 96 条，`max_tool_calls` 分布 `{0:12, 1:48, 2:228}`，
但**没有任何一条要求两次调用**——`max_tool_calls:2` 只是上限，不是要求。
（`expect.tool` 的三类工具：`query_rules` 72、`evaluate_team` 12、`compare_team_change` 12。）

另有一条容易误读的：按 `evidenceNeeds()` 的字面信号量，288 条里有 **12 条**需要两个来源族
（都是「第 3 回合如果我先防御会怎样？」→ `turn`+`branch`）。但那 12 条的
`context` 是 `forced_failure:"plan"`、`expect.tool` 是 `null`、金标行为是**说清「算不了」**——
它们是失败模式用例，不是多步用例。多来源（coverage-force）这条路的端到端能力
**在当前任务集下没有被测过**。机制本身是通的（`runtime.js:2695-2741` 的族定义与
`evidenceNeeds()`、`:3481-3514` 的补调），默认关（`:2737-2739`）。

顺带一个实测：在 145 条真实问句（`scripts/roco/probe-answer-speak.mjs` +
`tests/roco-ask-coverage.test.js` 里的问题串去重）上，需要 ≥2 个来源族的只有 **1 条（0.7%）**。
所以「默认关」是合理的，不必为了它翻默认。

## 3. 怎么复算

需要一个跑着 LoRA 适配器的本地模型网关（`scripts/model/start-mac.sh`，端口 8766）：

```bash
# 模型自己决定（9 个世界，约 30-40 分钟）
ROCO_TRAJ_WORLDS=9 node scripts/roco/build-agent-trajectories.mjs --arms local_4b \
  --out tests/evals/agent-trajectories-model-v1.jsonl

# policy-first（1 个世界，约 4 分钟；跑两次看方差）
node scripts/roco/build-agent-trajectories.mjs --arms local_4b --policy-first \
  --out reports/roco/agent-policy-first/traj-policyfirst-run2.jsonl
```

`--policy-first` 的接线在 `scripts/roco/agent-trajectories.mjs:1027-1030`，
`policyFirstChoice()` 在同文件里；`chosen_by` 会记成 `'policy'`。

## 4. 产物与哈希（sha256 前 16 位）

| 文件 | sha256 |
|---|---|
| `tests/evals/agent-trajectories-model-v1.jsonl` | `77a1c84f6e6808e8` |
| `reports/roco/agent-policy-first/traj-policyfirst-run1.jsonl` | `def5509d12e456cc` |
| `reports/roco/agent-policy-first/traj-policyfirst-run2.jsonl` | `e8244084a59d2ce8` |

（复制前后哈希一致；`run1`/`run2` 的来源分别是 `tmp/probe/traj-policyfirst-w1.jsonl`
与 `tmp/probe/traj-pf2.jsonl`。）

## 5. 诚实记录的局限

1. **两轮 policy-first 自己不一致**：286/288 与 288/288。差的 2 条都在 `rules_lookup`。
   也就是说「100%」是两次里较好的那次；**准确的说法是「286–288/288」**。
   这与 `model-trajectories ④` 那条红判据是同一个现象（同一配置的两次独立运行不完全相同），
   不要把它讲成 100%。
2. **只跑了 1 个 arm**（`local_4b`）。云端臂、规则臂没有跑这个开关。
3. **`worlds_per_task` 不一致**（9 vs 1）。2.1 的配对是为消除这个差异而做的；
   但配对后每个 case 只剩 1 个世界，比 9 个世界的结论**方差更大**。
4. **网关与适配器版本会影响结果**（本项目踩过：网关跑 v3、测试钉 v4、仓库默认 v8
   曾导致整条 `trajectories-model` 假红）。复算前先确认网关加载的是
   `src/coach/local-model.js` 里的 `DEFAULT_ADAPTER_NAME`。
5. **56 这个数字依赖配对口径**。如果换成「按 case 聚合（一个 case 的 9 个世界全过才算过）」，
   数字会变；本文件用的是**逐窗口配对**，与 `trajs` 的判据口径一致。
