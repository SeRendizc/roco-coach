# `agent-tasks-v3-difficulty` —— 困难类别留出集（四类 × 32 条）

这一份是**数据**，回答的是 `docs/roadmap/DSH-EXECUTION-STATE.md` §C6.312 给 Phase E 定的那个重启条件：

> **重启条件**：每个困难类别 **≥30 条**且与训练集**零重叠**（判据现成，扩数据即生效）；
> 扩完**先跑基座看基线**再谈提升；在那之前，这 20 条算出来的比率**只当冒烟**。

**现在的状态：条件已满足（每类 32 条、重叠 0），但一个模型都还没测过。**
这份 README 里没有任何分数，也不要从别处引用分数来谈这四类 —— 按上面那句话，基线没跑之前算出来的比率只当冒烟。

---

## 0. 为什么不是 v2 就够

| | `agent-tasks-v2-tool-coverage.jsonl` | 本集 `agent-tasks-v3-difficulty` |
| --- | --- | --- |
| 条数 | 18（9 工具 × 正负各一） | **128（4 类 × 32）** |
| 考什么 | **工具选择**：这句话该不该调这个工具 | **困难类别**：多轮指代 / 冲突回执 / 长上下文 / 模糊指代 |
| 缺点 | 每一类只有 1 条，报不出泛化 | 每类 32 条，能看出"这一类是普遍不会还是偶尔不会" |

两者互补，**不是替代**：v2 保证"契约里每个工具都被考过"，v3 保证"困难场景有足够样本"。

---

## 1. 四个类别各考什么

每类 32 条，按四个"口味"各 8 条。`expect.tools` 是**可接受工具集**（空集 = 只能停），
`calls` 是**闭区间**，`stop_ok === (calls[0] === 0)`（允许 0 次调用就是允许停）。

### ① `multi-turn` —— 多轮指代 / 追问（32 条，只许停 8 条）

| 口味 | 条数 | 考的是什么 |
| --- | --- | --- |
| `mt-anaphor-*` | 8 | 「它」指的是**上一轮点名的那只**，这一轮字面里没有主词 ⇒ 解回实体后去查图鉴 |
| `mt-repeat-*` | 8 | 追的是**上一轮已经查过**的东西，回执里就躺着答案 ⇒ 正确动作是**停**，再查一次会被判 `repeated-tool` |
| `mt-action-*` | 8 | 指代对象是**上一轮讨论的方案**（不是一个实体）⇒ 该走推演/规划，不是重新检索 |
| `mt-state-*` | 8 | 指代解对了，但问的是**它的当前状态** ⇒ 必须换 `read_state`，拿旧回执答就是过期数据 |

**难在哪**：一句话里两个动作 —— 先把指代解回来，再判断这一问要的是哪一类事实。解错对象或选错工具都算错。

### ② `conflicting-receipts` —— 回执互相冲突 / 不完整（32 条，全部要求继续取证）

| 口味 | 条数 | 冲突长什么样 | 正确动作 |
| --- | --- | --- | --- |
| `cr-turn-*` | 8 | 对局摘要的 `availableTurns` 里有第 N 回合，`read_evidence` 的回执却说"没加载" | 再去读一次把它钉死（`read_evidence` / `read_match`） |
| `cr-version-*` | 8 | 两条回执压在不同 `state_version` 上，一条 `version_mismatch`、一条有结果，**两条都不是当前版本** | 拿当前版本重跑同一个查询 |
| `cr-lastturn-*` | 8 | `read_state` 已经读到第 N 回合，`read_last_turn` 却是一张更早的 `missing` 回执 | 重读上一回合 |
| `cr-contradiction-*` | 8 | **同一组 `(tool,args)`** 的两次回执给出相反结果（重试这条路被 `repeated-tool` 堵死） | 换个层级核实（整局摘要 / 原始回合），**不许挑一条顺眼的讲** |

**难在哪**：回执不是"越多越可信"。这里考的是认出**哪一条是旧的 / 哪两条不可能同时为真**，而不是复述最新那条。

### ③ `long-context` —— 长上下文里找对那一条（32 条，只许停 8 条）

| 口味 | 条数 | 考的是什么 |
| --- | --- | --- |
| `lc-present-*` | 8 | 回执 10–17 条、覆盖十几个回合，**答案就在其中一条里** ⇒ 停下来用已有的作答 |
| `lc-absent-*` | 8 | 同一片草堆里**没有**那一根（问的回合不在手上）⇒ 精确补读那一条 |
| `lc-confusable-*` | 8 | 长回执里同时出现两个**只差一个字**的名字（`仪式巨像`/`祭礼巨像`、`雪蛮人`/`雪巨人`…）⇒ 别指错对象 |
| `lc-crossmatch-*` | 8 | **同一个回合号在局 A 和局 B 都存在**，引擎已经点名 `otherMatchId` ⇒ 必须带着 `matchId` 去读 |

**难在哪**：上下文一长，"找到那一条"和"别再翻一遍"是两种相反的正确动作；这一类的难点就是分辨自己在哪一种里。

### ④ `vague-reference` —— 模糊指代（32 条，只许停 16 条）

| 口味 | 条数 | 「那只/它」有没有解 | 正确动作 |
| --- | --- | --- | --- |
| `vr-two-*` | 8 | **两个**合法解（上下文点过两只） | **停下来问清是哪一只**，一个工具都不该调 |
| `vr-anchored-*` | 8 | 唯一解（先行词在同一个句子里） | 去查图鉴事实，别顺着闲聊编 |
| `vr-active-*` | 8 | 文字里没有先行词，但**有当前对局兜底**（唯一读法 = 场上的那一只） | `read_state`（反问在这里反而错） |
| `vr-noref-*` | 8 | **彻底没有着落**（camp 档、没有队伍、没有回执） | 停下来说清"我不知道你指哪个" |

**难在哪**：这一类的关键是**先判断指代有没有唯一解**，再决定"查"还是"问"。
一直问 = 不会干活；一直猜 = 拿玩家的东西瞎试。

---

## 2. 一条记录长什么样

```json
{
  "case_id": "mt-anaphor-01",
  "category": "multi-turn",
  "message": "刚才说的学院呱呱——它怕什么系？",
  "turns": [{"role": "user", "content": "先帮我看一眼学院呱呱"},
            {"role": "assistant", "content": "好，你想知道它的哪一项？"}],
  "hints": {"mode": "battle", "team": ["pet_000012", "pet_000130", "pet_000485"], "state_version": 7},
  "receipts": null,
  "expect": {"tools": ["query_rules"], "calls": [1, 2], "stop_ok": false},
  "why": "难在**指代跨轮**：……",
  "source": "built"
}
```

| 字段 | 说明 |
| --- | --- |
| `case_id` | `mt-` / `cr-` / `lc-` / `vr-` 前缀 + 口味 + 两位序号 |
| `category` | 四个困难类别之一，**与文件名一致** |
| `message` | **被判的那一句**（当前这一轮玩家说的话）。全集内唯一 |
| `turns` | 前几轮对话（`{role, content}`）。**可选**；只有 `multi-turn` / `vague-reference` 有 |
| `hints` | 只放 `toolPromptFor` 认得的键：`mode` / `state_version` / `team`。没有 `team` 就是**刻意没有** |
| `receipts` | 工具回执数组（`{id, tool, args, result, chosenBy}`，形状照 `runtime.js` 的 trace）；`null` = 这一轮还没有回执 |
| `fixture` | 有回执的记录会带 `true`：**回执是评测夹具，不是引擎实测记录**（见 §4） |
| `expect.tools` | **可接受工具集**。`[]` = 只能停，调任何工具都算错 |
| `expect.calls` | **闭区间** `[min,max]`：工具调用次数必须落在这个区间里 |
| `expect.stop_ok` | 是否允许"不调工具直接作答"。恒等于 `calls[0] === 0`（判据逐条查这个自洽性） |
| `why` | 这一条**难在哪**（必有、非空、且要点出难点） |
| `facts_used` | 可选：回执里引用到的图鉴字段，逐值标出语料出处（判据会逐值核对） |
| `source` | 恒为 `built`：**机器生成的，不是人工标注** |

### 关于 `turns` 与单轮评测器（重要）

现有的 `toolPromptFor({task, hints, receipts})`（`src/coach/shadow-tools.js`）
**只转发 `message` / `hints` 的四个条件键 / `receipts`**，不会带上 `turns`。

所以这一批做了个取舍：**`message` 自己带指代锚点**（例：「刚才说的**学院呱呱**——它怕什么系？」），
`turns` 只是让多轮这件事有据可查。这样：

* 评测器只支持单轮 ⇒ 判据仍然成立、仍然可判定；
* 评测器将来支持多轮 ⇒ 把 `turns` 当成 chat history 接上即可，不用改数据。

**代价**：`multi-turn` 因此没有考"锚点只在历史里、字面完全无线索"的极端形态 —— 那需要评测器先支持多轮。
这一点记在 §6「已知边界」里，不藏着。

---

## 3. 怎么加题 / 怎么重新生成

**不要手改 jsonl。** 数据是生成出来的，手改会在 `--check` 和判据⑦上翻红。

```bash
# 1) 改生成器：scripts/roco/build-difficulty-holdout.mjs 的某个 flavor
node scripts/roco/build-difficulty-holdout.mjs            # 重新生成四个文件
node scripts/roco/build-difficulty-holdout.mjs --check    # 重算并与磁盘逐字节比对（不写盘）

# 2) 校验（四条判红 + 两条加严 + 写报告）
node scripts/roco/verify-difficulty-holdout.mjs
node scripts/roco/verify-difficulty-holdout.mjs --selftest # 注入反证：5 条必须按预期翻红

# 3) 判据（把上面的检查再钉一遍，带反证）
node --test tests/roco-difficulty-holdout.test.js
```

加一条题的正常做法：在对应 flavor 的 `build()` 里加一句问句模板 + 抽一个实体，
**不要**在别处另写一份 `expect`（`tools` 必须在 `TOOL_CONTRACTS` 里，生成时会直接抛）。

约定（生成器会替你把关，判据会再查一遍）：

1. **确定性**：实体从 `data/roco/normalized/roco-world-s4-2026-09-10/**` 现取，抽样用固定种子
   （`SEED = 20260928`）。同一个 flavor 有独立子种子 ⇒ 改一个 flavor 不会动别处的抽样。
2. **不写死数值答案**：题目只问「该不该查 / 查什么」。回执里出现的 `pet_/skill_` id 必须能在语料里找到，
   引用的图鉴字段进 `facts_used` 逐值核对。
3. **问句必须新**：不能与 `reports/roco/sft-coverage/{train,valid,test}.jsonl` 的
   `messages[1].content.message` 或 `tests/evals/agent-tasks-v1.jsonl` 的题面逐字相同（`turns` 里的历史问句也查）。
4. **每类 ≥30**：`CASES_PER_CATEGORY = 32` 留 2 条余量；低于 30 判据①直接红。
5. **回执要真形状**：信封字段照 `src/coach/roco-client.js` 的 `_normalize`、trace 照 `runtime.js`
   的 `gatherAgentEvidenceOnce`、精灵投影照 `roco/src/roco_env/service.py` 的 `_pet_record`、
   事件串照 `src/game/engine.js` 的 `g.log.push`。当前只用了**两种不含数字**的事件串
   （`── 第 N 回合 ──` 与 `你/对手换上了X。`）—— 带伤害/回复数值的那几种一律没用，
   这样夹具里就不会出现"引擎里查不到的数值"。

---

## 4. 回执是**夹具**，不是实测（这条必须说清）

记录里标了 `fixture: true`。含义是：

* **形状**是从引擎代码抄的（字段名、嵌套、错误码都对得上，冲突场景也照着引擎真实的语义设计 ——
  例如"同号回合属于另一局"用的就是 `read_evidence` 的 `otherMatchId` 分支）；
* **内容**是评测场景（"这一局打到第 12 回合、第 9 回合有人换人"这类设定），**不是**某次真实对局的记录；
* 里面出现的**实体名与 id、引用的图鉴字段**全部来自归一化语料，且由判据⑥逐值核对 ——
  所以它不会把"引擎里不存在的精灵/技能/数值"喂给模型。

`facts_used` 是这套约束的收口：回执里凡是引用到图鉴数值的地方，都记一条
`{source, id, field, value}`，判据⑥会拿语料逐值比。回执里只写"谁换上了谁"这类**场景事实**，
不写任何对局的伤害/血量数字。

---

## 5. 怎么跑基线

> ⚠️ **要跑时先跟人类确认。** 这条命令会起本地模型网关（8766，约 3GB MLX 子进程），
> 人的机器会卡一下；**人类在休息 / 机器忙的时候不要跑**。
> 本文档写下来只是为了"到时候一条条照着敲"，**本次扩容没有跑过任何模型**。

```bash
# ① 起本地网关（8766）——这一步会加载模型，跑之前先确认
bash scripts/model/start-mac.sh

# ② 确认网关活着（不加载新东西）
curl -s http://127.0.0.1:8766/v1/models
```

③ 在新切片上量"工具选择"。**目前还没有 v3 专用的运行器**
（`scripts/roco/eval-tool-coverage-arms.mjs` 只读 v2 切片，本次改动不允许新增运行器文件），
所以先用等价的临时命令 —— 它跑的是**同一套** `toolPromptFor` / `modelToolChoice`：

```bash
node --input-type=module -e '
import {readFileSync} from "node:fs";
import {toolPromptFor, modelToolChoice} from "./src/coach/shadow-tools.js";
const rows = ["multi-turn","conflicting-receipts","long-context","vague-reference"]
  .flatMap((c) => readFileSync(`tests/evals/agent-tasks-v3-difficulty/${c}.jsonl`,"utf8")
    .split("\n").filter(Boolean).map(JSON.parse));
const hit = {};
for (const row of rows) {
  const prompt = toolPromptFor({task: {message: row.message}, hints: row.hints, receipts: row.receipts});
  const {choice} = await modelToolChoice({prompt, baseUrl: "http://127.0.0.1:8766"});
  const picked = choice.tool ?? null;
  const ok = row.expect.tools.length === 0 ? picked === null
    : (picked !== null && row.expect.tools.includes(picked));
  hit[row.category] ??= {ok: 0, n: 0}; hit[row.category].n += 1; if (ok) hit[row.category].ok += 1;
  console.log(ok ? "ok  " : "MISS", row.case_id, "→", picked ?? `(停:${choice.reason})`);
}
for (const [c, v] of Object.entries(hit)) console.log(c, `${v.ok}/${v.n}`);
'
```

**跑之前先知道两件事**：

* 这条命令量的是**工具选择**（选没选对），不是最终回答质量 —— 和 v2 一样，它只回答"该不该查、查哪个"。
* 门槛不是"越高越好"的拍脑袋数。至少先跑 `--arm base` 的**基座**，拿到 per-category 的
  分母（每类 32）再谈提升；按 §C6.312，**基座没跑之前，任何比率只当冒烟**。
* 退化的下界参考（**不是**基线，只是让 0 分和 100 分有意义的锚）：
  "永远停下"能拿到 `multi-turn 8/32`、`conflicting-receipts 0/32`、`long-context 8/32`、
  `vague-reference 16/32` —— 合计 **32/128**（只许停的用例正好 32 条）。
  所以一个模型的分数明显低于 32/128 就说明它比"什么都不做"还差。

将来若要把这条命令固化成 `scripts/roco/eval-difficulty-arms.mjs`
（照 `eval-tool-coverage-arms.mjs` 的结构：按类聚合并写 `reports/roco/difficulty-arms/`），
那是**主线程**要决定的事，不在本次扩容的改动范围内。

---

## 6. 已知边界（如实记）

1. **只是数据，没测过模型**：本目录不含任何模型跑分；报告 `reports/roco/difficulty-holdout.json`
   里只有计数、每类条数、重叠数。按 §C6.312，跑基座之前不引用这四类的比率。
2. **`expect.calls` 是**作者定的**区间，不是量出来的**：它表达"这件事最少要几次工具调用才做得完"，
   依据是各工具契约的描述与主循环的 `Math.min(4,limit)` 上限，不是标定数据。
   区间故意放宽到"做完所需的最小步数 … 加上一次合理的纠错"。
3. **`expect.tools` 是集合，不是唯一正解**：`mt-action-*` 同时收 `plan_actions` 与 `compare_actions`，
   `cr-turn-*` 同时收 `read_evidence` 与 `read_match` —— 这几处两种工具都说得通，
   与其钉一个假的唯一解，不如如实收一个集合。代价是判据比"唯一解"松。
4. **`multi-turn` 的锚点写在 `message` 里**（见 §2）：极端形态"锚点只在历史里"要等评测器支持多轮。
5. **`expect.tools` 覆盖 9 个工具**：`summarize_battle` / `compare_team_change` 没有被期望到
   （硬塞进这四个类别会很牵强）；**工具覆盖是 v2 的职责**，v3 的职责是困难类别。
6. **`vr-two-*` 有 8 条"必须停下来问"**：这类用例在只看工具选择的判据里，和"模型什么都没干"长得一样。
   要区分"问得对"和"懒得动"，需要看回复文本 —— 这一批只钉住了工具层（调了什么），没钉住话术。
