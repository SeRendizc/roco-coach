// 属性相性：**承伤方向**的现算（U05，2026-09-29）。
//
// 这一层回答的问题只有一个，而且必须和另外两个问题分开：
//   · 「我这一招打它多少倍」 → 进攻向，来源是**引擎**（`view.damage_preview.samples[].multiplier`），
//     在 `roco.js` 的技能格里，本文件**不碰**；
//   · 「换成这一只，它挨打会怎样」 → **承伤向**，就是本文件；
//   · 「我现在这只挨打会怎样」 → 同一个函数，换一个主语而已。
//
// 数据只来自 `./type-affinity.data.js`（从冻结真值生成），本文件**不写任何倍率常量**。
//
// 为什么不能猜
// ------------
//   ① 防御组合没登记 ⇒ `known:false`，调用方**不许画**（在 `roco.js` 里落成
//      `data-b3-rel="unknown"`，CSS 对 unknown 不显示任何三角）。宁可空着，不许写"无影响"。
//   ② 对手的属性是**公开信息**（`view.opponent.field.types`），但它不是"对手这一手要出什么"。
//      所以这里的口径写死成一句可核对的话：「按对手属性系推算的承伤」。有多属性时不把两个
//      倍率乘起来（那会造出一个数据里不存在的数），而是取**最坏的一格**并点名是哪个系。

import {
  COMBO_COUNT,
  DEFENCE_SCALE_BY_COMBO,
  ENTRY_COUNT,
  RULESET_ID,
  SCALE_NEUTRAL,
  SOURCE_ID,
  SOURCE_SHA256,
} from './type-affinity.data.js';

export {RULESET_ID, SOURCE_ID, SOURCE_SHA256, COMBO_COUNT, ENTRY_COUNT, SCALE_NEUTRAL};

/** 倍率分母：标度 = 倍率 × 4（与 `src/coach/team-gaps.js` 的 `scaleByCombo` 同一口径）。 */
export const SCALE_PER_UNIT = 4;

const INCOMING_LABEL_PREFIX = '承伤';

const cache = new Map();

/** 属性组合的**登记键**：`types.join('|')`（与教练层同一口径）。 */
export function comboKey(types) {
  const list = Array.isArray(types) ? types.filter((t) => typeof t === 'string' && t) : [];
  return list.length ? list.join('|') : null;
}

/**
 * 防御组合 → Map(攻击属性 → 标度)；组合没登记 ⇒ `null`（**未知**，不是中性）。
 *
 * 键序：真值表里每对组合只登记一个方向（例：有「光系|水系」，没有「水系|光系」），
 * 而防御相性的主语是**属性集合**，两个方向说的是同一件事 —— 所以正序查不到时按
 * 逆序再查一次。两次都没有 ⇒ null。这一步是**集合语义**，不是猜倍率。
 */
export function defenceScaleMap(types) {
  const key = comboKey(types);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  const rows = DEFENCE_SCALE_BY_COMBO[key] ?? DEFENCE_SCALE_BY_COMBO[reverseKey(key)] ?? null;
  const map = rows ? new Map(rows) : null;
  cache.set(key, map);
  return map;
}

/** `光系|水系` ⇄ `水系|光系`（只反转一次；单属性返回自己）。 */
function reverseKey(key) {
  const parts = key.split('|');
  return parts.length === 2 ? `${parts[1]}|${parts[0]}` : key;
}

/** 单个攻击属性打这个防御组合的倍率；组合没登记 ⇒ `null`。 */
export function defenceMultiplier(defenderTypes, attackType) {
  const map = defenceScaleMap(defenderTypes);
  if (!map) return null;
  const scale = map.has(attackType) ? map.get(attackType) : SCALE_NEUTRAL;
  return scale / SCALE_PER_UNIT;
}

/** 倍率的显示写法：与真值表的档位逐字对应（0.25 / 0.5 / 1 / 2 / 3），不四舍五入。 */
export function formatMultiplier(multiplier) {
  if (!Number.isFinite(multiplier)) return '—';
  return `×${multiplier}`;
}

/**
 * 「按对手属性系推算的承伤」：对手的每一个属性各当一次攻击系，取**最坏**的一格。
 *
 * @param {string[]} defenderTypes 承伤方（我换上来的 / 现在场上的）属性
 * @param {string[]} attackerTypes 对手的属性（公开信息）
 * @returns {{
 *   known: boolean, reason: string|null, rows: Array<{attackType: string, multiplier: number}>,
 *   worst: {attackType: string, multiplier: number}|null,
 *   best: {attackType: string, multiplier: number}|null,
 *   direction: 'threat'|'resist'|'neutral'|'unknown', label: string, detail: string,
 * }}
 */
export function incomingAffinity(defenderTypes, attackerTypes) {
  const mine = Array.isArray(defenderTypes) ? defenderTypes.filter((t) => typeof t === 'string' && t) : [];
  const foe = Array.isArray(attackerTypes) ? attackerTypes.filter((t) => typeof t === 'string' && t) : [];
  const unknown = (reason) => ({
    known: false, reason, rows: [], worst: null, best: null,
    direction: 'unknown', label: `${INCOMING_LABEL_PREFIX}相性未知`, detail: reason,
  });

  if (!mine.length) return unknown('这一只没有属性数据（名册里 types 为空）');
  if (!foe.length) return unknown('对手当前的属性还没读到');
  const map = defenceScaleMap(mine);
  if (!map) return unknown(`属性组合「${mine.join('|')}」不在冻结相性表里（共 ${COMBO_COUNT} 个组合）`);

  const rows = foe.map((attackType) => ({
    attackType,
    multiplier: (map.has(attackType) ? map.get(attackType) : SCALE_NEUTRAL) / SCALE_PER_UNIT,
  }));
  // 最坏 = 倍率最大的那一格；并列时取表里靠前的那个（顺序稳定，不随对象键序飘）。
  let worst = rows[0];
  let best = rows[0];
  for (const row of rows) {
    if (row.multiplier > worst.multiplier) worst = row;
    if (row.multiplier < best.multiplier) best = row;
  }

  const direction = worst.multiplier > 1 ? 'threat' : (best.multiplier < 1 ? 'resist' : 'neutral');
  const label = direction === 'threat'
    ? `${INCOMING_LABEL_PREFIX} ${worst.attackType} ${formatMultiplier(worst.multiplier)}（被克制）`
    : direction === 'resist'
      ? `${INCOMING_LABEL_PREFIX} ${best.attackType} ${formatMultiplier(best.multiplier)}（抵抗）`
      : `${INCOMING_LABEL_PREFIX}中性`;
  const detail = `${mine.join('·')} 对对手（${foe.join('·')}）的承伤：`
    + rows.map((r) => `${r.attackType} ${formatMultiplier(r.multiplier)}`).join(' / ')
    + `（按对手属性系推算；来源 ruleset ${RULESET_ID}，防御组合 ${mine.join('|')}）`;
  return {known: true, reason: null, rows, worst, best, direction, label, detail};
}

/** 一个属性组合在表里有没有登记（排障 / 验收用；不改语义）。 */
export function hasCombo(types) {
  return defenceScaleMap(types) !== null;
}
