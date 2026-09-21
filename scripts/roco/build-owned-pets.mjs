#!/usr/bin/env node
// ── RC-203：OwnedPet / BattleBuild 生成器（固定 seed，可逐字节复跑） ──────────
//
// 这一层回答的是 L2/L3 的问题：「我**真正拥有的那一只**是谁、练到几级、带哪四个技能、
// 能不能锁定」，而不是「这个物种在图鉴里是什么」。同一个物种可以有多个个体，
// 教练才有得比。所以 instance_id 是主键，species_id 只是外键。
//
// 三条纪律（写在这里，因为它决定了下面每一行怎么写的）：
//
//   ① **不许编数据**。四个技能逐个来自该 species 在冻结目录 learnsets.json 里的
//      native_skills；species 必须真实存在；凑不出四个技能的精灵**跳过**，
//      不补、不改、不猜。全量 622 只里只有 48 只在冻结目录里有 learnset，
//      另外 574 只的跳过原因逐只落在报告里（不是「大概没数据」这种话）。
//
//   ② **不许发明养成公式**。性格 / 个体资质 / 特长 / 血脉只存**标签**，
//      effect 恒为 UNKNOWN、reason 恒为 10 号文档 §13 那句话、microcase_id 恒为 null。
//      面板数值一律不给：base_stats 是冻结目录的**静态种族值**（带 pointer），
//      「等级换算后的面板值」是 panel_stats=null —— 因为我们确实不知道那个公式。
//      本仓唯一一张「性格加成表」在 `data/roco/raw/extracted/NRC_AI/` 里，
//      那是一个 **REFERENCE_ONLY**（不得进入可分发产物）的交叉核验来源，
//      而且标的是**另一款游戏**（页游洛克王国，百度百科）——所以连标签取值都不用。
//
//   ③ **确定性**。固定 seed=20301，没有任何挂钟字段（clock_fields 恒为空）。
//      generated_at 由 ruleset_id 推导，所以 `--check` 可以逐字节比对，不需要任何豁免。
//
// 用法：
//   node scripts/roco/build-owned-pets.mjs            # 生成 schema.json + owned-pets.json + RC-203 报告
//   node scripts/roco/build-owned-pets.mjs --check     # 只校验：重建结果必须与磁盘逐字节相同
//   node scripts/roco/build-owned-pets.mjs --selftest  # 12 条必红反证：把产物改坏，判据必须抓住
//   node scripts/roco/build-owned-pets.mjs --json      # 额外把摘要打到 stdout

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {
  CLOCK_FIELDS,
  FROZEN_FULL_CATALOG,
  FROZEN_IMPORT_REPORT,
  FROZEN_LAYER_LEARNSETS,
  FROZEN_LAYER_PETS,
  FROZEN_LAYER_SUPPORT,
  FROZEN_MAIN_LEARNSETS,
  FROZEN_ROOT,
  FROZEN_SKILLS,
  GENERATED_AT,
  GROWTH_EFFECT_REASON,
  INSTANCE_TARGET,
  LICENCE_REF,
  MIN_OUTSIDE_LAYER,
  MIN_SAME_SPECIES_GROUPS,
  MIN_SPECIES,
  OWNED_PETS_PATH,
  OWNED_SCHEMA_PATH,
  PACK_PATH,
  RC203_REPORT_PATH,
  RULESET_ID,
  GAME,
  SEED,
  SOURCE_MODE,
  battleBuildHash,
  buildOwnedPetSchema,
  compareOwnedPets,
  datasetHash,
  deepClone,
  deepEqual,
  expectedBattleBuildUnknownFields,
  expectedInstanceUnknownFields,
  growthAttribute,
  instanceBuildHash,
  makeRng,
  sha256Hex,
} from './owned-pets-lib.mjs';
import {CHECK_NAMES, SELFTEST_MUTATIONS, criteriaReport, runChecks, runSelftest} from './verify-owned-pets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');

/** 等级取值：Demo 值，不是从冻结目录里查出来的游戏常量（那里面没有等级上限证据）。 */
const LEVELS = Object.freeze([50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]);
const GENERATOR = 'scripts/roco/build-owned-pets.mjs';

// ── 读盘小工具（只读，不改任何输入） ────────────────────────────────────────

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

function shaOf(root, path) {
  return createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
}

/** Fisher-Yates：用我们自己的 rng，而不是 Math.random（那会毁掉可复跑性）。 */
function shuffle(rng, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ── 候选宇宙 ────────────────────────────────────────────────────────────────

/**
 * 把 622 只 pack 精灵逐只过一遍，能用的留下、不能用的记下**为什么**。
 *
 * 「候选宇宙 600+」不是口号：这里真的从 622 条记录出发，
 * 而不是从一个写死的 48 只白名单出发。48 只是**结果**（有冻结 learnset 的那批），
 * 不是**输入**。
 */
function collectCandidates(root) {
  const mainLearnsets = readJson(root, FROZEN_MAIN_LEARNSETS);
  const layerLearnsets = readJson(root, FROZEN_LAYER_LEARNSETS);
  const layerPets = readJson(root, FROZEN_LAYER_PETS);
  const layerSupport = readJson(root, FROZEN_LAYER_SUPPORT);
  const fullCatalog = readJson(root, FROZEN_FULL_CATALOG);
  const skillsDoc = readJson(root, FROZEN_SKILLS);
  const pack = readJson(root, PACK_PATH);
  const importReport = readJson(root, FROZEN_IMPORT_REPORT);
  // roster-48.json 是「可玩 48 池」（12 基线 + 36 overlay）。它**不是**本任务的判据口径，
  // 但两个口径的数都要摆出来，免得读者以为哪个数是笔误。
  const roster48 = readJson(root, `${FROZEN_ROOT}/roster-48.json`);

  const catalogById = new Map();
  fullCatalog.pets.forEach((pet, index) => catalogById.set(pet.pet_id, {pet, index}));
  const packEntities = (pack.sections.distributable.entities ?? []).filter((entity) => entity.group === 'pet');
  const packById = new Map(packEntities.map((entity, index) => [entity.id, {entity, index}]));
  const layerPetIds = new Set([
    ...Object.keys(layerPets.pets ?? {}),
    ...Object.keys(layerLearnsets.learnsets ?? {}),
    ...Object.keys(layerSupport.pets ?? {}),
  ]);
  const skillIds = new Set(Object.keys(skillsDoc.skills ?? {}));

  const sources = {
    FROZEN_MAIN_LEARNSETS: shaOf(root, FROZEN_MAIN_LEARNSETS),
    FROZEN_LAYER_LEARNSETS: shaOf(root, FROZEN_LAYER_LEARNSETS),
    FROZEN_FULL_CATALOG: shaOf(root, FROZEN_FULL_CATALOG),
    PACK_PATH: shaOf(root, PACK_PATH),
  };

  const skipped = {
    no_frozen_learnset: [],
    insufficient_learnable_skills: [],
    no_blood_skills_in_learnset: [],
    species_not_in_pack: [],
  };
  const candidates = [];
  const seen = new Set();

  const consider = (petId, entry, artifactPath) => {
    if (seen.has(petId)) return;
    seen.add(petId);
    const catalog = catalogById.get(petId);
    const packEntry = packById.get(petId);
    const name = catalog?.pet?.name ?? packEntry?.entity?.name ?? petId;
    if (!catalog || !packEntry) {
      skipped.species_not_in_pack.push({species_id: petId, species_name: name, reason: 'species_not_in_pack'});
      return;
    }
    // 可学技能：只认 native_skills；顺带按 (习得等级, skill_id) 排序，让「最低等级那四个」可复算。
    const native = (entry.native_skills ?? [])
      .map((row) => ({level: row.level, skill_id: row.skill_id}))
      .sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.skill_id.localeCompare(b.skill_id));
    const usable = native.filter((row) => skillIds.has(row.skill_id));
    const orphanRefs = native.filter((row) => !skillIds.has(row.skill_id)).map((row) => row.skill_id);
    if (usable.length < 4) {
      skipped.insufficient_learnable_skills.push({
        species_id: petId,
        species_name: name,
        reason: 'insufficient_learnable_skills',
        learnable: usable.length,
        orphan_skill_refs: orphanRefs,
      });
      return;
    }
    const bloodSkills = (entry.blood_skills ?? []).filter((row) => skillIds.has(row.skill_id));
    if (bloodSkills.length === 0) {
      skipped.no_blood_skills_in_learnset.push({species_id: petId, species_name: name, reason: 'no_blood_skills_in_learnset'});
      return;
    }
    candidates.push({
      petId,
      speciesName: name,
      tier: layerPetIds.has(petId) ? 'overlay' : 'baseline',
      learnsetPath: artifactPath === FROZEN_MAIN_LEARNSETS ? FROZEN_MAIN_LEARNSETS : FROZEN_LAYER_LEARNSETS,
      learnsetSha: artifactPath === FROZEN_MAIN_LEARNSETS
        ? sources.FROZEN_MAIN_LEARNSETS
        : sources.FROZEN_LAYER_LEARNSETS,
      pointer: `learnsets.${petId}.native_skills`,
      usable,
      bloodSkills,
      catalogIndex: catalog.index,
      stats: catalog.pet.stats,
      packIndex: packEntry.index,
      effectiveForm: packEntry.entity.form_axis?.axis ?? 'BASE',
    });
  };

  // 主 learnsets.json（12 只，**不在** layer-playable-48 目录里）
  for (const [petId, entry] of Object.entries(mainLearnsets.learnsets ?? {})) {
    consider(petId, entry, FROZEN_MAIN_LEARNSETS);
  }
  // layer-playable-48/learnsets.json（36 只 overlay）
  for (const [petId, entry] of Object.entries(layerLearnsets.learnsets ?? {})) {
    consider(petId, entry, FROZEN_LAYER_LEARNSETS);
  }

  // 没有冻结 learnset 的 pack 精灵：逐只点名（不是「大概没数据」）。
  const withLearnset = new Set([...Object.keys(mainLearnsets.learnsets ?? {}), ...Object.keys(layerLearnsets.learnsets ?? {})]);
  for (const entity of packEntities) {
    if (withLearnset.has(entity.id)) continue;
    skipped.no_frozen_learnset.push({
      species_id: entity.id,
      species_name: entity.name,
      reason: 'no_frozen_learnset',
      detail: 'pack 里有这只，但冻结 normalized/ 目录里没有它的 learnsets.json 条目——四技能与合法性未校验，不给它配技能',
    });
  }

  candidates.sort((a, b) => a.petId.localeCompare(b.petId));
  for (const key of Object.keys(skipped)) {
    skipped[key].sort((a, b) => a.species_id.localeCompare(b.species_id));
  }

  return {
    candidates,
    skipped,
    counts: {
      rosterPetIds: (roster48.pets ?? []).map((pet) => pet.pet_id ?? pet.id),
      packPetEntities: packEntities.length,
      withFrozenLearnset: withLearnset.size,
      baseline: candidates.filter((c) => c.tier === 'baseline').length,
      overlay: candidates.filter((c) => c.tier === 'overlay').length,
      upstreamLearnsetsInSnapshot: importReport?.counts?.learnsets_total_in_snapshot ?? null,
    },
    sources,
    importReport,
  };
}

// ── 生成 ────────────────────────────────────────────────────────────────────

/**
 * 生成整份产物。
 *
 * 实例配比是**算出来的**、不是写死的：先给每个候选 1 个实例，再按确定性洗牌的顺序
 * 把 species 提升为「2 个实例」，直到凑够 80 个。这样「同种不同个体」组数是
 * 由数据规模推出来的，而不是「先写 32 组再解释」。
 */
export function buildOwnedPets({root = ROOT} = {}) {
  const {candidates, skipped, counts: universe, sources} = collectCandidates(root);
  if (candidates.length < MIN_SPECIES) {
    throw new Error(`有冻结 learnset 的 species 只有 ${candidates.length} 个 < ${MIN_SPECIES}：产物无法满足宇宙判据`);
  }
  const baseline = candidates.filter((c) => c.tier === 'baseline');
  const overlay = candidates.filter((c) => c.tier === 'overlay');
  if (baseline.length < MIN_OUTSIDE_LAYER) {
    throw new Error(`不在 layer-playable-48 里的 species 只有 ${baseline.length} 个 < ${MIN_OUTSIDE_LAYER}：产物无法满足宇宙判据`);
  }

  const rng = makeRng(SEED);
  // baseline 一律 2 个（这样「不在 layer-playable-48」那条判据天然满足）；
  // overlay 按确定性洗牌顺序逐个提升，直到总数到 80。
  const paired = new Set(baseline.map((c) => c.petId));
  let projected = candidates.length + paired.size;
  const overlayOrder = shuffle(rng, overlay.map((c) => c.petId));
  for (const petId of overlayOrder) {
    if (projected >= INSTANCE_TARGET) break;
    paired.add(petId);
    projected += 1;
  }
  if (projected !== INSTANCE_TARGET) {
    throw new Error(`配比算出来是 ${projected} 个实例，凑不到 ${INSTANCE_TARGET} 个（候选 ${candidates.length} 个 species）`);
  }

  const instances = [];
  const battleBuilds = [];
  let serial = 0;
  for (const candidate of candidates) {
    const groupSize = paired.has(candidate.petId) ? 2 : 1;
    let previousLevel = null;
    let previousSkills = null;
    for (let k = 0; k < groupSize; k += 1) {
      serial += 1;
      const instanceId = `own-${String(serial).padStart(4, '0')}`;

      // 等级：Demo 值；同一 species 的两个个体**等级必定不同**（这样「同种不同个体」不靠运气）。
      let level = LEVELS[Math.floor(rng() * LEVELS.length) % LEVELS.length];
      if (previousLevel !== null && level === previousLevel) {
        level = LEVELS[(LEVELS.indexOf(level) + 1 + Math.floor(rng() * (LEVELS.length - 1))) % LEVELS.length];
      }

      // 四个技能：从该 species 的 native_skills 里取四个，顺序即技能位顺序。
      const pool = candidate.usable.map((row) => row.skill_id);
      let skills = shuffle(rng, pool).slice(0, 4);
      if (previousSkills !== null && deepEqual(skills, previousSkills)) {
        // 极小概率撞上同一组：旋转一位，保证「有序技能组合」不同。
        skills = [skills[3], skills[0], skills[1], skills[2]];
      }

      // 血脉：只有**真的带血脉名**的行才能当标签用。layer-playable-48 的 36 只 overlay 里
      // blood 是 null（blood_status=not_provided_by_source）——那就标 UNKNOWN，不拿 18 条
      // 无名的 skill_id 编一个「血脉」出来。
      const labelledBlood = candidate.bloodSkills.filter((row) => typeof row.blood === 'string' && row.blood.length > 0);
      const blood = labelledBlood.length > 0
        ? labelledBlood[Math.floor(rng() * labelledBlood.length) % labelledBlood.length]
        : null;
      const bloodline = growthAttribute({
        value: blood ? blood.blood : null,
        valueSource: blood ? `${candidate.learnsetPath}#learnsets.${candidate.petId}.blood_skills[].blood` : null,
        extra: {
          value_pointer: `learnsets.${candidate.petId}.blood_skills[].blood`,
          blood_skill_id: blood ? blood.skill_id : null,
        },
      });

      const instance = {
        instance_id: instanceId,
        species_id: candidate.petId,
        species_name: candidate.speciesName,
        species_tier: candidate.tier,
        level,
        nature: growthAttribute(),
        talent: growthAttribute(),
        specialty: growthAttribute(),
        bloodline,
        skills,
        skills_source: {
          artifact_path: candidate.learnsetPath,
          artifact_sha256: candidate.learnsetSha,
          pointer: candidate.pointer,
        },
        base_stats: {
          hp: candidate.stats.hp,
          atk: candidate.stats.atk,
          def: candidate.stats.def,
          spa: candidate.stats.spa,
          spd: candidate.stats.spd,
          spe: candidate.stats.spe,
        },
        // 等级换算后的面板值：公式未校准，所以这里**没有数**。
        panel_stats: null,
        source: SOURCE_MODE,
        favourite: rng() < 0.3,
        locked: rng() < 0.125,
        provenance: [
          {
            source_id: LICENCE_REF,
            source_scope: 'frozen_l1',
            artifact_path: candidate.learnsetPath,
            artifact_sha256: candidate.learnsetSha,
            pointer: candidate.pointer,
            note: '四个技能的候选集合出处（native_skills）',
          },
          {
            source_id: LICENCE_REF,
            source_scope: 'frozen_l1',
            artifact_path: FROZEN_FULL_CATALOG,
            artifact_sha256: sources.FROZEN_FULL_CATALOG,
            pointer: `pets[${candidate.catalogIndex}].stats`,
            note: '静态种族值出处（不是等级换算后的面板值）',
          },
        ],
        licence_ref: LICENCE_REF,
        unknown_fields: [],
        build_hash: '',
      };
      instance.unknown_fields = expectedInstanceUnknownFields(instance);
      instance.build_hash = instanceBuildHash(instance);
      instances.push(instance);

      const build = {
        build_id: `build-${instanceId}`,
        owned_pet_instance_id: instanceId,
        species_id: candidate.petId,
        effective_form: candidate.effectiveForm,
        form_sources: [
          {
            source_id: LICENCE_REF,
            source_scope: 'frozen_l1',
            artifact_path: PACK_PATH,
            artifact_sha256: sources.PACK_PATH,
            pointer: `sections.distributable.entities[${candidate.packIndex}].form_axis.axis`,
            note: '出战形态轴出处',
          },
        ],
        ordered_skills: [...skills],
        effective_bloodline: deepClone(bloodline),
        derived_stats: null,
        derived_stats_confidence: 'UNKNOWN',
        ruleset_id: RULESET_ID,
        unknown_fields: [],
        build_hash: '',
      };
      build.unknown_fields = expectedBattleBuildUnknownFields(build);
      build.build_hash = battleBuildHash(build);
      battleBuilds.push(build);

      previousLevel = level;
      previousSkills = skills;
    }
  }

  const counts = {
    instances: instances.length,
    species: new Set(instances.map((i) => i.species_id)).size,
    species_in_layer_playable_48: new Set(instances.filter((i) => i.species_tier === 'overlay').map((i) => i.species_id)).size,
    species_outside_layer_playable_48: new Set(instances.filter((i) => i.species_tier === 'baseline').map((i) => i.species_id)).size,
    same_species_groups: 0,
    same_species_groups_with_difference: 0,
    battle_builds: battleBuilds.length,
    skills_referenced: new Set(instances.flatMap((i) => i.skills)).size,
  };
  const bySpecies = new Map();
  for (const instance of instances) {
    if (!bySpecies.has(instance.species_id)) bySpecies.set(instance.species_id, []);
    bySpecies.get(instance.species_id).push(instance);
  }
  for (const group of bySpecies.values()) {
    if (group.length < 2) continue;
    counts.same_species_groups += 1;
    // 复用同一个比较器：判据与产物用同一份逻辑，免得两处说法不一致。
    const comparison = compareOwnedPets(group[0], group[1]);
    if (comparison.differs_in_at_least_one_attribute) counts.same_species_groups_with_difference += 1;
  }

  const dataset = {
    schema_version: 'roco-owned-pets/v1',
    ruleset_id: RULESET_ID,
    game: GAME,
    generated_by: GENERATOR,
    generated_at: GENERATED_AT,
    clock_fields: [...CLOCK_FIELDS],
    seed: SEED,
    source: SOURCE_MODE,
    licence_ref: LICENCE_REF,
    unknown_fields_allowlist: ['nature', 'talent', 'specialty', 'bloodline', 'panel_stats'],
    counts,
    candidate_universe: {
      definition: 'pack.json 的 pet 实体（600+ 候选宇宙），不是 48 只迁移夹具',
      pack_pet_entities: universe.packPetEntities,
      with_frozen_learnset: universe.withFrozenLearnset,
      baseline_species: universe.baseline,
      overlay_species: universe.overlay,
      upstream_learnsets_in_snapshot: universe.upstreamLearnsetsInSnapshot,
      note: [
        `pack 里有 ${universe.packPetEntities} 只；冻结 normalized/ 目录里只有 ${universe.withFrozenLearnset} 只有 learnsets.json 条目`,
        `（主 learnsets.json 的 ${universe.baseline} 只 baseline + layer-playable-48 的 ${universe.overlay} 只 overlay）。`,
        `上游快照里其实有 ${universe.upstreamLearnsetsInSnapshot} 份 learnset，但其余那些没有导入冻结目录，`,
        '本产物 fail closed：没有冻结 learnset 的精灵一只都不配技能。',
      ],
    },
    skips: {
      reasons: [
        {
          reason: 'no_frozen_learnset',
          count: skipped.no_frozen_learnset.length,
          detail: 'pack 里有这只，但冻结 normalized/ 目录里没有它的 learnsets.json 条目（四技能与合法性未校验）',
        },
        {
          reason: 'insufficient_learnable_skills',
          count: skipped.insufficient_learnable_skills.length,
          detail: '有 learnset，但 native_skills 里在全量 skills.json 里查得到的不足 4 个',
        },
        {
          reason: 'no_blood_skills_in_learnset',
          count: skipped.no_blood_skills_in_learnset.length,
          detail: '有 learnset，但 blood_skills 一个都查不到——血脉标签无从取值（不猜）',
        },
        {
          reason: 'species_not_in_pack',
          count: skipped.species_not_in_pack.length,
          detail: '有 learnset，但不在 pack 的 pet 实体里（来源台账对不上）',
        },
      ],
      no_frozen_learnset: skipped.no_frozen_learnset.length,
      insufficient_learnable_skills: skipped.insufficient_learnable_skills.length,
      no_blood_skills_in_learnset: skipped.no_blood_skills_in_learnset.length,
      species_not_in_pack: skipped.species_not_in_pack.length,
      skipped_species_total: Object.values(skipped).reduce((sum, list) => sum + list.length, 0),
    },
    growth_attribute_policy: {
      effect: 'UNKNOWN',
      reason: GROWTH_EFFECT_REASON,
      doc: '10-SOURCES-AND-CONFIDENCE.md §13 养成相关',
      fields: {
        nature: '冻结目录没有任何性格取值枚举；仓库里唯一一张性格加成表在 REFERENCE_ONLY 的交叉核验来源里，且标的是另一款游戏——不用。',
        talent: '冻结目录没有任何「个体资质」取值枚举（字段存在 ≠ 换算已知）。',
        specialty: '冻结目录没有任何「特长」取值枚举。',
        bloodline: '只有主 learnsets.json 的 12 只 baseline 带真实血脉名（blood_skills[].blood）；layer-playable-48 的 36 只 overlay 里该字段是 null（blood_status=not_provided_by_source），那 36 只的血脉标 UNKNOWN。无论哪一层，「血脉怎么参与结算」都没有校准。',
      },
      consequence: '阵容评估不得把 nature / talent / specialty / bloodline 当成已知加成；它们现在只是标签。',
    },
    provenance: [
      {
        source_id: LICENCE_REF,
        source_scope: 'frozen_l1',
        artifact_path: FROZEN_FULL_CATALOG,
        artifact_sha256: sources.FROZEN_FULL_CATALOG,
        pointer: 'pets',
        note: '622 只的静态种族值 / 名字 / learnable_skills',
      },
      {
        source_id: LICENCE_REF,
        source_scope: 'frozen_l1',
        artifact_path: FROZEN_MAIN_LEARNSETS,
        artifact_sha256: sources.FROZEN_MAIN_LEARNSETS,
        pointer: 'learnsets',
        note: 'baseline 12 只的 learnset（在 layer-playable-48 目录之外）',
      },
      {
        source_id: LICENCE_REF,
        source_scope: 'frozen_l1',
        artifact_path: FROZEN_LAYER_LEARNSETS,
        artifact_sha256: sources.FROZEN_LAYER_LEARNSETS,
        pointer: 'learnsets',
        note: 'layer-playable-48 overlay 36 只的 learnset',
      },
      {
        source_id: LICENCE_REF,
        source_scope: 'frozen_l1',
        artifact_path: PACK_PATH,
        artifact_sha256: sources.PACK_PATH,
        pointer: 'source_registry',
        note: '来源台账与许可（licence_ref 的解析依据）',
      },
    ],
    instances,
    battle_builds: battleBuilds,
    dataset_hash: '',
  };
  dataset.dataset_hash = datasetHash(dataset);

  const schema = buildOwnedPetSchema();
  return {
    schema,
    schemaText: `${JSON.stringify(schema, null, 2)}\n`,
    dataset,
    datasetText: `${JSON.stringify(dataset, null, 2)}\n`,
    skipped,
    universe,
    sources,
  };
}

// ── 报告 ────────────────────────────────────────────────────────────────────

/**
 * 机器可读报告（任务第 6 项）：实例数 / species 数 / 不在 48 层的**逐只点名** /
 * 同种不同个体组数与逐组差异字段 / 跳过的精灵与原因 /
 * 哪些个体属性仍是 UNKNOWN 及为什么 / 90 天内的复现命令。
 */
export function buildReport({dataset, datasetText, checkResult, skipped, universe}) {
  const roster48 = new Set(universe.rosterPetIds ?? []);
  const speciesOutsideRoster48 = [...new Set(dataset.instances
    .filter((instance) => !roster48.has(instance.species_id))
    .map((instance) => instance.species_id))].sort();
  const checksByCheck = new Map(checkResult.checks.map((entry) => [entry.check, entry]));
  const criteria = criteriaReport(checkResult.facts).map((criterion) => {
    const check = checksByCheck.get(criterion.check);
    return {
      ...criterion,
      ok: check ? check.ok : null,
      problems: check && !check.ok ? checkProblemsOf(checkResult.problems, criterion.check) : [],
    };
  });

  const growthUnknown = new Map();
  for (const field of ['nature', 'talent', 'specialty', 'bloodline']) {
    growthUnknown.set(field, dataset.instances.filter((instance) => instance[field]?.value === null).length);
  }

  return {
    report_version: 'roco-rc203-owned-pets-report/v1',
    task: 'RC-203 OwnedPet / BattleBuild',
    generated_by: GENERATOR,
    generated_at: GENERATED_AT,
    clock_fields: [...CLOCK_FIELDS],
    artifact: {
      path: OWNED_PETS_PATH,
      sha256: sha256Hex(datasetText),
      dataset_hash: dataset.dataset_hash,
      instances: dataset.instances.length,
      battle_builds: dataset.battle_builds.length,
    },
    schema: {path: OWNED_SCHEMA_PATH},
    ok: checkResult.ok,
    criteria,
    counts: dataset.counts,
    candidate_universe: dataset.candidate_universe,
    // **这批实例能证明什么、不能证明什么**（主线程补：防止「12 只在 layer-playable-48 之外」
    // 被读成「候选宇宙不止 48 只」的证据 —— 那 12 只是基线层，本来就在 roster-48 之内）。
    buildability_ceiling: {
      candidate_universe_species: dataset.candidate_universe.pack_pet_entities,
      species_with_frozen_learnset: dataset.candidate_universe.with_frozen_learnset,
      candidates_without_frozen_learnset: dataset.candidate_universe.pack_pet_entities - dataset.candidate_universe.with_frozen_learnset,
      buildable_subset_equals_roster_48: new Set(dataset.instances.map((i) => i.species_id)).size === roster48.size
        && [...new Set(dataset.instances.map((i) => i.species_id))].every((id) => roster48.has(id)),
      proves_600_buildable: false,
      why_not: '冻结目录只导入了 48 份 learnset（12 基线 + 36 overlay），上游快照另有 264 份未导入；'
        + '622 个候选里 574 只在 no_frozen_learnset 上 fail closed 跳过，所以可出战子集现在恰好等于 roster-48。',
      needed_to_prove: '导入其余 learnset，或走 RC-402 的按需 Capability Compiler。',
      must_not_claim: '不得把本批 80 个实例说成「600+ 都能出战」。',
    },
    outside_layer_playable_48: {
      criterion: 'C06',
      definition: '按任务文本点名的 layer-playable-48 目录算：不在 layer-playable-48/pets.json、layer-playable-48/learnsets.json、layer-playable-48/support-matrix.json 的 pet 集合里的 species',
      expected_min: MIN_OUTSIDE_LAYER,
      count: checkResult.facts.speciesOutsideLayerPlayable48,
      species: checkResult.facts.outsideLayerSpecies,
      what_this_proves: '这 12 只是**基线层**的 12 只，它们本来就在 roster-48.json 的 48 只之内；'
        + '所以这条**不能**用来证明「候选宇宙不止 48 只」（见 buildability_ceiling）。',
      alternative_reading: {
        definition: '若把 roster-48.json（48 条 = 12 基线 + 36 overlay）当成「48 层」',
        roster_48_species: roster48.size,
        species_outside_roster_48: speciesOutsideRoster48.length,
        species: speciesOutsideRoster48,
        note: '有冻结 learnset 的 48 只恰好等于 roster-48 的 48 只：上游快照里那 312 份 learnset 的其余部分没有导入冻结目录，'
          + '而本产物 fail closed（没有冻结 learnsets.json 的精灵一只都不配技能），所以在「48 层 = roster-48」这个口径下取不到池外的 species。'
          + '这是本任务已知的紧张点，写在这里而不是藏起来。',
      },
    },
    same_species_groups: {
      expected_min: MIN_SAME_SPECIES_GROUPS,
      count: checkResult.facts.sameSpeciesGroups,
      with_difference: checkResult.facts.sameSpeciesGroupsWithDifference,
      groups: checkResult.facts.sameSpeciesGroupDetails,
    },
    skips: {
      counts: dataset.skips,
      species: [
        ...skipped.no_frozen_learnset,
        ...skipped.insufficient_learnable_skills,
        ...skipped.no_blood_skills_in_learnset,
        ...skipped.species_not_in_pack,
      ],
    },
    unknown_attributes: [
      {
        field: 'nature',
        value: null,
        instances_affected: growthUnknown.get('nature') ?? 0,
        why: '冻结目录里没有任何性格取值枚举；仓库里唯一一张性格加成表（data/roco/raw/extracted/NRC_AI/src/pokemon_nature_table.py）来自 REFERENCE_ONLY 的交叉核验来源，且标的是另一款游戏（页游），不得进入可分发产物',
        where_it_would_be_resolved: '需要一条可分发来源给出性格取值与面板换算，并过 microcase',
      },
      {
        field: 'talent',
        value: null,
        instances_affected: growthUnknown.get('talent') ?? 0,
        why: '冻结目录里没有任何「个体资质」取值枚举（字段存在 ≠ 换算已知，见 10 号文档 §13）',
        where_it_would_be_resolved: '同上',
      },
      {
        field: 'specialty',
        value: null,
        instances_affected: growthUnknown.get('specialty') ?? 0,
        why: '冻结目录里没有任何「特长」取值枚举；快照只说「一般般的天分无法获得特长」，没有取值表',
        where_it_would_be_resolved: '同上',
      },
      {
        field: 'bloodline.value',
        value: null,
        instances_affected: growthUnknown.get('bloodline') ?? 0,
        why: 'layer-playable-48 的 36 只 overlay 在 learnsets.json 里 blood 是 null（blood_status=not_provided_by_source）；只有主 learnsets.json 的 12 只 baseline 带真实血脉名。无名可标就标 UNKNOWN，不拿 18 条无名的 skill_id 编一个「血脉」出来',
        where_it_would_be_resolved: '需要一份逐条给出 blood 字段的可分发 learnset 导入',
      },
      {
        field: 'bloodline.effect',
        value: 'UNKNOWN',
        instances_affected: dataset.instances.length,
        why: '标签（blood_skills[].blood）有真实出处，但「血脉怎么参与结算」没有校准',
        where_it_would_be_resolved: '需要血脉结算的 microcase',
      },
      {
        field: 'panel_stats',
        value: null,
        instances_affected: dataset.instances.length,
        why: '等级换算后的面板值需要未校准的公式；本产物只给冻结目录的静态种族值 base_stats（带 pointer）',
        where_it_would_be_resolved: '面板换算公式校准后由 RC-403 支持分级接管',
      },
      {
        field: 'battle_builds[].derived_stats',
        value: null,
        instances_affected: dataset.battle_builds.length,
        why: '与 panel_stats 同因：公式未校准，所以不给数（fail closed，而不是给个估数）',
        where_it_would_be_resolved: '同上',
      },
    ],
    reproduce: {
      within_days: 90,
      deterministic: true,
      wall_clock_fields: 0,
      commands: [
        'node scripts/roco/build-owned-pets.mjs',
        'node scripts/roco/build-owned-pets.mjs --check',
        'node scripts/roco/build-owned-pets.mjs --selftest',
        'node scripts/roco/verify-owned-pets.mjs',
        'node scripts/roco/verify-owned-pets.mjs --json',
        'node scripts/roco/verify-owned-pets.mjs --selftest',
        'node --test tests/roco-owned-pets.test.js',
      ],
      note: '同输入两次运行逐字节相同；generated_at 由 ruleset_id 推导（没有任何挂钟字段），所以 --check 逐字节比对且不做任何字段豁免。',
    },
    checks: checkResult.checks,
    problems: checkResult.problems,
  };
}

function checkProblemsOf(problems, check) {
  return problems.filter((problem) => problem.startsWith(`[${check}]`));
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function writeIfChanged(path, text, {check}) {
  const absolute = join(ROOT, path);
  const exists = existsSync(absolute) && statSync(absolute).isFile();
  const current = exists ? readFileSync(absolute, 'utf8') : null;
  if (current === text) return {path, status: 'unchanged'};
  if (check) return {path, status: exists ? 'DIFFERS' : 'MISSING'};
  mkdirSync(dirname(absolute), {recursive: true});
  writeFileSync(absolute, text);
  return {path, status: exists ? 'rewritten' : 'created'};
}

const HELP = `用法：node scripts/roco/build-owned-pets.mjs [--check] [--selftest] [--json]

  （无参数）  生成 ${OWNED_SCHEMA_PATH} / ${OWNED_PETS_PATH} / ${RC203_REPORT_PATH}
  --check     只校验：现在重建的结果必须与磁盘产物**逐字节相同**（可复跑判据），不写盘
  --selftest  ${SELFTEST_MUTATIONS.length} 条必红反证：把产物改坏，判据必须抓住
  --json      额外把摘要打到 stdout

退出码：0=成功（--check 下即「逐字节相同」）；1=有差异或判据不通过；2=运行异常`;

function main(argv) {
  const check = argv.includes('--check');
  const json = argv.includes('--json');
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const built = buildOwnedPets({root: ROOT});
  const checkResult = runChecks(built.dataset, {root: ROOT});
  const report = buildReport({
    dataset: built.dataset,
    datasetText: built.datasetText,
    checkResult,
    skipped: built.skipped,
    universe: built.universe,
  });
  const reportText = `${JSON.stringify(report, null, 2)}\n`;

  if (check) {
    const results = [
      writeIfChanged(OWNED_SCHEMA_PATH, built.schemaText, {check}),
      writeIfChanged(OWNED_PETS_PATH, built.datasetText, {check}),
      writeIfChanged(RC203_REPORT_PATH, reportText, {check}),
    ];
    const drifted = results.filter((entry) => entry.status !== 'unchanged');
    process.stdout.write(`RC-203 复跑比对（逐字节，无字段豁免）：${drifted.length === 0 ? '相同' : '有差异'}\n`);
    for (const entry of results) process.stdout.write(`  ${entry.status.padEnd(10)} ${entry.path}\n`);
    if (drifted.length) {
      process.stderr.write('重建结果与磁盘产物不同：产物过期或被人手改过。跑一次不带 --check 的命令即可重写。\n');
      return 1;
    }
    return checkResult.ok ? 0 : 1;
  }

  const results = [
    writeIfChanged(OWNED_SCHEMA_PATH, built.schemaText, {check}),
    writeIfChanged(OWNED_PETS_PATH, built.datasetText, {check}),
    writeIfChanged(RC203_REPORT_PATH, reportText, {check}),
  ];
  for (const entry of results) process.stdout.write(`${entry.status.padEnd(10)} ${entry.path}\n`);

  process.stdout.write(`实例 ${built.dataset.counts.instances} 个 / species ${built.dataset.counts.species} 个`
    + `（不在 layer-playable-48 的 ${built.dataset.counts.species_outside_layer_playable_48} 个）`
    + ` / 同种组 ${built.dataset.counts.same_species_groups}（其中有差异 ${built.dataset.counts.same_species_groups_with_difference}）`
    + ` / battle_builds ${built.dataset.counts.battle_builds}\n`);
  process.stdout.write(`候选宇宙 ${built.dataset.candidate_universe.pack_pet_entities} 只，有冻结 learnset 的 ${built.dataset.candidate_universe.with_frozen_learnset} 只，`
    + `跳过 ${built.dataset.skips.skipped_species_total} 只（无冻结 learnset ${built.dataset.skips.no_frozen_learnset}）\n`);

  process.stdout.write(`判据 ${checkResult.ok ? 'PASS' : 'FAIL'}（${CHECK_NAMES.length} 组）\n`);
  for (const entry of checkResult.checks) {
    if (!entry.ok) process.stdout.write(`  FAIL ${entry.check}（${entry.problems} 条）\n`);
  }
  for (const problem of checkResult.problems.slice(0, 20)) process.stdout.write(`  ${problem}\n`);

  if (argv.includes('--selftest')) {
    process.stdout.write(`\n必红反证：\n`);
    const selftest = runSelftest(built.dataset, {
      root: ROOT,
      onResult: (entry) => {
        process.stdout.write(`  ${entry.caught ? '红  ' : '没红'} ${entry.id} ${entry.title} → 期望 ${entry.expect}\n`);
        for (const problem of entry.problems.slice(0, 2)) process.stdout.write(`        实际输出：${problem}\n`);
      },
    });
    if (selftest.message) {
      process.stderr.write(`${selftest.message}\n`);
      return 1;
    }
    process.stdout.write(`反证结论：${selftest.ok ? '全部翻红' : '有反证没翻红——判据失效'}\n`);
    if (!selftest.ok) return 1;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({
      counts: built.dataset.counts,
      candidate_universe: built.dataset.candidate_universe,
      skips: built.dataset.skips,
      checks: checkResult.checks,
      ok: checkResult.ok,
    }, null, 2)}\n`);
  }
  return checkResult.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 2;
  }
}
