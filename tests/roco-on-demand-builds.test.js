// RC-402 按需配招编译（`data/roco/derived/on-demand-builds.json`）的守卫。
//
// 为什么这一组必须存在
// --------------------
// 「让 574 只没有冻结 learnset 的精灵也能上场」这件事，最省事的四种做法都不会红，但都是错的：
//   ① 随便凑四个技能（只要 id 长得像 skill_000123）——没人会去核对这只学不学得到；
//   ② 把**编出来的**配招塞进冻结那一份——「已核验」与「推算」就此混成一锅；
//   ③ 威力来源没给就补 0——数字看起来完整，含义是错的；
//   ④ 只报「覆盖率 100%」，不报哪只是编的、哪只是冻结的。
// 所以这一组钉的是**判据有没有牙**，每条都有必红方向（改一份**内存副本**，不写盘）。
//
// 判据全部复用 `scripts/roco/on-demand-builds-lib.mjs` —— 与构建器/检查器的 `--selftest`
// 跑的是**同一份代码**（两份判据各写一遍就会各自漂移）。
//
// 用法：`node --test tests/roco-on-demand-builds.test.js`

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  BUILD_UNKNOWNS, SELECTION_RULE, SUPPORT_FULL_VERIFIED, SUPPORT_SIMULATABLE_UNVERIFIED,
  checkOnDemandBuilds, compileBuild, selftest, sha256, skillSortKey,
} from '../scripts/roco/on-demand-builds-lib.mjs';
import {checkRepo} from '../scripts/roco/verify-on-demand-builds.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/tests$/, '');
const TARGET = join(ROOT, 'data/roco/derived/on-demand-builds.json');
const CATALOG = join(ROOT, 'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json');
const SKILLS = join(ROOT, 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json');
const log = (...args) => console.log('  ·', ...args);
const readJson = (abs) => JSON.parse(readFileSync(abs, 'utf8'));
const copy = (value) => JSON.parse(JSON.stringify(value));

const context = () => {
  const doc = readJson(TARGET);
  const catalogText = readFileSync(CATALOG, 'utf8');
  const skillsText = readFileSync(SKILLS, 'utf8');
  return {doc, catalog: JSON.parse(catalogText), skills: JSON.parse(skillsText),
    hashes: {catalog: sha256(catalogText), skills: sha256(skillsText)}};
};

test('产物存在且真的能过检查（这条红了就是真问题）', () => {
  assert.ok(existsSync(TARGET), `缺少 ${TARGET}；先跑 node scripts/roco/build-on-demand-builds.mjs`);
  const report = checkRepo();
  assert.equal(report.ok, true, `检查未通过：${JSON.stringify(report.issues?.slice(0, 4))}`);
});

test('覆盖账目自洽：622 只 = 已核验 48 + 推算 574（且没有既编又跳过的）', () => {
  const {doc, catalog} = context();
  const built = Object.keys(doc.builds).length;
  log('[实际] 覆盖', {catalog_pets: catalog.pets.length, built, skipped: doc.skipped.length,
    full: doc.summary[SUPPORT_FULL_VERIFIED], unverified: doc.summary[SUPPORT_SIMULATABLE_UNVERIFIED]});
  assert.equal(catalog.pets.length, 622);
  assert.equal(built + doc.skipped.length, catalog.pets.length, '每一只都必须有交代（编出来或如实跳过）');
  assert.equal(doc.summary[SUPPORT_FULL_VERIFIED], 48, '冻结 learnset 覆盖的是 48 只');
  assert.equal(doc.summary[SUPPORT_SIMULATABLE_UNVERIFIED], 574, '剩下 574 只走按需推算');
  assert.equal(doc.skipped.length, 0);
});

test('每个技能都能追溯：在该物种的学招表里，且在冻结 skills.json 里解析得到', () => {
  const {doc, catalog, skills} = context();
  const pets = new Map(catalog.pets.map((pet) => [pet.pet_id, pet]));
  let checked = 0;
  for (const [petId, row] of Object.entries(doc.builds)) {
    if (row.support !== SUPPORT_SIMULATABLE_UNVERIFIED) continue;
    const pool = new Set(pets.get(petId).learnable_skills);
    assert.equal(row.skills.length, 4, `${petId} 必须有四个技能`);
    for (const skill of row.skills) {
      assert.ok(pool.has(skill.skill_id), `${petId} 学不到 ${skill.skill_id}`);
      assert.ok(skills.skills[skill.skill_id], `${petId} 的 ${skill.skill_id} 解析不到`);
      assert.notEqual(skills.skills[skill.skill_id].is_trait, true, `${petId} 的 ${skill.skill_id} 是特性`);
      checked += 1;
    }
  }
  assert.equal(checked, 574 * 4);
});

test('「已核验」与「推算」永不混淆：冻结那一份原样带出，推算的一律不带', () => {
  const {doc} = context();
  for (const [petId, row] of Object.entries(doc.builds)) {
    if (row.support === SUPPORT_FULL_VERIFIED) {
      assert.ok(Array.isArray(row.frozen_build) && row.frozen_build.length === 4, `${petId} 必须带冻结配招`);
    } else {
      assert.equal(row.frozen_build, null, `${petId} 是推算的，不许带冻结配招`);
    }
    assert.equal(row.selection_rule_id, SELECTION_RULE.id);
    assert.deepEqual(row.unknowns, [...BUILD_UNKNOWNS], `${petId} 必须逐条带上未知项`);
  }
  // 实测：本模块的启发式**不复现**冻结那 48 份配招（所以更不能互相替换）——如实登记。
  log('[实际] 推算配招与冻结配招逐位相同的物种数 =', doc.summary.compiled_matches_frozen);
  assert.equal(doc.summary.compiled_matches_frozen, 0);
});

test('威力来源没给就照实说：不补 0、power_status 与冻结数据逐字一致', () => {
  const {doc, skills} = context();
  let missingPower = 0;
  for (const row of Object.values(doc.builds)) {
    for (const skill of row.skills) {
      const frozen = skills.skills[skill.skill_id];
      if (skill.power === null) {
        missingPower += 1;
        assert.equal(frozen.power, null, `${skill.skill_id} 冻结里有威力，产物却写成 null`);
        assert.equal(skill.power_status, frozen.power_status);
      } else {
        assert.equal(skill.power, frozen.power, `${skill.skill_id} 的威力被改过`);
      }
    }
  }
  log('[实际] 产物里「来源没给威力」的技能槽位数 =', missingPower, '（这些一律是 null，不是 0）');
  assert.ok(missingPower > 0, '冻结数据里确实有没给威力的技能；这条判据要能数到它们');
});

test('选择规则是工程启发式，且排序键确定（同分有显式 tie-break）', () => {
  assert.equal(SELECTION_RULE.confidence, 'ENGINE_HYPOTHESIS');
  assert.match(SELECTION_RULE.why_not_official, /没有任何|证据/);
  // 排序键：威力降序 → 能耗升序 → skill_id 升序；威力 null 排最后（不是当 0）
  const a = {skill_id: 's2', power: null, energy: 1};
  const b = {skill_id: 's1', power: 60, energy: 3};
  const c = {skill_id: 's0', power: 60, energy: 2};
  const sorted = [a, b, c].sort((x, y) => {
    const kx = skillSortKey(x); const ky = skillSortKey(y);
    for (let i = 0; i < kx.length; i += 1) { if (kx[i] !== ky[i]) return kx[i] < ky[i] ? -1 : 1; }
    return 0;
  });
  log('[实际] 排序结果 =', sorted.map((row) => row.skill_id).join(' < '));
  assert.deepEqual(sorted.map((row) => row.skill_id), ['s0', 's1', 's2'], '威力降序 → 能耗升序；null 垫底');
});

test('compileBuild 的 fail closed：池子太小 / 有特性 / 解析不到 ⇒ 拒绝而不是硬凑', () => {
  const skills = {skills: {skill_1: {skill_id: 'skill_1', name: 'A', is_trait: false, power: 10, energy: 1},
    skill_2: {skill_id: 'skill_2', name: 'B', is_trait: false, power: 20, energy: 1}}};
  const tooSmall = compileBuild({pet_id: 'x', learnable_skills: ['skill_1', 'skill_2']}, skills);
  assert.equal(tooSmall.ok, false);
  assert.equal(tooSmall.reason, 'POOL_TOO_SMALL');
  const withTrait = compileBuild({pet_id: 'x', learnable_skills: ['skill_1', 'skill_2', 'trait']},
    {skills: {...skills.skills, trait: {skill_id: 'trait', is_trait: true}}});
  assert.equal(withTrait.ok, false, '特性不是战斗技能，不能拿来凑数');
  log('[实际] 池子太小 →', tooSmall.detail);
});

test('必红方向：改坏产物之后，同一个检查器必须抓住（逐条打印实际输出原文）', () => {
  const {doc, catalog, skills, hashes} = context();
  const cases = [
    ['编一个该物种学不到的技能', (t) => { const id = Object.keys(t.builds).find((k) => t.builds[k].support === SUPPORT_SIMULATABLE_UNVERIFIED); t.builds[id].skills[0].skill_id = 'skill_999999'; }],
    ['四个技能里塞重复', (t) => { const id = Object.keys(t.builds).find((k) => t.builds[k].support === SUPPORT_SIMULATABLE_UNVERIFIED); t.builds[id].skills[1].skill_id = t.builds[id].skills[0].skill_id; }],
    ['把已核验的标成推算', (t) => { const id = Object.keys(t.builds).find((k) => t.builds[k].support === SUPPORT_FULL_VERIFIED); t.builds[id].support = SUPPORT_SIMULATABLE_UNVERIFIED; t.builds[id].frozen_build = null; }],
    ['同一只既编出 build 又登记跳过', (t) => { t.skipped.push({pet_id: Object.keys(t.builds)[0], reason: 'X'}); }],
    ['把选择规则的等级偷偷升成官方口径', (t) => { t.selection_rule.confidence = 'OFFICIAL_CURRENT'; }],
  ];
  for (const [name, mutate] of cases) {
    const tampered = copy(doc);
    mutate(tampered);
    const report = checkOnDemandBuilds(tampered, {catalog, skills, hashes});
    assert.equal(report.ok, false, `${name}：必须红`);
    log(`[实际] ${name} →`, `${report.issues[0].rule}：${report.issues[0].detail}`);
  }
});

test('自带用例（lib 的 --selftest 同一份代码）必须全绿', () => {
  const result = selftest();
  assert.equal(result.ok, true, JSON.stringify(result.cases.filter((row) => !row.passed)));
  assert.ok(result.cases.length >= 9);
});
