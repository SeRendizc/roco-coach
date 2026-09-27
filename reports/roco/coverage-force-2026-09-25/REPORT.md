# 覆盖度强制：把「证据够不够」从模型手里拿走（2026-09-25）

**一句话**：49 例真跑云臂，开 `ROCO_COVERAGE_FORCE=1` 后 **`cat3-cross-tool` 严格正确 0 → 0.2**、
**工具选择正确率 0.429 → 0.469**、**调用次数正确率 0.592 → 0.653**，
而「该停」的两类（`cat2` / `cat4`）**一次误调都没增加**（`cat2` 的既有误调还从 1 降到 0）。

## 为什么是这个杠杆

同一天两次实测把「改提示」这条杠杆证伪了：
本地 4B 改写提示 `rules_lookup` **12/72 → 2/72**（SFT 分布外）；云端加充分性规则
**11/18 → 11/18**（只有措辞 18/18 变了）。而 49 例里 (乙) 28/49 与 (甲) 27/49 几乎打平、
**两者都错的 13 条中 10 条是 `cat3-cross-tool`**（金标 `expect.calls:[2,2]`：两个不同来源各一份回执）。

⇒ 「该不该调」不能问模型。这一点 `src/coach/runtime.js` 的 `policyFor` 上方本来就写着：
「模型『选哪个工具』很准（90–100%），但『该不该调』只有 50%，所以把后者从模型手里拿走」。
本改动只是把它从**「第一个查什么」**扩到**「每个来源都要覆盖」**。

## 机制（`src/coach/runtime.js`）

| 件 | 位置 | 作用 |
|---|---|---|
| `EVIDENCE_FAMILIES` | runtime.js 新导出 | 五个来源族：`state` / `turn` / `match` / `rules` / `branch`，每族列出可用工具 |
| `evidenceNeeds(message,context)` | 新导出 | 这句话要**几个来源**：`policyFor` 的结论（既有政策，判据钉着）**一定在内**，再叠加保守的字面信号 |
| `coverageForce(env)` | 新导出 | 开关，默认**关**；只有 `ROCO_COVERAGE_FORCE=1` 才开 |
| `gatherAgentEvidence` | 由「内层循环」改为**包装** | 模型停下后数覆盖度，缺哪个来源就由**运行时**补一次调用（同 `defaultArgsFor`/`runTool`，回执标 `chosenBy:'coverage'`，并返回 `coverage:{needed,covered,forced}`） |

**边界（刻意不做的）**：单一来源（`families.length<2`）一概不插手 —— 那是 `policyFor` 的职责；
预算与内层同一个上限 `min(4,limit)`；参数构造不出来或不合法就**跳过**，不硬凑调用；
**不开档时直接返回内层结果，与改动前逐字节相同**。

## 实测（49 例真跑 `deepseek-flash`，0 报错）

| 层 / 指标 | 基线 | 覆盖度强制 |
|---|---|---|
| `toolSelectionCorrect` | 33/49 | 33/49 |
| `answerConsistency` | 47/49 | 46/49 |
| `toolSelectionCorrectnessRate` | 0.429 | **0.469** |
| `callCountCorrectRate` | 0.592 | **0.653** |
| `missedCallRate` | 0.556 | 0.556 |
| `unnecessaryToolCallRate` | 0.045 | **0.045**（没有变差） |
| `meanCallsPerCase` | 0.265 | 0.327 |
| `cat3-cross-tool` 严格正确 | **0** | **0.2** |
| `cat2-parametric` / `cat4-should-stop` | 1.0 / 0 | **1.0 / 0**（无回归） |

逐条变化只有三条，全是设计预期的：`c25`、`c27`、`c32` 的调用数 **1 → 2**（金标要两次）。

## 顺带修掉的一个既有假阳性

`policyFor` 的 `/整局/` 把 c21「…算**整局失败**吗？」（问败北条件，金标 `calls:[0,0]`）判成
「整局统计」，政策于是自己先打了一次 `read_match` —— **基线就已经错了**。
现在 `整局` 加了负向断言 `(?!失败|输|赢|获胜|胜利)`；「帮我看看整局的统计」这类**真要统计**的
说法照旧命中（`tests/coach.test.js:167/181` 钉着）。修完 c21 回到 **0 次调用**，`cat2` 严格正确 1.0。

## 判据 + 反证

`tests/roco-coverage-force.test.js`（**5/5**）：① 默认关时与内层**逐字段相同**、且不出现 `coverage` 字段；
② 开档 + 两个来源 ⇒ 补上且 `chosenBy:'coverage'`、`coverage.forced` 与实际一致；
③ 开档 + 单一来源 ⇒ 一次都不补；④ 已覆盖的族不许补第二次（只数**真执行**的调用，纠错回执 `tool:err:*` 不算）；
⑤ 必红反证：来源族表若退化成「永远只有一族」，② 必须红。
相关回归：`tests/coach.test.js`、`tests/roco-judge-shadow.test.js`、`tests/roco-server-side-guard.test.js`、
以及全部引用 `read_match` 的判据 —— **115/115 + 46/46 绿**。

## 这份报告**没有**说的话

- 没有说 `cat3` 已经好了：10 条里只有 2 条转正，`missedCallRate` 仍是 0.556（`cat1` 的 9 条该查没查
  一条都没动 —— 因为 (甲)/(乙) 在那类上是 8:9 几乎打平，硬推等于拿 8 条换 9 条）。
- 没有把开关**默认打开**：默认关，开不开是产品决定（证据在这里，随时可复跑）。
- 没有动判定器：金标、`checkTask`、`validToolArgs` 一个字没改。

## 复现

```bash
KEY="$(security find-generic-password -s pet-coach-deepseek -a "$USER" -w)"
PORT=8933 DEEPSEEK_API_KEY="$KEY" node src/server/index.js &                       # 基线
PORT=8934 ROCO_COVERAGE_FORCE=1 DEEPSEEK_API_KEY="$KEY" node src/server/index.js & # 开档
ROCO_EVAL_ORIGIN=http://127.0.0.1:8933 node scripts/eval-live-s04.js   # → reports/live-model-eval.json
ROCO_EVAL_ORIGIN=http://127.0.0.1:8934 node scripts/eval-live-s04.js
node --test tests/roco-coverage-force.test.js
```

产物：本目录的 `eval-49-baseline2.json` / `eval-49-coverage2.json`（两份完整 49 例回执，含每例的
`toolTrace`/`calls`/`judgment`）。
