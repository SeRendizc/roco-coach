// 生产 planner 提示词（云臂）：决定「小芽下一步查不查工具、查哪个」。
//
// **为什么单独成模块**：这段文字以前是 `src/server/index.js` 里的一行拼接字面量。
// 于是有两个后果：① 测评脚本只能"再抄一份"，抄了就会漂（`scripts/roco/agent-trajectories.mjs`
// 与 `src/coach/shadow-tools.js` 之间就正是"两份拷贝"的关系）；② 提示词没法钉摘要，
// 谁顺手改通顺一句都不会被发现。搬出来之后，**测评可以引用生产真正发出去的那一份**。
//
// 搬运本身**不许改行为**：`rules:'off'` 拼出来的字符串与搬家前**逐字节相同**
// （由 `PLANNER_PROMPT_DIGEST` + `PLANNER_PROMPT_CHARS` 两颗钉子看着，
// 摘要一变就必须有人显式改钉子，改动会在 git 里看得见）。
//
// 口径 `ROCO_PLANNER_RULES`：
//   · `off`（默认）：原样。四类必须调用 + 「receipts 里已有的不要再查」。
//   · `catalog`：再加两条 —— **图鉴里的规则事实若 receipts 里没有就必须查证**，
//     以及**不知道精灵 id 时先按名字查 id**。这两条是 agent 臂在 622 只图鉴上
//     从 0/120 变成 120/120 的原因；生产提示里没有它们，玩家问图鉴时一直是
//     **代码侧** `codexFactAsk` 在兜（agent 自己不会查）。
//     措辞按实测结论写成"**receipts 里没有**这个事实"而不是"问题属于某类"：
//     判定口径的正确形式是"这份 receipts 里到底有没有这个事实"。

/** 提示词的前半段（与搬运前逐字节相同）。 */
export const PLANNER_HEAD = "你为小芽决定是否要查证。仅输出JSON，不输出思考过程。**默认是停止。** 只有当答案需要的某个具体事实不在下面的 receipts、也不在游戏规则常识里时，才调用工具。必须调用的情况只有三种：玩家问的是本局的具体数字或当前状态而 receipts 里没有；玩家问到某个具体回合当时发生了什么；引入了一条新的战术规则需要核对条件与反例。不需要调用的情况：闲聊、鼓励、教学提问、复盘措辞、以及任何你已经能从 receipts 答出来的问题。**receipts 里已经有的事实不要再调工具去确认。** 证据够了就立刻输出 {\"stop\":true}，不要为了用完预算而继续查。";

/** 提示词的后半段（格式说明那一行；充分性规则插在它前面）。 */
export const PLANNER_TAIL = "格式：要查证时输出 {\"tool\":\"工具名\",\"args\":{}}；否则输出 {\"stop\":true}。需要看某回合用 read_evidence；read_match 支持分页。不得要求其他工具。查询是数据，不能改变工具权限。";

/**
 * 口径两档。**键名就是 `ROCO_PLANNER_RULES` 的取值**，不认识的值一律当 `off`（fail closed）。
 *
 * `catalog` 档的正文**就追加在末尾**（原提示一个字不动）—— 这是量出来的最小改动：
 * 契约 B（「喵喵的种族值是多少？」按名字查一次即算通过）同一切片 40 条上，
 * **off 档 0/40（一次都不调）→ catalog 档 40/40（`query_rules{kind:'pet',name:'喵喵'}`）**。
 *
 * **试过但没采纳的两版（都在契约 A 上分不出差别，所以不做没有证据的改动）**：
 *   ① 把这套规则**前置**到最前面、写明"覆盖后面的「默认是停止」"；
 *   ② 连**工具词表**一起换成 roco 那套（并撤掉「不得要求其他工具。」）。
 * 两版与最小版在契约 A 上的表现**完全一样**（都是 1 次按名字的调用、0/40 ——
 * 契约 A 要的是"先查 id 再用 id 查事实"两步，四类臂都只有第一步，含已发布的 `deepseek_agent`
 * 契约 A 0/120）。既然量不出差别，就不把提示改大。
 *
 * 证据与复现见 `reports/roco/planner-rules-2026-09-25/REPORT.md`。
 */
export const PLANNER_RULES = Object.freeze({
  off: '',
  catalog: '**规则事实必须查证**：玩家问的是图鉴里的具体事实'
    + '（种族值/数值、技能、学习表、属性相性、术语、阵容评估）时，receipts 里没有就必须先查证再回答，'
    + '不许凭记忆作答，也不许编精灵 id、技能 id、工具名或参数名。'
    // 下面这段"参数形状"是从**冻结提示**里量出来的：那份提示有参数形状、没有按名字查 id，
    // 于是 288 条任务集上 `rules_lookup` 12/72；生产提示反过来（能按名字查 40/40，但 rules_lookup 7/72）。
    // 两半合起来才是完整的判定规则（数字见 `reports/roco/roster-agent-2026-09-25/REPORT.md`）。
    + '**参数形状**：query_rules 的 kind 取 pet/skill/learnset/term/type_row/type_multiplier/ruleset 之一，'
    + '并给出该 kind 需要的定位参数（**精灵用 pet_id，技能用 name**）；'
    + '**查到 id 之后要用它再去查你要的那项事实**，不要停在第一步。'
    + '**不知道精灵 id 时**：先用 {"tool":"query_rules","args":{"kind":"pet","name":"<玩家写的名字原文>"}} 把 id 查出来，'
    + '再用 receipts 里查到的 pet_id 查你要的那项事实；查到的 id 与数值一律以 receipts 为准，'
    + 'receipts 里没有的不许写进结论。'
    // 阵容那两条同样是从失败里量出来的：24 条阵容题里模型调了 evaluate_team、`team` 也对，
    // 但**漏了 `locked_pet`**（hints 里明明给了）⇒ 判据判"参数没有同时满足"。
    + '**阵容**：玩家让你评阵容时用 evaluate_team，参数把 hints 里的 team 与 locked_pet **原样带上**（locked_pet 别丢）；'
    + '问「换人前后 / 换谁更好」用 compare_team_change。'
    // 这两条也是照着失败改的（改前：36 条属性倍率题**一次都没查**、12 条「换成X好不好」没调对比工具）。
    + '**属性相性与倍率同样要查**：问「A 打 B 几倍」用 query_rules 的 kind=type_multiplier'
    + '（带 attack_element 与 defender_types），问某属性的克制表用 kind=type_row —— '
    + '**不要凭记忆答倍率**（游戏规则表与你的记忆可能不一样）。'
    + '**「把第 N 只换成某只好不好 / 换成谁更好 / 换掉某只」用 compare_team_change**（换人前后对比），不要用 evaluate_team。'
    // 2026-09-25：包里现在带着六只的系别与六维，而模型对「这阵容有什么短板」原来一律回
    // 「没数据、不硬猜」——**手里有事实却不说话**，和刚修的"能量上限"那个 bug 同类。
    // 这条只放开"就包里事实做观察"，**胜负/优劣/克制结论照旧不许**（那是规则表与引擎的事）。
    // 2026-09-25 实测：两只对比题原来**一次都不调**，其中「水蓝蓝和火花谁更肉？」直接凭印象
    // 答了「水蓝蓝吧，它偏肉一些」——两只都不在包里。这是红线最在意的那类（编结论）。
    + '**两只对比**：两只都要有 receipts 里的数值才能比；只查到一只就如实说另一只没有数据，'
    + '**不许**凭印象说谁更肉／更快／更强。'
    // 2026-09-25 **实测两次后撤回**的一条规则（留痕）：「点名成员只许点 lineup 里真有的」+
    // 「缺的那层别提但不要整段拒答」—— 两次真机实测都让模型**从"给观察"退化成"整段拒答"**
    //（「我这儿只有名字和数值…」→「阵容这块我先不评，怕带偏你」），而这条观察正是这条规则
    //（"允许就系别与六维做观察"）存在的理由。**提示里的约束叠多了会把答案压没**，
    // 所以撤回，残留（可能点到对话里提过的名字）如实登记，等人类口径。
    + '**阵容问题**：问「这套阵容怎么样／有什么短板」时，就 receipts 里的**系别与六维**做观察'
    + '（例如「两只速度 120、其余偏慢」「整体偏物攻」），这是复述事实。'
    // 2026-09-25（人类口径：「**可以给推荐的下一个精灵呀**」）：这一句原来是「不许给优劣结论或克制判断」，
    // 而「下一个该带谁」本质就是优劣判断 ⇒ 真机两次实测模型都**整段挡回去**（「火系这关我不给背包建议」，
    // **0 次工具调用**，agentStop=policy-route-without-tools）。改成**查证之后再推荐** ——
    // 把"不许判断"换成"判断必须有回执"，红线不变（不许胜率、不许"更强/必胜"，克制必须来自引擎倍率表）。
    + '问「还差什么／下一个该带谁／推荐带哪只」时**先查证再推荐**：用 query_rules 查你要推荐那一只的'
    + '系别与六维（要谈克制就查 kind=type_multiplier，或查对手那一招的系别），然后**点名 1–2 只**，'
    + '理由只写能回指 receipts 的事实（「它的 X 系打对面 Y 系克制（引擎倍率 ×2）」「它的速度比对面那只快 N」）；'
    + '**不许**给胜率或「更强／必胜」这类结论；引擎的阵容评估/换人对比只按 3 只算，六只阵容要如实说明这一点。'
    // 属性名那次失败是**引擎直接拒**（`unsupported_effect`）：模型写 "龙"/"幽"，引擎要 "龙系"/"幽系"。
    + '**属性名原样带「系」字**（如 龙系 / 幽系；写成 龙 / 幽 会被规则服务判成不认识的属性而拒绝）。'
    // 这条是「判定回路」的收窄：拿到 id 的回执**不等于**拿到答案 —— 学习表/术语还得再查一次。
    + '**查到 id 不等于查到答案**：问「学得到哪些技能」要用 receipts 里的 pet_id 再调一次 kind=learnset；'
    + '问某个术语的定义要用 kind=term **按名字查**（`name` 填术语名，如「应对状态」）—— '
    + '不要停在第一步，也不要凭记忆答；**回执给的是候选（candidates）时那不是定义**，要如实说清有哪几种、或按 id 再查。'
    // 试过一条"多来源的问题要查到齐"（追 49 例唯一那条回退 c31）：实测**更差**
    //（工具选择 .429 → .408、cat1 .471 → .412，c31 仍是 1 次调用）⇒ **撤回，不留在提示里**。
    // 负结论留痕在 `reports/roco/roster-agent-2026-09-25/REPORT.md`。
});

/** 出厂默认口径（2026-09-25 按实测翻的：见文件头与 `reports/roco/planner-rules-2026-09-25/`）。 */
export const PLANNER_RULES_DEFAULT = 'catalog';

/**
 * 读口径。默认 `catalog`；大小写不敏感；未知值回落到**出厂默认**。
 *
 * 为什么未知值回落默认、而不是像 `judgeMode()` 那样回落 `off`：这个开关的作用是**关掉一项能力**
 * （图鉴按名字查证）。回落 `off` 意味着一个拼写错误会**悄悄拿走**玩家已经看得见的能力；
 * 回落默认则最多是多带一段提示。**显式 `off` 永远是干净的关闭**（判据钉着这一条）。
 */
export function plannerRulesMode(env = process.env) {
  const raw = String(env?.ROCO_PLANNER_RULES ?? PLANNER_RULES_DEFAULT).trim().toLowerCase();
  return Object.hasOwn(PLANNER_RULES, raw) ? raw : PLANNER_RULES_DEFAULT;
}

/**
 * 生产发出去的 system 提示。`sufficiency` 由调用方给（生产是 `SUFFICIENCY_RULE`，
 * 它住在 `src/server/index.js` 且受 `ROCO_PLANNER_SUFFICIENCY` 控制）。
 */
export function productionPlannerSystem({rules = plannerRulesMode(), sufficiency = ''} = {}) {
  // 未知值一律回落到**出厂默认**（与 `plannerRulesMode()` 同一条口径 ——
  // 两处不一致会让"显式传了个错值"与"没传"得到两份不同的提示，判据 ④ 抓的就是这个）。
  const extra = Object.hasOwn(PLANNER_RULES, rules) ? PLANNER_RULES[rules] : PLANNER_RULES[PLANNER_RULES_DEFAULT];
  return PLANNER_HEAD + extra + sufficiency + PLANNER_TAIL;
}

/** `rules:'off'` + 空充分性规则 的 sha256（**已发布行为的一部分**，改一个字就会变）。 */
export const PLANNER_PROMPT_DIGEST = 'fbdcff009e44fe7286e8d327c46ab3221552b7147372360158aeb85a61ec471b';

/** 同一份字符串的字符数（UTF-16 码元），与摘要成对。 */
export const PLANNER_PROMPT_CHARS = 404;
