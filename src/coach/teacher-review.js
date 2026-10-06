import {decisionEvidenceAt} from './decision-evidence.js';
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

// ── 结果：**四类分开**（胜 / 负 / 逃跑 / 异常结束），不许把撤退写成「输了」────────
//
// 引擎真的会写下的 `battle_result` 取值逐个核过源码，不是猜的：
//   · `env.py:1638/1640/1642`（`_finish`）与 `:2544/2546/2548`（魔力归零）→ `win`/`loss`/`draw`；
//   · `env.py:986`（`ACTION_ESCAPE` 那一支）→ **`escaped`**：这是第四个取值，
//     `src/client/roco.js:355` 的 `RESULT_CN` 也登记了它（`escaped: '撤退'`）；
//   · `env.py:1702`（`_surrender`）→ 投降方判负，结果字符串仍是 `win`/`loss`，
//     **没有**第五个字符串；「投降」这件事只能从事件流里的 `surrender` 行看出来
//     （`env.py:1711` 的 `_bump(state, "surrender", {"side": side, "result": state.result})`）。
//
// 原来这里只认 win/loss/draw，其余一律落成「结果没有记下来」。后果有两层：
//   · 撤退结束的一局被讲成「结果没有记下来」——引擎明明给了 `escaped`；
//   · 未知取值与「引擎没给」落进同一句，玩家分不出这两件事。
// 现在四类分开；未知取值说「引擎没给全」而不是「没有记下来」——后者是把
// 「我不认识这个值」说成「引擎没给」，这是两回事。
export const BATTLE_RESULTS = Object.freeze(['win', 'loss', 'draw', 'escaped']);

/** 四类结果各自的说法。`draw` 那一条与旧口径逐字相同（既有判据见过它）。 */
const OUTCOME_TEXT = Object.freeze({
  win: '最后赢了下来',
  loss: '最后输掉了',
  draw: '双方打平',
  escaped: '最后是我方主动撤退结束的，不是被打输的',
});

/** 引擎给的取值不在 `BATTLE_RESULTS` 里（或压根没给）时的口径。 */
const OUTCOME_UNKNOWN = '这一局的结论引擎没给全';

/**
 * 单次伤害的免责句。
 *
 * U10（2026-09-29 产品口径）：**不许拿一次伤害事件写整局结论**——「就是这一下输的」
 * 「因为这一击所以败」这类话把一次结算读成了因果必然。事件流里真的有的只是
 * 「第 N 回合挨了约 D 点」，那就只说到这一步，并把「不能据此断定整局走向」一起写出来。
 * 这句话由判据逐字钉住（`tests/roco-review-u10.test.js`）。
 */
const SINGLE_BLOW_NOTE = '这是单次伤害记录，不能据此断定整局走向。';

// ── 合法替代：拿「那一回合的合法动作表」说话 ─────────────────────────────────
//
// U10 要的复盘是「具体回合 + 当时事实 + **合法替代** + 理由」。前两项这一层一直有
// （`chosen.evidence`），缺的是「那一回合当时还能选什么」。而这一项**必须有出处**：
//
//   · `legalByTurn`（加性入参，形如 `{3: [{kind:'skill', label:'龙血'}, …]}`）：
//     调用方逐回合攒下来的合法表，按回合查得到就能说（也认 `Map` 与
//     `[{turn, legal}]` 这两种同义结构）；
//   · 局面视图自带的 `game.roco.legal`：`rocoMatchReview` 传的是 `lastLiveView`
//     （**最后一个还能行动的局面**）的投影，它只属于那个局面所在的回合（`game.roco.turn`）。
//     拿它去讲别的回合，就是把「现在的菜单」安到「过去那一回合」头上——这是这一层
//     最容易犯、且犯了不会报错的错，所以只在 `game.roco.turn === 要讲的那一回合` 时才认它。
//
// 拿不到时的口径：**不编**，写清「哪一项未知」，再给现在就能做的一步（学习点那一句）。
// 默认（不传 `legalByTurn`）这一层**整层关闭**：输出与之前逐字节相同。
//
// ⚠ 为什么整层默认关闭、而不是「只要有 game.roco.legal 就自动讲」：
// 生产链路上 `rocoMatchReview` 现在并没有逐回合的合法表，靠 `lastLiveView` 顶多覆盖
// 最后一个可行动回合；自动开口会把「这一回合刚好是最后一个可行动局面」这个巧合
// 变成一句像模像样的「当时你还能选 X」。要不要开口由调用方显式声明（传这个参数）。
/** 合法动作的中文说法兜底（与 `schema.Action.label` 同一套词，只补它没覆盖的那几个）。 */
const ACTION_KIND_LABEL = Object.freeze({
  escape: '撤退', struggle: '挣扎', charge: '聚能', surrender: '投降', magic: 'PVP 魔法',
});

/**
 * 每门课「能对上这一课的替代动作」是哪几类。
 *
 * `null` ＝ 这一课要改的不是「那一回合选哪一项」（例如「先确认补位上来的那一只是谁」），
 * 那就**不点**替代动作——硬凑一句「你当时可以换个技能」会把两门课混成一句。
 */
const GOAL_ALTERNATIVE = Object.freeze({
  'use-item-before-danger-line': {kinds: ['item'], remedy: '先把回复药吃掉再决定'},
  'switch-out-of-the-bad-matchup': {kinds: ['switch'], remedy: '把这一只换下去'},
  'treat-status-before-it-stacks': {kinds: ['item', 'switch'], remedy: '下一回合就把异常状态处理掉'},
  'stop-attacking-into-resistance': {kinds: ['skill', 'switch'], remedy: '换一手或换一只再打'},
  'read-the-replacement-first': null,
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
 *   · `escape`     → `{side}`（`env.py:988`，撤退结束那一局的**唯一**事件证据）
 *   · `surrender`  → `{side, result}`（`env.py:1711`；投降方判负，结果字符串仍是 win/loss，
 *     所以「这一局是投降结束的」只能靠这一行认出来）
 *
 * `index` 是事件在数组里的次序：同一回合内也要能分出先后（例如「先吃药后倒下」）。
 */
export function teacherMatchFacts({events = []} = {}) {
  const facts = {
    faints: [], blows: [], ticks: [], items: [], switches: [], replacements: [],
    escapes: [], surrenders: [],
  };
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
      return;
    }
    if (kind === 'escape') {
      // `env.py` 的 `ACTION_ESCAPE` 分支：`_bump(state, "escape", {"side": side})`。
      facts.escapes.push({index, turn, side: sideOf(detail.side)});
      return;
    }
    if (kind === 'surrender') {
      // `_surrender` 的 detail 是 `{side, result}`——`result` 是**引擎写的**结果字符串，
      // 这里原样留着（不翻译成输赢：投降的结算语义在引擎台账里仍是未核验）。
      facts.surrenders.push({
        index, turn, side: sideOf(detail.side),
        result: typeof detail.result === 'string' && detail.result ? detail.result : null,
      });
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
 *
 * `numbers`（2026-09-29 加性）是**这一门课用到的机器可读数字**：回合号、点数、倍率、次数。
 * 加它的理由只有一个：「合法替代」那一层要给出**理由**，而理由不许是一句新编的话，
 * 只能用这里已经算出来的那几个数（`tests/roco-review-u10.test.js` 会拿同一份 events 重算一遍）。
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
    // U10：这一句是**唯一**把「一次伤害」与「倒下」摆在一起的地方，所以免责句就跟在它后面。
    // 只加在这一句上、不逐句都挂一遍——那样免责句自己就变成复读了。
    const fatalLine = fatal
      ? `第 ${faint.turn} 回合 ${pet.label} 是在一次约 ${fatal.damage} 点伤害之后倒下的${blowSkillSuffix(fatal, names)}。${SINGLE_BLOW_NOTE}`
      : null;
    if (goal === 'use-item-before-danger-line') {
      const heal = facts.items.find((item) => item.side === PLAYER && item.healed !== null && item.healed > 0) ?? null;
      const available = Boolean(heal) || bagHasHealItem(game, bag);
      const numbers = {
        faint_turn: faint.turn,
        fatal_damage: fatal ? fatal.damage : null,
        healed_turn: heal ? heal.turn : null,
        healed_amount: heal ? heal.healed : null,
      };
      if (!available) {
        return {...base, applies: false, handling: null, numbers, evidence: [fatalLine, `${pet.label} 第 ${faint.turn} 回合倒下；这一局没有可用回复药的记录，所以不谈用药时机。`].filter(Boolean)};
      }
      const healedFirst = Boolean(heal) && (heal.index < faint.index);
      const handling = healedFirst ? 'healed-before-faint' : 'no-heal-before-faint';
      const evidence = [fatalLine, healedFirst
        ? `${pet.label} 倒下之前，第 ${heal.turn} 回合先用过回复药（回 ${heal.healed} 点）。`
        : `${pet.label} 倒下之前没有用过回复药（这一局没有我方用药的记录；背包里还有回复药）。`].filter(Boolean);
      return {...base, applies: true, handling, numbers, evidence};
    }
    // switch-out-of-the-bad-matchup：先看有没有吃到过属性克制的伤害（只算打在**后来倒下那一只**
    // 身上的，`target_slot` 对得上才算），再看从那一击到倒下之间有没有换人
    // （`switch` 是引擎记的主动换人；`replacement` 是被动补位，不算「主动换人」）。
    const badHit = facts.blows.find((blow) => blow.side === ENEMY
      && blow.multiplier !== null && blow.multiplier > TYPE_MULTIPLIER_NEUTRAL
      && blow.index < faint.index
      && (blow.targetSlot === null || faint.slot === null || blow.targetSlot === faint.slot)) ?? null;
    if (!badHit) {
      return {
        ...base, applies: false, handling: null,
        numbers: {faint_turn: faint.turn, fatal_damage: fatal ? fatal.damage : null, bad_hit_turn: null, bad_hit_damage: null, bad_hit_multiplier: null, switched: false},
        evidence: [fatalLine, `${pet.label} 第 ${faint.turn} 回合倒下，但倒下之前没有吃到属性克制的伤害记录。`].filter(Boolean),
      };
    }
    const switched = facts.switches.some((row) => row.side === PLAYER && row.index > badHit.index && row.index < faint.index);
    const handling = switched ? 'switched-out-after-bad-hit' : 'stayed-in-after-bad-hit';
    return {
      ...base, applies: true, handling,
      numbers: {faint_turn: faint.turn, fatal_damage: fatal ? fatal.damage : null, bad_hit_turn: badHit.turn, bad_hit_damage: badHit.damage, bad_hit_multiplier: badHit.multiplier, switched},
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
      numbers: {tick_count: ticks.length, first_tick_turn: first.turn, first_tick_damage: first.damage, status: first.status ?? null, cleansed},
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
      return {
        ...base, applies: false, handling: null,
        numbers: {faint_turn: faint.turn, next_turn: null, next_multiplier: null, resisted: null},
        evidence: [`${pet.label} 第 ${faint.turn} 回合倒下，之后没有带属性倍率的我方出手记录。`],
      };
    }
    const resisted = next.multiplier < TYPE_MULTIPLIER_NEUTRAL;
    const handling = resisted ? 'next-hit-into-resist' : 'next-hit-not-resisted';
    return {
      ...base, applies: true, handling,
      numbers: {faint_turn: faint.turn, next_turn: next.turn, next_multiplier: next.multiplier, resisted},
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
      numbers: {
        resist_count: resisted.length,
        first_resist_turn: first.turn,
        first_resist_skill: first.skillId,
        // 连着两回合的那一对（`null` ＝ 这一局没有连着打抵抗）。
        pair: pair === null ? null : [pair, pair + RESIST_WINDOW_TURNS],
      },
      evidence: [pair === null
        ? [`我方一共打出 ${resisted.length} 次被属性抵抗的伤害，没有连着两个回合都打在抵抗上（最早的抵抗在第 ${first.turn} 回合${blowSkillSuffix(first, names)}）。`]
        : [`我方在第 ${pair} 与第 ${pair + RESIST_WINDOW_TURNS} 回合连着打在属性抵抗上（这一局共 ${resisted.length} 次）。`]],
    };
  }

  return null;
}

// ── 主入口 ①：局末复盘 ─────────────────────────────────────────────────────

/**
 * 结果字符串 → 一句玩家看得懂的话。**四类分开**（胜 / 负 / 逃跑 / 异常结束）。
 *
 * @param {string|null} result 引擎给的 `battle_result`（或视图投影里的 `result`）
 * @param {object|null} facts   `teacherMatchFacts` 的结果——只用来看有没有 `surrender` 行：
 *   投降方判负，结果字符串仍是 `loss`/`win`（`env.py:1702`），所以「这一局是投降结束的」
 *   只能从事件里认。认出来就照实说，不把投降说成「被打输」。
 */
function outcomeText(result, facts = null) {
  const value = safeResultToken(result);
  const surrender = surrenderSide(facts);
  if (value && OUTCOME_TEXT[value]) {
    if (value === 'loss' && surrender === PLAYER) return '最后判负（这一局是我方投降，不是全队被打倒）';
    if (value === 'win' && surrender === ENEMY) return '对面投降，这一局赢了下来';
    return OUTCOME_TEXT[value];
  }
  // 未知取值与「没给」分开说，但都**不许**写成输赢：这一局的结论没拿到，不是输了。
  if (value) return `${OUTCOME_UNKNOWN}（引擎写的结束方式是「${value}」，这一局不按输赢来看）`;
  return `${OUTCOME_UNKNOWN}（结束方式那一项是空的），这一局不按输赢来看`;
}

/**
 * 能不能把引擎给的取值原样写进句子。
 *
 * 为什么需要它：这个值来自视图投影（`roco-service.js:190` 的 `battle_result: result.result ?? null`），
 * 而同一处的 `result` 在别的动作回执里是**对象**。原样把一个对象塞进句子会写出
 * `[object Object]` 或者一串花括号——既有判据把 `{}` 列为禁用字样，这正是它们要拦的东西。
 * 只是不像一句话就不写它，**不编**一个说法。
 */
function safeResultToken(value) {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (!token || token.length > 24) return null;
  if (/[{}<>"']/.test(token)) return null;
  return token;
}

/** 这一局有没有投降、哪一方投的（`env.py:1711` 的 `surrender` 行）。没有就是 null。 */
function surrenderSide(facts) {
  const row = (facts?.surrenders ?? []).find((item) => item.side !== null) ?? null;
  return row ? row.side : null;
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

// ── 合法替代：只讲「表真的属于那一回合」的那些项 ──────────────────────────────
//
// 这一节回答 U10 的第一条缺口：「那一回合当时还有一个合法替代是 X，因为 Y」。
// 三条纪律（每条都有判据钉着）：
//   ① 只在表真的属于那一回合时才说「当时合法集合里有 X」——两条来源分别标注
//      （`legal-by-turn` / `live-view`），拿不到就 fail closed 并写清**哪一项未知**；
//   ② 理由只用本局已经核对过的数字（`evaluateGoal` 的 `numbers`），不新编一句因果；
//   ③ 收尾一句「这里只说当时有这一项可选，不代表换了它整局就会不一样」——
//      这是与「不拿单次事件写绝对结论」同一条口径（U10 第 3 条）。

/** 引擎道具表里「净化」那一项（`env.py:125` 的 `ITEM_EFFECTS`）。 */
const CLEANSE_ITEM_IDS = Object.freeze(['净化药', 'cleanse']);

/** 这一局属于哪一场。`matchId` 参数优先，其次局面视图的 `id`（`rocoGameView` 存的就是它）。 */
function matchIdOf({matchId = null, game = null} = {}) {
  if (typeof matchId === 'string' && matchId) return matchId;
  const id = asObject(game).id;
  return typeof id === 'string' && id ? id : null;
}

/** 手里这份局面属于哪一回合（`rocoGameView` 把视图的 turn 同时放在顶层与 `roco` 里）。 */
function viewTurnOf(game) {
  const raw = asObject(asObject(game).roco);
  if (Number.isInteger(raw.turn)) return raw.turn;
  const turn = asObject(game).turn;
  return Number.isInteger(turn) ? turn : null;
}

/**
 * 按回合查调用方给的合法表。
 *
 * 认三种同义结构（都是纯数据，不引入依赖）：
 *   · `{3: [...]}`（键是回合号，字符串键也认）；
 *   · `new Map([[3, [...]]])`；
 *   · `[{turn: 3, legal: [...]}]`（或 `actions`）。
 * 拿不到返回 null——**不猜**，也不退化成空表：空表会被下游读成「当时没有别的可选」，
 * 那是把「查不到」说成了「没有」。
 */
function lookupLegalByTurn(legalByTurn, turn) {
  if (!Number.isInteger(turn) || legalByTurn === null || legalByTurn === undefined) return null;
  if (typeof legalByTurn?.get === 'function') {
    const hit = legalByTurn.get(turn) ?? legalByTurn.get(String(turn));
    return Array.isArray(hit) ? hit : null;
  }
  if (Array.isArray(legalByTurn)) {
    const row = legalByTurn.find((item) => Number(item?.turn) === turn) ?? null;
    const list = row?.legal ?? row?.actions ?? null;
    return Array.isArray(list) ? list : null;
  }
  if (typeof legalByTurn === 'object') {
    const hit = legalByTurn[turn] ?? legalByTurn[String(turn)];
    return Array.isArray(hit) ? hit : null;
  }
  return null;
}

/**
 * 合法动作的中文说法。三种写法都见过（与 `nameBook` 同一套口径）：
 * `label`（`ui_legal_actions` 加的）、`skill_name`、`skill.name`。
 * 拿不到就返回 null——**不编**名字（未知 kind 也不拿 kind 本身充数）。
 */
function legalActionLabel(action, names) {
  const row = asObject(action);
  const explicit = [row.label, row.skill_name, row?.skill?.name]
    .find((value) => typeof value === 'string' && value.trim());
  if (explicit) return explicit.trim();
  const kind = typeof row.kind === 'string' ? row.kind : '';
  if (kind === 'skill') return skillNameOf(row.skill_id, names);
  if (kind === 'item') return typeof row.item_id === 'string' && row.item_id ? `使用${row.item_id}` : null;
  if (kind === 'switch') return Number.isInteger(row.target_index) ? `换上第 ${row.target_index + 1} 位` : '换人';
  return ACTION_KIND_LABEL[kind] ?? null;
}

/** 这个道具是干什么的：`heal` / `cleanse` / null（认不出就不认，不猜效果）。 */
function itemRole(action) {
  const row = asObject(action);
  if (row.kind !== 'item') return null;
  const id = typeof row.item_id === 'string' ? row.item_id : '';
  const label = typeof row.label === 'string' ? row.label : '';
  if (HEAL_ITEM_IDS.some((name) => id === name || label.includes(name))) return 'heal';
  if (CLEANSE_ITEM_IDS.some((name) => id === name || label.includes(name))) return 'cleanse';
  return null;
}

/** 那一回合我方**实际**做了什么。只认事件（动作表说的是「能选什么」，不是「选了什么」）。 */
function actionsTakenAt(facts, turn) {
  if (!Number.isInteger(turn)) return [];
  const taken = [];
  for (const blow of facts.blows) {
    if (blow.side === PLAYER && blow.turn === turn) taken.push({kind: 'skill', skillId: blow.skillId});
  }
  for (const item of facts.items) {
    if (item.side === PLAYER && item.turn === turn) taken.push({kind: 'item', item: item.item});
  }
  for (const row of facts.switches) {
    if (row.side === PLAYER && row.turn === turn) taken.push({kind: 'switch', toSlot: row.toSlot});
  }
  return taken;
}

/**
 * 「这一课要改的那件事」的**理由**：只用 `evaluateGoal` 已经算出来的数字，
 * 一句新事实都不加。拿不到数字就返回 null ⇒ 那一句替代话不写（宁可不讲，不编）。
 */
function alternativeReason(goal, numbers) {
  const row = asObject(numbers);
  if (goal === 'use-item-before-danger-line') {
    if (!Number.isInteger(row.faint_turn)) return null;
    return `这一局直到第 ${row.faint_turn} 回合倒下都没有用过回复药（事件流里没有我方用药的记录）`;
  }
  if (goal === 'switch-out-of-the-bad-matchup') {
    const parts = [];
    if (Number.isInteger(row.bad_hit_turn) && Number.isFinite(row.bad_hit_damage)) {
      const multiplier = Number.isFinite(row.bad_hit_multiplier) ? `，倍率 ${row.bad_hit_multiplier}` : '';
      parts.push(`第 ${row.bad_hit_turn} 回合已经吃过一次属性克制的伤害（约 ${row.bad_hit_damage} 点${multiplier}）`);
    }
    if (Number.isInteger(row.faint_turn)) parts.push(`到第 ${row.faint_turn} 回合倒下之间没有换过人`);
    return parts.length ? parts.join('，') : null;
  }
  if (goal === 'treat-status-before-it-stacks') {
    if (!Number.isInteger(row.tick_count) || !Number.isInteger(row.first_tick_turn)) return null;
    const name = row.status ? `「${row.status}」` : '异常状态';
    const amount = Number.isFinite(row.first_tick_damage) ? `，约 ${row.first_tick_damage} 点` : '';
    return `我方身上的${name}在回合末已经扣了 ${row.tick_count} 次血（第一次是第 ${row.first_tick_turn} 回合${amount}）${row.cleansed === true ? '，中途用过净化类道具' : '，这一局没有净化类道具的使用记录'}`;
  }
  if (goal === 'stop-attacking-into-resistance') {
    if (!Number.isInteger(row.resist_count)) return null;
    if (Array.isArray(row.pair) && row.pair.length === 2) {
      return `我方在第 ${row.pair[0]} 与第 ${row.pair[1]} 回合连着打在属性抵抗上（这一局共 ${row.resist_count} 次）`;
    }
    return `我方一共打出 ${row.resist_count} 次被属性抵抗的伤害，没有连着两个回合都打在抵抗上`;
  }
  return null;
}

/** 「换了这一手就不一样」这类保证性说法，一律由这一句收口。 */
const ALTERNATIVE_HEDGE = '这里只说当时有这一项可选，不代表换了它整局就会不一样。';

/**
 * 挑出「那一回合的合法替代」并把话说完整。
 *
 * @returns {{field: object, sentence: string|null, evidence: string|null}}
 *   `field.claimed === true` 才表示**真的声称了**「当时合法集合里有 X」；
 *   拿不到表时 `field.unknown` 写清哪一项未知，`sentence` 给出现在就能做的一步。
 */
function alternativeFor({goal, chosen, facts, game, names, legalByTurn, decisionRecords, isMistake}) {
  const rule = Object.hasOwn(GOAL_ALTERNATIVE, goal) ? GOAL_ALTERNATIVE[goal] : null;
  const anchor = Number.isInteger(chosen.turn) ? chosen.turn : null;
  const viewTurn = viewTurnOf(game);
  const field = {
    claimed: false, source: null, anchor_turn: anchor, view_turn: viewTurn,
    label: null, reason: null, unknown: null, skipped: null, menu: [], remedy: rule?.remedy ?? null,
  };
  // ① 这一课要改的不是「那一回合选哪一项」：不点替代（也谈不上「未知」）。
  if (!rule) return {field: {...field, skipped: 'lesson-is-not-an-action-choice'}, sentence: null, evidence: null};
  // ② 这一课这一局是做对了的地方：不点替代——表扬那一局配一句「你当时其实可以…」是自相矛盾。
  if (!isMistake) return {field: {...field, skipped: 'lesson-was-handled-well'}, sentence: null, evidence: null};
  // ③ 连「哪一回合」都拿不到：先把这个未知说清楚。
  if (anchor === null) {
    const unknown = '这一课的局面落在第几回合';
    return {
      field: {...field, unknown},
      sentence: `这一课的局面没有落在具体回合上（事件里那一回合没有记下来），所以不能说「那一回合的合法动作里有哪一项」；能照做的还是学习点里那一句。`,
      evidence: `这一课的局面没有落在具体回合上，合法动作表无从对上（未知项：${unknown}）。`,
    };
  }
  // ④ 找表：先按回合查调用方给的表，再看局面视图能不能为**这一回合**作证。
  const identityRequired=game?.roco?.self?.pets?.length===6||decisionRecords!==undefined;
  const bound=decisionEvidenceAt(decisionRecords,{matchId:game?.id,publicMatchId:game?.roco?.match_id,turn:anchor,taken:actionsTakenAt(facts,anchor)});
  if(bound)Object.assign(field,{match_id:bound.matchId,public_match_id:bound.publicMatchId,decision_id:bound.decisionId,state_version:bound.stateVersion,phase:bound.phase});
  const fromCaller = identityRequired ? null : lookupLegalByTurn(legalByTurn, anchor);
  // 两种形状都认（与 `nameBook` 同一口径）：`rocoGameView` 的投影在 `roco.legal`，
  // 而手工拼出来的局面对象常见的是顶层 `legal`——它们的「属于哪一回合」都由 `viewTurnOf` 判。
  const rawLegal = asObject(asObject(game).roco).legal ?? asObject(game).legal;
  const viewVouches = viewTurn === anchor && Array.isArray(rawLegal) && rawLegal.length > 0;
  const source = bound ? 'decision-evidence' : (identityRequired ? null : (fromCaller?.length ? 'legal-by-turn' : (viewVouches ? 'live-view' : null)));
  const table = bound ? bound.legal : (source === 'legal-by-turn' ? fromCaller : (source === 'live-view' ? rawLegal : null));
  if (!table) {
    const unknown = identityRequired ? '该次主动决策的身份绑定合法表未确认' : '那一回合的合法行动表没有随复盘送来';
    const holder = viewTurn === null ? '手里也没有带合法表的局面' : `手里那份局面属于第 ${viewTurn} 回合`;
    return {
      field: {...field, unknown},
      sentence: `${identityRequired ? `第 ${anchor} 回合的主动决策身份未确认` : `第 ${anchor} 回合的合法行动表没有随复盘送来`}，所以这里不能说「当时合法动作里有哪一项」——这是查不到，不是没有。能照做的还是学习点里那一句。`,
      evidence: `第 ${anchor} 回合的合法行动表查不到（${holder}）。未知项：${unknown}。`,
    };
  }
  // ⑤ 表在手上：菜单原样列出来（最多 6 条，避免把一张长表念完），再挑能对上这一课的那一项。
  const menu = [];
  for (const action of table) {
    const label = legalActionLabel(action, names);
    if (label && !menu.includes(label)) menu.push(label);
    if (menu.length >= 6) break;
  }
  const taken = bound ? [{kind:bound.submittedAction.kind,skillId:bound.submittedAction.skill_id,toSlot:bound.submittedAction.target_index,label:bound.submittedAction.label}] : actionsTakenAt(facts, anchor);
  const takenSkillIds = new Set(taken.filter((row) => row.kind === 'skill' && row.skillId).map((row) => row.skillId));
  const takenItem = taken.some((row) => row.kind === 'item');
  const takenSwitch = taken.some((row) => row.kind === 'switch');
  let picked = null;
  for (const action of table) {
    const row = asObject(action);
    const kind = typeof row.kind === 'string' ? row.kind : '';
    if (!rule.kinds.includes(kind)) continue;
    // 排除「那一回合已经做过的那一手」：建议玩家再做一遍他刚做过的事没有意义。
    if (kind === 'skill' && row.skill_id && takenSkillIds.has(row.skill_id)) continue;
    if (kind === 'item' && takenItem) continue;
    if (kind === 'switch' && takenSwitch) continue;
    // 道具只认对得上这一课的那一类：用药课只认回复药，状态课只认净化药（认不出就不认）。
    if (kind === 'item') {
      const wanted = goal === 'use-item-before-danger-line'
        ? 'heal'
        : (goal === 'treat-status-before-it-stacks' ? 'cleanse' : null);
      if (wanted && itemRole(row) !== wanted) continue;
    }
    const label = legalActionLabel(row, names);
    if (!label) continue;
    picked = {kind, label, skill: row.skill_id ?? null, item: row.item_id ?? null};
    break;
  }
  const sourceText = bound ? `来自本局 ${bound.decisionId} 的主动决策合法表（状态版本 ${bound.stateVersion}）` : source === 'legal-by-turn'
    ? '来自调用方逐回合送来的合法表'
    : `来自第 ${viewTurn} 回合那份可行动局面的合法表（就是这一回合）`;
  if (!picked) {
    // 菜单只显示前 6 条（`menu` 上限），表更长时把总数一起写出来——**不许**让玩家以为
    // 「表里就这几项」；「没有能对上这一课的那一项」这个结论是拿**整张表**判的，不是前 6 条。
    const shown = menu.length ? menu.map((label) => `「${label}」`).join('、') : '（表里没有能读出名字的项）';
    const menuText = table.length > menu.length ? `${shown} 等（共 ${table.length} 项）` : shown;
    return {
      field: {...field, source, menu, skipped: 'table-has-no-matching-alternative'},
      sentence: `第 ${anchor} 回合当时的合法动作表里有 ${menuText}，里面没有能对上这一课的那一项（这一课要改的是「${rule.remedy}」），所以这里不点「当时该换成什么」。`,
      evidence: `第 ${anchor} 回合的合法动作表：${menuText}（没有能对上这一课的那一项）。`,
    };
  }
  const reason = alternativeReason(goal, chosen.numbers);
  if (!reason) {
    // 数字拿不齐 ⇒ 说不出**可核对**的理由 ⇒ 不点这一项（只如实说表里有它）。
    const unknown = '这一课对应的事实数字';
    return {
      field: {...field, source, menu, label: picked.label, unknown},
      sentence: `第 ${anchor} 回合当时的合法动作里确实有「${picked.label}」这一项，但要说明「为什么值得看它」还缺这一条事实（未知项：${unknown}），所以这里不硬给理由。`,
      evidence: `第 ${anchor} 回合的合法动作表里有「${picked.label}」（${sourceText}）。`,
    };
  }
  const actualText = (() => {
    // 「当时你做的是「…」」只在**真的叫得出名字**时才写：叫不出名字的那一手直接不提，
    // 不写「一个技能」这类占位说法（那等于在依据里塞一个不是事实的短语）。
    const labels = [];
    for (const row of taken) {
      if (row.kind === 'skill') {
        const name = row.label || skillNameOf(row.skillId, names);
        if (name) labels.push(name);
      } else if (row.kind === 'item') {
        labels.push(`使用${row.item ?? '道具'}`);
      } else if (row.kind === 'switch') {
        labels.push(Number.isInteger(row.toSlot) ? `换上第 ${row.toSlot + 1} 位` : '换人');
      }
    }
    return labels.length ? `，当时你${bound ? '提交' : '做'}的是「${labels.join('、')}」` : '';
  })();
  return {
    field: {...field, claimed: true, source, menu, label: picked.label, reason, kind: picked.kind},
    sentence: `第 ${anchor} 回合当时的合法动作里还有「${picked.label}」这一项${actualText}。之所以值得看它：${reason}——这一课要改的是「${rule.remedy}」。${ALTERNATIVE_HEDGE}`,
    evidence: `第 ${anchor} 回合的合法动作表里有「${picked.label}」（${sourceText}）。`,
  };
}

// ── 复读防线：同一句话不讲第二遍（但**不**因此整条沉默）─────────────────────
//
// U10 第 2 条：不得复读同一句。这里的「同一句」= 同一门课 + 同一类局面 + 同一种处理
// + 同一句学习点，判断依据是 memory 里 `recordTeacherReview` 已经写下的账
// （`journal` 的 `kind:'teach'` 行：`goal` / `situation` / `handling` / `turn` / `text`）。
//
// 两条边界（判据里逐条做反证）：
//   ① **必须带 matchId 才能被引用**：拿不到本局编号、或账本那一行没有编号时，
//      一律不把它当「上一局」——否则同一局被复盘两遍就会声称「上一局讲过」；
//   ② `matchId` 不同的行才叫「上一局」；同一局的行只说明「这一局已经记过一次账」。
//
// 命中的处理（**不许**整条返回 null——那会把复盘变成空白）：
//   · 先换一门候选课（同一档里没被复读过的）；
//   · 换不出来就把学习点换成另一种**仍然真实**的说法（用本局的具体事实重述），
//     并把为什么换写进 `repeat_avoided`。

/** 账本里 `kind:'teach'` 的行（`recordTeacherReview` 写的那些）。 */
function teachingRows(memory) {
  const rows = Array.isArray(asObject(memory).journal) ? memory.journal : [];
  return rows.filter((row) => row?.kind === 'teach' && typeof row.goal === 'string' && row.goal);
}

/** 别的局讲过的课（`matchId` 两边都有、且不同）。拿不到本局编号就返回空数组（fail closed）。 */
function previousMatchRows(memory, matchId) {
  if (typeof matchId !== 'string' || !matchId) return [];
  return teachingRows(memory).filter((row) => typeof row.matchId === 'string' && row.matchId && row.matchId !== matchId);
}

/** 这一局自己已经记过账的课（同一 `matchId`）。用来避免把本局记录说成「上一局讲过」。 */
function sameMatchRows(memory, matchId) {
  if (typeof matchId !== 'string' || !matchId) return [];
  return teachingRows(memory).filter((row) => row.matchId === matchId);
}

/**
 * 这一门课这一次的「形状」是不是与账本里那一行是同一份。
 *
 * 比的是**机器可读字段**，不是自由文本：`goal` + `situation` + `handling` 三项都要对得上，
 * 再看学习点句子（`row.text` 是 `recordTeacherReview` 存的 `review.learning`）是不是同一句。
 * 老账本没有 `text` 时不装作「不同」——三项对得上就算同一份（宁可多让一次，不复读）。
 */
function sameReviewShape(row, {goal, evaluation}) {
  if (!row || row.goal !== goal) return false;
  const handling = evaluation?.handling ?? null;
  const situation = evaluation?.situation ?? null;
  if (typeof row.handling !== 'string' || !row.handling || row.handling !== handling) return false;
  if (typeof row.situation !== 'string' || !row.situation || row.situation !== situation) return false;
  if (typeof row.text === 'string' && row.text) return row.text === (GOAL_LESSON[goal] ?? null);
  return true;
}

/** 复读防线的结构化交代：为什么换、换成什么、上一局是哪一场。 */
function repeatField({detected, action, previous = null, reason = null}) {
  return {
    detected: Boolean(detected),
    reason: detected ? reason : null,
    action: detected ? action : 'none',
    previous: previous
      ? {
        matchId: previous.matchId ?? null,
        goal: previous.goal ?? null,
        situation: previous.situation ?? null,
        handling: previous.handling ?? null,
        turn: Number.isInteger(previous.turn) ? previous.turn : null,
      }
      : null,
  };
}

/**
 * 「同一局重复调用」的口径：这一课在本局已经记过账时，正文不许说「上一局讲过」
 * （那会把本局记录说成另一局的事）。三个来源分开写清楚。
 */
function repeatDetail({alreadyTaught, sameMatch, previousMatch}) {
  return {
    memory_taught: Boolean(alreadyTaught),
    same_match: Boolean(sameMatch),
    previous_match: Boolean(previousMatch),
  };
}

/**
 * 换不出来时，学习点改成另一种**仍然真实**的说法：同一门课 + 同一种处理 + 这一局的回合，
 * 并明说为什么这次不逐字重复。**不引用**上一局那一句（引用了就是复读）。
 *
 * `GOAL_REPHRASE` 是每门课的第二套说法：换一门课做不到时（候选只有这一门），
 * 至少别把上一局那一句原样再说一遍。它与 `GOAL_LESSON` **不是**同一句
 * （判据会逐字比对：新正文里不许出现上一局的学习点原句），说的却是同一件事。
 */
const GOAL_REPHRASE = Object.freeze({
  'use-item-before-danger-line': '下一局血线掉到一半就先吃药，别等到倒下那一回合才想起背包里还有药。',
  'switch-out-of-the-bad-matchup': '再吃到属性克制的伤害时，下一手就先换人，别让同一只继续站在场上挨。',
  'treat-status-before-it-stacks': '异常状态开始扣血的下一回合就处理掉，别让它一回合接一回合地扣。',
  'read-the-replacement-first': '对面补位之后先看清上来的是谁、什么系，再定这一手打谁。',
  'stop-attacking-into-resistance': '打在抵抗上就别接着再打同一手，换一只或者换一个系别的技能试试。',
});

function rephrasedLessonSentence({goal, chosen, priorSameShape = 1}) {
  const handling = handlingText(chosen?.handling) ?? '同一种处理方式';
  const turn = Number.isInteger(chosen?.turn) ? `第 ${chosen.turn} 回合` : '这一局那一回合';
  const situation = situationText(chosen?.situation);
  const again = GOAL_REPHRASE[goal] ?? null;
  // 「连着第 N 局」这个计数不是修辞：它保证**同一份事实连着来第三、第四次时**，
  // 这一句仍然与上一次不同（否则改写本身就成了新的复读）。它也能被重算：
  // N = 账本里同一门课 + 同一类局面 + 同一种处理的行数 + 1。
  const streak = Number.isInteger(priorSameShape) && priorSameShape > 0 ? `（连着第 ${priorSameShape + 1} 局了）` : '';
  return `这一课上一局的复盘讲过同一件事（${situation}），这一局还是${handling}，${turn}又是这样${streak}——所以这次不逐字重复上一局那一句。${again ? `换个说法：${again}` : ''}`;
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
 * @param {object} input
 *   · `events` / `turns` / `result` / `game` / `memory` / `skills` / `bag`：原有入参，一字未改；
 *   · `legalByTurn`（2026-09-29 加性）：**按回合**的合法动作表，形如
 *     `{3: [{kind:'skill', label:'龙血', skill_id:'…'}], 4: [{kind:'item', item_id:'回复药'}]}`。
 *     传了它才开启「合法替代」那一层（不传 ⇒ 输出与之前逐字节相同）；
 *     那一回合查不到表时会**明说哪一项未知**，不许编「当时你还能选 X」。
 *   · `matchId`（加性）：这一局的编号，用于「不复读上一局同一句」与
 *     「同一局重复复盘不把本局记录说成上一局」。不传时退回 `game.id`（`rocoGameView` 存的就是它）。
 *
 * @returns {null | {
 *   text: string,                      // 2–4 句自然中文复盘，全部来自这一局的事件
 *   turning_point: object,             // {turn, rule, candidates, what, evidence}
 *   learning: string,                  // 一条能照做的学习点
 *   goal: string,                      // TEACHER_GOALS 里的标签
 *   evidence: string[],                // 用到的具体事实（回合、名字、伤害、血量）
 *   check: {situation, handling, turn},// 机器可读，交给 recordTeacherReview 存账
 *   repeat: boolean,                   // 这一课之前是不是已经讲过（memory 口径，未改）
 *   outcome: object,                   // {result, category, sentence, event}——结果四类分开
 *   alternative: object,               // 合法替代：声称了什么 / 哪一项未知（见 alternativeFor）
 *   repeat_avoided: object,            // 复读防线：有没有换、换的理由、上一局是哪一场
 *   repeat_detail: object,             // {memory_taught, same_match, previous_match}
 *   ledger: object,                    // 这一局的复盘记账对象（resetMatchReview() 造的是空的那一份）
 * }}
 * 返回 null ＝ 这一局没有可说的：没有转折点，或者挑不出该讲哪一课。宁可沉默。
 */
export function reviewMatch({
  events = [], turns = null, result = null, game = null, memory = null,
  skills = null, bag = null, legalByTurn = undefined, decisionRecords = undefined, matchId = null,
} = {}) {
  const facts = teacherMatchFacts({events});
  const names = nameBook(game, skills);
  const point = chooseTurningPoint({facts, game});
  if (!point) return null;
  // 这一局是哪一场：决定「账本里哪一行算上一局」。拿不到就**不引用**任何旧局（fail closed）。
  const currentMatchId = matchIdOf({matchId, game});
  // ── 挑哪一门课：先看「这一局有没有做错的地方」，不是先看优先级 ──────────────
  //
  // 第 45 轮实测（30 个固定种子、真服务打完整局、真引擎）：按固定优先级取第一门
  // 够得上的课，**30/30 都是同一门** `use-item-before-danger-line`——其中 13 局
  // （43%）玩家其实**已经做对了**（`healed-before-faint`，正文是「这一步的先后顺序
  // 是对的」），也就是说他这一局唯一的学习点被花在了一句表扬上，而同一局里
  // 别的、真的做错了的课（补给之后打在抵抗上 / 吃到克制伤害不换人）一句都没提。
  //
  // 老师的职责是「一个转折点 + **一条可执行的改法**」，所以按**可教性**排：
  //   ① 处理方式做错了的课优先（`HANDLING_RANK` 里排 1 的那些）；
  //   ② 都是错的时候，仍按 `TEACHER_GOALS` 的优先级；
  //   ③ 这一课以前讲过、而同一档里还有没讲过的，先讲没讲过的（不把同一课念第二遍）；
  //   ④ 一句错都没有（全做对了）才讲「做对了」那一门——那时它是这一局最值得看的地方。
  const candidates = [];
  for (const candidate of TEACHER_GOALS) {
    const evaluation = evaluateGoal(candidate, {facts, game, names, bag});
    if (!evaluation) continue;
    // `applies === false` 的候选跳过（前提不在的课不能讲，例如背包里根本没药却教人吃药）。
    if (evaluation.applies !== true) continue;
    candidates.push({goal: candidate, evaluation});
  }
  if (!candidates.length) return null;
  const rank = (row) => HANDLING_RANK[row.evaluation.handling];
  const untaught = (row) => teachingPlan(memory, {lesson: row.goal}).teach !== false;
  const mistakes = candidates.filter((row) => rank(row) === 1);
  const pickFrom = (pool) => pool.find(untaught) ?? pool[0];
  let choice = mistakes.length ? pickFrom(mistakes) : pickFrom(candidates);

  // ── 复读防线：上一局讲过同一句时换一门课（换不出来就换一种说法）──────────────
  //
  // 判据、边界与「不许因此沉默」的理由都写在 `sameReviewShape` 那一段注释里。
  // 比的基准是 `primary`——**不看「讲过没有」**的那一选（`mistakes[0]` / `candidates[0]`）：
  // 上面第 ③ 条规则（`teachingPlan` 的 `untaught`）已经会把它让位给没讲过的课，
  // 那是同一件事的另一半。所以两处都要认，并且**分清是哪一处换的**（`repeat_avoided.via`）：
  //   · `lesson-preference`：原有规则换的（这一层只负责如实记下原因，不改动它）；
  //   · `repeat-defense`：原有规则没换（同一档里没有别的候选），由这一层换或改写。
  const priorRows = previousMatchRows(memory, currentMatchId);
  const sameRows = sameMatchRows(memory, currentMatchId);
  const repeatedRowFor = (row) => (row ? priorRows.find((item) => sameReviewShape(item, row)) ?? null : null);
  const primary = mistakes.length ? mistakes[0] : candidates[0];
  const repeatHit = repeatedRowFor(primary);
  let repeatAction = 'none';
  let repeatVia = null;
  if (repeatHit) {
    if (choice.goal !== primary.goal && !repeatedRowFor(choice)) {
      repeatAction = 'switched-lesson';
      repeatVia = 'lesson-preference';
    } else {
      const pool = candidates.filter((row) => row.goal !== primary.goal && !repeatedRowFor(row));
      const sameRank = pool.filter((row) => rank(row) === rank(primary));
      const swapped = pickFrom(sameRank.length ? sameRank : pool);
      if (swapped && swapped.goal !== primary.goal) {
        choice = swapped;
        repeatAction = 'switched-lesson';
      } else {
        // 候选只有这一门、而且被复读过：**不沉默**，改由「换一种仍然真实的说法」兜住。
        choice = primary;
        repeatAction = 'rephrased';
      }
      repeatVia = 'repeat-defense';
    }
  }
  const chosen = choice.evaluation;
  const goal = choice.goal;

  // 复用 memory.js 的教学账本判断「这一课讲过没有」——不新建第二套「教过」记录。
  const alreadyTaught = teachingPlan(memory, {lesson: goal}).teach === false;
  const mistakeAvailable = mistakes.length > 0;
  const teachingAMistake = rank(choice) === 1;
  // 同一局重复复盘：账本里这一局已经记过这一课 ⇒ 不许说「这一课之前讲过，这次又是同一类局面」
  // （那是把本局记录说成另一局的事）。三种来源分开放在 `repeat_detail` 里，供页面与判据核对。
  const sameMatchTaught = sameRows.some((row) => row.goal === goal);
  const previousMatchTaught = priorRows.some((row) => row.goal === goal);
  // 同一门课 + 同一类局面 + 同一种处理**连着**出现过几次（含本局之前的那些局）。
  // 改写那一句要用它：同一份事实连着来第三次、第四次时，靠它才能仍然与上一次不同。
  const previousSameShape = priorRows.filter((row) => sameReviewShape(row, {goal, evaluation: chosen})).length;
  const repeatAvoided = repeatHit
    ? {...repeatField({detected: true, action: repeatAction, previous: repeatHit, reason: 'same-lesson-as-previous-match'}), via: repeatVia, streak: previousSameShape + 1}
    : {...repeatField({detected: false, action: 'none'}), via: null, streak: 0};

  // ── 合法替代：那一回合当时还能选什么（只在调用方给了 `legalByTurn` 时才开口）──
  const alternative = (legalByTurn == null && decisionRecords === undefined && game?.roco?.self?.pets?.length!==6)
    ? null
    : alternativeFor({goal, chosen, facts, game, names, legalByTurn, decisionRecords, isMistake: teachingAMistake});

  const outcome = resultOf({result, game});
  const outcomeSentence = outcomeText(outcome, facts);

  const sentences = [];
  const totalTurns = turnCountOf({turns, game, facts});
  sentences.push(`这一局一共 ${totalTurns === null ? '若干' : totalTurns} 个回合，${outcomeSentence}。`);
  sentences.push(turningPointSentence(point));
  const lesson = lessonSentence(goal, chosen);
  if (lesson) sentences.push(repeatAction === 'rephrased' ? rephrasedLessonSentence({goal, chosen, priorSameShape: previousSameShape}) : lesson);
  if (repeatAction === 'switched-lesson' && repeatHit) {
    // 为什么换课：上一局讲的是另一门课，这一局不重复那一句。说给玩家听的是**原因**，不是账本字段名。
    // 位置紧跟学习点那一句：它解释的正是「这一课为什么换了一门」。
    const was = HANDLING_LABEL[repeatHit.handling] ?? SITUATION_LABEL[repeatHit.situation] ?? '同一类局面';
    const now = HANDLING_LABEL[chosen.handling] ?? SITUATION_LABEL[chosen.situation] ?? '这一门';
    sentences.push(`上一局的复盘讲的是「${was}」这一类局面，这一局不再重复那一句，换成「${now}」来讲。`);
  }
  if (alternative?.sentence) sentences.push(alternative.sentence);
  if (alreadyTaught) {
    // 同一局重复复盘：说「这一局已经记过账」，**不许**说「这一课之前讲过，这次又是同一类局面」
    // （那是把本局记录说成另一局的事，U10 第 5 条）。
    // 另外：改写那一条（`rephrased`）自己已经把「上一局讲过同一件事」说清楚了，不再叠一句。
    if (sameMatchTaught) sentences.push('这一课在这一局里已经记过一次账（同一局重复复盘），这一遍不再当成新的一课。');
    else if (repeatAction !== 'rephrased') sentences.push('这一课之前讲过，这次又是同一类局面。');
  }

  const evidence = [];
  for (const line of point.evidence) if (line) evidence.push(line);
  for (const line of chosen.evidence ?? []) if (line) evidence.push(line);
  if (alternative?.evidence) evidence.push(alternative.evidence);
  // 血量只在公开视图真的给了 maxHp 时才写；`chosen.pet.slot` 不明（状态扣血查不到是哪一只）
  // 时 `hpEvidence` 自己返回 null，不拿别的精灵顶替。
  const hp = hpEvidence(game, chosen.pet?.side ?? PLAYER, chosen.pet?.slot ?? null);
  if (hp) evidence.push(hp);

  const category = safeResultToken(outcome);
  const review = {
    matchId: currentMatchId,
    text: sentences.join(''),
    turning_point: {turn: point.turn, rule: point.rule, candidates: point.candidates, what: point.what, evidence: point.evidence},
    learning: GOAL_LESSON[goal] ?? null,
    goal,
    evidence,
    check: {situation: chosen.situation, handling: chosen.handling, turn: chosen.turn},
    repeat: alreadyTaught,
    // 结果四类分开（胜 / 负 / 逃跑 / 异常结束）：`category` 是机器可读的那一类，
    // `sentence` 就是正文里那一句（去掉句号），`event` 记这一局有没有投降行。
    outcome: {
      result: outcome,
      category: category && BATTLE_RESULTS.includes(category) ? category : (category ? 'unknown' : 'missing'),
      sentence: outcomeSentence,
      event: surrenderSide(facts) ? 'surrender' : ((facts.escapes ?? []).some((row) => row.side !== null) ? 'escape' : null),
    },
    alternative: alternative?.field ?? null,
    repeat_avoided: repeatAvoided,
    repeat_detail: repeatDetail({alreadyTaught, sameMatch: sameMatchTaught, previousMatch: previousMatchTaught}),
    // 可核对的两个记号：这一局**有没有**做错的地方、最后讲的是不是那一处。
    // 页面与验收据此断言「先讲要改的，不是先讲优先级最高的」。
    mistake_available: mistakeAvailable,
    teaching_a_mistake: teachingAMistake,
    candidates: candidates.map((row) => row.goal),
  };
  // 这一局的记账对象（开下一局时用 `resetMatchReview()` 换一份全新的，别把旧局的结论带过去）。
  review.ledger = matchReviewLedgerOf(review, {matchId: currentMatchId});
  return review;
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
  // ── 挂账的那个回合必须是**这门课的局面**发生在第几回合（第 45 轮的浏览器实测抓到的）──
  //
  // `checkLearningProgress` 拿 `record.turn` 和下一局的 `evaluation.turn` 做对比，
  // 所以两个数字必须是**同一类时刻**。而一局里「转折点」与「这门课的局面」常常不是同一回合：
  // 实测（19 回合的一局）转折点是**对方**第 10 回合第一次减员，而这门课讲的是**我方**
  // 第 15 回合才倒下。原来存的是转折点回合，于是下一局的核对写成
  // 「对比第 10 回合（上一次：倒下之前还有回复药但没有用）与第 15 回合（这一次：…）」——
  // 两个数字量的不是同一件事，读起来却像同一次对比。
  // 所以：`turn` 存**局面**那一回合（对比用），转折点回合另存 `pointTurn`（依据用）。
  const situationTurn = review?.check?.turn;
  const ledgerTurn = Number.isInteger(situationTurn) ? situationTurn : turn;
  const m = markTaught(memory, {lesson: review.goal});
  return recordCoachEvent(m, {
    id: `${matchId}:teach:${review.goal}`,
    kind: 'teach',
    matchId,
    turn: ledgerTurn,
    pointTurn: turn,
    lesson: review.goal,
    goal: review.goal,
    situation: review?.check?.situation ?? null,
    handling: review?.check?.handling ?? null,
    text: review.learning ?? null,
    // ── 加性三行（2026-09-29）：给「不复读同一句」留可核对的证据 ─────────────
    //
    // 复读防线要比的是「同一份（转折点 + 学习点 + 具体事实）」，而上面那几个字段
    // 只够表达「同一门课 + 同一类局面 + 同一种处理」。所以把**转折点那一句**
    // 与**正文全文**也存下来：
    //   · `pointWhat` / `pointRule`：转折点当时说的是什么（可逐字比）；
    //   · `reviewText`：这一局复盘正文的原文（判「上一局是不是讲过同一句」最直接）。
    // 三个字段都是**加性**的：老的读法（transferAssessment / memorySummary / 判据）
    // 一个都不读它们，journal 行多几个键不影响任何既有结论。
    pointRule: review?.turning_point?.rule ?? null,
    pointWhat: review?.turning_point?.what ?? null,
    reviewText: review.text ?? null,
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

// ── 复盘记账对象：开下一局要**换一份全新的** ──────────────────────────────────
//
// U10 第 5 条（「正常开下一局要清掉旧局建议」）在这一层只做**纯函数**：
//   · `resetMatchReview()` 造一份空账（新的一局从它开始）；
//   · `reviewMatch(...)` 返回的 `review.ledger` 就是这一局的账（同一个形状）。
//
// 为什么不是一个带状态的类：这个模块是浏览器安全的纯函数模块（不读时钟、不碰存储），
// 状态归页面（`src/client/roco.js` 的 `state`）。页面在 `returnHome()` /
// `battle/new` 那一处把账换成 `resetMatchReview()` 即可，**这一层不替它记**。
//
// 之所以还要在这里给：这条口径的另一半是**不能靠页面**——旧局的句子不许自己漂进
// 新一局的结论里（那是 `reviewMatch` 里复读防线 + `previousMatchRows` 的 matchId 边界
// 负责的），账本对象只是把这层关系写成可核对的数据。
export const MATCH_REVIEW_LEDGER_VERSION = 1;

/**
 * 一份复盘记账对象（纯数据、可 JSON 序列化、不含时间戳——时间由调用方自己写）。
 *
 * `review` 传 null 就是**空账**（开新局用）；传一份 `reviewMatch` 的结果就是那一局的账。
 */
export function matchReviewLedgerOf(review = null, {matchId = null} = {}) {
  const row = review && typeof review === 'object' ? review : null;
  const owner = typeof matchId === 'string' && matchId
    ? matchId
    : (typeof row?.matchId === 'string' && row.matchId ? row.matchId : null);
  const point = row?.turning_point ?? null;
  const check = row?.check ?? null;
  return {
    version: MATCH_REVIEW_LEDGER_VERSION,
    matchId: owner,
    text: typeof row?.text === 'string' ? row.text : null,
    learning: typeof row?.learning === 'string' ? row.learning : null,
    goal: typeof row?.goal === 'string' ? row.goal : null,
    turning_point: point
      ? {
        turn: Number.isInteger(point.turn) ? point.turn : null,
        rule: typeof point.rule === 'string' ? point.rule : null,
        what: typeof point.what === 'string' ? point.what : null,
      }
      : null,
    check: check
      ? {
        situation: check.situation ?? null,
        handling: check.handling ?? null,
        turn: Number.isInteger(check.turn) ? check.turn : null,
      }
      : null,
    alternative: row?.alternative ?? null,
    repeat_avoided: row?.repeat_avoided ?? null,
    repeat_detail: row?.repeat_detail ?? null,
  };
}

/**
 * 开下一局时用的**全新**复盘账：所有字段归 null/空，绝不带上一局的结论。
 *
 * @param {{matchId?: string|null}} input 新一局的编号（拿不到就传 null——它只用于标注归属，
 *   不参与任何判定：判定看的是 `memory` 里那一行自己的 `matchId`）。
 */
export function resetMatchReview({matchId = null} = {}) {
  return matchReviewLedgerOf(null, {matchId});
}
