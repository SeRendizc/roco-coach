// RC-202 GameDataPackV2（统一索引包）的守卫。
//
// 为什么这一组必须存在
// --------------------
// 「把冻结目录 + 公网对账 + 来源台账合成一个包」这件事，最省事的做法有三种，
// 三种都**不会红**：
//   ① 把冻结层的大块数值抄进包里 —— 于是同一份事实有了第三个副本，三份各自漂移；
//   ② 把 REFERENCE_ONLY 来源的内容混进可分发分节 —— 包的形状看起来完全正常；
//   ③ 冲突没解决就把状态写成 ready —— 报告里那几个字没人会去核对。
// 所以这里钉六件事，每条都有**必红方向**（构造一个违规样本，看判据会不会翻红）：
//   ① 抽掉某实体 provenance ⇒ 红；
//   ② artifact_sha256 对不上磁盘 ⇒ 红（登记表一起改坏，只有磁盘判据能抓）；
//   ③ licence_ref 在 sources.yaml 里查不到 ⇒ 红；
//   ④ REFERENCE_ONLY 混进 distributable ⇒ 红；
//   ⑤ 有值的字段被标进 unknown_fields ⇒ 红；
//   ⑥ 冲突未解决却把就绪标成 ready ⇒ 红。
//
// 判据全部复用 scripts/roco/verify-game-data-pack.mjs 里的真实实现——与
// `--selftest` 跑同一份代码（两份判据各写一遍就会各自漂移）。
//
// 用法：`node --test tests/roco-game-data-pack.test.js`

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

import {SUITES as RELEASE_GATE_SUITES} from '../scripts/roco/verify-release.mjs';
import {releaseGateSatisfied,
  PACK_PATH,
  READINESS_PATH,
  SCHEMA_PATH,
  RECORD_KIND_ENUM,
  FORM_AXES,
  READINESS_ITEMS,
  buildPack,
  buildSchema,
} from '../scripts/roco/build-game-data-pack.mjs';
import {
  createCaches,
  evaluateReadiness,
  resolvePointer,
  runChecks,
} from '../scripts/roco/verify-game-data-pack.mjs';

const log = (...args) => console.log('  ·', ...args);

/** 真产物：磁盘上的包。测试**不许**用内存里现造的包替代它。 */
const packText = readFileSync(PACK_PATH, 'utf8');
const pack = JSON.parse(packText);
const schemaText = readFileSync(SCHEMA_PATH, 'utf8');
const schema = JSON.parse(schemaText);
const reportText = readFileSync(READINESS_PATH, 'utf8');
const report = JSON.parse(reportText);
const entities = [...pack.sections.distributable.entities, ...pack.sections.reference_only.entities];

const clone = () => JSON.parse(JSON.stringify(pack));
/** 一次反证跑十几遍 runChecks：只读磁盘，所以复用同一份缓存是安全的（也不改磁盘）。 */
const caches = createCaches();
const judge = (doc) => runChecks(doc, {schema, caches});

/** 打印实际报错原文，报告里要贴。 */
function show(problems, limit = 2) {
  return problems.slice(0, limit).join(' | ');
}

// ─────────────────────────────────────────────────────────────────────────
// 0. 真产物：1446 条实体全部合规，且**只做索引**
// ─────────────────────────────────────────────────────────────────────────

test('真产物：1446 条实体全部过判据（17 组），逐条给 provenance 与 licence_ref', () => {
  const result = judge(pack);
  log('[实际] 实体 =', result.facts.entityCount, '；provenance 条目 =', result.facts.provenanceEntries);
  log('[实际] 分组 =', JSON.stringify(pack.metadata.entity_counts.by_record_kind));
  log('[实际] 分节 =', JSON.stringify(pack.metadata.entity_counts.by_section));
  log('[实际] 判据 =', result.checks.map((c) => `${c.check}:${c.ok ? 'ok' : `✖${c.problems}`}`).join(' '));
  log('[实际] 问题 =', show(result.problems) || '(无)');
  assert.deepEqual(result.problems, [], '真产物必须过全部判据');
  assert.equal(result.facts.entityCount, 1446, `实体数应当是 1446（622 精灵 + 824 技能），实际 ${result.facts.entityCount}`);
  assert.equal(result.facts.artifactShaMismatches, 0);
  assert.equal(result.facts.orphanReferences, 0);
  for (const entity of entities) {
    assert.ok(entity.provenance.length >= 1, `${entity.entity_key} 缺 provenance`);
    assert.ok(entity.licence_ref, `${entity.entity_key} 缺 licence_ref`);
    assert.ok(entity.source_scope, `${entity.entity_key} 缺 source_scope`);
    assert.ok(entity.entity_key === `${entity.group}::${entity.id}`, `${entity.entity_key} 的身份键不对`);
  }
  assert.equal(result.checks.length, 17, `判据组应当是 17 组，实际 ${result.checks.length}`);
});

test('真产物：只做索引——大块数值一律只给 refs，不抄进包', () => {
  const valueKeys = ['stats', 'learnable_skills', 'desc', 'power', 'energy', 'damage_class', 'flavor'];
  const indexKeys = new Set(['number', 'game_id', 'class', 'stage', 'types', 'category', 'element',
    'is_trait', 'form', 'season', 'type', 'tags', 'primary_type', 'secondary_type']);
  const offenders = [];
  for (const entity of entities) {
    for (const key of Object.keys(entity.tags ?? {})) {
      if (!indexKeys.has(key)) offenders.push(`${entity.entity_key}.tags.${key}`);
    }
    for (const key of Object.keys(entity.tags_live ?? {})) {
      if (!indexKeys.has(key)) offenders.push(`${entity.entity_key}.tags_live.${key}`);
    }
    for (const key of valueKeys) {
      if (Object.prototype.hasOwnProperty.call(entity, key)) offenders.push(`${entity.entity_key}.${key}`);
      if (Object.prototype.hasOwnProperty.call(entity.tags ?? {}, key)) offenders.push(`${entity.entity_key}.tags.${key}`);
    }
  }
  log('[实际] 抄进包的值字段 =', offenders.length, offenders.slice(0, 3).join(','));
  assert.deepEqual(offenders.slice(0, 5), [], '大字段只许给 refs 指针');
  const withStatsRef = entities.filter((e) => (e.refs ?? []).some((r) => r.field === 'stats'));
  const withLearnsetRef = entities.filter((e) => (e.refs ?? []).some((r) => r.field === 'learnable_skills'));
  log('[实际] 带 stats ref =', withStatsRef.length, '；带 learnable_skills ref =', withLearnsetRef.length);
  assert.equal(withStatsRef.length, 622, '622 只精灵都应当有 stats 指针');
  assert.ok(withLearnsetRef.length >= 600, `带学招表指针的应当 ≥600，实际 ${withLearnsetRef.length}`);
  // 指针真的指得到东西（不是写个好看的字符串）
  const catalog = JSON.parse(readFileSync('data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json', 'utf8'));
  const resolved = resolvePointer(catalog, withStatsRef[0].refs.find((r) => r.field === 'stats').pointer);
  assert.ok(resolved.found && resolved.value.atk !== undefined, 'stats 指针必须解析到真实对象');
});

// ─────────────────────────────────────────────────────────────────────────
// 1. schema：自描述契约
// ─────────────────────────────────────────────────────────────────────────

test('schema：record_kind enum 用 RC-201 那份词表，必填字段齐备', () => {
  const contract = schema['x-roco-contract'];
  log('[实际] record_kind_enum =', JSON.stringify(schema['x-roco-contract'].record_kind_enum));
  log('[实际] required_entity_fields =', JSON.stringify(contract.required_entity_fields));
  log('[实际] required_provenance_fields =', JSON.stringify(contract.required_provenance_fields));
  assert.deepEqual(contract.record_kind_enum, RECORD_KIND_ENUM);
  assert.deepEqual([...contract.record_kind_enum].sort(), ['battle_skill', 'pet_form', 'pet_record', 'trait_record']);
  for (const field of ['entity_key', 'record_kind', 'name', 'provenance', 'licence_ref', 'source_scope']) {
    assert.ok(contract.required_entity_fields.includes(field), `schema 少了必填字段 ${field}`);
  }
  assert.deepEqual(contract.required_provenance_fields, ['source_id', 'artifact_path', 'artifact_sha256', 'pointer']);
  assert.ok(contract.unknown_fields_allowlist.length > 0);
  assert.deepEqual(schema.properties.contract.required, ['contains', 'does_not_contain'],
    '契约级 contains / does_not_contain 必须是 schema 的必填');
  assert.ok(pack.contract.contains.length > 0);
  assert.ok(pack.contract.does_not_contain.some((row) => (row.fields ?? []).includes('stats')), 'does_not_contain 必须写清公网索引页没有种族值');
  // 磁盘上的 schema.json 与「现在重建」逐字节相同（契约不许漂移）
  assert.equal(schemaText, `${JSON.stringify(buildSchema(), null, 1)}\n`, 'schema.json 与重建结果不一致');
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 冲突与形态轴：RC-201 的 4 条 unresolved 与 61 组同名不同 id 逐条落条
// ─────────────────────────────────────────────────────────────────────────

test('冲突：4 条未解决 + 61 组同名不同 id + 34 条形态口径，逐条带证据；未解决即拒绝 ready', () => {
  const rc201 = JSON.parse(readFileSync('reports/roco/reconciliation/catalog-reconciliation.json', 'utf8'));
  const byClass = {};
  for (const item of pack.conflicts.items) byClass[item.class] = (byClass[item.class] ?? 0) + 1;
  log('[实际] conflicts =', JSON.stringify(byClass), '；total =', pack.conflicts.total, '；unresolved =', pack.conflicts.unresolved);
  log('[实际] 未解决条目 =', pack.conflicts.items.filter((i) => i.status === 'UNRESOLVED').map((i) => i.entity_keys[0]).join(','));
  assert.equal(pack.conflicts.unresolved, rc201.buckets.unresolved.length, '未解决冲突必须与 RC-201 unresolved 逐条对齐');
  assert.equal(byClass.GRANULARITY_CONFLICT, rc201.convention_notes.count);
  assert.equal(pack.conflicts.items.filter((i) => i.class === 'IDENTITY_CONFLICT' && i.status === 'RESOLVED_BY_POLICY').length,
    rc201.name_collision_diagnostics.count);
  assert.deepEqual(Object.keys(pack.conflicts.classes).sort(),
    ['GRANULARITY_CONFLICT', 'IDENTITY_CONFLICT', 'VALUE_CONFLICT']);
  for (const item of pack.conflicts.items) {
    assert.ok(item.evidence.length > 0, `${item.conflict_id} 没有证据`);
    assert.ok(item.reason && item.reason.length > 5, `${item.conflict_id} 没有写原因`);
  }
  // VALUE_CONFLICT = 0 是「没比过」，必须在分类说明里写清楚，不许当作「没有差异」
  log('[实际] VALUE_CONFLICT 说明 =', pack.conflicts.classes.VALUE_CONFLICT.slice(0, 40), '…');
  assert.match(pack.conflicts.classes.VALUE_CONFLICT, /不是"没有差异"，是"没比过"|没比过/);
  // 未解决冲突 ⇒ 状态必须是 draft
  assert.equal(pack.readiness.conflict_gate, 'BLOCKED_UNRESOLVED_CONFLICTS');
  assert.equal(pack.readiness.game_data_pack_v2_status, 'draft');
  // 形态轴：34 条 convention_notes 逐条落表，轴都在词表内
  const divergence = pack.form_axis.assignments.filter((a) => a.divergence);
  log('[实际] form_axis.counts =', JSON.stringify(pack.form_axis.counts), '；divergence =', divergence.length);
  assert.equal(divergence.length, rc201.convention_notes.count);
  assert.deepEqual(divergence.map((a) => a.entity_key.split('::')[1]).sort(),
    rc201.convention_notes.items.map((n) => n.id).sort());
  assert.equal(pack.form_axis.counts.UNMAPPED, pack.form_axis.assignments.filter((a) => a.axis === 'UNMAPPED').length);
  for (const assignment of pack.form_axis.assignments) {
    assert.ok(FORM_AXES.includes(assignment.axis), `形态轴 ${assignment.axis} 不在词表里`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 覆盖证明：能比的只有 id / 名字 / 编号 / 属性标签
// ─────────────────────────────────────────────────────────────────────────

test('覆盖矩阵：可比字段只许是 id/名字/编号/属性标签，其余逐条给出「公网索引页没有」', () => {
  const comparable = pack.field_coverage_matrix.rows.filter((r) => r.comparable).map((r) => `${r.group}.${r.field}`);
  const lacks = pack.field_coverage_matrix.rows.filter((r) => r.verdict === 'NOT_COMPARABLE_PUBLIC_INDEX_LACKS_FIELD');
  log('[实际] 可比字段 =', comparable.join(', '));
  log('[实际] 「公网索引页没有」字段 =', lacks.map((r) => `${r.group}.${r.field}`).join(', '));
  log('[实际] pet.type 逐条 =', JSON.stringify(pack.field_coverage_matrix.rows.find((r) => r.group === 'pet' && r.field === 'type')));
  assert.deepEqual([...comparable].sort(), [
    'battle_skill.element', 'battle_skill.id', 'battle_skill.name',
    'pet.id', 'pet.name', 'pet.number', 'pet.type',
    'trait.id', 'trait.name',
  ]);
  for (const row of pack.field_coverage_matrix.rows) {
    if (row.comparable) assert.equal(row.equal, row.matched_entities, `${row.group}.${row.field} 的可比声明与逐条相等数对不上`);
    else assert.ok(row.reason && row.reason.length > 4, `${row.group}.${row.field} 没写不可比原因`);
  }
  for (const field of ['stats', 'learnset', 'power', 'desc', 'energy', 'damage_class']) {
    assert.ok(lacks.some((r) => r.field === field), `${field} 应当被判为「公网索引页没有」`);
  }
  assert.match(pack.field_coverage_matrix.note, /不是「数值一致」/);
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 就绪判定与报告：9 项逐条给证据，status=draft 且说清还缺哪几项
// ─────────────────────────────────────────────────────────────────────────

test('就绪：9 项逐条 satisfied + 证据；只有全 satisfied 才允许 ready', () => {
  log('[实际] status =', report.game_data_pack_v2_status, '；satisfied =', `${report.satisfied_count}/${report.total_items}`);
  for (const item of report.items) {
    log(`[实际] §9-${item.id} ${item.key}: satisfied=${item.satisfied}`
      + `${item.owner ? ` owner=${item.owner}` : ''} 证据=${item.evidence.map((e) => e.check).join('+')}`);
  }
  log('[实际] blocking =', report.blocking.map((b) => b.key ?? b.kind).join(', '));
  assert.equal(report.items.length, READINESS_ITEMS.length);
  assert.equal(report.items.length, 9);
  assert.equal(report.game_data_pack_v2_status, 'draft');
  assert.equal(report.satisfied_count, report.items.filter((i) => i.satisfied).length);
  const item6 = report.items.find((i) => i.id === 6);
  const item9 = report.items.find((i) => i.id === 9);
  assert.equal(item6.satisfied, false, '第 6 项只能证明「公网索引页没有这些字段」，不能证明数值一致');
  assert.match(item6.note, /NOT_COMPARABLE|数值一致/);
  // 第 9 项在**主线程接线之后**变成 satisfied=true —— 它的判据现在是「闸门登记表里真的存在
  // 那两条套件」（`releaseGateSatisfied`），而不是「有人声明会接线」。所以这里不再断言它是 false，
  // 而是断言它**与登记表一致**，并用登记表做反向控制（抽掉套件 → 必须 false）。
  const gate = releaseGateSatisfied({suites: RELEASE_GATE_SUITES,
    requires: READINESS_ITEMS.find((d) => d.id === 9).requires_suites});
  assert.equal(item9.satisfied, gate.satisfied,
    `第 9 项必须与闸门登记表一致：报告=${item9.satisfied} 登记表=${gate.satisfied}（缺 ${JSON.stringify(gate.missing)}）`);
  assert.equal(gate.satisfied, true, `闸门里缺少套件：${JSON.stringify(gate.missing)}`);
  assert.equal(item9.owner, null, '接线完成后不再是「等主线程」的状态');
  assert.equal(item9.evidence[0].check, 'release_gate.registry');
  assert.ok(report.blocking.some((b) => b.id === 6), '第 6 项仍是不满足项');
  assert.ok(!report.blocking.some((b) => b.id === 9), '第 9 项接线后不该再出现在 blocking 里');
  // 反向控制：把 game-data-pack 从登记表里抽掉 → 这一项必须变 false
  assert.equal(releaseGateSatisfied({suites: RELEASE_GATE_SUITES.filter((x) => x.id !== 'game-data-pack'),
    requires: ['reconciliation', 'game-data-pack']}).satisfied, false);
  assert.ok(report.blocking.some((b) => b.kind === 'unresolved_conflicts' && b.count === 4));
  // 报告必须与「现在重算」一致（声明与重算是同一件事的两个读者）
  const run = judge(pack);
  const readiness = evaluateReadiness(pack, {schema, facts: run.facts});
  assert.equal(readiness.game_data_pack_v2_status, report.game_data_pack_v2_status);
  assert.equal(readiness.satisfied_count, report.satisfied_count);
  assert.deepEqual(readiness.items.map((i) => [i.id, i.satisfied]), report.items.map((i) => [i.id, i.satisfied]));
  assert.equal(report.pack_sha256, createHash('sha256').update(Buffer.from(packText, 'utf8')).digest('hex'));
  assert.equal(report.pack_bytes, Buffer.byteLength(packText));
});

// ─────────────────────────────────────────────────────────────────────────
// 5. 可复跑：同输入两次运行逐字节相同，且与磁盘产物相同
// ─────────────────────────────────────────────────────────────────────────

test('可复跑：内存重建两次逐字节相同，并与磁盘上的 pack.json/schema.json 一致', () => {
  const first = `${JSON.stringify(buildPack(), null, 1)}\n`;
  const second = `${JSON.stringify(buildPack(), null, 1)}\n`;
  log('[实际] 两次重建 =', first === second ? '逐字节相同' : '不同',
    `；磁盘 pack.json ${packText.length} 字节 vs 重建 ${first.length} 字节`);
  assert.equal(first, second, '同输入两次运行必须逐字节相同（包内不许有挂钟时间戳）');
  assert.equal(first, packText, '磁盘 pack.json 必须等于「现在重建」的结果（--check 的判据）');
  assert.equal(`${JSON.stringify(buildSchema(), null, 1)}\n`, schemaText);
  assert.equal(pack.metadata.determinism.includes('--check'), true);
});

// ─────────────────────────────────────────────────────────────────────────
// 6. 必红反证（注入实测，不是声明）
// ─────────────────────────────────────────────────────────────────────────

test('反证① 抽掉某实体 provenance ⇒ 红', () => {
  const bad = clone();
  const victim = bad.sections.distributable.entities[0];
  victim.provenance = [];
  const problems = judge(bad).problems;
  log('[实际] rc =', problems.length ? 1 : 0, '；原文 =', show(problems));
  assert.ok(problems.length > 0, '抽掉 provenance 却没人报——这一层就没有守住了');
  assert.ok(problems.some((p) => p.includes(victim.entity_key) && p.includes('provenance')));
});

test('反证② artifact_sha256 对不上磁盘 ⇒ 红（登记表一起改坏，只有磁盘判据能抓）', () => {
  const bad = clone();
  const victim = bad.sections.distributable.entities.find((e) => e.group === 'battle_skill');
  const path = victim.provenance[0].artifact_path;
  bad.artifacts[path].sha256 = '0'.repeat(64);
  for (const entity of [...bad.sections.distributable.entities, ...bad.sections.reference_only.entities]) {
    for (const entry of entity.provenance) if (entry.artifact_path === path) entry.artifact_sha256 = '0'.repeat(64);
  }
  const problems = judge(bad).problems;
  log('[实际] rc =', problems.length ? 1 : 0, '；原文 =', show(problems, 1));
  assert.ok(problems.some((p) => p.includes('[artifacts_on_disk]') && p.includes('磁盘实际')),
    'sha256 与磁盘对不上却没人报');
  assert.ok(problems.some((p) => p.includes(path)));
});

test('反证③ licence_ref 在 sources.yaml 里查不到 ⇒ 红', () => {
  const bad = clone();
  const victim = bad.sections.distributable.entities[0];
  victim.licence_ref = 'not-a-registered-source';
  const problems = judge(bad).problems;
  log('[实际] rc =', problems.length ? 1 : 0, '；原文 =', show(problems, 1));
  assert.ok(problems.some((p) => p.includes('[licence_refs]') && p.includes('sources.yaml') && p.includes(victim.entity_key)),
    'licence_ref 查不到却没人报');
});

test('反证④ REFERENCE_ONLY 混进 distributable ⇒ 红', () => {
  const bad = clone();
  const victim = bad.sections.distributable.entities[0];
  victim.provenance = [{
    source_id: 'nrc-ai-sqlite', source_scope: 'frozen_l1',
    artifact_path: victim.provenance[0].artifact_path,
    artifact_sha256: victim.provenance[0].artifact_sha256,
    pointer: victim.provenance[0].pointer,
  }];
  const problems = judge(bad).problems;
  log('[实际] rc =', problems.length ? 1 : 0, '；原文 =', show(problems, 1));
  assert.ok(problems.some((p) => p.includes('[distribution_sections]') && p.includes('REFERENCE_ONLY') && p.includes('distributable')),
    'REFERENCE_ONLY 的来源混进可分发分节却没人报');
});

test('反证⑤ 有值的字段被标进 unknown_fields ⇒ 红（缺了却漏报也 ⇒ 红）', () => {
  const bad = clone();
  const victim = bad.sections.distributable.entities.find((e) => (e.refs ?? []).some((r) => r.field === 'stats'));
  victim.unknown_fields = [...victim.unknown_fields, 'stats'];
  const problems = judge(bad).problems;
  log('[实际] rc =', problems.length ? 1 : 0, '；原文 =', show(problems, 1));
  assert.ok(problems.some((p) => p.includes('[unknown_fields]') && p.includes(victim.entity_key) && p.includes('stats')),
    '有值却标 unknown 却没人报');

  const bad2 = clone();
  const victim2 = bad2.sections.distributable.entities.find((e) => e.unknown_fields.includes('traits'));
  victim2.unknown_fields = victim2.unknown_fields.filter((f) => f !== 'traits');
  const problems2 = judge(bad2).problems;
  log('[实际] 漏报方向 rc =', problems2.length ? 1 : 0, '；原文 =', show(problems2, 1));
  assert.ok(problems2.some((p) => p.includes('[unknown_fields]') && p.includes(victim2.entity_key) && p.includes('traits')),
    '缺了却漏报却没人报');
});

test('反证⑥ 冲突未解决却把就绪标成 ready ⇒ 红', () => {
  const bad = clone();
  bad.readiness.game_data_pack_v2_status = 'ready';
  bad.readiness.items = bad.readiness.items.map((i) => ({...i, satisfied: true}));
  bad.readiness.satisfied_count = bad.readiness.total_items;
  bad.readiness.blocking = [];
  const problems = judge(bad).problems;
  log('[实际] rc =', problems.length ? 1 : 0, '；原文 =', show(problems, 1));
  assert.ok(problems.some((p) => p.includes('未解决冲突') && p.includes('拒绝')),
    '冲突未解决却标 ready 却没人报——ready 就成了一个可以随便写的字');

  // 声明与重算不一致也要红（把已提交报告里的一项改成 satisfied=true）
  const bad2 = clone();
  const item3 = bad2.readiness.items.find((i) => i.id === 3);
  item3.satisfied = !item3.satisfied;
  bad2.readiness.satisfied_count = bad2.readiness.items.filter((i) => i.satisfied).length;
  const result2 = judge(bad2);
  log('[实际] 声明与重算不一致 rc =', result2.problems.length ? 1 : 0);
  assert.ok(result2.problems.length > 0, '包内声明与重算不一致却没人报');
});

test('反证⑦ 指针指到不存在的下标 / 快照 STALE 却 ready ⇒ 红', () => {
  const badPointer = clone();
  badPointer.sections.distributable.entities[0].provenance[0].pointer = 'pets[99999]';
  const p1 = judge(badPointer).problems;
  log('[实际] 坏指针 rc =', p1.length ? 1 : 0, '；原文 =', show(p1, 1));
  assert.ok(p1.some((p) => p.includes('[provenance_pointers]')));

  const badStale = clone();
  badStale.freshness.status = 'STALE';
  badStale.freshness.guard.pass = false;
  badStale.readiness.game_data_pack_v2_status = 'ready';
  badStale.readiness.items = badStale.readiness.items.map((i) => ({...i, satisfied: true}));
  badStale.readiness.satisfied_count = badStale.readiness.total_items;
  badStale.readiness.blocking = [];
  const p2 = judge(badStale).problems;
  log('[实际] STALE+ready rc =', p2.length ? 1 : 0, '；原文 =', show(p2, 1));
  assert.ok(p2.some((p) => p.includes('STALE') || p.includes('[freshness_guard]')));
});

test('反证⑧ sources.yaml 查不到、报告缺项、契约缺项都 ⇒ 红', () => {
  const bad = clone();
  bad.contract.does_not_contain = bad.contract.does_not_contain.filter((row) => !(row.fields ?? []).includes('stats'));
  const problems = judge(bad).problems;
  log('[实际] 契约缺项 rc =', problems.length ? 1 : 0, '；原文 =', show(problems, 1));
  assert.ok(problems.some((p) => p.includes('[contract_completeness]') && p.includes('stats')));

  const bad2 = clone();
  bad2.source_registry = bad2.source_registry.map((r) => (r.source_id === 'wiki-rocom-snapshot' ? {...r, redistribution: 'UNLIMITED'} : r));
  const problems2 = judge(bad2).problems;
  log('[实际] 台账篡改 rc =', problems2.length ? 1 : 0, '；原文 =', show(problems2, 1));
  assert.ok(problems2.some((p) => p.includes('[licence_refs]') && p.includes('sources.yaml')));
});

// ─────────────────────────────────────────────────────────────────────────
// 7. 报告文件本身
// ─────────────────────────────────────────────────────────────────────────

test('就绪报告：存在、可解析、不含挂钟时间戳（确定性）', () => {
  assert.ok(existsSync(READINESS_PATH), `缺 ${READINESS_PATH}`);
  assert.equal(report.report, 'game-data-pack-readiness');
  assert.ok(report.pack_sha256.match(/^[0-9a-f]{64}$/));
  assert.ok(report.schema_sha256.match(/^[0-9a-f]{64}$/));
  assert.equal(report.generated_at, undefined, '报告不许带挂钟时间戳（否则不可复跑）');
  const checks = report.checks.map((c) => c.check);
  log('[实际] 报告判据组 =', checks.join(' '));
  assert.equal(checks.length, 17);
  for (const check of checks) assert.ok(report.checks.find((c) => c.check === check).ok, `${check} 应当通过`);
  log('[实际] 规模 =', JSON.stringify(report.scale));
});
