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
// 同种两只「掷点后是否真的不同」要按个体层算（数据集里那两项是 null）。
import {individualFromInstance} from '../src/coach/individuals.js';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';

import {
  FROZEN_LAYER_SUPPORT,
  FROZEN_MAIN_SUPPORT,
  INSTANCE_TARGET,
  MIN_OUTSIDE_LAYER,
  MAX_SAME_SPECIES_GROUPS,
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
  mergeCanonicalLoadouts,
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

test('真产物：owned 实例过全部 16 组判据（2026-09-28 起是 49 个：48 物种 + 1 只演示用的同种第二只）', () => {
  const result = judge(dataset);
  log('[实际] 实例 =', result.facts.instances, '；species =', result.facts.species,
    '；battle_builds =', result.facts.battleBuilds);
  log('[实际] 分组 =', result.checks.map((c) => `${c.check}:${c.ok ? 'ok' : `✖${c.problems}`}`).join(' '));
  log('[实际] 问题 =', show(result.problems) || '(无)');
  assert.deepEqual(result.problems, [], '真产物必须过全部判据');
  assert.equal(result.checks.length, CHECK_NAMES.length);
  for (const check of result.checks) assert.ok(check.ok, `${check.check} 应当通过`);
  // ⚠ 2026-09-28 **第二次改钉**（人类：「重复精灵不要了，把铠甲虫还原回来」+「每种精灵只允许有一只」）：
  // 上一版是 `instances == species + 1`（多出来的那一只是演示同种第二只 `own-0049`），
  // 现在按 human-decisions 里写好的 rollback 把那一只回收了 ⇒ **回到 `instances == species`**。
  // 判据仍然不写死数字（守住"不许灌水"这条原意）：**一个物种一只**，一只演示个体都不许有。
  assert.equal(result.facts.instances, result.facts.species,
    `实例数应当**等于**物种数（一个物种一只），实际 ${result.facts.instances}/${result.facts.species}`);
  const demos = dataset.instances.filter((one) => one.synthetic_demo === true);
  assert.equal(demos.length, 0, `演示个体必须为 0（那一对已回收），实际 ${demos.length}`);
  assert.ok(result.facts.instances >= INSTANCE_TARGET, '实例数不得低于下限');
  assert.equal(result.facts.battleBuilds, result.facts.instances, '每只实例都要有一条 battle_build');
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
  // 2026-09-24（人类纠正）：不再允许同种多实例 —— 那批「第二个个体」是造的，游戏里不存在。
  assert.ok(groups.length <= MAX_SAME_SPECIES_GROUPS,
    `同种多实例组有 ${groups.length} 组 > ${MAX_SAME_SPECIES_GROUPS}：重复个体必须删掉`);
  // 每一组都必须至少有一项个体属性不同，否则「同种不同个体」是空的。
  for (const group of groups) {
    const comparison = compareOwnedPets(group[0], group[1]);
    assert.ok(comparison.differs_in_at_least_one_attribute,
      `${group[0].species_id} 的两个个体没有任何个体属性不同`);
  }
  assert.equal(dataset.counts.species_outside_layer_playable_48, outside.length);
  assert.equal(dataset.counts.same_species_groups_with_difference, groups.length);
});

test('真产物：四个技能逐个都在该 species 的学习表池（native ∪ blood ∪ stones，与引擎 is_learnable 同口径）里', () => {
  // 不信任产物自带的 pointer：直接按 species_id 重算一遍出处。
  // 2026-09-25：口径从「只认 native_skills」改成**引擎自己的那一条** ——
  // `Ruleset.is_learnable`（`roco/src/roco_env/data.py:305-307`）读的是 `Learnset.all_skill_ids`
  // = native ∪ blood ∪ stones（`data.py:133-135`）；字段名与类型照 `data.py:477-483` 抄：
  // `native_skills`/`blood_skills` 是 `[{skill_id}]`，`skill_stones` 是**纯字符串数组**。
  const frozen = {
    main: JSON.parse(readFileSync('data/roco/normalized/roco-world-s4-2026-09-10/learnsets.json', 'utf8')).learnsets,
    layer: JSON.parse(readFileSync('data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/learnsets.json', 'utf8')).learnsets,
  };
  const skills = new Set(Object.keys(JSON.parse(readFileSync('data/roco/normalized/roco-world-s4-2026-09-10/skills.json', 'utf8')).skills));
  let checked = 0;
  let outsideNative = 0;
  const origins = {native: 0, blood: 0, stones: 0};
  for (const instance of dataset.instances) {
    const entry = frozen.main[instance.species_id] ?? frozen.layer[instance.species_id];
    assert.ok(entry, `${instance.instance_id} 的 ${instance.species_id} 没有冻结 learnset`);
    const native = new Set((entry.native_skills ?? []).map((row) => row.skill_id).filter(Boolean));
    const blood = new Set((entry.blood_skills ?? []).map((row) => row.skill_id).filter(Boolean));
    const stones = new Set((entry.skill_stones ?? []).filter((s) => typeof s === 'string' && s.length > 0));
    const learnable = new Set([...native, ...blood, ...stones]);
    assert.equal(instance.skills.length, 4, `${instance.instance_id} 不是四个技能`);
    for (const skill of instance.skills) {
      assert.ok(learnable.has(skill), `${instance.instance_id} 的 ${skill} 不在 ${instance.species_id} 的学习表池里`);
      assert.ok(skills.has(skill), `${instance.instance_id} 的 ${skill} 不在全量 skills.json 里`);
      const origin = native.has(skill) ? 'native' : blood.has(skill) ? 'blood' : 'stones';
      origins[origin] += 1;
      if (origin !== 'native') outsideNative += 1;
      checked += 1;
    }
  }
  log('[实际] 逐个核对的技能引用 =', checked, `（native ${origins.native} / blood ${origins.blood} / stones ${origins.stones}）`);
  assert.equal(checked, dataset.instances.length * 4);
  // 差异**不许消失**：这些非 native 引用是「引擎真的会装上血统/石系技能」的证据，
  // 谁把它们悄悄删掉（或把口径偷偷改回 native-only）都要在这里留下痕迹。
  // ⚠ 2026-09-28 **第二次改钉**：**47 → 46**。上一版多出来的那 1 条来自演示个体 `own-0049`
  // （它复用 own-0001 的四个技能，其中一个是非 native）；那一只按 rollback 回收之后这 1 条就没了。
  // 判据的原意一个字没变：这些非 native 引用是「引擎真的会装上血统/石系技能」的证据，
  // 谁把它们悄悄删掉（或把口径偷偷改回 native-only）都要在这里留下痕迹。
  // 2026-09-28 **第三次改钉**（**旧值不删**：`47 → 46 →` 现在 **444**）。
  // 头两次是演示个体 own-0049 的加减；这一次是**甲案扩规模**：盒子从 48 只物种扩到
  // 可玩层的 **542** 只（人类逐字「所有精灵实装，这样就不需要我的精灵了，直接全筛选」），
  // 技能引用总数 2168 条，其中非 native（blood/stones）的 **444** 条。
  // 判据的原意一个字没变：这些非 native 引用是「引擎真的会装上血统/石系技能」的证据，
  // 谁把它们悄悄删掉（或把口径偷偷改回 native-only）都要在这里留下痕迹。
  assert.equal(outsideNative, 444, '非 native（blood/stones）技能引用数变了 —— 请连同口径一起复核');
});

test('真产物：BattleBuild.ordered_skills **逐位**等于引擎 loadout（C20；2026-09-25 人类「配招这个你得修好」）', () => {
  // 引擎 loadout = support-matrix.json（基线 12）+ layer-playable-48/support-matrix.json（叠加层 36）
  // 的 candidate_moveset 合并（规则同 `roco/src/roco_env/data.py:515-535`）。
  // 这一条**不相信 owned 自己的任何声明**：直接从两片冻结矩阵重算，逐位比对。
  const matrices = [
    {label: 'baseline', doc: JSON.parse(readFileSync(FROZEN_MAIN_SUPPORT, 'utf8'))},
    {label: 'layer', doc: JSON.parse(readFileSync(FROZEN_LAYER_SUPPORT, 'utf8'))},
  ];
  const merged = mergeCanonicalLoadouts(matrices);
  assert.deepEqual(merged.problems, [], `规范四技能合并本身有问题：${show(merged.problems)}`);
  // 2026-09-28 改钉（**旧值不删**：`48`）。甲案 ⇒ 引擎 loadout = 基线 12 + 抓包可玩层 530 = **542**。
  assert.equal(merged.byPetId.size, 542, '引擎 loadout 覆盖的物种数应为 542（2026-09-28 前是 48）');
  let matched = 0;
  for (const build of dataset.battle_builds) {
    const canonical = merged.byPetId.get(build.species_id);
    assert.ok(canonical, `${build.build_id} 的 ${build.species_id} 不在引擎 loadout 里`);
    assert.deepEqual(build.ordered_skills, canonical,
      `${build.build_id}（${build.species_id}）的 ordered_skills 与引擎 loadout 不逐位相同`);
    matched += 1;
  }
  log('[实际] 与引擎 loadout 逐位相同的 build =', matched, '/', dataset.battle_builds.length,
    '；样例 =', JSON.stringify(dataset.battle_builds[0].ordered_skills));
  assert.equal(matched, dataset.battle_builds.length);
  // 判据本身不是空的：C20 必须在 CHECK_NAMES 里，且报告里 C20 是通过的
  assert.ok(CHECK_NAMES.includes('canonical_loadout'), 'C20 的判据分组没接进 CHECK_NAMES');
  assert.equal(report.criteria.find((c) => c.id === 'C20')?.ok, true, '报告里的 C20 不是通过状态');
});

test('必红反证：把 owned 的四技能换掉/调序，C20 立刻报（判据有牙）', () => {
  // 反证 A：调换第 3、4 位 —— **只动顺序、不动集合**。这一条专抓「顺序不算数」那种放松。
  const swapped = clone();
  const b0 = swapped.battle_builds[0];
  [b0.ordered_skills[2], b0.ordered_skills[3]] = [b0.ordered_skills[3], b0.ordered_skills[2]];
  const a0 = swapped.instances.find((i) => i.instance_id === b0.owned_pet_instance_id);
  [a0.skills[2], a0.skills[3]] = [a0.skills[3], a0.skills[2]];
  resign(swapped);
  const swapProblems = judge(swapped).problems;
  assert.ok(swapProblems.some((p) => p.includes('[canonical_loadout]')),
    `只调换顺序也必须被 C20 抓住：${show(swapProblems, 3)}`);
  log('[反证] 调换第 3/4 位 → C20 命中：', showCheck(swapProblems, 'canonical_loadout'));

  // 反证 B：把四个技能里换掉一个（换成同池的另一个合法技能）—— 集合级也要抓住。
  const replaced = clone();
  const b1 = replaced.battle_builds[1];
  const original = b1.ordered_skills[1];
  const pool = JSON.parse(readFileSync('data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/learnsets.json', 'utf8')).learnsets[b1.species_id]
    ?? JSON.parse(readFileSync('data/roco/normalized/roco-world-s4-2026-09-10/learnsets.json', 'utf8')).learnsets[b1.species_id];
  const alternatives = (pool.native_skills ?? []).map((r) => r.skill_id)
    .filter((id) => !b1.ordered_skills.includes(id));
  assert.ok(alternatives.length > 0, '反证 B 需要至少一个候选技能');
  b1.ordered_skills[1] = alternatives[0];
  const a1 = replaced.instances.find((i) => i.instance_id === b1.owned_pet_instance_id);
  a1.skills[1] = alternatives[0];
  resign(replaced);
  const replaceProblems = judge(replaced).problems;
  assert.ok(replaceProblems.some((p) => p.includes('[canonical_loadout]')),
    `换掉一个技能（${original} → ${alternatives[0]}）也必须被 C20 抓住：${show(replaceProblems, 3)}`);
  log('[反证] 换掉一个技能 → C20 命中：', showCheck(replaceProblems, 'canonical_loadout'));

  // 反证 C：真产物本身**不许**被判红（否则说明反证只是把判据弄红了）
  assert.deepEqual(judge(dataset).problems.filter((p) => p.includes('[canonical_loadout]')), []);
});

// 2026-09-28 改钉（**旧值不删**：标题与期望集合原来是「**2/48**」= `['pet_000451','pet_000474']`）。
// 甲案（盒子扩到可玩层 542 只）之后，多出**一只**漂移 `pet_000137 多多`，逐条核过**不是缺陷**：
//   · `roster-48.json`（M1 的选择登记层，从 **wiki** 学招表选招）给它的四招里有一招
//     `skill_000612 毒液渗透`；
//   · 而抓包 `level` 桶里**没有**这一招（FEASIBILITY-547-A §B-4 实测记过：多多「level 16 条 vs
//     wiki native 17 条 → partial」）⇒ 按人类「**配招以抓包为准**」的口径，引擎侧的规范配招
//     从抓包池里重选，于是两侧不同。
//   · 这正是「抓包为准」的应有结果，不是数据错；判据本身仍然是**有牙**的：
//     任何**新增**漂移都会让这条红（要修必须先动 `src/**` 的读点，或拿到改冻结层的授权）。
test('已知限制（钉住）：盒子页读的冻结 roster-48.json 与引擎 loadout 有 3/542 不一致', () => {
  // 两条链都**冻结**（`data/roco/normalized/**` 一个字节都不许动）：
  //   · 引擎/战斗读 `support-matrix.json` + `layer-playable-48/support-matrix.json`（本判据的事实源）；
  //   · 盒子页 `/api/roco/box` 读 `roster-48.json#pets[].moveset`（`src/server/roco-service.js:292`）。
  // 这 2 只（基线 12 里的 pet_000451 秩序鱿墨 / pet_000474 画间沉铁兽）在两侧给出的四技能不同，
  // 而**改不动**（两侧都在 normalized/ 里）。所以这里把它**钉成已知数字**：
  // 任何**新增**漂移都会让这条测试红；要修必须先动 `src/**` 的读点或拿到改冻结层的授权。
  const matrices = [
    {label: 'baseline', doc: JSON.parse(readFileSync(FROZEN_MAIN_SUPPORT, 'utf8'))},
    {label: 'layer', doc: JSON.parse(readFileSync(FROZEN_LAYER_SUPPORT, 'utf8'))},
  ];
  const engine = mergeCanonicalLoadouts(matrices).byPetId;
  const roster = JSON.parse(readFileSync('data/roco/normalized/roco-world-s4-2026-09-10/roster-48.json', 'utf8'));
  const drift = [];
  for (const pet of roster.pets) {
    const engineSkills = engine.get(pet.pet_id);
    const rosterSkills = (pet.moveset ?? []).map((row) => row.skill_id);
    if (!engineSkills || rosterSkills.length === 0) continue;
    if (JSON.stringify(engineSkills) !== JSON.stringify(rosterSkills)) drift.push(pet.pet_id);
  }
  log('[实际] roster-48 与引擎 loadout 不一致的物种 =', drift.length, JSON.stringify(drift));
  // 比**集合**（两侧都排序）：`drift` 的顺序跟着 roster-48.json 的名单顺序走，
  // 这里要钉的是「有哪几只」，不是「按什么顺序列出来」——排序不是放宽（成员一个没少）。
  assert.deepEqual([...drift].sort(), ['pet_000137', 'pet_000451', 'pet_000474'],
    '已知漂移集合变了：新增漂移必须当成缺陷处理，不许直接改这条期望值'
    + '（2026-09-28 新增的 pet_000137 已逐条核过：抓包 level 桶里没有 roster-48 记的「毒液渗透」，'
    + '按「配招以抓包为准」它就应当漂移）');
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
  // 2026-09-24：实例集合改成「一人一只」之后，第 3 个实例不一定在主 learnsets.json 里有登记
  //（它可能只在 layer-playable-48 那份里）→ 挑一个**两份都能查到的**物种当受害者，
  // 否则反证会因为「查不到 learnset」而报别的错，测的就不是这条判据了。
  const victim = bad.instances.find((i) => mainLearn[i.species_id]?.native_skills?.length) ?? bad.instances[2];
  const learnable = new Set(mainLearn[victim.species_id].native_skills.map((row) => row.skill_id));
  const foreign = frozenSkills.find((skill) => !learnable.has(skill));
  victim.skills[0] = foreign;
  const victimBuild = bad.battle_builds.find((b) => b.owned_pet_instance_id === victim.instance_id);
  victimBuild.ordered_skills = [...victim.skills];
  resign(bad);
  const problems = judge(bad).problems;
  log('[实际] 学了学不到的 rc =', problems.length ? 1 : 0, '；原文 =', showCheck(problems, 'learnset_membership'));
  assert.ok(problems.some((p) => p.includes('[learnset_membership]') && p.includes(foreign)));

  const bad2 = clone();
  const victim2 = bad2.instances.find((i) => i.instance_id !== victim.instance_id);
  victim2.skills = victim2.skills.slice(0, 3);
  bad2.battle_builds.find((b) => b.owned_pet_instance_id === victim2.instance_id).ordered_skills = [...victim2.skills];
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
  log('[实际] 少一个实例 rc =', problems2.length ? 1 : 0, '；原文 =', showCheck(problems2, 'species_universe'));
  // 2026-09-24：实例数=物种数（人类要求删掉重复个体）；2026-09-28 人类批准加**一对**同种演示个体
  // ⇒ 现在是 49 个实例 / 48 个物种。判据断言「点名了**实际条数**」（`bad2.instances.length`），
  // 既不写死 79 也不写死 48 —— 数字再变一次也不会假装没变。
  // ⚠ 2026-09-28 改钉：掉 1 个已经不够（49→48 仍等于下限）⇒ 这里与 R07 一样掉 **2** 个，
  // 断言"点名了实际条数"（不写死数字）。意图不变：宇宙缩水必须被抓到。
  const bad3 = clone();
  for (let i = 0; i < 2; i += 1) {
    const gone = bad3.instances.pop();
    bad3.battle_builds = bad3.battle_builds.filter((b) => b.owned_pet_instance_id !== gone.instance_id);
  }
  resign(bad3);
  const problems3 = judge(bad3).problems;
  assert.ok(problems3.some((p) => p.includes('[species_universe]')
    && p.includes(String(bad3.instances.length))),
  `少两个实例必须被点到数（实际 ${bad3.instances.length}）：${showCheck(problems3, 'species_universe')}`);
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
  // 2026-09-28 改钉（**旧值不删**：`622 - 48`）。甲案 ⇒ 冻结 learnset 覆盖 542 只，跳过 80 只。
  assert.equal(report.skips.counts.no_frozen_learnset, 622 - 542,
    'pack 622 只里有 542 只有冻结 learnset（2026-09-28 前是 48）');
  log('[实际] 跳过 =', JSON.stringify(report.skips.counts));
  log('[实际] unknown 属性 =', report.unknown_attributes.map((u) => u.field).join(','));
  assert.ok(report.reproduce.commands.includes('node scripts/roco/build-owned-pets.mjs --check'));
  assert.equal(report.reproduce.within_days, 90);
  // 报告必须与磁盘产物一致（否则「报告」就成了另一份事实）。
  assert.equal(report.artifact.sha256, sha256Hex(datasetText));
  assert.equal(report.artifact.dataset_hash, dataset.dataset_hash);
});

test('⑬ 演示用的同种第二只**已经回收**（人类 2026-09-28：「重复精灵不要了」）', () => {
  // 演变（改钉不删，记在这里）：
  //   · 2026-09-24 人类：「重复的删掉」（当时 80 只里 32 只是演示造的第二个个体 ⇒ 编数据）；
  //   · 2026-09-28 上午：「同种你可以做一对测试一下」⇒ 放宽到**一对**（own-0049，须显式标注）；
  //   · 2026-09-28 晚些：先「加入比较不是删了吗？」，再「重复精灵不要了，把铠甲虫还原回来」
  //     +「每种精灵只允许有一只」⇒ 那一对存在的唯一理由（同种比较）没了，按 human-decisions
  //     里写好的 rollback 回收：删实例 + 把 MAX_SAME_SPECIES_GROUPS 调回 0。
  // 判据换了方向，但**原意（不许灌水、不许有来历不明的第二只）一个字没改**：
  // 现在钉的是「一只演示个体都不许有，且每个物种恰好一只」。
  const demos = dataset.instances.filter((one) => one.synthetic_demo === true);
  assert.equal(demos.length, 0, `演示个体必须为 0（rollback 之后），实际 ${demos.length}`);
  const bySpecies = new Map();
  for (const one of dataset.instances) {
    bySpecies.set(one.species_id, (bySpecies.get(one.species_id) ?? 0) + 1);
  }
  const doubled = [...bySpecies.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(doubled, [],
    `每个物种只许一只（人类：「每种精灵只允许有一只」），实际多只的：${JSON.stringify(doubled)}`);
  // 回滚记录本身要在 human-decisions 里（可追、可退这条规矩不变）
  const decisions = JSON.parse(readFileSync(
    new URL('../data/roco/human-decisions.json', import.meta.url), 'utf8'));
  const blob = JSON.stringify(decisions);
  assert.match(blob, /remove-same-species-demo-pair/, '回收这件事本身要记进 human-decisions（可追、可退）');
});
