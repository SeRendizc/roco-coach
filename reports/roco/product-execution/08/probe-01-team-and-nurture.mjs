// 08.1 只读勘察读数：配队/培养闭环的**现状**（比较口径、个体 vs 物种键、撤销/偏好入口）。
//
// 全部只读：读 `data/**`、调纯函数、用**内存里的假 storage**（绝不碰真 localStorage / 玩家存档）。
// 运行（仓库根）：node reports/roco/product-execution/08/probe-01-team-and-nurture.mjs
// 产出：raw-team-and-nurture.json

import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  STANDARD_PVP_MODE, STANDARD_PVP_TEAM_SIZE, loadRecommendationInputs, validateRecommendationRequest,
} from '../../../../src/coach/team-request.js';
import {
  AXIS_IDS, compareTeams, diagnoseForCompare, loadTeamCompareInputs, minimalReplacement,
} from '../../../../src/coach/team-compare.mjs';
import {
  LOADOUT_STORE_KEY, isSharedLoadout, readSharedLoadout, writeSharedLoadout,
} from '../../../../src/client/loadout-store.js';
import {adviceFor, compareIndividuals, raceOf} from '../../../../src/coach/nature-advice.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..', '..', '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const out = {};

// ── A. 配招记录的**键**：个体维度还是物种维度？──────────────────────────────
const memStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    _dump: () => Object.fromEntries(map),
  };
};
{
  const storage = memStorage();
  const loadoutA = ['skill_000286', 'skill_000305', 'skill_000418', 'skill_000483'];
  // 两个**个体**（own-0001 / own-0002）同属一个物种（pet_000417）。
  // 工坊/盒子写共用记录用的是引擎回执里的 `pet_…`（物种 id，见 loadout-store.js:13-16）。
  const wrote = writeSharedLoadout(storage, 'pet_000417', loadoutA);
  out.loadout_store = {
    key: LOADOUT_STORE_KEY,
    wrote,
    storage_after_write: storage._dump(),
    // 用物种 id 读得到
    read_by_species: readSharedLoadout(storage, 'pet_000417'),
    // 用**个体 id**（own-…）读不到：整个记录里**没有个体维度**
    read_by_individual_instance: readSharedLoadout(storage, 'own-0002'),
    individual_dimension_present: false,
    two_individuals_same_species_share_one_record: true,
    shape_rule_ok: isSharedLoadout(loadoutA),
  };
}

// ── B. RC-301 请求合同：目标/约束/偏好有没有落点 ─────────────────────────────
const rc301 = await loadRecommendationInputs({root: ROOT});
const registry = validateRecommendationRequest({mode: STANDARD_PVP_MODE}, rc301).registry;
const instanceIds = [...registry.instances.keys()].sort();
const six = instanceIds.slice(0, 6);
{
  const good = validateRecommendationRequest({
    mode: STANDARD_PVP_MODE, selected: six, locked: [six[0]],
    favourites_only: false, preference: 'brief',
  }, rc301);
  const lockedNotSelected = validateRecommendationRequest({
    mode: STANDARD_PVP_MODE, selected: six, locked: ['own-9999'],
  }, rc301);
  const unknownField = validateRecommendationRequest({
    mode: STANDARD_PVP_MODE, selected: six, resources: {refresh: 3},
  }, rc301);
  out.request_contract = {
    ok: good.ok,
    request_keys: good.request ? Object.keys(good.request).sort() : null,
    locked: good.request?.locked ?? null,
    favourites_only: good.request?.favourites_only ?? null,
    preference: good.request?.preference ?? null,
    constraints: good.request?.constraints ?? null,
    locked_not_selected_rejected: lockedNotSelected.ok === false,
    locked_not_selected_codes: (lockedNotSelected.problems ?? []).map((p) => p.code),
    unknown_field_rejected: unknownField.ok === false,
    unknown_field_codes: (unknownField.problems ?? []).map((p) => p.code),
  };
}

// ── C. RC-304 比较：分布 unknown 时给什么；有先验时给什么 ─────────────────────
const compareInputs = await loadTeamCompareInputs({root: ROOT});
const prior = readJson('data/roco/meta-prior/v1.json');
const distinctSpecies = (list) => {
  const seen = new Set(); const picked = [];
  for (const row of list) {
    if (seen.has(row.species_id)) continue;
    seen.add(row.species_id); picked.push(row);
  }
  return picked;
};
const owned = [...registry.instances.values()];
const teams = [];
for (const [name, slice] of [['probe-team-a', [0, 12]], ['probe-team-b', [12, 24]]]) {
  const picked = distinctSpecies(owned).slice(slice[0], slice[1] || undefined).slice(0, 6);
  const request = validateRecommendationRequest({
    mode: STANDARD_PVP_MODE, team_size: STANDARD_PVP_TEAM_SIZE,
    selected: picked.map((row) => row.instance_id),
  }, rc301);
  teams.push({
    team_id: name,
    request: request.request,
    team: {team_id: name, members: picked.map((row) => ({key: `instance:${row.instance_id}`, species_id: row.species_id}))},
  });
}
const gapsByTeam = {};
for (const row of teams) Object.assign(gapsByTeam, diagnoseForCompare(row.team_id, row.request, compareInputs));

const axisSummary = (result) => {
  const axes = {};
  for (const id of AXIS_IDS) {
    const value = result?.axes?.[id] ?? null;
    axes[id] = value ? {available: value.available, value: value.value ?? null,
      unknown_reason: value.unknown_reason ?? null} : null;
  }
  return axes;
};
{
  const unknown = compareTeams({teamA: teams[0].team, teamB: teams[1].team, metaPrior: null, gapsByTeam});
  const withPrior = compareTeams({teamA: teams[0].team, teamB: teams[1].team, metaPrior: prior, gapsByTeam});
  out.compare = {
    axis_ids: AXIS_IDS,
    teams_ok: teams.length,
    unknown_prior: axisSummary(unknown),
    real_prior: axisSummary(withPrior),
    result_keys: Object.keys(unknown ?? {}).sort(),
  };
  const replacement = minimalReplacement({team: teams[0].team, metaPrior: null, candidates: [], gapsByTeam});
  out.minimal_replacement = {
    keys: Object.keys(replacement ?? {}).sort(),
    proposals: Array.isArray(replacement?.proposals) ? replacement.proposals.length
      : (Array.isArray(replacement?.replacements) ? replacement.replacements.length : null),
    sample: JSON.stringify(replacement).slice(0, 600),
  };
}

// ── D. 培养建议：比的是什么（六维面板 vs 先手/承伤/伤害阈值）──────────────────
{
  const found = await raceOf('pet_000417');
  // ⚠ `raceOf()` 返回 `{pet_id, name, types, race}`，而 `adviceFor/compareIndividuals` 要的是
  // **race 那一层**（六维）—— 第一版直接把外层递进去，算出来全是 null（读数失真，已修）。
  const race = found?.race ?? null;
  const a = {nature: '保守', talent: {atk: 20, def: 10, hp: 15, spa: 25, spd: 12, spe: 8}};
  const b = {nature: '胆小', talent: {atk: 20, def: 10, hp: 15, spa: 25, spd: 12, spe: 8}};
  const cmp = compareIndividuals({race, a, b});
  const advice = adviceFor({race, talent: a.talent, priority: ['spe'], limit: 3});
  out.nurture = {
    race_found: Boolean(race),
    race_stats: race,
    compare_ok: cmp.ok,
    compared_dimensions: cmp.compared,
    diff_keys: Object.keys(cmp.diff ?? {}),
    diff: cmp.diff,
    caveats: cmp.caveats,
    text: cmp.text,
    advice_rows: (advice.rows ?? []).map((row) => ({nature: row.nature, gain: row.gain, cost: row.cost})),
    // 结构事实：这两层只算**六维面板差**，不算「对谁先手 / 挨几下 / 几招收」
    thresholds_present: false,
    opponent_context_required: false,
  };
}

writeFileSync(join(here, 'raw-team-and-nurture.json'),
  JSON.stringify(out, null, 1) + '\n', 'utf8');
console.log(JSON.stringify(out, null, 1));
console.log('WROTE raw-team-and-nurture.json');
