// 「小芽在查 / 在算 / 在纠错」——把**真实的**工具回执翻成玩家话（2026-09-25）。
//
// 为什么要有这个模块：agent 线做了一整天，`toolTrace` / `agentStop` / 降级原因一直只写进
// `document.body.dataset` 与 HTTP 回执里 —— **玩家一个字都看不到**。于是"agent 到底做了什么"
// 在页面上等于不存在：玩家只看到一句回复，看不出小芽刚去查了图鉴、算了这回合、或者把模型
// 那句没过核对的话换成了引擎结论。人类点名的第三条交付正是「玩家看得见」。
//
// 三条纪律（这一层只做翻译，不新增事实）：
//   ① **只描述发生过的事**：没有回执就没有词。**绝不**装饰性地写「已查证」；
//   ② **不泄漏工程面**：产出里不许出现精灵/技能 id、工具参数、字段名、来源路径 ——
//      玩家话是「查了图鉴」，不是「query_rules{kind:'learnset',pet_id:'pet_000012'}」；
//   ③ **降级要说出来**：模型正文被事实守卫/回执一致性拦下时，玩家看到的那句其实是引擎结论，
//      这必须写在脸上（否则就是"悄悄换了一份答案"，比不显示更坏）。
//
// 这一层是**纯函数**：输入回执，输出词。判定与措辞都在测试里钉着。

/**
 * 工具名 → 玩家话。**键必须覆盖 `TOOL_CONTRACTS` 的全部工具**（测试逐键核对）：
 * 漏一个工具，那条回执就会在界面上变成沉默 —— 而"沉默"和"没查"在页面上长得一样。
 */
export const TOOL_WORDS = Object.freeze({
  read_state: '看了当前局面',
  search_rules: '查了规则与战术',
  compare_actions: '比了可选行动',
  simulate_branch: '模拟了后续走向',
  read_match: '翻了整局统计',
  read_evidence: '翻了那一回合',
  read_last_turn: '回看了上一回合',
  query_rules: '查了图鉴',
  evaluate_team: '评了阵容',
  compare_team_change: '比了换人前后',
  plan_actions: '算了行动建议',
  summarize_battle: '做了复盘摘要',
});

/** 降级原因 → 玩家话（`runCoach` 的 `rejectedReason` 取值域）。 */
const FALLBACK_WORDS = Object.freeze({
  ungrounded: '模型那句话里有对不上的数字，已经换成引擎自己的结论',
  'receipt-inconsistent': '模型那句话和引擎回执对不上，已经换成引擎自己的结论',
  'too-long': '模型那句话太长，已经换成引擎自己的结论',
});

/**
 * **包级的引擎事实** → 玩家话。
 *
 * 为什么要有这一组（对局路径验收量出来的缺口）：回答「这一手引擎推荐换第4位。」**一次工具都没调**
 * —— 它直接引用引擎已经算好的本回合规划。按"没有回执就没有词"的纪律，活动行是空的，
 * 于是**玩家看不出"引擎算过"** —— 而"在算"正是人类点名的三个动词之一。
 * 所以这里把"这一轮包里带了哪些引擎事实"如实翻出来。措辞是"**给了什么**"，不是"用了什么"：
 * 模型有没有采纳某条事实，这一层无从判断，也不替它宣称。
 */
const PROVIDED_WORDS = Object.freeze({
  plan: '本回合的规划（引擎算的）',
  battle: '场上战况',
  lineup: '你选的六只',
  roster: '你的名单',
});

/**
 * `query_rules` 一个工具管着好几张表（图鉴 / 术语 / 属性 / 规则集版本）。
 * 玩家话按 `kind` 说准一点 —— 实测里术语题也显示「查了图鉴」，那是不准确的说法。
 * **只看 `kind` 这个字面量**，绝不把 `args` 里的 id / 值带进玩家话（判据钉着不许泄漏）。
 */
const QUERY_RULES_WORDS = Object.freeze({
  term: '查了术语表',
  type_row: '查了属性表',
  type_chart: '查了属性表',
  type_multiplier: '查了属性相性',
  ruleset: '查了规则集版本',
});

/**
 * 把回执翻成玩家话。
 *
 * @param {{trace?:Array, rejected?:boolean, rejectedReason?:string|null, provided?:object|null,
 *   answerCorrection?:boolean, answerCorrectionRetried?:boolean}} input
 *   `provided`：这一轮的包里带了哪些引擎事实（`{plan, battle, lineup, roster}`）。
 *   `answerCorrection`：这一轮**答案层**真的改写重问过一次（模型正文没过核对 ⇒ 拿同一条错误回执
 *   再问一次）。它与工具层纠错共用同一张券，所以两者只会有一个为真；
 *   `answerCorrectionRetried`：同一个原因**上一轮已经试过一次还没改对** ⇒ 这一轮不再试，
 *   只说清"这条我试过一次没改对，这轮给你已核验的结论"。
 * @returns {{words:string[], sources:string[], corrected:boolean, answerCorrected:boolean,
 *   fallback:boolean, fallbackReason:string|null, steps:number, fallbackNote:string|null}}
 */
export function coachActivity({trace = [], rejected = false, rejectedReason = null, provided = null,
  answerCorrection = false, answerCorrectionRetried = false} = {}) {
  const words = [];
  let toolCorrected = false;
  let answerCorrected = false;
  for (const item of Array.isArray(trace) ? trace : []) {
    // 纠错回执本身**不是查到的东西**：它记的是"这一枪打歪了"。它只贡献 `corrected` 这一个词。
    if (item?.chosenBy === 'correction') {
      // 答案层纠错（`answer:err:*`）是"改写过一次**回答**"，不是"改过一次**工具用法**"。
      // 两句话分开说：把答案层说成工具用法，就是替玩家描述一件没发生过的事（本层第①条纪律）。
      if (String(item?.id ?? '').startsWith('answer:err:')) answerCorrected = true;
      else toolCorrected = true;
      continue;
    }
    // **缺参回执不是"查过"**：那种回执记的是"参数构造不出来、没有执行"（`result.missing`）。
    // 把它翻成「比了换人前后」就是替引擎宣称做过一件没做的事（2026-09-25 自查发现：
    // 六只阵容下换人对比政策会写这样一条回执，活动行差点就显示成"比过"）。
    if (item?.result?.missing === true) continue;
    const word = item?.tool === 'query_rules' && QUERY_RULES_WORDS[item?.args?.kind]
      ? QUERY_RULES_WORDS[item.args.kind]
      : TOOL_WORDS[item?.tool];
    if (word && !words.includes(word)) words.push(word);
  }
  // 包级事实：只列**真的带了**的那些（没带就不许说）。
  const sources = [];
  for (const [key, word] of Object.entries(PROVIDED_WORDS)) {
    if (provided?.[key] === true && !words.includes(word)) sources.push(word);
  }
  const fallback = Boolean(rejected);
  const reason = fallback ? String(rejectedReason || '') : null;
  // 「降级要说出来」的第四种情形（2026-09-25，答案层一次纠错）：核对没过**先不给降级**，
  // 拿错误回执再问了一次模型；这次改写**没成**才降级。所以降级说明要连着这次尝试一起说，
  // 否则玩家以为小芽一次都没试过就直接换了答案。
  const fallbackNote = fallback
    ? (FALLBACK_WORDS[reason] ?? '模型那句话没过事实核对，已经换成引擎自己的结论')
      + (answerCorrection ? '；这句核对没过，改写一次后还是没过' : '')
      + (answerCorrectionRetried ? '；这条我试过一次没改对，这轮给你已核验的结论' : '')
    : null;
  return {
    words,
    sources,
    // `corrected` 的老语义（工具层纠错）一个字不变；答案层纠错另有一个字段，
    // 因为它对应的是另一句话（见 activityLine）。
    corrected: toolCorrected,
    answerCorrected,
    fallback,
    fallbackReason: reason,
    steps: words.length,
    // 玩家话里的降级说明：认识的原因给具体说法，不认识的原因**如实说"没过核对"**（不编原因）。
    fallbackNote,
  };
}

/**
 * 拼成页面上那一行「依据：…」。空活动返回 `null`（调用方据此**不渲染**这一行）。
 * 这一行里不许有数字与 id —— 由测试喂带 id 的回执来钉。
 */
export function activityLine(activity) {
  const words = Array.isArray(activity?.words) ? activity.words : [];
  const sources = Array.isArray(activity?.sources) ? activity.sources : [];
  const parts = [...words, ...sources];
  if (activity?.corrected) parts.push('中途改过一次工具用法');
  if (activity?.answerCorrected) parts.push('核对之后改写过一次');
  if (!parts.length && !activity?.fallback) return null;
  const basis = parts.length ? `依据：${parts.join(' · ')}` : '依据：引擎结论';
  return activity?.fallbackNote ? `${basis}（${activity.fallbackNote}）` : basis;
}
