// RC-402 按需配招编译（Build Compiler）：**让全量图鉴精灵有可上场的四个技能**。
//
// 问题
// ----
// RC-203 只给「冻结 `learnsets.json` 里真的有 native_skills」的精灵编了配招，全量 622 只里
// 只有 48 只过得了这一关；另外 574 只在引擎的 `is_learnable()` 那里是「学不到任何技能」，
// 于是**选得到、上不了场**。而全量图鉴 `full-catalog.json` 其实每只都带 `learnable_skills`
// （实测 622/622，共 8787 条引用，**全部**能在 `skills.json` 里解析），所以这不是数据缺失，
// 是**没人把这份数据编成配招**。
//
// 三条纪律（与 RC-203 同一套，理由不同）
// -------------------------------------
//   ① **不许发明技能**。每个技能必须同时满足：出现在该物种的 `learnable_skills` 里、
//      且能在冻结 `skills.json` 里解析。任取其一不成立 ⇒ 那只精灵**不编**，并如实登记原因。
//   ② **不许冒充已核验**。冻结 learnset 覆盖的那 48 只是 `FULL_VERIFIED`；本模块编出来的
//      一律是 `SIMULATABLE_UNVERIFIED`（RC-403 的词汇），并且**绝不覆盖**冻结那一份
//      （`frozen_build` 原样带出来，供对账）。
//   ③ **不许声称这是最优配招**。选择规则是一条**工程启发式**（`ENGINE_HYPOTHESIS`），
//      写死在 `SELECTION_RULE` 里并逐只带出去；不是强度排序，也不是社区推荐。
//
// 确定性：同一份输入 ⇒ 逐字节相同的产物（无挂钟字段、排序键全部显式 tie-break）。

import {createHash} from 'node:crypto';

/** 产物 schema 版本。 */
export const SCHEMA_VERSION = 1;

/** RC-403 的支持等级词汇。本模块只产出这两种。 */
export const SUPPORT_FULL_VERIFIED = 'FULL_VERIFIED';
export const SUPPORT_SIMULATABLE_UNVERIFIED = 'SIMULATABLE_UNVERIFIED';

/**
 * 选择规则（**工程启发式**，不是游戏规则）。
 *
 * 排序键：威力降序（`power` 为 null 的排在**最后**，绝不补 0）→ 能耗升序 → skill_id 升序。
 * 取前 4 个**互不相同**的技能。
 */
export const SELECTION_RULE = Object.freeze({
  id: 'rc402-power-desc-energy-asc-skillid',
  confidence: 'ENGINE_HYPOTHESIS',
  rule: '威力降序（来源没给威力的排最后，不补 0）→ 能耗升序 → skill_id 升序，取前 4 个不同的技能',
  why_not_official: '仓库里没有任何「标准 PVP 该怎么配招」的证据（台账没有条目）；'
    + '这条规则只是为了让每只精灵有一个**确定、可复核、可替换**的起点',
});

/** 每只精灵的 four-skill build 必然带出的未知项（逐只写进产物）。 */
export const BUILD_UNKNOWNS = Object.freeze([
  '这份学招表是否是该物种的**全部**可学技能（是否有等级/道具/活动前置）——仓库里没有证据',
  '配招选择规则是工程启发式（ENGINE_HYPOTHESIS），不是最优解、不是社区推荐、不是强度排序',
  '性格/资质/特长/血脉的养成效果全部 UNKNOWN（与 RC-203 同一条纪律）',
]);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** 幂等的技能排序键：威力降序（null 最后）→ 能耗升序 → skill_id 升序。 */
export function skillSortKey(skill) {
  const power = Number.isFinite(skill?.power) ? skill.power : -1;   // -1 = 来源没给，排最后
  const energy = Number.isFinite(skill?.energy) ? skill.energy : 99;
  return [-power, energy, String(skill?.skill_id ?? '')];
}

const compareSkill = (a, b) => {
  const ka = skillSortKey(a);
  const kb = skillSortKey(b);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
};

/**
 * 编一只精灵的配招。
 *
 * @returns {{ok: true, skills: Array<object>}|{ok: false, reason: string, detail: string}}
 */
export function compileBuild(pet, skills, {size = 4} = {}) {
  const pool = Array.isArray(pet?.learnable_skills) ? pet.learnable_skills : [];
  if (pool.length === 0) return {ok: false, reason: 'NO_LEARNABLE_SKILLS', detail: '全量图鉴里这只没有 learnable_skills'};
  const resolved = [];
  const missing = [];
  for (const skillId of pool) {
    const skill = skills?.[skillId];
    if (!skill) { missing.push(skillId); continue; }
    if (skill.is_trait === true) { missing.push(`${skillId}(特性不是战斗技能)`); continue; }
    resolved.push({
      skill_id: skillId,
      name: skill.name ?? null,
      category: skill.category ?? null,
      element: skill.element ?? null,
      energy: Number.isFinite(skill.energy) ? skill.energy : null,
      damage_class: skill.damage_class ?? null,
      // 威力**来源没给就不给数字**（`power_status` 原文带出去）——这条与玩家层同一条纪律。
      power: Number.isFinite(skill.power) ? skill.power : null,
      power_status: skill.power_status ?? null,
      pointer: `skills.json#${skillId}`,
    });
  }
  if (resolved.length < size) {
    return {
      ok: false,
      reason: 'POOL_TOO_SMALL',
      detail: `可解析的战斗技能只有 ${resolved.length} 个（需要 ${size} 个）；`
        + (missing.length ? `另外 ${missing.length} 条引用解析不到/是特性：${missing.slice(0, 4).join('、')}` : ''),
    };
  }
  const picked = [...resolved].sort(compareSkill).slice(0, size);
  const unique = new Set(picked.map((row) => row.skill_id));
  if (unique.size !== size) {
    return {ok: false, reason: 'DUPLICATE_SKILLS', detail: `去重后只有 ${unique.size} 个技能`, };
  }
  // `resolved` 原样带出去：引擎侧要按**完整可学池**校验 loadout（不是只认挑出来的四个）。
  return {ok: true, skills: picked, pool_size: resolved.length, resolved, unresolved: missing};
}

/**
 * 构建产物。
 *
 * @param {object} input
 * @param {object} input.catalog `full-catalog.json`
 * @param {object} input.skills  `skills.json`
 * @param {object} [input.frozenBuilds] 冻结 learnset 覆盖的那批配招（`{pet_id: [skill_id...]}`），
 *        用来标 `FULL_VERIFIED` 并**对账**（编出来的那份绝不替换它）。
 * @param {object} input.hashes  `{catalog, skills, frozen}` 的 sha256 原文
 */
export function buildOnDemandBuilds({catalog, skills, frozenBuilds = {}, hashes}) {
  const pets = Array.isArray(catalog?.pets) ? catalog.pets : null;
  if (!pets) throw new Error('buildOnDemandBuilds：catalog.pets 缺失');
  if (!skills?.skills || typeof skills.skills !== 'object') throw new Error('buildOnDemandBuilds：skills.skills 缺失');

  const builds = {};
  const skipped = [];
  const supportCounts = {[SUPPORT_FULL_VERIFIED]: 0, [SUPPORT_SIMULATABLE_UNVERIFIED]: 0};
  let matchedFrozen = 0;

  for (const pet of pets) {
    const frozen = Array.isArray(frozenBuilds[pet.pet_id]) ? frozenBuilds[pet.pet_id] : null;
    const compiled = compileBuild(pet, skills.skills);
    if (frozen && frozen.length) {
      supportCounts[SUPPORT_FULL_VERIFIED] += 1;
      const same = compiled.ok && compiled.skills.length === frozen.length
        && compiled.skills.every((row, index) => row.skill_id === frozen[index]);
      if (same) matchedFrozen += 1;
      builds[pet.pet_id] = {
        species_id: pet.pet_id,
        name: pet.name ?? null,
        types: Array.isArray(pet.types) ? [...pet.types] : [],
        support: SUPPORT_FULL_VERIFIED,
        // 冻结那一份原样带出来：它是**已核验**的配招，本模块只做对账，不做替换。
        frozen_build: [...frozen],
        compiled_matches_frozen: same,
        selection_rule_id: SELECTION_RULE.id,
        skills: compiled.ok
          ? compiled.skills
          : frozen.map((skillId) => ({skill_id: skillId, name: skills.skills[skillId]?.name ?? null,
            pointer: `frozen-learnset#${skillId}`})),
        learnable_pool_size: compiled.ok ? compiled.pool_size : null,
        unknowns: [...BUILD_UNKNOWNS],
      };
      continue;
    }
    if (!compiled.ok) {
      skipped.push({pet_id: pet.pet_id, name: pet.name ?? null, reason: compiled.reason, detail: compiled.detail});
      continue;
    }
    supportCounts[SUPPORT_SIMULATABLE_UNVERIFIED] += 1;
    builds[pet.pet_id] = {
      species_id: pet.pet_id,
      name: pet.name ?? null,
      types: Array.isArray(pet.types) ? [...pet.types] : [],
      support: SUPPORT_SIMULATABLE_UNVERIFIED,
      frozen_build: null,
      compiled_matches_frozen: null,
      selection_rule_id: SELECTION_RULE.id,
      skills: compiled.skills,
      learnable_pool_size: compiled.pool_size,
      // 引擎侧消费它时要能**独立**建出这只精灵，所以这里带齐最小事实：
      // 静态种族值、特性 id、以及完整的可学技能池（编出来的四只是从池子里挑的）。
      // 这些字段逐条来自冻结全量图鉴，`pointer` 写清出处；不是本模块算的。
      stats: Object.fromEntries(Object.entries(pet.stats ?? {}).filter(([, value]) => Number.isFinite(value))),
      stats_pointer: `full-catalog.json#pets[${pet.pet_id}].stats`,
      feature_skill_id: pet.feature_skill_id ?? null,
      learnable_pool: compiled.pool > 0 ? undefined : undefined,
      unknowns: [...BUILD_UNKNOWNS],
    };
    // 完整可学池（已在 `compileBuild` 里解析过）：与四个技能同一条纪律——只收录能解析的战斗技能。
    builds[pet.pet_id].learnable_pool = compiled.resolved.map((row) => row.skill_id);
  }

  const ids = Object.keys(builds).sort();
  return {
    schema_version: SCHEMA_VERSION,
    artifact: 'on-demand-builds',
    ruleset_id: catalog.ruleset_id ?? null,
    generated_by: 'scripts/roco/build-on-demand-builds.mjs',
    why: '全量图鉴每只精灵都带 learnable_skills（实测 622/622、8787 条引用全部可解析），'
      + '但冻结 learnsets.json 只覆盖 48 只 ⇒ 另外 574 只「选得到、上不了场」。'
      + '本产物把这批编成确定、可复核、可替换的四个技能，并**明确标成未核验**。',
    selection_rule: {...SELECTION_RULE},
    derived_from: {
      catalog: {path: 'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json', sha256: hashes.catalog},
      skills: {path: 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json', sha256: hashes.skills},
      frozen_learnsets: frozenBuilds.__source
        ? {path: 'data/roco/owned/owned-pets.json#battle_builds', sha256: hashes.frozen, count: frozenCount(frozenBuilds)}
        : null,
    },
    summary: {
      species: ids.length,
      [SUPPORT_FULL_VERIFIED]: supportCounts[SUPPORT_FULL_VERIFIED],
      [SUPPORT_SIMULATABLE_UNVERIFIED]: supportCounts[SUPPORT_SIMULATABLE_UNVERIFIED],
      compiled_matches_frozen: matchedFrozen,
      skipped: skipped.length,
      note: `${SUPPORT_SIMULATABLE_UNVERIFIED} = 本模块推算的配招（工程启发式），`
        + '**不是**冻结数据、也**没有**实机核验；引擎侧消费它时必须带着这个等级。',
    },
    skipped,
    builds,
  };
}

const frozenCount = (frozenBuilds) => Object.keys(frozenBuilds).filter((key) => key !== '__source').length;

/**
 * 检查一份产物。每条判据都配一条必红方向（见 `selftest()` 与 tests）。
 */
export function checkOnDemandBuilds(doc, {catalog, skills, frozenBuilds = {}, hashes} = {}) {
  const issues = [];
  const add = (rule, speciesId, detail) => issues.push({rule, species_id: speciesId, detail});
  if (!doc || typeof doc !== 'object') { add('document_shape', '-', '文档不是对象'); return {ok: false, issues}; }
  if (doc.schema_version !== SCHEMA_VERSION) add('schema_version', '-', `schema_version=${doc.schema_version}`);
  if (doc.selection_rule?.confidence !== 'ENGINE_HYPOTHESIS') {
    add('selection_rule_confidence', '-', '选择规则必须登记为 ENGINE_HYPOTHESIS（它不是游戏规则）');
  }
  if (hashes && doc.derived_from?.catalog?.sha256 && doc.derived_from.catalog.sha256 !== hashes.catalog) {
    add('derived_from_stale', '-', 'catalog sha256 与磁盘不符');
  }
  if (hashes && doc.derived_from?.skills?.sha256 && doc.derived_from.skills.sha256 !== hashes.skills) {
    add('derived_from_stale', '-', 'skills sha256 与磁盘不符');
  }
  const builds = doc.builds && typeof doc.builds === 'object' ? doc.builds : null;
  if (!builds) { add('builds_shape', '-', 'doc.builds 不是对象'); return {ok: false, issues}; }
  const pets = new Map((catalog?.pets ?? []).map((pet) => [pet.pet_id, pet]));
  let full = 0; let unverified = 0; let matched = 0;
  for (const [petId, row] of Object.entries(builds)) {
    const pet = pets.get(petId);
    if (!pet) { add('unknown_species', petId, '产物里出现了不在全量图鉴里的物种'); continue; }
    if (![SUPPORT_FULL_VERIFIED, SUPPORT_SIMULATABLE_UNVERIFIED].includes(row?.support)) {
      add('support_level', petId, `非法 support=${JSON.stringify(row?.support)}`);
      continue;
    }
    if (row.support === SUPPORT_FULL_VERIFIED) {
      full += 1;
      if (!Array.isArray(row.frozen_build) || row.frozen_build.length === 0) {
        add('frozen_missing', petId, 'FULL_VERIFIED 必须带 frozen_build（已核验那一份）');
      }
      if (row.compiled_matches_frozen === true) matched += 1;
      continue;
    }
    unverified += 1;
    if (row.frozen_build !== null) add('unverified_with_frozen', petId, '未核验的 build 不该带 frozen_build');
    const pool = new Set(Array.isArray(pet.learnable_skills) ? pet.learnable_skills : []);
    const list = Array.isArray(row.skills) ? row.skills : null;
    if (!list) { add('skills_shape', petId, 'skills 不是数组'); continue; }
    if (list.length !== 4) add('skills_size', petId, `必须是 4 个技能，实际 ${list.length}`);
    const ids = list.map((skill) => skill?.skill_id);
    if (new Set(ids).size !== ids.length) add('skills_duplicate', petId, `四个技能里有重复：${ids.join('、')}`);
    for (const skill of list) {
      const id = skill?.skill_id;
      if (!pool.has(id)) add('skill_not_in_pool', petId, `${id} 不在该物种的 learnable_skills 里`);
      const frozenSkill = skills?.skills?.[id];
      if (!frozenSkill) { add('skill_unresolved', petId, `${id} 在 skills.json 里解析不到`); continue; }
      if (frozenSkill.is_trait === true) add('skill_is_trait', petId, `${id} 是特性，不是战斗技能`);
      // 威力：来源没给就不许出现数字（这是「不补 0」的那条纪律）
      if (skill.power !== null && !Number.isFinite(skill.power)) add('power_fabricated', petId, `${id} 的威力不是数字也不是 null`);
      if (skill.power !== null && frozenSkill.power !== skill.power) {
        add('power_mismatch', petId, `${id} 的威力与冻结 skills.json 不一致`);
      }
      if (skill.power === null && frozenSkill.power_status && skill.power_status !== frozenSkill.power_status) {
        add('power_status_mismatch', petId, `${id} 的 power_status 与冻结数据不一致`);
      }
    }
  }
  // 覆盖：全量图鉴里每只都要**要么编出来、要么如实登记跳过**，而且**只能占一个**——
  // 既编出来又登记跳过会让「有多少只上了场」这笔账永远对不上。
  const skippedIds = new Set((doc.skipped ?? []).map((row) => row?.pet_id));
  for (const petId of pets.keys()) {
    if (!builds[petId] && !skippedIds.has(petId)) add('coverage_gap', petId, '既没有 build 也没有跳过记录');
  }
  for (const petId of skippedIds) {
    if (builds[petId]) add('coverage_overlap', petId, '同一只既编出了 build、又登记成跳过（账目对不上）');
  }
  if (doc.summary?.[SUPPORT_FULL_VERIFIED] !== full) {
    add('summary_full', '-', `summary.${SUPPORT_FULL_VERIFIED}=${doc.summary?.[SUPPORT_FULL_VERIFIED]} 实际 ${full}`);
  }
  if (doc.summary?.[SUPPORT_SIMULATABLE_UNVERIFIED] !== unverified) {
    add('summary_unverified', '-', `summary.${SUPPORT_SIMULATABLE_UNVERIFIED}=${doc.summary?.[SUPPORT_SIMULATABLE_UNVERIFIED]} 实际 ${unverified}`);
  }
  if (doc.summary?.compiled_matches_frozen !== matched) {
    add('summary_matched', '-', `summary.compiled_matches_frozen=${doc.summary?.compiled_matches_frozen} 实际 ${matched}`);
  }
  return {ok: issues.length === 0, issues, summary: {full_verified: full, simulatable_unverified: unverified, matched_frozen: matched}};
}

/** 自带用例：每条都拿一个**违规样本**过真判据，必须红。 */
export function selftest() {
  const catalog = {pets: [
    {pet_id: 'pet_000001', name: '甲', types: ['草系'], learnable_skills: ['skill_000010', 'skill_000011', 'skill_000012', 'skill_000013', 'skill_000014']},
    {pet_id: 'pet_000002', name: '乙', types: ['水系'], learnable_skills: ['skill_000020']},
    {pet_id: 'pet_000003', name: '丙', types: ['火系'], learnable_skills: ['skill_000010', 'skill_000011', 'skill_000012', 'skill_000013']},
  ]};
  const mk = (id, power, energy) => ({skill_id: id, name: id, category: '攻击', element: '普通系', energy,
    damage_class: 'physical', power, power_status: power === null ? 'not_provided_by_source' : 'from_source'});
  const skills = {skills: {
    skill_000010: mk('skill_000010', 60, 2), skill_000011: mk('skill_000011', 90, 3),
    skill_000012: mk('skill_000012', null, 1), skill_000013: mk('skill_000013', 40, 1),
    skill_000014: mk('skill_000014', 120, 4), skill_000020: mk('skill_000020', 30, 1),
  }};
  const frozenBuilds = {__source: 'owned-pets.json#battle_builds', pet_000003: ['skill_000010', 'skill_000011', 'skill_000012', 'skill_000013']};
  const hashes = {catalog: sha256('catalog'), skills: sha256('skills'), frozen: sha256('frozen')};
  const good = buildOnDemandBuilds({catalog, skills, frozenBuilds, hashes});
  const cases = [];
  const probe = (name, mutate) => {
    const doc = JSON.parse(JSON.stringify(good));
    mutate(doc);
    const problems = checkOnDemandBuilds(doc, {catalog, skills, frozenBuilds, hashes});
    cases.push({name, want: 'ok=false', passed: problems.ok === false,
      got: problems.ok ? 'ok=true' : `ok=false；命中：${problems.issues[0].rule} ${problems.issues[0].detail}`});
  };
  const base = checkOnDemandBuilds(good, {catalog, skills, frozenBuilds, hashes});
  cases.push({name: '基线（未改坏）必须绿', want: 'ok=true', passed: base.ok === true,
    got: base.ok ? 'ok=true' : `ok=false：${JSON.stringify(base.issues[0])}`});
  probe('编了一个该物种学不到的技能', (doc) => { doc.builds.pet_000001.skills[0].skill_id = 'skill_999999'; });
  probe('四个技能里有重复', (doc) => { doc.builds.pet_000001.skills[1].skill_id = doc.builds.pet_000001.skills[0].skill_id; });
  probe('把威力来源没给的填成 0', (doc) => { doc.builds.pet_000001.skills[0].power = 0; });
  probe('把已核验的那只标成未核验', (doc) => { doc.builds.pet_000003.support = SUPPORT_SIMULATABLE_UNVERIFIED; doc.builds.pet_000003.frozen_build = null; });
  probe('少一个技能', (doc) => { doc.builds.pet_000001.skills.pop(); });
  probe('同一只既编出来又登记跳过（覆盖账目对不上）', (doc) => { doc.skipped.push({pet_id: 'pet_000001', reason: 'X'}); });
  probe('选择规则被偷偷升成官方口径', (doc) => { doc.selection_rule.confidence = 'OFFICIAL_CURRENT'; });
  probe('summary 与实际不符', (doc) => { doc.summary[SUPPORT_SIMULATABLE_UNVERIFIED] = 99; });
  const failed = cases.filter((row) => !row.passed).length;
  return {ok: failed === 0, failed, cases};
}

export {sha256};
