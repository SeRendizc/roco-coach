// 手游「局面 → 建议」验收的**共享装置**。
//
// 为什么它存在（而不是两边各写一份）
// --------------------------------
// 同一件事有两个验收面：
//   · 引擎侧 `tests/evals/roco/coach-positions.test.js`：真 Python 引擎上的 10 个隔离局面；
//   · 浏览器侧 `scripts/roco/demo-acceptance.mjs`：真页面上逐局面收集气泡，
//     再用**同一批可观测量**在 Node 里独立重算一遍，逐条比对。
//
// 浏览器侧的判据是「页面上显示的 === Node 侧重算的」。如果两侧各自写一份
// 「公开视图 → coachAdvice 入参」的构造，它们会**慢慢漂**：等到对不上时，
// 你分不清是页面错了、还是重算的构造错了——那种红是最没价值的红。
// 所以构造只此一份，两处都 import 它。
//
// 纪律（这个文件里不许出现的东西）
//   · 不 import 任何 `src/client/*`（那是浏览器模块图，见结构契约测试）；
//   · 不捏 payload：所有 `view` / `plan` 都来自真服务回执，这里只做搬运与投影；
//   · 不写死精灵名：名字表从 `data/roco/normalized` 读。
//
// 这个文件被 `scripts/` 与 `tests/` 共同 import，所以它只能依赖 Node 标准库 +
// `src/server`（真服务）与 `src/coach`（被验收的那一层本身）。

import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createCoachServer} from '../../src/server/index.js';
import {coachAdvice, COACH_ADVICE_KINDS} from '../../src/coach/coach-advice.js';
import {rocoGameView, rocoIntervention, rocoInterventionText} from '../../src/coach/roco-experience.js';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const DATA = join(ROOT, 'data', 'roco', 'normalized', 'roco-world-s4-2026-09-10');

// ── python3 探测（不可用就跳过，与 intervention-margin-chain.test.js 同一口径）──
export function probePython(bin) {
  try {
    execFileSync(bin, ['-c', 'import sys;print(sys.version_info[0])'], {encoding: 'utf8'});
    return {ok: true};
  } catch (error) {
    return {ok: false, error: String(error.message).slice(0, 80)};
  }
}

export const PYTHON = probePython(process.env.ROCO_PYTHON || 'python3');
export const SKIP = PYTHON.ok ? false : `python3 不可用（${PYTHON.error}）`;

// ── 规则集数据（只读，用来把真实局面翻译成可读证据；不改任何东西）───────────
export const readJson = (name) => JSON.parse(readFileSync(join(DATA, name), 'utf8'));
export const PETS = readJson('pets.json').pets;
export const SKILLS = readJson('skills.json').skills;
export const TYPE_CHART = readJson('types.json').types;
export const SUPPORT = readJson('support-matrix.json');

/** 每只精灵的规范配招（引擎 `Ruleset.candidate_moveset` 的同一份来源）。 */
export const MOVESETS = {};
for (const entry of SUPPORT.pets || []) {
  const ids = ((entry.candidate_moveset || {}).skills || [])
    .map((s) => s.skill_id).filter(Boolean);
  if (ids.length) MOVESETS[entry.pet_id] = ids;
}

/** 属性倍率：与引擎同一个方向（攻方系别 → 守方属性表）。 */
export function typeMultiplier(element, defenderTypes) {
  const key = [...(defenderTypes || [])].sort().join('|');
  const row = TYPE_CHART[key];
  if (!row) return 1;
  for (const r of row.resist || []) if (r.type === element) return r.multiplier;
  for (const w of row.weak || []) if (w.type === element) return w.multiplier;
  return 1;
}

// ── 句子形状 ────────────────────────────────────────────────────────────────
//
// 需求原话是「换个技能名和数字不算不同」，所以有两档口径：
//   · `shapeOf`（**浏览器侧**口径，也是需求逐字写下的那一条）：
//       ① 数字（含小数点与负号）→ `#`；
//       ② 引号里的动作/技能/道具/伙伴标签 → `「◆」`。
//   · `shapeOfWithNames`（**引擎侧**口径）：在上一档之上再把裸露的精灵名/技能名 → `◆`。
//     引擎侧那一份必须更严：那里的句子可能不带引号地写出技能名（「注意对方可能诡刺」），
//     只归一化数字的话，同一模板的多次复现会被算成多种形状，正好把这个缺陷放过。
export function shapeOf(text) {
  return String(text ?? '')
    .replace(/「[^」]{0,40}」/g, '「◆」')
    .replace(/-?\d+(?:\.\d+)?/g, '#');
}

const NAME_ESCAPE = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 真实存在的精灵名 / 技能名（长的排前面，避免短名先吃掉长名的一部分）。 */
export const NAMES = [...new Set([
  ...Object.values(PETS).map((p) => p.name),
  ...Object.values(SKILLS).map((s) => s.name),
].filter((n) => typeof n === 'string' && n.length >= 2))].sort((a, b) => b.length - a.length);

export const NAME_RE = new RegExp(NAMES.map(NAME_ESCAPE).join('|'), 'g');
// 不带 /g 的探针：`/g` 正则的 `test()` 有 lastIndex 状态，会随调用次数飘。
export const NAME_PROBE = new RegExp(NAME_RE.source);

export function shapeOfWithNames(text) {
  return shapeOf(text).replace(NAME_RE, '◆');
}

/** 名字 → 可读标签（产物里只写名字，不写内部 id）。 */
export const nameOfPet = (petId) => PETS[petId]?.name ?? null;

/**
 * 这句话点了名没有（引擎侧 D 判据）。
 *   · 引号里的动作/技能/道具标签；或
 *   · 任何一个真实存在的精灵名 / 技能名（裸写）；或
 *   · 一句明确的**动作**；或
 *   · 一句明确的「先观察 / 不硬给答案」立场。
 */
export const ACTION_PATTERN = /换人|换上|顶上|切换到|使用|吃「|补位|防御|收掉|收线|直接收|补上|别硬顶|别硬对拼|躲一下|拖住节奏|压上去/;
export const STANCE_PATTERN = /先按你的判断走|先看局面|按局面常识走|先观察|保持观察|允许沉默|再观察/;

export function namesSomething(text) {
  if (/「[^」]{1,24}」/.test(text)) return true;
  if (NAME_PROBE.test(text)) return true;
  if (ACTION_PATTERN.test(text)) return true;
  return STANCE_PATTERN.test(text);
}

/** 引擎侧禁词表（`coach-positions.test.js` 的 C 判据）。 */
export const FORBIDDEN = ['state_version', 'quota', 'coverage', 'margin', 'worst', '尾部', '区间',
  '分支', '分析种子', 'score', 'critical', 'degrade', 'JSON', 'undefined', 'null', 'NaN'];

/**
 * **玩家可见文案**侧的禁词表（浏览器矩阵沿用现有 demo-acceptance 的口径，
 * 再补上需求逐字点名的 `pet_id` 与裸 JSON 片段）。
 *
 * ⚠️ 它只用来扫**玩家看得见的字符串**（气泡正文、依据行、Node 侧重算文本），
 * 不扫产物本身：产物要记 seed、要记形状，「种子」「#」这些字在**元数据**里是合法的。
 */
export const PLAYER_FORBIDDEN = Object.freeze([
  '区间', '尾部', 'margin', 'score', '种子', 'coverage', 'state_version', 'pet_id',
]);

/** 裸 JSON 片段（`{"` / `[{` 这类）——玩家句子里出现它就是在漏内部结构。 */
export const RAW_JSON_PATTERN = /\{\s*"|\[\s*\{/;

/** 玩家可见字符串里是否出现工程术语或裸 JSON。返回命中的词（没有就是空数组）。 */
export function engineeringTermsIn(text) {
  const value = String(text ?? '');
  const hits = PLAYER_FORBIDDEN.filter((word) => value.includes(word));
  if (RAW_JSON_PATTERN.test(value)) hits.push('裸 JSON');
  return hits;
}

// ── 页面与引擎共用的会话形状 ────────────────────────────────────────────────
export const freshSession = () => ({hints: 0, lastAt: -Infinity, dismissed: false, said: new Set(),
  readings: new Set(), topics: new Set(), limit: 3});

// ── 真服务 + 真路由 ────────────────────────────────────────────────────────
export async function startServer({semantic = false, fetchImpl} = {}) {
  const options = {semantic};
  if (fetchImpl) options.fetchImpl = fetchImpl;
  const server = createCoachServer(options);
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
  const get = (path) => fetch(base + path, {headers: {Cookie: cookie}}).then((r) => r.json());
  return {
    base,
    post,
    get,
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

/** 把一份真实公开视图压成判定用的最小事实集（只读公开字段）。 */
export function windowOf(view) {
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
    // 己方全队的配招技能（UI 视图公开）：断言「这个名字/这个能耗真的在这场里」会用到。
    selfSkills: (view?.self?.skills || []).filter(Boolean)
      .map((s) => ({name: s.name, energy: s.energy, power: s.power})),
    // 上一手的公开事件（属性倍率、状态结算都在这）：局面判据要读它，断言也要读它。
    events: (Array.isArray(view?.events) ? view.events : [])
      .map((e) => ({kind: e?.kind ?? null, side: e?.side ?? null, detail: e?.detail ?? null})),
    items: legal.filter((a) => a.kind === 'item').map((a) => a.item_id ?? a.label),
    tickEvents: (Array.isArray(view?.events) ? view.events : [])
      .map((e) => e?.text).filter((t) => typeof t === 'string' && /因(灼烧|中毒|寄生)损失/.test(t)),
    switchCount: legal.filter((a) => a.kind === 'switch').length,
  };
}

export const hpRatio = (w) => (w.me && w.me.max > 0 ? w.me.hp / w.me.max : 1);
export const foeRatio = (w) => (w.foe && w.foe.max > 0 ? w.foe.hp / w.foe.max : 1);

/** 规划回执里的伤害预览（引擎的原始伤害估算）。 */
export const previewOf = (w) => (w.plan?.damage_preview?.available === true ? w.plan.damage_preview : null);

/**
 * **合法**技能的估算区间。
 *
 * `damage_preview.min/max` 是**整份配招**（含这一步出不了的招）的包络，不能直接拿来
 * 回答「这一手收不收得掉」——那要按**合法**动作去 `samples` 里查同一招。
 */
export function legalDamageSamples(w) {
  const preview = previewOf(w);
  if (!preview || !Array.isArray(preview.samples)) return [];
  const legalNames = new Set(w.damaging.map((d) => d.name));
  return preview.samples.filter((s) => s && legalNames.has(s.label));
}

/** 这一轮真有「稳收」的一手（合法招的估算下限 ≥ 对手当前血）。 */
export const finishAvailable = (w) => Boolean(w.foe) && w.foe.hp > 0
  && legalDamageSamples(w).some((s) => Number.isFinite(s.min) && s.min >= w.foe.hp);

/** 规范配招里这一招的能耗（引擎自己的配招来源；不是猜的）。 */
export function loadoutEnergyOf(petId, skillName) {
  const skill = (MOVESETS[petId] || []).map((sid) => SKILLS[sid])
    .find((s) => s && s.name === skillName);
  return skill && Number.isFinite(skill.energy) ? skill.energy : null;
}

/**
 * 「更狠的那一招放不出来，而且它估算盖得过对面血量」——这是 energy-short 检测器的
 * 公开事实判据（能耗 > 当前能量 + 估算能收）。用它把「能量局面」与「只是招不够狠」分开。
 */
export function blockedDecisive(w) {
  const preview = previewOf(w);
  if (!preview || !w.foe || !w.me) return false;
  const legalNames = new Set(w.damaging.map((d) => d.name));
  return (preview.samples || []).some((s) => s && !legalNames.has(s.label)
    && Number.isFinite(s.max) && s.max >= w.foe.hp
    && (loadoutEnergyOf(w.me.pet_id, s.label) ?? 0) > w.me.energy);
}

/** 后备里有血比 ≥60% 的健康伙伴（switch-low-hp 的前提之一）。 */
export const healthyBench = (w) => w.bench.some((b) => !b.isActive && !b.fainted && b.max > 0 && b.hp / b.max >= 0.6);

/**
 * 引擎公开事件里「我方上一手打出的、带属性倍率的那一击」。
 * 与建议层 `lastMyTypeHit` 同一口径：那一击之后对面没有换人/倒下，倍率才属于**现在**场上这只。
 */
export function lastPlayerTypeHit(w) {
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
export function resistedHitPending(w) {
  const hit = lastPlayerTypeHit(w);
  return Boolean(hit) && hit.multiplier < 1
    && w.damaging.some((d) => d.skill_id === hit.skillId);
}

/** 上一手那一招没有属性信息（倍率恰好 1 或没打出伤害）→ type 检测器不会开口。 */
export function noPendingTypeMatchup(w) {
  const hit = lastPlayerTypeHit(w);
  return !hit || hit.multiplier === 1;
}

/**
 * 公开可观测量：**产物里唯一允许出现的局面事实**。
 *
 * 纪律（产物是要交给别人核对的，泄一次就废了）：
 *   · 只搬公开视图里真的有的字段，只搬**双方场上那一只**的对手信息——
 *     对手后备在公开视图里**只有位次与是否倒下**，这里既不补血量、也不补能量/配招；
 *   · 精灵只写名字，**绝不写 `pet_id`**；
 *   · 不搬 `state_version`、不搬任何内部评分（`detail.value/floor/decisive`）。
 */
export function observableOf(view) {
  const w = windowOf(view);
  const byKind = {};
  for (const a of w.legal) {
    const kind = a.kind ?? 'unknown';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  // 系别只在原始公开视图上（`windowOf` 只搬判定要用的字段，不重复搬一份展示字段），
  // 所以这里显式从 view 上取——少取一次的后果是产物里双方系别恒为空数组。
  const activeIndex = Number.isInteger(view?.self?.active) ? view.self.active : 0;
  const rawMine = view?.self?.pets?.[activeIndex] ?? null;
  const rawFoe = view?.opponent?.field ?? null;
  const pet = (p, raw) => (p ? {
    name: p.name, types: Array.isArray(raw?.types) ? raw.types.slice() : [],
    hp: p.hp, max_hp: p.max,
    energy: p.energy, spe: p.spe, statuses: Object.keys(p.statuses ?? {}).sort(),
    fainted: p.fainted === true,
  } : null);
  return {
    turn: w.turn,
    phase: w.phase,
    my_active: pet(w.me, rawMine),
    foe_active: pet(w.foe, rawFoe),
    // 我方后备是公开的（页面自己就画着血条）；对手后备只留位次与是否倒下。
    my_bench: w.bench.filter((b) => !b.isActive)
      .map((b) => ({name: b.name, hp: b.hp, max_hp: b.max, energy: b.energy, fainted: b.fainted === true})),
    foe_bench: (Array.isArray(view?.opponent?.bench) ? view.opponent.bench : [])
      .map((b) => ({slot: b.slot ?? null, fainted: b.fainted === true})),
    legal: {
      total: w.legal.length,
      by_kind: byKind,
      skill_names: w.legal.filter((a) => a.kind === 'skill' && a.name).map((a) => a.name),
      action_labels: w.legal.map((a) => a.label).filter((x) => typeof x === 'string'),
    },
  };
}

// ── 建议层的**唯一**重算入口（浏览器侧与引擎侧都用它）─────────────────────────
//
// 页面上的判定与重算必须喂**同样的**四样东西：公开视图、这一步的 plan、局内记账、宿主门控。
// 这个函数就是那四样的构造，别在别处再拼一次。
//
// ⚠️ `adviceOf` 是**再算一遍**，不是读页面的 `lastDetail`：
//    · `game` 走 `rocoGameView(view)`（页面走的是同一个投影，`refreshHint` 里那一次）；
//    · `plan` 必须是**这一步用的那一份**（页面上是 `state.hint.plan`，也就是 `state.plan`）；
//    · `session` 只需要 `dismissed` 与 `said`（重算时用**页面记账里已有的形状**，
//      不含刚刚显示的这一条——页面的 `alreadySaid` 判据发生在写入之前）。
export function adviceOf({view, plan = null, said = [], dismissed = false, ended = false} = {}) {
  const game = rocoGameView(view, {matchId: null});
  const session = {...freshSession(), dismissed: dismissed === true, said: new Set(said)};
  const advice = coachAdvice({
    game,
    plan,
    session,
    host: {preference: 'gentle', stale: false, ended: ended === true,
      background: false, focus: true},
  });
  return {game, advice};
}

// ── 引擎侧：在一条真链路上找一个「隔离窗口」─────────────────────────────────
export async function findPosition({post, config, canAskPlan, isMatch, maxTurns = 14}) {
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

/** 建议层可能产出的全部 kind（对外契约的那一份，不在这里另抄一份清单）。 */
export const COACH_ADVICE_KINDS_LIST = COACH_ADVICE_KINDS;

export const DEFAULT_TEAM = ['pet_000225', 'pet_000190', 'pet_000445'];

/** 手游 12 只精灵（`data/roco/normalized` 的顺序，写死以保证扫描样本可复现）。 */
export const PET_IDS = Object.freeze(['pet_000062', 'pet_000112', 'pet_000124', 'pet_000190',
  'pet_000225', 'pet_000417', 'pet_000445', 'pet_000451', 'pet_000474', 'pet_000601',
  'pet_000608', 'pet_000611']);

/**
 * 确定性的阵容样本：按固定顺序枚举我方三人排列（1320 个），每 `stride` 个取一个，
 * 每个再配一个「镜像对手」与一个「倒序对手」。**不用随机**——样本一变，
 * 「哪些 kind 不可达」这句话就不再有可比性。
 */
export function coverageLineups({stride = 8, seeds = [20260921, 5, 11]} = {}) {
  const triples = [];
  for (const a of PET_IDS) for (const b of PET_IDS) for (const c of PET_IDS) {
    if (a === b || b === c || a === c) continue;
    triples.push([a, b, c]);
  }
  const out = [];
  let picked = 0;
  for (let i = 0; i < triples.length; i += stride) {
    const team = triples[i];
    const seed = seeds[picked % seeds.length];
    picked += 1;
    out.push({seed, team});
    out.push({seed, team, enemyTeam: [...team].reverse()});
  }
  return {lineups: out, triples_total: triples.length, stride, seeds: [...seeds]};
}

/**
 * 引擎侧 kind 覆盖扫描。
 *
 * 为什么需要它：矩阵只能证明**被选中的局面**是对的，回答不了
 * 「剩下那些 kind 为什么没进矩阵」。没有这份扫描，「不可达」就只是作者的断言；
 * 有了它，每一个 kind 都能给出「命中多少次 / 气泡显示多少次 / 沉默时我方血量比多少」。
 *
 * 走的是与页面**同一条**真实链路：`/api/roco/battle/new` → `/api/roco/battle/advance`
 * → `/api/roco/plan` → `rocoIntervention`，局内记账固定为「干净的会话」。
 * 它**不**改任何判据，只读取。
 */
export async function scanKindCoverage({post, lineups, maxTurns = 12, onBattle} = {}) {
  const kinds = {};
  let battles = 0;
  let steps = 0;
  for (const spec of lineups) {
    const started = await post('/api/roco/battle/new', {seed: spec.seed, strategy: 'greedy_damage',
      team: spec.team, ...(spec.enemyTeam ? {enemy_team: spec.enemyTeam} : {})});
    if (!started.ok) continue;
    battles += 1;
    let current = started;
    for (let step = 0; step <= maxTurns; step += 1) {
      const view = current.view;
      if (!view || view.battle_result) break;
      const w = windowOf(view);
      w.plan = await post('/api/roco/plan', {battle_id: started.battle_id, depth: 2, beam: 4});
      const detail = rocoIntervention({view, session: freshSession(), plan: w.plan,
        host: {focus: true, preference: 'gentle', now: 1000}});
      const spoken = rocoInterventionText(detail, w.plan);
      const kind = detail.advice?.kind ?? null;
      if (kind) {
        const entry = kinds[kind] ?? (kinds[kind] = {hit: 0, shown: 0, shown_battle_phase: 0,
          silent_at_low_hp: 0, silent_at_full_hp: 0, first_shown: null, shown_windows: []});
        entry.hit += 1;
        if (spoken) {
          entry.shown += 1;
          if (w.phase === 'battle') entry.shown_battle_phase += 1;
          // **真的显示出来了**的窗口要能定位回具体局面，否则「可达」这句话没法被复现。
          if (entry.shown_windows.length < 4) {
            entry.shown_windows.push({seed: spec.seed, team: spec.team,
              enemyTeam: spec.enemyTeam ?? null, advances: step, turn: w.turn, phase: w.phase,
              action: detail.action, my_hp_ratio: Number(hpRatio(w).toFixed(3)),
              foe_hp_ratio: Number(foeRatio(w).toFixed(3)), shape: shapeOf(spoken.text)});
          }
          if (!entry.first_shown) {
            entry.first_shown = {turn: w.turn, phase: w.phase, action: detail.action,
              my_hp_ratio: Number(hpRatio(w).toFixed(3)),
              foe_hp_ratio: Number(foeRatio(w).toFixed(3)), shape: shapeOf(spoken.text)};
          }
        } else if (hpRatio(w) <= 0.6) {
          entry.silent_at_low_hp += 1;
        } else {
          entry.silent_at_full_hp += 1;
        }
      }
      const advanced = await post('/api/roco/battle/advance', {battle_id: started.battle_id, auto: true});
      if (!advanced.ok) break;
      steps += 1;
      current = advanced;
    }
    if (onBattle) onBattle(battles);
  }
  return {battles_scanned: battles, steps_scanned: steps, kinds};
}

export function describeConfig(config) {
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
export function numericFactsOf(w) {
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

export function fabricatedClaims(text, w) {
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
