# 术语问句：从「我这没有」到**去查术语表**（2026-09-25）

> 这一条来自上一轮报告里如实登记的**能力洞**：`docs/roadmap/DSH-EXECUTION-STATE.md` C6.113 §⑤ ——
> 引擎 `_answer_term` 与工具合同都**只认 `term_id`**，所以「『应对』这条术语是怎么定义的？」
> 这类问题**当前工具答不了**（模型不可能猜到 1015），而玩家会问。
> 本文件只写实测与结论。

## 1. 改前的产品路径实测（真服务 + 真模型）

探针：`/tmp/roco-recon/term-probe.mjs`（POST `/api/coach`，营地上下文）。

| 量 | 值 |
|---|---|
| `agentStop` | **`policy-route-without-tools`** ← **工具循环根本没进** |
| 工具调用 | **0 次** |
| 回答 | 「『应对』在宠物对战里，一般指对方出一招后，你选招回敬的那种互动。具体定义要看本作说明，**我这没有它的准确定义**。」 |

**"我这没有"是假话**：引擎里那时就有 1015 应对状态 / 1016 应对攻击 / 1017 应对防御。
根因不在模型：`policyFor` 没有术语这一类 ⇒ 路由把问题判成闲聊 ⇒ 循环被跳过。

## 2. 两处改动（都是"该不该查由代码判、怎么查由模型"这条既有架构）

**① 引擎：术语的**名字路径**（`service.py::_answer_term` + `data.py::terms_by_name/terms_matching`）**

| 输入 | 回执 |
|---|---|
| `{kind:'term',name:'应对状态'}` | 定义（`term_id 1015` + 出处 `terms.json#1015`） |
| `{kind:'term',name:'应对'}` | **候选**：`candidates: true` + 三条各自的 id/名字/描述 + **明说"它们不是这个名字的定义"** |
| `{kind:'term',name:'不存在的术语名'}` | `not_found`（404） |
| `{kind:'term',term_id:'1015'}` | 与改前**逐字段相同**（回归） |
| `{kind:'term'}` | `bad_request`（400） |

**为什么短说法必须给候选、不许挑一条**：册子上没有「应对」这个词条。替玩家挑 1015 就是拿
「应对状态」的定义冒充「应对」的定义 —— 而 1016/1017 的描述并不一样。
这条纪律照抄 `_answer_pet` 的同名分支（多命中要显式登记，不得静默取第一只）。

**② 产品：术语政策（`policyFor` + `defaultArgsFor`）**
- `termAsk`/`termTarget`：识别 7 种问法（含评测里那种前缀很长的），名字从引号或「什么叫 X」里取；
  **取不出来就 fail closed**（返回 `null`，运行时写"没有记录"的回执，而不是编一个名字去查）；
- `ROCO_TERM_LOOKUP` 默认开，显式 `0` 关掉（与图鉴查询同一条理由：关着的时候只会得到"我这没有"）；
- 顺序排在图鉴问句之后（图鉴问题仍归 `codex-fact`）。

## 3. 改后的产品路径实测（同一条探针）

| 问法 | 调用 | 回答 | 依据行 |
|---|---|---|---|
| 「应对」这条术语是怎么定义的？ | `query_rules{kind:'term',name:'应对'}` | 「…只有三个带它的分类：应对状态、应对攻击、应对防御…」 | **依据：查了术语表** |
| 什么叫应对状态？ | `query_rules{kind:'term',name:'应对状态'}` | 「敌方用状态技能时，你这招应对成功就会先手并触发额外效果。」 | **依据：查了术语表** |

两条回执原文在 `probe-short-form.json` / `probe-exact-name.json`（`agentStop: complete`、各 1 次调用）。

**顺带修准了一处玩家话**：活动行原来按工具名一律说「查了图鉴」，术语题也这么说 —— 现在按
`query_rules` 的 `kind` 说准（术语表 / 属性表 / 属性相性 / 规则集版本），且**只认 `kind` 这个白名单字面量**，
`args` 里的 id 与值一个都不许进玩家话（判据 ②b 钉着）。

## 4. 判据

| 文件 | 条数 | 钉的是什么 |
|---|---|---|
| `roco/tests/test_term_lookup.py` | 7 | 精确名/短说法候选/未知名/按 id 不变/参数缺失；**反证**：把候选伪装成定义必须被同一条判据抓住、剥掉出处必须报问题、健康输入必须判空 |
| `tests/roco-term-lookup.test.js` | 5 | 7 种问法都触发且参数对；**49 例里 18 条非术语问句零误伤**；取不出名字 fail closed；开关两态；与图鉴政策的顺序 |
| `tests/roco-coach-activity.test.js` | +1 | `query_rules` 按 `kind` 说准 + 不许泄漏 `args` |

**判据当场抓到一个真 bug**：「这条术语是怎么定义的？」被解析成名字「**这条术语是**」
（捕获组多吃了「是」）—— 修法是去掉尾部「是/为」并显式拒绝纯指代。`roco/tests` 全量 **496 OK（1 skipped）**。

## 5. 回归（49 例，同一份代码只加这条政策）

| 指标 | 加政策前 | 加政策后 |
|---|---|---|
| 工具选择正确率 | 0.429 | **0.429** |
| 调用次数正确率 | 0.612 | **0.633**（+1 条） |
| **不该查却查了** | 0.045 | **0.045** |
| `cat2-parametric`（不该查） | 1.000 | **1.000** |
| 漏查率 / 有据回答率 | 0.519 / 0.918 | 0.519 / 0.918 |

⇒ **零退化**，且调用次数多对了 1 条。产品路径验收 `roco:coach-agent-acceptance` **6/6**；
单测全量 **1186/1186**。

## 6. 复现

```bash
KEY="$(security find-generic-password -s pet-coach-deepseek -a "$USER" -w)"
PORT=8937 DEEPSEEK_API_KEY="$KEY" node src/server/index.js &
ROCO_EVAL_ORIGIN=http://127.0.0.1:8937 node /tmp/roco-recon/term-probe.mjs '「应对」这条术语是怎么定义的？'
(cd roco && PYTHONPATH=src python3 -m unittest tests.test_term_lookup -v)
node --test tests/roco-term-lookup.test.js
```
