// 天分（个体值）与性格：**规则与面板换算的唯一一份**。
//
// 为什么单独一个模块：这两个系统是「游戏里真实存在的数值」那一类，红线是
// **数字只能来自数据层**、缺的必须如实标 unknown。所以这里只做两件事：
//   ① 把规则读进来（`data/roco/systems/natures.json`，逐条带出处）；
//   ② 按来源里写的公式算面板，并把"这一步用的是哪条来源、哪些输入缺了"一起返回。
// 这个模块**不猜**：输入缺一个，对应的输出就是 null + `unknown` 里记一条原因。
// 浏览器安全：规则数据由 `scripts/roco/sync-browser-data.mjs` 从
// `data/roco/systems/natures.json` 生成成常量模块（**不许在这里 import node:fs**，
// 否则浏览器模块图会静默断链 —— 判据 `tests/evals/structure-contract.test.js` 钉着）。
import {NATURES, NATURES_MODIFIER, NATURES_STAT_NAMES, NATURES_STAT_ORDER} from './natures-data.js';

export const STAT_KEYS = NATURES_STAT_ORDER;
export const STAT_NAMES = NATURES_STAT_NAMES;

let cached = null;
/** 读一次、缓存一份。表坏了就抛（缺数据的静默降级会让上层拿着空表算出一堆 0）。 */
export function naturesData() {
  if (cached) return cached;
  const problems = validateNatures(NATURES);
  if (problems.length) throw new Error(`性格表坏了：${problems.slice(0, 4).join('；')}`);
  cached = {modifier: NATURES_MODIFIER, natures: NATURES, stat_order: NATURES_STAT_ORDER,
    stat_names: NATURES_STAT_NAMES};
  return cached;
}

export function natures() { return naturesData().natures; }

/**
 * 校验一张性格表（纯函数，便于**用改坏的副本做反证**：判据不是空的）。
 * 返回问题清单，空数组 = 通过。规则来自图片本身的结构：30 条 = 6 个上项 × 5 个下项。
 */
export function validateNatures(rows) {
  const problems = [];
  if (!Array.isArray(rows) || rows.length !== 30) return [`必须是 30 条（实际 ${rows?.length}）`];
  const ids = new Set(); const names = new Set(); const pairs = new Set();
  for (const row of rows) {
    if (!Number.isInteger(row?.id)) problems.push(`编号不是整数：${JSON.stringify(row)}`);
    if (ids.has(row.id)) problems.push(`编号重复：${row.id}`);
    ids.add(row.id);
    if (names.has(row.name)) problems.push(`性格名重复：${row.name}`);
    names.add(row.name);
    if (!STAT_KEYS.includes(row.up)) problems.push(`${row.name} 的上项不合法：${row.up}`);
    if (!STAT_KEYS.includes(row.down)) problems.push(`${row.name} 的下项不合法：${row.down}`);
    if (row.up === row.down) problems.push(`${row.name} 的上项和下项是同一项（${row.up}）`);
    const key = `${row.up}>${row.down}`;
    if (pairs.has(key)) problems.push(`这一组上下项重复：${key}`);
    pairs.add(key);
  }
  // 完备性：六项两两组合一共 30 组，一条不多一条不少
  const all = new Set();
  for (const up of STAT_KEYS) for (const down of STAT_KEYS) if (up !== down) all.add(`${up}>${down}`);
  for (const key of all) if (!pairs.has(key)) problems.push(`缺这一组：${key}`);
  for (const key of pairs) if (!all.has(key)) problems.push(`多出这一组：${key}`);
  return problems;
}

export function natureOf(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  return natures().find((row) => row.name === name.trim()) ?? null;
}

/**
 * 性格对某一项的系数。**未知性格一律返回 1（中性）并把这件事记在 `unknown` 里** ——
 * 不许把"没填性格"当成"性格是加这一项的"（那是编数据的一种）。
 */
export function natureFactor(name, stat) {
  const row = natureOf(name);
  if (!row) return {factor: 1, known: false, reason: name ? `认不出性格「${name}」` : '这一只还没填性格'};
  if (!STAT_KEYS.includes(stat)) throw new Error(`没有这一项：${stat}`);
  const {up, down, neutral} = naturesData().modifier;
  if (row.up === stat) return {factor: 1 + up, known: true, reason: `${row.name}：${STAT_NAMES[stat]}是长处（+${Math.round(up * 100)}%）`};
  if (row.down === stat) return {factor: 1 + down, known: true, reason: `${row.name}：${STAT_NAMES[stat]}是短处（${Math.round(down * 100)}%）`};
  return {factor: neutral, known: true, reason: `${row.name}：${STAT_NAMES[stat]}不受影响`};
}

/**
 * **非 PVP 那一档**的性格系数**下界**（2026-09-27 人类口述 + 台账引文推出的那一条）。
 *
 * 人类 2026-09-27 贴的评论里两句看似矛盾的话 —— 「增加幅度从 10% 提到 20%」与「性格都是一项 +10%、
 * 一项 −10%」—— 按台账 `EV-NATURE-BALANCE-PVP`（OFFICIAL_CURRENT，逐字）可以**同时为真**：
 *   · PVP（闪耀大赛）把加成平衡到 **+20%**，负面固定 **−10%**；
 *   · 非 PVP：提升 **初始 +10%**，**每突破一次 +2%**，满突破 **+20%**；降低固定 −10%。
 * 所以"±10%"是**非 PVP 零突破**那一档，不是与 PVP 冲突。
 *
 * ⚠ 我们**没有"每只的突破次数"这个数据** ⇒ 这一层只能给**零突破下界**（1.1 / 0.9），
 * 并且**必须标成下界**（`floor: true`）——不许把它当成"这一只的实际加成"。
 */
export const NATURE_PVE_FLOOR = Object.freeze({up: 0.1, down: -0.1, perBreakthrough: 0.02, cap: 0.2,
  source: 'EV-NATURE-BALANCE-PVP（data/roco/evidence/rule-evidence-ledger.json）逐字：'
    + '「提升初始 +10%，每突破一次 +2%，满突破 +20%；降低固定 −10%」+ 人类 2026-09-27 口述',
  note: '零突破下界；每突破 +2%、满 +20% —— 我们没有突破次数，所以只给下界'});

/** 非 PVP 档的**下界**系数（`floor: true` 提醒调用方"这是下界不是实测"）。 */
export function natureFloorFactor(name, stat) {
  const row = natureOf(name);
  if (!row) return {factor: 1, known: false, floor: true, reason: name ? `认不出性格「${name}」` : '这一只还没填性格'};
  if (!STAT_KEYS.includes(stat)) throw new Error(`没有这一项：${stat}`);
  const up = 1 + NATURE_PVE_FLOOR.up;
  const down = 1 + NATURE_PVE_FLOOR.down;
  if (row.up === stat) {
    return {factor: up, known: true, floor: true,
      reason: `${row.name}：${STAT_NAMES[stat]}是长处（非 PVP 零突破下界 +${Math.round(NATURE_PVE_FLOOR.up * 100)}%，`
        + `每突破 +${Math.round(NATURE_PVE_FLOOR.perBreakthrough * 100)}%、满突破 +${Math.round(NATURE_PVE_FLOOR.cap * 100)}%）`};
  }
  if (row.down === stat) {
    return {factor: down, known: true, floor: true,
      reason: `${row.name}：${STAT_NAMES[stat]}是短处（${Math.round(NATURE_PVE_FLOOR.down * 100)}%，非 PVP 档也是这个数）`};
  }
  return {factor: 1, known: true, floor: true, reason: `${row.name}：${STAT_NAMES[stat]}不受影响`};
}

// ── 面板换算 ────────────────────────────────────────────────────────────────
//
// 来源：桌面笔记 `~/Desktop/洛克王国PVP规则、战术、策略、技巧小黑盒帖子简单收集.md` 的 pvp 公式一节，逐字：
//   生命 =（1.7*种族值 + 个体值*0.85 + 70）*性格加成（0.9，1，1.2）+100
//   其他 =（1.1*种族值 + 个体值*0.55 + 10）*性格加成（0.9，1，1.2）+50
//
// ⚠ **一处未解决的冲突，必须一起读**：同一份笔记的另一处写「个体值 pvp 中自动乘六倍，
// 7-8-9-10 分别会在战斗中增加 42-48-54-60 的面板值」——按上式，个体值 10 对生命只加 8.5，
// 对别项只加 5.5，**对不上 60**。所以 `TALENT_PVP_STEP` 只作为"待核对的另一条口径"存在，
// 面板换算**只用公式那条**；两者之间的关系在被证实前不许合并（判据里钉着这个冲突必须还在）。
export const PANEL_FORMULA = {
  hp: {race: 1.7, talent: 0.85, base: 70, add: 100},
  other: {race: 1.1, talent: 0.55, base: 10, add: 50},
  source: '~/Desktop/洛克王国PVP规则、战术、策略、技巧小黑盒帖子简单收集.md §pvp公式',
  confidence: 'COMMUNITY_CURRENT（笔记逐字抄的 pvp 公式，非官方文本）',
};
export const TALENT_PVP_STEP = {
  perPoint: 6,
  table: {7: 42, 8: 48, 9: 54, 10: 60},
  source: '小黑盒帖子（桌面笔记逐字）：「个体值 pvp 中自动乘六倍，7-8-9-10 分别会在战斗中增加 42-48-54-60 的面板值」',
  // 2026-09-26 外部查证（人类：「你冲突自己查资料呀」）：
  //   TapTap 二测攻略 https://www.taptap.cn/moment/655419543417521467：「资质 = 种族值（白条）+ 天分值（黄条）……
  //   天分值一级的时候单一属性最高为 10，随着突破会往上增加」，并指出**另有隐藏个体值**（同种族间随机、影响成长）。
  //   也就是说"个体值"这个词在这份笔记里指的很可能是**天分值**（0–10 那一档），
  //   而公式里那个 ×0.85/×0.55 的系数与"每点 +6"对不上 —— 两条**仍然是两套口径**，但有了新的外部支持：
  //   「一级单一属性最高 10」与 7/8/9/10 → 42/48/54/60 的取值域吻合（都是 0–10 档）。
  // 于是本仓现在的默认取**每点 +6（PVP）**这一套：它自洽（7→42 … 10→60 逐点线性），
  // 而公式那套（0.85/0.55）**保留**在 PANEL_FORMULA 里作为"升级成长口径"，两条都带出处、都能算，界面上可并列。
  external_support: 'TapTap 二测攻略（资质=种族值+天分；天分一级单项最高 10；另有隐藏个体值）',
  decision: 'PVP 面板默认用"每点 +6"；升级/成长口径仍用 PANEL_FORMULA（0.85/0.55）。两条都留，不互相覆盖。',
};
export const TALENT_RANGE = {min: 0, max: 10, note: '六项各自 0–10；「了不起天分」= 六项资质里随机三项加 7–10（笔记 §精灵性格与资质）'};

/**
 * 算面板。`race` 是种族值（归一化图鉴 full-catalog.json 里每只的 stats），
 * `talent` 是个体值（天分，缺省 0 并标注），`nature` 是性格名。
 *
 * 返回 `{panel, unknown[], sources[]}`：
 *   · 算得出的项进 `panel`；算不出的项**不出现**（不是 0）—— 0 会被下游当成真值；
 *   · `unknown` 逐条写清缺什么（种族值缺 / 天分没填 / 性格没填）；
 *   · `sources` 是这一次实际用到的来源，供答案层交代出处。
 */
/**
 * **PVP 面板**：种族值那部分走 `PANEL_FORMULA`，天分那部分走"每点 +6"（`TALENT_PVP_STEP`）。
 *
 * 为什么这样拼：两条口径各自的自洽域不同 —— 公式那条含性格系数（0.9/1/1.2，与 PVP 的 ±20/10% 吻和）
 * 但天分系数只有 0.85/0.55；而"每点 +6"那条在 7/8/9/10 上逐点线性、且与「一级单项最高 10」的取值域吻合。
 * 所以：**性格与种族值按公式，天分按 +6**，并把两条都写进 `sources` 让人能核。
 */
export function pvpPanelOf({race = null, talent = null, nature = null} = {}) {
  const base = panelOf({race, talent: null, nature, scope: 'pvp'});
  if (!Object.keys(base.panel).length) return base;
  const panel = {...base.panel};
  const unknown = [...base.unknown.filter((row) => !row.includes('还没填天分'))];
  for (const stat of STAT_KEYS) {
    const value = Number(talent?.[stat]);
    if (!Number.isFinite(value) || value <= 0) continue;
    panel[stat] = (panel[stat] ?? 0) + value * TALENT_PVP_STEP.perPoint;
    if (value > 10) unknown.push(`${STAT_NAMES[stat]} 的天分值 ${value} 超过"一级单项最高 10"（外部攻略口径）`);
  }
  return {panel, unknown: [...new Set(unknown)],
    sources: [...base.sources, TALENT_PVP_STEP.source]};
}

export function panelOf({race = null, talent = null, nature = null, scope = 'pvp'} = {}) {
  const unknown = [];
  const sources = [PANEL_FORMULA.source];
  if (scope !== 'pvp') {
    // 非 PVP 档的性格加成随突破次数走，本仓没有突破数据 ⇒ 只给公式那一半，性格按 unknown。
    unknown.push('非 PVP 档的性格加成要看突破次数（每突破 +2%），本仓没有这个数据 ⇒ 这一档只给中性面板');
  }
  if (!race || typeof race !== 'object') {
    return {panel: {}, unknown: [...unknown, '没有种族值 ⇒ 面板算不出来（不拿 0 顶）'], sources};
  }
  if (!talent || typeof talent !== 'object') {
    unknown.push('这一只还没填天分（个体值）⇒ 按 0 计入，面板偏低，别当成实测值');
  }
  const panel = {};
  // ⚠ `Number(null) === 0`、`Number('') === 0` —— 直接 Number() 会把"没这一项"当成 0
  // （判据 ⑤ 当场抓到：种族值写 null 的那一项被算成了 0 分面板）。所以先过这一个闸。
  const numOrNull = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  for (const stat of STAT_KEYS) {
    const raceValue = numOrNull(race[stat]);
    if (raceValue === null) { unknown.push(`种族值缺「${STAT_NAMES[stat]}」⇒ 这一项不算`); continue; }
    const talentValue = numOrNull(talent?.[stat]) ?? 0;
    const shape = stat === 'hp' ? PANEL_FORMULA.hp : PANEL_FORMULA.other;
    const nf = scope === 'pvp' ? natureFactor(nature, stat) : {factor: 1, known: false, reason: '非 PVP 档性格加成未知'};
    if (!nf.known) unknown.push(`性格：${nf.reason}`);
    const raw = (shape.race * raceValue + shape.talent * talentValue + shape.base) * nf.factor + shape.add;
    panel[stat] = Math.round(raw);
  }
  return {panel, unknown: [...new Set(unknown)], sources};
}

/**
 * 「这一只该用什么性格」的**候选**：不替玩家拍板，只把每种性格对这套种族值+天分的
 * 实际影响算出来排序（**排序依据是数值差，不是我们的偏好**）。
 * 用于答案层讲取舍（防止纯机器算：教练要说的是"为什么"，排序只是材料）。
 */
export function natureCandidates({race, talent, stats = ['spe', 'atk'], limit = 6} = {}) {
  const rows = [];
  for (const nature of natures().map((row) => row.name)) {
    const {panel} = panelOf({race, talent, nature});
    rows.push({nature, panel, score: stats.reduce((sum, stat) => sum + (panel[stat] ?? 0), 0)});
  }
  rows.sort((a, b) => b.score - a.score || a.nature.localeCompare(b.nature, 'zh'));
  return rows.slice(0, limit);
}
