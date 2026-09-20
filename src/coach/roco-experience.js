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
 * 返回的对象可以直接喂给 `interventionFeatures(...)`（它再补 game/risk/timeLeft）。
 */
export function rocoPlanFeatures(plan) {
  if (!plan || plan.ok !== true) return {gap: null, skill: null, timedOut: null};
  const expected = plan.expected;
  const gap = expected && Number.isFinite(expected.min) && Number.isFinite(expected.max)
    ? Math.max(0, expected.max - expected.min)
    : null;
  // 「推荐随分析种子变化」= 这个局面没有稳健结论；技能证据按 0 处理（不压低门槛）。
  const skill = plan.recommendation_stable === false ? 0 : null;
  return {gap, skill, timedOut: plan.timed_out === true};
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
 * 提示文案：只用公开事实，且**必须**能说清「依据是什么」。
 *
 * 措辞纪律（与页面、报告口径一致）：
 *   · 不说胜率、不说「最优」、不说「一定能赢」；
 *   · 推荐动作直接用引擎给的标签；
 *   · 区间是「跨分析种子的期望区间」，不是置信区间——不写「概率」。
 */
export function rocoHintText(plan) {
  if (!plan || plan.ok !== true) return null;
  if (plan.recommendation_stable === false) {
    return '这一手没有稳健结论：换个分析种子推荐会变。先按局面常识走，局后再看取舍。';
  }
  if (!plan.recommendation) return null;
  const worst = plan.worst;
  const tail = worst && Number.isFinite(worst.min) && Number.isFinite(worst.max)
    ? `（最坏尾部 ${worst.min.toFixed(2)} ~ ${worst.max.toFixed(2)}）`
    : '';
  // 风险分支（W3-04）：这一手「脆」的时候**降级措辞**，不说「可以优先考虑」。
  // `fragile` 来自规划器按产品阈值判定的 downside，不是游戏机制。
  if (plan.risk && plan.risk.fragile === true) {
    const gap = Number.isFinite(plan.risk.downside_max) ? plan.risk.downside_max.toFixed(2) : '—';
    return `「${plan.recommendation}」这一手不稳：对手换个选择就要亏约 ${gap}，先看区间再定${tail}`;
  }
  return `可以优先考虑「${plan.recommendation}」${plan.main_counter ? `，注意对方可能${plan.main_counter}` : ''}${tail}`;
}

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
    timeLeft: Number.isFinite(host.timeLeft) ? host.timeLeft : Infinity,
  });
  return interventionDetail(features);
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
  const hint = rocoHintText(plan);
  if (!hint) return {text: '先看局面：对手场上的血条与能量都是公开的，按它来选。', why: detail.reason};
  return {text: hint, why: detail.reason};
}
