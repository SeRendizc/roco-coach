// RC-203 OwnedPet / BattleBuild 的守卫。
//
// 为什么这一组必须存在
// --------------------
// 「造 80 个 owned 实例」这件事，最省事的做法有四种，四种都**不会红**：
//   ① 技能随便填 —— 只要 id 长得像 skill_000123，没人会去核对这只学不学得到；
//   ② 把 48 只迁移夹具当成全世界 —— 数量对了、格式对了，产品却只覆盖夹具；
//   ③ 给性格/资质/特长补一列「加成」 —— 面板看起来更完整，公式是编的；
//   ④ 面板值直接抄种族值 —— 数字看起来合理，含义是错的。
// 所以这里钉住的是**判据本身有没有牙**，每条都有必红方向：
//   ① 抽掉实例 provenance ⇒ 红；          ② artifact_sha256 与磁盘不符 ⇒ 红；
//   ③ 技能换成该精灵学不到的 ⇒ 红；        ④ 四个技能改成三个 ⇒ 红；
//   ⑤ species_id 改成不存在的 ⇒ 红；       ⑥ nature.effect 填具体数值 ⇒ 红；
//   ⑦ 实例降到 79 个 ⇒ 红；               ⑧ 有值的字段塞进 unknown_fields ⇒ 红；
//   ⑨ BattleBuild 技能位顺序反转 ⇒ 红；    ⑩ licence_ref 查不到 ⇒ 红；
//   ⑪ 养成属性长出公式字段 ⇒ 红；          ⑫ base_stats 与冻结目录不符 ⇒ 红。
//
// 判据全部复用 scripts/roco/verify-owned-pets.mjs / owned-pets-lib.mjs 里的真实实现，
// 与两个脚本的 `--selftest` 跑**同一份代码**（两份判据各写一遍就会各自漂移）。
//
// 用法：`node --test tests/roco-owned-pets.test.js`

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';

import {
  INSTANCE_TARGET,
  MIN_OUTSIDE_LAYER,
  MIN_SAME_SPECIES_GROUPS,
  MIN_SPECIES,
  OWNED_PETS_PATH,
  OWNED_SCHEMA_PATH,
  RC203_REPORT_PATH,
  RULESET_ID,
  SEED,
  buildOwnedPetSchema,
  compareOwnedPets,
  datasetHash,
  expectedInstanceUnknownFields,
  OwnedPetSpeciesMismatchError,
  resignDataset,
  sha256Hex,
} from '../scripts/roco/owned-pets-lib.mjs';
import {
  CHECK_NAMES,
  SELFTEST_MUTATIONS,
  createCaches,
  runChecks,
  runSelftest,
} from '../scripts/roco/verify-owned-pets.mjs';
import {buildOwnedPets} from '../scripts/roco/build-owned-pets.mjs';

const log = (...args) => console.log('  ·', ...args);
const show = (problems, limit = 2) => problems.slice(0, limit).join(' | ');
/** 只挑某一组判据的问题贴出来——报告里的「实际输出原文」应当是**这条判据**说的那句话。 */
const showCheck = (problems, check, limit = 1) => problems.filter((p) => p.includes(`[${check}]`)).slice(0, limit).join(' | ');

/** 真产物：磁盘上的 owned-pets.json。测试**不许**用内存里现造的产物替代它。 */
const datasetText = readFileSync(OWNED_PETS_PATH, 'utf8');
const dataset = JSON.parse(datasetText);
const schemaText = readFileSync(OWNED_SCHEMA_PATH, 'utf8');
const schema = JSON.parse(schemaText);
const reportText = readFileSync(RC203_REPORT_PATH, 'utf8');
const report = JSON.parse(reportText);

const clone = () => JSON.parse(JSON.stringify(dataset));
/** 反证要跑十几遍 runChecks：只读磁盘，所以复用同一份缓存是安全的（也不改磁盘）。 */
const caches = createCaches();
const judge = (doc) => runChecks(doc, {schema, caches});
/** 注入违规后重签哈希链：让红色只来自真正想证明的那一组判据。 */
const resign = (doc) => resignDataset(doc);

/** 用同一份 lib 自己造一个合法的 owned 实例（比较器测试用，不去动真产物）。 */
const sample = (overrides = {}) => ({
  ...clone().instances[0],
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────
// 0. 真产物：80 个实例全部合规
// ─────────────────────────────────────────────────────────────────────────

test('真产物：80 个 owned 实例过全部 16 组判据', () => {
  const result = judge(dataset);
  log('[实际] 实例 =', result.facts.instances, '；species =', result.facts.species,
    '；battle_builds =', result.facts.battleBuilds);
  log('[实际] 分组 =', result.checks.map((c) => `${c.check}:${c.ok ? 'ok' : `✖${c.problems}`}`).join(' '));
  log('[实际] 问题 =', show(result.problems) || '(无)');
  assert.deepEqual(result.problems, [], '真产物必须过全部判据');
  assert.equal(result.checks.length, CHECK_NAMES.length);
  for (const check of result.checks) assert.ok(check.ok, `${check.check} 应当通过`);
  assert.equal(result.facts.instances, INSTANCE_TARGET);
  assert.equal(result.facts.battleBuilds, INSTANCE_TARGET);
  assert.equal(result.facts.provenanceMismatches, 0);
  assert.equal(result.facts.pointerMismatches, 0);
  assert.equal(result.facts.licenceRefUnresolved, 0);
  assert.equal(result.facts.wallClockFields, 0);
});

test('真产物：实例数 / species 数 / 不在 48 层的逐只点名 / 同种组数', () => {
  const instances = dataset.instances;
  const speciesIds = [...new Set(instances.map((i) => i.species_id))];
  const outside = [...new Set(instances.filter((i) => i.species_tier === 'baseline').map((i) => i.species_id))].sort();
  const bySpecies = new Map();
  for (const instance of instances) {
    if (!bySpecies.has(instance.species_id)) bySpecies.set(instance.species_id, []);
    bySpecies.get(instance.species_id).push(instance);
  }
  const groups = [...bySpecies.values()].filter((group) => group.length >= 2);
  log('[实际] 实例 =', instances.length, '；species =', speciesIds.length, '；不在 layer-playable-48 的 =', outside.length);
  log('[实际] 不在 layer-playable-48 的 species 逐只点名 =', outside.join(','));
  log('[实际] 同种组 =', groups.length);
  assert.ok(instances.length >= INSTANCE_TARGET, `实例数 ${instances.length} < ${INSTANCE_TARGET}`);
  assert.ok(speciesIds.length >= MIN_SPECIES, `species 数 ${speciesIds.length} < ${MIN_SPECIES}`);
  assert.ok(outside.length >= MIN_OUTSIDE_LAYER, `不在 layer-playable-48 的只有 ${outside.length} < ${MIN_OUTSIDE_LAYER}`);
  assert.ok(groups.length >= MIN_SAME_SPECIES_GROUPS, `同种组只有 ${groups.length} < ${MIN_SAME_SPECIES_GROUPS}`);
  // 每一组都必须至少有一项个体属性不同，否则「同种不同个体」是空的。
  for (const group of groups) {
    const comparison = compareOwnedPets(group[0], group[1]);
    assert.ok(comparison.differs_in_at_least_one_attribute,
      `${group[0].species_id} 的两个个体没有任何个体属性不同`);
  }
  assert.equal(dataset.counts.species_outside_layer_playable_48, outside.length);
  assert.equal(dataset.counts.same_species_groups_with_difference, groups.length);
});

test('真产物：四个技能逐个都在该 species 的 learnsets.json native_skills 里', () => {
  // 不信任产物自带的 pointer：直接按 species_id 重算一遍出处。
  const frozen = {
    main: JSON.parse(readFileSync('data/roco/normalized/roco-world-s4-2026-09-10/learnsets.json', 'utf8')).learnsets,
    layer: JSON.parse(readFileSync('data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/learnsets.json', 'utf8')).learnsets,
  };
  const skills = new Set(Object.keys(JSON.parse(readFileSync('data/roco/normalized/roco-world-s4-2026-09-10/skills.json', 'utf8')).skills));
  let checked = 0;
  for (const instance of dataset.instances) {
    const entry = frozen.main[instance.species_id] ?? frozen.layer[instance.species_id];
    assert.ok(entry, `${instance.instance_id} 的 ${instance.species_id} 没有冻结 learnset`);
    const learnable = new Set(entry.native_skills.map((row) => row.skill_id));
    assert.equal(instance.skills.length, 4, `${instance.instance_id} 不是四个技能`);
    for (const skill of instance.skills) {
      assert.ok(learnable.has(skill), `${instance.instance_id} 的 ${skill} 不在 ${instance.species_id} 的 native_skills 里`);
      assert.ok(skills.has(skill), `${instance.instance_id} 的 ${skill} 不在全量 skills.json 里`);
      checked += 1;
    }
  }
  log('[实际] 逐个核对的技能引用 =', checked);
  assert.equal(checked, dataset.instances.length * 4);
});

test('真产物：养成属性全部是 UNKNOWN，且没有任何被发明的公式字段', () => {
  let counter = 0;
  for (const instance of dataset.instances) {
    for (const field of ['nature', 'talent', 'specialty', 'bloodline']) {
      const attribute = instance[field];
      assert.equal(attribute.effect, 'UNKNOWN', `${instance.instance_id}.${field}.effect 必须是 UNKNOWN`);
      assert.equal(attribute.microcase_id, null, `${instance.instance_id}.${field}.microcase_id 必须是 null`);
      assert.equal(attribute.effect_reason, '面板换算公式未校准（见 10 号文档 §13）');
      assert.deepEqual(Object.keys(attribute).filter((k) => /(formula|multiplier|modifier|percent|ratio|coefficient|bonus)/i.test(k)), [],
        `${instance.instance_id}.${field} 出现了被发明的公式字段`);
      counter += 1;
    }
  }
  log('[实际] 养成属性条目 =', counter, '（全部 effect=UNKNOWN）');
  assert.equal(counter, dataset.instances.length * 4);
  assert.equal(dataset.instances.every((i) => i.panel_stats === null), true, 'panel_stats 必须为 null（公式未校准）');
  assert.equal(dataset.battle_builds.every((b) => b.derived_stats === null), true, 'derived_stats 必须为 null');
});

test('真产物：unknown_fields 与「确实不可得」双向一致', () => {
  for (const instance of dataset.instances) {
    assert.deepEqual([...instance.unknown_fields].sort(), expectedInstanceUnknownFields(instance),
      `${instance.instance_id} 的 unknown_fields 与重算不一致`);
  }
  log('[实际] 实例级 unknown_fields 取值集合 =', JSON.stringify([...new Set(dataset.instances.map((i) => i.unknown_fields.join('+')))]));
  assert.deepEqual(dataset.unknown_fields_allowlist.slice().sort(), ['bloodline', 'nature', 'panel_stats', 'specialty', 'talent']);
});

test('确定性：同一输入两次重建逐字节相同，且没有任何挂钟字段', () => {
  const again = buildOwnedPets();
  assert.equal(again.datasetText, datasetText, '两次重建必须逐字节相同');
  assert.equal(again.schemaText, schemaText, '两次重建的 schema 必须逐字节相同');
  assert.equal(dataset.seed, SEED);
  assert.equal(dataset.ruleset_id, RULESET_ID);
  assert.deepEqual(dataset.clock_fields, []);
  assert.equal(JSON.stringify(dataset).match(/(timestamp|updated_at|created_at|fetched_at|checked_at|run_at)"/gi), null,
    '产物里不许出现挂钟字段');
  log('[实际] dataset_hash =', dataset.dataset_hash);
  log('[实际] sha256(owned-pets.json) =', sha256Hex(datasetText));
  assert.equal(dataset.dataset_hash, datasetHash(dataset));
  assert.equal(datasetText, `${JSON.stringify(again.dataset, null, 2)}\n`);
});

test('schema.json 是契约：磁盘内容与「现在重建」逐字节相同', () => {
  assert.equal(schemaText, `${JSON.stringify(buildOwnedPetSchema(), null, 2)}\n`);
  assert.ok(schema.contracts.OwnedPet && schema.contracts.BattleBuild, 'schema 必须同时描述 OwnedPet 与 BattleBuild');
  log('[实际] schema 契约 =', Object.keys(schema.contracts).join(','));
  assert.ok(schema.policies.unknown_fields_rule.length > 0);
  assert.ok(schema.policies.forbidden_growth_field_pattern.includes('formula'));
});

// ─────────────────────────────────────────────────────────────────────────
// 1. 同种个体比较：纯函数，逐字段 same/different/unknown
// ─────────────────────────────────────────────────────────────────────────

test('compareOwnedPets：同种不同个体的逐字段结论，以及不同物种必须抛错', () => {
  const a = sample({instance_id: 'own-A', level: 50, skills: ['skill_000246', 'skill_000273', 'skill_000359', 'skill_000249']});
  const b = sample({instance_id: 'own-B', level: 90, skills: ['skill_000246', 'skill_000273', 'skill_000359', 'skill_000342']});

  const comparison = compareOwnedPets(a, b);
  log('[实际] different_fields =', JSON.stringify(comparison.different_fields));
  log('[实际] unknown_fields =', JSON.stringify(comparison.unknown_fields));
  log('[实际] fields.level =', JSON.stringify(comparison.fields.level));
  log('[实际] fields.nature =', JSON.stringify(comparison.fields.nature));
  log('[实际] fields.skills =', JSON.stringify(comparison.fields.skills));
  assert.equal(comparison.same_species, true);
  assert.equal(comparison.fields.level.status, 'different');
  assert.deepEqual(comparison.different_fields, ['level', 'skills']);
  assert.equal(comparison.fields.nature.status, 'unknown');
  assert.equal(comparison.fields.talent.status, 'unknown');
  assert.equal(comparison.fields.specialty.status, 'unknown');
  assert.equal(comparison.differs_in_at_least_one_attribute, true);

  // 只换技能位顺序 → different（顺序敏感），但 skills_as_set 是 same（集合没变）。
  const reordered = compareOwnedPets(a, sample({
    instance_id: 'own-C',
    level: 50,
    skills: [a.skills[3], a.skills[0], a.skills[1], a.skills[2]],
  }));
  log('[实际] 只换顺序：skills =', reordered.fields.skills.status, '；skills_as_set =', reordered.fields.skills.skills_as_set);
  assert.equal(reordered.fields.skills.status, 'different');
  assert.equal(reordered.fields.skills.skills_as_set, 'same');

  // 完全一样 → 没有任何差异字段。
  const identical = compareOwnedPets(a, {...a, instance_id: 'own-D'});
  assert.deepEqual(identical.different_fields, []);
  assert.equal(identical.identical_in_known_attributes, true);

  // 不同物种：抛错，不静默比较。
  assert.throws(() => compareOwnedPets(dataset.instances[0], dataset.instances.find((i) => i.species_id !== dataset.instances[0].species_id)),
    (error) => {
      log('[实际] 不同物种抛错 =', error.name, '：', error.message);
      assert.ok(error instanceof OwnedPetSpeciesMismatchError);
      return true;
    });
  assert.throws(() => compareOwnedPets({species_id: 'pet_000062'}, {species_id: null}), TypeError);
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 必红反证：每一条都把产物改坏，对应判据必须翻红
// ─────────────────────────────────────────────────────────────────────────

test(`反证：${SELFTEST_MUTATIONS.length} 条注入全部翻红（逐条打印实际输出原文）`, () => {
  const selftest = runSelftest(dataset, {caches});
  log('[实际] 基线判据 =', selftest.baseline.ok ? 'PASS' : 'FAIL');
  for (const entry of selftest.results) {
    log(`[实际] ${entry.caught ? '红  ' : '没红'} ${entry.id} ${entry.title} → 期望 ${entry.expect}`
      + `；原文 = ${show(entry.problems, 1) || '(没有该组的问题)'}`);
    assert.ok(entry.caught, `${entry.id}（${entry.title}）没有让 [${entry.expect}] 翻红——这条判据没有牙`);
  }
  assert.equal(selftest.ok, true);
  assert.ok(selftest.results.length >= 6, '必红反证至少要 6 条');
});

test('反证① 抽掉一个实例的 provenance ⇒ 红', () => {
  const bad = clone();
  bad.instances[0].provenance = [];
  resign(bad);
  const problems = judge(bad).problems;
  log('[实际] rc =', problems.length ? 1 : 0, '；原文 =', showCheck(problems, 'provenance_on_disk'));
  assert.ok(problems.some((p) => p.includes('[provenance_on_disk]') && p.includes('own-0001')));
});

test('反证② artifact_sha256 与磁盘不符 ⇒ 红', () => {
  const bad = clone();
  bad.instances[1].provenance[0].artifact_sha256 = 'f'.repeat(64);
  resign(bad);
  const problems = judge(bad).problems;
  log('[实际] rc =', problems.length ? 1 : 0, '；原文 =', showCheck(problems, 'provenance_on_disk'));
  assert.ok(problems.some((p) => p.includes('[provenance_on_disk]') && p.includes('artifact_sha256')));
});

test('反证③④ 技能换成学不到的 / 四个改成三个 ⇒ 红', () => {
  const frozenSkills = Object.keys(JSON.parse(readFileSync('data/roco/normalized/roco-world-s4-2026-09-10/skills.json', 'utf8')).skills);
  const mainLearn = JSON.parse(readFileSync('data/roco/normalized/roco-world-s4-2026-09-10/learnsets.json', 'utf8')).learnsets;

  const bad = clone();
  const victim = bad.instances[2];
  const learnable = new Set(mainLearn[victim.species_id].native_skills.map((row) => row.skill_id));
  const foreign = frozenSkills.find((skill) => !learnable.has(skill));
  victim.skills[0] = foreign;
  bad.battle_builds[2].ordered_skills = [...victim.skills];
  resign(bad);
  const problems = judge(bad).problems;
  log('[实际] 学了学不到的 rc =', problems.length ? 1 : 0, '；原文 =', showCheck(problems, 'learnset_membership'));
  assert.ok(problems.some((p) => p.includes('[learnset_membership]') && p.includes(foreign)));

  const bad2 = clone();
  bad2.instances[3].skills = bad2.instances[3].skills.slice(0, 3);
  bad2.battle_builds[3].ordered_skills = [...bad2.instances[3].skills];
  resign(bad2);
  const problems2 = judge(bad2).problems;
  log('[实际] 三个技能的 rc =', problems2.length ? 1 : 0, '；原文 =', showCheck(problems2, 'learnset_membership'));
  assert.ok(problems2.some((p) => p.includes('[learnset_membership]') && p.includes('恰好 4 个')));
});

test('反证⑤⑦ species_id 不存在 / 实例降到 79 个 ⇒ 红', () => {
  const bad = clone();
  bad.instances[4].species_id = 'pet_999999';
  resign(bad);
  const problems = judge(bad).problems;
  log('[实际] 假 species rc =', problems.length ? 1 : 0, '；原文 =', showCheck(problems, 'species_existence'));
  assert.ok(problems.some((p) => p.includes('[species_existence]') && p.includes('pet_999999')));

  const bad2 = clone();
  const dropped = bad2.instances.pop();
  bad2.battle_builds = bad2.battle_builds.filter((b) => b.owned_pet_instance_id !== dropped.instance_id);
  resign(bad2);
  const problems2 = judge(bad2).problems;
  log('[实际] 79 个实例 rc =', problems2.length ? 1 : 0, '；原文 =', showCheck(problems2, 'species_universe'));
  assert.ok(problems2.some((p) => p.includes('[species_universe]') && p.includes('79')));
});

test('反证⑥⑪ nature.effect 填数值 / 长出公式字段 ⇒ 红', () => {
  const bad = clone();
  bad.instances[5].nature.effect = 0.2;
  resign(bad);
  const problems = judge(bad).problems;
  log('[实际] effect=0.2 rc =', problems.length ? 1 : 0, '；原文 =', showCheck(problems, 'growth_attributes'));
  assert.ok(problems.some((p) => p.includes('[growth_attributes]') && p.includes('被发明的养成公式')));

  const bad2 = clone();
  bad2.instances[5].specialty.multiplier = 1.15;
  resign(bad2);
  const problems2 = judge(bad2).problems;
  log('[实际] 公式字段 rc =', problems2.length ? 1 : 0, '；原文 =', showCheck(problems2, 'growth_attributes'));
  assert.ok(problems2.some((p) => p.includes('[growth_attributes]') && p.includes('multiplier')));

  const badEvidence = clone();
  badEvidence.instances[5].talent.effect = 'microcase:panel-formula-v1';
  resign(badEvidence);
  const problemsEvidence = judge(badEvidence).problems;
  log('[实际] 臆造证据 id rc =', problemsEvidence.length ? 1 : 0, '；原文 =', showCheck(problemsEvidence, 'growth_attributes'));
  assert.ok(problemsEvidence.some((p) => p.includes('[growth_attributes]') && p.includes('证据 id 白名单')));

  const bad3 = clone();
  bad3.instances[5].nature.value = '固执';
  bad3.instances[5].nature.value_source = 'hand-written';
  resign(bad3);
  const problems3 = judge(bad3).problems;
  log('[实际] 手写标签后 unknown_fields 不一致 rc =', problems3.length ? 1 : 0, '；原文 =', showCheck(problems3, 'unknown_fields'));
  assert.ok(problems3.some((p) => p.includes('[unknown_fields]') && p.includes('nature')));
});

test('反证⑧ 有值的字段塞进 unknown_fields ⇒ 红', () => {
  const bad = clone();
  bad.instances[6].unknown_fields = [...bad.instances[6].unknown_fields, 'level'].sort();
  resign(bad);
  const problems = judge(bad).problems;
  log('[实际] rc =', problems.length ? 1 : 0, '；原文 =', showCheck(problems, 'unknown_fields'));
  assert.ok(problems.some((p) => p.includes('[unknown_fields]') && p.includes('多报')));

  // 另一个方向：该标没标。
  const bad2 = clone();
  bad2.instances[6].unknown_fields = bad2.instances[6].unknown_fields.filter((f) => f !== 'talent');
  resign(bad2);
  const problems2 = judge(bad2).problems;
  log('[实际] 漏报方向 rc =', problems2.length ? 1 : 0, '；原文 =', showCheck(problems2, 'unknown_fields'));
  assert.ok(problems2.some((p) => p.includes('[unknown_fields]') && p.includes('漏报')));
});

test('反证⑨⑩⑫ BattleBuild 顺序反转 / licence_ref 查不到 / base_stats 不符 ⇒ 红', () => {
  const bad = clone();
  bad.battle_builds[7].ordered_skills = [...bad.battle_builds[7].ordered_skills].reverse();
  resign(bad);
  const problems = judge(bad).problems;
  log('[实际] 顺序反转 rc =', problems.length ? 1 : 0, '；原文 =', showCheck(problems, 'skill_order'));
  assert.ok(problems.some((p) => p.includes('[skill_order]') && p.includes('顺序被改动')));

  const bad2 = clone();
  bad2.instances[8].licence_ref = 'licence-not-registered-anywhere';
  resign(bad2);
  const problems2 = judge(bad2).problems;
  log('[实际] 假 licence_ref rc =', problems2.length ? 1 : 0, '；原文 =', showCheck(problems2, 'licence_refs'));
  assert.ok(problems2.some((p) => p.includes('[licence_refs]')));

  const bad3 = clone();
  bad3.instances[9].base_stats.hp += 1;
  resign(bad3);
  const problems3 = judge(bad3).problems;
  log('[实际] 改 base_stats rc =', problems3.length ? 1 : 0, '；原文 =', showCheck(problems3, 'base_stats_pointers'));
  assert.ok(problems3.some((p) => p.includes('[base_stats_pointers]')));
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 报告文件本身
// ─────────────────────────────────────────────────────────────────────────

test('RC-203 报告：存在、可解析、逐条给出判据文本与实际值、不含挂钟字段', () => {
  assert.ok(existsSync(RC203_REPORT_PATH), `缺 ${RC203_REPORT_PATH}`);
  assert.equal(report.report_version, 'roco-rc203-owned-pets-report/v1');
  assert.equal(report.ok, true);
  assert.deepEqual(report.clock_fields, []);
  log('[实际] 判据条数 =', report.criteria.length, '；checks =', report.checks.length);
  log('[实际] C06 不在 48 层 =', report.criteria.find((c) => c.id === 'C06').actual);
  log('[实际] C07 同种组 =', report.criteria.find((c) => c.id === 'C07').actual);
  for (const criterion of report.criteria) {
    assert.ok(criterion.text && criterion.expected && criterion.actual !== undefined, `${criterion.id} 缺判据文本或实际值`);
    assert.equal(criterion.ok, true, `${criterion.id} 应当通过`);
  }
  assert.equal(report.outside_layer_playable_48.species.length, report.counts.species_outside_layer_playable_48);
  // 另一个口径（roster-48）的数也必须摆在报告里，不能只报对自己有利的那个。
  log('[实际] 备选口径 roster-48 池外 species =', report.outside_layer_playable_48.alternative_reading.species_outside_roster_48);
  assert.equal(report.outside_layer_playable_48.alternative_reading.roster_48_species, 48);
  assert.ok(report.outside_layer_playable_48.alternative_reading.note.length > 0);
  assert.equal(report.same_species_groups.groups.length, report.counts.same_species_groups);
  assert.ok(report.skips.species.length >= 0);
  assert.equal(report.skips.counts.no_frozen_learnset, 622 - 48, 'pack 622 只里只有 48 只有冻结 learnset');
  log('[实际] 跳过 =', JSON.stringify(report.skips.counts));
  log('[实际] unknown 属性 =', report.unknown_attributes.map((u) => u.field).join(','));
  assert.ok(report.reproduce.commands.includes('node scripts/roco/build-owned-pets.mjs --check'));
  assert.equal(report.reproduce.within_days, 90);
  // 报告必须与磁盘产物一致（否则「报告」就成了另一份事实）。
  assert.equal(report.artifact.sha256, sha256Hex(datasetText));
  assert.equal(report.artifact.dataset_hash, dataset.dataset_hash);
});
