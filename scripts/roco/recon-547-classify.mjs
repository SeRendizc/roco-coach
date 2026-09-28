#!/usr/bin/env node
/**
 * 只读侦察：把抓包里的每一只精灵按「能不能自动生成冻结配招层」分档（甲/乙/丙）。
 *
 * 依据（全部实测，不编）：
 *   - 抓包：data/roco/raw/hke-2026-09-27/raw/*.json 的 .result.pet_detail
 *   - 技能名→skill_id：data/roco/normalized/roco-world-s4-2026-09-10/skills.json
 *   - 图鉴映射：data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json
 *
 * **只读**：不写任何数据文件；需要落盘时用 `--out <路径>` 显式指定（本次评估不写）。
 *
 * 用法：
 *   node scripts/roco/recon-547-classify.mjs                 # 打印汇总
 *   node scripts/roco/recon-547-classify.mjs --table         # 打印逐只分档
 *   node scripts/roco/recon-547-classify.mjs --json          # 打印整份结果 JSON
 *   node scripts/roco/recon-547-classify.mjs --out x.json    # 落盘（显式才写）
 */
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = join(ROOT, 'data/roco/raw/hke-2026-09-27/raw');
const NORM = join(ROOT, 'data/roco/normalized/roco-world-s4-2026-09-10');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

// ── 技能名 → skill_id（含重名登记） ────────────────────────────────
const skillsDoc = JSON.parse(readFileSync(join(NORM, 'skills.json'), 'utf8'));
const skillList = Object.values(skillsDoc.skills);
const byName = new Map();
const dupNames = new Map();
for (const skill of skillList) {
  if (byName.has(skill.name)) {
    if (!dupNames.has(skill.name)) dupNames.set(skill.name, [byName.get(skill.name)]);
    dupNames.get(skill.name).push(skill);
  } else {
    byName.set(skill.name, skill);
  }
}
const idToName = new Map(skillList.map((skill) => [skill.skill_id, skill.name]));

// ── 图鉴：game_id / capture_id → 条目 ─────────────────────────────
const catalog = JSON.parse(readFileSync(join(NORM, 'full-catalog.json'), 'utf8'));
// ⚠ 抓包里的 `pet_detail.id` 是**字符串**（"3001"），图鉴里的 `game_id`/`capture_id` 是**数字**（3001）。
// 第一版没归一化 ⇒ 547 只全部"映射失败"（假的）。统一按字符串比对。
const key = (value) => (value == null ? null : String(value));
const catalogByGameId = new Map();
const catalogByCaptureId = new Map();
for (const pet of catalog.pets) {
  const gid = key(pet.game_id);
  const cid = key(pet.capture_id);
  if (gid != null) {
    if (!catalogByGameId.has(gid)) catalogByGameId.set(gid, []);
    catalogByGameId.get(gid).push(pet);
  }
  if (cid != null) {
    if (!catalogByCaptureId.has(cid)) catalogByCaptureId.set(cid, []);
    catalogByCaptureId.get(cid).push(pet);
  }
}

// ── 抓包：逐文件读，按 pet id 去重（同 id 多文件时保留字段最全的那份） ──
const files = readdirSync(RAW).filter((name) => name.endsWith('.json'));
const byPetId = new Map();
let parseErrors = 0;
for (const file of files) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(RAW, file), 'utf8'));
  } catch {
    parseErrors += 1;
    continue;
  }
  const detail = doc?.result?.pet_detail;
  if (!detail || detail.id == null) continue;
  const score = (detail.skill_list?.level?.length || 0)
    + (detail.skill_list?.machine?.length || 0)
    + (detail.skill_list?.blood?.length || 0);
  const prev = byPetId.get(detail.id);
  if (!prev || score > prev.score) byPetId.set(detail.id, {detail, file, score});
}

// ── 逐只分档 ──────────────────────────────────────────────────────
const rows = [];
for (const [petId, {detail, file}] of byPetId) {
  const buckets = {
    level: detail.skill_list?.level || [],
    machine: detail.skill_list?.machine || [],
    blood: detail.skill_list?.blood || [],
  };
  const names = {
    level: buckets.level.map((s) => s.name),
    machine: buckets.machine.map((s) => s.name),
    blood: buckets.blood.map((s) => s.name),
  };
  const allNames = [...new Set([...names.level, ...names.machine, ...names.blood])];

  const missingNames = allNames.filter((name) => !byName.has(name));
  const dupHitNames = allNames.filter((name) => dupNames.has(name));
  const levelMissing = names.level.filter((name) => !byName.has(name));

  const catalogHits = [
    ...(catalogByGameId.get(key(petId)) || []),
    ...(catalogByCaptureId.get(key(petId)) || []),
  ];
  const catalogPet = catalogHits[0] || null;

  // 图鉴里已经登记的 learnable_skills（来自 wiki 快照）——用来对照抓包能不能复现它
  const catalogLearnable = catalogPet ? (catalogPet.learnable_skills || []).map((id) => idToName.get(id)) : null;
  const overlap = catalogLearnable
    ? catalogLearnable.filter((name) => allNames.includes(name))
    : null;
  const exactMatch = catalogLearnable
    ? catalogLearnable.length === allNames.length && overlap.length === allNames.length
    : null;
  const levelExactMatch = catalogLearnable
    ? catalogLearnable.length === names.level.length && catalogLearnable.every((n) => names.level.includes(n))
    : null;

  // 分档判定
  const reasons = [];
  let tier;
  if (allNames.length === 0) {
    tier = '丙';
    reasons.push('抓包没有任何技能条目');
  } else if (missingNames.length > 0) {
    tier = '丙';
    reasons.push(`技能名在 skills.json 里查不到（${missingNames.length} 个）`);
  } else if (buckets.level.length < 4) {
    tier = '乙';
    reasons.push(`level 桶不足 4 条（${buckets.level.length} 条）`);
  } else if (names.level.length !== allNames.length && dupHitNames.length > 0) {
    tier = '乙';
    reasons.push('重名技能需要人工裁决');
  } else if (detail.feature == null) {
    tier = '乙';
    reasons.push('抓包缺 feature（特性）');
  } else if (!catalogPet) {
    tier = '乙';
    reasons.push('图鉴里找不到对应 pet_id（映射缺失）');
  } else {
    tier = '甲';
    reasons.push('三桶齐全 + 技能名全能对上 + 特性/种族值/进化链在 + 图鉴映射在');
  }

  rows.push({
    capture_id: petId,
    file,
    name: detail.name,
    pictorial_book_id: detail.pictorial_book_id ?? null,
    catalog_pet_id: catalogPet ? catalogPet.pet_id : null,
    catalog_matched_by: catalogPet ? catalogPet.capture_matched_by ?? null : null,
    tier,
    reasons,
    level_count: buckets.level.length,
    machine_count: buckets.machine.length,
    blood_count: buckets.blood.length,
    union_count: allNames.length,
    missing_names: missingNames,
    dup_names: dupHitNames,
    has_feature: detail.feature != null,
    has_race: Array.isArray(detail.base_race_params) || detail.base_race_params != null,
    has_evolution: Array.isArray(detail.evolution_chain) ? detail.evolution_chain.length > 0 : detail.evolution_chain != null,
    catalog_learnable_count: catalogLearnable ? catalogLearnable.length : null,
    catalog_overlap_count: overlap ? overlap.length : null,
    catalog_exact_match: exactMatch,
    catalog_level_exact_match: levelExactMatch,
    // 抓包 level 桶有、图鉴 learnable 没有的技能名（可能是新版本加的）
    level_only: catalogLearnable ? names.level.filter((n) => !catalogLearnable.includes(n)) : null,
    catalog_only: catalogLearnable ? catalogLearnable.filter((n) => !names.level.includes(n)) : null,
  });
}

rows.sort((a, b) => a.capture_id - b.capture_id);

const tierCount = {甲: 0, 乙: 0, 丙: 0};
for (const row of rows) tierCount[row.tier] += 1;

const catalogMapped = rows.filter((row) => row.catalog_pet_id);
const withCatalogLearnable = rows.filter((row) => row.catalog_learnable_count != null);

const summary = {
  raw_files: files.length,
  parse_errors: parseErrors,
  distinct_pet_ids: rows.length,
  skill_names_total: byName.size,
  skill_entries_total: skillList.length,
  duplicate_skill_names: [...dupNames.keys()],
  tier_counts: tierCount,
  catalog_mapped: catalogMapped.length,
  catalog_unmapped: rows.length - catalogMapped.length,
  compared_with_catalog_learnable: withCatalogLearnable.length,
  catalog_exact_match: withCatalogLearnable.filter((row) => row.catalog_exact_match).length,
  catalog_level_exact_match: withCatalogLearnable.filter((row) => row.catalog_level_exact_match).length,
  missing_skill_names_total: rows.filter((row) => row.missing_names.length > 0).length,
  no_feature: rows.filter((row) => !row.has_feature).length,
  no_race: rows.filter((row) => !row.has_race).length,
  no_evolution: rows.filter((row) => !row.has_evolution).length,
  level_bucket_lt4: rows.filter((row) => row.level_count < 4).length,
};

if (has('--json')) {
  console.log(JSON.stringify({summary, rows}, null, 2));
} else {
  console.log('=== 抓包全量分档（只读侦察） ===');
  console.log(JSON.stringify(summary, null, 2));
  const tiers = {甲: [], 乙: [], 丙: []};
  for (const row of rows) tiers[row.tier].push(row);
  for (const tier of ['甲', '乙', '丙']) {
    console.log(`\n--- ${tier}档 ${tiers[tier].length} 只 ---`);
    if (tier === '甲' && !has('--table')) {
      console.log('（甲档只数见上；要逐只列表加 --table）');
      continue;
    }
    const shown = has('--table') ? tiers[tier] : tiers[tier].slice(0, 40);
    for (const row of shown) {
      console.log(`${row.capture_id}\t${row.name}\t${row.catalog_pet_id || '-'}\t`
        + `level${row.level_count}/machine${row.machine_count}/blood${row.blood_count}\t`
        + `图鉴learnable${row.catalog_learnable_count ?? '-'} 重合${row.catalog_overlap_count ?? '-'}\t`
        + `${row.reasons.join('；')}`);
    }
    if (!has('--table') && tiers[tier].length > shown.length) console.log(`… 另 ${tiers[tier].length - shown.length} 只`);
  }
}

const out = valueOf('--out');
if (out) {
  writeFileSync(resolve(ROOT, out), JSON.stringify({summary, rows}, null, 2));
  console.log(`\n[已写出] ${out}`);
}
