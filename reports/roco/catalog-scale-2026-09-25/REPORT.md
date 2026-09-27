# 600 只规模：agent 到底会不会去查（2026-09-25）

**一句话**：把取证任务从「4 只精灵」铺到**全图鉴 622 只**之后，两件事同时暴露出来 ——
① 本地 4B 在 622 条上 **0/622**，其中 **603 条（97%）一次工具都不调**；
② **云端模型会调工具，但会静默地用错 id**：没有「不知道 id 就先按名字查」这条判定规则时，
它把玩家屏幕上那只的 `pet_000225` 当成问题里那只的 id，**120/120 全错**；
补上这条规则后 **120/120 全对**。后者是玩家会直接踩到的坑：小芽会把**别的宠物的数值**当成答案讲出来。

## 一、为什么此前量不到这件事

现有 288 条 agent 任务**只用到了 4 只精灵**（`pet_000225 / 190 / 445 / 417`），
任务池是写死的 12 只（`scripts/roco/coach-position-harness.mjs` 的 `PET_IDS`），而图鉴有 622 只。
**此前所有 agent 数字都量在 0.6% 的图鉴上。**

新增 `scripts/roco/catalog-lookup-tasks.mjs`：把同一个问题族（「<名字>的种族值是多少？」）
铺到全图鉴。**任务集/世界/判定器都不新造**，只换取样面，两条跑法：

```bash
node scripts/roco/shadow-replay.mjs --arm rule       --pool catalog --contract A   # 参照臂
node scripts/roco/shadow-replay.mjs --arm local_4b   --pool catalog --contract B
node scripts/roco/shadow-replay.mjs --arm deepseek_agent --pool catalog --contract B --limit 120
```

## 二、实测数字

参照臂（确定性规则，不经模型）：**契约 A 442/442**、**契约 B 622/622** —— 题目本身是可过的。

| 臂 / 契约 | 通过 | 调用次数分布 |
|---|---|---|
| `rule` / A | **442/442** | 每条 1 次 |
| `rule` / B | **622/622** | 每条 1 次 |
| `local_4b` / A | **0/442** | **429 条 0 次**、13 条 1 次 |
| `local_4b` / B | **0/622** | **603 条 0 次（97%）**、19 条 1 次 |
| `deepseek`（冻结提示·单步）/ B（前 120 条） | **0/120** | 120 条各 1 次，**id 全是 `pet_000225`** |
| `deepseek_agent` / B（前 120 条） | **120/120** | 120 条各 1 次，**按问题里的名字查**（`喵喵`/`水蓝蓝`/`火花`…） |
| `deepseek_agent` / A（前 120 条） | 0/120 | 只有第一步 |

## 三、两个必须说清楚的边界（否则上表会被读大）

1. **契约 A 在「查规则事实」这类题上要求的是冗余的第二步。**
   引擎的按名字查询**本来就把整条记录返回**了（`service.py:679 _pet_record` 里含 `stats` 与 `pet_id`），
   所以 `query_rules{kind:'pet',name:'喵喵'}` 一次就答完了；再拿 `pet_id` 查第二次**不增加任何信息**。
   ⇒ **B 才是 622 只规模上「会不会去查」的正确口径**；
   「名字→id」这个**真本事**属于参数必须是 id 的那类任务（`evaluate_team{team:[id…]}` = 现有
   `roster_constraint` 家族，本地 4B 在那类是 0/24）—— 契约 C 待做。
2. **`must_not_fabricate` 在这条链上不构成证明。** 回放的「正文」由 harness 从回执生成
   （`finalAnswer`），不是模型自己写的 ⇒ 上表的 120/120 证明的是
   **「工具调用按玩家说的名字发起」**，**不**证明「模型自己写的回答不造数」。
   要证后者得走产品链路（`/api/coach` 的 49 例那套，那里正文是模型写的）。
3. 云端是三组各 **120 条样本**（全量 622 条未跑）；本地 4B 与规则臂是**全量**。

## 四、这一轮真正的收获（玩家视角）

- **本地 4B：0/622。** 与上一轮在 4 只精灵上的结论一致、并在全图鉴上复现：
  它的病不是「不知道查什么」，是**根本不查**（97% 零调用）。这不是提示或编排能修的（见 C6.92）。
- **云端：会查，但会用错 id。** 这是**新发现**，也是 600 只规模才会暴露的：
  屏幕上那只的 id 就在提示里（`locked_pet`/`team`），模型会拿它去回答**另一只**的问题。
  在 4 只精灵的小任务集里看不出来 —— 因为那套题恰好问的就是屏幕上那只。
  补上判定规则后 120/120 按名字查，**零编造 id**。

## 五、复现与产物

```bash
# 需要：8766 本地网关（4B 臂）；DEEPSEEK_API_KEY（云端臂，钥匙串 pet-coach-deepseek）
node --test tests/roco-catalog-lookup-tasks.test.js     # 5/5（含必红反证）
```

- `cat-{A,B}-rule.json`、`cat-{A,B}-local_4b.json`：全量摘要（每条的调用、违规、耗时）
- `cat-B-deepseek-n120.json`、`cat-B-deepseek_agent-n120.json`、`cat-A-deepseek_agent-n120.json`：云端三组完整回执
- 代码：`scripts/roco/catalog-lookup-tasks.mjs`、`scripts/roco/shadow-replay.mjs`（`--pool catalog` / `--contract` / `--arm deepseek[_agent]`）
- 判据：`tests/roco-catalog-lookup-tasks.test.js`（5/5）

## 六、下一步（按价值排序）

1. **契约 C**：把 `evaluate_team{team:[名字…]}` 铺到全图鉴 —— 那才是「名字→id」必须做对的地方，
   也是 600 只规模上教练真正要干的事（玩家说「这三只帮我看看」，参数必须是 id）。
2. **把「按名字查」这条规则接进产品链路**（`src/server/index.js` 的 planner 提示），
   并在 49 例真跑上量一次正文不造数 —— 补上第三节第 2 条那个缺口。
3. 本地 4B 若要参与 600 只规模，缺的是**训练数据里「该查就必须查」的样本**（不是提示、不是编排）。
