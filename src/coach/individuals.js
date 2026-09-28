// 个体层：把 `owned-pets.json` 的实例读成"可培养的个体"，并给出**可复现**的刷新。
//
// 人类口径（逐条落在这里，改口径就改这一处）：
//   · 拥有的精灵**默认 60 级** —— ⚠ 2026-09-27 **改钉**：9-26 说的是"默认 100 级"，
//     但当晚人类拍了「pvp 没有的话就默认都 60 级别吧」，且查证到**官方：等级上限 60 级**
//     （配置表 `ATTR_GLOBAL_CONFIG` 的等级项也只在 60 以内自洽）。所以默认档改成 60，
//     100 级那条留在这里当历史记录（改钉不删）。
//   · 天分（个体值）与性格**没有真实数值的一律归零并标注** —— 不许编；
//   · 同一只精灵**可以有多个个体**（可重复拥有），性格/天分不同 ⇒ 配队复杂度；
//   · 洛手没有加点 ⇒ 用**刷新**代替：`刷新性格` 与 `刷新天分` **分开**，每个个体**各 3 次**；
//   · 刷新必须**可复现**（种子化），并留下历史（刷新前后 + 剩余次数）。
//
// ⚠ 掷点规则的**诚实边界**：官方概率本仓没有。所以两条掷点规则都标 `MODELLED_NOT_OBSERVED`，
// 界面上必须能说出来"这是我们模拟器的掷点，不是官方概率"。拿到真分布（小黑盒/实机）就替换这一处。
import {STAT_KEYS, STAT_NAMES, panelOf, natures} from './talent.js';

export const REFRESH_LIMIT = 3;

/** 一种掷点规则：`uniform-nature/v1` 与 `uniform-talent/v1` —— 都标着"建模的、非实测"。 */
export const ROLL_RULES = {
  nature: {
    id: 'uniform-nature/v1',
    confidence: 'MODELLED_NOT_OBSERVED',
    note: '30 条性格等概率。官方概率本仓没有；这是模拟器的掷点规则，不是实测分布。',
  },
  // 2026-09-26 人类口径（口述）：「刷新天分（一/二/三级，每级随机提升一个**不重复**的属性值 10 点）」。
  // 所以天分刷新**不是掷一个新值**，而是"三级、每级 +10、落在还没加过的那一项上"——
  // 次数上限与"不重复"这两条合起来就是**限制机制**（三次之后这只的加法就定格了）。
  talent: {
    id: 'tiered-plus10/v1',
    confidence: 'RECORDED_IN_GAME',
    // 2026-09-27 人类口述改口径（逐字）：「只能回上一个状态，不能回前两个状态；不是回一次；
    // 还是三次刷新次数，回滚的话不消耗也不返还次数。」
    note: '一/二/三级各一次，每次 +10 到一个还没被加过的属性；**可以回滚上一次** —— '
      + '一次只退一步、不能连着退（再刷一次之后才能再退），**次数不消耗也不返还**；'
      + '回滚之后重刷会掷到**另一个**落点。'
      + '（哪一项被加是随机的 —— 随机性只在这里，幅度与次数都是定死的。）',
  },
};

/** 32 位种子散列（FNV-1a）——同一个体、同一件事、第几次，结果固定。 */
export function seedOf(...parts) {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash = Math.imul(hash ^ 0x2f, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32：小而稳的确定性 PRNG（同种子同序列，跨进程一致）。 */
export function rngFrom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const zeroTalent = () => Object.fromEntries(STAT_KEYS.map((stat) => [stat, 0]));

/**
 * 把 owned 数据集的一条实例读成个体。
 * `talent.value` 在数据集里是 null（没有取值枚举）⇒ **按 0 计并标 `zeroed:true`**（本人口径），
 * 这样界面上能一眼看出"这个 0 不是真数据"，而面板仍然算得出来（不会被 null 卡住）。
 */
/**
 * 原版里**性格与天分都是抓到时随机生成的**（人类 2026-09-26：「性格天分是随机的啊」）。
 * 所以数据集里没这两项时，正确做法不是留空，而是**按种子掷一份出来** ——
 * 同一只个体在任何机器上掷到的一样（种子只来自 instance_id），换机器能复现。
 *
 * ⚠ 分布是**建模的**：性格 30 条等概率；官方概率本仓没有 ⇒ 标 `MODELLED_NOT_OBSERVED`。
 *
 * ⚠ 2026-09-28 **改钉（人类 ⑤ 的口述档位逼出来的）**：天分的**激活条数**必须是 1–3 条。
 *   人类逐字：「天分分为：一般般的天分（激活一条个体值），还不错的天分（激活两条个体值），
 *   相当好的天分（激活三条个体值），了不起的天分（激活三条个体值，性格加成和天分三个加成
 *   正好有重合好像就是了不起）」。**旧口径**是「随机三项 7–10、**另外三项 0–6**」——
 *   实测后果：49 只里激活 4 条 3 只、5 条 16 只、**6 条 30 只**，四档**一只都套不上**
 *   （`talentTierOf` 对 4 条以上如实返回"认不出"）⇒ 档位这个功能等于死掉。
 *   现在：先掷**激活几条**（1/2/3，等概率 —— 官方概率本仓没有，这一条同样是**建模的**），
 *   被激活的那几条给 7–10（社区笔记里"了不起 = 随机三项加 7–10"就是这一档），其余**恰好 0**
 *   （没被激活 = 加成为 0，不是"随机给一点"）。改完实测 49/49 都能读出档位，见台账 §C6.334e。
 */
export function rollNatureAndTalent(instanceId) {
  const seed = seedOf(instanceId, 'initial-roll', 0);
  const next = rngFrom(seed);
  const nature = rollNature(seedOf(instanceId, 'initial-nature', 0));
  const stats = [...STAT_KEYS];
  const talent = {};
  // 洗牌后前 `active` 项进 7–10、其余**恰好 0**（"激活几条"就是人类那四档的判据）。
  for (let i = stats.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [stats[i], stats[j]] = [stats[j], stats[i]];
  }
  const active = 1 + Math.floor(next() * 3);   // 1 / 2 / 3 条（建模：等概率）
  stats.forEach((stat, index) => {
    talent[stat] = index < active ? 7 + Math.floor(next() * 4) : 0;
  });
  return {nature, talent};
}

export function individualFromInstance(instance, {level = 60} = {}) {
  if (!instance || typeof instance !== 'object') throw new Error('individualFromInstance 需要一条实例');
  const id = String(instance.instance_id ?? instance.id ?? '');
  if (!id) throw new Error('实例缺少 instance_id');
  const nature = instance.nature?.value ?? null;
  const rawTalent = instance.talent?.value ?? null;
  // 数据集里没有 ⇒ **掷一份**（原版就是随机的），并标明是掷出来的
  const rolled = (nature === null || !rawTalent) ? rollNatureAndTalent(id) : null;
  return {
    individual_id: id,
    species_id: String(instance.species_id ?? ''),
    species_name: instance.species_name ?? null,
    level: Number.isFinite(Number(instance.level)) && level === null ? Number(instance.level) : level,
    level_source: `default-60（人类 2026-09-27：「pvp 没有的话就默认都 60 级别吧」；等级上限 60 是官方口径。`
      + '9-26 曾按 100 级，已改钉）',
    nature: nature ?? rolled?.nature ?? null,
    nature_source: nature ? 'dataset'
      : 'rolled（原版抓到时随机生成；这里按 instance_id 种子化掷点，换机器结果一致）',
    talent: rawTalent && typeof rawTalent === 'object' ? {...zeroTalent(), ...rawTalent} : {...(rolled?.talent ?? zeroTalent())},
    talent_boosts: [],
    talent_source: rawTalent ? 'dataset'
      : 'rolled（原版随机生成；种子化掷点：先掷激活 1–3 条、激活的那几条 7–10、其余 0 —— 条数与取值都是建模的，非官方概率）',
    refreshes: {nature: REFRESH_LIMIT, talent: REFRESH_LIMIT},
    history: [],
  };
}

export function individualsFromDataset(dataset, {level = 60} = {}) {
  const rows = Array.isArray(dataset?.instances) ? dataset.instances : [];
  const list = rows.map((row) => individualFromInstance(row, {level}));
  // 同一只精灵允许出现多次 —— 这里只校验 id 唯一（同种不同个体是正常情况）。
  const seen = new Set();
  for (const row of list) {
    if (seen.has(row.individual_id)) throw new Error(`个体 id 重复：${row.individual_id}`);
    seen.add(row.individual_id);
  }
  return list;
}

/** 按种类分组（界面上的"抽屉"就是这个形状：一行一种，点开才是个体）。 */
export function groupBySpecies(list) {
  const groups = new Map();
  for (const individual of list) {
    const key = individual.species_id;
    if (!groups.has(key)) groups.set(key, {species_id: key, species_name: individual.species_name, individuals: []});
    groups.get(key).individuals.push(individual);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    count: group.individuals.length,
    // 默认展示哪个个体：调用方给了 `panel_total` 就先比它（同种之间比才公平），
    // 没给就按 id 稳定排序 —— **不许在这里自己算面板**（数字只有一个来源：`talent.js`）。
    best: [...group.individuals].sort((a, b) => (b.panel_total ?? -1) - (a.panel_total ?? -1)
      || a.individual_id.localeCompare(b.individual_id))[0]?.individual_id ?? null,
  }));
}

/** 单个个体的面板（数字只从 `talent.js` 来；缺输入会进 `unknown`）。 */
export function panelOfIndividual(individual, race) {
  return panelOf({race, talent: individual.talent, nature: individual.nature, scope: 'pvp'});
}

/** 掷一次性格（30 条等概率）。 */
export function rollNature(seed) {
  const rows = natures();
  return rows[Math.floor(rngFrom(seed)() * rows.length) % rows.length].name;
}

/** 天分每级加多少（人类口径：每级 +10）。 */
export const TALENT_STEP = 10;
/** 三级：一级/二级/三级各一次。 */
// ⚠ 2026-09-28 **改名**（原名 `TALENT_TIERS`）：`src/coach/talent.js` 里另有一个
// `TALENT_TIERS` —— 那是人类 ⑤ 的**四个档位名**（一般般/还不错/相当好/了不起）的数组，
// 和这里的「刷新天分的三级」**同名不同物**。两个都叫 `TALENT_TIERS` 时，
// `import {TALENT_TIERS}` 拿到的可能是 3、也可能是长度为 4 的数组，页面就会静默画错。
// 现在：**刷新的级数**叫 `TALENT_REFRESH_LEVELS`（本名），**档位**继续叫 `TALENT_TIERS`（在 talent.js）。
export const TALENT_REFRESH_LEVELS = 3;

/**
 * 掷一次天分刷新的**落点**：在"还没被加过"的属性里选一个。
 * `boosted` 是这个个体已被加过的项（来自 history）；全加过就返回 null（次数上限会先挡住）。
 */
export function rollTalentStat(seed, boosted = []) {
  const pool = STAT_KEYS.filter((stat) => !boosted.includes(stat));
  if (!pool.length) return null;
  const pick = Math.floor(rngFrom(seed)() * pool.length) % pool.length;
  return pool[pick];
}

/** 这一只已经被加过哪些项（从天分加成记录里读，不另存状态）。 */
export function boostedStatsOf(individual) {
  return Array.isArray(individual?.talent_boosts)
    ? individual.talent_boosts.map((row) => row.stat)
    : [];
}

const clone = (individual) => ({
  ...individual,
  talent: {...individual.talent},
  talent_boosts: [...(individual.talent_boosts ?? [])],
  refreshes: {...individual.refreshes},
  history: [...individual.history],
});

/**
 * 刷新（**不原地改**：返回新个体；`at` 由调用方给，便于判据里注入固定时间）。
 * 超过次数一律拒绝（抛错），绝不"悄悄多给一次"。
 */
export function refresh(individual, kind, {at = null, salt = ''} = {}) {
  if (kind !== 'nature' && kind !== 'talent') throw new Error(`没有这种刷新：${kind}`);
  // 2026-09-28 改钉（人类逐字：「刷新上限达到后可继续刷新，回到 3 次」）：
  // 次数用完**不再锁死** —— 用掉最后一次之后计数**回到 `REFRESH_LIMIT`**，可以接着刷。
  // 于是「还剩 N 次」的含义变成"离下一次回满还有几次"，不再是"这辈子只剩几次"。
  if (!Number.isInteger(individual.refreshes?.[kind])) {
    // 老记录里没有这一格（或被写坏）就按满额起算，而不是把人挡在外面。
    individual = {...individual, refreshes: {...(individual.refreshes ?? {}), [kind]: REFRESH_LIMIT}};
  }
  // `used`（这是第几次）**不能再按剩余次数推**：计数会回满，那样会算出重复的种子 ⇒ 刷出同一个落点。
  //
  // ⚠ 也不能数 `history` 里这一类的条数：**回滚会把那一条删掉**（`undoLastRefresh` 弹掉刷新行、
  // 压进一条 `undo`），于是回滚之后重刷会退回 `used=1` ⇒ 只剩 `#undo` 那个盐在区分，
  // 实测 200 只里有 6 只（含本机 own-0002）**重刷又刷回同一条** —— 那正是"回滚之后换个落点"
  // 这条承诺被打破。所以用一个**回滚不动的持久计数** `rolls`（只增不减）。
  //
  // 老记录没有这一格：按老口径（`REFRESH_LIMIT - 剩余次数`）起算，与改动前逐字节一致。
  const priorRolls = Number.isInteger(individual.rolls?.[kind])
    ? individual.rolls[kind]
    : Math.max(0, REFRESH_LIMIT - Number(individual.refreshes?.[kind] ?? REFRESH_LIMIT));
  const used = priorRolls + 1;
  // 2026-09-27（审计 §C6.288 ④ 的两处矛盾之一）：**回滚过之后，同一次刷新要掷到不同的落点**。
  // 原来种子只由「个体 + 种类 + 第几次」决定 ⇒ 回滚再刷**必然回到同一个落点**，
  // 而教练文案却说「回滚换一个落点可能更值」——两者自相矛盾。
  // 现在把「这一类回滚过几次」并进种子：回滚一次，重刷就换一个落点；没回滚过时与从前逐字节一致。
  const undone = (Array.isArray(individual.history) ? individual.history : [])
    .filter((row) => row?.kind === 'undo' && row?.undo_of === kind).length;
  const seed = seedOf(individual.individual_id, kind, used, `${salt}${undone ? `#undo${undone}` : ''}`);
  const next = clone(individual);
  const before = kind === 'nature' ? individual.nature : {...individual.talent};
  let stat = null;                                   // 天分这一级落在哪一项（性格类刷新保持 null）
  if (kind === 'nature') {
    next.nature = rollNature(seed);
  } else {
    // 天分：+10 到一个**还没被加过**的项；`talent_boosts` 是账（每级一条），`talent` 是现值。
    stat = rollTalentStat(seed, boostedStatsOf(individual));
    if (!stat) throw Object.assign(new Error('六项都已经加过了 —— 这只的加法定格了'), {code: 'no-stat-left'});
    next.talent = {...individual.talent, [stat]: Number(individual.talent?.[stat] ?? 0) + TALENT_STEP};
    next.talent_boosts = [...(individual.talent_boosts ?? []),
      {tier: used, stat, delta: TALENT_STEP, at}];
  }
  // 用掉一次；**用掉最后一次时回满**（不是变成 0 然后锁死）。
  next.refreshes[kind] = individual.refreshes[kind] > 1
    ? individual.refreshes[kind] - 1 : REFRESH_LIMIT;
  // 累计刷过几次（**回滚不退**）：它是 `used` 的唯一事实源，保证"回滚之后重刷换一个落点"成立。
  next.rolls = {...(individual.rolls ?? {}), [kind]: used};
  // 2026-09-27（§C6.313② 的收尾）：这一级的**落点**要记在账上。
  // 原来只有 `before/after` 两个面板对象，`rollbackAdvice` 得回头去 `talent_boosts` 里按 tier 找，
  // 玩家问"这次换到了哪一项"时没人答得出来。现在：天分记 `stat`；回滚之后重刷再记 `replaced`
  //（= 被撤掉的那个落点），于是"换到了 X（原来那个是 Y）"这句话有据可依。
  const undoneRows = (Array.isArray(individual.history) ? individual.history : [])
    .filter((row) => row?.kind === 'undo' && row?.undo_of === kind);
  const replaced = undoneRows.length ? undoneRows[undoneRows.length - 1].undid ?? null : null;
  const row = {
    kind, used, before, after: kind === 'nature' ? next.nature : {...next.talent},
    remaining: next.refreshes[kind], rule: ROLL_RULES[kind].id, at,
  };
  if (kind === 'talent') row.stat = stat;
  if (replaced !== null && replaced !== undefined) row.replaced = replaced;
  next.history.push(row);
  return next;
}

/** 再来一只同种个体（可重复拥有）：新的 id、刷新次数重新是 3+3、数值按本人口径归零。 */
export function duplicateIndividual(individual, {individual_id, at = null} = {}) {
  if (!individual_id) throw new Error('duplicateIndividual 需要一个新 individual_id');
  if (individual_id === individual.individual_id) throw new Error('新个体的 id 不能和原来一样');
  // ⚠ 2026-09-28 改钉（人类指着截图：这一行「性格 待导出 / 天分 待导出」，而别的行都有值 ——
  // 「点一下再养一只莫名其妙出现然后又多一只还删不掉」）：
  // 原来新个体一律 nature=null + talent 全 0，界面就只能写"待导出"，看起来像坏数据。
  // 现在按**新编号种子化掷一份**（与其它个体同一套 `rollNatureAndTalent`，可复现），
  // 来源照实标成掷点；这样"再养一只"得到的是一只**能看、能比、能培养**的个体。
  const rolled = rollNatureAndTalent(individual_id);
  return {
    ...clone(individual),
    individual_id,
    level: individual.level,
    nature: rolled.nature,
    nature_source: 'rolled（原版抓到时随机生成；这里是按新编号种子化掷点，换机器结果一致）',
    talent: rolled.talent,
    talent_boosts: [],
    talent_source: 'rolled（原版随机生成；种子化掷点：先掷激活 1–3 条、激活的那几条 7–10、其余 0 —— 条数与取值都是建模的，非官方概率）',
    refreshes: {nature: REFRESH_LIMIT, talent: REFRESH_LIMIT},
    history: [{kind: 'duplicate', used: 0, before: individual.individual_id, after: individual_id,
      remaining: REFRESH_LIMIT, rule: 'duplicate/v1', at}],
  };
}

// ── 回滚上一次刷新（人类 2026-09-26：「做个上次刷新可回滚吧，这样可以让 coach 判断是否可以回滚来优化」）──
//
// 三条纪律：
//   ① **只回滚一步**：`history` 里最后一条 `nature`/`talent` 的刷新（`duplicate` 不算）；
//   ② **次数要还**：回滚哪一类就把那一类的剩余次数 +1（但不超过上限）—— 不然"回滚"等于罚一次；
//   ③ **留痕**：回滚本身也进 history（`kind:'undo'`），刷了什么、撤了什么，账上一条不少。

/** 上一次可回滚的刷新（没有就 null）。 */
export function lastRefreshOf(individual) {
  const rows = Array.isArray(individual?.history) ? individual.history : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.kind === 'nature' || rows[i]?.kind === 'talent') return rows[i];
  }
  return null;
}

/**
 * 回滚的规则（**2026-09-27 人类口述改口径**，逐字）：
 *   「只能回上一个状态，不能回前两个状态；**不是回一次**；还是三次刷新次数，
 *     回滚的话**不消耗也不返还**次数。」
 *
 * 翻成人话，就是三条：
 *   ① **一次只退一步**：永远只撤销"最近那一次刷新"，没有"退回到两步之前"这种操作；
 *   ② **不能连着退**：刚退完一步时，最近一条记录是 `undo` —— 这时再退就等于退两步 ⇒ 不允许；
 *      但**再刷一次之后又能退**（所以要退几次都行，只要中间真的刷过）；
 *   ③ **次数不退**：退掉的那一次刷新**不还给你**（三次就是三次），回滚自己也不消耗次数。
 *
 * ⚠ 前一版（同日更早）写的是「每人只许回滚一次」+ 次数归还 —— 那是我替产品做的决定，
 * 人类这次把口径说清了，所以两处都改：`UNDO_LIMIT`/`undoUsed` 不再限制次数（保留导出以免调用方炸），
 * `canUndo()` 改成"**最近一条记录就是刷新**"，`undoLastRefresh()` **不再归还次数**。
 */
export function undoUsed(individual) {
  return (Array.isArray(individual?.history) ? individual.history : [])
    .filter((row) => row?.kind === 'undo').length;
}
/** 历史里最近一条记录（没有就 null）——"只退一步"判的就是它。 */
export function lastHistoryOf(individual) {
  const rows = Array.isArray(individual?.history) ? individual.history : [];
  return rows.length ? rows[rows.length - 1] : null;
}
/** 现在能不能退：**最近一条记录必须是刷新**（退过一次就必须先再刷一次）。 */
export function canUndo(individual) {
  const last = lastHistoryOf(individual);
  return Boolean(last && (last.kind === 'nature' || last.kind === 'talent'));
}

/**
 * 回滚上一次刷新。返回**新个体**（不原地改）；没有可回滚的刷新就抛 `nothing-to-undo`，
 * 连着退第二步抛 `already-undone`（文案说清"只能退一步"）。
 * **次数不动**：退掉的那次刷新不还（人类 2026-09-27 口述）。
 */
export function undoLastRefresh(individual, {at = null} = {}) {
  const last = lastRefreshOf(individual);
  if (!last) {
    // 已经退到没有"最近一次刷新"了：退过一次就是"只能退一步"，否则是"还没刷过"。
    throw Object.assign(new Error(undoUsed(individual) > 0
      ? '这一步已经退过了：一次只能退一步，再刷一次之后才能再退'
      : '没有可以回滚的刷新'), {code: undoUsed(individual) > 0 ? 'already-undone' : 'nothing-to-undo'});
  }
  if (!canUndo(individual)) {
    throw Object.assign(new Error('这一步已经退过了：一次只能退一步，再刷一次之后才能再退'), {code: 'already-undone'});
  }
  const next = clone(individual);
  const index = next.history.lastIndexOf(last);
  next.history.splice(index, 1);                       // 把那次刷新的记录拿掉（它已经被撤销）
  if (last.kind === 'nature') {
    next.nature = last.before ?? null;
  } else {
    next.talent = {...(last.before ?? {})};
    // 天分：那次加成要从账上删掉（`talent_boosts` 里 tier 等于这次的）
    next.talent_boosts = (next.talent_boosts ?? []).filter((row) => row.tier !== last.used);
  }
  // 次数**一个都不动**（人类口述：「不消耗也不返还」）——原来那行 `Math.min(LIMIT, +1)` 删掉了。
  // `undid` = **被撤掉的那个落点**（性格是那条性格名，天分是那一项）。
  // 下一次重刷要靠它说出"换掉了什么"（见 `refresh()` 的 `replaced` 与 `lastRefreshNote()`）。
  next.history.push({kind: 'undo', used: last.used, undo_of: last.kind,
    undid: last.kind === 'nature' ? (last.after ?? null) : (last.stat ?? null),
    before: last.after, after: last.kind === 'nature' ? next.nature : {...next.talent},
    remaining: next.refreshes[last.kind], rule: 'undo/v1', at});
  return next;
}

/**
 * 上一次刷新**落在哪**（一句话，给玩家看）—— 回滚之后重刷时，把"换掉了什么"也说出来。
 *
 * 为什么要有它：§C6.313 记的② —— `rollbackAdvice` 那句「回滚换一个落点**可能更值**」在
 * `refresh()` 把 `undone` 拼进种子之后**成立了**，但没人把"到底换到了哪一项"说出来。
 * 玩家在页面上点完刷新，只看到面板数字动了，得自己猜是哪一项变的。
 *
 * 返回 `null`（没刷过）或一句话：
 *   · 「上一次刷天分（第 2 级）：+10 加到「物攻」—— 这次是回滚之后重刷的，换掉了原来的「速度」。」
 *   · 「上一次刷性格：换成了「开朗」—— 这次是回滚之后重刷的，原来的「胆小」已经撤掉。」
 */
export function lastRefreshNote(individual, {labels = null} = {}) {
  const last = lastRefreshOf(individual);
  if (!last) return null;
  const statName = (stat) => labels?.[stat] ?? STAT_NAMES?.[stat] ?? stat;
  const reroll = (last.replaced === null || last.replaced === undefined)
    ? ''
    : last.kind === 'nature'
      // 不用 `**`：这两处落点（抽屉行、状态行）都是纯文本/`textContent`，星号会原样画出来。
      ? `—— 这次是回滚之后重刷的，原来的「${last.replaced}」已经撤掉。`
      : `—— 这次是回滚之后重刷的，换掉了原来的「${statName(last.replaced)}」。`;
  if (last.kind === 'nature') {
    return `上一次刷性格：换成了「${last.after ?? '（没填）'}」${reroll}`;
  }
  const stat = last.stat ?? (Array.isArray(individual.talent_boosts)
    ? individual.talent_boosts.find((row) => row.tier === last.used)?.stat ?? null : null);
  const label = stat ? statName(stat) : '（记录里没有这一项）';
  return `上一次刷天分（第 ${last.used} 级）：+${TALENT_STEP} 加到「${label}」${reroll}`;
}

/**
 * 「这次回滚值不值」——**给 coach 用的材料，不是结论**：
 * 把"撤掉的这一级加到了哪一项"与"你关心的方向"对上，说清值得/不值得的**理由**，
 * 但**不替玩家拍板**（拍板要看队伍与对手，那是回答层的事）。
 */
export function rollbackAdvice(individual, {priority = [], labels = null} = {}) {
  const last = lastRefreshOf(individual);
  if (!last) return {ok: false, reason: '没有可回滚的刷新', text: '这只还没有刷过，回滚没有对象。'};
  const name = (stat) => (labels?.[stat] ?? stat);
  if (last.kind === 'nature') {
    const before = last.before ?? '（没填）';
    const now = last.after ?? '（没填）';
    return {ok: true, kind: 'nature', worth: null,
      text: `上一次刷性格：从「${before}」换成了「${now}」。回滚就是换回「${before}」` +
        '（只退这一步，退掉的这次刷新**不会**还给你）——'
        + '哪个更合适要看你要它干什么（抢速度、扛伤害、还是打输出），我不替你拍板。'};
  }
  const boosted = Array.isArray(individual.talent_boosts) ? individual.talent_boosts : [];
  const row = boosted.find((item) => item.tier === last.used) ?? null;
  const stat = row?.stat ?? null;
  const hit = stat ? priority.includes(stat) : false;
  const label = stat ? name(stat) : '（记录里没有这一项）';
  const tail = priority.length
    ? (hit ? `这次加到的正是你在意的「${label}」⇒ 回滚会把这一级浪费掉，**不太值得**。`
      : `这次加到的「${label}」不在你在意的方向里 ⇒ 回滚换一个落点**可能更值**。`)
    : `这次加到的是「${label}」；你没说要什么方向，所以值不值得由你定。`;
  return {ok: true, kind: 'talent', stat, worth: priority.length ? !hit : null,
    text: `上一次刷天分（第 ${last.used} 级）：+${TALENT_STEP} 加到「${label}」。${tail}`};
}

