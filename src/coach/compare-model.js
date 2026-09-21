// 可展开的**并列比较模型**：把「这一回合能走的动作」与「往后 2—3 回合的后果」
// 收成一个**结构化、可断言**的对象。
//
// 为什么要有这一层（第 65 轮）
// ===========================
// 比较区的第一版是**直接写 HTML** 的（`src/client/roco.js` 的 `compareBlockHtml`）。
// 后果是：那份比较只存在于浏览器里——mock 宿主、报告、评测脚本都拿不到它，
// 于是「建议合法且可执行」「可展开的多动作比较 + 未来 2—3 回合后果」这两条
// 就只能靠截图证明，不能靠断言证明。
//
// 现在把**模型**放在核心侧（纯函数、零依赖），页面只负责把它渲染出来。
// 一条纪律随之写死：**标签即口径**——
//   · 【事实】= 引擎/公开视图真的给了的东西（合法动作表、动作名字、能耗、威力来源状态）；
//   · 【估计】= 引擎算出来但**未核验**的东西（期望值、伤害估算、对手应对）；
//   · 【不确定】= 引擎**没给**的东西，如实说没给（**不补数字**）。
//
// 这一层不产出新的数值：每一个数字都来自 `plan` 或 `view`，缺了就写成「没给」。

import {expectedLine, rocoDamagePreviewText} from './roco-experience.js';

/** 引擎一次规划最多并列几个动作。与页面原来的 3 个一致（第 1 个 + 推荐那一手）。 */
export const COMPARE_PICK_LIMIT = 3;

const isObj = (value) => Boolean(value) && typeof value === 'object';

/**
 * 造出并列比较模型。
 *
 * @param {object} input
 * @param {object} input.plan    `/api/roco/plan` 的回执（可以为 null：没跑规划）
 * @param {Array}  input.legal   这一回合的**真实合法动作**（来自公开视图，一个都不编）
 * @param {object} input.view    公开视图（用来交叉核对动作名字）
 * @returns {{available:boolean, reason:string|null, picks:Array, future:Array, recommended:string|null}}
 */
export function rocoCompareModel({plan = null, legal = null, view = null} = {}) {
  const actions = Array.isArray(legal) ? legal : (Array.isArray(view?.legal) ? view.legal : []);
  const ok = isObj(plan) && plan.ok === true;
  const recommended = ok ? (plan.recommendation ?? plan.recommended_label ?? null) : null;
  if (!actions.length) {
    return {
      available: false,
      reason: '这一刻引擎没有给出可执行的动作（可能已经打完这一局）',
      picks: [],
      future: [],
      recommended: null,
    };
  }
  // 至少并列 2 个合法动作；**推荐那一手必须在里面**——否则「引擎推荐」那一行会漏掉。
  const picks = actions.slice(0, COMPARE_PICK_LIMIT);
  if (recommended !== null && !picks.some((a) => (a?.label ?? '') === recommended)) {
    const hit = actions.find((a) => (a?.label ?? '') === recommended);
    if (hit) {
      if (picks.length >= COMPARE_PICK_LIMIT) picks[picks.length - 1] = hit;
      else picks.push(hit);
    }
  }
  const preview = ok ? rocoDamagePreviewText(plan) : null;
  const dp = ok && plan.damage_preview?.available === true ? plan.damage_preview : null;
  const rows = picks.map((action, index) => {
    const skill = action?.skill ?? null;
    // 威力**只在引擎给了数值**的时候写进玩家看的那一行。
    //
    // 第 65 轮这里写过「威力：来源未给」——那是 `power_status: 'not_provided_by_source'`
    // 的直译，是**工程话**，第 64 轮已经定过口径「没给就不写」，而这一句把它带回了
    // 玩家点得到的比较区（`demo-acceptance` 的 ④ 当场变红，实测命中「来源未给」）。
    // 口径回到第 64 轮：玩家层**整段不写**；原文是啥样、谁没给，
    // 由同一行的 `power_status`（原始代码）+ 开发者抽屉的 `#power-status-raw` 逐条留证。
    const powerKnown = Number.isFinite(skill?.power);
    const powerUnknown = !powerKnown && typeof skill?.power_status === 'string' && skill.power_status !== 'static_value_present';
    const bits = [
      skill?.element ?? action?.element ?? null,
      skill?.category ?? null,
      Number.isFinite(skill?.energy) ? `能耗 ${skill.energy}` : (Number.isFinite(action?.energy) ? `能耗 ${action.energy}` : null),
      powerKnown ? `威力 ${skill.power}` : null,
    ].filter(Boolean);
    const label = action?.label ?? action?.kind ?? '（没有名字的动作）';
    const isRecommended = recommended !== null && label === recommended;
    const lines = [
      {tag: '事实', text: `第 ${index + 1} 个合法动作：${label}${bits.length ? `（${bits.join(' · ')}）` : ''}`},
    ];
    if (isRecommended && ok) {
      lines.push({tag: '估计', text: `引擎推荐这一手：${expectedLine(plan)}${dp && dp.best_label === skill?.name && preview ? `；${preview}` : ''}`});
    } else if (ok) {
      lines.push({tag: '不确定', text: '往后 2—3 回合的推演：引擎这一次只算出了推荐那一手，这个动作没有单独的后续推演（拿不到就不编）。'});
    } else {
      lines.push({tag: '不确定', text: '这一手没有跑通规划：引擎没给后续回合的推演（拿不到就不编）。'});
    }
    return {
      index,
      label,
      recommended: isRecommended,
      legal: true,
      // 给**开发者**看的那一列（玩家层不渲染它）：威力到底有没有来源、来源状态是什么代码。
      // 玩家那一行只是「不写」，事实本身不许因此消失。
      dev: {
        power: powerKnown ? skill.power : null,
        power_status: typeof skill?.power_status === 'string' ? skill.power_status : null,
        power_unknown: powerUnknown,
      },
      lines,
    };
  });

  const future = [];
  if (ok) {
    const depth = plan.depth_searched ?? null;
    const branches = plan.branches_evaluated ?? null;
    const seeds = Array.isArray(plan.analysis_seeds) ? plan.analysis_seeds : [];
    future.push({
      tag: '事实',
      text: `引擎把这一手往后算了 ${depth === null ? '（没给层数）' : `${depth} 层`}、覆盖 ${branches === null ? '（没给分支数）' : `${branches} 个分支`}${seeds.length ? `（固定分析种子 ${seeds.join('/')}）` : ''}。`,
    });
    future.push({tag: '估计', text: expectedLine(plan)});
    future.push(
      plan.main_counter
        ? {tag: '估计', text: `对手最可能的应对：「${plan.main_counter}」——引擎说这是启发式建模，不是真人行为。`}
        : {tag: '不确定', text: '对手最可能的应对：引擎这一次没给。'},
    );
    future.push(preview ? {tag: '估计', text: preview} : {tag: '不确定', text: '伤害估算：引擎这一次没有给出可用的预览。'});
    if (plan.risk) {
      future.push({
        tag: '不确定',
        text: `风险：期望到最坏差 ${plan.risk.downside_max ?? '（没给）'}${plan.risk.fragile ? '（这一手不稳）' : ''}${plan.risk.top_risks?.length ? ` · 最差的对手选择是「${plan.risk.top_risks[0].opponent_action}」` : ''}`,
      });
    }
    if (plan.recommendation_stable === false) {
      future.push({tag: '不确定', text: '引擎说这一手**没有稳健结论**：换个分析口径推荐的动作就会变，所以上面那条推荐只能当参考，不是保证。'});
    }
  } else {
    future.push({tag: '不确定', text: '往后 2—3 回合的后果：这一手没有跑通规划，引擎没给（拿不到就不编）。'});
    future.push({tag: '不确定', text: '这条只是提醒你把注意力放到哪，不含具体数值结论。'});
  }
  return {available: true, reason: null, picks: rows, future, recommended};
}

/**
 * 比较模型里出现过的**每一个动作名字**，并标注它在**这一回合**是不是真的可执行。
 *
 * 用途：合法性判据（「建议里的动作必须在这一回合的合法动作表里」）不用正则去刮文案，
 * 而是直接问模型「你说到哪些动作」，再拿合法动作表逐个核。
 *
 * ⚠️ 「说过」不等于「建议用它」。推荐那一手如果**这一轮放不出来**（能量不够），
 * 引擎仍然会推荐它（`plan.recommendation` 就是它），而文案会把它说成
 * 「**这一轮放不出**（能量不够）」——那是「引擎说得出、这一轮做不到」这件事本身，
 * 把 X 判成「非法建议」是**错的判据**。
 *
 * 所以每一条带两个标记，判据只看第一个：
 *   · `blocked_notice` —— 文案**明确**说过「这一轮放不出 / 不在合法动作表里 /
 *     做不到 / 能量不够」。为真 → 不是一条可执行建议，合法性判据放行；
 *   · `mentioned_only` —— 只是被**提到**（「X 的估算伤害…」这种解释性引用），
 *     不是一个行动提议。
 *
 * 两个标记都只由**文案本身**决定，不看调用方的心情：判据必须是可复算的。
 */
export function compareActionNames(model) {
  const names = new Map();
  /**
   * 收一个名字。`line` 是它所在的那一整行（带标签），`context` 说明这行是什么。
   *
   * 三类**不是行动提议**的出现方式（判据必须把它们排除，否则会造出假越界）：
   *   ① 这一轮做不到：文案写明「不在合法动作表 / 放不出 / 做不到 / 能量不够」；
   *   ② 对手的应对：「对手最可能的应对：「X」」——建模出来的**对手**动作；
   *   ③ 后果推演：那一行标着【估计】/【不确定】且在讲后果（期望值、伤害估算、风险），
   *      里面出现的动作名是**被讨论的对象**，不是叫玩家现在去做的事。
   *
   * 剩下的（尤其【事实】行里的「先吃「能量果」补上」）才算可执行建议，
   * 必须在这一回合的合法动作表里。
   */
  const add = (name, source, line, tag) => {
    if (!name) return;
    const row = names.get(name) ?? {name, sources: [], blocked_notice: false, mentioned_only: false};
    row.sources.push(source);
    const text = String(line ?? '');
    if (/(不在合法动作表|放不出|这一轮用不了|用不了|做不到|能量不够|还差\s*\d+\s*点能量)/.test(text)) {
      row.blocked_notice = true;
    }
    const aboutOpponent = /(对手|对面|它)(最可能|会|可能|要)/.test(text);
    const consequenceLine = (tag === '估计' || tag === '不确定')
      && /(期望|伤害|风险|推演|估计|应对|最坏|区间)/.test(text);
    if (!row.blocked_notice && (aboutOpponent || consequenceLine)) row.mentioned_only = true;
    names.set(name, row);
  };
  for (const pick of model?.picks ?? []) add(pick?.label, 'pick', '', '事实');
  for (const line of model?.future ?? []) {
    const text = String(line?.text ?? '');
    for (const hit of text.match(/「([^」]{1,12})」/g) ?? []) {
      // 用**整行**当上下文，而不是名字后面若干个字：一行就是一句完整的结论。
      add(hit.slice(1, -1), 'future', text, line.tag);
    }
  }
  return [...names.values()];
}

/** 只取名字（给「不关心来源」的调用方）。 */
export function compareActionNameList(model) {
  return compareActionNames(model).map((row) => row.name);
}

/** 三档标签的计数（测试与报告用它证明三档都真的出现过）。 */
export function compareTagCounts(model) {
  const counts = {事实: 0, 估计: 0, 不确定: 0};
  for (const row of model?.picks ?? []) for (const line of row.lines) counts[line.tag] = (counts[line.tag] ?? 0) + 1;
  for (const line of model?.future ?? []) counts[line.tag] = (counts[line.tag] ?? 0) + 1;
  return counts;
}
