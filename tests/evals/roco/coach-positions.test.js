// **这个文件现在是「活的验收」（live acceptance），不是「待修复的目标」。**
// 它写下时 P1 还没接，头注写的是「应当是红的」；那一版已经过期：
// 建议层（src/coach/coach-advice.js）已经接进 `rocoIntervention`（`detail.advice`），
// 所以它现在**守的是当前行为**——这 10 个局面必须各自得到「说得对路」的那种建议，
// 而且是 6 种以上不同的句子形状。哪天有人把建议层改回「只吃 plan」，
// 或者把某个局面检测器的优先级挪坏，这里会立刻变红。
//
// ── 动机（用户实测原话，文件存在的理由）────────────────────────────────────
//   玩家看到的主动气泡几乎永远是同一句：
//     「<技能名>」这一手不稳：对手换个选择就要亏约 <数字>，先看区间再定（最坏尾部 <a> ~ <b>）
//   换局面、换精灵、换技能，句子骨架一个字不变，只有名字和数字在动。
//   根因是结构：`rocoHintText(plan)` 只拿得到 planner 结果，看不到局面
//   （我方血量/能量、对手血条与能量、属性倍率、速度、异常、是否必须补位）。
// 本文件就是「修好之后长什么样」的验收证据。
//
// ── 这条测试做什么 ──────────────────────────────────────────────────────────
// 它用**真服务**（真 Python 规则引擎 + 真 HTTP 路由）造 10 个**互不相同**的对局局面，
// 每个局面都走真实提示链路：
//     /api/roco/battle/new → /api/roco/battle/advance → /api/roco/plan
//     → rocoIntervention({view, session, plan, host}) → rocoInterventionText(detail, plan)
//
// **每个 case 都绑定一个期望的检测器 kind**（`detail.advice.kind`），并且窗口是
// **隔离**过的：命名局面必须是那一刻**最优先**的局面事实，不能被更高优先级的检测器压住。
// 为什么必须隔离：一个叫「属性被抗」的 case，如果战况其实是我方只剩 8% 血，
// 那么建议层**根本没被问到属性问题**（它先看到的是「该换人了」）——那条 case 名不副实。
// 隔离依据只有**局面事实**（血量/能量/速度/倍率/合法动作/回执估算），
// 绝不看产出的文案，也绝不按形状挑窗口。
//
// ── 一条纪律：不捏 payload ─────────────────────────────────────────────────
// 每一个 position 都来自真实回执：`view` 只用 `/api/roco/battle/new` 或
// `/api/roco/battle/advance` 的 `view`，`plan` 只用 `/api/roco/plan` 的回执。
// 不做任何手工构造的假局面（第 39 轮的漏检根因就是守卫自己捏了一个服务端不发的形状）。
//
// ── 「形状」怎么算 ──────────────────────────────────────────────────────────
// 需求原话是「换技能名和数字不算不同」，所以形状归一化做三件事（见 `shapeOf`）：
//   ① 引号里的动作/技能/道具标签 → `「◆」`；
//   ② 任何数字（含小数点与负号）→ `#`；
//   ③ 裸露的精灵名 / 技能名 → `◆`（名字表从 data/roco/normalized 读，不写死在这里）。
//
// ── 第 44 轮：引擎修了两个缺陷，所有窗口都重挑过 ────────────────────────────
//   ① `SideState.to_dict()` 不序列化 `loadouts`（schema.py，已修 + test_state_roundtrip.py）：
//      私有域每次往返都把配招丢成 `{}`，规划器于是退回「全部可学技能」，
//      合法动作从 4 个虚涨到 3–43 个，`damage_preview` 恒不可用。
//   ② `RocoClient.planActions` 不转发 `damagePreview`（roco-client.js，已修）。
// 每个 case 的注释里写了它修复前落在哪里、为什么移动。
//
// python3 不可用时整条 skip（与 intervention-margin-chain.test.js 同一口径）。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createCoachServer} from '../../../src/server/index.js';
import {rocoIntervention, rocoInterventionText} from '../../../src/coach/roco-experience.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const DATA = join(ROOT, 'data', 'roco', 'normalized', 'roco-world-s4-2026-09-10');

function probePython(bin) {
  try {
    execFileSync(bin, ['-c', 'import sys;print(sys.version_info[0])'], {encoding: 'utf8'});
    return {ok: true};
  } catch (error) {
    return {ok: false, error: String(error.message).slice(0, 80)};
  }
}

const PYTHON = probePython(process.env.ROCO_PYTHON || 'python3');
const SKIP = PYTHON.ok ? false : `python3 不可用（${PYTHON.error}）`;

// ── 规则集数据（只读，用来把真实局面翻译成可读证据；不改任何东西）──────────
const readJson = (name) => JSON.parse(readFileSync(join(DATA, name), 'utf8'));
const PETS = readJson('pets.json').pets;
const SKILLS = readJson('skills.json').skills;
const TYPE_CHART = readJson('types.json').types;
const SUPPORT = readJson('support-matrix.json');

/** 每只精灵的规范配招（引擎 `Ruleset.candidate_moveset` 的同一份来源）。 */
const MOVESETS = {};
for (const entry of SUPPORT.pets || []) {
  const ids = ((entry.candidate_moveset || {}).skills || [])
    .map((s) => s.skill_id).filter(Boolean);
  if (ids.length) MOVESETS[entry.pet_id] = ids;
}

/** 属性倍率：与引擎同一个方向（攻方系别 → 守方属性表）。 */
function typeMultiplier(element, defenderTypes) {
  const key = [...(defenderTypes || [])].sort().join('|');
  const row = TYPE_CHART[key];
  if (!row) return 1;
  for (const r of row.resist || []) if (r.type === element) return r.multiplier;
  for (const w of row.weak || []) if (w.type === element) return w.multiplier;
  return 1;
}

const NAMES = [...new Set([
  ...Object.values(PETS).map((p) => p.name),
  ...Object.values(SKILLS).map((s) => s.name),
].filter((n) => typeof n === 'string' && n.length >= 2))].sort((a, b) => b.length - a.length);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME_RE = new RegExp(NAMES.map(escapeRe).join('|'), 'g');

/**
 * 句子形状：把「这一句在说什么」之外的东西全部抹掉——
 *   ① 引号里的动作/技能/道具标签（`「使用能量果」` `「换上第2位」` `「彗星」`）→ `「◆」`；
 *   ② 任何数字（含小数点与负号）→ `#`；
 *   ③ 裸露的精灵名 / 技能名（「注意对方可能诡刺」里的「诡刺」）→ `◆`。
 *
 * 需求原话是「换个技能名和数字不算不同」。所以名字与数字**两样**都要归一化：
 * 只归一化数字的话，同一个模板的十次复现会因为技能名/道具标签不同而被算成十种形状，
 * 那正好把这个缺陷放过。名字表从 data/roco/normalized 读，不写死在这里。
 */
function shapeOf(text) {
  return String(text)
    .replace(/「[^」]{0,40}」/g, '「◆」')
    .replace(/-?\d+(?:\.\d+)?/g, '#')
    .replace(NAME_RE, '◆');
}

// 不带 /g 的探针：`/g` 正则的 `test()` 有 lastIndex 状态，会随调用次数飘。
const NAME_PROBE = new RegExp(NAME_RE.source);

/**
 * D 的判据：这句话点了名没有。
 *   · 引号里的动作/技能/道具标签；或
 *   · 任何一个真实存在的精灵名 / 技能名（裸写，如「注意对方可能诡刺」）；或
 *   · 一句明确的**动作**（换人 / 换上 / 吃果 / 补位 / 防御 / 收掉 / 别硬顶 …）；
 *   · 或一句明确的「先观察 / 不硬给答案」立场。
 *
 * 为什么动作词也算：速度局面那句「它速度 90 快过你 60：别硬对拼，这一轮先换人躲一下」
 * 既没有引号也没有技能名，但它给的是**动作**（换人）加一个具体观察（速度差），
 * 完全满足 D 的本意；D 要挡的是「只说了一个区间、什么也没让人做」的那种句子。
 */
const ACTION_PATTERN = /换人|换上|顶上|切换到|使用|吃「|补位|防御|收掉|收线|直接收|补上|别硬顶|别硬对拼|躲一下|拖住节奏|压上去/;
const STANCE_PATTERN = /先按你的判断走|先看局面|按局面常识走|先观察|保持观察|允许沉默|再观察/;

function namesSomething(text) {
  if (/「[^」]{1,24}」/.test(text)) return true;
  if (NAME_PROBE.test(text)) return true;
  if (ACTION_PATTERN.test(text)) return true;
  return STANCE_PATTERN.test(text);
}

const FORBIDDEN = ['state_version', 'quota', 'coverage', 'margin', 'worst', '尾部', '区间',
  '分支', '分析种子', 'score', 'critical', 'degrade', 'JSON', 'undefined', 'null', 'NaN'];

const freshSession = () => ({hints: 0, lastAt: -Infinity, dismissed: false, said: new Set(),
  readings: new Set(), topics: new Set(), limit: 3});

// ── 真服务 + 真路由 ────────────────────────────────────────────────────────
async function startServer() {
  const server = createCoachServer({});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootRes = await fetch(`${base}/api/bootstrap`);
  const boot = await bootRes.json();
  const cookie = bootRes.headers.get('set-cookie') || '';
  const post = (path, data) => fetch(base + path, {
    method: 'POST',
    headers: {Origin: base, Cookie: cookie, 'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf},
    body: JSON.stringify(data),
  }).then((r) => r.json());
  return {
    post,
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

/** 把一份真实公开视图压成判定用的最小事实集（只读公开字段）。 */
function windowOf(view) {
  const activeIndex = Number.isInteger(view?.self?.active) ? view.self.active : 0;
  const me = view?.self?.pets?.[activeIndex] ?? null;
  const foe = view?.opponent?.field ?? null;
  const legal = Array.isArray(view?.legal) ? view.legal : [];
  const damaging = legal
    .filter((a) => a.kind === 'skill' && a.skill && a.skill.power != null)
    .map((a) => ({name: a.skill_name, skill_id: a.skill_id, element: a.skill.element,
      energy: a.skill.energy, power: a.skill.power,
      mult: foe ? typeMultiplier(a.skill.element, foe.types || []) : 1}));
  return {
    // 原始公开视图：rocoIntervention 只接受这一份形状，投影在 rocoGameView 里做。
    rawView: view,
    turn: view.turn ?? null,
    phase: view.phase ?? null,
    me: me ? {pet_id: me.pet_id, name: me.name, hp: me.hp, max: me.max_hp, energy: me.energy,
      statuses: me.statuses || {}, fainted: me.fainted === true, spe: me.stats?.spe ?? null} : null,
    bench: (view?.self?.pets || []).map((p, index) => ({pet_id: p.pet_id, name: p.name,
      hp: p.hp, max: p.max_hp, energy: p.energy, statuses: p.statuses || {},
      fainted: p.fainted === true, isActive: index === activeIndex})),
    foe: foe ? {pet_id: foe.pet_id, name: foe.name, hp: foe.hp, max: foe.max_hp, energy: foe.energy,
      types: foe.types || [], statuses: foe.statuses || {}, marks: foe.marks || {},
      buffs: foe.buffs || {}, fainted: foe.fainted === true, spe: foe.stats?.spe ?? null} : null,
    legal,
    damaging,
    // 己方全队的配招技能（UI 视图公开）：断言 F 的「这个名字/这个能耗真的在这场里」会用到。
    selfSkills: (view?.self?.skills || []).filter(Boolean)
      .map((s) => ({name: s.name, energy: s.energy, power: s.power})),
    // 上一手的公开事件（属性倍率、状态结算都在这）：局面判据要读它，断言 F 也要读它。
    events: (Array.isArray(view?.events) ? view.events : [])
      .map((e) => ({kind: e?.kind ?? null, side: e?.side ?? null, detail: e?.detail ?? null})),
    items: legal.filter((a) => a.kind === 'item').map((a) => a.item_id ?? a.label),
    tickEvents: (Array.isArray(view?.events) ? view.events : [])
      .map((e) => e?.text).filter((t) => typeof t === 'string' && /因(灼烧|中毒|寄生)损失/.test(t)),
    switchCount: legal.filter((a) => a.kind === 'switch').length,
  };
}

const hpRatio = (w) => (w.me && w.me.max > 0 ? w.me.hp / w.me.max : 1);
const foeRatio = (w) => (w.foe && w.foe.max > 0 ? w.foe.hp / w.foe.max : 1);

/** 规划回执里的伤害预览（引擎的原始伤害估算；第 44 轮起这条链真的通了）。 */
const previewOf = (w) => (w.plan?.damage_preview?.available === true ? w.plan.damage_preview : null);

/**
 * **合法**技能的估算区间。
 *
 * `damage_preview.min/max` 是**整份配招**（含这一步出不了的招）的包络，不能直接拿来
 * 回答「这一手收不收得掉」——那要按**合法**动作去 `samples` 里查同一招。
 */
function legalDamageSamples(w) {
  const preview = previewOf(w);
  if (!preview || !Array.isArray(preview.samples)) return [];
  const legalNames = new Set(w.damaging.map((d) => d.name));
  return preview.samples.filter((s) => s && legalNames.has(s.label));
}

/** 这一轮真有「稳收」的一手（合法招的估算下限 ≥ 对手当前血）。 */
const finishAvailable = (w) => Boolean(w.foe) && w.foe.hp > 0
  && legalDamageSamples(w).some((s) => Number.isFinite(s.min) && s.min >= w.foe.hp);

/** 规范配招里这一招的能耗（引擎自己的配招来源；不是猜的）。 */
function loadoutEnergyOf(petId, skillName) {
  const skill = (MOVESETS[petId] || []).map((sid) => SKILLS[sid])
    .find((s) => s && s.name === skillName);
  return skill && Number.isFinite(skill.energy) ? skill.energy : null;
}

/**
 * 「更狠的那一招放不出来，而且它估算盖得过对面血量」——这是 energy-short 检测器的
 * 公开事实判据（能耗 > 当前能量 + 估算能收）。用它把「能量局面」与「只是招不够狠」分开。
 */
function blockedDecisive(w) {
  const preview = previewOf(w);
  if (!preview || !w.foe || !w.me) return false;
  const legalNames = new Set(w.damaging.map((d) => d.name));
  return (preview.samples || []).some((s) => s && !legalNames.has(s.label)
    && Number.isFinite(s.max) && s.max >= w.foe.hp
    && (loadoutEnergyOf(w.me.pet_id, s.label) ?? 0) > w.me.energy);
}

/** 后备里有血比 ≥60% 的健康伙伴（switch-low-hp 的前提之一）。 */
const healthyBench = (w) => w.bench.some((b) => !b.isActive && !b.fainted && b.max > 0 && b.hp / b.max >= 0.6);

/**
 * 引擎公开事件里「我方上一手打出的、带属性倍率的那一击」。
 * 与建议层 `lastMyTypeHit` 同一口径：那一击之后对面没有换人/倒下，倍率才属于**现在**场上这只。
 */
function lastPlayerTypeHit(w) {
  const events = w.events;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    const detail = e?.detail && typeof e.detail === 'object' ? e.detail : {};
    if (e?.kind !== 'damage' || detail.side !== 'player') continue;
    const multiplier = detail.type_multiplier;
    if (!Number.isFinite(multiplier)) continue;
    const changed = events.slice(i + 1).some((x) => {
      const d = x?.detail && typeof x.detail === 'object' ? x.detail : {};
      return d.side === 'enemy' && ['switch', 'replacement', 'faint'].includes(x?.kind);
    });
    if (changed) return null;
    return {multiplier, skillId: typeof detail.skill_id === 'string' ? detail.skill_id : null};
  }
  return null;
}

/** 上一手那一招被抵抗，而且这一轮还放得出来（建议层 type-resisted 的前提）。 */
function resistedHitPending(w) {
  const hit = lastPlayerTypeHit(w);
  return Boolean(hit) && hit.multiplier < 1
    && w.damaging.some((d) => d.skill_id === hit.skillId);
}

/** 上一手那一招没有属性信息（倍率恰好 1 或没打出伤害）→ type 检测器不会开口。 */
function noPendingTypeMatchup(w) {
  const hit = lastPlayerTypeHit(w);
  return !hit || hit.multiplier === 1;
}

async function findPosition({post, config, canAskPlan, isMatch, maxTurns = 14}) {
  const request = {seed: config.seed, strategy: config.strategy};
  if (config.team) request.team = config.team;
  if (config.enemyTeam) request.enemy_team = config.enemyTeam;
  const started = await post('/api/roco/battle/new', request);
  if (!started.ok) return {error: `开局失败：${started.error || ''}`};
  let current = started;
  for (let step = 0; step < maxTurns; step += 1) {
    const view = current.view;
    if (!view || view.battle_result) break;
    const w = windowOf(view);
    // 计划必须在**推进之前**问：plan 描述的是这一手所在的局面。
    if (canAskPlan(w)) {
      w.plan = await post('/api/roco/plan', {battle_id: started.battle_id, depth: 2, beam: 4});
    }
    const advanced = await post('/api/roco/battle/advance',
      {battle_id: started.battle_id, auto: true});
    if (!advanced.ok) break;
    if (isMatch(w)) return {config, window: w, steps: step + 1};
    current = advanced;
  }
  return {error: `在 ${maxTurns} 个回合里没有出现这个局面`};
}

const DEFAULT_TEAM = ['pet_000225', 'pet_000190', 'pet_000445'];
const CFG_A = {seed: 20260921, strategy: 'greedy_damage'};
const CFG_C = {seed: 20260921, strategy: 'greedy_damage', team: ['pet_000062', 'pet_000112', 'pet_000417']};
const CFG_D = {seed: 20260921, strategy: 'conservative_switch',
  enemyTeam: ['pet_000112', 'pet_000611', 'pet_000190']};
const CFG_E = {seed: 20260921, strategy: 'greedy_damage', team: ['pet_000112', 'pet_000611', 'pet_000124']};
const CFG_G = {seed: 20260921, strategy: 'greedy_damage', team: ['pet_000190', 'pet_000608', 'pet_000611'],
  enemyTeam: ['pet_000062', 'pet_000445', 'pet_000417']};
const CFG_H = {seed: 20260921, strategy: 'greedy_damage', team: ['pet_000451', 'pet_000601', 'pet_000112'],
  enemyTeam: ['pet_000474', 'pet_000124', 'pet_000417']};

/**
 * 取不到「隔离窗口」的局面检测器（每条一行，附具体原因）。
 * 这些**不是**断言失败，而是这条真实链路上的覆盖缺口，写在这里免得下次有人再找一遍。
 */
const NOT_ISOLATABLE = [
  'ko-maybe（估 X~Y 跨过血线）：引擎对**同一个技能**在三个分析种子下的估算是同一个数'
  + '（min === max），所以「下限 < 血 ≤ 上限」结构上不可能成立；damage_preview 的 min/max '
  + '只是「最弱那招 / 最狠那招」两个**不同**技能的包络。',
  'foe-status-ticking（对面中毒/灼烧/寄生掉血）：12 只精灵的规范配招没有一个直接施加这三种状态，'
  + '而 POST /api/roco/battle/new 不接受 loadouts；取念→复制引燃只在第 44 轮之前的配招序列化缺陷下成立'
  + '（修好后取念只复制对手真实带的 1–3 个技能）。冻结/萌化还会被 _apply_status_effects 直接跳过。',
  'type-favoured（我方上一手打出克制、这一轮还在用那一招）：45 局 / ~500 个窗口里只命中 1 次，'
  + '而且那一次我方满血（血量比 1.0）→ 主动提示门控直接沉默（risk 0.2 < 门槛）。'
  + '**压住它的是门控，不是检测器**；能开口的窗口里它总被更前面的检测器盖过。',
  'foe-low-hp（对面 ≤10% 血、且这一轮没有稳收的招）：这两个条件在真实推进里没有同时出现过——'
  + '对面被压到那个血量时，合法招基本都能收掉（→ ko-now）；收不掉的那些窗口我方也在 35% 以下（→ switch-low-hp）。',
  'foe-energy-high（对面能量 ≥5）：优先级排在第 11 位，所有命中的窗口都先满足了 speed-decides '
  + '或属性检测器，所以它从来没有成为那句建议。',
];

// ── 10 个局面（每个都隔离到它命名的那种局面事实）────────────────────────────
//
// 每个 case 给若干候选参数（seed / team / enemy_team / strategy），按顺序试，
// 取第一个真的出现该局面、且**命名局面是最优先事实**的真实窗口。
// `expectedKind` 是 case 名字对应的检测器；跑出来不是它，就是 K 条判据不满足。
// 隔离注释写明：修复前落在哪、为什么移动、当时是哪个更高优先级的局面在抢。
const CASES = [
  {
    id: '01-ko-now-lethal',
    name: '对手场上残血、我方可以收掉（lethal available）',
    expectedKind: 'ko-now',
    // 修复前：默认队 t3，靠「下一次推进对手真的倒下」间接取证。
    // 现在直接读引擎的收线估算：合法那一招的估算下限 ≥ 对手当前血。
    // 隔离：ko-now 是最优先级里仅次于「必须补位」的一条，双方都残血，没有更高的局面在抢。
    configs: [CFG_A, {seed: 11, strategy: 'greedy_damage'}],
    canAskPlan: (w) => w.phase === 'battle' && w.foe && w.foe.hp > 0 && hpRatio(w) <= 0.6,
    isMatch: (w) => w.phase === 'battle' && hpRatio(w) <= 0.6 && finishAvailable(w),
    evidence: (w) => {
      const best = legalDamageSamples(w).find((s) => s.min >= w.foe.hp);
      return `对手 ${w.foe.name} ${w.foe.hp}HP；合法招「${best.label}」估 ${best.min}，收得掉`;
    },
  },
  {
    id: '02-energy-short',
    name: '能量不足：关键技能能耗高于当前能量，而那一招正好能收掉',
    expectedKind: 'energy-short',
    // 修复前：默认队 t4（寂灭骨龙 1 能量）。现在还是默认队 t4（3 能量），
    // 判据改成引擎检测器真正看的两件事：更狠的那一招不在合法动作里、能耗 > 当前能量、
    // 而且估算盖得过对面血量（否则它「不值得打断玩家」）。
    // 隔离：我方血量 39% > 35%，所以 switch-low-hp 不会抢；对面也没到残血线。
    configs: [CFG_A, {seed: 11, strategy: 'greedy_damage'}],
    canAskPlan: (w) => w.phase === 'battle' && w.foe && w.foe.hp > 0 && hpRatio(w) <= 0.6,
    isMatch: (w) => w.phase === 'battle' && hpRatio(w) <= 0.6 && hpRatio(w) > 0.35
      && foeRatio(w) > 0.1 && !finishAvailable(w) && blockedDecisive(w),
    evidence: (w) => {
      const preview = previewOf(w);
      const legalNames = new Set(w.damaging.map((d) => d.name));
      const blocked = (preview.samples || []).filter((s) => !legalNames.has(s.label));
      return `${w.me.name} ${w.me.energy} 能量；放不出的「${blocked[0].label}」估 `
        + `${blocked[0].min}~${blocked[0].max} 盖得过对面 ${w.foe.hp} 血`;
    },
  },
  {
    id: '03-switch-low-hp',
    name: '我方场上残血、后备有健康精灵（换人是否值得）',
    expectedKind: 'switch-low-hp',
    // 修复前：默认队 t5。现在用 C 队（音速犬/雪影娃娃/圆号鱼）。
    // 隔离：C 队 t6 也能换人，但那一轮我方**能直接收掉对面**（火云车 414 ≥ 102），
    // ko-now 优先，建议层正确地让人先收——所以窗口推到 t7：这一轮收不掉、只能选换不换。
    configs: [CFG_C, {seed: 5, strategy: 'greedy_damage', team: CFG_C.team}],
    canAskPlan: (w) => w.phase === 'battle' && hpRatio(w) <= 0.35 && healthyBench(w),
    isMatch: (w) => w.phase === 'battle' && hpRatio(w) <= 0.35 && healthyBench(w)
      && foeRatio(w) > 0.1 && !finishAvailable(w),
    evidence: (w) => `我方 ${w.me.hp}/${w.me.max}；后备 `
      + w.bench.filter((b) => !b.isActive && !b.fainted).map((b) => `${b.name} ${b.hp}/${b.max}`).join('、'),
  },
  {
    id: '04-type-resisted',
    name: '属性被抗：上一手那一招被抵抗、这一轮还在用它',
    expectedKind: 'type-resisted',
    // 修复前：雪影娃娃镜像 t4（当时只按「所有合法招倍率 < 1」取窗口）。
    // 移动原因：t4 的**上一手**是普通伤害（倍率 1），属性检测器没有被"武装"，
    // 建议层那一轮什么都不说（advice=null）。t6 才是「上一手风吹雪只打出抵抗（26）」
    // 真正成为局面的那一刻。
    // 隔离：我方血量 48% > 35%（switch-low-hp 不抢）；这个血量下 ko-now 不成立；
    // 更狠的超级糖果（e3）估算 176 < 对面 214，所以 energy-short 也不开口。
    configs: [CFG_E, {seed: 5, strategy: 'greedy_damage', team: CFG_E.team}],
    canAskPlan: (w) => w.phase === 'battle' && hpRatio(w) <= 0.6 && hpRatio(w) > 0.35
      && w.damaging.length > 0 && w.damaging.every((d) => d.mult < 1),
    isMatch: (w) => w.phase === 'battle' && hpRatio(w) <= 0.6 && hpRatio(w) > 0.35
      && foeRatio(w) > 0.1 && w.damaging.length > 0 && w.damaging.every((d) => d.mult < 1)
      && resistedHitPending(w) && !finishAvailable(w) && !blockedDecisive(w),
    evidence: (w) => {
      const hit = lastPlayerTypeHit(w);
      return `上一手那一招被抵抗（倍率 ${hit.multiplier}）；这一轮合法招 `
        + w.damaging.map((d) => `${d.name}×${d.mult}`).join('、');
    },
  },
  {
    id: '05-replace-own-faint',
    name: '我方场上倒下、需要补位（phase == replace 且我方 fainted）',
    expectedKind: 'replace-required',
    // 修复前：默认队 t3 的 replace，但那时**倒下的是对手**（对手 0 血、我方 165 血）——
    // 那条 case 名不副实（队友指出）。现在用默认队 t8：我方寂灭骨龙 0/425 且
    // `fainted === true`，补位确实由我方倒下触发；下面还显式断言这个前提。
    configs: [CFG_A, {seed: 5, strategy: 'greedy_damage'}],
    canAskPlan: (w) => w.phase === 'replace' && w.me?.fainted === true,
    isMatch: (w) => w.phase === 'replace' && w.me?.fainted === true && w.switchCount > 0,
    // 装置判据：这个 case 只在「我方自己倒下」时才算数；前提漂了就红，而不是安静换个意思。
    assertWindow: (w) => {
      assert.equal(w.me?.fainted, true,
        'replace 必须由**我方**场上那只倒下触发（me.fainted === true）');
      assert.ok(w.switchCount > 0, '补位必须有可换的目标');
    },
    evidence: (w) => `phase=replace，我方 ${w.me.name} ${w.me.hp}/${w.me.max}（已倒下），`
      + `可选换人 ${w.switchCount} 个`,
  },
  {
    id: '06-ko-now-mid',
    name: '双方都还有余血（39%），但我方这一手刚好够收（收线成立）',
    expectedKind: 'ko-now',
    // 这一格顶替原来被判定为「取不到」的第 2/6/9 条（见 NOT_ISOLATABLE）。
    // 与 01 的区别是血量档位：01 是双方都只剩 8% 的互残局，这里是双方 39%、
    // 靠一招威力刚好够线收掉——同样是 ko-now，但局面不是同一个。
    // 隔离：ko-now 优先级很高，血量 > 35% 也避开了 switch-low-hp。
    configs: [CFG_E, {seed: 5, strategy: 'greedy_damage', team: CFG_E.team}],
    canAskPlan: (w) => w.phase === 'battle' && w.foe && w.foe.hp > 0 && hpRatio(w) <= 0.6,
    isMatch: (w) => w.phase === 'battle' && hpRatio(w) <= 0.6 && hpRatio(w) > 0.35
      && foeRatio(w) > 0.1 && finishAvailable(w),
    evidence: (w) => {
      const best = legalDamageSamples(w).find((s) => s.min >= w.foe.hp);
      return `对手 ${w.foe.name} ${w.foe.hp}HP（我方还有 ${Math.round(hpRatio(w) * 100)}%）；`
        + `合法招「${best.label}」估 ${best.min}，收得掉`;
    },
  },
  {
    id: '07-switch-low-hp-low',
    name: '我方被压到 15%、后备有厚的那只，该不该换',
    expectedKind: 'switch-low-hp',
    // 第二个体感不同的换人局面：G 队（海豹船长/银月狼王/月使鹭纳）对音速犬/黑猫巫师/圆号鱼。
    // 与 03 的区别：这里是 15% 血、对面还有 37%，换人是唯一动作；03 是 28% 血、对面满血。
    // 隔离：这一轮我方收不掉对面（气波 58 < 134），所以 ko-now 不抢。
    configs: [CFG_G, {seed: 5, strategy: 'greedy_damage', team: CFG_G.team, enemyTeam: CFG_G.enemyTeam}],
    canAskPlan: (w) => w.phase === 'battle' && hpRatio(w) <= 0.35 && healthyBench(w),
    isMatch: (w) => w.phase === 'battle' && hpRatio(w) <= 0.35 && healthyBench(w)
      && foeRatio(w) > 0.1 && !finishAvailable(w),
    evidence: (w) => `我方 ${w.me.name} ${w.me.hp}/${w.me.max}；后备 `
      + w.bench.filter((b) => !b.isActive && !b.fainted).map((b) => `${b.name} ${b.hp}/${b.max}`).join('、'),
  },
  {
    id: '08-speed-slower',
    name: '对手比我方快：同一档对拼是它先出手',
    expectedKind: 'speed-decides',
    // 修复前：seed5 默认队 t8（黑猫巫师 70 vs 海豹船长 100）。现在用 conservative_switch t6：
    // 寂灭骨龙 60 vs 雪影娃娃 90。
    // 隔离：我方 51% 血（> 35%，switch-low-hp 不抢）、对面 56%（不残）、这一轮收不掉（诡刺 85 < 247）、
    // 上一手没有带属性倍率的一击（type 检测器不抢）——所以「谁先动」就是这个世界的主要问题。
    configs: [CFG_D, {seed: 5, strategy: 'conservative_switch', enemyTeam: CFG_D.enemyTeam}],
    canAskPlan: (w) => w.phase === 'battle' && w.me && w.foe && hpRatio(w) <= 0.6
      && w.me.spe < w.foe.spe,
    isMatch: (w) => w.phase === 'battle' && w.me && w.foe && hpRatio(w) <= 0.6 && hpRatio(w) > 0.35
      && foeRatio(w) > 0.1 && w.me.spe < w.foe.spe && !finishAvailable(w)
      && noPendingTypeMatchup(w) && !blockedDecisive(w),
    evidence: (w) => `我方 ${w.me.name} 速度 ${w.me.spe}，对手 ${w.foe.name} 速度 ${w.foe.spe}（它更快）`,
  },
  {
    id: '09-speed-faster',
    name: '我方比对手快：这一轮可以先手压上去',
    expectedKind: 'speed-decides',
    // 速度局面的另一半：H 队（秩序鱿墨/圣凯布米龙/雪影娃娃）对画间沉铁兽/化蝶/圆号鱼，
    // 这一轮我方速度 130 vs 对手 92。同一个检测器、**相反的先手方向**，
    // 句子也是另一句（「你速度 X 快过它 Y」）——这是 A 条要求的第 7 种形状。
    configs: [CFG_H, {seed: 11, strategy: 'greedy_damage', team: CFG_H.team, enemyTeam: CFG_H.enemyTeam}],
    canAskPlan: (w) => w.phase === 'battle' && w.me && w.foe && hpRatio(w) <= 0.6
      && w.me.spe > w.foe.spe,
    isMatch: (w) => w.phase === 'battle' && w.me && w.foe && hpRatio(w) <= 0.6 && hpRatio(w) > 0.35
      && foeRatio(w) > 0.1 && w.me.spe > w.foe.spe && !finishAvailable(w)
      && noPendingTypeMatchup(w) && !blockedDecisive(w),
    evidence: (w) => `我方 ${w.me.name} 速度 ${w.me.spe}，对手 ${w.foe.name} 速度 ${w.foe.spe}（我更快）`,
  },
  {
    id: '10-peaceful',
    name: '双方都接近满血、局面平稳（没有值得说的局面事实，应当沉默）',
    expectedKind: null,
    // 没有移动（原来是默认队 t1）。但默认队 t1 其实**不是**「无话可说」：
    // 那一轮 energy-short 检测器是成立的（坟场搏击 e4 放不出、估算 469 盖得过对面 425 血），
    // 只是被主动提示门控按住了（满血 → risk 0.2 < 门槛）。拿它当「平稳」会名不副实。
    // 换成 E 队 t1（双方 442/442）：这一轮连检测器都不开口——超级糖果 e3 放不出，
    // 但它的估算 176 盖不过对面 442 血，所以 energy-short 也主动放弃。
    // 这才是「平稳 = 建议层自己没说」的那种窗口；E 条同时要求它确实是沉默的。
    configs: [CFG_E, {seed: 5, strategy: 'greedy_damage', team: CFG_E.team}],
    canAskPlan: (w) => w.phase === 'battle' && hpRatio(w) >= 0.9 && foeRatio(w) >= 0.9,
    isMatch: (w) => w.phase === 'battle' && hpRatio(w) >= 0.9 && foeRatio(w) >= 0.9,
    evidence: (w) => `我方 ${w.me.hp}/${w.me.max}，对手 ${w.foe.hp}/${w.foe.max}`,
  },
];

function describeConfig(config) {
  const team = config.team ? config.team.join('+') : DEFAULT_TEAM.join('+');
  const enemy = config.enemyTeam ? config.enemyTeam.join('+') : '（缺省＝与我方同队）';
  return `seed=${config.seed} strategy=${config.strategy} team=[${team}] enemy=[${enemy}]`;
}

// ── 断言 F：不允许编造（hint 说的每个具体事实，同一个局面里必须真的有）──────
//
// 事实来源只有三处：公开视图（血压/能量/速度/异常/印记/合法动作/配招技能名）、
// `/api/roco/plan` 回执（伤害预览、期望/最坏/风险这些引擎自己算出来的数）、
// 以及这两份里字符串自带的数字（例如推荐标签「换上第3位」里的 3）。
// hint 里出现别的东西就是编造；这条守卫把「说得像真的」挡在验收之外。
function numericFactsOf(w) {
  const values = [];
  const push = (v) => { if (Number.isFinite(v)) values.push(v); };
  const petFacts = (p) => {
    if (!p) return;
    push(p.hp); push(p.max); push(p.energy); push(p.spe);
    if (p.max > 0) { push(p.hp / p.max * 100); push(Math.round(p.hp / p.max * 100)); }
    for (const v of Object.values(p.statuses || {})) {
      if (typeof v === 'number') push(v);
      else if (v && typeof v === 'object') push(v.layers);
    }
  };
  push(w.turn);
  push(w.switchCount);
  push(w.items.length);
  petFacts(w.me); petFacts(w.foe);
  for (const b of w.bench) petFacts(b);
  for (const d of w.damaging) { push(d.energy); push(d.power); }
  // 全队配招（UI 公开面板）：不提这一块，「能量还差 4」这类**由配招能耗算出来**的
  // 数字就会被误判成编造。
  for (const s of w.selfSkills) { push(s.energy); push(s.power); }
  const plan = w.plan || {};
  const dp = plan.damage_preview;
  if (dp) {
    push(dp.min); push(dp.max); push(dp.foe_hp); push(dp.candidates);
    for (const s of dp.samples || []) { push(s?.min); push(s?.max); }
  }
  for (const bucket of [plan.expected, plan.worst, plan.best, plan.first_second_margin]) {
    if (bucket && typeof bucket === 'object') for (const v of Object.values(bucket)) push(v);
  }
  if (plan.risk) { push(plan.risk.downside_min); push(plan.risk.downside_max); push(plan.risk.threshold); }
  for (const label of [plan.recommendation, plan.main_counter]) {
    if (typeof label === 'string') for (const m of label.match(/-?\d+(?:\.\d+)?/g) || []) push(Number(m));
  }
  // 「还差多少」这类差值也要有依据：能量与血量之间的差是最常见的。
  const base = [w.me?.hp, w.me?.max, w.foe?.hp, w.foe?.max, w.me?.energy, w.foe?.energy,
    dp?.min, dp?.max, dp?.foe_hp, ...w.damaging.map((d) => d.energy),
    ...w.selfSkills.map((s) => s.energy)].filter(Number.isFinite);
  for (let i = 0; i < base.length; i += 1) {
    for (let j = i + 1; j < base.length; j += 1) push(Math.abs(base[i] - base[j]));
  }
  return values;
}

function fabricatedClaims(text, w) {
  const problems = [];
  const allowed = new Set();
  for (const p of [w.me, w.foe, ...w.bench]) if (p?.name) allowed.add(p.name);
  for (const d of w.damaging) allowed.add(d.name);
  for (const s of w.selfSkills) if (s.name) allowed.add(s.name);
  for (const s of w.plan?.damage_preview?.samples || []) if (s?.label) allowed.add(s.label);
  if (w.plan?.recommendation) allowed.add(w.plan.recommendation);
  if (w.plan?.main_counter) allowed.add(w.plan.main_counter);
  for (const name of NAMES) {
    if (!String(text).includes(name)) continue;
    if (!allowed.has(name)) problems.push(`提到的「${name}」在这个局面里不存在`);
  }
  const facts = numericFactsOf(w);
  for (const token of String(text).match(/-?\d+(?:\.\d+)?/g) || []) {
    const value = Number(token);
    if (!facts.some((v) => Math.abs(v - value) <= 0.006)) {
      problems.push(`数字 ${token} 在这个局面里找不到依据`);
    }
  }
  return problems;
}

test('P1 验收：10 个真实局面各自得到「对路」的建议，且句子在种类上不同',
  {skip: SKIP}, async () => {
    const {post, close} = await startServer();
    const rows = [];
    try {
      for (const c of CASES) {
        let found = null;
        const failures = [];
        for (const config of c.configs) {
          const attempt = await findPosition({post, config, canAskPlan: c.canAskPlan, isMatch: c.isMatch});
          if (attempt.window) { found = {...attempt, config}; break; }
          failures.push(`${describeConfig(config)} → ${attempt.error}`);
        }
        // 这一条是**装置**判据，不是 P1 判据：局面必须真的能从真引擎取到。
        assert.ok(found, `装置失败：${c.id}「${c.name}」在真引擎上取不到。\n  `
          + failures.join('\n  '));

        const {window: w, config, steps} = found;
        // 提示链路必须拿到真规划结果；拿不到就说明装置断了，不是 P1 的问题。
        assert.equal(w.plan?.ok, true, `装置失败：${c.id} 的 /api/roco/plan 没成功：`
          + `${w.plan?.error || '（没有回执）'}`);
        if (c.assertWindow) c.assertWindow(w);

        const detail = rocoIntervention({
          view: w.rawView,
          session: freshSession(),
          plan: w.plan,
          host: {focus: true, preference: 'gentle'},
          now: 1000,
        });
        const spoken = rocoInterventionText(detail, w.plan);
        rows.push({
          id: c.id,
          name: c.name,
          expectedKind: c.expectedKind,
          observedKind: detail.advice?.kind ?? null,
          config: describeConfig(config),
          steps,
          turn: w.turn,
          phase: w.phase,
          action: detail.action,
          gate: detail.gate,
          evidence: c.evidence(w),
          text: spoken ? spoken.text : null,
          shape: spoken ? shapeOf(spoken.text) : null,
          recommendation: w.plan?.recommendation ?? null,
          window: w,
        });
      }
    } finally {
      close();
    }

    // ── 给人看的表：局面 → 期望/实际 kind → 形状 → 原句 ──────────────────
    const spokenRows = rows.filter((r) => r.text != null);
    const shapeCounts = new Map();
    for (const r of spokenRows) shapeCounts.set(r.shape, (shapeCounts.get(r.shape) || 0) + 1);
    const kindCounts = new Map();
    for (const r of rows) {
      if (!r.observedKind) continue;
      kindCounts.set(r.observedKind, (kindCounts.get(r.observedKind) || 0) + 1);
    }
    const width = Math.max(...rows.map((r) => r.name.length)) + 2;
    const table = rows.map((r) => [
      r.id.padEnd(24),
      r.name.padEnd(width),
      `kind=${r.observedKind ?? '（无建议）'}`.padEnd(24),
      (r.shape || '（silent：没有文案）'),
      '|',
      (r.text || '').replace(/\n/g, ' '),
    ].join(' '));
    console.log('\n=== 10 个隔离过的真实局面上的真实建议 =====================================');
    console.log(`局面 → 实际 kind → 形状 → 原句（共 ${spokenRows.length}/${rows.length} 个局面开口）`);
    for (const line of table) console.log(line);
    console.log('\n--- 形状统计（引号内容/数字/精灵名/技能名 → 占位符）---------------------');
    for (const [shape, count] of [...shapeCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(2)} × ${shape}`);
    }
    console.log(`  不同形状 ${shapeCounts.size} 种；开口局面 ${spokenRows.length} 个`);
    console.log('\n--- 检测器 kind 统计 ----------------------------------------------------');
    for (const [kind, count] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(2)} × ${kind}`);
    }
    console.log(`  不同 kind ${kindCounts.size} 种`);
    console.log('\n--- 每个局面的取证（真引擎参数）-----------------------------------------');
    for (const r of rows) {
      console.log(`  ${r.id} ${r.config} | 推进 ${r.steps} 步到 turn ${r.turn}（phase=${r.phase}）`);
      console.log(`      证据：${r.evidence}`);
      console.log(`      期望 kind=${r.expectedKind ?? '（应当沉默）'} → 实际 kind=${r.observedKind ?? '（无建议）'}`
        + `；判定 ${r.action}${r.gate ? `（硬门控 ${r.gate}）` : ''}；plan 推荐=${r.recommendation ?? '（无）'}`);
    }
    console.log('\n--- 取不到「隔离窗口」的检测器（覆盖缺口，不是断言失败）-----------------');
    for (const line of NOT_ISOLATABLE) console.log(`  · ${line}`);
    console.log('=========================================================================\n');

    // 局面之间必须真的不同（同一局面的复述不算十个局面）。
    const signatures = rows.map((r) => `${r.config}|turn ${r.turn}|${r.phase}|${r.evidence}`);
    assert.equal(new Set(signatures).size, rows.length,
      `有局面重复了，装置不对：\n${signatures.join('\n')}`);

    // ── 验收判据 A–G + K ────────────────────────────────────────────────
    // 全部跑完再一起报：一次运行就能看到「哪几条不满足」，而不是被第一条挡住。
    const problems = [];
    const listing = () => `\n形状统计：\n`
      + [...shapeCounts.entries()].sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `  ${n} × ${s}`).join('\n')
      + `\n（每个局面 → kind → 形状 → 原句的完整表已打印在测试输出里）`;

    // ── K：每个 case 必须真的说出它命名的那种局面 ────────────────────────
    for (const r of rows) {
      if (r.observedKind !== r.expectedKind) {
        problems.push(`K：${r.id}「${r.name}」期望 kind=${r.expectedKind ?? '（应当沉默）'}，`
          + `实际 kind=${r.observedKind ?? '（无建议）'}`
          + `${r.text ? `；原句：${r.text}` : ''}。窗口隔离没做到，case 名与断言已经漂了`);
      }
    }

    // ── A：至少 6 种不同形状 ─────────────────────────────────────────────
    if (shapeCounts.size < 6) {
      problems.push(`A：只有 ${shapeCounts.size} 种句子形状（要求 ≥6）。${listing()}`);
    }

    // ── B：没有哪一种形状占到开口局面的 60% 以上 ─────────────────────────
    const worst = [...shapeCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const share = worst && spokenRows.length ? worst[1] / spokenRows.length : 0;
    if (spokenRows.length === 0) {
      problems.push('B：没有任何局面开口，这条判据没有意义');
    } else if (share > 0.6) {
      problems.push(`B：形状「${worst[0]}」占了 ${worst[1]}/${spokenRows.length} = `
        + `${(share * 100).toFixed(0)}%（上限 60%）。这就是「同一模板换数字」：\n`
        + rows.filter((r) => r.shape === worst[0]).map((r) => `  ${r.id} ${r.text}`).join('\n')
        + listing());
    }

    // ── C：没有工程词汇，也不能有花括号 ──────────────────────────────────
    for (const r of spokenRows) {
      for (const word of FORBIDDEN) {
        if (r.text.includes(word)) {
          problems.push(`C：${r.id} 的提示里出现了工程词汇「${word}」：${r.text}`);
        }
      }
      if (/[{}]/.test(r.text)) problems.push(`C：${r.id} 的提示里有花括号：${r.text}`);
    }

    // ── D：开口就必须点出动作或一个具体观察 ─────────────────────────────
    for (const r of spokenRows) {
      if (!namesSomething(r.text)) {
        problems.push(`D：${r.id} 的提示既没有点名动作/技能/精灵，`
          + `也没有明确的「先观察」立场：${r.text}`);
      }
    }

    // ── E：平稳局面要么不说话，要么说的是有区分度的形状 ─────────────────
    const peaceful = rows.find((r) => r.id === '10-peaceful');
    if (!['silent', 'defer_to_review'].includes(peaceful.action)) {
      if (!peaceful.text) problems.push(`E：平稳局面开口了却没有文案：${JSON.stringify(peaceful)}`);
      else if (!shapeCounts.has(peaceful.shape)) {
        problems.push(`E：平稳局面说的形状不在本次统计里：${peaceful.shape}`);
      }
    }

    // ── F：不编造 —— 每个具体事实都要在同一个局面里找得到 ────────────────
    for (const r of spokenRows) {
      const claims = fabricatedClaims(r.text, r.window);
      for (const claim of claims) problems.push(`F：${r.id} 的提示${claim}：${r.text}`);
    }

    // ── G：至少 6 种不同的检测器 kind ────────────────────────────────────
    if (kindCounts.size < 6) {
      problems.push(`G：只有 ${kindCounts.size} 种检测器 kind（要求 ≥6）：\n`
        + [...kindCounts.entries()].map(([k, n]) => `  ${n} × ${k}`).join('\n'));
    }

    assert.ok(problems.length === 0,
      `P1 验收未通过，共 ${problems.length} 条判据不满足（A/B/C/D/E/F/G/K）：\n\n`
      + problems.join('\n\n'));
  });
