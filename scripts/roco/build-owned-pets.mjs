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
//      不补、不改、不猜。全量 622 只里有 **542** 只在冻结目录里有 learnset（2026-09-28 甲案之前是 48），
//      另外 80 只的跳过原因逐只落在报告里（不是「大概没数据」这种话）。
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
  FROZEN_MAIN_SUPPORT,
  FROZEN_ROOT,
  FROZEN_SKILLS,
  GENERATED_AT,
  GROWTH_EFFECT_REASON,
  INSTANCE_TARGET,
  LICENCE_REF,
  MIN_OUTSIDE_LAYER,
  MAX_SAME_SPECIES_GROUPS,
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
  expectedBattleBuildUnknownFields,
  expectedInstanceUnknownFields,
  growthAttribute,
  instanceBuildHash,
  makeRng,
  mergeCanonicalLoadouts,
  sha256Hex,
} from './owned-pets-lib.mjs';
import {CHECK_NAMES, SELFTEST_MUTATIONS, criteriaReport, runChecks, runSelftest} from './verify-owned-pets.mjs';
// 「同种两个体差在哪」要按**个体层掷出来的值**算（数据集里 nature/talent 是 null，见下面那一段）。
// 走的是与页面**同一个**解析器，免得"产物说没差异、页面上两只明明不同"。
import {individualFromInstance} from '../../src/coach/individuals.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');

/** 等级取值：Demo 值，不是从冻结目录里查出来的游戏常量（那里面没有等级上限证据）。 */
// ⚠ 2026-09-27 **改钉**：原来是一串 Demo 等级 `[50…100]`，但**等级上限是 60**（官方口径 + 人类
// 「pvp 没有的话就默认都 60 级别吧」）⇒ 60 以上的等级在游戏里**不可能存在**，页面上还显示着 Lv.95/100。
// 这些个体本来就是**建模的示例数据**（不是玩家存档）⇒ 一律取 **60**（默认档）。旧的取值留在这里当记录。
const LEVELS = Object.freeze([60]);
const LEVELS_PREVIOUS_RECORD = Object.freeze([50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]);
const GENERATOR = 'scripts/roco/build-owned-pets.mjs';

// ── 读盘小工具（只读，不改任何输入） ────────────────────────────────────────

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

function shaOf(root, path) {
  return createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
}

// 2026-09-25：这里原来有一个 `shuffle(rng, list)`（Fisher-Yates）—— 它只服务
// 「从 native_skills 里随机抽四个技能」那条路。配招改成**引擎 loadout** 之后没有任何调用点，
// 按死代码删掉（判据在 `tests/roco-owned-pets.test.js`：配招必须逐位等于引擎 loadout）。

// ── 候选宇宙 ────────────────────────────────────────────────────────────────

/**
 * 把 622 只 pack 精灵逐只过一遍，能用的留下、不能用的记下**为什么**。
 *
 * 「候选宇宙 600+」不是口号：这里真的从 622 条记录出发，
 * 而不是从一个写死的白名单出发。542 是**结果**（有冻结 learnset 的那批 = 可玩层），
 * 不是**输入**。
 */
function collectCandidates(root) {
  const mainLearnsets = readJson(root, FROZEN_MAIN_LEARNSETS);
  const layerLearnsets = readJson(root, FROZEN_LAYER_LEARNSETS);
  const layerPets = readJson(root, FROZEN_LAYER_PETS);
  const mainSupport = readJson(root, FROZEN_MAIN_SUPPORT);
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
    FROZEN_MAIN_SUPPORT: shaOf(root, FROZEN_MAIN_SUPPORT),
    FROZEN_LAYER_SUPPORT: shaOf(root, FROZEN_LAYER_SUPPORT),
    FROZEN_FULL_CATALOG: shaOf(root, FROZEN_FULL_CATALOG),
    PACK_PATH: shaOf(root, PACK_PATH),
  };

  // ── 规范四技能 = 引擎 loadout（**唯一事实源**，2026-09-25 人类口径「配招这个你得修好」）──────
  // 合并规则与 `roco/src/roco_env/data.py:515-535` 逐条同义（见 owned-pets-lib 的
  // `mergeCanonicalLoadouts`）。**这里曾经是 `shuffle(rng, pool).slice(0,4)` 伪随机抽样** ——
  // 那让 owned 的四技能与引擎实战装上的四技能**逐只全不一致**（当时 48/48），是数据层的自相矛盾。
  const supportMatrices = [
    {label: 'support-matrix.json（基线 12）', doc: mainSupport,
      artifact_path: FROZEN_MAIN_SUPPORT, artifact_sha256: sources.FROZEN_MAIN_SUPPORT},
    {label: 'layer-playable-48/support-matrix.json（抓包可玩层 530）', doc: layerSupport,
      artifact_path: FROZEN_LAYER_SUPPORT, artifact_sha256: sources.FROZEN_LAYER_SUPPORT},
  ];
  const canonical = mergeCanonicalLoadouts(supportMatrices);
  if (canonical.problems.length) {
    throw new Error(`规范四技能合并失败（引擎 data.py:515-535 同款校验）：${canonical.problems.slice(0, 3).join(' | ')}`);
  }
  const supportSourceByPet = new Map();
  for (const source of supportMatrices) {
    (source.doc?.pets ?? []).forEach((entry, index) => {
      if (!(entry?.candidate_moveset?.skills ?? []).length) return;
      supportSourceByPet.set(entry.pet_id, {
        artifact_path: source.artifact_path,
        artifact_sha256: source.artifact_sha256,
        pointer: `pets[${index}].candidate_moveset.skills`,
      });
    });
  }

  const skipped = {
    no_frozen_learnset: [],
    insufficient_learnable_skills: [],
    no_blood_skills_in_learnset: [],
    no_canonical_moveset: [],
    canonical_moveset_unresolvable: [],
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
    // 规范四技能：**只认引擎 loadout**，没有就跳过（fail closed，绝不自己选一组出来）。
    const canonicalSkills = canonical.byPetId.get(petId) ?? null;
    const movesetSource = supportSourceByPet.get(petId) ?? null;
    if (!canonicalSkills || canonicalSkills.length !== 4 || !movesetSource) {
      skipped.no_canonical_moveset.push({
        species_id: petId,
        species_name: name,
        reason: 'no_canonical_moveset',
        note: '引擎 loadout（support-matrix / layer-playable-48）里没有这一只的 candidate_moveset',
      });
      return;
    }
    const unresolvable = canonicalSkills.filter((id) => !skillIds.has(id));
    if (unresolvable.length) {
      skipped.canonical_moveset_unresolvable.push({
        species_id: petId,
        species_name: name,
        reason: 'canonical_moveset_unresolvable',
        skill_ids: unresolvable,
        note: '引擎 loadout 里的技能在冻结 skills.json 里解析不了 —— 不删技能、不换技能去凑四个',
      });
      return;
    }
    // 2026-09-28（甲案）：overlay 那批的**最上游**是社区抓包。本层（`layer-playable-48`）是
    // 抓包派生层，每个 pet 记录里带着 `capture_file` / `capture_id`（见生成器
    // `scripts/roco/build-all-pets-engine-inputs.mjs`）⇒ 逐条把那一跳也写进 provenance，
    // 「出处指针指向真正来源」这条才算兑现（基线 12 只的值来自 wiki 快照，不带抓包指针）。
    const captureRow = layerPetIds.has(petId) ? (layerPets.pets?.[petId] ?? null) : null;
    const captureFile = typeof captureRow?.capture_file === 'string' ? captureRow.capture_file : null;
    candidates.push({
      petId,
      speciesName: name,
      tier: layerPetIds.has(petId) ? 'overlay' : 'baseline',
      capture: captureFile && existsSync(join(root, captureFile))
        ? {file: captureFile, sha256: shaOf(root, captureFile), capture_id: captureRow.capture_id ?? null}
        : null,
      learnsetPath: artifactPath === FROZEN_MAIN_LEARNSETS ? FROZEN_MAIN_LEARNSETS : FROZEN_LAYER_LEARNSETS,
      learnsetSha: artifactPath === FROZEN_MAIN_LEARNSETS
        ? sources.FROZEN_MAIN_LEARNSETS
        : sources.FROZEN_LAYER_LEARNSETS,
      pointer: `learnsets.${petId}`,
      usable,
      bloodSkills,
      canonicalSkills: [...canonicalSkills],
      movesetSource,
      catalogIndex: catalog.index,
      stats: catalog.pet.stats,
      packIndex: packEntry.index,
      effectiveForm: packEntry.entity.form_axis?.axis ?? 'BASE',
    });
  };

  // 主 learnsets.json（12 只，**不在** layer-playable-48 目录里）
  // 2026-09-28：旧值是 36 只 overlay（layer-playable-48 的迁移夹具），甲案之后是 530 只（抓包派生）。
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
 * 实例配比：**每个候选物种恰好 1 个个体**（人类 2026-09-24：「重复的删掉」）。
 * 以前这里会按确定性洗牌把 32 个物种提升为「2 个实例」凑到 80 —— 那批第二个个体
 * 在游戏里并不存在（是我们为了让「同种比较」有数据可演而造的），既违反「不编数据」，
 * 也让「我的精灵」出现同名两张卡。现在 `groupSize` 恒为 1，判据反向钉住
 * 「同种组数 == 0」（`MAX_SAME_SPECIES_GROUPS`）。
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
  // 一个人一只：不造第二个个体（见上面的说明）。
  const paired = new Set();
  const projected = candidates.length;
  if (projected !== INSTANCE_TARGET) {
    throw new Error(`候选物种 ${projected} 个 ≠ 期望实例数 ${INSTANCE_TARGET} 个：`
      + '实例数现在等于物种数（一人一只），对不上说明候选宇宙变了，判据要跟着改');
  }
  // ── 2026-09-28 甲案：盒子 = **可玩层镜像**（有牙的交叉判据，不是空判据）──────────
  // 人类逐字：「**所有精灵实装，这样就不需要我的精灵了，直接全筛选**」⇒ 甲案：盒子跟着扩到
  // 可玩层的物种数。下面三条把「542」这个数**钉在磁盘上**，谁少一只、谁多一只都报错退出：
  //   ① 冻结层物种数（基线 learnsets.json + layer-playable-48/learnsets.json）必须**恰好**
  //      等于 `INSTANCE_TARGET`；层改了而常量没改 ⇒ 这里先红，不会静默换个规模；
  //   ② 每个有冻结学招表的物种都必须是候选（`candidates.length === withFrozenLearnset`）；
  //   ③ 基线（**不在** layer-playable-48 目录里）那一档必须仍是 `MIN_OUTSIDE_LAYER` 只 ——
  //      这条防的是「盒子只从可玩层目录里抄」。
  const frozenSpecies = universe.withFrozenLearnset;
  if (frozenSpecies !== INSTANCE_TARGET) {
    throw new Error(`可玩层物种数 ${frozenSpecies} ≠ INSTANCE_TARGET ${INSTANCE_TARGET}：`
      + '层变了就得一起改这个常量（改钉规矩：旧值留在 owned-pets-lib.mjs 的注释里），不许静默改规模');
  }
  if (candidates.length !== frozenSpecies) {
    throw new Error(`候选物种 ${candidates.length} ≠ 有冻结学招表的物种 ${frozenSpecies}：`
      + '有 learnset 的物种一只都不许被静默跳过（跳过原因逐只列在 skipped 里，见报告）');
  }
  if (baseline.length !== MIN_OUTSIDE_LAYER) {
    throw new Error(`基线档（不在 layer-playable-48 目录里）应当恰好 ${MIN_OUTSIDE_LAYER} 只，实际 ${baseline.length} 只`);
  }

  const instances = [];
  const battleBuilds = [];
  let serial = 0;
  for (const candidate of candidates) {
    const groupSize = paired.has(candidate.petId) ? 2 : 1;
    let previousLevel = null;
    for (let k = 0; k < groupSize; k += 1) {
      serial += 1;
      const instanceId = `own-${String(serial).padStart(4, '0')}`;

      // 等级：**一律 60**（人类 2026-09-27 口径 + 官方上限 60）。原来靠"同种两个体等级不同"来区分个体 ——
      // 那条 Demo 设计随上限 60 一起作废：个体之间的区别现在由**性格与天分**承担（那两层本来就有）。
      let level = LEVELS[Math.floor(rng() * LEVELS.length) % LEVELS.length];
      if (previousLevel !== null && level === previousLevel) {
        level = LEVELS[(LEVELS.indexOf(level) + 1 + Math.floor(rng() * (LEVELS.length - 1))) % LEVELS.length];
      }

      // 四个技能 = **引擎 loadout**（顺序即技能位顺序；逐位，不是按集合）。
      // 2026-09-25 之前这里是 `shuffle(rng, pool).slice(0, 4)`：那是**伪随机抽样**，
      // 与引擎实战真正装上的四个技能 48/48 全不一致（集合级）—— 玩家在工坊选的那只，
      // 进对局后四个技能是另一套。现在唯一事实源是 support-matrix / layer 的
      // `candidate_moveset`（`Ruleset.candidate_moveset()` 读的就是它）。
      const skills = [...candidate.canonicalSkills];

      // 血脉：只有**真的带血脉名**的行才能当标签用。layer-playable-48 的 overlay 里
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
        // 这四技能**从哪来**：引擎 loadout 的那一片 support-matrix（基线 12 走主文件、
        // 可玩层走 layer-playable-48）里的 `candidate_moveset.skills`。
        skills_source: {
          artifact_path: candidate.movesetSource.artifact_path,
          artifact_sha256: candidate.movesetSource.artifact_sha256,
          pointer: candidate.movesetSource.pointer,
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
            artifact_path: candidate.movesetSource.artifact_path,
            artifact_sha256: candidate.movesetSource.artifact_sha256,
            pointer: candidate.movesetSource.pointer,
            note: '规范四技能的**选择**出处（引擎 loadout；confidence=ENGINE_HYPOTHESIS，'
              + '台账 23 条里没有配招主题 ⇒ 这一份是工程启发式，不是游戏真实配招）',
          },
          {
            source_id: LICENCE_REF,
            source_scope: 'frozen_l1',
            artifact_path: candidate.learnsetPath,
            artifact_sha256: candidate.learnsetSha,
            pointer: candidate.pointer,
            note: '四个技能的**合法性**出处（该物种学习表：native + blood + stones —— '
              + '与引擎 `Ruleset.is_learnable` 的 `all_skill_ids` 同一口径）',
          },
          {
            source_id: LICENCE_REF,
            source_scope: 'frozen_l1',
            artifact_path: FROZEN_FULL_CATALOG,
            artifact_sha256: sources.FROZEN_FULL_CATALOG,
            pointer: `pets[${candidate.catalogIndex}].stats`,
            note: '静态种族值出处（不是等级换算后的面板值）',
          },
          // 2026-09-28（甲案）：overlay 那批多一条**最上游**的出处 —— 抓包原始响应的那一份文件。
          // 没有它，「四个技能从哪来」只能追到 `layer-playable-48/support-matrix.json`（中间层），
          // 追不到抓包本身。`source_id` 用抓包自己的 id（不是 `licence_ref`：抓包不在
          // `data/roco/sources.yaml` 的登记来源里，许可未确认 ⇒ 标 REFERENCE_ONLY，C14 也会跳过它）。
          ...(candidate.capture ? [{
            source_id: 'hke-2026-09-27',
            source_scope: 'capture_reference_only',
            artifact_path: candidate.capture.file,
            artifact_sha256: candidate.capture.sha256,
            pointer: 'result.pet_detail.skill_list',
            note: '四技能与技能池的**最上游**：小黑盒社区接口抓包（2026-09-27，许可 UNKNOWN / '
              + 'REFERENCE_ONLY，**不是官方文本**）。它经 `layer-playable-48/{support-matrix,learnsets}.json` '
              + '落进冻结层；本条是逐只可追的那一跳。',
          }] : []),
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
    }
  }

  // ── 演示用的同种第二个个体：**2026-09-28 回收掉了** ─────────────────────────
  //
  // 当初为什么要它：`compareOwnedPets()` 那条路要**同种**才有意义，而"一人一只"之后
  // 真实数据里没有同种对 ⇒ 只能靠判据夹具验、真机永远验不到（§C6.331 抓出的那个错）。
  //
  // 人类 2026-09-28 逐字（这一轮）：「**重复精灵不要了，把铠甲虫还原回来**」+「每种精灵只允许有一只」，
  // 并且在此之前已经先说了「加入比较不是删了吗？」⇒ **它存在的理由（同种比较）整个没有了**。
  // 于是按当初就在 `data/roco/human-decisions.json` 里写好的 rollback 执行：
  //   删掉 own-0049 + 它的 synthetic_demo provenance，把 `MAX_SAME_SPECIES_GROUPS` 调回 0。
  // ⚠ 这一段的删除本身也记进 human-decisions（`2026-09-28-remove-same-species-demo-pair`），
  // 免得下一个人看到"没有同种对"又去造一对。

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
    // ⚠ 两个口径都要：
    //   · `compareOwnedPets` 比的是**数据集原始字段** —— 而数据集里 `nature.value`/`talent.value`
    //     是 null（静态数据没有这两项），所以它恒判"无差异"，那是**数据集层面**的实话；
    //   · 真正决定"这两个个体能不能比出高低"的是**个体层掷出来的值**（`individualFromInstance`
    //     按 instance_id 种子化掷点）⇒ 用它算这一项。
    const comparison = compareOwnedPets(group[0], group[1]);
    const rolled = group.slice(0, 2).map((one) => {
      const row = individualFromInstance(one, {level: one.level ?? 60});
      return `${row.nature}|${JSON.stringify(row.talent)}`;
    });
    if (rolled[0] !== rolled[1] || comparison.differs_in_at_least_one_attribute) {
      counts.same_species_groups_with_difference += 1;
    }
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
        note: 'layer-playable-48（抓包可玩层 530 只）的 learnset',
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
    // 2026-09-28 改钉（**旧值不删**）：这一块原来是「可出战子集恰好等于 roster-48（48 只）」的
    // 自我限制声明，三条旧值分别是 `buildable_subset_equals_roster_48`、`proves_600_buildable: false`、
    // `must_not_claim: '不得把本批 80 个实例说成「600+ 都能出战」'`。
    // 甲案（人类：「所有精灵实装，这样就不需要我的精灵了，直接全筛选」）之后，可出战子集
    // **就是可玩层**（542 只：基线 12 + 抓包派生的 530），不再等于 roster-48。
    // 判据没有放宽成空话，而是换成**三条逐项可算**的：
    //   ① 可出战子集 == 有冻结学招表的物种数（instance 的 species 去重后一个不少）；
    //   ② 它**仍然不等于**全量 pack（622）：还有 80 只没有冻结学招表 ⇒ `proves_600_buildable` 仍是 false；
    //   ③ roster-48 的 48 只是它的**真子集**（旧口径是相等 —— 那是 48 时代的事）。
    buildability_ceiling: (() => {
      const builtSpecies = new Set(dataset.instances.map((i) => i.species_id));
      const packSpecies = dataset.candidate_universe.pack_pet_entities;
      const withLearnset = dataset.candidate_universe.with_frozen_learnset;
      return {
        candidate_universe_species: packSpecies,
        species_with_frozen_learnset: withLearnset,
        candidates_without_frozen_learnset: packSpecies - withLearnset,
        buildable_subset_size: builtSpecies.size,
        buildable_subset_equals_frozen_layer: builtSpecies.size === withLearnset,
        buildable_subset_equals_pack: builtSpecies.size === packSpecies,
        // 旧字段名保留（**旧值是 `true`**：48 时代可出战子集恰好 == roster-48）：现在它是 `false`，
        // 而且**必须**是 false —— 可出战子集已经扩到 542，roster-48 只有 48 只。
        // 下游（`tests/roco-v3-redirect.test.js` 的诚实条款）读的就是这个键，所以改值不改名。
        buildable_subset_equals_roster_48: builtSpecies.size === roster48.size
          && [...builtSpecies].every((id) => roster48.has(id)),
        roster_48_subset_of_buildable: {
          is_subset: [...roster48].every((id) => builtSpecies.has(id)),
          roster_48_species: roster48.size,
          buildable_species: builtSpecies.size,
          missing_from_buildable: [...roster48].filter((id) => !builtSpecies.has(id)).sort(),
          note: 'roster-48.json 是 M1 的**选择登记层**；它里面有 7 只（古啦多/学院呱呱/祭礼巨像/'
            + '棋契陛下×2/新月鹭/智辉章脑）已不在冻结可玩层里（3 只被人类点名剔除、4 只抓包接口给不出来），'
            + '所以它**不是**可出战子集的子集 —— 这是实况，不修数字。',
        },
        proves_600_buildable: false,
        why_not: `冻结目录导入的是 ${withLearnset} 份 learnset（基线 12 + 抓包可玩层 ${withLearnset - 12}），`
          + `pack 的 ${packSpecies} 个候选里还有 ${packSpecies - withLearnset} 只在 no_frozen_learnset 上 fail closed 跳过。`
          + '所以可出战子集 = 可玩层（不是全量 622，也**不再**是 roster-48 那 48 只）。',
        needed_to_prove: '把剩下那些也导入冻结 learnset，或走 RC-402 的按需 Capability Compiler（那一档是 SIMULATABLE_UNVERIFIED）。',
        must_not_claim: `不得把本批 ${builtSpecies.size} 个实例说成「全量 ${packSpecies} 只都能出战」。`,
      };
    })(),
    outside_layer_playable_48: {
      criterion: 'C06',
      definition: '按任务文本点名的 layer-playable-48 目录算：不在 layer-playable-48/pets.json、layer-playable-48/learnsets.json、layer-playable-48/support-matrix.json 的 pet 集合里的 species',
      expected_min: MIN_OUTSIDE_LAYER,
      count: checkResult.facts.speciesOutsideLayerPlayable48,
      species: checkResult.facts.outsideLayerSpecies,
      what_this_proves: '这 12 只是**基线层**的 12 只（主 `learnsets.json`，在 layer-playable-48 目录之外）；'
        + '它们本来就在 roster-48.json 的 48 只之内。⚠ 2026-09-28（甲案）之后可出战子集已经**大于**'
        + 'roster-48（542 > 48），所以这条判据的作用回到它字面上的意思：**盒子不是只从可玩层目录里抄的**。',
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
      expected_max: MAX_SAME_SPECIES_GROUPS,
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
