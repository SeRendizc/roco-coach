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
 * 依据：默认规则配置 `legacy_sim_v1` 的上限 6（`data/roco/rulesets/legacy-sim-v1.json`，
 * 唯一事实源），每回合回 1 点，`能量果` 一次给 4 点（引擎 `ITEM_EFFECTS`）。
 * 到 5 就意味着对面**当下**放得出几乎任何一招（配招里最贵的那几招能耗 3—5）。
 * 这是一个档位判断，没有官方「高能量」定义，所以它是产品阈值。**不是游戏规则。**
 */
const FOE_ENERGY_ALERT = 5;

// 这一层**不再**持有能量上限的字面量（RC-101：全仓只有规则配置文件可以出现它）。
// 上限从**公开视图**里读：服务端把规则配置里的 `energy_max` 一起发下来时
// （`opponent.energy_max`），本层才知道「离满还差多少」；发不下来时**不说话**，
// 而不是照抄一个可能已经过期的 6。判据见 `detectFoeEnergyHigh`。

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

/**
 * 合法动作的可寻址标识：`kind#下标:标签`。
 *
 * 为什么要一个**自己的**标识，而不是 `skill_id`：手游 `/api/coach` 那条快照
 * （客户端 `coachRocoBattle()`）只搬玩家看得见的 `{label, kind}` 两个字段 —— 拿不到 id。
 * 「不给标识」的后果不是报错，而是客户端的「采用建议」**没有可回填的目标**：
 * 建议渲染得出来，点下去却不知道该选哪一项。
 *
 * 用「当前合法集合里的位置 + 标签」当标识是**故意**的：局面一变（回合推进、合法表变化），
 * 标识跟着变，「旧建议失效」就有了机器可读的判据（配合 `stateVersion` 用）。
 */
export function legalActionIdOf(action, index) {
  const kind = str(action?.kind) ?? 'action';
  const label = str(action?.label) ?? str(action?.name);
  // ⚠ 2026-09-29 改钉（Lead 的宿主侧契约）：标识里**不许放数组下标**。
  //
  // 起因：客户端「采用建议」要按这个标识在**当前** `state.view.legal` 里重新解析后执行
  //（`roco.js` 的 `roco:advice-adopt`，解析不到就拒绝执行）。数组下标会漂 ——
  // 同一件道具换个位置，下标就从 `item#2` 变成 `item#0`，客户端会解析到**另一项**上。
  // 现在一律用**动作自己的身份**：换人用 `target_index`（聊天快照里没有它就退回标签里的位次，
  // 与 `switchIndexFromLabel` 同一口径），技能优先 `skill_id`、道具优先 `item_id`，
  // 拿不到 id 才退回标签（标签是引擎给的公开动作名，仍然稳定）。
  // `index` 只用来做最后的兜底，且只在完全没有名字时才会出现。
  const targetIndex = Number.isInteger(action?.targetIndex)
    ? action.targetIndex
    : switchIndexFromLabel(action?.label);
  if (kind === 'switch' && Number.isInteger(targetIndex)) return `switch#${targetIndex}`;
  if (kind === 'skill') return `skill#${str(action?.skillId) ?? label ?? (Number.isInteger(index) ? index : '?')}`;
  if (kind === 'item') return `item#${str(action?.itemId) ?? label ?? (Number.isInteger(index) ? index : '?')}`;
  return `${kind}#${label ?? (Number.isInteger(index) ? index : '?')}`;
}

/** 玩家看到的那一项叫什么：换人用**伙伴名**（换「水蓝蓝」），其余用引擎给的标签。 */
function displayLabelOf(action) {
  if (!action) return null;
  if (action.kind === 'switch' && action.targetName) return action.targetName;
  return str(action.label) ?? str(action.name);
}

/** 合法动作归一。技能名可能只在 `label` 上（换人/道具就没有 `skill`）。 */
function readAction(action, index = null) {
  if (!isObj(action)) return null;
  const skill = isObj(action.skill) ? action.skill : null;
  const kind = str(action.kind);
  const label = str(action.label);
  return {
    kind,
    label,
    legalIndex: Number.isInteger(index) ? index : null,
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
 * 换人标签里的位次 → 伙伴下标。
 *
 * 为什么从**标签**里读而不是 `target_index`：手游快照的合法动作只有 `{label, kind}`，
 * `target_index` 在客户端就被裁掉了（`coachRocoBattle()` 只搬 label/kind）。
 * 位次与引擎公开视图同源（「换上第3位」就是 `self[2]`），所以这不是猜 ——
 * 与 `runtime.js` 的 `switchTargetOf()` 同一口径。读不出数字就返回 null（不猜）。
 */
function switchIndexFromLabel(label) {
  const m = /(\d+)/.exec(String(label ?? ''));
  if (!m) return null;
  const index = Number(m[1]) - 1;
  return Number.isInteger(index) && index >= 0 ? index : null;
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
  // 下标要**真的传下去**：`legalActionIdOf()` 用它构成可寻址标识（见那个函数的说明）。
  const legal = (Array.isArray(raw?.legal) ? raw.legal : []).map((one, index) => readAction(one, index)).filter(Boolean);
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
    // 能量上限来自公开视图里的**规则配置**（`opponent.energy_max` / `self.energy_max`）。
    // 读不到就是 null —— 本层宁可不说，也不猜一个上限。
    energyMax: num(rawFoe?.energy_max) ?? num(rawFoe?.energyMax)
      ?? num(rawSelf?.energy_max) ?? num(rawSelf?.energyMax) ?? null,
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

/**
 * 合法招里**估算最高**的那一条；没有估算数据就返回 null。
 *
 * 为什么不用 `power`（面板威力）挑：威力是配方表里的数，不等于这一下的伤害
 * （属性倍率、防御、异常都会改），拿它挑会得到一条「看起来最强、实际不是」的建议。
 * 估算只认服务端发下来的 `damage_preview.samples`，没有就什么都不挑 ——
 * 由上层如实写「没有估算数据」。
 */
function bestLegalAttack(pos, plan) {
  const estimates = estimateTable(pos, plan);
  const rows = legalSkills(pos)
    .map((action) => ({action, est: estimates.get(action.label) ?? null}))
    .filter((row) => row.est && (row.est.max !== null || row.est.min !== null))
    .sort((a, b) => ((b.est.max ?? b.est.min ?? -Infinity) - (a.est.max ?? a.est.min ?? -Infinity))
      || (a.action.legalIndex ?? 0) - (b.action.legalIndex ?? 0));
  return rows.length ? rows[0].action : null;
}

/** 能换到的那几只（合法 switch 动作指向的、还站着的伙伴）。 */
function switchTargets(pos) {
  const out = [];
  for (const action of pos.legal) {
    if (action.kind !== 'switch') continue;
    // `target_index` 优先（视图里有就用它）；手游快照里它被裁掉了，于是退回**标签里的位次**
    // ——「换上第3位」与 `self[2]` 同源（见 `switchIndexFromLabel` 的说明）。
    const fromLabel = switchIndexFromLabel(action.label);
    if (action.targetIndex === null && fromLabel === null) continue;
    const index = pos.myPets.findIndex((p, i) => (p.slot ?? i) === (action.targetIndex ?? fromLabel) || i === (action.targetIndex ?? fromLabel));
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
  // 对手在补位：与「我方必须补位」同族（都是补位阶段的事实），但**不是我必须动**。
  'foe-replacing': 1,
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
  // U09 的确定性兜底：分数层判「这一手必须说话」（decisive），而没有一个检测器
  // 够得上自己的触发条件时，仍然要给出一条合法首选行动 —— 那一类的标签就是它。
  // 放在最后一位：它是**兜底**，永远不该抢在具体局面事实前面。
  'primary-action': 12,
});

function candidate(kind, text, why, risk, evidence, action = null) {
  return {kind, priority: KIND_PRIORITY[kind] ?? 99, text, why, risk, evidence: evidence ?? {}, action};
}

/**
 * 把一条候选里的行动翻成**机器可读的可执行目标**。
 *
 * 为什么必须有这一栏：U08 要求建议里的行动「在最新合法集合里」并且客户端要能渲染
 * 「查看 / 采用建议」。「文本里提到了某个技能名」证明不了它在合法集合里，也点不下去；
 * 只有 `legalActionId` + 下标才能被客户端回填到与合法表**同一项**。
 * 拿不到（`action` 为 null）就如实为 null —— 不拿一个像样的标签顶替。
 */
function actionRefOf(pos, action) {
  if (!action) return null;
  const index = Number.isInteger(action.legalIndex)
    ? action.legalIndex
    : pos.legal.findIndex((one) => one === action || (one.kind === action.kind && one.label === action.label));
  const resolved = index >= 0 ? pos.legal[index] : null;
  const label = resolved?.label ?? action.label ?? action.name ?? null;
  // 传**完整动作**（`targetIndex` / `skillId` / `itemId` 都在里面）——标识必须是动作的身份，
  // 不是它在数组里的位置（见 `legalActionIdOf` 的说明）。
  return {
    legalActionId: legalActionIdOf(resolved ?? action, index),
    legalIndex: index >= 0 ? index : null,
    kind: action.kind ?? null,
    // 引擎给的合法动作标签（客户端「采用」时要回填的那一项）。
    label,
    // 给句子用的名字：换人用伙伴名（「换上第3位」对玩家没有意义）。
    display: displayLabelOf(action) ?? label,
  };
}

/** 换人动作 + 目标伙伴：`actionRefOf` 需要伙伴名才能写出玩家看得懂的那一项。 */
function switchActionOf(entry) {
  return entry?.action ? {...entry.action, targetName: entry.pet?.name ?? null} : null;
}

/**
 * 建议里的「另一个合法选项」：只列**当前合法集合里**的项，带一句解释（有估算就说估算）。
 * 上限 2 条：备选多了就不是建议，是一张表。
 */
function alternatesOf(pos, primaryRef, plan) {
  const estimates = estimateTable(pos, plan);
  const rows = [];
  for (const [index, action] of pos.legal.entries()) {
    if (primaryRef && action.kind === primaryRef.kind && action.label === primaryRef.label) continue;
    const target = action.kind === 'switch'
      ? switchIndexFromLabel(action.label)
      : null;
    const pet = target === null ? null : pos.myPets[target] ?? null;
    const label = action.kind === 'switch' && pet?.name ? pet.name : (action.label ?? action.name ?? '这一项');
    const est = estimates.get(action.label ?? '') ?? null;
    const note = est
      ? `按未核验公式估 ${estimateText(est.min, est.max)} 点`
      : (action.kind === 'switch'
        ? `换上去 ${pet && pet.hp !== null ? `${show(pet.hp)} 血` : '血量没给'}`
        : (action.kind === 'item' ? '用一件道具（这一手就不能出招了）' : '没有估算数据'));
    rows.push({label, kind: action.kind ?? null, legalActionId: legalActionIdOf(action, index),
      legalIndex: index, note});
    if (rows.length >= 2) break;
  }
  return rows;
}

/**
 * 估算表：`技能标签 → {min,max}`。
 *
 * 只认**服务端真的发下来**的样本（`plan.damage_preview.samples`）。没有就是空表 ——
 * 本层宁可说「没有估算数据」，也不拿一个配方表算出来的数顶替
 * （伤害公式未核验，`coach-advice.js` 文件头的纪律）。
 */
function estimateTable(pos, plan) {
  const preview = plan?.damage_preview;
  const out = new Map();
  if (!isObj(preview)) return out;
  for (const sample of Array.isArray(preview.samples) ? preview.samples : []) {
    const label = str(sample?.label);
    if (!label) continue;
    const min = num(sample?.min);
    const max = num(sample?.max);
    if (min === null && max === null) continue;
    out.set(label, {min, max});
  }
  if (out.size === 0 && str(preview.best_label) && (num(preview.min) !== null || num(preview.max) !== null)) {
    out.set(preview.best_label, {min: num(preview.min), max: num(preview.max)});
  }
  return out;
}

/** 1. 场上的倒了，必须补位。命名一只能换上去的、最厚的伙伴。 */
function detectReplaceRequired(pos) {
  // U09 的硬要求：**己方倒下必须提示合法存活可换对象**。
  //
  // ⚠ 2026-09-29 改钉（真 8765 六宠局 t8 抓到的**事实错误**）：触发条件**不能**用
  // `phase==='replace'`。那是**双方共用**的阶段名，而引擎在补位阶段对**两边**都只发 switch
  // （`env.py:360`）；对手倒下时 `needs_replacement` 只有 `['enemy']`。旧写法于是在
  // 「对面喵喵倒下、我方多彩方方还活着 246/360」的那一手说出「你的多彩方方倒了，换缇塔顶上」
  // —— 名字、状态、因果全错。权威信号只有一个：**引擎说 player 要补位**，或者我方场上那只
  // 真的倒了/hp 为 0（`self.active` 指向已倒下的伙伴，见 `tests/evals/coach-advice.test.js`
  // 的「对手的 active 是它在自己队伍里的位次」那一格 —— 那一格 `phase==='battle'`，
  // 所以「hp 为 0」这条不会误伤它）。
  const mineHp = num(pos.mine?.hp);
  const fainted = pos.mine?.fainted === true || (mineHp !== null && mineHp <= 0);
  const mustReplace = pos.needsReplacement.includes('player') || fainted;
  if (!mustReplace) return null;
  const mine = pos.mine;
  // 只能从**合法动作**里挑（补位也是引擎给的 switch 动作）；没有合法目标就不开口。
  const picks = pickSwitchTargets(pos).filter((entry) => !entry.pet.fainted && (entry.pet.hp === null || entry.pet.hp > 0));
  if (!picks.length) return null;
  const pick = picks[0];
  const foeName = pos.foe?.name ?? null;
  const foeTail = foeName ? `对面${ref(foeName)}还在场，补位别一上来就挨打` : '补位选厚的顶住这一轮';
  const faintedName = mine?.name ?? null;
  return candidate(
    'replace-required',
    `${faintedName ? ref(faintedName) : '场上那一只'}倒了，换${ref(pick.pet.name)}顶上：${foeTail}`,
    '场上的伙伴已经倒下，这一手只能补位，没有别的选择',
    `补上来的这只这一轮就要接对面的手${foeName ? `（${foeName}）` : ''}`,
    {
      fainted: faintedName,
      bench: picks.map((p) => ({name: p.pet.name, hp: p.pet.hp, maxHp: p.pet.maxHp})),
      foe: foeName,
      foeHp: pos.foe?.hp ?? null,
    },
    switchActionOf(pick),
  );
}

/**
 * 1b. **对手**正在补位（`needs_replacement` 里有 enemy、没有 player）。
 *
 * 为什么单独一条：这一幕的引擎合法动作表**只有换人**（补位阶段两边都只发 switch），
 * 于是玩家屏幕上只有「更换」，很容易被读成「我必须换人」。事实不是：
 *   · 服务端会**自动替对手补位**（`service.py:2451` 的 `for side in queue`），玩家可以什么都不做；
 *   · 玩家主动换人是**允许但不必须**（`service.py` 会把 player 插到队列最前）。
 * 所以这里说的是「等它亮明是谁再决定」这件**具体的事**，以及「真要动就换最厚的哪一只」，
 * 而不是编一句「你的宠倒了」。对手换上来的属性/配招不在公开视图里 —— 进 `risk`，不猜。
 */
function detectFoeReplacing(pos) {
  if (pos.phase !== 'replace') return null;
  if (!pos.needsReplacement.includes('enemy')) return null;
  if (pos.needsReplacement.includes('player')) return null;   // 我方那一档由 replace-required 负责
  const foeName = pos.foe?.name ?? null;
  const pick = pickSwitchTargets(pos)[0] ?? null;
  const pickText = pick && Number.isFinite(pick.pet.hp)
    ? `真要动就换${ref(pick.pet.name)}（${show(pick.pet.hp)} 血，是后备里最厚的），别把还站着的${ref(pos.mine?.name)}主动换下去`
    : '真要动就先换后备里最厚的那一只，别把还站着的这一只主动换下去';
  return candidate(
    'foe-replacing',
    `对面${ref(foeName)}倒下了、正在补位：这一轮你**不必**换人（可以先等它上场）；${pickText}`,
    '引擎这一轮给你的是补位阶段的动作表（只有换人），但 `needs_replacement` 里有 enemy、没有 player —— 要补位的是对面，不是你',
    '它换上来的那一只是什么系、会什么招不在公开视图里：等它亮明再决定打谁；别在这一轮把健康的伙伴白换下去',
    {foe: foeName, needsReplacement: [...pos.needsReplacement],
      bench: pick ? {name: pick.pet.name, hp: pick.pet.hp, maxHp: pick.pet.maxHp} : null,
      myActive: pos.mine?.name ?? null},
    null,
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
      legalByName(pos, steady.label),
    );
  }
  if (maybe) {
    return candidate(
      'ko-maybe',
      `${ref(maybe.label)}估 ${show(maybe.min)}~${show(maybe.max)}，对面 ${show(foeHp)} 血：收得掉是运气，收不掉就白亏一轮`,
      `估算的上下界跨过了对面的血线（${show(foeHp)}），所以这不是一个稳的收线`,
      '这一下收不掉就白送对面一轮，想稳就先别赌',
      {foe: foeName, foeHp, move: maybe.label, estimate: {min: maybe.min, max: maybe.max}, formulaVerified: preview.formula_verified === true},
      legalByName(pos, maybe.label),
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
function detectFoeLowHp(pos, plan) {
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
    // 「补掉它」得有一招能补：只认合法招里**有估算数据**的那一条，没有就不编一个招名。
    bestLegalAttack(pos, plan),
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
    switchActionOf(pick),
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
      energyItem,
    );
  }
  if (!decisive || !bestCastable) return null; // 说不出「改放什么」、或换招也救不了 → 不开口
  return candidate(
    'energy-short',
    `能量不够收它：先用${ref(bestCastable.label)}顶这一轮，攒够再放${ref(bestBlocked.label)}`,
    `${ref(bestBlocked.label)}估 ${estimateText(bestBlocked.min, bestBlocked.max)} 盖得过对面 ${show(foeHp)} 血，但能量还差 ${show(deficit)} 点`,
    `这一轮只能用${ref(bestCastable.label)}这种小招，对面会趁这一轮压过来`,
    {energy, cost, move: bestBlocked.label, alternative: bestCastable.label, estimate: {min: bestCastable.min, max: bestCastable.max}, foeHp, decisive},
    legalByName(pos, bestCastable.label),
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
    // 「拖住」得有一个真的能拖的合法动作：只认「防御」（引擎的减伤/回能动作）。
    // 拿不到就为 null —— 这句话仍然是立场与风险，但**不假装**有一条具体行动。
    legalByName(pos, '防御'),
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
      legalByName(pos, name),
    );
  }
  return candidate(
    'type-resisted',
    `${ref(name)}打${foeName ? ref(foeName) : '对面'}只有抵抗${damageNote}：别再硬用它`,
    `上一手${ref(name)}被对面属性抵抗，这一轮再用就是同样的轻伤害`,
    '硬打这一手等于把回合让给对面，改招或先换人都比它强',
    evidence,
    // 「别再硬用它」必须给出一条**替代**的合法动作：优先「换成另一招」，
    // 没有别的招才退回换人（后者在文本里已经说了「或先换人」）。
    legalSkills(pos).find((one) => one.label !== name) ?? switchActionOf(pickSwitchTargets(pos)[0]) ?? legalByName(pos, name),
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
      // 「压上去」= 先手出一招：合法招里估算最高的那一条（拿不到估算就为 null）。
      bestLegalAttack(pos, null),
    );
  }
  const defend = hasLegalName(pos, '防御');
  return candidate(
    'speed-decides',
    `它速度 ${show(foeSpe)} 快过你 ${show(mineSpe)}：别硬对拼，${defend ? '先换人或者用「防御」顶这一下' : '这一轮先换人躲一下'}`,
    `对面的速度比你高，同档对拼是它先出手`,
    '硬拼的话这一下会先落在你身上',
    {mySpe: mineSpe, foeSpe, foe: foeName, defendLegal: defend},
    legalByName(pos, '防御') ?? switchActionOf(pickSwitchTargets(pos)[0]),
  );
}

/**
 * 11. 对面能量快满了：下一手随时可能是重招。只提醒风险，不替玩家挑招。
 *
 * 上限来自公开视图（`pos.energyMax`，服务端从规则配置里带下来）。**读不到上限就沉默**：
 * 这句话里唯一有价值的数字就是「上限」，判据不够就开口等于编规则。
 * 沉默是允许的（见文件头的第三条纪律），所以这里不用一个抄来的默认值兜底。
 */
function detectFoeEnergyHigh(pos) {
  const foe = pos.foe;
  const energy = num(foe?.energy);
  const energyMax = num(pos.energyMax);
  if (!foe || foe.fainted || energy === null || energyMax === null) return null;
  if (energy < FOE_ENERGY_ALERT) return null;
  return candidate(
    'foe-energy-high',
    `对面能量到 ${show(energy)} 了（上限 ${show(energyMax)}）：重招随时来，别拿残血硬接这一手`,
    // ⚠ 2026-09-30 **改钉**（根治：跨对象串号）：原来是「**它**能量已经攒到 N」——
    // 代词「它」在下游被改写成某只精灵的名字时，**名字与数字可以来自不同对象**
    // （实测：`缇塔=后备` 的名字 + `多彩方方=场上` 的 9 能量 ⇒「缇塔它能量已经攒到 9」，而缇塔自己没动过）。
    // 治法是把**主语写成同一个快照里的那个对象**（`foe.name` + `foe.energy` 同源）⇒ 名字与数字
    // **结构上不可能再分家** ✓。旧句原文留档（改钉不删）：
    //   `它能量已经攒到 ${show(energy)}（上限 ${show(energyMax)}），这一轮随时放得出重招`
    `${foe.name} 能量已经攒到 ${show(energy)}（上限 ${show(energyMax)}），这一轮随时放得出重招`,
    '这一下硬接可能直接倒一只，先把厚的那只留在场上',
    {foe: foe.name, foeEnergy: energy, energyMax, foeHp: foe.hp},
    // 「先把厚的那只留在场上」= 换人顶上；没有能换的就用「防御」顶。两条都不合法时如实为 null。
    switchActionOf(pickSwitchTargets(pos)[0]) ?? legalByName(pos, '防御'),
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
  (pos, plan) => detectFoeReplacing(pos, plan),
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
  // 引擎这一轮**没有任何合法动作** ⇒ 没什么可建议的（对手正在补位、或这一局要结算了）。
  // 没有这一条时，属性/速度那些检测器仍会对着一个"没有按钮可点"的局面开口
  //（实测：对手补位的那一手会给出一句「你速度更快，先手压上去」）—— 那是噪声，不是建议。
  if (!pos.legal.length) return null;

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
      // U09/U08 的机器可读那一栏：这一条建议**指向哪个合法动作**。
      // 加性字段 —— 老的调用方（只读 text/why/risk/evidence）逐字节不变。
      action: actionRefOf(pos, picked.action),
    };
  }
  // 没有一条局面事实值得说 → 沉默。这里**不**回退到「引擎推荐了什么」：
  // 「推荐 X」不是决策依据，硬说出来就是这一层要修掉的那个毛病。
  return null;
}

/** 本层可能产出的全部标签（测试与页面按它断言，别在别处再抄一份）。 */
export const COACH_ADVICE_KINDS = Object.freeze(Object.keys(KIND_PRIORITY));

// ─────────────────────────────────────────────────────────────────────────────
// U08：玩家**明确要建议**时的那一层（局中问答链路）
//
// 背景（用户 2026-09-29 的 12 张截图，第 08 张）：
//   玩家在对局里问建议，小芽回的是
//     「具体这手该出什么，还是你自己定；想让我帮你对比两个选项的差异，说说你倾向哪边。」
//   这句话在 `src/` 里**没有字面量** —— 它是模型自己组出来的。由此得到本任务最重要的
//   一条结论：**建议的保障不能只靠提示词**。提示词能提高概率，但「必须给一个当前合法
//   且有价值的首选行动」是个**硬要求**，所以这里有一层确定性的实现，回答层再拿它做兜底
//   （见 `runtime.js` 的 `adviceEnforcement`）。
//
// 与 `coachAdvice()` 的分工：
//   · `coachAdvice()` 服务**主动气泡**（页面已经有 view，检波器按「值不值得打断」挑）；
//   · `battleAdvice()` 服务**玩家点名要建议**：这时不能沉默，必须给出首选行动 ——
//     检波器命中就用它（它更局面化），一条都不命中就按公开事实做**最小真实比较**。
//
// 三条纪律（每一条都能被机器核对）：
//   ① 行动必须在**当前合法集合**里，并带 `legalActionId`（客户端「查看/采用建议」靠它回填）；
//   ② 只搬公开事实（回合、精灵、血量、能量、引擎的合法动作表与伤害估算），
//      对手后备血量/配招/速度这些没给的**写成 unknown**，不编；
//   ③ 不自动替玩家出招：本层只产出结构与文本，不提交任何动作（没有 fetch、没有副作用）。

/**
 * 「玩家在明确要建议」的问句形状。
 *
 * 为什么必须是**窄表**：它决定「要不要强行塞一条建议」。宽一个词，事实问句
 * （「火系克制什么属性」）就会被吞掉，玩家得到一段答非所问的战术建议 —— 这比沉默更糟。
 * 所以只收三类说法：**现在做什么 / 这一手怎么打 / 换谁**。
 * 调用方必须同时满足「这一局有公开战况」（`context.roco_battle`）才允许命中，
 * 营地/图鉴那些链路一个字都不受影响。
 */
export function rocoAdviceAsk(message) {
  const text = String(message ?? '');
  if (!text) return false;
  return /(?:这一?手|这(?:一)?回合|本回合|当前回合).{0,16}(?:合法首选|首选行动|推荐行动|主要风险)/.test(text)
    || /现在(该怎么办|怎么办|做什么|该做什么|该干什么|该怎么打|该出什么|出什么|打什么|怎么打|该干嘛)/
    .test(text)
    || /(这|本|下)(一)?(手|回合|轮)(该)?(怎么打|怎么办|该出什么|出什么|出哪(一)?招|怎么出|该干嘛|打什么)/.test(text)
    || /该出什么|出什么(招|好)|(该|要)用什么招|出哪一?招|这一手出什么/.test(text)
    || /(该|要|应该)换(谁|哪只|哪一?只|什么|上谁)|换上谁|换谁(好|上|顶)|谁(来|去)顶|补谁/.test(text)
    || /(出招|进攻|打)还是(防御|守|换)|(防御|守)还是(出招|进攻|换)|要不要换(人|宠|只)|该攻还是该守|怎么选/.test(text)
    || /(接下来|下一步|下面)(该)?(做什么|干什么|怎么办|怎么打|该干嘛|怎么走)/.test(text)
    || /(给|来|出)(我)?(个|条|点)?建议|有什么建议|帮我(选|挑|定)|我该怎么选/.test(text)
    // 第 8 组（2026-10-01，B2/P1-A 同族）：**比较类**问句 —— 见 `isCompareAsk()`（**单一出处**，
    //   `rocoAdviceAsk()` 与 `rocoAdviceKind()` 都引用它，两处口径不许各自漂移）。
    || isCompareAsk(text)
    // 第 9 组（2026-10-01，05.1b）：**合法性/机制缺口**问句 —— 「这招能不能用」。
    //   现场：这一格旧词表一条都不命中 ⇒ 落 `companion` 回「说清你问的是哪一块（配招/先手/队伍），我按事实答。」
    //   —— 而**合法性正是本层的看家本事**（行动必须在当前合法集合里、带 `legalActionId`：
    //   `coach-advice.js` 文件头那三条纪律的第 ① 条）。窄表纪律不变：**必须点名"这一招/这手/这个技能"
    //   这类主语 + 用不用的疑问**，不是泛指（「能不能用这个思路打」不许被吞）。
    || /(这一?招|这一?手|这个?技能|这招|大招).{0,6}(能不能用|能不能出|能用吗|能用么|出得来吗|可用吗|管用吗|有用吗|划不划算)/.test(text)
    || /(能不能|可以|能).{0,4}(用|出).{0,2}(这一?招|这一?手|这个?技能)/.test(text);
}

/**
 * **比较类**问句（2026-10-01，B2）：比较词与承伤/生存词**同现**才算。**单一出处** ——
 * `rocoAdviceAsk()` 与 `rocoAdviceKind()` 都引用它（05.1c 的"两套口径只许一处定义"在本文件内先落地）。
 *
 * 为什么必须窄：文件头逐字写着「宽一个词，事实问句（火系克制什么属性）就会被吞掉，玩家得到一段
 * 答非所问的战术建议 —— 这比沉默更糟」。只说「承伤是什么」是机制题，归事实层。
 */
function isCompareAsk(text) {
  return /(?:比较|对比).{0,32}(?:承伤|挨打|耐打|抗打)/.test(text)
    || (/(谁|哪(?:一)?只|哪个|这两只|这两个)/.test(text) && /(更|比较)/.test(text)
      && /(承伤|挨打|耐打|抗打|更扛|扛得住|顶得住|站得住)/.test(text))
    || /(承伤|挨打|耐打|抗打).{0,16}(更低|更少|更小|怎么比|如何比|比较一下|比较|哪个更好)/.test(text)
    || /(扛得住|顶得住|站得住).{0,6}(吗|么|这一下|这一手|这一招)/.test(text);
}

/**
 * 问句分类（2026-10-01，task-51 第 3 步；口径来自 lead-mac 的 `FIXPACK-coach-comparison-question`）：
 * `'compare'`（比较 / 哪个更 / 差多少）· `'recommend'`（现在该出什么 / 这手怎么打 / 换谁）· `'fact'`（其余）。
 *
 * 为什么需要它：`runtime.js` 的**强制层没有"问句类型"概念** —— 它把比较类回答按
 * 「一个首选 + 理由 + 风险」的推荐契约校验，不合格就**替换成通用首选稿** ⇒ 玩家问「0.5 与 1 怎么比」，
 * 拿到的却是「首选换缇塔上场」（真机确证）。分类是那条修法的**唯一入口**：调用方按
 * `kind==='compare'` 跳过强制（跨文件 API 已冻结：`enforceBattleAdvice(advice, text, {kind})`）。
 */
export function rocoAdviceKind(message) {
  const text = String(message ?? '');
  if (!text) return 'fact';
  if (isCompareAsk(text)) return 'compare';
  return rocoAdviceAsk(text) ? 'recommend' : 'fact';
}

/**
 * 手游快照（`context.roco_battle`）→ 本层认得的局面。
 *
 * 为什么不复用 `readPosition()`：那是给**公开视图**（`self.pets[] / opponent.field`）写的，
 * 而 `/api/coach` 送上来的是**裁过的一层**（`self[] / foe[0] / legal[{label,kind}]`）。
 * 少认一种形状的后果不是报错，而是建议层安静地拿不到局面 —— 那正是要修的东西。
 * 两份形状的**事实来源是同一个**（引擎的 `ui_public_view`），这里只做字段搬运。
 */
function positionFromSnapshot(battle, plan = null) {
  if (!isObj(battle)) return null;
  const self = Array.isArray(battle.self) ? battle.self : [];
  if (!self.length) return null;
  const activeIndex = Number.isInteger(battle.self_active) ? battle.self_active : 0;
  const petOf = (row, index) => ({
    name: str(row?.name) ?? str(row?.pet_id),
    types: Array.isArray(row?.types) ? row.types.slice() : [],
    // 速度：快照里没有（客户端只搬 label/kind 与血量）。没有就是 null，
    // 「谁先动」那类结论因此不会在问答链路上出现（宁可不说）。
    spe: num(row?.spe) ?? num(row?.stats?.spe),
    hp: num(row?.hp),
    maxHp: num(row?.max_hp),
    energy: num(row?.energy),
    fainted: row?.alive === false || num(row?.hp) === 0,
    statuses: statusMap(isObj(row?.statuses) ? row.statuses : (str(row?.status) ? {[row.status]: {}} : null)),
    slot: index,
  });
  const myPets = self.map(petOf);
  const foeRow = Array.isArray(battle.foe) && isObj(battle.foe[0]) ? battle.foe[0] : null;
  const foe = foeRow ? petOf(foeRow, 0) : null;
  const foeBench = (Array.isArray(battle.foe_bench) ? battle.foe_bench : []).map((row) => ({
    name: null, types: [], spe: null, hp: null, maxHp: null, energy: null,
    fainted: row?.fainted === true, statuses: {}, slot: num(row?.slot),
  }));
  const legal = (Array.isArray(battle.legal) ? battle.legal : []).map((one, index) => readAction(one, index)).filter(Boolean);
  return {
    phase: str(battle.phase),
    turn: num(battle.turn),
    result: battle.result ?? null,
    mine: myPets[activeIndex] ?? null,
    myActiveIndex: activeIndex,
    myPets,
    myBench: myPets.filter((_, index) => index !== activeIndex),
    foe,
    foeBench,
    energyMax: num(battle.self_energy_max),
    legal,
    skills: [],
    events: [],
    //: 2026-09-30（P0 旁路缺陷收口）：**这里原来写死 `[]`** ⇒ 引擎给的 `needs_replacement` 被丢掉 ✗
    //:  下游有**五个**消费者直接 `.includes(...)`（`:567` `:604` `:605` `:1118` `:1393`）⇒
    //:  所以**不能改成 `null`**（那五个会 TypeError ✗），`[]` 兜底要保留（保持数组契约 ✓）。
    //:  ⚠ `[]` 在这里**兼表「不需要补位」与「没读到」**；更正确的形状是 `null`，
    //:    但那要先把上面五个消费者改成容错 ⇒ 记档在这里，等那一步做完再谈 ✗
    //:  旧行留档（**改钉不删**）：`needsReplacement: [],`
    needsReplacement: Array.isArray(battle.needs_replacement) ? battle.needs_replacement.slice() : [],
    // 局面指纹的原料：回合 + 阶段 + 版本 + 合法动作表。任何一项变了，旧建议就不属于这个局面。
    stateVersion: Number.isInteger(battle.state_version) ? battle.state_version : null,
  };
}

/** 标签归一：去引号/空白，用来把「引擎推荐的那一项」认回合法动作表里的同一条。 */
function labelKey(value) {
  return String(value ?? '').replace(/[「」“”"'\s·，,。:：]/g, '');
}

/**
 * 最小真实比较（**不依赖 roco_plan**）：从当前合法集合里挑一条首选行动。
 *
 * 次序的口径（每一步都只用公开事实）：
 *   ① 必须补位 → 补位（引擎在 replace 阶段给的就只有 switch 动作）；
 *   ② 引擎这一轮的推荐**确实是合法动作** → 用它（它已经把双方应对算过一遍）；
 *   ③ 有伤害估算时：先看有没有一招的下界就盖过对面血量（收线），再看估算最高的那条；
 *   ④ 都没有 → 合法招里的第一条，并如实写「这一手没有估算数据」。
 * 每一步都返回 `reason`，玩家看得到「为什么是它」；拿不到的部分进 `unknown`。
 */
function primaryFromFacts(pos, plan) {
  const estimates = estimateTable(pos, plan);
  const foeHp = num(pos.foe?.hp);
  const refOf = (action) => actionRefOf(pos, action);
  const switchEntry = pickSwitchTargets(pos)[0] ?? null;

  // ① 必须补位：判据是**引擎说 player 要补位**（或我方场上那只真的倒了），
  //    不是「阶段叫 replace」—— 后者在对手补位时同样成立（见 `detectReplaceRequired` 的说明）。
  const mineHpRaw = num(pos.mine?.hp);
  if (pos.needsReplacement.includes('player') || pos.mine?.fainted === true || (mineHpRaw !== null && mineHpRaw <= 0)) {
    if (switchEntry) {
      return {
        ref: refOf(switchActionOf(switchEntry)),
        reason: pos.mine?.name
          ? `${pos.mine.name}已经倒下，这一手只能补位（引擎在补位阶段给的合法动作里只有换人）`
          : '场上的伙伴已经倒下，这一手只能补位（引擎在补位阶段给的合法动作里只有换人）',
        upside: `${switchEntry.pet.name}现在 ${show(switchEntry.pet.hp)}/${show(switchEntry.pet.maxHp)} 血，补位不占回合`,
        risk: `补上来的这一只这一轮就要接对面的手${pos.foe?.name ? `（${pos.foe.name}）` : ''}`,
        unknown: pos.foe?.hp === null ? ['对手场上那只的血量不在公开视图里'] : [],
      };
    }
    return null;
  }

  // ② 引擎的推荐：**只在它真的是合法动作时**才算建议（不然就是把一个不属于当前局面的结论端出去）。
  const rec = str(plan?.recommendation);
  if (rec) {
    const key = labelKey(rec);
    const hit = pos.legal.find((one) => labelKey(one.label) === key)
      ?? pos.legal.find((one) => one.name && labelKey(one.name) === key)
      ?? pos.legal.find((one) => one.kind === 'switch' && switchPetName(pos, one) && labelKey(switchPetName(pos, one)) === key)
      ?? null;
    if (hit) {
      const branches = num(plan?.branches_evaluated);
      const stable = plan?.recommendation_stable === true;
      return {
        ref: refOf(hit.kind === 'switch' ? {...hit, targetName: switchPetName(pos, hit)} : hit),
        reason: `引擎把这一回合的双方应对算过一遍${branches === null ? '' : `（${show(branches)} 个分支）`}，推荐的就是这一项`
          + `${stable ? '，而且推荐在多个分析种子里是稳的' : ''}`,
        upside: upsideOfAction(pos, plan, hit),
        risk: riskOfAction(pos, hit, plan),
        unknown: stable ? [] : ['引擎的推荐只在部分分析种子里成立（不稳），换一个种子可能换一手'],
      };
    }
  }

  // ②b 想放的招这一轮放不出来（能量不够是最常见的原因），而它比能放的更狠。
  //     先说这一条，再说「哪一招最高」—— 不然玩家会照着一条被削过的招下注。
  const blocked = blockedDecisiveMove(pos, plan, estimates);
  if (blocked) {
    const legalBest = legalSkills(pos).find((one) => one.label === blocked.legalBestLabel) ?? null;
    const energyItem = pos.legal.find((one) => one.kind === 'item' && labelKey(one.label).includes('能量果')) ?? null;
    const pick = energyItem ?? legalBest ?? pos.legal[0] ?? null;
    if (pick) {
      const energy = num(pos.mine?.energy);
      const energyMax = num(pos.energyMax);
      const energyText = energy === null
        ? '（快照里没有给当前能量）'
        : `（你现在 ${show(energy)} 点能量${energyMax === null ? '' : `，上限 ${show(energyMax)}`}）`;
      return {
        ref: refOf(pick.kind === 'switch' ? {...pick, targetName: switchPetName(pos, pick)} : pick),
        reason: `按引擎这一轮的估算，「${blocked.label}」能打出 ${estimateText(blocked.min, blocked.max)}`
          + `${blocked.foeHp === null ? '' : `（对面剩 ${show(blocked.foeHp)} 血）`}，`
          + `但这一轮它不在合法动作里 —— 引擎没把它列出来${energyText}`,
        upside: upsideOfAction(pos, plan, pick),
        risk: legalBest
          ? `这一轮只能先用「${blocked.legalBestLabel}」顶过去，对面会趁这一轮压过来`
          : '这一轮连一招攻击都放不出来，对面会趁这一轮压过来',
        unknown: [
          `「${blocked.label}」这一轮放不出来的确切原因（快照里没有能耗表，只看得到它不在合法集合里）`,
          '这一只的能耗表（所以我不说「还差几点能量」）',
        ],
      };
    }
  }

  // ③ 伤害估算：先收线，再最高。
  const legalWithEst = legalSkills(pos)
    .map((action) => ({action, est: estimates.get(action.label) ?? null}))
    .filter((row) => row.est && (row.est.max !== null || row.est.min !== null));
  const lethal = foeHp === null ? [] : legalWithEst.filter((row) => row.est.min !== null && row.est.min >= foeHp);
  const ranked = (lethal.length ? lethal : legalWithEst)
    .sort((a, b) => ((b.est.max ?? b.est.min ?? -Infinity) - (a.est.max ?? a.est.min ?? -Infinity))
      || (a.action.legalIndex ?? 0) - (b.action.legalIndex ?? 0));
  if (ranked.length) {
    const best = ranked[0].action;
    return {
      ref: refOf(best),
      reason: lethal.length
        ? `对面${pos.foe?.name ? `「${pos.foe.name}」` : ''}只剩 ${show(foeHp)} 血，「${best.label}」的估算下界（${show(ranked[0].est.min)}）就盖过它，是这一轮能结算掉它的合法行动`
        : `按引擎这一轮的伤害估算，它是当前合法招里打得最重的一条`,
      upside: upsideOfAction(pos, plan, best),
      risk: riskOfAction(pos, best, plan),
      unknown: [],
    };
  }

  // ④ 没有估算数据：给一条**现在就能出手**的合法行动，并说清缺的是什么。
  const firstSkill = legalSkills(pos)[0] ?? null;
  const fallback = firstSkill
    ?? pos.legal.find((one) => one.kind === 'item')
    ?? pos.legal[0]
    ?? null;
  if (!fallback) return null;
  return {
    ref: refOf(fallback.kind === 'switch' ? {...fallback, targetName: switchPetName(pos, fallback)} : fallback),
    reason: firstSkill
      ? '这一轮没有可比较的伤害估算（包里没有引擎的规划），所以只按「现在就能出手」挑：它是合法招里的第一条'
      : '这一轮没有可比较的伤害估算，只能先从合法动作里挑一条现在就能做的',
    upside: upsideOfAction(pos, plan, fallback),
    risk: riskOfAction(pos, fallback, plan),
    unknown: ['这一手的伤害估算（这一轮没有 damage_preview）', '对手这一回合会做什么'],
  };
}

/**
 * 「想放的那一招这一轮放不出来，而它比能放的招更狠」——最小真实比较里的一个真实缺口。
 *
 * 为什么要有它（而不是只靠 `detectEnergyShort`）：那个检测器要**能耗表**
 * （`self.skills` / 合法动作的 `skill.energy`）才敢说「差几点能量」；手游快照只有
 * `{label, kind}`，于是它在问答链路上**恒不成立** —— 玩家问「现在怎么办」时，
 * 引擎估算里那个能收掉对面的招明明在配招表里、却放不出来，建议层却一个字都不提。
 *
 * 这里的口径刻意收窄：只认「不在合法集合里」+「估算比所有合法招都高」两个公开事实，
 * 并且只在**它真的决定这一轮**时才算数（估算盖过对面血量，或者这一轮一招攻击都放不出）。
 * 具体差几点能量**不说** —— 快照里没有能耗表，那是编。缺的那一块进 `unknown`。
 */
function blockedDecisiveMove(pos, plan, estimates = null) {
  const table = estimates ?? estimateTable(pos, plan);
  const legalBest = bestLegalAttack(pos, plan);
  const legalMax = legalBest ? (table.get(legalBest.label)?.max ?? -Infinity) : -Infinity;
  const rows = [...table.entries()]
    .filter(([label]) => !legalByName(pos, label))
    .map(([label, est]) => ({label, min: est.min, max: est.max}))
    .filter((row) => row.max !== null || row.min !== null)
    .sort((a, b) => ((b.max ?? b.min ?? -Infinity) - (a.max ?? a.min ?? -Infinity)));
  const best = rows[0] ?? null;
  if (!best) return null;
  const top = best.max ?? best.min ?? -Infinity;
  if (!(top > legalMax)) return null;                       // 放不出来的那招并不更狠 → 不是问题
  const foeHp = num(pos.foe?.hp);
  const decisive = (foeHp !== null && top >= foeHp) || !legalBest;
  if (!decisive) return null;
  return {...best, legalBestLabel: legalBest?.label ?? null, foeHp};
}

/** 换人动作对应的伙伴名（标签里的位次 → `myPets`）。 */
function switchPetName(pos, action) {
  const index = action?.targetIndex ?? switchIndexFromLabel(action?.label);
  if (index === null || index === undefined) return null;
  return pos.myPets[index]?.name ?? null;
}

/** 收益那一栏：有估算就写估算（带「未核验」），换人/道具写它们真实的代价与作用。 */
function upsideOfAction(pos, plan, action) {
  if (!action) return null;
  if (action.kind === 'switch') {
    const name = switchPetName(pos, action);
    const index = action.targetIndex ?? switchIndexFromLabel(action.label);
    const pet = index === null || index === undefined ? null : pos.myPets[index] ?? null;
    return `${name ? `换${name}上来` : '换人'}${pet && pet.hp !== null ? `（${show(pet.hp)}/${show(pet.maxHp)} 血）` : ''}`
      + `${pos.phase === 'replace' ? '；补位不占回合' : '；这一手会把回合用掉'}`;
  }
  if (action.kind === 'item') return '吃道具占这一回合，之后不能再出招（回血/回能立刻结算）';
  // ⚠ 2026-09-29（人类实测：防御 5→4 **无额外回 2**）：手游引擎**不额外回能**；
  //   「额外回 2 点能量」是 JS 练习引擎（`src/game/rules.js:125`）的语义，别串进来。
  //   旧文案留档（改钉不删）：return '防御能减伤、额外回 2 点能量';
  if (action.kind === 'skill' && labelKey(action.label).includes('防御')) return '防御能减伤';
  const est = action.kind === 'skill' ? estimateTable(pos, plan).get(action.label) ?? null : null;
  if (!est) return '这一条是现在就能出手的合法行动（这一轮没有它的伤害估算）';
  const foeHp = num(pos.foe?.hp);
  const parts = [`按未核验公式估 ${estimateText(est.min, est.max)} 点`];
  if (foeHp !== null) {
    if (est.min !== null && est.min >= foeHp) parts.push(`对面剩 ${show(foeHp)} 血，够收掉`);
    else if (est.max !== null && est.max >= foeHp) parts.push(`对面剩 ${show(foeHp)} 血：有的口径够收，不稳`);
    else parts.push(`对面剩 ${show(foeHp)} 血，这一下收不掉`);
  }
  return parts.join('；');
}

/** 主要风险那一栏：一条，具体的，能对上公开事实的。 */
function riskOfAction(pos, action, plan) {
  if (!action) return null;
  if (action.kind === 'switch') return '换人先结算，但上来的那一只照样可能吃对面这一手';
  if (action.kind === 'item') return '这一轮只吃道具不出招，对面会趁这一轮压过来';
  const key = labelKey(action.label);
  if (key.includes('防御')) return '防御挡不住已有的中毒或灼烧，也不能连用';
  const est = action.kind === 'skill' ? estimateTable(pos, plan).get(action.label) ?? null : null;
  const foeHp = num(pos.foe?.hp);
  if (est && foeHp !== null && est.max !== null && est.max >= foeHp && (est.min === null || est.min < foeHp)) {
    return '估算的上界跨过了对面的血线，这一下不稳：收不掉就白送对面一轮';
  }
  // 没有估算数据时**不许**把「估算来自未核验公式」当风险说 —— 那句话在这里是假的
  // （这一轮根本没有估算），而假话比少说一句糟得多。
  return est
    ? '对面换人可以先躲掉这一下（换人比技能先动）；估算来自未核验公式'
    : '对面换人可以先躲掉这一下（换人比技能先动）；这一手没有伤害估算，打多少要打完才知道';
}

/** 把一条检波器候选翻成 U08 的结构（行动那一栏同样要能被客户端回填）。 */
function adviceFromCandidate(pos, picked, plan) {
  const ref = actionRefOf(pos, picked.action);
  if (!ref) return null;
  return {
    ref,
    reason: picked.why ?? null,
    upside: upsideOfAction(pos, plan, picked.action),
    risk: picked.risk ?? riskOfAction(pos, picked.action, plan),
    unknown: [],
    kind: picked.kind,
  };
}

/**
 * 段首那一行：**引用当前精灵与回合**（U08 要求建议引用当前局面，不是泛泛而谈）。
 * 读不到的字段就不写那一句（宁可短，也不编）。
 */
function situationLine(pos) {
  const parts = [];
  const turn = Number.isInteger(pos.turn) ? `第 ${pos.turn} 回合` : '这一回合';
  const mine = pos.mine;
  const mineText = mine
    ? `${mine.name ?? '场上那只'}${mine.hp !== null && mine.maxHp !== null ? `（${show(mine.hp)}/${show(mine.maxHp)} 血`
      + `${mine.energy !== null ? `，能量 ${show(mine.energy)}` : ''}）` : (mine.energy !== null ? `（能量 ${show(mine.energy)}）` : '')}`
    : null;
  parts.push(mineText ? `${turn}：${mineText}` : turn);
  const foe = pos.foe;
  if (foe) {
    const foeText = `${foe.name ?? '对面场上那只'}${foe.hp !== null ? `（${show(foe.hp)}${foe.maxHp !== null ? `/${show(foe.maxHp)}` : ''} 血` : ''}`
      + (foe.hp !== null ? '）' : '');
    parts.push(`对手是${foeText}`);
  }
  return `${parts.join('，')}。`;
}

/**
 * 局中「明确要建议」的确定性建议（U08 的唯一入口）。
 *
 * @param {{battle?: object, plan?: object, message?: string}} input
 *   `battle` = `context.roco_battle`（引擎公开视图裁出来的那一层）
 *   `plan`   = `context.roco_plan`（引擎这一轮的规划；**可以为空** —— 缺它也要能建议）
 * @returns {null | {
 *   headline: string, reason: string, upside: string, risk: string,
 *   alternates: Array<{label:string,kind:string,legalActionId:string,note:string}>,
 *   actionLabel: string, actionKind: string, legalActionId: string, legalIndex: number|null,
 *   turn: number|null, phase: string|null, stateVersion: number|null, fingerprint: string,
 *   unknown: string[], evidence: object, kind: string|null, text: string,
 * }}
 */
export function battleAdvice({battle = null, plan = null, message = null} = {}) {
  // 比较类问句**不走推荐契约**（见 `rocoAdviceKind` 的注释）：它要的是"比一比"，不是"出哪一手"。
  const advice = rocoAdviceKind(message) === 'compare' ? compareAdvice(battle, message)
    : withAffinityLimits(adviceForPosition(positionFromSnapshot(battle, plan), plan), battle);
  return advice ? {...advice, battleId: typeof battle?.battle_id === 'string' ? battle.battle_id : null} : null;
}

/**
 * **比较类**建议（2026-10-01，task-51 第 3 步 / lead-mac 的 FIXPACK）：
 * 玩家问「A 与 B 的承伤怎么比」，回答就**真的做比较** —— 引用 B3 送上来、**有出处**的倍率，
 * 说出谁更扛，并如实交代读不到的那几层。
 *
 * 三条纪律：
 *   ① **不是推荐**：本函数产出的正文**不许出现「首选行动」**（玩家问的不是"出哪一手"）；
 *   ② **倍率有出处**：数字**只**来自 `battle.affinity.rows`（页面用 `incomingAffinity()` 从生成产物算的），
 *      本层**不重算**；拿不到 ⇒ 正文写「读不到」，**一个数字都不编**；
 *   ③ 结构化字段照旧给（`kind:'compare'`），调用方按 `kind` 跳过强制层（跨文件 API 已冻结）。
 */
/** Explicit incoming type belongs to the requested comparison, never to the current foe.
 * Negated/conditional clauses are separate questions: “not light” supplies no substitute type.
 */
export function comparisonTypeRequest(message) {
  const clauses = String(message ?? '').split(/[。！？?；;]/).filter(Boolean);
  const comparison = (clauses.find(c => /承伤|挨打|耐打|抗打|更扛|扛得住|顶得住|站得住/.test(c)) ?? '').split(/(?:如果|假如|若|要是)/)[0];
  const positive = comparison.replace(/(?:不比较|不是|非|不要|不用|别用)[^，,]*/g, '');
  const types = [...new Set(positive.match(/(?:普通|机械|[\u4e00-\u9fff])系/g) ?? [])];
  const normalized = types.filter(t => t !== '关系');
  const unspecified = !normalized.length && /(?:不是|非).{0,3}系/.test(comparison);
  const conditional = clauses.some(c => /(?:如果|假如|若|要是).*(?:不是|非).{0,3}系/.test(c));
  return {comparisonText: positive, attackType: normalized.length === 1 ? normalized[0] : null,
    ambiguous: normalized.length > 1 || unspecified, conditional};
}

function compareAdvice(battle, message) {
  const view = battle && typeof battle === 'object' ? battle : {};
  const self = Array.isArray(view.self) ? view.self : [];
  const foe = Array.isArray(view.foe) ? view.foe[0] : null;
  const turn = Number.isInteger(view.turn) ? view.turn : null;
  const head = `${turn === null ? '' : `第 ${turn} 回合。`}${foe?.name ? `对手场上：${foe.name}。` : ''}`;
  const request = comparisonTypeRequest(message);
  const unread = (reason, targets = []) => ({kind: 'compare', headline: '比一比', reason,
    upside: null, risk: null, alternates: [], unknown: [reason],
    evidence: {turn, targets, compared: [], source: null},
    actionLabel: null, legalActionId: null, legalIndex: null, text: `${head}${reason}。` + (request.conditional ? '如果招式不是原比较属性，新的攻击属性未指定，请说明具体攻击属性再比较。' : '')});
  // Bind only names actually present in the public roster. Unknown aliases and duplicate
  // individual names require clarification; neither a ranking nor a species id resolves them.
  const names = new Map();
  for (const pet of self) {
    if (typeof pet?.name !== 'string' || !pet.name || typeof pet.pet_id !== 'string') continue;
    if (!names.has(pet.name)) names.set(pet.name, []);
    names.get(pet.name).push(pet);
  }
  const mentioned = [...names.entries()].filter(([name]) => request.comparisonText.includes(name));
  const ambiguous = mentioned.find(([, pets]) => pets.length !== 1);
  if (ambiguous) return unread(`「${ambiguous[0]}」有同名个体，对象不明确，请说明要比较哪一只`);
  if (mentioned.length !== 2) return unread('请点名公开队伍中要比较的两只；未识别的名字或别名请先确认');
  mentioned.sort(([a], [b]) => request.comparisonText.indexOf(a) - request.comparisonText.indexOf(b));
  const targets = mentioned.map(([, pets]) => ({pet_id: pets[0].pet_id, name: pets[0].name}));
  if (request.ambiguous) return unread('来袭属性不明确，请指定要比较哪一种攻击属性', targets);
  const rows = [];
  for (const target of targets) {
    const matches = (Array.isArray(view.affinity?.rows) ? view.affinity.rows : [])
      .filter((row) => row?.pet_id === target.pet_id && row.known !== false && Number.isFinite(row.multiplier)
        && (!request.attackType || row.vs_type === request.attackType));
    if (matches.length !== 1) return unread(`「${target.name}」${request.attackType ? `对${request.attackType}` : ''}的承伤倍率读不到或不明确，不能用其他属性或宠物替代`, targets);
    rows.push({...target, multiplier: matches[0].multiplier,
      vsType: typeof matches[0].vs_type === 'string' ? matches[0].vs_type : null});
  }
  const pairs = rows.map((row) => `${row.name} 承伤 ${row.multiplier}`
    + (row.vsType ? `（${row.vsType}）` : '')).join('、');
  const [first, second] = rows;
  let meaning;
  if (!first.vsType || first.vsType !== second.vsType) {
    meaning = '这些倍率对应的来袭属性不同或未知，不能当作同一招直接排承伤高低';
  } else if (first.multiplier === second.multiplier) {
    meaning = '两只对这个属性的承伤倍率相同；实际伤害还取决于技能、攻防与个体配置，不能据此判断掉血多少';
  } else {
    const lower = first.multiplier < second.multiplier ? first : second;
    meaning = `${lower.name} 对这个属性的承伤倍率更低（倍率越小，属性减伤越有利）；实际伤害还取决于技能、攻防与个体配置`;
  }
  const unknown = ['这里只比较公开属性相性；对手下一招的属性和隐藏配置未知，不代表实际伤害预测'];
  if (request.conditional) unknown.push(`如果招式不是${request.attackType ?? '原比较属性'}，新的攻击属性未指定，不能继续沿用这些倍率；请说明具体攻击属性再比较`);
  return {kind: 'compare', headline: '比一比：' + pairs, reason: meaning, upside: null, risk: null,
    alternates: [], unknown,
    evidence: {turn, targets, compared: rows, source: typeof view.affinity?.source === 'string' ? view.affinity.source : null},
    actionLabel: null, legalActionId: null, legalIndex: null, phase: 'compare',
    text: `${head}比一比：${pairs}。${meaning}。`
      + (typeof view.affinity?.source === 'string' ? '这些倍率依据公开属性相性表，比较的是这两只对来袭属性的抗性。' : '')
      + unknown.join('；') + '。'};
}

/**
 * B3（2026-10-01）：把页面送上来的**承伤相性读数**里「读不到的那几只」并进建议的「不知道」一栏。
 *
 * 为什么在这一层做：`battleAdviceText()` 已经把 `advice.unknown` 渲染成
 * 「我这里不知道的：…」——这正是「拿不到就如实说」的那条既有通道（不新增话术、不新增出口）。
 * **只引用、不重算**：本层没有相性表，也不该有第二份实现（`type-affinity.js` 是唯一来源）；
 * 名字也从 `battle.self/foe` 的公开面取，**不把内部 id 端给玩家**。
 * 加性：老上下文没有 `affinity` ⇒ 原样返回（一个字不变）。
 */
function withAffinityLimits(advice, battle) {
  if (!advice) return advice;
  const unread = Array.isArray(battle?.affinity?.unavailable) ? battle.affinity.unavailable : [];
  if (!unread.length) return advice;
  const nameOf = new Map();
  for (const row of [...(Array.isArray(battle?.self) ? battle.self : []),
    ...(Array.isArray(battle?.foe) ? battle.foe : [])]) {
    if (row && typeof row.pet_id === 'string' && typeof row.name === 'string' && row.name) {
      nameOf.set(row.pet_id, row.name);
    }
  }
  const lines = unread
    .filter((row) => row && typeof row.reason === 'string' && row.reason)
    .map((row) => `「${nameOf.get(row.pet_id) ?? '场上一只'}」这一只的承伤相性我没有：${row.reason}`)
    .slice(0, 6);
  if (!lines.length) return advice;
  return {...advice, unknown: [...(Array.isArray(advice.unknown) ? advice.unknown : []), ...lines]};
}

/**
 * 主动气泡那一路的确定性兜底：**公开视图**（`rocoIntervention` 手里那一份）→ 建议。
 *
 * 为什么需要它：分数层（`interventionScore`）判 decisive 时，门控已经放行，而建议层的
 * 检测器可能一条都够不上（例如只剩低血量、后备里没有更厚的、也没有伤害估算）。
 * 那时的正确行为不是「静默」——静默会让回执看起来像「该说没说」，玩家也拿不到任何东西。
 * 这里用**同一套**最小真实比较算出一条合法首选行动。
 *
 * `session` 传进来是为了复用同一条去重口径（`session.said` 里已经有这个形状就不再说）——
 * 重复本身就是在浪费玩家的注意力（U09）。
 */
export function adviceForView(view, plan = null, {session = null} = {}) {
  const pos = readPosition(view);
  if (!pos || pos.result || pos.phase === 'ended') return null;
  if (!pos.legal.length) return null;
  const advice = adviceForPosition(pos, plan);
  if (!advice) return null;
  if (alreadySaid(session, normaliseAdviceShape(advice.text))) return null;
  return advice;
}

/** 建议的**唯一**装配点：局面 → 结构 + 正文（`battleAdvice` 与 `adviceForView` 都走它）。 */
export function adviceForPosition(pos, plan = null) {
  if (!pos || pos.result || pos.phase === 'ended') return null;
  if (!pos.legal.length) return null;

  // 检波器先来：它按「哪一条局面事实最值得说」排序（补位 > 收线 > 换血 > 能量 > …），
  // 命中时它的措辞比通用比较准。一条都不命中（平稳回合）才退回最小真实比较。
  // 「这一手只能补位」= 引擎在补位阶段/我方倒下时只给 switch 动作（与 experience.js 的
  // `situationRisk` 同一口径）。兜底 kind 用它把「必须补位」与「一般首选行动」分开。
  const mineHpForKind = num(pos.mine?.hp);
  const mustReplace = pos.needsReplacement.includes('player')
    || pos.mine?.fainted === true || (mineHpForKind !== null && mineHpForKind <= 0);
  const picked = DETECTORS.map((detect) => detect(pos, isObj(plan) ? plan : null)).find(Boolean) ?? null;
  const base = (picked ? adviceFromCandidate(pos, picked, plan) : null) ?? primaryFromFacts(pos, plan);
  if (!base?.ref) return null;

  const ref = base.ref;
  const actionLabel = ref.display ?? ref.label;
  // 段首已经引用过回合与精灵，标题里不再重复「第 N 回合」—— 复读正是 U10 要修的那种毛病。
  const headline = ref.kind === 'switch' ? `换${actionLabel}上场` : `出「${actionLabel}」`;
  const fingerprint = [pos.turn ?? '?', pos.phase ?? '?', pos.stateVersion ?? '?',
    pos.legal.map((one) => `${one.kind}:${one.label}`).join('|')].join('@');
  // 只列**真的缺**的那几项。不写「对手这一回合的选择」这种放之四海皆准的话 ——
  // 那不是「哪一项未知」，是一句谁都知道的废话（U09 的同一条口径：没有信息量就不说）。
  const unknown = [...new Set(base.unknown ?? [])].filter((row) => typeof row === 'string' && row);
  const estimates = estimateTable(pos, plan);
  const est = ref.kind === 'skill' ? estimates.get(ref.label) ?? null : null;

  const advice = {
    headline,
    reason: base.reason,
    upside: base.upside,
    risk: base.risk,
    alternates: alternatesOf(pos, ref, plan),
    actionLabel,
    actionKind: ref.kind ?? null,
    legalActionId: ref.legalActionId,
    legalIndex: ref.legalIndex,
    // 与 `coachAdvice()` 同一形状的**可执行目标**：客户端渲染「查看 / 采用建议」都读它
    // （`legalActionId` 用来回填当前合法动作表里那一项，`display` 是给玩家看的名字）。
    action: ref,
    // 行动**同时**带上引擎给的原始标签：客户端「采用」时按它回填合法表里那一项。
    legalLabel: ref.label ?? null,
    turn: pos.turn,
    phase: pos.phase,
    stateVersion: pos.stateVersion,
    fingerprint,
    unknown,
    // 这一条建议属于哪一类局面事实。**兜底那一支也必须给一个契约里的 kind** ——
    // 客户端的浮条按「有没有 kind」判有没有信息量，null 会被当成「没话说」而把气泡藏掉。
    kind: base.kind ?? picked?.kind ?? (mustReplace ? 'replace-required' : 'primary-action'),
    evidence: {
      turn: pos.turn,
      my: pos.mine ? {name: pos.mine.name, hp: pos.mine.hp, maxHp: pos.mine.maxHp, energy: pos.mine.energy} : null,
      foe: pos.foe ? {name: pos.foe.name, hp: pos.foe.hp, maxHp: pos.foe.maxHp, energy: pos.foe.energy} : null,
      legal: pos.legal.map((one, index) => ({legalActionId: legalActionIdOf(one, index), kind: one.kind, label: one.label})),
      estimate: est ? {min: est.min, max: est.max} : null,
      plan_recommendation: str(plan?.recommendation),
      plan_branches: num(plan?.branches_evaluated),
    },
    // 结构化字段之外的**可读正文**：无模型档直接用它；有模型时它是兜底与校对基准。
    text: null,
  };
  advice.text = battleAdviceText(advice, pos);
  return advice;
}

/**
 * 建议写成玩家读得懂的一段话。
 *
 * 每一栏都必须能对上 `advice.evidence` 里的公开事实（这是这一段的判据，不是文风）：
 *   局面 → 首选行动 → 为什么 → 收益 → 主要风险 → 备选 → 未知 → 不会替你出招。
 */
export function battleAdviceText(advice, pos = null) {
  if (!advice) return null;
  const lines = [];
  const position = pos ?? {turn: advice.turn, phase: advice.phase, mine: null, foe: null};
  const intro = pos ? situationLine(pos) : (Number.isInteger(advice.turn) ? `第 ${advice.turn} 回合。` : '');
  if (intro) lines.push(intro);
  lines.push(`首选行动：${advice.headline}（引擎给的合法动作：${advice.legalLabel ?? advice.actionLabel}）。`);
  if (advice.reason) lines.push(`为什么是它：${advice.reason}。`);
  if (advice.upside) lines.push(`收益：${advice.upside}。`);
  if (advice.risk) lines.push(`主要风险：${advice.risk}。`);
  if (Array.isArray(advice.alternates) && advice.alternates.length) {
    lines.push(`备选：${advice.alternates.map((row) => `${row.label}（${row.note}）`).join('；')}。`);
  }
  if (Array.isArray(advice.unknown) && advice.unknown.length) {
    lines.push(`我这里不知道的：${advice.unknown.join('；')}。`);
  }
  lines.push('以上都来自这一轮的公开局面与引擎估算（不是胜率）；我不会自动替你出招，采用与否由你决定。');
  return lines.join('');
}

/** A card is usable only in the battle and version for which it was produced. */
export function adviceSnapshotFresh(advice, battleId, view) {
  return typeof battleId === 'string' && battleId.length > 0 && advice?.battleId === battleId
    && Number.isInteger(advice?.stateVersion) && advice.stateVersion === view?.state_version
    && !view?.battle_result && view?.phase !== 'ended';
}

/** Public battle identity for late-response checks; no hidden state participates. */
export function coachBattleStamp(context) {
  const b = context?.roco_battle;
  if (!b) return null;
  return JSON.stringify([b.battle_id ?? null, b.state_version ?? null, b.turn ?? null, b.self_active ?? null, b.phase ?? null, b.result ?? null]);
}
