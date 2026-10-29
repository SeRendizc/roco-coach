import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {searchOwnedTeamAlternatives} from '../coach/team-alternatives.js';
import {evolutionFamilyMetadata} from './evolution-families.js';

const read = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const digest = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const sort = (xs) => [...new Set(xs)].sort();
const skillIds = (rows) => rows.map((s) => typeof s === 'string' ? s : s?.skill_id).filter(Boolean);
const fail = (error, needs) => ({ok: false, error, ...(needs ? {needs} : {})});

/** Full authoritative box, not the visible candidate page. Exported for exact chat entity resolution. */
export async function loadOwnedTeamCatalog({service}) {
  if (!service?.box || !service?.roster) throw new Error('缺少本机配队数据服务。');
  const owned = [];
  let expected = null;
  for (let page = 0; page < 100; page += 1) {
    const response = await service.box({kind: 'mine', limit: '60', offset: String(owned.length)});
    if (response?.ok !== true || !Array.isArray(response?.player?.cards)) throw new Error(response?.error || '当前盒子未读完整。');
    const total = response.player.total;
    if (!Number.isInteger(total) || total < 0 || (expected !== null && expected !== total)) throw new Error('盒子读取期间发生变化，请重新生成。');
    expected = total;
    const rows = response.player.cards;
    if (!rows.length && owned.length < total) throw new Error('盒子分页提前结束，不能只用第一页配队。');
    owned.push(...rows);
    if (owned.length >= total) break;
  }
  if (owned.length !== expected || new Set(owned.map((p) => p.select)).size !== owned.length) throw new Error('盒子分页不完整或有重复个体。');
  const response = await service.roster({});
  if (response?.ok !== true || !Array.isArray(response.pets)) throw new Error(response?.error || '没有读到本机精灵规则资料。');
  return {owned, roster: response.pets, ownedCount: owned.length};
}

function normalize(request, owned) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return fail('配队请求必须是对象。');
  const allowed = new Set(['mode','selected','locked','loadouts','goal','must_include','must_exclude','seenTeams','refresh']);
  if (Object.keys(request).some((key) => !allowed.has(key))) return fail('配队请求含不支持的条件。');
  if (request.mode !== undefined && request.mode !== 'pvp-standard-six-pet') return fail('当前配队只支持标准六宠模式。');
  if (request.goal !== undefined && !['coverage','attack','bulk'].includes(request.goal)) return fail('配队目标必须是 coverage、attack 或 bulk。');
  const byId = new Map(owned.map((p) => [p.select, p]));
  const bySpecies = new Map();
  for (const p of owned) {
    if (!bySpecies.has(p.group)) bySpecies.set(p.group, []);
    bySpecies.get(p.group).push(p);
  }
  const out = {mode: 'pvp-standard-six-pet', goal: request.goal ?? 'coverage'};
  for (const key of ['selected','locked','must_include','must_exclude']) {
    const xs = request[key] ?? [];
    if (!Array.isArray(xs) || xs.length > 600 || xs.some((x) => typeof x !== 'string'
      || !(byId.has(x) || ((key === 'must_include' || key === 'must_exclude') && bySpecies.has(x))))) {
      return fail(`${key} 里有未持有或无法确定的精灵，请用准确个体或物种选择。`, [key]);
    }
    out[key] = sort(xs);
  }
  if (out.selected.length > 6 || out.locked.length > 6) return fail('六宠模式最多选择或锁定六只。');
  const excluded = new Set(out.must_exclude);
  const blocked = (p) => excluded.has(p.select) || excluded.has(p.group);
  const required = new Set(out.locked);
  for (const id of out.must_include) {
    if (byId.has(id)) required.add(id);
    else {
      const choices = bySpecies.get(id).filter((p) => !blocked(p))
        .sort((a, b) => (b.level ?? -1) - (a.level ?? -1) || a.select.localeCompare(b.select));
      const already = [...required].find((x) => byId.get(x)?.group === id);
      if (!already && !choices.length) return fail('必须带上的物种同时被排除了。');
      if (!already) required.add(choices.find((p) => out.selected.includes(p.select))?.select ?? choices[0].select);
    }
  }
  if ([...required].some((id) => blocked(byId.get(id)))) return fail('必须保留的精灵同时被排除，请先修改这两个条件。');
  if (required.size > 6 || new Set([...required].map((id) => byId.get(id).group)).size !== required.size) {
    return fail('必须保留的精灵超过六只，或同一物种重复。');
  }
  out.required = [...required].sort();
  out.refresh = request.refresh === true;
  if (request.refresh !== undefined && typeof request.refresh !== 'boolean') return fail('refresh 必须是布尔值。');
  const seen = request.seenTeams ?? [];
  if (!Array.isArray(seen) || seen.length > 200 || seen.some((team) => !Array.isArray(team) || team.length !== 6
    || new Set(team).size !== 6 || team.some((id) => typeof id !== 'string' || !/^own-\d+$/.test(id)))) return fail('已看过的阵容记录形状不正确。');
  out.seenTeams = seen.map((team) => sort(team));
  const loadouts = request.loadouts ?? {};
  if (!loadouts || typeof loadouts !== 'object' || Array.isArray(loadouts) || Object.keys(loadouts).length > 600) return fail('四招配置格式不正确。');
  out.loadouts = {};
  for (const species of Object.keys(loadouts).sort()) {
    const ids = loadouts[species];
    if (!bySpecies.has(species) || !Array.isArray(ids) || ids.length !== 4 || new Set(ids).size !== 4
      || ids.some((id) => typeof id !== 'string' || !/^skill_\d+$/.test(id))) return fail('每个持有物种必须配置四个不同的技能。');
    out.loadouts[species] = ids.slice();
  }
  return {ok: true, request: out};
}

/** Shared page/chat path. No model call, no side effects, no implicit adoption. */
export async function recommendOwnedTeams({service, request = {}}) {
  try {
    const catalog = await loadOwnedTeamCatalog({service});
    const validation = normalize(request, catalog.owned);
    if (!validation.ok) return validation;
    const normalized = validation.request;
    const frozenOwned = read('data/roco/owned/owned-pets.json');
    const frozen = new Map((frozenOwned.instances ?? []).map((p) => [p.instance_id, p]));
    const bank = new Map(Object.values(read('data/roco/normalized/roco-world-s4-2026-09-10/skills.json').skills)
      .map((s) => [s.skill_id, s]));
    const facts = new Map(catalog.roster.map((p) => [p.pet_id, p]));
    for (const p of catalog.roster) for (const m of p.moveset ?? []) if (m?.skill_id) bank.set(m.skill_id, {...bank.get(m.skill_id), ...m});
    const optionsCache = new Map();
    const options = async (instance) => {
      if (!optionsCache.has(instance)) {
        const result = await service.loadoutOptions({pet: instance});
        optionsCache.set(instance, result);
      }
      return optionsCache.get(instance);
    };
    // Explicit player choices must be legal before affecting search, even if no returned team uses them.
    for (const [species, ids] of Object.entries(normalized.loadouts)) {
      const card = catalog.owned.find((p) => p.group === species);
      const receipt = await options(card.select);
      const allowed = new Map((receipt?.learnable ?? []).filter((m) => m.is_trait !== true).map((m) => [m.skill_id, m]));
      if (receipt?.ok !== true || receipt.pet_id !== species || ids.some((id) => !allowed.has(id))) return fail(`「${card.name}」的四招中有学不到的技能，请重新选择。`, ['loadouts']);
      for (const row of allowed.values()) bank.set(row.skill_id, {...bank.get(row.skill_id), ...row});
    }
    const excluded = new Set(normalized.must_exclude);
    const omitted = [];
    let owned = catalog.owned.filter((card) => !excluded.has(card.select) && !excluded.has(card.group)).map((card) => {
      const fact = facts.get(card.group);
      const record = frozen.get(card.select);
      const exactRecord = record?.species_id === card.group ? record : null;
      const ids = normalized.loadouts[card.group]
        ?? (exactRecord ? exactRecord.skills : skillIds(fact?.moveset ?? []));
      const moves = ids?.map((id) => bank.get(id));
      if (!fact?.stats || ids?.length !== 4 || new Set(ids).size !== 4 || moves.some((m) => !m)) {
        omitted.push(card.select); return null;
      }
      return {instance: card.select, species: card.group, name: card.name, types: card.types,
        stats: fact.stats, level: card.level, moves,
        skillsSource: normalized.loadouts[card.group] ? 'player-explicit-validated' : 'owned-frozen-build'};
    }).filter(Boolean);
    const families = evolutionFamilyMetadata();
    const context = {mode: normalized.mode, goal: normalized.goal, selected: normalized.selected,
      locked: normalized.locked, must_include: normalized.must_include, must_exclude: normalized.must_exclude,
      loadouts: normalized.loadouts, catalog: owned.map((p) => [p.instance, p.species, p.level, p.stats, p.moves.map((m) => m.skill_id)])};
    const requestKey = digest(context);
    let search, rejected = [];
    for (let retry = 0; retry < 4; retry += 1) {
      search = searchOwnedTeamAlternatives({owned, required: normalized.required, selected: normalized.selected,
        goal: normalized.goal, evolutionFamilies: families.families, seenTeams: normalized.seenTeams,
        refresh: normalized.refresh});
      const invalid = new Set();
      for (const alternative of search.alternatives) for (const row of alternative.rows) {
        const receipt = await options(row.instance);
        const allowed = new Set((receipt?.learnable ?? []).filter((m) => m.is_trait !== true).map((m) => m.skill_id));
        if (receipt?.ok !== true || receipt.pet_id !== row.species || row.moves.some((m) => !allowed.has(m.skill_id))) invalid.add(row.instance);
      }
      if (!invalid.size) break;
      rejected.push(...invalid); owned = owned.filter((p) => !invalid.has(p.instance));
      search = null;
    }
    if (!search) return fail('当前资料的四招校验未通过，暂时无法交付完整阵容。');
    const alternatives = search.alternatives.map((a) => ({id: a.id, label: a.label, reason: a.reason,
      limits: [...a.limits, '当前持有范围来自本机盒子；本演示盒子是冻结生成数据，未读取真实游戏账号。'],
      difference: a.difference, signature: a.signature, speciesSignature: a.speciesSignature,
      team: a.rows.map((p) => p.instance),
      loadouts: Object.fromEntries(a.rows.map((p) => [p.species, p.moves.map((m) => m.skill_id)])),
      rows: a.rows.map((p) => ({instance: p.instance, species: p.species, name: p.name, types: p.types,
        skills: p.moves.map((m) => ({skill_id: m.skill_id, name: m.name ?? '技能名未登记'})),
        locked: normalized.locked.includes(p.instance), origin: 'recommended', skillsSource: p.skillsSource})),
    }));
    const {required: _required, ...publicRequest} = normalized;
    return {ok: true, source: 'owned-team-search', requestKey, request: publicRequest, alternatives,
      exhausted: search.exhausted === true,
      message: alternatives.length ? `找到${alternatives.length}套${normalized.refresh ? '未看过的' : '可检查的'}完整六宠四招备选。`
        + (alternatives.length < 3 ? '当前约束、静态质量与成员差异要求下，本次只找到这些方案。' : '')
        : `这次有界搜索在当前静态质量范围内没有找到新队。${search.unavailable ?? '可以调整目标或锁定条件再试。'}`,
      evidence: {ownedCount: catalog.ownedCount, eligibleCount: owned.length, omittedIncompleteInstances: omitted,
        rejectedInvalidBuilds: sort(rejected), skillValidation: 'all-returned-24-skills-per-team-against-native-learnset',
        search: {solves: search.solves, maxSolves: 80, qualityRatio: search.qualityRatio ?? null,
          minimumSpeciesChanges: search.minimumSpeciesChanges ?? null,
          searchLimited: search.searchLimited === true, note: '有界静态搜索；候选耗尽仅指当前质量范围与搜索预算，非穷尽所有组合。'},
        evolutionSource: families.source, mappedEvolutionSpecies: families.mappedSpecies,
        dataSource: frozenOwned.source, provider: 'local-rules', modelCalls: 0},
    };
  } catch (error) {return fail(`配队数据暂不可用：${error?.message ?? '读取失败'}`);}
}
