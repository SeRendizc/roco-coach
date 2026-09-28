// 我的盒子：个体状态（性格 / 天分 / 刷新次数）的读写。
//
// 为什么单独一个模块：这一层要碰 localStorage 与服务器字段名（`select` / `group`），
// 而页面主文件 `box.js` 的**玩家区代码里不许出现工程词**（判据见 `tests/roco-box.test.js`
// 的「玩家层：路由的 player 段没有工程键」）。所以"翻译"与"存"都在这里做。
//
// 诚实边界：性格/天分现在**没有真实数值**（小黑盒那份还没导出）⇒ 缺的一律 null，
// 页面上显示"待导出"；刷新是玩家自己的动作，存在他自己的浏览器里。
import {refresh, individualFromInstance, canUndo, undoLastRefresh, duplicateIndividual,
  undoUsed, lastHistoryOf} from '../coach/individuals.js';

const STORE_KEY = 'roco.box.individuals.v1';

function loadAll() {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
function saveAll(all) {
  // 隐私模式下写不了：不报错，只是这次不持久（页面照常显示）。
  try { globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* 忽略 */ }
}

/** 从一张卡造个体记录；已有记录的复用（刷新次数不能被页面重载重置）。 */
function individualFor(all, card) {
  const hit = all[card.select];
  if (hit && typeof hit === 'object') return hit;
  const made = individualFromInstance({
    instance_id: card.select, species_id: card.group, species_name: card.name, level: card.level,
    nature: {value: null}, talent: {value: null},
  }, {level: 60});
  all[card.select] = made;
  return made;
}

/** 这一页的行 → 个体记录表（键是行上的 `select`）。 */
export function individualsForRows(rows) {
  const all = loadAll();
  const out = {};
  for (const card of rows) out[card.select] = individualFor(all, card);
  saveAll(all);
  return out;
}

/**
 * 刷一次（性格或天分）。成功返回 `{ok:true}`，次数用完返回 `{ok:false, reason}` ——
 * **不抛给页面**：次数用完不是错误，是一句要说给玩家听的话。
 */
export function refreshIndividual(kind, individualId, {at = null} = {}) {
  const all = loadAll();
  const one = all[individualId];
  if (!one) return {ok: false, reason: '这个个体不在本地记录里'};
  try {
    all[individualId] = refresh(one, kind, {at: at ?? new Date().toISOString()});
  } catch (error) {
    return {ok: false, reason: String(error?.message ?? error)};
  }
  saveAll(all);
  return {ok: true, individual: all[individualId]};
}

/** 只给判据用：清空本地记录。 */
export function resetIndividualsForTest() {
  try { globalThis.localStorage?.removeItem(STORE_KEY); } catch { /* 忽略 */ }
}

/**
 * 回滚上一次刷新（人类 2026-09-26：「做个上次刷新可回滚吧」）。
 * 与刷新同样：**不抛给页面**，成不成都回一个说给人听的结果。
 */
export function undoIndividual(individualId, {at = null} = {}) {
  const all = loadAll();
  const one = all[individualId];
  if (!one) return {ok: false, reason: '这个个体不在本地记录里'};
  // `canUndo()` 为假有**两种**原因，分开说（按钮那边已经按 `canUndo()` 藏起来了，这里是接口层兜底）：
  //   · 还没刷过 / 已经退到最后一步 ⇒ 没有可退的；
  //   · 刚退过一步 ⇒ 再退就是退两步（人类口述：「只能回上一个状态，不能回前两个状态」）。
  if (!canUndo(one)) {
    return {ok: false, reason: undoUsed(one) > 0 && lastHistoryOf(one)?.kind === 'undo'
      ? '这一步已经退过了：一次只能退一步，再刷一次之后才能再退'
      : '这一只还没有可以回滚的刷新'};
  }
  try {
    all[individualId] = undoLastRefresh(one, {at: at ?? new Date().toISOString()});
  } catch (error) {
    return {ok: false, reason: String(error?.message ?? error)};
  }
  saveAll(all);
  return {ok: true, individual: all[individualId]};
}

/**
 * 「再养一只同种」（人类 2026-09-26：「同一只精灵可以有多个个体…来增加配队复杂度」）。
 *
 * 为什么产品里需要这个入口：冻结的 owned 数据是 48 实例 / 48 物种（更早一次「重复的删掉」的产物），
 * 所以**同种第二只在真机上原本永远不存在** —— 抽屉的"收起/点开"、两个个体比大小、再抓一只
 * 这几条产品逻辑都没有落点（审计 §C6.288 H2 点名的就是这个）。
 * 这里给一条**真的能走通**的路：在同一台机器的本地记录里给这个种类加一个个体，
 * 天分/性格各自重新掷（新个体 = 新的种子），刷新次数重置成 3+3。
 *
 * 诚实边界：这是**本机记录**里多出来的个体（存 localStorage），不是从游戏里"抓"来的；
 * 界面上按钮写的就是「再养一只同种」，不假装是捕捉。真实获得途径要等游戏侧数据口径。
 */
export function addIndividualFor(card, {suffix = null} = {}) {
  const all = loadAll();
  const base = individualFor(all, card);
  // ⚠ 2026-09-28 改钉（人类：「点一下再养一只莫名其妙出现然后**又多一只**还删不掉」）：
  // 原来每次点都再加一只（`-b`→`-c`…最多 6 只）⇒ 连点几下就堆一排同名卡。
  // 人类对"同种多只"的口径是**一对**（2026-09-28 批准演示对时就是这么说的）⇒ 本机**至多加 1 只**：
  // 已经有 `-b` 就**不再加**，并告诉玩家要加先删掉本机那只。
  const used = new Set(Object.keys(all).filter((id) => id.startsWith(base.individual_id)));
  const letters = ['b'];
  const pick = suffix ?? letters.find((letter) => !used.has(`${base.individual_id}-${letter}`));
  if (!pick) {
    return {ok: false, reason: '这一种已经有两只了（同种最多一对）；要再加，先删掉本机那一只'};
  }
  const id = `${base.individual_id}-${pick}`;
  try {
    all[id] = duplicateIndividual(base, {individual_id: id, at: new Date().toISOString()});
  } catch (error) {
    return {ok: false, reason: String(error?.message ?? error)};
  }
  saveAll(all);
  return {ok: true, individual: all[id], individual_id: id};
}

/**
 * **删掉**一个本机个体（人类 2026-09-28：「点一下再养一只莫名其妙出现然后又多一只**还删不掉**」）。
 *
 * 只许删**本机加出来的**那些（`<原编号>-b/-c/…`）：服务端名单里那只删不掉（它不在本机记录里，
 * 说"删掉了"就是骗人）。删不动就**如实说为什么**（`{ok:false, reason}`），页面照原样显示。
 */
export function removeIndividual(individualId) {
  const id = String(individualId ?? '').trim();
  if (!id) return {ok: false, reason: '没有编号 ⇒ 不知道删哪一只'};
  if (!/-(?:b|c|d|e|f)$/.test(id)) {
    return {ok: false, reason: '这只是名单里的个体（不是本机加的）⇒ 不能在这里删'};
  }
  const all = loadAll();
  if (!Object.hasOwn(all, id)) return {ok: false, reason: '本机记录里没有这一只（可能已经删过了）'};
  delete all[id];
  saveAll(all);
  return {ok: true, individual_id: id};
}

/**
 * 本机记录里按编号取一个个体（含「再养一只」加出来的那种 —— 它们**不在**服务端名单里）。
 *
 * 2026-09-27（审计 ③ 的真机那一半）：「＋ 再养一只同种」造出来的个体只活在本机，
 * 而比较走的是服务端那条路（`/api/roco/box?compare=A,B` 按 owned 名单解析）。
 * 页面要能**认出**这种个体，才能把"为什么比不了"说清楚，而不是静默什么都不发生。
 */
export function localIndividualById(individualId) {
  const all = loadAll();
  const one = all?.[individualId];
  return one && typeof one === 'object' ? one : null;
}

/**
 * 本机记录 → **卡片形状**（`select` / `group` / `name` / `locked` / `localOnly`）。
 *
 * 为什么要有它：`box.js` 的玩家区代码**不许出现工程词**（判据 `tests/roco-box.test.js` 扫源码，
 * 2026-09-27 当场抓到我在 `toggleCompare` 里写了 `local.species_id`）。按这个模块本来的分工
 * ——"翻译与存都在这里做"—— 工程键 → 页面字段的换算就放在此处，页面只认卡片那套字段。
 */
export function localCardById(individualId) {
  const one = localIndividualById(individualId);
  if (!one) return null;
  return {select: one.individual_id, group: one.species_id ?? '', name: one.species_name ?? '',
    types: [], locked: false, localOnly: true};
}

/**
 * 本机记录按**种类**分组，只留"服务端那一页没有画的"（即「再养一只同种」加出来的）。
 *
 * 2026-09-27（真机 29 号抓到的真 bug）：`drawerHtml` 早就留了 `extras` 这个入口，
 * 而**页面从来没传过它** —— 于是「＋ 再养一只同种」把个体写进了 localStorage、
 * 状态行还说「在下面这一行里」，可那一行**根本不显示它**（静态判据只查了
 * "box.js 里出现过 `localIndividualsOf`"，而它只出现在 import 那一行 ⇒ 又一次假绿）。
 * 这里一次读完再分组：48 行不必每行 parse 一遍 localStorage。
 */
export function localIndividualsGrouped(serverIds = []) {
  const drawn = new Set((Array.isArray(serverIds) ? serverIds : []).map((id) => String(id)));
  const all = loadAll();
  // ⚠ 返回**普通对象**（不是 `Map`）：消费方 `drawerHtml` 是按 `extras[group.species_id]` 取的 ——
  // 第一版返回 Map，`map['pet_000012']` 是 `undefined`，而它被 `?? []` 兜住 ⇒
  // **一声不响地什么都不画**（真机 29 号查了两轮才定位到这里）。
  const groups = {};
  for (const one of Object.values(all)) {
    if (!one || typeof one !== 'object' || !one.individual_id) continue;
    if (drawn.has(String(one.individual_id))) continue;
    const key = one.species_id ?? 'unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(one);
  }
  for (const list of Object.values(groups)) {
    list.sort((a, b) => String(a.individual_id).localeCompare(String(b.individual_id)));
  }
  return groups;
}

/** 本机记录里**属于这个种类**的个体（含"再养一只"加出来的），按编号排序。 */
export function localIndividualsOf(speciesId, {fallback = null} = {}) {
  const all = loadAll();
  const rows = Object.values(all).filter((row) => row?.species_id === speciesId);
  if (!rows.length && fallback) return [fallback];
  return rows.sort((a, b) => String(a.individual_id).localeCompare(String(b.individual_id)));
}
