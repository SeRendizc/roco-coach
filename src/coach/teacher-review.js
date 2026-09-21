// 老师（teacher）这一角色的局末复盘与后续验证。
//
// 三个角色不许互相顶替：军师管局内该不该提醒（`coach-advice.js`）、陪练管情绪与偏好
// （`companion.js`）、老师管**一局打完之后的复盘**，以及**在后面的局里核对学到了没有**。
// 这个文件只做老师那两件事，不产出一句局内提示。
//
// 为什么不改写 `roco-experience.js` 的 `rocoLessonEntry`：
// 它返回的是**一个固定问句**（「倒下那一回合，如果先用回复药或先换一只不被克的…」），
// 这句话只取决于「有没有倒下 / 有没有换人」，与这一局**实际发生了什么**无关。
// 后果是两局完全不同的对局会得到同一句话，而且没有任何一处会去查玩家后来改没改——
// 那不是复盘，是一句印在卡片上的话。所以这里另起一层：
//   · 转折点由事件按**写死的规则**选（规则名随结果一起返回，可核对）；
//   · 学习点由转折点的**成因**决定，不是固定问句；
//   · 学习点带一个机器可读的 goal 标签，后面的局才能查同一个局面有没有再出现。
//
// 纪律（与 `coach-advice.js` / `roco-experience.js` 同口径，这里是代码而不是文案）：
//   · 不说胜率、不承诺胜负、不说「最优」；
//   · 这一局没有转折点就返回 null，宁可沉默，绝不编一个「关键回合」出来；
//   · **没有再次出现**同一局面时不许说「有改善」——没出现什么也证明不了。
//
// 浏览器安全：纯函数 + 纯数据，没有 `node:*`、没有 `require`、没有计时器、没有 DOM。
// 台账复用 `memory.js` 已有的字段（`lessons` / `journal` / `reflections`），
// 不新建第二套存储。

import {markTaught, recordCoachEvent, teachingPlan} from './memory.js';

const PLAYER = 'player';
const ENEMY = 'enemy';

// ── 学习点标签：老师能教的「课」就这几门 ─────────────────────────────────────
//
// 标签是机器可读的（下一局按它查同一个局面），也是 `memory.lessons` 里的课程名，
// 所以它必须与 `memory.js` 的那套账本对得上：`markTaught` / `teachingPlan` /
// `transferAssessment` 都按这个字符串记账。
//
// 数组顺序＝**优先级**：一局里同时够得上两门课时先讲哪一门。这是产品口径
// （哪一条更值得玩家现在改），不是游戏规则。顺序理由：先讲「我们自己倒下」
// （信息量最大、也最贵），再讲状态扣血、对面补位、最后才是打在抵抗上这种单点问题。
export const TEACHER_GOALS = Object.freeze([
  'use-item-before-danger-line',
  'switch-out-of-the-bad-matchup',
  'treat-status-before-it-stacks',
  'read-the-replacement-first',
  'stop-attacking-into-resistance',
]);

// ── 产品阈值（不是游戏规则）─────────────────────────────────────────────────
//
// 下面这些数字定义的是「本产品觉得什么值得讲、什么算同一类局面」，全部来自这一侧的
// 产品口径。它们**不是**引擎规则，改这里不会改变任何一次结算。
/** 属性倍率的中性值。引擎在 `env.py` 的 `_damage` 里写 `type_multiplier`，1＝无克制无抵抗。 */
const TYPE_MULTIPLIER_NEUTRAL = 1;
/** 相邻回合（t 与 t+1）都打在被抵抗上，才算「连着打抵抗」。改成 2 就是「隔一回合也算」。 */
const RESIST_WINDOW_TURNS = 1;
/** 回合末被同一条异常状态扣血 ≥2 次才算「拖着没处理」；只扣 1 次可能是这一局刚好只走到这里。 */
const STATUS_TICKS_DRAWN_OUT = 2;
/** 至少要有 2 个带伤害数字的回合，才敢说累计伤害差翻过盘；1 个回合没有「翻」可言。 */
const MIN_TURNS_FOR_LEAD_FLIP = 2;
/** 背包里算「回复药」的道具名。客户端发的是中文名（`env.py` 的 `ITEM_EFFECTS` 键），
 *  但引擎事件里的 `detail.item` 才是权威；这里只在**读背包**时用一次，见 bagHasHealItem。 */
const HEAL_ITEM_IDS = Object.freeze(['回复药', 'potion', '治疗药']);

/** 转折点的候选规则名。返回结果里带 `rule`，这样「为什么挑了这一回合」是可核对的。 */
export const TEACHER_TURNING_POINT_RULES = Object.freeze(['first-faint', 'damage-lead-flip']);

/** 每门课对应的一句「下次怎么做」。必须能照做，不能是「要更小心」这类空话。 */
const GOAL_LESSON = Object.freeze({
  'use-item-before-danger-line': '血线掉下一半时先把回复药吃掉，再决定继续输出还是换人。',
  'switch-out-of-the-bad-matchup': '吃到一次属性克制的伤害之后，下一回合先换掉这一只，别让它继续站在场上。',
  'treat-status-before-it-stacks': '身上开始扣异常状态伤害之后，下一回合就把它处理掉（换人或净化），别让它连着扣。',
  'read-the-replacement-first': '对面补上新的一只之后，先确认它是谁、什么系，再决定这一手打谁。',
  'stop-attacking-into-resistance': '打在抵抗上的那一手不要连着出，换一只或者换一个系别的技能。',
});

/** 处理方式的「好坏」排序。只有**同一门课、同一类局面**里才允许比较这两个标签。 */
const HANDLING_RANK = Object.freeze({
  'healed-before-faint': 2,
  'no-heal-before-faint': 1,
  'switched-out-after-bad-hit': 2,
  'stayed-in-after-bad-hit': 1,
  'handled-status-quickly': 2,
  'let-status-repeat': 1,
  'next-hit-not-resisted': 2,
  'next-hit-into-resist': 1,
  'stopped-after-resist': 2,
  'repeated-resist': 1,
});

/** 处理方式的中文说法。只进「依据」那一栏（给玩家看的是 `GOAL_LESSON` 那句）。 */
const HANDLING_LABEL = Object.freeze({
  'healed-before-faint': '倒下之前先用过回复药',
  'no-heal-before-faint': '倒下之前还有回复药但没有用',
  'switched-out-after-bad-hit': '吃到克制伤害之后换过人',
  'stayed-in-after-bad-hit': '吃到克制伤害之后一直留在场上',
  'handled-status-quickly': '异常状态只扣了一次血',
  'let-status-repeat': '异常状态连着扣了不止一次血',
  'next-hit-not-resisted': '补位之后第一手没有被抵抗',
  'next-hit-into-resist': '补位之后第一手打在抵抗上',
  'stopped-after-resist': '吃到抵抗之后换了一手',
  'repeated-resist': '连续回合都打在抵抗上',
});

/** 局面标签的中文说法。用于「这一局没有再出现……」这类必须说清楚的句子。 */
const SITUATION_LABEL = Object.freeze({
  'our-pet-fainted': '我方有伙伴倒下',
  'our-status-ticked': '我方身上的异常状态在回合末扣血',
  'enemy-pet-fainted': '对面有伙伴倒下',
  'our-hit-resisted': '我方打在属性抵抗上',
});

// ── 小工具：读事件 ──────────────────────────────────────────────────────────

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function numberOf(value) {
  return Number.isFinite(value) ? value : null;
}

/** `side` 字段在引擎里时而是 `"player"`，时而是 `Side.name`；口径与 `events_text._SIDE` 一致。 */
function sideOf(value) {
  const text = String(value ?? '');
  if (text === 'player' || text === 'Player') return PLAYER;
  if (text === 'enemy' || text === 'Enemy') return ENEMY;
  return null;
}

/**
 * 一条事件的字段：先取 `detail`，再把顶层字段并进来。
 *
 * 两种形状都要认，理由与 `events_text.event_text` 里那段一样：`_bump` 产出的是
 * `Event(kind, turn, detail, evidence)`，而特性层（`traits.py`）直接往列表里塞**扁平字典**
 * （`{kind:"trait", trait:"专注力", side:"player", effect:"atk +100%"}`）。
 * 只认 `detail` 的话，特性那一类事件在这层就看不见了。
 */
function detailOf(event) {
  const source = asObject(event);
  const detail = {...asObject(source.detail)};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'kind' || key === 'turn' || key === 'detail' || key === 'evidence' || key === 'text') continue;
    if (!(key in detail)) detail[key] = value;
  }
  return detail;
}

function turnOf(event) {
  const turn = asObject(event).turn;
  return Number.isInteger(turn) ? turn : null;
}

/**
 * 事件流 → 这一局真的发生过的事实。
 *
 * 字段名全部来自引擎实际写下的东西，一个都没有编：
 *   · `faint`      → `{side, slot}`（`env.py` 的 `_damage` 与 `_end_of_turn`）
 *   · `damage`     → `{side, skill_id, target_slot, damage, type_multiplier, ...}`
 *   · `status_tick`→ `{side, status, damage, layers_after}`
 *   · `item`       → `{side, item, healed|energy_gained|cleared}`
 *   · `switch`     → `{side, to_slot}`；`replacement` → `{side, slot}`
 *
 * `index` 是事件在数组里的次序：同一回合内也要能分出先后（例如「先吃药后倒下」）。
 */
export function teacherMatchFacts({events = []} = {}) {
  const facts = {faints: [], blows: [], ticks: [], items: [], switches: [], replacements: []};
  const list = Array.isArray(events) ? events : [];
  list.forEach((event, index) => {
    const kind = String(asObject(event).kind ?? '');
    if (!kind) return;
    const detail = detailOf(event);
    const turn = turnOf(event);
    const slot = Number.isInteger(detail.slot) ? detail.slot : null;
    if (kind === 'faint') {
      facts.faints.push({index, turn, side: sideOf(detail.side), slot});
      return;
    }
    if (kind === 'damage') {
      const attacker = sideOf(detail.side);
      const blow = {
        index, turn, side: attacker,
        skillId: typeof detail.skill_id === 'string' ? detail.skill_id : null,
        targetSlot: Number.isInteger(detail.target_slot) ? detail.target_slot : null,
        damage: numberOf(detail.damage),
        multiplier: numberOf(detail.type_multiplier),
      };
      facts.blows.push(blow);
      // 引擎把倒下单独发一条 `faint`；这里**也**认 `damage` 上的 `fainted` 标记，
      // 因为 `roco-experience.js` 的 `rocoLessonEntry` 已经把这个形状当成「这一下打倒了」。
      // 倒下的永远是**挨打那一方**，所以 side 取攻击方的反面。
      if (detail.fainted === true && attacker !== null && !facts.faints.some((f) => f.index === index)) {
        facts.faints.push({index, turn, side: attacker === PLAYER ? ENEMY : PLAYER, slot: blow.targetSlot});
      }
      return;
    }
    if (kind === 'status_tick') {
      facts.ticks.push({index, turn, side: sideOf(detail.side), status: detail.status ?? null, damage: numberOf(detail.damage)});
      return;
    }
    if (kind === 'item') {
      facts.items.push({
        index, turn, side: sideOf(detail.side),
        item: typeof detail.item === 'string' ? detail.item : null,
        // `healed` 是「这是一次治疗」最可靠的信号：事件里的 `detail.item` 是引擎的
        // 中文道具名（`ITEM_EFFECTS` 的键），而 `events_text._ITEM` 认的是英文键
        // （`potion`/`energy_fruit`/`cleanse`），两边对不上，所以不拿道具名当判据。
        healed: numberOf(detail.healed),
        cleared: Array.isArray(detail.cleared) ? detail.cleared.length : 0,
      });
      return;
    }
    if (kind === 'switch') {
      facts.switches.push({index, turn, side: sideOf(detail.side), toSlot: Number.isInteger(detail.to_slot) ? detail.to_slot : null});
      return;
    }
    if (kind === 'replacement') {
      facts.replacements.push({index, turn, side: sideOf(detail.side), slot});
    }
  });
  // 事件数组本身就是时序，这里只按出现次序稳定排一次，避免调用方重排数组后结论变样。
  for (const key of Object.keys(facts)) facts[key].sort((a, b) => a.index - b.index);
  return facts;
}

// ── 小工具：读局面（拿名字与血量）────────────────────────────────────────────
//
// 事件里**没有**精灵名：`faint` 只有 `{side, slot}`，技能只有 `skill_id`。
// 名字来自两份公开数据：
//   · 精灵名：局面的公开视图（`rocoGameView` 的投影，或它保留的 `game.roco` 原始视图）；
//   · 技能名：合法动作的 `label`（规则集里的显示名），或调用方显式给的 `skills` 表。
// 拿不到名字时**不猜**，只说「那一只 / 第 N 位」。

function rawSidePets(game, side) {
  const raw = asObject(game).roco;
  if (!raw) return null;
  if (side === PLAYER) return Array.isArray(raw?.self?.pets) ? raw.self.pets : null;
  const field = raw?.opponent?.field;
  const bench = Array.isArray(raw?.opponent?.bench) ? raw.opponent.bench : [];
  return [field, ...bench].filter(Boolean);
}

function petShape(name, hp, maxHp) {
  return {name: typeof name === 'string' && name ? name : null, hp: numberOf(hp), maxHp: numberOf(maxHp)};
}

/** 取「某一方第 slot 位」的公开信息：只按视图里的 `slot` 字段找，找不到就不给名字。 */
function petInfoAt(game, side, slot) {
  const object = asObject(game);
  if (!Number.isInteger(slot)) return null;
  const raw = rawSidePets(object, side) ?? (side === PLAYER
    ? (Array.isArray(object?.self?.pets) ? object.self.pets : null)
    : (() => {
      const field = object?.opponent?.field;
      const bench = Array.isArray(object?.opponent?.bench) ? object.opponent.bench : [];
      const list = [field, ...bench].filter(Boolean);
      return list.length ? list : null;
    })());
  if (Array.isArray(raw)) {
    const hit = raw.find((pet) => pet && pet.slot === slot);
    if (hit) return petShape(hit.name ?? hit.pet_id, hit.hp, hit.max_hp);
  }
  if (side === PLAYER) {
    // 己方全体在视图里是齐的（含已倒下的那一只），下标就是位次——`rocoGameView` 的约定。
    const pet = Array.isArray(object?.player?.pets) ? object.player.pets[slot] : null;
    if (pet) return petShape(pet.name, pet.hp, pet.maxHp);
  }
  // 对手**不能**退到「场上那一只」：对面倒下之后会补位，终局视图的 `opponent.field`
  // 已经是**换上来的那一只**，而 `ui_public_view` 的后备只给 `slot` 与 `fainted`、不给名字。
  // 拿现在场上那一只顶替倒下那一只，就是把这一局的战绩安到另一只头上。宁可不给名字。
  return null;
}

/** 「我方 寂灭骨龙」/「对方第 2 位」——名字拿不到时退回位次，不编名字。 */
function describePet(game, side, slot) {
  const who = side === PLAYER ? '我方' : '对方';
  const info = petInfoAt(game, side, slot) ?? petShape(null, null, null);
  const label = info.name ? `${who} ${info.name}` : (Number.isInteger(slot) ? `${who}第 ${slot + 1} 位` : `${who}那一只`);
  return {...info, side, slot, label, who};
}

/** 技能显示名：优先事件自带的名字，其次合法动作的 label，最后调用方给的表。 */
function skillNameOf(skillId, names) {
  if (typeof skillId !== 'string' || !skillId) return null;
  const fromTable = names?.skills?.[skillId];
  return typeof fromTable === 'string' && fromTable ? fromTable : null;
}

/** 证据里补一句技能名——只在**真的拿得到显示名**时才加，拿不到就不提技能。 */
function blowSkillSuffix(blow, names) {
  const label = skillNameOf(blow?.skillId, names);
  return label ? `，用的是「${label}」` : '';
}

function nameBook(game, skills) {
  const table = {};
  const object = asObject(game);
  // 三个真实来源：页面这一侧的合法动作（`roco.legal`）、
  // `ui_public_view` 给出的**己方配招全表**（`self.skills`，`ui_action_public` 加的 `skill.name`）、
  // 以及调用方显式给的技能表。对手的技能名公开数据里没有，所以拿不到就是拿不到。
  const sources = [object?.roco?.legal, object?.legal, object?.roco?.self?.skills, object?.self?.skills, asObject(skills).legal];
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const action of source) {
      const id = action?.skill_id;
      if (typeof id !== 'string' || !id || table[id]) continue;
      // 合法动作里三种写法都见过：`skill_name`（`ui_legal_actions` 加的）、
      // `skill.name`（`ui_action_public` 加的）、以及 `label`（动作名＝技能名）。
      const label = [action.skill_name, action?.skill?.name, action?.label]
        .find((value) => typeof value === 'string' && value);
      if (label) table[id] = label;
    }
  }
  if (asObject(skills).skills && typeof skills.skills === 'object') {
    for (const [id, label] of Object.entries(skills.skills)) {
      if (typeof label === 'string' && label && !table[id]) table[id] = label;
    }
  }
  return {skills: table};
}

/**
 * 背包里还有没有回复药。
 *
 * ⚠️ **终局视图里读不到背包**：引擎的 `legal_actions` 在 `state.result` 非空时直接返回 `[]`
 * （`env.py` 开头那句 `if state.result: return []`），而 `rocoGameView` 的 `items` 是从
 * 合法动作里数出来的。所以调用方要么把**最后一次还有合法动作**的那份视图传进来，
 * 要么显式给 `bag`。两条都不给时这里返回 false，那一课就不会被讲——不知道背包里有什么，
 * 就不教人吃药。
 */
function bagHasHealItem(game, bag = null) {
  const explicit = asObject(bag);
  if (Object.keys(explicit).length) {
    return HEAL_ITEM_IDS.some((id) => Number(explicit[id]) > 0);
  }
  const items = asObject(asObject(game).player).items;
  if (!items || typeof items !== 'object') return false;
  return HEAL_ITEM_IDS.some((id) => Number(items[id]) > 0);
}

// ── 转折点：按固定规则挑一个回合 ─────────────────────────────────────────────

/**
 * 累计伤害差翻盘的那一回合。
 *
 * 为什么用**累计伤害差**而不是血量差：事件里没有逐回合的血量，只有每一击的
 * `damage` 与回合末 `status_tick` 的扣血。把「我方打出的伤害 − 我方承受的伤害」
 * 当成血量差的代理，并在依据里把两个数字写出来，玩家自己能核对。
 * 这是产品口径的代理量，不是引擎的结算量。
 */
function damageLeadFlip(facts) {
  const rows = new Map();
  const add = (turn, side, amount) => {
    if (turn === null || amount === null || side === null) return;
    const row = rows.get(turn) ?? {turn, dealt: 0, taken: 0};
    if (side === PLAYER) row.dealt += amount; else row.taken += amount;
    rows.set(turn, row);
  };
  for (const blow of facts.blows) add(blow.turn, blow.side, blow.damage);
  // 状态扣血也算进「承受」：它确实在扣血，漏掉它会把翻盘判晚一回合。
  for (const tick of facts.ticks) add(tick.turn, tick.side === PLAYER ? ENEMY : tick.side === ENEMY ? PLAYER : null, tick.damage);
  const turns = [...rows.values()].sort((a, b) => a.turn - b.turn);
  if (turns.length < MIN_TURNS_FOR_LEAD_FLIP) return null;
  let dealt = 0;
  let taken = 0;
  let previous = 0;
  for (const row of turns) {
    dealt += row.dealt;
    taken += row.taken;
    const lead = dealt - taken;
    const sign = lead > 0 ? 1 : lead < 0 ? -1 : 0;
    if (previous !== 0 && sign !== 0 && sign !== previous) {
      return {turn: row.turn, dealt, taken, from: previous > 0 ? 'ahead' : 'behind', to: sign > 0 ? 'ahead' : 'behind'};
    }
    if (sign !== 0) previous = sign;
  }
  return null;
}

/**
 * 挑一个转折点。两条规则，按固定次序问，先够得上的赢：
 *   ① `first-faint`      —— 全场第一次减员。它是一个**事件**，不是推断，所以优先。
 *   ② `damage-lead-flip` —— 累计伤害差首次换边。没有减员时看它。
 * 两条都不成立就返回 null：这一局没有转折点，调用方应当保持沉默。
 */
function chooseTurningPoint({facts, game}) {
  const candidates = [];
  const firstFaint = facts.faints.find((faint) => faint.side !== null) ?? null;
  if (firstFaint) candidates.push('first-faint');
  const flip = damageLeadFlip(facts);
  if (flip) candidates.push('damage-lead-flip');
  if (firstFaint) {
    const pet = describePet(game, firstFaint.side, firstFaint.slot);
    const turnText = Number.isInteger(firstFaint.turn) ? `第 ${firstFaint.turn} 回合` : '有一回合';
    return {
      turn: firstFaint.turn,
      rule: 'first-faint',
      candidates,
      what: `${turnText} ${pet.label} 倒下，这是全场第一次减员`,
      evidence: [`${turnText}：${pet.label} 倒下（第一次减员）。`],
    };
  }
  if (flip) {
    return {
      turn: flip.turn,
      rule: 'damage-lead-flip',
      candidates,
      what: `第 ${flip.turn} 回合累计伤害差翻到${flip.to === 'ahead' ? '我方' : '对面'}一侧`,
      evidence: [`第 ${flip.turn} 回合后，我方累计打出 ${flip.dealt} 点、承受 ${flip.taken} 点，从这一回合起${flip.to === 'ahead' ? '领先' : '落后'}。`],
    };
  }
  return null;
}

// ── 每门课的判据 ────────────────────────────────────────────────────────────

function firstOf(list, side) {
  return list.find((row) => row.side === side) ?? null;
}

/**
 * 一门课的判据，返回 `{situation, applies, handling, turn, evidence, ...}`；够不上就返回 null。
 *
 * 三个字段是分开的，这一点很关键：
 *   · `situation` 只描述「**这一类局面**有没有出现」（例如「我方有伙伴倒下」），
 *     不知道有没有前置条件。下一局验证靠它判「同一类局面又来没来」。
 *   · `applies` 说明这一局**该不该讲这一课**（例如背包里得真的有药）。
 *   · `handling` 只在 `applies` 为真时有意义，是「这一次怎么处理」的标签。
 * 混在一起的后果是：下一局局面重复、但这一课的前提不在（背包里没药）时，
 * 会把「没法比较」说成「没有改善」。
 */
function evaluateGoal(goal, {facts, game, names, bag = null}) {
  if (goal === 'use-item-before-danger-line' || goal === 'switch-out-of-the-bad-matchup') {
    const faint = firstOf(facts.faints, PLAYER);
    if (!faint) return null;
    const base = {situation: 'our-pet-fainted', turn: faint.turn, pet: {side: PLAYER, slot: faint.slot}};
    const pet = describePet(game, PLAYER, faint.slot);
    // 「是什么把它打下去的」：倒下的前一条**打在这一只身上**的对方伤害。
    // `faint` 事件自己没有技能字段（`env.py` 只记 `{side, slot}`），所以只能从伤害事件里取，
    // 取不到就不写这一句——不拿别的回合的那一击顶替。
    const fatal = [...facts.blows].reverse().find((blow) => blow.side === ENEMY
      && blow.index < faint.index
      && blow.turn === faint.turn
      && (blow.targetSlot === null || faint.slot === null || blow.targetSlot === faint.slot)) ?? null;
    const fatalLine = fatal
      ? `第 ${faint.turn} 回合 ${pet.label} 是在一次约 ${fatal.damage} 点伤害之后倒下的${blowSkillSuffix(fatal, names)}。`
      : null;
    if (goal === 'use-item-before-danger-line') {
      const heal = facts.items.find((item) => item.side === PLAYER && item.healed !== null && item.healed > 0) ?? null;
      const available = Boolean(heal) || bagHasHealItem(game, bag);
      if (!available) {
        return {...base, applies: false, handling: null, evidence: [fatalLine, `${pet.label} 第 ${faint.turn} 回合倒下；这一局没有可用回复药的记录，所以不谈用药时机。`].filter(Boolean)};
      }
      const healedFirst = Boolean(heal) && (heal.index < faint.index);
      const handling = healedFirst ? 'healed-before-faint' : 'no-heal-before-faint';
      const evidence = [fatalLine, healedFirst
        ? `${pet.label} 倒下之前，第 ${heal.turn} 回合先用过回复药（回 ${heal.healed} 点）。`
        : `${pet.label} 倒下之前没有用过回复药（这一局没有我方用药的记录；背包里还有回复药）。`].filter(Boolean);
      return {...base, applies: true, handling, evidence};
    }
    // switch-out-of-the-bad-matchup：先看有没有吃到过属性克制的伤害（只算打在**后来倒下那一只**
    // 身上的，`target_slot` 对得上才算），再看从那一击到倒下之间有没有换人
    // （`switch` 是引擎记的主动换人；`replacement` 是被动补位，不算「主动换人」）。
    const badHit = facts.blows.find((blow) => blow.side === ENEMY
      && blow.multiplier !== null && blow.multiplier > TYPE_MULTIPLIER_NEUTRAL
      && blow.index < faint.index
      && (blow.targetSlot === null || faint.slot === null || blow.targetSlot === faint.slot)) ?? null;
    if (!badHit) {
      return {...base, applies: false, handling: null, evidence: [fatalLine, `${pet.label} 第 ${faint.turn} 回合倒下，但倒下之前没有吃到属性克制的伤害记录。`].filter(Boolean)};
    }
    const switched = facts.switches.some((row) => row.side === PLAYER && row.index > badHit.index && row.index < faint.index);
    const handling = switched ? 'switched-out-after-bad-hit' : 'stayed-in-after-bad-hit';
    return {
      ...base, applies: true, handling,
      evidence: [fatalLine, switched
        ? `第 ${badHit.turn} 回合吃到属性克制的伤害（约 ${badHit.damage} 点${blowSkillSuffix(badHit, names)}）之后换过人，但 ${pet.label} 还是在第 ${faint.turn} 回合倒下。`
        : `第 ${badHit.turn} 回合 ${pet.label} 吃到属性克制的伤害（约 ${badHit.damage} 点${blowSkillSuffix(badHit, names)}），到第 ${faint.turn} 回合倒下之间没有换人。`].filter(Boolean),
    };
  }

  if (goal === 'treat-status-before-it-stacks') {
    const ticks = facts.ticks.filter((tick) => tick.side === PLAYER);
    const first = ticks[0] ?? null;
    if (!first) return null;
    // 状态扣血只记了「哪一方」，没记是哪一只（`status_tick` 的字段里只有 side/status/damage），
    // 所以这里**不点名**：点名就等于编一个事件里没有的事实。
    const base = {situation: 'our-status-ticked', turn: first.turn, pet: {side: PLAYER, slot: null}};
    const pet = describePet(game, PLAYER, null);
    const drawnOut = ticks.length >= STATUS_TICKS_DRAWN_OUT;
    const handling = drawnOut ? 'let-status-repeat' : 'handled-status-quickly';
    const statusName = first.status ? `「${first.status}」` : '异常状态';
    const cleansed = facts.items.some((item) => item.side === PLAYER && item.cleared > 0 && item.index > first.index);
    return {
      ...base, applies: true, handling,
      evidence: [`${pet.label} 身上的${statusName}在回合末扣血 ${ticks.length} 次（第一次是第 ${first.turn} 回合，约 ${first.damage} 点）${cleansed ? '，中途用过净化类道具' : ''}。`],
    };
  }

  if (goal === 'read-the-replacement-first') {
    const faint = firstOf(facts.faints, ENEMY);
    if (!faint) return null;
    const base = {situation: 'enemy-pet-fainted', turn: faint.turn, pet: {side: ENEMY, slot: faint.slot}};
    const pet = describePet(game, ENEMY, faint.slot);
    // 补位不消耗回合（术语 3009），所以「补位之后的第一手」= 这个倒下事件之后的第一条我方伤害。
    const next = facts.blows.find((blow) => blow.side === PLAYER && blow.index > faint.index && blow.multiplier !== null) ?? null;
    if (!next) {
      return {...base, applies: false, handling: null, evidence: [`${pet.label} 第 ${faint.turn} 回合倒下，之后没有带属性倍率的我方出手记录。`]};
    }
    const resisted = next.multiplier < TYPE_MULTIPLIER_NEUTRAL;
    const handling = resisted ? 'next-hit-into-resist' : 'next-hit-not-resisted';
    return {
      ...base, applies: true, handling,
      evidence: [`${pet.label} 第 ${faint.turn} 回合倒下，之后我方第 ${next.turn} 回合那一手倍率 ${next.multiplier}${blowSkillSuffix(next, names)}${resisted ? '（打在抵抗上）' : '（没有被抵抗）'}。`],
    };
  }

  if (goal === 'stop-attacking-into-resistance') {
    const resisted = facts.blows.filter((blow) => blow.side === PLAYER && blow.multiplier !== null && blow.multiplier < TYPE_MULTIPLIER_NEUTRAL);
    const first = resisted[0] ?? null;
    if (!first) return null;
    const base = {situation: 'our-hit-resisted', turn: first.turn, pet: {side: PLAYER, slot: null}};
    const turns = [...new Set(resisted.map((blow) => blow.turn).filter((turn) => turn !== null))].sort((a, b) => a - b);
    const pair = turns.find((turn) => turns.includes(turn + RESIST_WINDOW_TURNS)) ?? null;
    const handling = pair === null ? 'stopped-after-resist' : 'repeated-resist';
    return {
      ...base, applies: true, handling,
      evidence: [pair === null
        ? [`我方一共打出 ${resisted.length} 次被属性抵抗的伤害，没有连着两个回合都打在抵抗上（最早的抵抗在第 ${first.turn} 回合${blowSkillSuffix(first, names)}）。`]
        : [`我方在第 ${pair} 与第 ${pair + RESIST_WINDOW_TURNS} 回合连着打在属性抵抗上（这一局共 ${resisted.length} 次）。`]],
    };
  }

  return null;
}

// ── 主入口 ①：局末复盘 ─────────────────────────────────────────────────────

function outcomeText(result) {
  if (result === 'win') return '最后赢了下来';
  if (result === 'loss') return '最后输掉了';
  if (result === 'draw') return '双方打平';
  return '结果没有记下来';
}

function turnCountOf({turns, game, facts}) {
  if (Number.isInteger(turns) && turns > 0) return turns;
  const fromGame = asObject(game).turn;
  if (Number.isInteger(fromGame) && fromGame > 0) return fromGame;
  const all = [...facts.faints, ...facts.blows, ...facts.ticks, ...facts.items, ...facts.switches, ...facts.replacements];
  const max = all.reduce((best, row) => (Number.isInteger(row.turn) && row.turn > best ? row.turn : best), 0);
  return max > 0 ? max : null;
}

function resultOf({result, game}) {
  if (typeof result === 'string' && result) return result;
  const fromGame = asObject(game).result;
  return typeof fromGame === 'string' && fromGame ? fromGame : null;
}

/** 转折点写成一句给玩家看的话。 */
function turningPointSentence(point) {
  if (point.rule === 'first-faint') return `${point.what}。`;
  return `${point.what}（按累计伤害算，不是血量）。`;
}

/** 这一门课的证据写成一句给玩家看的话；没有就不加这句。 */
function lessonSentence(goal, chosen) {
  if (goal === 'use-item-before-danger-line') {
    return chosen.handling === 'healed-before-faint'
      ? '倒下之前你先用过回复药，这一步的先后顺序是对的。'
      : '它倒下之前，背包里的回复药一直没有用过。';
  }
  if (goal === 'switch-out-of-the-bad-matchup') {
    return chosen.handling === 'switched-out-after-bad-hit'
      ? '吃到克制伤害之后你换过人，但那一只还是没能留下来。'
      : '更早的时候它已经吃到一次属性克制的伤害，之后到倒下都没有换人。';
  }
  if (goal === 'treat-status-before-it-stacks') {
    return '身上的异常状态是回合末一点点扣的，处理得越早，后面越少被迫应对。';
  }
  if (goal === 'read-the-replacement-first') {
    return chosen.handling === 'next-hit-into-resist'
      ? '对面补上新的一只之后，我方的下一手打上去还是被抵抗。'
      : '对面补上新的一只之后，我方下一手没有被抵抗。';
  }
  if (goal === 'stop-attacking-into-resistance') {
    return chosen.handling === 'repeated-resist'
      ? '有两回合连着打在对方的属性抵抗上。'
      : '吃到抵抗之后你换了手，没有连着打。';
  }
  return null;
}

/** 可核对的依据：血量只在公开视图真的给了 maxHp 时才写。 */
function hpEvidence(game, side, slot) {
  const pet = petInfoAt(game, side, slot);
  if (!pet || pet.hp === null || pet.maxHp === null) return null;
  const who = side === PLAYER ? '我方' : '对方';
  const name = pet.name ? `${who} ${pet.name}` : `${who}第 ${slot + 1} 位`;
  return `${name} 结束时 ${pet.hp} / ${pet.maxHp} 生命。`;
}

/**
 * 一局打完，老师说什么。
 *
 * @returns {null | {
 *   text: string,                      // 2–4 句自然中文复盘，全部来自这一局的事件
 *   turning_point: object,             // {turn, rule, candidates, what, evidence}
 *   learning: string,                  // 一条能照做的学习点
 *   goal: string,                      // TEACHER_GOALS 里的标签
 *   evidence: string[],                // 用到的具体事实（回合、名字、伤害、血量）
 *   check: {situation, handling, turn},// 机器可读，交给 recordTeacherReview 存账
 *   repeat: boolean,                   // 这一课之前是不是已经讲过
 * }}
 * 返回 null ＝ 这一局没有可说的：没有转折点，或者挑不出该讲哪一课。宁可沉默。
 */
export function reviewMatch({events = [], turns = null, result = null, game = null, memory = null, skills = null, bag = null} = {}) {
  const facts = teacherMatchFacts({events});
  const names = nameBook(game, skills);
  const point = chooseTurningPoint({facts, game});
  if (!point) return null;
  let chosen = null;
  let goal = null;
  for (const candidate of TEACHER_GOALS) {
    const evaluation = evaluateGoal(candidate, {facts, game, names, bag});
    if (!evaluation) continue;
    // 优先级里第一门「够得上」的课就是这一局要讲的；`applies === false` 的候选跳过
    // （前提不在的课不能讲，例如背包里根本没药却教人吃药）。
    if (evaluation.applies !== true) continue;
    chosen = evaluation;
    goal = candidate;
    break;
  }
  if (!chosen || !goal) return null;

  // 复用 memory.js 的教学账本判断「这一课讲过没有」——不新建第二套「教过」记录。
  const alreadyTaught = teachingPlan(memory, {lesson: goal}).teach === false;

  const sentences = [];
  const totalTurns = turnCountOf({turns, game, facts});
  sentences.push(`这一局一共 ${totalTurns === null ? '若干' : totalTurns} 个回合，${outcomeText(resultOf({result, game}))}。`);
  sentences.push(turningPointSentence(point));
  const lesson = lessonSentence(goal, chosen);
  if (lesson) sentences.push(lesson);
  if (alreadyTaught) sentences.push('这一课之前讲过，这次又是同一类局面。');

  const evidence = [];
  for (const line of point.evidence) if (line) evidence.push(line);
  for (const line of chosen.evidence ?? []) if (line) evidence.push(line);
  // 血量只在公开视图真的给了 maxHp 时才写；`chosen.pet.slot` 不明（状态扣血查不到是哪一只）
  // 时 `hpEvidence` 自己返回 null，不拿别的精灵顶替。
  const hp = hpEvidence(game, chosen.pet?.side ?? PLAYER, chosen.pet?.slot ?? null);
  if (hp) evidence.push(hp);

  return {
    text: sentences.join(''),
    turning_point: {turn: point.turn, rule: point.rule, candidates: point.candidates, what: point.what, evidence: point.evidence},
    learning: GOAL_LESSON[goal] ?? null,
    goal,
    evidence,
    check: {situation: chosen.situation, handling: chosen.handling, turn: chosen.turn},
    repeat: alreadyTaught,
  };
}

// ── 主入口 ②：在后面的局里核对学到了没有 ─────────────────────────────────────

/** 最近一次讲过的课（`journal` 里 kind==='teach' 的最后一条）。 */
function latestTeaching(memory) {
  const rows = Array.isArray(asObject(memory).journal) ? memory.journal : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row?.kind === 'teach' && typeof row.goal === 'string' && row.goal) return row;
  }
  return null;
}

function situationText(tag) {
  return SITUATION_LABEL[tag] ?? (typeof tag === 'string' && tag ? tag : '同一类局面');
}

function handlingText(tag) {
  return HANDLING_LABEL[tag] ?? null;
}

function handlingRank(tag) {
  return Number.isInteger(HANDLING_RANK[tag]) ? HANDLING_RANK[tag] : null;
}

/**
 * 上一局那个学习点，在这一局里有没有再出现、处理方式有没有变。
 *
 * 判据的次序（每一步都可以被核对，不允许跳步）：
 *   ① 账本里没有讲过的课 → `checked:false`，什么都不说；
 *   ② 同一类局面这一局没再出现 → `recurred:false`、`improved:null`，
 *      并在 note 里明说「没出现证明不了任何事」——这是这个函数存在的理由；
 *   ③ 局面重复了、但这一课的前提不在（例如这次背包里没有药）→ `improved:null`，
 *      说明为什么没法比较，不硬判；
 *   ④ 局面重复且可比 → 处理方式标签的档位更高才是 `improved:true`，
 *      并且把**两次的回合**一起写进依据；同档或更低是 `improved:false`。
 *
 * 永远不返回 `improved:true` 而拿不出「两次回合 + 两次处理方式」。
 */
export function checkLearningProgress({memory = null, match = null} = {}) {
  const record = latestTeaching(memory);
  if (!record) {
    return {
      checked: false, goal: null, recurred: false, improved: null,
      note: '还没有记录过学习点，这一局没有可以核对的课。先打完一局拿到复盘，下一局才谈得上验证。',
      evidence: [],
    };
  }
  const goal = record.goal;
  const facts = teacherMatchFacts({events: Array.isArray(asObject(match).events) ? match.events : []});
  const game = asObject(match).game ?? null;
  const evaluation = evaluateGoal(goal, {facts, game, names: nameBook(game, asObject(match).skills ?? null), bag: asObject(match).bag ?? null});
  const plan = teachingPlan(memory, {lesson: goal});
  const situation = typeof record.situation === 'string' && record.situation ? record.situation : null;
  const lessonName = goal;

  if (!evaluation || !situation || evaluation.situation !== situation) {
    return {
      checked: true, goal, recurred: false, improved: null,
      situation,
      note: `上一课是「${lessonName}」，对应的局面是「${situationText(situation)}」。这一局没有再出现这个局面，所以这一局证明不了你有没有改善——没出现既不是做到了，也不是没做到。`,
      evidence: [`这一局的事件里没有「${situationText(situation)}」的记录。`],
      plan: {teach: plan.teach, reason: plan.reason},
    };
  }

  const beforeTurn = Number.isInteger(record.turn) ? record.turn : null;
  const afterTurn = Number.isInteger(evaluation.turn) ? evaluation.turn : null;
  const beforeHandling = typeof record.handling === 'string' ? record.handling : null;

  if (evaluation.applies !== true || evaluation.handling === null || beforeHandling === null) {
    return {
      checked: true, goal, recurred: true, improved: null,
      situation,
      note: `「${situationText(situation)}」这一局又出现了，但这一课的前提不在（这一次没法判断该怎么处理才算更好），所以不比较处理方式，也不给改善结论。`,
      evidence: [...(evaluation.evidence ?? [])],
      plan: {teach: plan.teach, reason: plan.reason},
    };
  }

  const beforeRank = handlingRank(beforeHandling);
  const afterRank = handlingRank(evaluation.handling);
  if (beforeRank === null || afterRank === null) {
    return {
      checked: true, goal, recurred: true, improved: null,
      situation,
      note: '这一局局面重复了，但两次的处理方式里有一次没有可核对的档位，所以不下改善结论。',
      evidence: [...(evaluation.evidence ?? [])],
      plan: {teach: plan.teach, reason: plan.reason},
    };
  }

  const improved = afterRank > beforeRank;
  const beforeText = handlingText(beforeHandling) ?? beforeHandling;
  const afterText = handlingText(evaluation.handling) ?? evaluation.handling;
  const comparison = `对比第 ${beforeTurn === null ? '—' : beforeTurn} 回合（上一次：${beforeText}）与第 ${afterTurn === null ? '—' : afterTurn} 回合（这一次：${afterText}）。`;
  const note = improved
    ? `「${situationText(situation)}」这一局又出现了。${comparison}两次的处理方式不同，这一次是往好的方向变。一次变化只说明这一次这样做了，不代表以后都会。`
    : `「${situationText(situation)}」这一局又出现了。${comparison}两次的处理方式一样，所以这一局看不到变化。`;
  return {
    checked: true, goal, recurred: true, improved,
    situation,
    note,
    evidence: [comparison, ...(evaluation.evidence ?? [])],
    turns: [beforeTurn, afterTurn],
    plan: {teach: plan.teach, reason: plan.reason},
  };
}

// ── 记账：把复盘与核对写进 memory.js 已有的字段 ─────────────────────────────

/**
 * 把一次复盘存进账本。
 *
 * 只用 memory.js 已有的两处：
 *   · `markTaught` → `memory.lessons`（课程名），`teachingPlan` / `memoryItems` 直接读得到；
 *   · `recordCoachEvent` → `memory.journal` 的 `kind:'teach'` 行，带上机器可读的
 *     `goal` / `situation` / `handling` / `turn`，这就是下一局 `checkLearningProgress` 的输入。
 * 没有整数回合就**不记**：挂不上回合的账，下一局就没法拿两次回合做对比。
 */
export function recordTeacherReview(memory, {matchId = null, review = null, now = Date.now()} = {}) {
  if (!review || typeof review.goal !== 'string' || !review.goal) return memory;
  if (typeof matchId !== 'string' || !matchId) return memory;
  const turn = review?.turning_point?.turn;
  if (!Number.isInteger(turn)) return memory;
  const m = markTaught(memory, {lesson: review.goal});
  return recordCoachEvent(m, {
    id: `${matchId}:teach:${review.goal}`,
    kind: 'teach',
    matchId,
    turn,
    lesson: review.goal,
    goal: review.goal,
    situation: review?.check?.situation ?? null,
    handling: review?.check?.handling ?? null,
    text: review.learning ?? null,
    evidenceIds: [`${matchId}:turn:${turn}`],
    source: 'local-game',
    confidence: 1,
    time: new Date(now).toISOString(),
  });
}

/**
 * 把一次核对记成一条 decision 行——与军师记账**同一套字段**。
 *
 * 这样 `transferAssessment` / `teachingPlan` / `memorySummary` 不用改一行就读得到老师的核对，
 * 不会出现第二套「学会没有」的账。
 *
 * `improved === null`（局面没重复、或没法比较）时**不记**：那不是一次不合理行动，
 * 记成 `reasonable:false` 会把「什么都没发生」算成一次失误。
 */
export function recordLearningCheck(memory, {matchId = null, check = null, goal = null, now = Date.now()} = {}) {
  const lesson = typeof goal === 'string' && goal ? goal : check?.goal;
  if (typeof lesson !== 'string' || !lesson) return memory;
  if (typeof matchId !== 'string' || !matchId) return memory;
  if (check?.improved !== true && check?.improved !== false) return memory;
  const turn = Number.isInteger(check?.turns?.[1]) ? check.turns[1] : null;
  if (turn === null) return memory;
  return recordCoachEvent(memory, {
    id: `${matchId}:learning-check:${lesson}`,
    kind: 'decision',
    matchId,
    turn,
    lesson,
    reasonable: check.improved === true,
    prompted: false,
    caseKey: typeof check.situation === 'string' && check.situation ? check.situation : lesson,
    improved: check.improved,
    source: 'local-game',
    confidence: .6,
    time: new Date(now).toISOString(),
  });
}

/** 给页面/测试用：一门课的中文说法。没有登记就返回 null（不编）。 */
export function teacherGoalLesson(goal) {
  return GOAL_LESSON[goal] ?? null;
}

/** 给页面/测试用：局面标签与处理方式标签的中文说法。 */
export function teacherLabel(tag) {
  return HANDLING_LABEL[tag] ?? SITUATION_LABEL[tag] ?? null;
}
