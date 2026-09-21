#!/usr/bin/env node
// ── L1：全量图鉴（622 只）只读层 ───────────────────────────────────────────────
//
// 为什么单独成层：现在 `normalized/` 里那份 `pets.json` 只有 **12 只**（进引擎实现的那批），
// 而社群快照里其实有 **622 只**。第 46 轮审计的结论是 L1「全量图鉴检索」根本没交付
// （实测 12/622）。这个脚本把 622 只导入成**只读的图鉴层**：
//
//   · 它**只做检索**：能被查询（名字/属性/技能），但**不声称可模拟**——每只都带
//     `support: 'knowledge_only'` 与 `refused[]` 原因码。想升级到「可模拟」要走
//     L2/L3 的进入条件（4 个有证据的技能 + 无 fail-closed），那是另一层的事。
//   · **逐字段 provenance**：快照文件与 sha256 来自 `tmp/roco-full-catalog.json` 的
//     `sources`（导出自 `data/roco/raw/extracted/...`），每个字段组都指回它。
//   · **拿不到就写 unknown，不猜**：快照里没有的字段（例如特性/技能时序）显式列进
//     `unknown_fields`，而不是补一个默认值。这是本仓 fail-closed 纪律在数据层的写法。
//
// 输入：`tmp/roco-full-catalog.json`（由 `scripts/roco/export-full-catalog.mjs` 从原始
//      快照导出；tmp/ 在 gitignore 里，属于**本地审计输入**，不入库）。
// 输出：`data/roco/normalized/<ruleset>/full-catalog.json`
//
// 用法：
//   node scripts/roco/build-full-catalog.mjs            # 生成
//   node scripts/roco/build-full-catalog.mjs --verify   # 只读校验已生成的产物
//   node scripts/roco/build-full-catalog.mjs --selftest # 反证：缺字段/空目录必须被抓住

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const RULESET = 'roco-world-s4-2026-09-10';
const INPUT = join(ROOT, 'tmp', 'roco-full-catalog.json');
const OUT = join(ROOT, 'data', 'roco', 'normalized', RULESET, 'full-catalog.json');

/** 字段 → 它在快照里的出处（同一个来源文件，但分组记账，方便逐项核对）。 */
const FIELD_GROUPS = Object.freeze({
  identity: ['pet_id', 'name', 'title', 'game_id', 'number', 'class', 'stage'],
  types: ['types'],
  stats: ['stats'],
  release: ['release'],
  learnset: ['learnset_id', 'feature_skill_id'],
});

/**
 * 快照里**没有**的东西。这些不是"以后补"，而是这一层**必须显式承认**的空白：
 * 它们决定了 L1 只能叫「图鉴检索」，不能叫「可模拟」。
 */
const NOT_IN_SNAPSHOT = Object.freeze([
  'traits',            // 特性：快照只给 feature_skill_id（一个技能），没有特性名与效果
  'skill_timing',      // 技能时序/优先级：要做在线规划才需要，图鉴层没有
  'panel_formula',     // 面板值换算：社区快照只给种族值，换算见 data.py 的 PANEL_FORMULAS（未核验）
  'season_strength',   // 版本强势度：快照没有，属 R7 单一来源
]);

const REFUSED = Object.freeze({
  knowledge_only: 'R7 单一来源（rocom-wiki-data 社群快照）：可以作为**检索**结果，不能声称可模拟',
  no_traits: 'R4 特性未登记：快照没有特性数据，引擎侧特性表也只覆盖 12 条',
  not_in_engine: 'R1/R6 未进入可模拟层：只有 12 只（后来扩到 48 只）做了 4 技能与合法性校验',
});

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** 从快照里挑出这只精灵**真的有**的字段；缺的进 unknown_fields。 */
function petRow(raw, learnsets, provenance) {
  const unknown = [];
  const skills = raw.learnset_id ? (learnsets[raw.learnset_id]?.native ?? null) : null;
  if (!skills) unknown.push('learnset');
  for (const field of ['types', 'stats', 'release']) {
    const value = raw[field];
    if (value === undefined || value === null || (Array.isArray(value) && !value.length)) unknown.push(field);
  }
  unknown.push(...NOT_IN_SNAPSHOT);
  return {
    pet_id: raw.pet_id,
    name: raw.name ?? null,
    title: raw.title ?? null,
    number: raw.number ?? null,
    game_id: Number.isInteger(raw.game_id) ? raw.game_id : null,
    class: raw.class ?? null,
    stage: Number.isInteger(raw.stage) ? raw.stage : null,
    types: Array.isArray(raw.types) ? [...raw.types] : null,
    stats: raw.stats && typeof raw.stats === 'object' ? {...raw.stats} : null,
    release: raw.release && typeof raw.release === 'object' ? {...raw.release} : null,
    feature_skill_id: raw.feature_skill_id ?? null,
    learnable_skills: skills ? [...skills] : null,
    learnable_count: skills ? skills.length : 0,
    // 这一层的**唯一**声称：可检索。可模拟要看 L2/L3 的进入条件。
    support: 'knowledge_only',
    unknown_fields: unknown,
    refused: [REFUSED.knowledge_only, REFUSED.no_traits, REFUSED.not_in_engine],
    provenance,
  };
}

function build() {
  if (!existsSync(INPUT)) {
    throw new Error(`缺本地审计输入 ${INPUT}：先跑 node scripts/roco/export-full-catalog.mjs`);
  }
  const raw = readFileSync(INPUT, 'utf8');
  const snapshot = JSON.parse(raw);
  const provenance = {
    source_id: 'rocom-wiki-data',
    snapshot: 'tmp/roco-full-catalog.json',
    snapshot_sha256: sha256(raw),
    upstream: snapshot.sources ?? null,
    ruleset_id: RULESET,
    note: '这是**社群快照**的导入，不是官方一手数据；每个字段都属于同一个来源（R7）。',
  };
  const pets = Object.values(snapshot.pets ?? {})
    .map((pet) => petRow(pet, snapshot.learnsets ?? {}, provenance))
    .sort((a, b) => String(a.pet_id).localeCompare(String(b.pet_id)));
  const missing = (field) => pets.filter((p) => p.unknown_fields.includes(field)).length;
  return {
    schema_version: 'roco-full-catalog/v1',
    ruleset_id: RULESET,
    game: 'roco_world_mobile',
    source_id: upstreamSourceId(),
    layer: 'L1-knowledge-only',
    generated_by: 'scripts/roco/build-full-catalog.mjs',
    claims: {
      is: ['全量图鉴检索：按名字/属性/可学技能查得到', `覆盖 ${pets.length} 只（含未进入引擎实现的那批）`],
      is_not: ['可模拟', '面板值为实测', '特性效果已知', '版本强势度'],
    },
    field_groups: FIELD_GROUPS,
    provenance,
    coverage: {
      pets_total: pets.length,
      with_types: pets.filter((p) => p.types).length,
      with_stats: pets.filter((p) => p.stats).length,
      with_learnset: pets.filter((p) => p.learnable_skills).length,
      learnsets_total: Object.keys(snapshot.learnsets ?? {}).length,
      unknown_by_field: Object.fromEntries(
        [...NOT_IN_SNAPSHOT, 'types', 'stats', 'release', 'learnset'].map((f) => [f, missing(f)])),
    },
    refused_reasons: REFUSED,
    pets,
  };
}

function verify(doc) {
  const problems = [];
  if (doc.layer !== 'L1-knowledge-only') problems.push(`layer 应为 L1-knowledge-only，实际 ${doc.layer}`);
  if (!Array.isArray(doc.pets) || doc.pets.length < 600) {
    problems.push(`pets 数应 ≥600（快照 622 只），实际 ${doc.pets?.length ?? 0}`);
  }
  for (const pet of doc.pets ?? []) {
    if (!pet.pet_id || !pet.name) problems.push(`条目缺 pet_id/name：${JSON.stringify(pet).slice(0, 80)}`);
    if (pet.support !== 'knowledge_only') problems.push(`${pet.pet_id} 的 support 不是 knowledge_only（这一层不许声称可模拟）`);
    if (!Array.isArray(pet.refused) || pet.refused.length < 2) problems.push(`${pet.pet_id} 缺 refused 原因`);
    if (!Array.isArray(pet.unknown_fields) || !pet.unknown_fields.length) {
      problems.push(`${pet.pet_id} 没有 unknown_fields——快照里不可能所有字段都有（traits 一定缺）`);
    }
    if (!pet.provenance?.snapshot_sha256) problems.push(`${pet.pet_id} 缺 provenance.snapshot_sha256`);
  }
  if (!doc.provenance?.upstream) problems.push('缺 upstream 来源（原始快照路径与 sha256）');
  if (doc.game !== 'roco_world_mobile') problems.push(`顶层 game 必须是 roco_world_mobile，实际 ${doc.game}`);
  if (!doc.source_id) problems.push('缺顶层 source_id：说不清这份数据从哪来');
  const share = doc.coverage?.pets_total ? doc.coverage.with_learnset / doc.coverage.pets_total : 0;
  if (share < 0.3) problems.push(`带学招表的比例只有 ${(share * 100).toFixed(0)}%——低于 30% 说明导入路径不对`);
  return problems;
}


/** 顶层 `source_id` 指向 `data/roco/sources.yaml` 里真实登记的来源（查清单，不写死）。 */
function upstreamSourceId() {
  const text = readFileSync(join(ROOT, 'data', 'roco', 'sources.yaml'), 'utf8');
  const ids = [...text.matchAll(/-\s*source_id:\s*([\w.-]+)/g)].map((m) => m[1]);
  if (!ids.length) throw new Error('data/roco/sources.yaml 里没有任何 source_id');
  return ids.find((id) => /rocom|wiki/i.test(id)) ?? ids[0];
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    // 反证：把产物改坏，verify 必须抓到（否则这条守卫是空的）。
    const good = build();
    const cases = [
      ['把 layer 改成可模拟', {...good, layer: 'L2-simulable'}],
      ['删掉一只的 unknown_fields', {...good, pets: good.pets.map((p, i) => (i === 0 ? {...p, unknown_fields: []} : p))}],
      ['删掉 provenance', {...good, provenance: {}}],
      ['把 pets 砍到 12 只', {...good, pets: good.pets.slice(0, 12)}],
    ];
    let ok = 0;
    for (const [name, mutated] of cases) {
      const problems = verify(mutated);
      if (problems.length) { ok += 1; console.log(`[selftest] 抓住：${name} → ${problems[0]}`); }
      else console.log(`[selftest] ✖ 没抓住：${name}`);
    }
    // 正向：真产物必须过
    const real = verify(good);
    if (real.length) { console.log('[selftest] ✖ 正产物没过：', real.slice(0, 2)); process.exit(1); }
    console.log(`[selftest] ${ok}/${cases.length} 个破坏被抓到；正产物通过`);
    process.exit(ok === cases.length ? 0 : 1);
  }

  if (args.includes('--verify')) {
    if (!existsSync(OUT)) { console.error(`缺产物 ${OUT}`); process.exit(1); }
    const doc = JSON.parse(readFileSync(OUT, 'utf8'));
    const problems = verify(doc);
    if (problems.length) { console.error('校验失败：\n  ' + problems.slice(0, 8).join('\n  ')); process.exit(1); }
    console.log(`OK full-catalog：${doc.pets.length} 只，unknown 分布 ${JSON.stringify(doc.coverage.unknown_by_field)}`);
    return;
  }

  const doc = build();
  const problems = verify(doc);
  if (problems.length) { console.error('生成的内容没过自检：\n  ' + problems.slice(0, 8).join('\n  ')); process.exit(1); }
  mkdirSync(dirname(OUT), {recursive: true});
  writeFileSync(OUT, `${JSON.stringify(doc, null, 1)}\n`);
  console.log(`OK full-catalog → ${OUT.replace(`${ROOT}/`, '')}`);
  console.log(`   pets=${doc.coverage.pets_total} 带属性=${doc.coverage.with_types} 带面板=${doc.coverage.with_stats} 带学招表=${doc.coverage.with_learnset}`);
  console.log(`   unknown 分布=${JSON.stringify(doc.coverage.unknown_by_field)}`);
}

main();
