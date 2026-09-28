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
 *
 * ⚠ 2026-09-27 **改钉**：长处这一侧不再写死 +20%，而是按**突破次数**算：
 *   提升初始 **+10%**，每突破一次 **+2%**，满突破 **+20%**；降低**固定 −10%**。
 *   人类当天的口径正是这个（「一个加 10%，一个减 10%，可不变化幅度就是 20%？」），
 *   台账 `EV-NATURE-BALANCE-PVP` 与反编译注释（`UMG_PetCharacter_PopUp_C._lua:103-104`）逐字一致。
 * `breakthrough` 缺省 **0**（我们没有"每只的突破次数"这个数据 ⇒ 给下界，不许猜）。
 * PVP（闪耀大赛）归一化到**满突破**，调用方传 `breakthrough: 5`（见 `pvpPanelOf`）。
 */
export const NATURE_BREAKTHROUGH = Object.freeze({max: 5, levels: [20, 30, 40, 50, 60],
  source: '游戏导出配置表 BREAK_NUMBER_CONF 的 require_level=20/30/40/50/60 + 反编译注释逐字'
    + '「提升初始 +10%，每突破一次 +2%，满突破 +20%；降低固定 −10%」',
  note: '突破＝星级，同一根 0→5 轴；每次突破还抬等级上限与天分上限（那两层本仓未建）'});

export function natureFactor(name, stat, {breakthrough = 0} = {}) {
  const row = natureOf(name);
  if (!row) return {factor: 1, known: false, reason: name ? `认不出性格「${name}」` : '这一只还没填性格'};
  if (!STAT_KEYS.includes(stat)) throw new Error(`没有这一项：${stat}`);
  const steps = Math.max(0, Math.min(NATURE_BREAKTHROUGH.max, Math.trunc(breakthrough) || 0));
  const up = Math.min(NATURE_PVE_FLOOR.up + NATURE_PVE_FLOOR.perBreakthrough * steps,
    NATURE_PVE_FLOOR.cap);
  const {down, neutral} = naturesData().modifier;
  if (row.up === stat) {
    return {factor: 1 + up, known: true, breakthrough: steps,
      reason: `${row.name}：${STAT_NAMES[stat]}是长处（+${Math.round(up * 100)}%`
        + `${steps ? `，已算 ${steps} 次突破` : '，零突破'}）`};
  }
  if (row.down === stat) {
    // 减益**固定**：随成长上升的只有增益那一侧（这条是本次查证最硬的一条）。
    return {factor: 1 + down, known: true, breakthrough: steps,
      reason: `${row.name}：${STAT_NAMES[stat]}是短处（${Math.round(down * 100)}%，不随突破变化）`};
  }
  return {factor: neutral, known: true, breakthrough: steps, reason: `${row.name}：${STAT_NAMES[stat]}不受影响`};
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
/**
 * **等级公式**（2026-09-27 从游戏导出配置表拿到的那一条）。
 *
 * 来源（两条互相印证）：
 *   · `DATAMINE`：配置表 `ATTR_GLOBAL_CONFIG` —— 非生命 `race_constant=100`、`talent_constant=50`、
 *     `race_add_level=50`；生命 `race_constant=200`、`talent_constant=100`、`race_add_level=25`；
 *   · 官方公众号《洛个明白》逐字「精灵最高能升到 **60 级** 哦~但精灵的等级上限会被魔法等级限制」。
 *
 * 两条公式（L = 等级，个体值按 **0–10** 的 UI 刻度直接代入，内部 ×6 是单位换算不是额外加成）：
 *   其他(L) = round( (round((种族值 + 3×个体值) × (L + 50) / 100) + 10) × 性格 ) + 50
 *   生命(L) = round( (round((种族值 + 3×个体值) × (L + 25) / 50) + 70) × 性格 ) + 100
 *
 * **L=60 时它会退化成社区那两行 PVP 公式**（`(60+50)/100 = 1.1`、`(60+25)/50 = 1.7`）——
 * 这就是"公式里的 1.1 是 60 级的指纹"那句话的意思，`tests/roco-talent-nature.test.js` 钉着这个等价。
 *
 * ⚠ **取整顺序敏感**：先 round 内层、再加 10/70、再乘性格、再 round、最后 +50/+100。
 * 判例：噼啪鸟（速度种族值 145）必须这样算才得 **294**，换个顺序得 293。
 *
 * **实测校验（用我们自己的抓包数据算，不是抄别人的结论）**：wiki「PVP 一速榜」公布的
 * 火神 273 / 落陨星兔 273 / 圣羽翼王 267 / 彩蝶鲨 267 / 电企鹅 267 / 神谕鲨 267 /
 * 音速犬 260 / 黑羽夫人 260 / 噼啪鸟 294 —— **9/9 全中**（满级 60、满突破性格 1.2、个体值 10、+50）。
 */
export const LEVEL_FORMULA = Object.freeze({
  cap: 60,
  // ⚠ 两条的 `race`/`talent` 系数是**同一个** (1 / 3)：等级项在括号内，随等级放大。
  // 区别只在括号外：生命 (L+25)/50 + 70 + 100，其他 (L+50)/100 + 10 + 50。
  // 曾经把生命的 race/talent 写成 2/6（把"每级增量是别人的两倍"错当成"括号内系数两倍"）——
  // 那会让 120 种族值的生命在 60 级算出 622（正确是 425）。判据里钉着这条。
  hp: {race: 1, talent: 3, level: 25, base: 70, add: 100, divisor: 50},
  other: {race: 1, talent: 3, level: 50, base: 10, add: 50, divisor: 100},
  default_level: 60,
  source: '游戏导出配置表 ATTR_GLOBAL_CONFIG（经 rocom.aoe.top 托管）+ 官方公众号《洛个明白》「最高 60 级」',
  confidence: 'DATAMINE + OFFICIAL（等级上限官号逐字；系数来自配置表，且 L=60 退化式与社区实测 9/9 吻合）',
  constants_note: '末尾的 +50/+100 与配置表 GROW_LEVEL_CONF（成长等级满 50 级：生命 +100、其它每项 +50）'
    + '逐值相等 —— 两种读法（"PVP 归一化的努力值 50" vs "成长等级满级加成"）都能对上这一项，见台账冲突清单。',
});

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
  decision: '2026-09-27 查证后**改钉**：面板换算只用等级公式（`LEVEL_FORMULA`，天分在括号内按 +3×资质）。'
    + '「每点 +6」与前述公式**冲突**（它解释不了 PVP 一速榜 9/9 的实测），因此**不再参与任何面板换算**；'
    + '这条记录只作为历史口径保留（改钉不删），出处见 external_support。',
  resolved_by: '2026-09-27 外部查证：配置表 ATTR_GLOBAL_CONFIG 的 talent_constant 在括号内（1/3），'
    + '笔记里的「×6」是 UI 0–10 → 内部 0–60 的**单位换算**，不是 PVP 额外加成；'
    + '9/9 实测（`tests/roco-panel-level.test.js` ①）只支持等级公式那一条。',
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
 * **PVP 面板**＝满级 60 + 满突破那一条（闪耀大赛把练度拉平的那一档）。
 *
 * ⚠ 2026-09-27 **改钉，这一条以前是错的**：旧实现是「种族值/性格按老公式 + 天分**另加**每点 +6」，
 * 而天分在公式里**已经在括号内**（`+3×个体值`）⇒ 那一版把天分算了两遍（10 点天分在速度上会多算 60）。
 * 现在直接落到等级公式的 L=60 分支上；`TALENT_PVP_STEP`（每点 +6）作为**已登记的另一条口径**保留，
 * 但**不再参与面板换算** —— 它解释不了 9/9 的实测（见 `LEVEL_FORMULA` 的校验说明）。
 */
export function pvpPanelOf({race = null, talent = null, nature = null, breakthrough = null} = {}) {
  // PVP 归一化那一档的**定义**就是满级 + 满突破（实测 9/9 要求性格系数 1.2）——
  // 所以这里显式给满突破，而不是靠 `panelOf` 的缺省。
  return panelOf({race, talent, nature, scope: 'pvp', level: LEVEL_FORMULA.cap,
    breakthrough: Number.isInteger(breakthrough) ? breakthrough : NATURE_BREAKTHROUGH.max});
}

export function panelOf({race = null, talent = null, nature = null, scope = 'pvp',
  level = LEVEL_FORMULA.default_level, breakthrough = null} = {}) {
  const unknown = [];
  const sources = [LEVEL_FORMULA.source, NATURE_BREAKTHROUGH.source];
  // 突破次数：调用方给了就按它算；没给 ⇒ PVP 归一化档按**满突破 5**（闪耀大赛把练度拉平，
  // 性格修正 1.2 是那一档的实测值），其他档按 **0**（我们没有每只的突破次数，只给下界并标注）。
  // ⚠ 缺省**永远是零突破下界**（我们没有"每只的突破次数"这个数据）：PVP 归一化那一档
  // 由 `pvpPanelOf` 显式传满突破 5（那是它的定义），`panelOf` 自己不替玩家假设练度。
  const steps = Number.isInteger(breakthrough) ? Math.max(0, Math.min(NATURE_BREAKTHROUGH.max, breakthrough)) : 0;
  if (!Number.isInteger(breakthrough)) {
    unknown.push('不知道这只突破到第几段 ⇒ 性格增益按**零突破下界**算（初始 +10%、每突破 +2%、满 +20%）');
  }
  if (!Number.isFinite(level) || level < 1 || level > LEVEL_FORMULA.cap) {
    unknown.push(`等级 ${level} 不在 1–${LEVEL_FORMULA.cap} 之内 ⇒ 这一份面板不算（等级上限 60 是官方口径）`);
    return {panel: {}, unknown, sources};
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
    const shape = stat === 'hp' ? LEVEL_FORMULA.hp : LEVEL_FORMULA.other;
    const nf = natureFactor(nature, stat, {breakthrough: steps});
    if (!nf.known) unknown.push(`性格：${nf.reason}`);
    // 取整顺序**照判例来**：先 round 内层 → 加常数 → 乘性格 → round → 加末尾常数。
    const scaled = (shape.race * raceValue + shape.talent * talentValue) * (level + shape.level) / shape.divisor;
    panel[stat] = Math.round((Math.round(scaled) + shape.base) * nf.factor) + shape.add;
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
