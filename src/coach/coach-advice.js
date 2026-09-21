// 主动提示的**局面化**文案层（新文件；页面还没接，见 docs/roco/COACH-ADVICE-DESIGN.md）。
//
// 为什么要有这一层
// ----------------
// 现在的 `rocoHintText(plan)` 只拿得到**规划结果**，看不到局面，于是所有「这一手不稳」
// 的回合都会说出同一句话（「…先看区间再定（最坏尾部 …）」）。玩家实测反馈就是
// 「反复只说…（最坏尾部…）」，而且那句话不是决策，是工程产物。
//
// 这一层反过来做，三条纪律写在代码里：
//   ① 触发条件是**局面事实**：血量、能量、速度、异常、后备、上一手打出的属性倍率；
//   ② 规划结果只用来**补充证据**（收线估算、对手主应对），它不单独触发说话
//      ——「引擎推荐 X」不是一句值得打断玩家的提示；
//   ③ 没有任何一条局面事实值得说 → 返回 null。**允许沉默**，不硬凑一句话。
//
// 纯函数、零依赖：这个文件可能被并进浏览器模块图，所以不 import `node:*`，
// 不 import `src/client/*`，不用 TS/JSX。所有事实只从**公开视图**（`rocoGameView`
// 投影出来的那份，或它保留下来的 `roco` 原始公开视图）里读。
//
// 不可协商的措辞纪律（tests/evals/coach-advice.test.js 钉着）：
//   · 玩家句子里不出现工程词：区间 / 尾部 / margin / score / 种子 / coverage /
//     state_version / worst / { }；
//   · 不说胜率、不说「最优」、不说「一定能赢」；
//   · 伤害一律带「估」——引擎自己的伤害公式就标着 `formula_verified: false`。

// ── 常量：哪些是游戏规则、哪些是产品阈值 ──────────────────────────────────
//
// 这一节是刻意分开的。**游戏规则**从引擎里抄，标注出处；**产品阈值**是本节自己选的
// 口径，只是「什么时候值得开口」，不是「游戏是怎么算的」。把两者混在一起写，
// 后面的人就分不清哪个数字可以改、哪个改了就是编规则。

/**
 * 回合末会持续掉血的状态。
 *
 * 出处：`roco/src/roco_env/effects.py` 的 `END_OF_TURN_STATUS`（键是中文名，
 * 引擎写进 `statuses` 的就是这几个键）。这不是阈值，是引擎实现的状态集合；
 * 引擎加了新状态就要同步这里，否则本层会**少说**（不会说错）。
 */
const TICKING_STATUSES = Object.freeze(['中毒', '灼烧', '寄生']);

/** 旧写法（英文键）→ 引擎实际写进 `statuses` 的中文键。只做显示归一，不猜机制。 */
const STATUS_ALIAS = Object.freeze({
  burn: '灼烧', poison: '中毒', paralysis: '麻痹', freeze: '冰冻',
  sleep: '睡眠', confusion: '混乱', seal: '封印',
});

/**
 * 「血少了」的**产品阈值**：0.35。
 *
 * 为什么是它：页面自己就用 0.35 决定血条变红（`src/client/roco.js` 的 `hpClass`），
 * 经验层的 `observe()` 也用 `hp <= maxHp * 0.35`（`src/coach/experience.js`）。
 * 本层沿用同一个口径，玩家看到的红血条和这句提示才是同一个判断。**不是游戏规则。**
 */
const LOW_HP_RATIO = 0.35;

/**
 * 「后备这只还健康」的**产品阈值**：0.6。
 *
 * 为什么是它：换人建议只有在这种情况下才站得住——后备明显比场上这只厚。
 * 取 0.6 而不是 0.35，是为了让「换上去」与「别换」之间有明确的空隙，
 * 避免在两边都不确定时硬给一个换人建议。**不是游戏规则。**
 */
const HEALTHY_HP_RATIO = 0.6;

/**
 * 「对面残血、这一轮值得补刀」的**产品阈值**：0.1。
 *
 * 它**不**声称「这一下一定收得掉」——那需要伤害公式，而公式是未核验的
 * （`damage_preview` 能算的时候由 `ko-now` / `ko-maybe` 说，那两条才是收线判断）。
 * 这条只说立场：对面血条已经短到「这一轮优先兑现」的程度。
 * 取 0.1 而不是页面的红血线 0.35，是因为 0.35 的一只还可能要两下才倒。**不是游戏规则。**
 */
const FOE_FINISH_RATIO = 0.1;

/**
 * 「对面能量快满了」的**产品阈值**：5。
 *
 * 依据：引擎 `ENERGY_MAX = 6`（`roco/src/roco_env/env.py`），每回合回 1 点，
 * `能量果` 一次给 4 点（同文件 `ITEM_EFFECTS`）。到 5 就意味着对面**当下**
 * 放得出几乎任何一招（配招里最贵的那几招能耗 3—5）。这是一个档位判断，
 * 没有官方「高能量」定义，所以它是产品阈值。**不是游戏规则。**
 */
const FOE_ENERGY_ALERT = 5;

/** 引擎的能量上限，只用来在证据里说明「离满还差多少」。 */
const ENERGY_MAX = 6;

// ── 小工具 ────────────────────────────────────────────────────────────────

const isObj = (v) => Boolean(v) && typeof v === 'object';

/** 只认有限数字；其余（null/undefined/NaN/字符串/对象）一律当作**未知**。 */
function num(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function str(value) {
  return typeof value === 'string' && value ? value : null;
}

/**
 * 数字写成玩家读得懂的样子：整数不带小数点。
 * 只用于**显示**，不用于判断——判断一律走原始数值。
 */
function show(value) {
  const v = num(value);
  if (v === null) return '—';
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}

/** `「名字」`；名字未知时用一个不含工程标识的说法。 */
function ref(name) {
  return typeof name === 'string' && name ? `「${name}」` : '场上这只';
}

/** 估算伤害的写法：上下界一样时写一个数，别写成 `469~469` 这种假区间。 */
function estimateText(min, max) {
  const low = num(min);
  const high = num(max);
  if (low === null) return show(high);
  if (high === null || low === high) return show(low);
  return `${show(low)}~${show(high)}`;
}

/** 归一化：把数字段换成 `#`，用来做「句子是否只是换了数字」的重复检测。 */
export function normaliseAdviceShape(text) {
  return String(text ?? '').replace(/\d+/g, '#');
}

// ── 局面读取：只搬公开字段 ────────────────────────────────────────────────
//
// `game` 可能是两形状之一：
//   · `rocoGameView` 的投影（`player.pets[].hp/maxHp`、`enemy.pets[0]` 是场上那只）；
//   · 投影里保留的原始公开视图 `game.roco`（`self.pets[].max_hp`、`opponent.field`）。
// 投影带血量口径，原始视图带名字/系别/六维/合法动作/事件，所以**两边合起来读**。
// 缺哪边就把那部分当未知（未知的检测器不开口），绝不补一个看起来合理的默认值。

/** 状态表归一：中文键原样留，英文键映射成中文键；层数只认数字。 */
function statusMap(raw) {
  if (!isObj(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = STATUS_ALIAS[key] ?? key;
    const layers = num(value?.layers);
    out[name] = layers === null ? {} : {layers};
  }
  return out;
}

/** 把「投影里的一只」与「原始视图里同一位置的一只」合成一只可读的伙伴。 */
function mergePet(projected, raw) {
  const p = isObj(projected) ? projected : {};
  const r = isObj(raw) ? raw : {};
  return {
    name: str(r.name) ?? str(p.name) ?? str(p.id),
    types: Array.isArray(r.types) ? r.types.slice() : [],
    spe: num(r.stats?.spe),
    hp: num(p.hp) ?? num(r.hp),
    maxHp: num(p.maxHp) ?? num(r.max_hp),
    energy: num(p.energy) ?? num(r.energy),
    fainted: (p.fainted ?? r.fainted) === true,
    statuses: statusMap(isObj(r.statuses) ? r.statuses : p.status),
    slot: num(r.slot) ?? num(p.slot),
  };
}

/** 血比：读不出来就是 null（**不要**当成 0 或 1）。 */
function hpRatio(pet) {
  if (!pet) return null;
  const {hp, maxHp} = pet;
  if (hp === null || maxHp === null || maxHp <= 0) return null;
  return Math.max(0, Math.min(1, hp / maxHp));
}

/** 合法动作归一。技能名可能只在 `label` 上（换人/道具就没有 `skill`）。 */
function readAction(action) {
  if (!isObj(action)) return null;
  const skill = isObj(action.skill) ? action.skill : null;
  const kind = str(action.kind);
  const label = str(action.label);
  return {
    kind,
    label,
    skillId: str(action.skill_id),
    name: str(skill?.name) ?? (kind === 'skill' ? label : null),
    element: str(skill?.element),
    energy: num(skill?.energy),
    power: num(skill?.power),
    targetIndex: num(action.target_index),
    itemId: str(action.item_id),
  };
}

/**
 * `self.skills` 的一行。
 *
 * 两种形状都认：Python UI 视图里技能说明嵌在 `skill` 下，而 Node 的 `publicView`
 * 已经把它摊平成 `{skill_id, name, energy, …}`。少认一种的后果不是报错，
 * 而是**安静地拿不到能耗**、于是「能量不够」那条检测器永远不开口。
 */
function readSkillRow(row) {
  if (!isObj(row)) return null;
  const nested = isObj(row.skill) ? row.skill : null;
  const name = str(row.name) ?? str(nested?.name);
  if (!name) return null;
  return {
    skillId: str(row.skill_id),
    name,
    element: str(row.element) ?? str(nested?.element),
    energy: num(row.energy) ?? num(nested?.energy),
    power: num(row.power) ?? num(nested?.power),
  };
}

/**
 * 公开视图 → 本层认可的局面。
 *
 * 返回 null 表示「这不是一个还能给建议的局面」（没有视图 / 已经打完）。
 */
function readPosition(game) {
  if (!isObj(game)) return null;
  // 两种形状都认：
  //   ① `rocoGameView(view)` 的投影（`player.pets` / `enemy.pets`，`.roco` 是原始公开视图）；
  //   ② 直接递进来的公开视图本身（顶层就是 `self` / `opponent`）。
  // 认第二种是为了接入时不至于因为「传的是哪一个」而**安静地沉默**——那种失败最难查。
  const raw = isObj(game.roco) ? game.roco
    : (isObj(game.self) || isObj(game.opponent) ? game : null);
  const rawSelf = isObj(raw) ? raw.self : null;
  const rawFoe = isObj(raw) ? raw.opponent : null;
  const projectedMine = Array.isArray(game.player?.pets) ? game.player.pets : [];
  const projectedFoe = Array.isArray(game.enemy?.pets) ? game.enemy.pets : [];
  const rawMine = Array.isArray(rawSelf?.pets) ? rawSelf.pets : [];
  const rawFoeField = isObj(rawFoe?.field) ? rawFoe.field : null;
  const rawFoeBench = Array.isArray(rawFoe?.bench) ? rawFoe.bench : [];

  const myPets = [];
  const mineCount = Math.max(projectedMine.length, rawMine.length);
  for (let i = 0; i < mineCount; i += 1) myPets.push(mergePet(projectedMine[i], rawMine[i]));
  // 投影里 `enemy.pets[0]` 是对手**场上**那只，其余是后备（只有位次与是否倒下）。
  const foePets = [];
  const foeCount = Math.max(projectedFoe.length, rawFoeBench.length + (rawFoeField ? 1 : 0));
  for (let i = 0; i < foeCount; i += 1) {
    const rawEntry = i === 0 ? rawFoeField : rawFoeBench[i - 1];
    foePets.push(mergePet(projectedFoe[i], rawEntry));
  }

  const activeIndex = num(game.player?.active) ?? num(rawSelf?.active) ?? 0;
  const legal = (Array.isArray(raw?.legal) ? raw.legal : []).map(readAction).filter(Boolean);
  const skills = (Array.isArray(rawSelf?.skills) ? rawSelf.skills : []).map(readSkillRow).filter(Boolean);
  const needsReplacement = Array.isArray(raw?.needs_replacement) ? raw.needs_replacement : [];

  return {
    phase: str(game.phase) ?? str(raw?.phase),
    turn: num(game.turn) ?? num(raw?.turn),
    result: game.result ?? raw?.battle_result ?? null,
    mine: myPets[activeIndex] ?? null,
    myActiveIndex: activeIndex,
    myPets,
    myBench: myPets.filter((_, index) => index !== activeIndex),
    // 对手**场上**那只恒为第一个：`rocoGameView` 把 `opponent.field` 放在最前面，
    // 后面的才是后备（只有位次与是否倒下）。**不能**用 `opponent.active` 当下标——
    // 那是对手在自己队伍里的位次（实测出现过 active=1 而 field 是另一只），
    // 用它去索引就会读到一条后备记录（血/速度/名字全是 null），于是检测器**安静地不说话**。
    foe: foePets[0] ?? null,
    foeBench: foePets.slice(1),
    legal,
    skills,
    events: Array.isArray(raw?.events) ? raw.events : [],
    needsReplacement,
  };
}

/** 合法技能动作（只认 `kind === 'skill'` 且名字已知的那些）。 */
function legalSkills(pos) {
  return pos.legal.filter((a) => a.kind === 'skill' && a.name);
}

/** 能换到的那几只（合法 switch 动作指向的、还站着的伙伴）。 */
function switchTargets(pos) {
  const out = [];
  for (const action of pos.legal) {
    if (action.kind !== 'switch' || action.targetIndex === null) continue;
    const index = pos.myPets.findIndex((p, i) => (p.slot ?? i) === action.targetIndex || i === action.targetIndex);
    if (index < 0 || index === pos.myActiveIndex) continue;
    const pet = pos.myPets[index];
    if (!pet || pet.fainted) continue;
    out.push({action, pet, index});
  }
  return out;
}

/** 合法性里按名字找一招（名字在公开视图里是玩家看到的那个标识）。 */
function legalByName(pos, name) {
  if (!name) return null;
  return legalSkills(pos).find((a) => a.name === name) ?? null;
}

/**
 * 技能名 → 能耗。
 *
 * `self.skills` 是**一整队的配招表**（开局那一份，含每招能耗）；合法动作只覆盖
 * 场上这只这一轮放得出的招，所以「放不出来的那招要多少能量」**只能**从 `self.skills`
 * 读。两边都没有就返回 null —— 宁可不说，也不猜一个能耗。
 */
function energyCostOf(pos, name) {
  if (!name) return null;
  const row = pos.skills.find((s) => s.name === name);
  if (row && row.energy !== null) return row.energy;
  const hit = legalByName(pos, name);
  if (hit && hit.energy !== null) return hit.energy;
  return null;
}

/** 技能名 → 系别（属性对位那条要拿它说「继续用这个系」）。 */
function elementOf(pos, name) {
  const row = pos.skills.find((s) => s.name === name);
  return row?.element ?? legalByName(pos, name)?.element ?? null;
}

/** 上一手我方打出的、带属性倍率的那一击（含它后面有没有换人/倒下）。 */
function lastMyTypeHit(pos) {
  const events = pos.events;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    const detail = isObj(e?.detail) ? e.detail : {};
    if (e?.kind !== 'damage' || detail.side !== 'player') continue;
    const multiplier = num(detail.type_multiplier);
    if (multiplier === null) continue;
    // 这一击之后如果对面换了人/倒了被补位，那这个倍率就不再属于**现在**场上这只：
    // 属性倍率是「攻击系别 × 防守方属性」的函数，防守方换了，结论就作废。
    const after = events.slice(i + 1);
    const foeChanged = after.some((x) => {
      const d = isObj(x?.detail) ? x.detail : {};
      return d.side === 'enemy' && (x?.kind === 'switch' || x?.kind === 'replacement' || x?.kind === 'faint');
    });
    if (foeChanged) return null;
    return {multiplier, skillId: str(detail.skill_id), damage: num(detail.damage)};
  }
  return null;
}

/** 技能 id → 名字：合法动作里有就够（`self.skills` 在第一次推进后是空的，见设计文档）。 */
function skillNameById(pos, skillId) {
  if (!skillId) return null;
  const hit = legalSkills(pos).find((a) => a.skillId === skillId);
  return hit?.name ?? null;
}

/** 这一轮我方有没有一招叫这个名字（用于「换个招」这类建议是否站得住）。 */
function hasLegalName(pos, name) {
  return legalByName(pos, name) !== null;
}

// ── 检测器 ────────────────────────────────────────────────────────────────
//
// 每个检测器返回一个候选 `{kind, text, why, risk, evidence}` 或 null。
// **数组顺序就是优先级**：前面的先说。理由写在 DOC（docs/roco/COACH-ADVICE-DESIGN.md）
// 的「优先级」一节，核心口径是：被迫的动作 > 现在就能兑现的收益 > 保住资产 >
// 解释为什么打不出该打的 > 让对手继续掉血 > 属性对位 > 出手顺序 > 威胁预告。

const KIND_PRIORITY = Object.freeze({
  'replace-required': 1,
  'ko-now': 2,
  'ko-maybe': 3,
  'foe-low-hp': 4,
  'switch-low-hp': 5,
  'energy-short': 6,
  'foe-status-ticking': 7,
  'type-resisted': 8,
  'type-favoured': 9,
  'speed-decides': 10,
  'foe-energy-high': 11,
});

function candidate(kind, text, why, risk, evidence) {
  return {kind, priority: KIND_PRIORITY[kind] ?? 99, text, why, risk, evidence: evidence ?? {}};
}

/** 1. 场上的倒了，必须补位。命名一只能换上去的、最厚的伙伴。 */
function detectReplaceRequired(pos) {
  if (pos.phase !== 'replace' && !pos.needsReplacement.includes('player')) return null;
  const mine = pos.mine;
  if (!mine || !mine.fainted) return null;
  const picks = pickSwitchTargets(pos);
  if (!picks.length) return null;
  const pick = picks[0];
  const foeName = pos.foe?.name ?? null;
  const foeTail = foeName ? `对面${ref(foeName)}还在场，补位别一上来就挨打` : '补位选厚的顶住这一轮';
  return candidate(
    'replace-required',
    `${ref(mine.name)}倒了，换${ref(pick.pet.name)}顶上：${foeTail}`,
    '场上的伙伴已经倒下，这一手只能补位，没有别的选择',
    `补上来的这只这一轮就要接对面的手${foeName ? `（${foeName}）` : ''}`,
    {
      fainted: mine.name,
      bench: picks.map((p) => ({name: p.pet.name, hp: p.pet.hp, maxHp: p.pet.maxHp})),
      foe: foeName,
      foeHp: pos.foe?.hp ?? null,
    },
  );
}

/**
 * 2/3. 收线：有一招（合法的、这一轮真的打得出来的）估算伤害能盖过对面当前血量。
 *
 * 判定一律用**样本包络**，不用规划器的 `lethal` 布尔：`lethal` 说的是「所有分析
 * 口径都收得掉」，而这里要分开讲「稳收」和「有的口径收不掉」两句不同的话。
 * 伤害来自引擎**未核验**的公式（`formula_verified: false`），所以措辞必须带「估」。
 */
function detectKo(pos, plan) {
  const preview = plan?.damage_preview;
  if (!isObj(preview) || preview.available !== true) return null;
  const foeHp = num(preview.foe_hp) ?? pos.foe?.hp ?? null;
  if (foeHp === null || foeHp <= 0) return null;
  const samples = (Array.isArray(preview.samples) ? preview.samples : [])
    .map((s) => ({label: str(s?.label), min: num(s?.min), max: num(s?.max)}))
    .filter((s) => s.label && s.max !== null);
  if (!samples.length) return null;
  // 只有**合法**的招才算「现在能收」：估算用的是配招表，里面可能有这一轮放不出的招。
  const castable = samples.filter((s) => legalByName(pos, s.label));
  if (!castable.length) return null;
  const steady = castable.filter((s) => s.min !== null && s.min >= foeHp).sort((a, b) => b.max - a.max)[0] ?? null;
  const maybe = castable.filter((s) => s.max >= foeHp).sort((a, b) => b.max - a.max)[0] ?? null;
  const foeName = pos.foe?.name ?? null;
  if (steady) {
    return candidate(
      'ko-now',
      `${ref(steady.label)}估 ${show(steady.max)}，够收对面${foeName ? ref(foeName) : ''}这 ${show(foeHp)} 血：这一轮直接收`,
      `对面只剩 ${show(foeHp)} 血，${ref(steady.label)}的估算伤害（${estimateText(steady.min, steady.max)}）把它盖住了`,
      '对面换人可以先躲掉这一下（换人比技能先动）',
      {foe: foeName, foeHp, move: steady.label, estimate: {min: steady.min, max: steady.max}, formulaVerified: preview.formula_verified === true},
    );
  }
  if (maybe) {
    return candidate(
      'ko-maybe',
      `${ref(maybe.label)}估 ${show(maybe.min)}~${show(maybe.max)}，对面 ${show(foeHp)} 血：收得掉是运气，收不掉就白亏一轮`,
      `估算的上下界跨过了对面的血线（${show(foeHp)}），所以这不是一个稳的收线`,
      '这一下收不掉就白送对面一轮，想稳就先别赌',
      {foe: foeName, foeHp, move: maybe.label, estimate: {min: maybe.min, max: maybe.max}, formulaVerified: preview.formula_verified === true},
    );
  }
  return null;
}

/**
 * 4. 对面已经残血：这一轮的立场是「先兑现」，不是换人、也不是试招。
 *
 * 为什么需要这一条（而不是全靠 `ko-now`）：`ko-now` 要引擎的收线估算
 * （`damage_preview`），而那份估算在真实链路里**只有开局那一回合可得**
 * （见设计文档 §10：`loadouts` 没被序列化，第一次推进后配招就空了）。
 * 所以「对面只剩几点血」这个**公开事实**要能单独说话——但它只表达立场，
 * 不声称能收掉：说收掉需要未核验的伤害公式。
 *
 * 什么时候**不**说：我自己也残血、而且对面比我快——那时候先换人更值
 * （这一手会先挨打，可能等不到我出手）。那一条路由 `switch-low-hp` 接手。
 */
function detectFoeLowHp(pos) {
  const foe = pos.foe;
  const mine = pos.mine;
  const foeRatio = hpRatio(foe);
  if (!foe || foe.fainted || foeRatio === null || foeRatio > FOE_FINISH_RATIO) return null;
  const myRatio = hpRatio(mine);
  const mySpe = num(mine?.spe);
  const foeSpe = num(foe.spe);
  const foeActsFirst = foeSpe !== null && (mySpe === null || foeSpe > mySpe);
  if (myRatio !== null && myRatio <= LOW_HP_RATIO && foeActsFirst) return null;
  return candidate(
    'foe-low-hp',
    `对面${ref(foe.name)}只剩 ${show(foe.hp)} 血：这一轮先把它补掉，别让它换人喘口气`,
    `它只剩 ${show(foe.hp)}/${show(foe.maxHp)}，是这一轮最值得先兑现的东西`,
    foeActsFirst ? '它比你快，这一下可能先落在你身上' : '对面换人就能躲掉这一下（换人比技能先动）',
    {foe: foe.name, foeHp: foe.hp, foeMaxHp: foe.maxHp, foeRatio: Number(foeRatio.toFixed(3)), myHp: mine?.hp ?? null, foeActsFirst},
  );
}

/** 5. 场上这只快撑不住了，而后备里还有厚的：先把资产换下来。 */
function detectSwitchLowHp(pos) {
  const mine = pos.mine;
  const ratio = hpRatio(mine);
  if (!mine || mine.fainted || ratio === null || ratio > LOW_HP_RATIO) return null;
  const picks = pickSwitchTargets(pos).filter((p) => {
    const r = hpRatio(p.pet);
    return r !== null && r >= HEALTHY_HP_RATIO;
  });
  if (!picks.length) return null;
  const pick = picks[0];
  const percent = Math.round(ratio * 100);
  return candidate(
    'switch-low-hp',
    `你只剩 ${percent}% 血，换${ref(pick.pet.name)}上来：它还厚，别把${ref(mine.name)}白送掉`,
    `场上这只血量已经到底（${show(mine.hp)}/${show(mine.maxHp)}），后备里有更厚的伙伴`,
    '换人这一手虽然先动，但上来的那只照样要吃对面这一下',
    {
      active: mine.name, myHp: mine.hp, myMaxHp: mine.maxHp, ratio: Number(ratio.toFixed(3)),
      pick: pick.pet.name, pickHp: pick.pet.hp, pickMaxHp: pick.pet.maxHp,
      foe: pos.foe?.name ?? null, foeHp: pos.foe?.hp ?? null,
    },
  );
}

/**
 * 6. 想放的那一招放不出来，而且原因是能量不够：说清「差多少」和「这一轮改放什么」。
 *
 * 为什么这条要有：玩家看到的是按钮灰了，却不知道为什么灰、也不知道改点什么。
 * 判据不用阈值——「估算更狠的那一招不在合法动作里」+「它的能耗大于当前能量」
 * 两个公开事实同时成立才开口。
 *
 * ⚠️ 只在**这一招真能决定这一轮**时开口（估算上限盖过对面当前血，或者这一轮连
 * 一招攻击都放不出）。为什么收窄：引擎修好配招序列化之后，开局的「最狠那招放不出」
 * 几乎是常态（能量 2、贵招要 4），于是每一局前几回合都会说「先吃能量果补上」——
 * 那正是玩家抱怨的「反复只说同一句」的翻版。只是「更狠一点」不值得打断玩家，
 * 这时候让属性/速度/异常那些更有信息量的检测器说话。
 */
function detectEnergyShort(pos, plan) {
  const preview = plan?.damage_preview;
  if (!isObj(preview) || preview.available !== true) return null;
  const mine = pos.mine;
  const energy = num(mine?.energy);
  if (!mine || energy === null) return null;
  const samples = (Array.isArray(preview.samples) ? preview.samples : [])
    .map((s) => ({label: str(s?.label), min: num(s?.min), max: num(s?.max)}))
    .filter((s) => s.label && s.max !== null);
  if (!samples.length) return null;
  const castable = samples.filter((s) => legalByName(pos, s.label));
  const blocked = samples.filter((s) => !legalByName(pos, s.label));
  if (!blocked.length) return null;
  const bestBlocked = blocked.sort((a, b) => b.max - a.max)[0];
  const bestCastable = castable.sort((a, b) => b.max - a.max)[0] ?? null;
  if (bestCastable && bestCastable.max >= bestBlocked.max) return null; // 放不出来的那招并不更狠
  const cost = energyCostOf(pos, bestBlocked.label);
  if (cost === null || cost <= energy) return null; // 不是能量问题 → 不猜原因
  const foeHp = num(preview.foe_hp);
  // 「决定这一轮」= 这一招估算能盖过对面血量（收线）；或者这一轮一招攻击都放不出。
  const decisive = foeHp !== null && bestBlocked.max >= foeHp;
  if (!decisive && bestCastable) return null;
  const deficit = cost - energy;
  const energyItem = pos.legal.find((a) => a.kind === 'item' && a.itemId === '能量果') ?? null;
  if (energyItem) {
    return candidate(
      'energy-short',
      decisive
        ? `能量还差 ${show(deficit)} 才能收掉它：先吃「能量果」补上，这一轮别硬顶`
        : `这一轮放不出攻击招：先吃「能量果」补上能量，别空过`,
      decisive
        ? `${ref(bestBlocked.label)}估 ${estimateText(bestBlocked.min, bestBlocked.max)} 盖得过对面 ${show(foeHp)} 血，但${ref(mine.name)}还差 ${show(deficit)} 点能量`
        : `${ref(mine.name)}只有 ${show(energy)} 点能量，配招里最便宜的招现在也放不出来`,
      '这一轮吃道具虽然先动，但对面那一手照样会打过来',
      {energy, cost, move: bestBlocked.label, estimate: {min: bestBlocked.min, max: bestBlocked.max}, foeHp, item: '能量果', decisive},
    );
  }
  if (!decisive || !bestCastable) return null; // 说不出「改放什么」、或换招也救不了 → 不开口
  return candidate(
    'energy-short',
    `能量不够收它：先用${ref(bestCastable.label)}顶这一轮，攒够再放${ref(bestBlocked.label)}`,
    `${ref(bestBlocked.label)}估 ${estimateText(bestBlocked.min, bestBlocked.max)} 盖得过对面 ${show(foeHp)} 血，但能量还差 ${show(deficit)} 点`,
    `这一轮只能用${ref(bestCastable.label)}这种小招，对面会趁这一轮压过来`,
    {energy, cost, move: bestBlocked.label, alternative: bestCastable.label, estimate: {min: bestCastable.min, max: bestCastable.max}, foeHp, decisive},
  );
}

/** 7. 对面场上那只正在被持续伤害扣血：这一轮的立场是「拖」，因为时间站在你这边。 */
function detectFoeStatus(pos) {
  const foe = pos.foe;
  if (!foe || foe.fainted) return null;
  const ticking = Object.keys(foe.statuses).filter((name) => TICKING_STATUSES.includes(name));
  if (!ticking.length) return null;
  const name = ticking[0];
  const layers = num(foe.statuses[name]?.layers);
  // 上一手的扣血数字是公开的（引擎把 `status_tick` 连伤害一起发出来），有就写进证据。
  const tick = [...pos.events].reverse().find((e) => {
    const d = isObj(e?.detail) ? e.detail : {};
    return e?.kind === 'status_tick' && d.side === 'enemy' && d.status === name;
  }) ?? null;
  const tickDamage = num(tick?.detail?.damage);
  const layerText = layers === null ? '' : `（${show(layers)} 层）`;
  return candidate(
    'foe-status-ticking',
    `对面${ref(foe.name)}还在${name}${layerText}：拖住节奏别对拼，让它每回合继续掉血`,
    tickDamage === null
      ? `${ref(foe.name)}身上挂着${name}，回合末会按生命比例扣血`
      : `上一手它因为${name}掉了约 ${show(tickDamage)} 血，这个扣血每回合都会来一次`,
    `它换人就能把这层持续伤害甩掉（回合末只结算场上那只）`,
    {foe: foe.name, status: name, layers, tickDamage, foeHp: foe.hp, foeMaxHp: foe.maxHp},
  );
}

/**
 * 8/9. 属性对位：用**上一手真实打出的倍率**说现在该不该继续用这一招。
 *
 * 为什么必须落在「上一手那一招」上：倍率只由「攻击系别 × 防守方属性」决定
 * （引擎 `effects.compute_damage`：`type_multiplier = type_chart.multiplier(defender.types, skill.element)`，
 * 本系加成 `stab` 是另一个字段）。看起来很自然的一步是「退到同系别的其它招」——
 * 但**做不到**：要把「上一手那招」换成同系别的招，先得知道那招的系别，而系别只能从
 * `self.skills` / 合法动作里读；一旦那招这一轮放不出来（能量不够），它就不在合法动作里，
 * 而 `self.skills` 在第一次推进后是空的（见设计文档 §10）。所以这里只认
 * 「那一招这一轮仍合法」这一种情况——宁可不说，也不猜一个系别。
 */
function detectTypeMatchup(pos) {
  const hit = lastMyTypeHit(pos);
  if (!hit || hit.multiplier === 1) return null;
  const name = skillNameById(pos, hit.skillId);
  if (!name || !hasLegalName(pos, name)) return null; // 这一轮放不出这招 → 不作为行动建议
  const foeName = pos.foe?.name ?? null;
  const element = elementOf(pos, name);
  const damageNote = hit.damage === null ? '' : `（${show(hit.damage)} 伤害）`;
  const evidence = {
    move: name, element, multiplier: hit.multiplier, damage: hit.damage,
    foe: foeName, foeHp: pos.foe?.hp ?? null,
  };
  if (hit.multiplier > 1) {
    return candidate(
      'type-favoured',
      `${ref(name)}上一手打出克制${damageNote}：继续用它压上去`,
      `${ref(name)}打对面${foeName ? ref(foeName) : ''}是克制伤害，换成别的招反而更轻`,
      '对面换人躲一下，这个克制关系就不一定还在了',
      evidence,
    );
  }
  return candidate(
    'type-resisted',
    `${ref(name)}打${foeName ? ref(foeName) : '对面'}只有抵抗${damageNote}：别再硬用它`,
    `上一手${ref(name)}被对面属性抵抗，这一轮再用就是同样的轻伤害`,
    '硬打这一手等于把回合让给对面，改招或先换人都比它强',
    evidence,
  );
}

/** 10. 速度差：谁先动决定了这一轮对拼的交换结果。只比公开的六维速度，不猜先手度。 */
function detectSpeed(pos) {
  const mineSpe = num(pos.mine?.spe);
  const foeSpe = num(pos.foe?.spe);
  if (mineSpe === null || foeSpe === null || mineSpe === foeSpe) return null;
  const foeName = pos.foe?.name ?? null;
  if (mineSpe > foeSpe) {
    return candidate(
      'speed-decides',
      `你速度 ${show(mineSpe)} 快过它 ${show(foeSpe)}：这一轮先手压上去，别把节奏让掉`,
      `速度比你慢的是对面，同一档出手顺序里你先动`,
      '对面要是掏先手招，速度再快也快不过它',
      {mySpe: mineSpe, foeSpe, foe: foeName},
    );
  }
  const defend = hasLegalName(pos, '防御');
  return candidate(
    'speed-decides',
    `它速度 ${show(foeSpe)} 快过你 ${show(mineSpe)}：别硬对拼，${defend ? '先换人或者用「防御」顶这一下' : '这一轮先换人躲一下'}`,
    `对面的速度比你高，同档对拼是它先出手`,
    '硬拼的话这一下会先落在你身上',
    {mySpe: mineSpe, foeSpe, foe: foeName, defendLegal: defend},
  );
}

/** 11. 对面能量快满了：下一手随时可能是重招。只提醒风险，不替玩家挑招。 */
function detectFoeEnergyHigh(pos) {
  const foe = pos.foe;
  const energy = num(foe?.energy);
  if (!foe || foe.fainted || energy === null || energy < FOE_ENERGY_ALERT) return null;
  return candidate(
    'foe-energy-high',
    `对面能量到 ${show(energy)} 了（上限 ${ENERGY_MAX}）：重招随时来，别拿残血硬接这一手`,
    `它能量已经攒到 ${show(energy)}（上限 ${ENERGY_MAX}），这一轮随时放得出重招`,
    '这一下硬接可能直接倒一只，先把厚的那只留在场上',
    {foe: foe.name, foeEnergy: energy, energyMax: ENERGY_MAX, foeHp: foe.hp},
  );
}

/** 能换的伙伴按「血量比例从高到低、同位次靠前优先」排。 */
function pickSwitchTargets(pos) {
  return switchTargets(pos)
    .map((entry) => ({...entry, ratio: hpRatio(entry.pet) ?? -1}))
    .sort((a, b) => (b.ratio - a.ratio) || ((a.pet.slot ?? a.index) - (b.pet.slot ?? b.index)));
}

/** 检测器表：**数组顺序 = 优先级**，第一个开口的就是这一轮的结论。 */
const DETECTORS = Object.freeze([
  (pos, plan) => detectReplaceRequired(pos, plan),
  (pos, plan) => detectKo(pos, plan),
  (pos, plan) => detectFoeLowHp(pos, plan),
  (pos, plan) => detectSwitchLowHp(pos, plan),
  (pos, plan) => detectEnergyShort(pos, plan),
  (pos, plan) => detectFoeStatus(pos, plan),
  (pos, plan) => detectTypeMatchup(pos, plan),
  (pos, plan) => detectSpeed(pos, plan),
  (pos, plan) => detectFoeEnergyHigh(pos, plan),
]);

/** 这一句形状是不是已经说过了（`session.said` 可以是 Set，也可以是数组）。 */
function alreadySaid(session, shape) {
  const said = session?.said;
  if (said instanceof Set) return said.has(shape);
  if (Array.isArray(said)) return said.includes(shape);
  return false;
}

/**
 * 本层的唯一入口。
 *
 * @param {object} input
 * @param {object} input.game  `rocoGameView(view)` 的产物（带 `.roco` 原始公开视图最好）
 * @param {object} input.plan  `/api/roco/plan` 的回执；只用它的收线估算与证据，不用它触发
 * @param {object} input.session 页面上的局内记账（`dismissed` / `said`）
 * @param {object} input.host  门控层传来的上下文（`ended` / `stale`）
 * @returns {null|{text:string, why:string, risk:string, kind:string, evidence:object}}
 *          返回 `null` 就是**沉默**：这个局面没有值得打断玩家的事实。
 */
export function coachAdvice({game, plan, session, host} = {}) {
  // 已经结束、或者提示对应的局面已经过期：这一层不说话（门控层已经拦过一次，这里是兜底）。
  if (host?.ended === true || host?.stale === true) return null;
  if (session?.dismissed === true) return null;
  const pos = readPosition(game);
  if (!pos || pos.result) return null;

  for (const detect of DETECTORS) {
    const picked = detect(pos, isObj(plan) ? plan : null);
    if (!picked) continue;
    // 同一句（数字不同也算同一句）已经说过就不再重复：重复本身就是在浪费玩家的注意力。
    if (alreadySaid(session, normaliseAdviceShape(picked.text))) return null;
    return {
      text: picked.text,
      why: picked.why,
      risk: picked.risk,
      kind: picked.kind,
      evidence: {...picked.evidence},
    };
  }
  // 没有一条局面事实值得说 → 沉默。这里**不**回退到「引擎推荐了什么」：
  // 「推荐 X」不是决策依据，硬说出来就是这一层要修掉的那个毛病。
  return null;
}

/** 本层可能产出的全部标签（测试与页面按它断言，别在别处再抄一份）。 */
export const COACH_ADVICE_KINDS = Object.freeze(Object.keys(KIND_PRIORITY));
