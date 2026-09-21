// 把「手游规则服务」的公开视图投影成 coach 经验层认得的局面对象。
//
// 为什么需要这一层：`coach/experience.js` 的门控与评分（`situationRisk` /
// `interventionFeatures` / `interventionDetail`）是在**旧引擎**的形状上写的
// （`game.player.pets[].maxHp`、`game.mode`、`game.result`…）。手游这一侧来自
// Python 引擎，字段名不一样（`max_hp` / `self` / `battle_result`）。
//
// 有两种做法，这里选了第二种：
//   ① 改 experience.js 让它同时认两种形状 —— 会把「谁该沉默」的判据摊到两个分支上；
//   ② 在这一层做**一次**投影，让经验层继续只认一种形状 —— 判据只有一处。
//
// 这一层是**纯函数**：没有 DOM、没有 fetch、没有计时器。所以它能被单元测试
// 直接钉住（`tests/roco-experience.test.js`），而不是只能靠浏览器验收。
//
// 一条纪律：投影只搬运**公开字段**。真实 seed、对手后备血量/配能/配招都不在这里，
// 也就不会顺着投影漏进任何提示文案。

import {interventionDetail,interventionFeaturesOfGame} from './experience.js';
import {coachAdvice, normaliseAdviceShape} from './coach-advice.js';

/** 手游 3v3 训练场在旧引擎口径下的「模式」：它属于本地 PvE 练习。 */
export const ROCO_MODE = 'pve';

/** 判断一份公开视图是不是还能玩（对应 experience.js 内部 playable 的口径）。 */
export function rocoPlayable(view) {
  return Boolean(view) && !view.battle_result && (view.phase === 'battle' || view.phase === 'replace');
}

function petOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const maxHp = Number.isFinite(entry.max_hp) ? entry.max_hp : 0;
  return {
    id: entry.pet_id ?? null,
    name: entry.name ?? entry.pet_id ?? '伙伴',
    hp: Number.isFinite(entry.hp) ? entry.hp : 0,
    maxHp,
    energy: Number.isFinite(entry.energy) ? entry.energy : 0,
    fainted: entry.fainted === true,
    status: entry.statuses && Object.keys(entry.statuses).length ? entry.statuses : null,
  };
}

/**
 * 公开视图 → 经验层认得的局面对象。
 *
 * `items` 只保留「有没有回复药」这一个经验层真的会用的计数：`situationRisk` 之外，
 * `observe()` 里那句「血量偏低，背包里还有回复药」读的就是 `player.items.potion`。
 * 手游侧的道具名是中文，所以这里做一次显式映射，而不是猜。
 */
export function rocoGameView(view, {matchId = null} = {}) {
  if (!view || typeof view !== 'object') return null;
  const self = view.self ?? {};
  const foe = view.opponent ?? {};
  const at = (side, index) => (Array.isArray(side.pets) ? side.pets[index] ?? null : null);
  const items = {};
  for (const action of Array.isArray(view.legal) ? view.legal : []) {
    if (action?.kind === 'item' && action.item_id) items[action.item_id] = (items[action.item_id] ?? 0) + 1;
  }
  return {
    id: matchId,
    mode: ROCO_MODE,
    version: view.ruleset_id ?? null,
    // `battle_result` 是这局的结果（null = 进行中）。经验层用 `result` 判断「已结束」。
    result: view.battle_result ?? null,
    phase: view.phase ?? null,
    turn: Number.isFinite(view.turn) ? view.turn : 0,
    player: {
      active: Number.isInteger(self.active) ? self.active : 0,
      items,
      pets: (Array.isArray(self.pets) ? self.pets : []).map(petOf).filter(Boolean),
    },
    enemy: {
      active: Number.isInteger(foe.active) ? foe.active : 0,
      // 对手场上那一只是公开的；后备在公开视图里只有位次与是否倒下，
      // 这里**不**给它补血量——补了就等于编造隐藏信息。
      pets: [foe.field, ...(Array.isArray(foe.bench) ? foe.bench : [])]
        .filter(Boolean)
        .map((entry, index) => (index === 0 ? petOf(entry) : { id: entry.pet_id ?? null, name: entry.pet_id ?? null, hp: null, maxHp: null, energy: null, fainted: entry.fainted === true, status: null })),
    },
    // 保留原始视图，供页面渲染与「为什么现在说」的解释入口使用。
    roco: view,
  };
}

/**
 * 从一份公开视图 + 一次规划结果里，取出门控与评分要的特征。
 *
 * `gap` 用的是规划器的**期望值区间宽度**（expected.max - expected.min）：区间越宽，
 * 说明这一手越依赖随机性，越不值得用一句短提示把玩家钉住。这里**不**用 worst 的绝对值，
 * 因为那是估值函数的口径（负数很常见），拿它当「分差」会系统性误判。
 *
 * ⚠️ **第 39 轮实测：手游引擎上 `gap` 恒为 0。**
 * 服务端把 `expected` 聚合成 `{min,max,mean}` 是靠跑三个分析种子
 * （`service.py` 里的 `for sv in raw_seeds`），但 `plan_actions` 在重建出来的分析状态上
 * 是**确定性**的：192 个运行时窗口 × 3 个种子，`expected` 逐位相同 → `gap ≡ 0`。
 * 后果不是「很少触发」，而是**结构上不可能触发**：
 *   · `interventionScore` 的 `decisive-gap` 分支在这条链上是**死代码**；
 *   · `value = 3*risk + 1.2*min(gap/5, 1)` 的第二项恒为 0；
 *   · 于是规则在手游侧**只按血量档位说话**（`speaks ⟺ risk >= 0.4 ⟺ hp_ratio <= 0.6`）。
 * 「规则用规划器分差判断」这句话在手游侧不成立，任何据此写下的结论都要重读。
 * 这一条由 `tests/evals/roco/intervention-agreement.test.js` 用**真服务**钉住，
 * 免得它哪天变回非零而没人知道；页面上的「期望区间」也据此改成按真实形状说话
 * （见本文件的 `expectedLine`，页面直接 import 它）。
 *
 * 返回的对象可以直接喂给 `interventionFeatures(...)`（它再补 game/risk/timeLeft）。
 */
/**
 * 从 plan 里取出「枚举第一与第二的估值差」这一个数。
 *
 * **它有三种形状，而且第三种是真实 bridge 用的那一种**（第 39 轮实测）：
 *   1. 标量，camelCase `firstSecondMargin` —— 工具回执（`toolbox.js` 给模型看的那份）；
 *   2. 标量，snake_case `first_second_margin` —— 早期假设的页面形状；
 *   3. 对象 `{min, max, mean, scale, note}`，snake_case —— **`/api/roco/plan` 真的发的是这个**
 *      （服务端把三个分析种子的结果聚合成区间）。
 *
 * 只认前两种的后果不是报错，而是 `Number.isFinite({...}) === false` →
 * `margin = null` → 判定层退回 sigmoid 兜底口径 → **页面上永远放行**。
 * 这就是第 21、30 轮之后同一形状问题的第三次复现，而第 30 轮那条端到端守卫
 * 之所以没抓住，是因为它自己捏了一个标量 `first_second_margin: mean` 喂进来。
 *
 * 取 `mean` 的理由：训练侧（`build-roco-intervention-windows.py`）用的是
 * **单次** `plan_actions` 的标量，三个种子的均值是与它同量纲、同尺度的聚合；
 * 阈值 `decision_margin_threshold = 0.146532` 是在那把尺子上标定的。
 * 区间本身宽不宽由 `recommendation_stable` 另行表达（不稳定时 `skill` 记 0）。
 */
export function firstSecondMarginOf(plan) {
  if (!plan) return null;
  const candidates = [plan.firstSecondMargin, plan.first_second_margin];
  for (const value of candidates) {
    if (Number.isFinite(value)) return value;
    if (value && typeof value === 'object' && Number.isFinite(value.mean)) return value.mean;
  }
  return null;
}

export function rocoPlanFeatures(plan) {
  if (!plan || plan.ok !== true) return {gap: null, skill: null, timedOut: null, margin: null};
  // 枚举第一与第二名的估值差。**两种写法都认**，因为同一个量在两个边界上的命名不同：
  //   · 工具回执（toolbox.js 里给模型看的那个）用 camelCase `firstSecondMargin`；
  //   · 页面这一侧的 plan 直接来自 `/api/roco/plan`（服务端由 Python 回执原样透传）
  //     用 snake_case `first_second_margin`。
  // 只认一种的后果不是报错，而是**安静地拿到 null**：判定层退回 sigmoid 口径，
  // 运行时永远放行——「接上了但不生效」这类问题在第 21 与第 30 轮各出现过一次，
  // 两次都是同一条量在搬运中换了名字。
  const margin = firstSecondMarginOf(plan);
  const expected = plan.expected;
  const gap = expected && Number.isFinite(expected.min) && Number.isFinite(expected.max)
    ? Math.max(0, expected.max - expected.min)
    : null;
  // 「推荐随分析种子变化」= 这个局面没有稳健结论；技能证据按 0 处理（不压低门槛）。
  const skill = plan.recommendation_stable === false ? 0 : null;
  return {gap, skill, timedOut: plan.timed_out === true, margin};
}

/**
 * 陈旧判定的唯一入口。
 *
 * 提示是在某个 `state_version` 上算出来的；那条局面一旦推进（换人、结算、补位），
 * 旧提示就必须作废。这里把判定收成一处，页面上不再各写一份比较。
 */
export function rocoHintStale(hint, version) {
  if (!hint || !Number.isInteger(hint.stateVersion)) return true;
  return hint.stateVersion !== version;
}

/**
 * （已删除）旧的 `rocoHintText(plan)`。第 43 轮删掉，理由留在这里：
 *
 * 它**只拿得到 planner 结果**，看不到局面，于是每一手「脆」的局面都落到同一句
 * 「「X」这一手不稳：…先看区间再定（最坏尾部 a ~ b）」——玩家实测判定为没用，
 * 而且「区间/尾部」是工程话，不该出现在给玩家的气泡里。
 *
 * 现在由 `coach-advice.js` 依据真实局面产出建议（做什么 / 为什么是现在 / 一个风险），
 * `rocoIntervention` 在手里还有 view/session/plan 的时候就算好挂在 `detail.advice` 上。
 * 保留这段说明是为了让后来的人知道**为什么这里空了**，而不是再写一个「只吃 plan」的文案函数。
 */

/**
 * 局末教学入口：一局结束后给**一个**关键决策点，而不是一份战报。
 *
 * 返回 null 表示这一局没有可教的东西——「没有亮点不硬夸」这条纪律在代码里，
 * 不在文案里。
 */
/**
 * 伤害预览写成一句话。
 *
 * 这一栏回答的是玩家真正会问的那个问题：「这一下打多少、够不够收」。
 * 两条纪律：
 *   · 数字来自**未核验公式**，所以必须带「估」字，不能说得像实测值；
 *   · `lethal_stable` 为假时不许说「能收掉」——结论随分析种子变化就不是结论。
 */
export function rocoDamagePreviewText(plan) {
  const dp = plan?.damage_preview;
  if (!dp || dp.available !== true) return null;
  if (!Number.isFinite(dp.min) || !Number.isFinite(dp.max)) return null;
  const span = dp.min === dp.max ? `${dp.max}` : `${dp.min}~${dp.max}`;
  const parts = [`按未核验公式估，这一步能打出 ${span} 点伤害`];
  if (dp.best_label) parts.push(`最高的是「${dp.best_label}」`);
  if (Number.isFinite(dp.foe_hp)) {
    if (dp.lethal === true && dp.lethal_stable === true) {
      parts.push(`对面场上还剩 ${dp.foe_hp}，够收掉`);
    } else if (dp.lethal === true) {
      parts.push(`有的分析种子能收掉（${dp.foe_hp}），换一个就不一定，别当保证`);
    } else {
      parts.push(`对面场上还剩 ${dp.foe_hp}，这一下收不掉`);
    }
  }
  return parts.join('；');
}

export function rocoLessonEntry({events = [], turns = 0} = {}) {
  const list = Array.isArray(events) ? events : [];
  const faints = list.filter((e) => e?.kind === 'faint' || e?.kind === 'damage' && e?.detail?.fainted === true);
  const switches = list.filter((e) => e?.kind === 'replace' || e?.kind === 'switch');
  if (!faints.length && !switches.length) return null;
  const focus = faints.length ? faints[faints.length - 1] : switches[switches.length - 1];
  return {
    turn: Number.isFinite(focus?.turn) ? focus.turn : null,
    kind: focus?.kind ?? null,
    question: faints.length
      ? '倒下那一回合，如果先用回复药或先换一只不被克的，后面会不一样吗？'
      : '那次换人是为了挡哪一手？事后看值不值？',
    note: `这一局共 ${turns} 个回合。只挑这一个决策点，不把整局复盘一遍。`,
  };
}

/**
 * 主动提示判定的**唯一入口**。
 *
 * 页面上有三处在问「现在要不要说话」（开局与换阵容后、每回合结束时、玩家操作后）。
 * 如果各写一份判定，就会出现「一处在冷却里、另一处照说不误」这种自相矛盾的提示。
 * 所以三处都走这一个函数，它只是把特征喂给经验层，并**不再自己判一遍**。
 *
 * 返回经验层的原样结论 `{action, gate, reason, value, floor, decisive, budget}`：
 *   · `action === 'silent'` 时页面不该显示任何东西；
 *   · `gate` 非空时 `reason` 形如 `hard-gate:stale-state`，页面上的「为什么现在说」
 *     直接显示它 —— 这正是 F01 那条「状态变化撤销旧建议」要的证据。
 */
export function rocoIntervention({view = null, session = null, plan = null, host = {}, now = Date.now()} = {}) {
  const game = rocoGameView(view, { matchId: host.matchId ?? null });
  const planFeatures = rocoPlanFeatures(plan);
  // 装配走经验层自己的那一个函数（只此一处字段清单），这里不重抄一遍。
  const features = interventionFeaturesOfGame({
    game,
    attention: null,
    session,
    mode: host.preference ?? 'gentle',
    now,
    host,
    risk: Number.isFinite(host.risk) ? host.risk : null,
    gap: planFeatures.gap,
    skill: planFeatures.skill,
    // 判定层的 `planner_margin_norm` 用的是**枚举第一与第二名的估值差**。
    // 规划器现在会把它带进回执（`PlanResult.first_second_margin` →
    // 工具回执 `firstSecondMargin`），所以这里**真的**有值可传了。
    // ⚠️ 量纲不同：本引擎实测 0.02—0.08，判定层里的 `GAP_SCALE = 5` 是旧演示引擎的尺子，
    // 因此判定层尚未按本引擎标定，见 docs/roco/W5-04-INTERVENTION-GATE.md §10.4。
    plannerMargin: planFeatures.margin,
    timeLeft: Number.isFinite(host.timeLeft) ? host.timeLeft : Infinity,
  });
  const detail = interventionDetail(features);
  // ── P1：建议必须**因局面而异**（第 43 轮的真实失败样例）────────────────
  //
  // 旧的 `rocoHintText(plan)` 只拿得到 planner 结果，于是每一手「脆」的局面都落到
  // 同一句「…先看区间再定（最坏尾部 …）」，玩家实测判定为没用。根因是**结构**：
  // 判定完之后position 就被丢掉了。
  //
  // 现在在这里（手里还有 view/session/plan/host）先把建议算出来挂到 detail 上，
  // 文案层只负责把它取出来。`coachAdvice` 返回 null 表示**这一手没有值得说的局面事实**，
  // 那就沉默——不为了「总得说点什么」退回旧模板。
  detail.advice = null;
  detail.advice_error = null;
  try {
    detail.advice = coachAdvice({game, plan, session, host});
  } catch (error) {
    // 建议层出问题**不许**把整页搞挂，也不许退回旧模板：记下错误、这一手沉默，
    // 错误留给开发者面板。上下文留给排查，别吞掉。
    detail.advice_error = {message: String(error?.message ?? error).slice(0, 200),
      at: new Date().toISOString()};
  }
  return detail;
}

/**
 * 提示文案：把经验层的结论 + 规划结果写成一句**能核对的**话。
 *
 * 措辞纪律（与页面、报告口径一致）：
 *   · 不说胜率、不说「最优」、不说「一定能赢」；
 *   · 推荐动作用引擎给的标签；
 *   · 区间是「跨分析种子的期望区间」，不是置信区间——不写「概率」。
 */
export function rocoInterventionText(detail, plan) {
  if (!detail || detail.action === 'silent') return null;
  if (detail.action === 'defer_to_review') {
    return {text: '这一手值得留到局后看一眼。现在先按你的判断走。', why: detail.reason};
  }
  // **建议层优先**。它看得到局面（换宠博弈 / 速度 / 能量 / 状态 / 后备 / 上一手），
  // 而 `plan` 只当作证据。它说 null 就沉默：硬说一句「引擎推荐 X」正是要修掉的毛病。
  const advice = detail.advice ?? null;
  if (advice) {
    return {
      text: advice.text,
      // 「为什么是现在 + 一个关键风险」一起给玩家；工程术语只进展开证据。
      why: [advice.why, advice.risk ? `风险：${advice.risk}` : null].filter(Boolean).join(' · '),
      kind: advice.kind,
      evidence: advice.evidence,
      shape: normaliseAdviceShape(advice.text),
    };
  }
  // 建议层说「这一手没有值得说的局面事实」→ **沉默**。
  //
  // 第 43 轮的产品口径：没有稳定优势时允许沉默，硬说一句就是玩家抱怨的那种废话。
  // 这里返回 null，页面整条提示不出现（门控层已经决定「可以说话」，但「有话可说」
  // 是另一回事——`detail.reason` 里的 `critical-risk` 这类工程词因此也不会漏给玩家）。
  if (detail.advice_error) {
    // 建议层出错要看得见，但看的地方是开发者面板，不是玩家气泡。
    return null;
  }
  return null;
}

/**
 * 「期望」那一行怎么写。
 *
 * 第 39 轮实测：手游引擎上三个分析种子给出的 `expected` **完全相同**
 * （`gap = expected.max - expected.min` 在所有量过的窗口里恒为 0），
 * 因为 `plan_actions` 在重建出来的分析状态上是确定性的。
 * 所以原来那句「期望区间：0.58 ~ 0.58（均值 0.58）」是把一个**点估计**写成区间
 * ——标签承诺了一个它没有的东西。这里按真实形状说话：
 *   · 区间真的有宽度 → 写区间；
 *   · 三个种子一致 → 写「估计 X（三个分析种子一致）」，不假装有区间。
 * 两种都注明「不是胜率、不是置信区间」。
 */
export function expectedLine(plan) {
  const expected = plan?.expected;
  if (!expected || !Number.isFinite(expected.min) || !Number.isFinite(expected.max)) {
    return '期望值：——（引擎没给出）';
  }
  const width = expected.max - expected.min;
  if (width <= 1e-9) {
    return `期望估计：${expected.mean.toFixed(2)}（三个分析种子给出同一个值，所以这里没有区间可报）`;
  }
  return `期望区间：${expected.min.toFixed(2)} ~ ${expected.max.toFixed(2)}（均值 ${expected.mean.toFixed(2)}）`;
}
