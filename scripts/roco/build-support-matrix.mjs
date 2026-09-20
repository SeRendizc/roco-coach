// M1 分析器：为 12 只目标精灵生成
//   1) 支持矩阵（数据完整度 / 效果原语覆盖 / 支持等级 / 缺口）
//   2) A 组候选配招（带证据，不声称最优）
//   3) 进入模拟前还缺什么
//
// 硬性口径：
//   - 支持等级**不**因为「数据字段齐全」就升级为可模拟。所有技能的 effect_support 都是
//     `unsupported`，因为本轮没有实现任何效果原语，也没有通过任何 microcase。
//   - 候选配招是「一组在数据中真实存在、且机制覆盖互不重复的 4 个技能」，
//     不是最优解、不是社区推荐、不是胜率结果。
//   - 描述文本里的机制（印记 / 蓄力 / 应对 / 减伤%）**只登记为待核验**，
//     不据此推断结算时序。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const N = 'data/roco/normalized/roco-world-s4-2026-09-10/';
const read = (f) => JSON.parse(readFileSync(N + f, 'utf8'));
const pets = read('pets.json').pets;
const learnsets = read('learnsets.json').learnsets;
const skills = read('skills.json').skills;
const types = read('types.json').types;
const history = read('history.json');

const OUT_JSON = N + 'support-matrix.json';

// ── 描述文本的机制标注（只标注「描述里出现了什么」，不做规则推断）────────
// 每个模式都标注为「待核验机制」：文本说了，但我们没有时序证据。
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

function mechanismsOf(desc) {
  const out = [];
  for (const p of MECHANISM_PATTERNS) if (p.re.test(desc)) out.push(p.key);
  return out;
}

function enrich(skillId) {
  const s = skills[skillId];
  if (!s) return null;
  return {
    skill_id: skillId,
    name: s.name,
    category: s.category,
    element: s.element,
    energy: s.energy,
    power: s.power,
    damage_class: s.damage_class,
    desc: s.desc,
    mechanisms: mechanismsOf(s.desc ?? ''),
    effect_support: s.effect_support,          // 恒为 unsupported（本轮未实现任何原语）
    power_status: s.power_status,
  };
}

// ── 候选配招选择：目标「机制覆盖互不重复」，不是「威力最大」────────────────
// 选择规则（全部可复现，写死在这里而不是手工挑）：
//   1. 必须有 1 个 0 能耗攻击（无资源也能行动）。
//   2. 必须有 1 个「可应对型防御」（category=防御 且 desc 含「应对」）。
//   3. 从剩余候选中，按「新机制数」优先，其次威力，其次能耗低，依次补到 4 个。
//   4. 若某类缺失，明确记为 missing_role，不编造替代品。
function selectCandidate(pet, learnset) {
  const nativeSet = new Set(learnset.native_skills.map((x) => x.skill_id));
  const pool = [...new Set([
    ...learnset.native_skills.map((x) => x.skill_id),
    ...learnset.blood_skills.map((x) => x.skill_id),
    ...learnset.skill_stones,
  ])].map(enrich).filter(Boolean);

  // 只从「本精灵固有技能(native)」优先挑，血统技能(stones/blood)作为后备。
  // 理由：native 是这只精灵的固有学习表，最不依赖外部条件，证据链最短。
  const native = pool.filter((s) => nativeSet.has(s.skill_id));

  const picked = [];
  const rolesFilled = {};
  const covered = new Set();
  const evidence = {};

  const topN = (list, n = 5) => list.slice(0, n).map((s) => ({
    skill_id: s.skill_id, name: s.name, category: s.category, element: s.element,
    energy: s.energy, power: s.power !== null ? s.power : null,
    from_native: nativeSet.has(s.skill_id), mechanisms: s.mechanisms,
  }));

  const takeIf = (role, pred, poolList) => {
    if (rolesFilled[role]) return null;
    const cands = poolList.filter(pred)
      .sort((a, b) => (b.power ?? -1) - (a.power ?? -1) || a.energy - b.energy || a.name.localeCompare(b.name));
    const cand = cands[0];
    if (!cand) return null;
    rolesFilled[role] = cand.skill_id;
    picked.push({ ...cand, role });
    evidence[role] = {
      rule: `predicate + sort(${role === 'free_attack' ? 'power desc, energy asc' : 'power desc, energy asc, name asc'})`,
      source_pool: poolList === native ? 'native_learnset' : 'full_pool(native+blood+stones)',
      considered: cands.length,
      alternatives: topN(cands.slice(1)),
    };
    cand.mechanisms.forEach((m) => covered.add(m));
    return cand;
  };

  // 角色 1：0 能耗攻击（资源安全阀）
  if (!takeIf('free_attack', (s) => s.category === '攻击' && s.energy === 0 && s.power !== null, native)) {
    takeIf('free_attack', (s) => s.category === '攻击' && s.energy === 0 && s.power !== null, pool);
  }
  // 角色 2：可应对型防御（面对攻击时的反应）
  if (!takeIf('reactive_defense', (s) => s.category === '防御' && /应对/.test(s.desc ?? ''), native)) {
    takeIf('reactive_defense', (s) => s.category === '防御' && /应对/.test(s.desc ?? ''), pool);
  }
  // 角色 3：主要输出（全池威力最高，且不在已选内）
  const powerSort = (a, b) => (b.power ?? -1) - (a.power ?? -1) || a.energy - b.energy || a.name.localeCompare(b.name);
  const mainPool = native.some((s) => s.category === '攻击' && s.power !== null && !picked.some((p) => p.skill_id === s.skill_id)) ? native : pool;
  const mainCands = mainPool.filter((s) => s.category === '攻击' && s.power !== null && !picked.some((p) => p.skill_id === s.skill_id)).sort(powerSort);
  const mainAttacker = mainCands[0];
  if (mainAttacker) {
    rolesFilled.main_attack = mainAttacker.skill_id;
    picked.push({ ...mainAttacker, role: 'main_attack' });
    evidence.main_attack = {
      rule: 'predicate(攻击类且有静态威力) + sort(power desc, energy asc)',
      source_pool: mainPool === native ? 'native_learnset' : 'full_pool(native+blood+stones)',
      considered: mainCands.length,
      alternatives: topN(mainCands.slice(1)),
    };
    mainAttacker.mechanisms.forEach((m) => covered.add(m));
  }

  // 角色 4：机制补充 —— 优先带来最多「尚未覆盖机制」的技能
  const remaining = pool.filter((s) => !picked.some((p) => p.skill_id === s.skill_id));
  const scored = remaining.map((s) => ({
    s,
    newMech: s.mechanisms.filter((m) => !covered.has(m)).length,
    fromNative: nativeSet.has(s.skill_id) ? 1 : 0,
  })).sort((a, b) =>
    b.newMech - a.newMech || b.fromNative - a.fromNative ||
    (b.s.power ?? -1) - (a.s.power ?? -1) || a.s.energy - b.s.energy || a.s.name.localeCompare(b.s.name));
  if (scored.length) {
    const chosen = scored[0].s;
    rolesFilled.mechanism_support = chosen.skill_id;
    picked.push({ ...chosen, role: 'mechanism_support' });
    evidence.mechanism_support = {
      rule: 'maximize(new mechanisms not yet covered), tie-break: native first, then power desc, energy asc',
      source_pool: 'full_pool(native+blood+stones)',
      considered: scored.length,
      new_mechanisms_brought: chosen.mechanisms.filter((m) => !covered.has(m)),
      alternatives: topN(scored.slice(1, 6).map((x) => x.s)),
    };
    chosen.mechanisms.forEach((m) => covered.add(m));
  }

  return { picked, rolesFilled, evidence, poolSize: pool.length, nativePoolSize: native.length };
}

// ── 支持等级判定 ────────────────────────────────────────────────────────
// 判定依据（严格）：
//   · effect primitives 已实现且 microcase 通过 → SIM_VERIFIED
//   · 本轮：一个都没有实现 → 任何精灵都不可能超过 KNOWLEDGE_ONLY
//   · A 组额外具备「有证据的候选配招」，属于下一轮 SIM 的目标群，
//     但**当前仍不可模拟**，因此标 KNOWLEDGE_ONLY 并写明 target。
// 引擎侧的特性实现状态（由 scripts/roco/export-trait-status.py 生成）。
// 与数据侧的 effect_support **是两件事**，必须在同一张表里分开写，否则必误导：
//   · effect_support=unsupported 是**上游快照**的说法（824/824 都是它）；
//   · engine status 是**本仓库引擎**的实现状态（FULL/PARTIAL/REFUSED 三档）。
const engineTraits = (() => {
  try {
    return JSON.parse(readFileSync('data/roco/engine-trait-status.json', 'utf8'));
  } catch {
    return null;
  }
})();
const engineTraitOf = (petName) =>
  engineTraits?.pets?.find((p) => p.name === petName) ?? null;

function supportLevel(entry) {
  const implemented = entry.trait?.engine_status;
  return {
    current: 'KNOWLEDGE_ONLY',
    reason: `本轮没有任何 microcase 通过（游戏内实测为零），因此**任何**精灵都不能进实战：`
      + `支持等级看的是「机制被实测核验过」，不是「代码写过」。`
      + `12 只特性里引擎侧已实现 ${engineTraits?.counts?.FULL ?? '?'} 条（FULL）、`
      + `部分实现 ${engineTraits?.counts?.PARTIAL ?? '?'} 条、明确拒绝 ${engineTraits?.counts?.REFUSED ?? '?'} 条`
      + `${implemented ? `；本精灵的特性当前是 ${implemented}` : ''}。`
      + `所有技能 effect_support=unsupported 是**数据侧**字段，与引擎实现状态是两件事。`,
    target_next: entry.group === 'A' ? 'SIM_PARTIAL' : entry.group === 'B' ? 'KNOWLEDGE_ONLY' : 'CATALOG_ONLY',
    target_note: entry.group === 'A'
      ? '下一轮为 A 组所选 4 技能实现效果原语并通过 microcase 后升为 SIM_PARTIAL。'
      : entry.group === 'B'
        ? 'B 组进入战斗前需先建立其形态/承伤机制；本轮只做知识库。'
        : 'C 组为 S4 新精灵，先支持图鉴与培养问答；技能/特性/时序未核验前不开放实战。',
  };
}

const results = [];
for (const [pid, pet] of Object.entries(pets).sort((a, b) => a[1].target.order - b[1].target.order)) {
  const ls = learnsets[pid];
  if (!ls) { results.push({ pet_id: pid, name: pet.name, error: 'no_learnset' }); continue; }
  const { picked, rolesFilled, evidence, poolSize, nativePoolSize } = selectCandidate(pet, ls);

  const allIds = [...new Set([...ls.native_skills.map((x) => x.skill_id), ...ls.blood_skills.map((x) => x.skill_id), ...ls.skill_stones])];
  const enrichedPool = allIds.map(enrich).filter(Boolean);
  const byCat = {};
  for (const s of enrichedPool) byCat[s.category] = (byCat[s.category] ?? 0) + 1;
  const withPower = enrichedPool.filter((s) => s.power !== null).length;
  const allMechanisms = [...new Set(enrichedPool.flatMap((s) => s.mechanisms))].sort();

  // 动态/条件威力：描述里出现条件化威力时，静态 power 不能直接当最终伤害
  const dynamicPower = enrichedPool.filter((s) => s.power !== null && /每有1能量|位于\d号位|若敌方|应对|迸发|蓄力|翻倍|变为|连击/.test(s.desc ?? '')).length;

  // 类型相性证据（该精灵属性在 types.json 中的防御相性）
  const defensiveKeys = [pet.types.join('|'), pet.types[0], pet.types[1]].filter(Boolean);
  const defensiveProfile = defensiveKeys.map((k) => ({ key: k, ...(types[k] ?? {}) })).filter((x) => x.resist || x.weak);

  const trait = skills[ls.feature_skill_id] ?? null;

  results.push({
    pet_id: pid,
    group: pet.target.group,
    order: pet.target.order,
    name: pet.name,
    title: pet.title,
    game_id: pet.game_id,
    number: pet.number,
    types: pet.types,
    stats: pet.stats,
    stat_total: Object.values(pet.stats).reduce((a, b) => a + (b ?? 0), 0),
    release: pet.release,
    role_hint: {
      A: { 寂灭骨龙: '耐久 / 换宠博弈 / 收尾', 海豹船长: '承伤与稳定防守', 黑猫巫师: '节奏与魔法增益', 圆号鱼: '水系输出与资源节奏', 雪影娃娃: '冰系控制', 音速犬: '火系高速进攻' },
      B: { 画间沉铁兽: '复杂形态 / 承伤机制', 秩序鱿墨: '控制 / 场面约束', 化蝶: '减速 / 回复 / 辅助' },
      C: { 银月狼王: 'S4 新精灵（机制核验中）', 圣凯布米龙: 'S4 新精灵（机制核验中）', 月使鹭纳: 'S4 新精灵（机制核验中）' },
    }[pet.target.group]?.[pet.name] ?? null,
    trait: trait ? {
      skill_id: ls.feature_skill_id,
      name: trait.name,
      desc: trait.desc,
      // 数据侧：上游快照给的支持字段，恒为 unsupported。
      effect_support: trait.effect_support,
      // 引擎侧：本仓库的实现状态（FULL/PARTIAL/REFUSED）+ 理由。
      // 两个字段说的不是一件事，所以**都留着**，由文档分两行写。
      engine_status: engineTraitOf(pet.name)?.status ?? null,
      engine_hook: engineTraitOf(pet.name)?.hook ?? null,
      engine_reason: engineTraitOf(pet.name)?.reason ?? null,
    } : null,
    learnset: {
      learnset_id: ls.learnset_id,
      native: ls.native_skills.length,
      blood: ls.blood_skills.length,
      stones: ls.skill_stones.length,
      pool_size: poolSize,
      native_pool_size: nativePoolSize,
      by_category: byCat,
      with_static_power: withPower,
      without_static_power: enrichedPool.length - withPower,
      dynamic_or_conditional_power: dynamicPower,
      distinct_mechanisms: allMechanisms,
      orphan_skill_refs: ls.orphan_skill_refs ?? [],
    },
    defensive_profile: defensiveProfile,
    support: supportLevel(pet.target),
    candidate_moveset: {
      note: '在数据中真实存在、且机制覆盖互不重复的一组 4 技能；**不是**最优解、不是社区推荐、不是胜率结果。选择规则见 scripts/roco/build-support-matrix.mjs。',
      roles_filled: rolesFilled,
      selection_evidence: evidence,
      skills: picked,
      missing_roles: ['free_attack', 'reactive_defense', 'main_attack', 'mechanism_support'].filter((r) => !rolesFilled[r]),
    },
    // 进入模拟前还缺什么（每条都可核验）
    blockers_before_simulation: [
      '所有技能 effect_support = unsupported：效果原语未实现',
      ...(dynamicPower ? [`${dynamicPower} 个技能是条件化/动态威力，静态 power 不能直接当最终伤害`] : []),
      ...(byCat['防御'] ? ['「防御」类技能是条件护盾（减伤%+应对效果），不是简单减伤，时序未核验'] : []),
      ...(allMechanisms.includes('mark') ? ['存在印记机制，叠加/持续/清除规则未核验'] : []),
      ...(allMechanisms.includes('charge') ? ['存在蓄力机制，「下次免蓄力」的消耗规则未核验'] : []),
      '等级→面板换算公式未知（性格/天分/血脉影响未知）',
      '官方伤害公式无来源，属 unknown',
    ],
    history: {
      changes: (history.pets[pid] ?? []).map((e) => ({ version_key: e.version_key, kind: e.kind, change_count: e.changes.length })),
    },
  });
}

const payload = {
  schema_version: 1,
  ruleset_id: 'roco-world-s4-2026-09-10',
  game: 'roco_world_mobile',
  generated_from: {
    pets: 'data/roco/normalized/roco-world-s4-2026-09-10/pets.json',
    learnsets: 'data/roco/normalized/roco-world-s4-2026-09-10/learnsets.json',
    skills: 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json',
    types: 'data/roco/normalized/roco-world-s4-2026-09-10/types.json',
    history: 'data/roco/normalized/roco-world-s4-2026-09-10/history.json',
  },
  caveats: [
    '支持等级 current 一律为 KNOWLEDGE_ONLY：本轮未实现任何效果原语，未通过任何 microcase。',
    '候选配招是一组机制覆盖互不重复的真实技能，不是最优解，也不代表社区推荐。',
    '描述文本里的机制只登记为「描述中出现」，未据此推断结算时序。',
    'C 组为 S4 新精灵：新版本登场不等于热门或强。',
  ],
  pets: results,
};

mkdirSync(dirname(OUT_JSON), { recursive: true });
writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2) + '\n');
console.log(`[support-matrix] wrote ${OUT_JSON}`);
for (const r of results) {
  if (r.error) { console.log(`  ${r.name}: ERROR ${r.error}`); continue; }
  const ms = r.candidate_moveset;
  console.log(`  ${r.group}${r.order} ${r.name.padEnd(6)} pool=${String(r.learnset.pool_size).padStart(2)} dmg=${String(r.learnset.with_static_power).padStart(2)} dyn=${String(r.learnset.dynamic_or_conditional_power).padStart(2)} mech=${r.learnset.distinct_mechanisms.length} | candidate: ${ms.skills.map((s) => s.name).join(' / ')}${ms.missing_roles.length ? ' | MISSING ' + ms.missing_roles.join(',') : ''}`);
}
