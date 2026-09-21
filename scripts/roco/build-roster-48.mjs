// 48 只 Demo 名单生成器（第 46 轮 · 只设计/审计，不改引擎）
//
// 输入（全部只读，零 npm 依赖）：
//   data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/Catalog.lua   ← 622 只全量图鉴
//   data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/Learnsets.lua ← 312 张学习表
//   data/roco/normalized/roco-world-s4-2026-09-10/skills.json                    ← 824 条技能（规范化）
//   data/roco/normalized/roco-world-s4-2026-09-10/pets.json                      ← 现有 12 只（必须包含）
//
// 输出：
//   reports/roco/coverage/roster-48.json  机器可读名单（含每字段 provenance）
//   docs/roco/ROSTER-48.md                人类可读名单
//
// 纪律：
//   · 只用手机游戏快照数据；不引入任何外部/社区推荐。
//   · 选择规则写死在代码里，可复现、可反驳；每条入选理由都指向字段或统计量。
//   · 不知道就写不知道：机制只从技能描述文本标注（与 build-support-matrix.mjs 同一套正则），
//     不推断结算时序；引擎是否真的会算由 scripts/roco/classify-roster-support.py 单独判定。
//   · 失败要响：任一硬约束（18 属性 / 角色配额 / 速度档配额 / 硬机制覆盖）没满足就抛错退出。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseLuaTable, luaArrayToArray } from './lua-safe-parse.mjs';
import { DEFAULT_RULESET_CONFIG_ID, readRulesetConfig } from './ruleset-energy.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const RAW = ROOT + 'data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/';
const NORM = ROOT + 'data/roco/normalized/roco-world-s4-2026-09-10/';
const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const SIZE = Number(argOf('--size', '48'));
if (!Number.isInteger(SIZE) || SIZE < 1) throw new Error('--size 必须是正整数');
const OUT_JSON = argOf('--out-json', ROOT + `reports/roco/coverage/roster-${SIZE}.json`);
const OUT_MD = argOf('--out-md', ROOT + `docs/roco/ROSTER-${SIZE}.md`);

const readText = (p) => readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(readText(p));
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ── 选择规则常量（**全部写死**，改这里就等于改口径）──────────────────────
const POOL_MIN = 40;              // 可学习技能数下限（622 只的 p10 是 45，留余量）
// 能耗上限取自**规则配置**（RC-101 的唯一事实源）：默认 `legacy_sim_v1` 是 6
// （与当前引擎逐位相同；该值在配置里自注为 ENGINE_HYPOTHESIS）。
// 引擎的合法性检查 `if skill.energy > pet.energy: continue` 让能耗 > 上限的技能
// **永远不可用**（能量被 `min(energy_max, …)` 夹住）。数据里有 21 条技能能耗是 7/8/10/30，
// 所以配招里**排除**它们，并把排除数如实报出来——不是把它们当 0 能耗。
//
// 候选配置 `mobile_s4_candidate_v2` 的上限是 10：那份配置**未经验证**，本脚本默认不用它
// （要试就显式传 id），否则会生成一批绑定候选规则的名单而没人看得出来。
const RULE_CONFIG = readRulesetConfig(DEFAULT_RULESET_CONFIG_ID);
const energy_max = RULE_CONFIG.energy.max;
const usable = (sid) => {
  const s = skills[sid];
  return !!s && s.category !== '特性' && s.energy <= energy_max;
};
// 配额是**下限**，合计刻意小于 48（留下若干自由位给机制覆盖与属性均衡）。
// 为什么不留满：角色与速度档是同一批 48 只的两个正交切分，两轴同时取满会变成
// 一个 5×5 精确列联表，只有特定分布才可行；留 4 个自由位让约束有回旋。
const ROLE_QUOTA = { attacker: 11, tank: 9, recovery: 11, control: 7, support: 6 };
const SPEED_TIER_QUOTA = { '<=50': 5, '51-70': 9, '71-90': 12, '91-110': 11, '>=111': 7 };
// 每个属性的最低只数（避免「覆盖了但只 1 只」的假均衡）：默认 2；龙系全图鉴只有 14 只，目标降到 1。
const TYPE_MIN_DEFAULT = 2;
const TYPE_MIN_OVERRIDE = { 龙系: 1 };
const typeMin = (t) => TYPE_MIN_OVERRIDE[t] ?? TYPE_MIN_DEFAULT;
// 硬机制：必须出现在 48 只的 4 技能并集里。少一个就抛错——这正是不许「只挑好实现的」。
const HARD_MECHS = ['charge', 'mark', 'multi_hit', 'position', 'random', 'escape', 'respond', 'priority'];

// 机制标注：与 scripts/roco/build-support-matrix.mjs 的 MECHANISM_PATTERNS **逐字相同**。
// 只标注「描述里出现了什么」，不做规则推断。
const MECHANISM_PATTERNS = [
  { key: 'damage', label: '直接伤害', re: /造成(物理|魔法|物伤|魔伤)|本次技能威力|连击|威力\+|威力翻倍|威力变为/ },
  { key: 'multi_hit', label: '多段/连击', re: /连击|2连击|3连击|连击数/ },
  { key: 'charge', label: '蓄力', re: /蓄力/ },
  { key: 'respond', label: '应对（条件反击）', re: /应对(攻击|状态|变化)/ },
  { key: 'shield', label: '减伤护盾', re: /减伤\d|减伤/ },
  { key: 'heal', label: '回复生命', re: /回复\d*%?生命|回复生命|吸血|回复自己生命|返场/ },
  { key: 'energy', label: '能量增减', re: /能量|能耗/ },
  { key: 'mark', label: '印记', re: /印记/ },
  { key: 'stat_mod', label: '属性增减', re: /物攻|物防|魔攻|魔防|速度|双攻/ },
  { key: 'status_dot', label: '持续状态', re: /灼烧|中毒|冻结|麻痹|睡眠|寄生|束缚/ },
  { key: 'escape', label: '强制离场/脱离', re: /脱离|离场|返场|换宠|入场/ },
  { key: 'priority', label: '先手', re: /先手/ },
  { key: 'position', label: '技能位/传动', re: /号位|传动/ },
  { key: 'random', label: '随机化', re: /随机/ },
];
const mechsOf = (desc) => MECHANISM_PATTERNS.filter((p) => p.re.test(desc ?? '')).map((p) => p.key);
const MECH_LABEL = Object.fromEntries(MECHANISM_PATTERNS.map((p) => [p.key, p.label]));
const TYPES_ALL = ['普通系', '草系', '火系', '水系', '电系', '冰系', '武系', '毒系', '地系', '翼系', '虫系', '幽系', '龙系', '恶系', '光系', '萌系', '幻系', '机械系'];

const arr = (v) => (Array.isArray(v) ? v : luaArrayToArray(v));

// ── 载入数据 ────────────────────────────────────────────────────────────
const catalogPath = RAW + 'Catalog.lua';
const learnsetsPath = RAW + 'Learnsets.lua';
const skillsPath = NORM + 'skills.json';
const petsPath = NORM + 'pets.json';

const catalog = parseLuaTable(readText(catalogPath), { file: 'Catalog.lua' }).root;
const luaLearnsets = parseLuaTable(readText(learnsetsPath), { file: 'Learnsets.lua' }).root;
const skills = readJson(skillsPath).skills;
const existingPets = readJson(petsPath);
const MUST_INCLUDE = Object.keys(existingPets.pets).sort();

// ── 展开宇宙 ────────────────────────────────────────────────────────────
function learnsetOf(lsId) {
  const ls = luaLearnsets[lsId];
  if (!ls) return null;
  return {
    native: arr(ls.native_skills).map((x) => x.skill).filter(Boolean),
    blood: arr(ls.blood_skills).map((x) => x.skill).filter(Boolean),
    stones: arr(ls.skill_stones).filter(Boolean),
    feature: ls.feature_skill || null,
  };
}

function universeRow(petId, p) {
  const ls = learnsetOf(p.learnset_id);
  if (!ls) return null;
  const origin = new Map();
  for (const [bucket, ids] of [['native', ls.native], ['blood', ls.blood], ['stones', ls.stones]]) {
    for (const id of ids) if (!origin.has(id)) origin.set(id, bucket);
  }
  const pool = [...origin.keys()].filter((s) => skills[s]);
  const descs = pool.map((s) => skills[s].desc || '');
  const cnt = (re) => descs.filter((d) => re.test(d)).length;
  const stats = p.stats;
  return {
    pet_id: petId,
    name: p.name,
    title: p.title || p.name,
    game_id: p.game_id ?? null,
    number: p.number ?? null,
    types: arr(p.types),
    stats,
    stat_total: ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].reduce((a, k) => a + stats[k], 0),
    release: p.release?.date ?? null,
    release_version: p.release?.version ?? null,
    learnset_id: p.learnset_id,
    feature_skill_id: p.feature_skill_id || ls.feature,
    origin,
    pool,
    native: pool.filter((s) => origin.get(s) === 'native'),
    pool_size: pool.length,
    native_size: pool.filter((s) => origin.get(s) === 'native').length,
    signals: {
      control: cnt(/冻结|眩晕|禁足|沉默|封印|麻痹/),
      heal: cnt(/回复\s*\d*\s*%?\s*生命|吸血/),
      support: cnt(/自己获得|敌方获得|驱散/),
    },
    offense: Math.max(stats.atk, stats.spa),
    bulk: stats.hp + stats.def + stats.spd,
  };
}

const universe = [];
for (const [petId, p] of Object.entries(catalog)) {
  const row = universeRow(petId, p);
  if (row) universe.push(row);
}
const byId = new Map(universe.map((r) => [r.pet_id, r]));

// ── 角色 / 速度档（确定性，规则写在这里）────────────────────────────────
// 优先级从上到下，第一个命中即角色。阈值是**设计选择**，不是游戏事实。
const ROLE_RULES = [
  { role: 'attacker', rule: '物攻或魔攻 ≥115 且 速度 ≥95（高速输出）', test: (r) => r.offense >= 115 && r.stats.spe >= 95 },
  { role: 'tank', rule: '生命+物防+魔防 ≥340（承伤）', test: (r) => r.bulk >= 340 },
  { role: 'recovery', rule: '技能池里「回复生命/吸血」类描述 ≥2 条', test: (r) => r.signals.heal >= 2 },
  { role: 'control', rule: '技能池里「冻结/眩晕/禁足/沉默/封印/麻痹」类描述 ≥2 条', test: (r) => r.signals.control >= 2 },
  { role: 'support', rule: '技能池里「自己获得/敌方获得/驱散」类描述 ≥3 条', test: (r) => r.signals.support >= 3 },
];
function roleOf(r) {
  for (const x of ROLE_RULES) if (x.test(r)) return { role: x.role, rule: x.rule };
  return { role: 'attacker', rule: '默认：无一条角色规则命中 → attacker' };
}
function tierOf(r) {
  const s = r.stats.spe;
  if (s <= 50) return '<=50';
  if (s <= 70) return '51-70';
  if (s <= 90) return '71-90';
  if (s <= 110) return '91-110';
  return '>=111';
}
for (const r of universe) { const rr = roleOf(r); r.role = rr.role; r.role_rule = rr.rule; r.tier = tierOf(r); }

// ── 每只精灵的 4 技能（与 M1 的 4 角色位同一套规则，机制补充位按本精灵机制最大化）──
const enrich = (sid) => {
  const s = skills[sid];
  return {
    skill_id: sid,
    name: s.name,
    category: s.category,
    element: s.element,
    energy: s.energy,
    power: s.power,
    power_status: s.power_status,
    damage_class: s.damage_class ?? null,
    desc: s.desc ?? '',
    mechanisms: mechsOf(s.desc),
    effect_support: s.effect_support,
  };
};
const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'zh');
const powerDesc = (a, b) => (b.power ?? -1) - (a.power ?? -1) || a.energy - b.energy || byName(a, b);

function pickMoveset(row) {
  const usablePool = row.pool.filter(usable);
  const pool = usablePool.map(enrich);
  const nativeSet = new Set(row.native.filter(usable));
  const nat = pool.filter((s) => nativeSet.has(s.skill_id));
  const picked = [];
  const rolesFilled = {};
  const covered = new Set();
  const preferNative = (cands, pred) => {
    const hit = cands.filter(pred).sort(powerDesc);
    return hit[0] ?? null;
  };
  const take = (role, pred) => {
    let cand = preferNative(nat, pred) ?? preferNative(pool, pred);
    if (!cand) { rolesFilled[role] = null; return null; }
    rolesFilled[role] = cand.skill_id;
    picked.push({ ...cand, slot: role });
    cand.mechanisms.forEach((m) => covered.add(m));
    return cand;
  };
  const notPicked = (s) => !picked.some((p) => p.skill_id === s.skill_id);
  take('free_attack', (s) => s.category === '攻击' && s.energy === 0 && s.power !== null);
  take('reactive_defense', (s) => s.category === '防御' && /应对/.test(s.desc));
  take('main_attack', (s) => s.category === '攻击' && s.power !== null && notPicked(s));
  // 机制补充位：最大化本精灵尚未覆盖的机制数；native 优先；再威力降序、能耗升序、名字
  const rest = pool.filter(notPicked).map((s) => ({
    s, newMech: s.mechanisms.filter((m) => !covered.has(m)).length, nat: nativeSet.has(s.skill_id) ? 1 : 0,
  })).sort((a, b) => b.newMech - a.newMech || b.nat - a.nat || powerDesc(a.s, b.s));
  if (rest.length) {
    const c = rest[0].s;
    rolesFilled.mechanism_support = c.skill_id;
    picked.push({ ...c, slot: 'mechanism_support' });
    c.mechanisms.forEach((m) => covered.add(m));
  } else {
    rolesFilled.mechanism_support = null;
  }
  return { picked, rolesFilled, covered };
}
for (const r of universe) {
  const ms = pickMoveset(r);
  r.moveset = ms.picked;
  r.roles_filled = ms.rolesFilled;
  r.mechSet = ms.covered;
}

// ── 48 只选择：字典序贪心（type → role 配额 → 速度档配额 → 硬机制 → 全部机制 → 质量）──
const eligible = universe.filter((r) => r.pool_size >= POOL_MIN && r.moveset.length === 4);
const chosen = [];
const chosenIds = new Set();
const typeHave = new Map(TYPES_ALL.map((t) => [t, 0]));
const roleNeed = { ...ROLE_QUOTA };
const tierNeed = { ...SPEED_TIER_QUOTA };
const mechHave = new Set();
const hardHave = new Set();

function commit(r, reason) {
  chosen.push({ ...r, selection_reason: reason });
  chosenIds.add(r.pet_id);
  for (const t of r.types) typeHave.set(t, (typeHave.get(t) || 0) + 1);
  if (roleNeed[r.role] > 0) roleNeed[r.role] -= 1;
  if (tierNeed[r.tier] > 0) tierNeed[r.tier] -= 1;
  for (const m of r.mechSet) { mechHave.add(m); if (HARD_MECHS.includes(m)) hardHave.add(m); }
}

// 1) 现有 12 只必须在名单里（它们已有 M1 证据链与特性登记）
for (const pid of MUST_INCLUDE) {
  const r = byId.get(pid);
  if (!r) throw new Error(`必须包含的现有精灵不在全量图鉴里：${pid}`);
  if (!eligible.includes(r)) throw new Error(`现有精灵不满足 POOL_MIN=${POOL_MIN}：${pid} pool=${r.pool_size}`);
  commit(r, 'must_include:M1 现有 12 只（已有候选配招与特性登记，证据链最短）');
}

function marginal(r) {
  const newTypes = r.types.filter((t) => (typeHave.get(t) || 0) < typeMin(t)).length;
  const roleGain = roleNeed[r.role] > 0 ? 1 : 0;
  const tierGain = tierNeed[r.tier] > 0 ? 1 : 0;
  const newHard = [...r.mechSet].filter((m) => HARD_MECHS.includes(m) && !hardHave.has(m)).length;
  const newMech = [...r.mechSet].filter((m) => !mechHave.has(m)).length;
  return [newTypes, roleGain, tierGain, newHard, newMech, r.pool_size, r.stat_total];
}
function better(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// ── 阶段 A：先填空缺（属性 / 角色配额 / 速度档配额），按「候选最稀缺」优先 ──
// 为什么不是加权贪心：加权贪心会让「新属性」压过速度档，最后档位配额补不上
// （实测 48 只里 <=50 挡只有 3 只）。这里改成显式的约束填空，稀缺者先填。
function currentDeficits() {
  const out = [];
  for (const t of TYPES_ALL) {
    const got = chosen.filter((r) => r.types.includes(t)).length;
    for (let i = got; i < typeMin(t); i++) out.push({ kind: 'type', key: t });
  }
  for (const [k, v] of Object.entries(ROLE_QUOTA)) {
    const got = chosen.filter((r) => r.role === k).length;
    for (let i = got; i < v; i++) out.push({ kind: 'role', key: k });
  }
  for (const [k, v] of Object.entries(SPEED_TIER_QUOTA)) {
    const got = chosen.filter((r) => r.tier === k).length;
    for (let i = got; i < v; i++) out.push({ kind: 'tier', key: k });
  }
  return out;
}
const satisfies = (r, d) => (d.kind === 'type' ? r.types.includes(d.key) : d.kind === 'role' ? r.role === d.key : r.tier === d.key);
const DEFICIT_REASONS = {};
while (chosen.length < SIZE) {
  const deficits = currentDeficits();
  if (!deficits.length) break;
  // 候选数最少的空缺优先；同稀缺度按 kind 固定序（type<role<tier）、再按 key
  const ranked = deficits.map((d) => ({ d, n: eligible.filter((r) => !chosenIds.has(r.pet_id) && satisfies(r, d)).length }))
    .sort((a, b) => a.n - b.n || a.d.kind.localeCompare(b.d.kind) || String(a.d.key).localeCompare(String(b.d.key)));
  const target = ranked[0];
  if (target.n === 0) throw new Error(`空缺 ${target.d.kind}:${target.d.key} 没有可用候选（已被前面填掉）——需要调整配额`);
  const cands = eligible.filter((r) => !chosenIds.has(r.pet_id) && satisfies(r, target.d));
  const score = (r) => [deficits.filter((d) => satisfies(r, d)).length, [...r.mechSet].length, r.pool_size, r.stat_total];
  let best = null; let bestSc = null;
  for (const r of cands) {
    const sc = score(r);
    if (best === null || better(sc, bestSc) || (sc.every((v, i) => v === bestSc[i]) && r.pet_id < best.pet_id)) { best = r; bestSc = sc; }
  }
  commit(best, `deficit:${target.d.kind}=${target.d.key},alsoCovers=${bestSc[0]},pool=${bestSc[2]},total=${bestSc[3]}`);
  DEFICIT_REASONS[best.pet_id] = `填补空缺 ${target.d.kind}=${target.d.key}`;
}

// ── 阶段 B：剩下的位置按字典序贪心（机制覆盖优先，其次质量）──────────────
while (chosen.length < SIZE) {
  let best = null; let bestScore = null;
  for (const r of eligible) {
    if (chosenIds.has(r.pet_id)) continue;
    const sc = marginal(r);
    if (best === null || better(sc, bestScore) ||
        (sc.every((v, i) => v === bestScore[i]) && r.pet_id < best.pet_id)) {
      best = r; bestScore = sc;
    }
  }
  if (!best) throw new Error('候选用尽，无法凑满 48 只——放宽 POOL_MIN 或配额');
  commit(best, `greedy:type=${bestScore[0]},role=${bestScore[1]},tier=${bestScore[2]},newHardMech=${bestScore[3]},newMech=${bestScore[4]},pool=${bestScore[5]},total=${bestScore[6]}`);
}
if (chosen.length !== SIZE) throw new Error(`名单长度 ${chosen.length} ≠ ${SIZE}`);

// ── 修复 pass：硬机制若仍缺，就在「已入选精灵」里把机制补充位换成带该机制的技能 ──
// 只动机制补充位（不是主输出位），native 优先，确定性 tie-break。
const REPAIR_REASONS = {};
const unionOf = () => [...new Set(chosen.flatMap((r) => [...r.mechSet]))];
for (const m of HARD_MECHS) {
  if (unionOf().includes(m)) continue;
  const row = chosen.find((r) => r.pool.filter(usable).some((s) => mechsOf(skills[s].desc).includes(m)));
  if (!row) throw new Error(`硬机制 ${m} 在 48 只的技能池里一个都没有——需要换人，不是近似`);
  const cands = row.pool.filter(usable).filter((s) => mechsOf(skills[s].desc).includes(m))
    .sort((a, b) => (row.native.includes(b) ? 1 : 0) - (row.native.includes(a) ? 1 : 0) || powerDesc(enrich(a), enrich(b)));
  const sid = cands[0];
  const idx = row.moveset.findIndex((x) => x.slot === 'mechanism_support');
  if (idx < 0) throw new Error(`修复 ${m} 时找不到 mechanism_support 位：${row.pet_id}`);
  const before = row.moveset[idx].skill_id;
  row.moveset[idx] = { ...enrich(sid), slot: 'mechanism_support' };
  row.mechSet = new Set(row.moveset.flatMap((x) => x.mechanisms));
  REPAIR_REASONS[row.pet_id] = `repair:机制补充位 ${before} → ${sid}，为了让硬机制「${MECH_LABEL[m]}」出现在名单并集里`;
}

// ── 硬约束自检（失败就红，不静默）────────────────────────────────────────
const problems = [];
const missingTypes = TYPES_ALL.filter((t) => !chosen.some((r) => r.types.includes(t)));
if (missingTypes.length) problems.push(`属性未覆盖：${missingTypes.join(',')}`);
for (const t of TYPES_ALL) {
  const got = chosen.filter((r) => r.types.includes(t)).length;
  if (got < typeMin(t)) problems.push(`属性 ${t} 只数不足：${got}/${typeMin(t)}`);
}
for (const [k, v] of Object.entries(ROLE_QUOTA)) {
  const got = chosen.filter((r) => r.role === k).length;
  if (got < v) problems.push(`角色配额不足 ${k}: ${got}/${v}`);
}
for (const [k, v] of Object.entries(SPEED_TIER_QUOTA)) {
  const got = chosen.filter((r) => r.tier === k).length;
  if (got < v) problems.push(`速度档配额不足 ${k}: ${got}/${v}`);
}
const unionMechs = unionOf();
for (const m of HARD_MECHS) if (!unionMechs.includes(m)) problems.push(`硬机制未覆盖：${m}(${MECH_LABEL[m]})`);
const badMoveset = chosen.filter((r) => r.moveset.length !== 4);
if (badMoveset.length) problems.push(`配招不是 4 个技能：${badMoveset.map((r) => r.pet_id).join(',')}`);
// 每个技能必须真的可学（在学习表里）
for (const r of chosen) for (const s of r.moveset) if (!r.pool.includes(s.skill_id)) problems.push(`技能不在学习表：${r.pet_id}/${s.skill_id}`);
if (problems.length) throw new Error('硬约束失败：\n  - ' + problems.join('\n  - '));

// ── 汇总 ────────────────────────────────────────────────────────────────
const uniqueSkills = [...new Set(chosen.flatMap((r) => r.moveset.map((s) => s.skill_id)))].sort();
const typeHist = {}; for (const r of chosen) for (const t of r.types) typeHist[t] = (typeHist[t] || 0) + 1;
const roleHist = {}; for (const r of chosen) roleHist[r.role] = (roleHist[r.role] || 0) + 1;
const tierHist = {}; for (const r of chosen) tierHist[r.tier] = (tierHist[r.tier] || 0) + 1;
const mechHist = {};
for (const r of chosen) for (const m of r.mechSet) mechHist[m] = (mechHist[m] || 0) + 1;
const skillMechHist = {};
for (const sid of uniqueSkills) for (const m of mechsOf(skills[sid].desc)) skillMechHist[m] = (skillMechHist[m] || 0) + 1;
const categoryHist = {}; for (const sid of uniqueSkills) categoryHist[skills[sid].category] = (categoryHist[skills[sid].category] || 0) + 1;
const energyHist = {}; for (const sid of uniqueSkills) energyHist[skills[sid].energy] = (energyHist[skills[sid].energy] || 0) + 1;

const out = {
  schema_version: 1,
  generated_by: 'scripts/roco/build-roster-48.mjs',
  command: 'node scripts/roco/build-roster-48.mjs',
  ruleset_id: existingPets.ruleset_id,
  // 产物里**不放生成时间**：它让同一份输入的两次运行不再是逐字节相同，而这份产物是
  // `verify-coverage-axes.mjs` 的输入（第 46 轮实测：重跑只差这一行）。要记时间就记在
  // 提交信息或报告里，不要污染可复现的产物。
  generated_at: null,
  sources: {
    catalog: { path: 'data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/Catalog.lua', sha256: sha256(catalogPath), entries: Object.keys(catalog).length },
    learnsets_lua: { path: 'data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/Learnsets.lua', sha256: sha256(learnsetsPath), entries: Object.keys(luaLearnsets).length },
    skills: { path: 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json', sha256: sha256(skillsPath), entries: Object.keys(skills).length },
    pets: { path: 'data/roco/normalized/roco-world-s4-2026-09-10/pets.json', sha256: sha256(petsPath), entries: Object.keys(existingPets.pets).length },
  },
  selection_rules: {
    roster_size: SIZE,
    pool_min: POOL_MIN,
    must_include: MUST_INCLUDE,
    role_quota: ROLE_QUOTA,
    speed_tier_quota: SPEED_TIER_QUOTA,
    type_min: Object.fromEntries(TYPES_ALL.map((t) => [t, typeMin(t)])),
    hard_mechanics: HARD_MECHS,
    role_rules: ROLE_RULES.map((x) => ({ role: x.role, rule: x.rule })),
    greedy_priority: 'lexicographic: [newTypes, roleQuotaGain, tierQuotaGain, newHardMechs, newMechs, pool_size, stat_total]',
    moveset_rule: `候选必须 energy<=${energy_max}（规则配置 data/roco/rulesets/legacy-sim-v1.json 的 energy.max，ENGINE_HYPOTHESIS）且 category!=特性；free_attack(攻击/能耗0/有静态威力/威力降序) → reactive_defense(防御且描述含「应对」) → main_attack(攻击且有静态威力/未选) → mechanism_support(最大化本只未覆盖机制数，native 优先)`,
    mechanism_patterns: MECHANISM_PATTERNS.map((p) => ({ key: p.key, label: p.label, re: String(p.re) })),
    repairs: REPAIR_REASONS,
    not_claimed: '本名单只声明「数据齐全 + 技能可学 + 机制已标注」；不声明任何技能可被引擎正确结算——那由 reports/roco/coverage/roster-48-support.json 单独判定。',
  },
  summary: {
    count: chosen.length,
    unique_skills: uniqueSkills.length,
    types: typeHist,
    roles: roleHist,
    speed_tiers: tierHist,
    mechanics_by_pet: mechHist,
    mechanics_by_skill: skillMechHist,
    skill_categories: categoryHist,
    skill_energy: energyHist,
    all_hard_mechanics_present: HARD_MECHS.every((m) => unionMechs.includes(m)),
    engine_energy_max: energy_max,
    skills_excluded_energy_over_max: {
      total_in_skills_json: Object.values(skills).filter((s) => s.energy > energy_max).length,
      among_48_learnable_pools: [...new Set(chosen.flatMap((r) => r.pool))].filter((sid) => skills[sid].energy > energy_max).length,
    },
    must_include_all_present: MUST_INCLUDE.every((p) => chosenIds.has(p)),
  },
  pets: chosen.map((r) => {
    const traitSkill = skills[r.feature_skill_id];
    return {
      pet_id: r.pet_id,
      name: r.name,
      title: r.title,
      game_id: r.game_id,
      number: r.number,
      types: r.types,
      stats: r.stats,
      stat_total: r.stat_total,
      release: r.release,
      role: r.role,
      role_rule: r.role_rule,
      speed_tier: r.tier,
      learnset_id: r.learnset_id,
      pool_size: r.pool_size,
      native_size: r.native_size,
      trait: traitSkill ? {
        skill_id: r.feature_skill_id,
        name: traitSkill.name,
        desc: traitSkill.desc,
        effect_support: traitSkill.effect_support,
      } : null,
      moveset: r.moveset.map((s) => ({
        slot: s.slot,
        skill_id: s.skill_id,
        name: s.name,
        category: s.category,
        element: s.element,
        energy: s.energy,
        power: s.power,
        power_status: s.power_status,
        damage_class: s.damage_class,
        desc: s.desc,
        mechanisms: s.mechanisms,
        learn_from: r.origin.get(s.skill_id),
      })),
      mechanisms_covered: [...r.mechSet].sort(),
      selection_reason: r.selection_reason + (REPAIR_REASONS[r.pet_id] ? ' | ' + REPAIR_REASONS[r.pet_id] : ''),
      provenance: {
        name: 'Catalog.lua#name',
        types: 'Catalog.lua#types',
        stats: 'Catalog.lua#stats',
        trait: 'Catalog.lua#feature_skill_id → skills.json#is_trait',
        pool: 'Learnsets.lua#' + r.learnset_id,
        skills: 'skills.json#skills[skill_id]',
        selection: 'scripts/roco/build-roster-48.mjs#selection_rules',
      },
    };
  }),
};
mkdirSync(ROOT + 'reports/roco/coverage', { recursive: true });
writeFileSync(OUT_JSON, JSON.stringify(out, null, 2) + '\n');

// ── 人类可读版 ──────────────────────────────────────────────────────────
const L = [];
const P = (s = '') => L.push(s);
P('# 48 只 Demo 名单（机器可读：`reports/roco/coverage/roster-48.json`）');
P();
P('> 本文件由 `node scripts/roco/build-roster-48.mjs` 生成，**不要手工编辑**。');
P('> 数据来源：`Catalog.lua`（622 只全量图鉴）+ `Learnsets.lua`（312 张学习表）+ 规范化 `skills.json`（824 条）。');
P('> **本名单只声明数据与可学性**；每个技能在引擎里到底会不会被结算，见 `reports/roco/coverage/roster-48-support.json`。');
P();
P('## 汇总');
P();
P('| 项 | 值 |');
P('|---|---|');
P(`| 名单只数 | ${out.summary.count} |`);
P(`| 独特技能数（48×4 去重） | **${out.summary.unique_skills}** |`);
P(`| 18 属性全覆盖 | ${missingTypes.length === 0 ? '是' : '否'} |`);
P(`| 硬机制全覆盖（${HARD_MECHS.join('/')}） | ${out.summary.all_hard_mechanics_present ? '是' : '否'} |`);
P(`| 原 12 只全部在名单内 | ${out.summary.must_include_all_present ? '是' : '否'} |`);
P();
P('### 属性分布');
P();
P('| 属性 | 只数 | 属性 | 只数 |');
P('|---|---:|---|---:|');
const tEntries = TYPES_ALL.map((t) => [t, typeHist[t] || 0]);
for (let i = 0; i < tEntries.length; i += 2) {
  P(`| ${tEntries[i][0]} | ${tEntries[i][1]} | ${tEntries[i + 1] ? tEntries[i + 1][0] : ''} | ${tEntries[i + 1] ? tEntries[i + 1][1] : ''} |`);
}
P();
P('### 角色 / 速度档 / 机制');
P();
P('| 角色 | 只数 | 配额 |');
P('|---|---:|---:|');
for (const [k, v] of Object.entries(ROLE_QUOTA)) P(`| ${k} | ${roleHist[k] || 0} | ${v} |`);
P();
P('| 速度档（种族速度） | 只数 | 配额 |');
P('|---|---:|---:|');
for (const [k, v] of Object.entries(SPEED_TIER_QUOTA)) P(`| ${k} | ${tierHist[k] || 0} | ${v} |`);
P();
P('| 机制（描述标注） | 只数（含该机制的精灵） | 技能数（独特技能里） |');
P('|---|---:|---:|');
for (const p of MECHANISM_PATTERNS) P(`| ${p.label} \`${p.key}\` | ${mechHist[p.key] || 0} | ${skillMechHist[p.key] || 0} |`);
P();
P('| 技能类别 | 独特技能数 |');
P('|---|---:|');
for (const [k, v] of Object.entries(categoryHist).sort()) P(`| ${k} | ${v} |`);
P();
P('| 能耗 | 独特技能数 |');
P('|---|---:|');
for (const k of Object.keys(energyHist).sort((a, b) => a - b)) P(`| ${k} | ${energyHist[k]} |`);
P();
P('## 逐只名单');
P();
P('| # | pet_id | 名字 | 属性 | 六维（生命/物攻/物防/魔攻/魔防/速度） | 合计 | 角色 | 速度档 | 特性 | 4 技能 | 入选理由 |');
P('|---:|---|---|---|---|---:|---|---|---|---|---|');
chosen.forEach((r, i) => {
  const st = r.stats;
  const trait = skills[r.feature_skill_id];
  const moves = r.moveset.map((s) => `\`${s.skill_id}\` ${s.name}(${s.category}${s.power !== null ? '/' + s.power : '/' + (s.power_status === 'not_provided_by_source' ? '来源未给威力' : '—')})`).join('<br>');
  P(`| ${i + 1} | \`${r.pet_id}\` | ${r.name} | ${r.types.join('+')} | ${st.hp}/${st.atk}/${st.def}/${st.spa}/${st.spd}/${st.spe} | ${r.stat_total} | ${r.role} | ${r.tier} | ${trait ? trait.name : '—'} | ${moves} | ${r.selection_reason.replace(/\|/g, '/')} |`);
});
P();
P('## 选择规则（可核对）');
P();
P('```text');
P(`名单规模：${SIZE}；可学习技能下限：${POOL_MIN}`);
P(`必须包含：${MUST_INCLUDE.join(', ')}`);
P(`角色配额：${JSON.stringify(ROLE_QUOTA)}`);
P(`速度档配额：${JSON.stringify(SPEED_TIER_QUOTA)}`);
P(`硬机制：${HARD_MECHS.join(', ')}`);
P('贪心优先级（字典序）：[新属性数, 角色配额增益, 速度档配额增益, 新硬机制数, 新机制数, 技能池大小, 种族值合计]');
P('配招规则：free_attack → reactive_defense → main_attack → mechanism_support（最大化本只未覆盖机制数）');
P('角色规则（自上而下，第一个命中）：');
for (const x of ROLE_RULES) P(`  · ${x.role}：${x.rule}`);
P('   · 无一条命中 → attacker');
P('速度档：<=50 / 51-70 / 71-90 / 91-110 / >=111（按种族速度）');
P('```');
P();
P('## 原语覆盖与 unsupported');
P();
P('本文件**不**判定引擎行为。技能在引擎里的三分类（会算 / 只登记不算 / fail closed）由');
P('`python3 scripts/roco/classify-roster-support.py` 用**引擎自己的代码路径**逐条判定，');
P('落在 `reports/roco/coverage/roster-48-support.json`。原因分类见 `docs/roco/COVERAGE-LAYERS.md`。');
P();
writeFileSync(OUT_MD, L.join('\n') + '\n');

console.log(`OK roster-${SIZE}: ${chosen.length} 只 / 独特技能 ${uniqueSkills.length} / 属性 ${TYPES_ALL.length - missingTypes.length} / 硬机制 ${hardHave.size}/${HARD_MECHS.length}`);
console.log('roles:', JSON.stringify(roleHist), 'tiers:', JSON.stringify(tierHist));
console.log('types:', JSON.stringify(typeHist));
