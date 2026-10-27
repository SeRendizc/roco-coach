// Browser-safe, deterministic alternatives from the current box instances.
// Static race stats and attack coverage are evidence, not a prediction of ladder strength.
const AXES = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export const TEAM_ALTERNATIVE_STYLES = Object.freeze([
  {id: 'coverage', label: '属性面更广', intent: '优先补齐队伍属性，兼顾六维'},
  {id: 'attack', label: '速度与输出', intent: '偏向速度与输出种族值，承伤要留心'},
  {id: 'bulk', label: '承伤取向', intent: '偏向生命与双防种族值，出手可能更慢'},
]);

const idOf = (p) => String(p?.instance ?? p?.select ?? p?.instance_id ?? '');
const speciesOf = (p) => String(p?.species ?? p?.speciesId ?? p?.group ?? p?.species_id ?? '');
const unique = (xs) => [...new Set(xs.filter(Boolean))];
const finiteStats = (p) => AXES.every((key) => Number.isFinite(p?.stats?.[key]));
const keyOf = (rows) => rows.map(speciesOf).sort().join('|');

/** Missing facts do not turn into zeros. A candidate needs complete numeric facts to be ranked. */
export function buildTeamAlternatives({owned = [], roster = [], locked = [], selected = [],
  excluded = [], size = 6, typeMultiplier = null, evolutionFamilies = {}} = {}) {
  const facts = new Map(roster.map((p) => [String(p.pet_id ?? p.species_id ?? ''), p]));
  const blocked = new Set(excluded);
  const pool = owned.filter((p) => idOf(p) && speciesOf(p) && !blocked.has(idOf(p)) && !blocked.has(speciesOf(p)))
    .map((p) => {
      const f = facts.get(speciesOf(p));
      return {...p, instance: idOf(p), species: speciesOf(p),
        name: p.name ?? f?.name ?? '未命名', types: p.types?.length ? p.types : (f?.types ?? []),
        stats: p.stats ?? f?.stats ?? null, stage: f?.stage ?? null,
        family: evolutionFamilies[speciesOf(p)] || `species:${speciesOf(p)}`,
        familyKnown: Boolean(evolutionFamilies[speciesOf(p)]),
        moves: p.moves ?? f?.moveset ?? [],
        movesSource: Array.isArray(p.moves) ? 'injected_current' : 'species_default',
        level: Number.isFinite(p.level) ? p.level : null};
    }).sort((a, b) => a.instance.localeCompare(b.instance));
  const byId = new Map(pool.map((p) => [p.instance, p]));
  const required = unique(locked).map((id) => byId.get(id));
  if (required.some((p) => !p) || required.length > size
    || new Set(required.map(speciesOf)).size !== required.length) {
    return {alternatives: [], unavailable: '锁定的精灵缺席、被排除或同种重复，先调整锁定。'};
  }
  const rankedPool = pool.filter(finiteStats);
  const unknownCount = pool.length - rankedPool.length;
  const selectedSet = new Set(selected);
  const attackTypes = (p) => unique((p.moves ?? []).filter((m) => Number.isFinite(m.power) && m.power > 0)
    .map((m) => m.element));
  const value = (p, rows, style, previous) => {
    const s = p.stats;
    const coverage = unique(rows.flatMap((r) => r.types));
    const offense = unique(rows.flatMap(attackTypes));
    const freshTypes = p.types.filter((t) => !coverage.includes(t)).length;
    const freshAttacks = attackTypes(p).filter((t) => !offense.includes(t)).length;
    const classes = unique((p.moves ?? []).filter((m) => Number.isFinite(m.power) && m.power > 0)
      .map((m) => m.damage_class));
    const attackStat = classes.length ? Math.max(...classes.map((c) => c === '物攻' ? s.atk
      : c === '魔攻' ? s.spa : Math.max(s.atk, s.spa))) : Math.max(s.atk, s.spa);
    const raw = style === 'attack' ? (attackStat * 1.8 + s.spe * 1.6 + s.hp * 0.25)
      : style === 'bulk' ? (s.hp * 1.1 + s.def + s.spd + Math.max(s.atk, s.spa) * 0.4)
        : AXES.reduce((n, axis) => n + s[axis], 0) * 0.55;
    // This is a declared preference for a different option, never called competitive strength.
    const repeated = previous.filter((team) => team.some((r) => r.species === p.species)).length;
    const newFacts = (style === 'coverage' ? 80 : 45) * freshTypes + freshAttacks * 20;
    let exposed = 0;
    if (typeof typeMultiplier === 'function') {
      for (const t of coverage) {
        const hits = [...rows, p].filter((r) => {
          try {const x = typeMultiplier(r.types, t); return Number.isFinite(x) && x > 1;} catch {return false;}
        }).length;
        if (hits >= 3) exposed += (hits - 2) * 18;
      }
    }
    return raw + newFacts - exposed - repeated * 60 + (selectedSet.has(p.instance) ? 8 : 0);
  };
  const alternatives = [];
  for (const style of TEAM_ALTERNATIVE_STYLES) {
    const rows = required.map((p) => ({...p, locked: true}));
    const used = new Set(rows.map(speciesOf));
    while (rows.length < size) {
      const possible = rankedPool.filter((p) => !used.has(p.species));
      const usedFamilies = new Set(rows.map(p=>p.family));
      const differentChain = possible.filter(p=>!usedFamilies.has(p.family));
      // Prefer another chain before optimizing its score. Duplicate a chain only
      // when no unused chain can fill the remaining slots; locks are never removed.
      const eligible = differentChain.length ? differentChain : possible;
      eligible.sort((a, b) => value(b, rows, style.id, alternatives.map((a) => a.rows))
        - value(a, rows, style.id, alternatives.map((a) => a.rows)) || a.instance.localeCompare(b.instance));
      const next = eligible[0];
      if (!next) break;
      rows.push({...next, locked: false}); used.add(next.species);
    }
    if (rows.length !== size || alternatives.some((a) => keyOf(a.rows) === keyOf(rows))) continue;
    const types = unique(rows.flatMap((p) => p.types));
    const sum = (axis) => rows.reduce((n, p) => n + (p.stats?.[axis] ?? 0), 0);
    const uncertainLocked = rows.some((p) => !finiteStats(p));
    const chainGroups = new Map();
    for(const p of rows){if(!chainGroups.has(p.family))chainGroups.set(p.family,[]);chainGroups.get(p.family).push(p);}
    const duplicates = [...chainGroups.values()].filter(group=>group.length>1);
    const usesDefaultMoves = rows.some((p) => p.movesSource === 'species_default');
    const moveLimit = usesDefaultMoves
      ? '招式依据为物种默认配招的静态参考，当前四招未参与排序；最终预览会保留玩家自选或盒子四招，尚未比较这份预览的当前攻击面。'
      : '招式依据为调用方提供的当前技能事实；仍需核对学习表与实战效果。';
    alternatives.push({id: style.id, label: style.label, rows,
      reason: `${style.intent}；覆盖 ${types.length} 种队伍属性${uncertainLocked ? ''
        : `，速度种族值合计 ${sum('spe')}、生命种族值合计 ${sum('hp')}`}。${usesDefaultMoves
        ? '招式只参考物种默认配招，当前四招未参与排序。' : ''}`,
      difference: alternatives.length ? `${rows.filter((p) => !alternatives[0].rows.some((r) => r.species === p.species)).length} 只与第一套不同` : '第一套备选',
      limits: ['按静态种族值和队伍属性选择，未计完整特性、控制链、个体面板与当前赛季对手。',
        moveLimit,
        ...(duplicates.length ? [`同一进化链仍有重复：${duplicates.map(g=>g.map(p=>p.name).join('、')).join('；')}。已保留你的锁定；可用进化链不足时才补同链成员。`] : []),
        ...(rows.some(p=>!p.familyKnown) ? ['部分进化链资料未收录，相关精灵仅按物种去重，不按名字猜关系。'] : []),
        ...(unknownCount ? [`${unknownCount} 个个体缺完整六维，未参加排序；锁定个体仍保留。`] : []),
        ...(uncertainLocked ? ['锁定个体缺六维，整队数值合计不展示。'] : [])],
    });
  }
  return {alternatives, unavailable: alternatives.length ? null : '现有个体或六维资料不足，凑不出六只不同物种。',
    note: alternatives.length < TEAM_ALTERNATIVE_STYLES.length
      ? '优先避免同一进化链重复。锁定或可用候选限制了变化，只展示实际不同的方案。'
      : '优先避免同一进化链重复；你锁定的精灵保留。'};
}
