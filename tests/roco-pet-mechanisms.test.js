// 精灵「机制首层」（`data/roco/derived/pet-mechanisms.json`）的守卫。
//
// 为什么这一组必须存在
// --------------------
// 人类在真实试玩里直说：卡片上那句「特点」**是模板，没意义**，要「看体系的吧」「基本属性单独拉出来说」。
// 修这句话最省事的四种做法都不会红，但都是错的：
//   ① 前端现编一句「最狠一招 + 速度档」 —— 看起来像结论，仓库里没有任何地方能核对；
//   ② 把冻结 desc 顺手润色/截成语录 —— 读起来更顺，但已经不是原文；
//   ③ 解析不到机制就填一个「综合型/速攻型」 —— 卡片不空了，内容是编的；
//   ④ 把 `skill_000129` 这类 id 或出处直接印进卡片首层 —— 玩家看到的是一张工程表。
// 所以这一组钉的是**判据有没有牙**，每条都有必红方向（改一份**内存副本**，不写盘）：
//   ① 润色 desc ⇒ 红；             ② FROZEN_DESC 却没 desc ⇒ 红；
//   ③ 没 desc 却给机制行 ⇒ 红；     ④ 机制行里塞 id ⇒ 红；
//   ⑤ 少一只精灵 ⇒ 红；            ⑥ summary 与实际不符 ⇒ 红；
//   ⑦ 派生 sha256 与磁盘不符 ⇒ 红；  ⑧ 冻结 desc 改成别的技能的 desc ⇒ 红。
//
// 判据全部复用 `scripts/roco/pet-mechanisms-lib.mjs` —— 与两个脚本的 `--selftest` 跑**同一份代码**
// （两份判据各写一遍就会各自漂移）。
//
// 用法：`node --test tests/roco-pet-mechanisms.test.js`

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  MECHANISM_FALLBACK, MECHANISM_LINE_MAX, checkMechanisms, selftest, sha256, toMechanismLine,
} from '../scripts/roco/pet-mechanisms-lib.mjs';
import {createMechanismIndex, playerMechanism} from '../src/coach/pet-mechanisms.js';
import {checkRepo} from '../scripts/roco/verify-pet-mechanisms.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/tests$/, '');
const TARGET = join(ROOT, 'data/roco/derived/pet-mechanisms.json');
const CATALOG = join(ROOT, 'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json');
const SKILLS = join(ROOT, 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json');

const readJson = (abs) => JSON.parse(readFileSync(abs, 'utf8'));
const copy = (value) => JSON.parse(JSON.stringify(value));

const loadContext = () => {
  const doc = readJson(TARGET);
  const catalogText = readFileSync(CATALOG, 'utf8');
  const skillsText = readFileSync(SKILLS, 'utf8');
  return {
    doc,
    catalog: JSON.parse(catalogText),
    skills: JSON.parse(skillsText),
    hashes: {catalog: sha256(catalogText), skills: sha256(skillsText)},
  };
};

test('产物存在且真的能过检查（这条红了就是真问题）', () => {
  assert.ok(existsSync(TARGET), `缺少 ${TARGET}；先跑 node scripts/roco/build-pet-mechanisms.mjs`);
  const report = checkRepo();
  assert.equal(report.ok, true, `机制首层检查未通过：${JSON.stringify(report.issues?.slice(0, 5))}`);
});

test('622 只精灵一只不少，且与冻结目录逐一对应', () => {
  const {doc, catalog} = loadContext();
  const want = catalog.pets.map((pet) => pet.pet_id).sort();
  const got = Object.keys(doc.pets).sort();
  assert.equal(got.length, 622);
  assert.deepEqual(got, want);
});

test('每只精灵的机制首层都来自冻结 desc 原文（逐字，不许润色）', () => {
  const {doc, skills} = loadContext();
  let checked = 0;
  for (const [petId, row] of Object.entries(doc.pets)) {
    assert.equal(row.mechanism_status, 'FROZEN_DESC', `${petId} 的机制状态不是 FROZEN_DESC`);
    const source = skills.skills[row.feature.skill_id];
    assert.ok(source, `${petId} 的 feature skill ${row.feature.skill_id} 不存在`);
    assert.ok(source.desc.includes(row.feature.desc), `${petId} 的 desc 不是原文子串`);
    checked += 1;
  }
  assert.equal(checked, 622);
});

test('机制首层是玩家文案：不超长、不带工程字段', () => {
  const {doc} = loadContext();
  for (const [petId, row] of Object.entries(doc.pets)) {
    assert.ok(row.mechanism_line.length <= MECHANISM_LINE_MAX, `${petId} 的机制行 ${row.mechanism_line.length} 字超上限`);
    assert.doesNotMatch(row.mechanism_line, /pet_\d|skill_\d|[{}]/, `${petId} 的机制行有工程字段：${row.mechanism_line}`);
    assert.notEqual(row.mechanism_line, MECHANISM_FALLBACK, `${petId} 有冻结 desc 却回落到了 fallback`);
  }
});

test('机制标签只说得出处里的标签，不许自创', () => {
  const {doc} = loadContext();
  const packTags = new Set();
  const pack = readJson(join(ROOT, 'data/roco/game-data-pack/v2/pack.json'));
  for (const entity of pack.sections.distributable.entities) {
    if (entity.group !== 'battle_skill') continue;
    for (const tag of String(entity.tags_live?.tags ?? '').split(/[|,、/]/).map((t) => t.trim())) if (tag) packTags.add(tag);
  }
  assert.ok(packTags.size >= 15, `标签词表只有 ${packTags.size} 个，先确认输入没变`);
  for (const [petId, row] of Object.entries(doc.pets)) {
    for (const entry of row.mechanism_tags) {
      assert.ok(packTags.has(entry.tag), `${petId} 的标签「${entry.tag}」不在冻结标签词表里`);
    }
  }
});

test('必红方向 ①：把 desc 润色过（原文 -40% 改成 40%）必须红', () => {
  const {doc, catalog, skills, hashes} = loadContext();
  const tampered = copy(doc);
  const petId = Object.keys(tampered.pets)[0];
  tampered.pets[petId].feature.desc = '受到攻击伤害40%。';
  const report = checkMechanisms(tampered, {catalog, skills, hashes});
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.rule === 'desc_not_verbatim'), JSON.stringify(report.issues.slice(0, 3)));
});

test('必红方向 ②：FROZEN_DESC 却把 desc 抹掉必须红', () => {
  const {doc, catalog, skills, hashes} = loadContext();
  const tampered = copy(doc);
  tampered.pets[Object.keys(tampered.pets)[0]].feature.desc = null;
  const report = checkMechanisms(tampered, {catalog, skills, hashes});
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.rule === 'frozen_without_desc'));
});

test('必红方向 ③：没有 desc 的精灵编一句机制行必须红', () => {
  const {doc, catalog, skills, hashes} = loadContext();
  const tampered = copy(doc);
  const petId = Object.keys(tampered.pets)[1];
  tampered.pets[petId].mechanism_status = 'MECHANISM_UNCONFIRMED';
  tampered.pets[petId].feature.desc = null;
  tampered.pets[petId].mechanism_line = '速度档 33，最狠一招抓挠';
  const report = checkMechanisms(tampered, {catalog, skills, hashes});
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.rule === 'unconfirmed_line'));
  // 同一只精灵改成 fallback 文案后必须**不再**命中这一条（证明红的是那句话，不是这条宠）。
  tampered.pets[petId].mechanism_line = MECHANISM_FALLBACK;
  const again = checkMechanisms(tampered, {catalog, skills, hashes});
  assert.equal(again.issues.some((issue) => issue.rule === 'unconfirmed_line'), false);
});

test('必红方向 ④：机制行里出现 skill_id 必须红', () => {
  const {doc, catalog, skills, hashes} = loadContext();
  const tampered = copy(doc);
  const petId = Object.keys(tampered.pets)[0];
  tampered.pets[petId].mechanism_line = `特性 skill_000003：${tampered.pets[petId].feature.desc}`;
  const report = checkMechanisms(tampered, {catalog, skills, hashes});
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.rule === 'line_forbidden'));
});

test('必红方向 ⑤：少一只精灵必须红（覆盖不能靠抽样）', () => {
  const {doc, catalog, skills, hashes} = loadContext();
  const tampered = copy(doc);
  delete tampered.pets[Object.keys(tampered.pets).at(-1)];
  const report = checkMechanisms(tampered, {catalog, skills, hashes});
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.rule === 'coverage_count'), JSON.stringify(report.issues.slice(0, 3)));
});

test('必红方向 ⑥：summary 与实际不符必须红', () => {
  const {doc, catalog, skills, hashes} = loadContext();
  const tampered = copy(doc);
  tampered.summary.feature_resolved = 621;
  const report = checkMechanisms(tampered, {catalog, skills, hashes});
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.rule === 'summary_feature_resolved'));
});

test('必红方向 ⑦：派生 sha256 与磁盘不符必须红（产物不许偷偷过期）', () => {
  const {doc, catalog, skills, hashes} = loadContext();
  const tampered = copy(doc);
  tampered.derived_from.skills.sha256 = sha256('别的 skills.json');
  const report = checkMechanisms(tampered, {catalog, skills, hashes});
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.rule === 'derived_from_stale'));
});

test('必红方向 ⑧：把 desc 换成**另一条**技能的 desc 也必须红（子串检查不是摆设）', () => {
  const {doc, catalog, skills, hashes} = loadContext();
  const tampered = copy(doc);
  const petId = Object.keys(tampered.pets)[0];
  const otherId = Object.keys(skills.skills).find((id) => id !== tampered.pets[petId].feature.skill_id && skills.skills[id].desc);
  tampered.pets[petId].feature.desc = skills.skills[otherId].desc;
  const report = checkMechanisms(tampered, {catalog, skills, hashes});
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.rule === 'desc_not_verbatim'));
});

test('机制行压行规则本身：取第一句、超长截断、不编内容', () => {
  assert.equal(toMechanismLine('氧循环', '使用草系技能后，回复10%生命。'), '特性「氧循环」：使用草系技能后，回复10%生命。');
  const long = toMechanismLine('长描述', `${'啊'.repeat(200)}。`);
  assert.ok(long.length <= MECHANISM_LINE_MAX, `截断后仍 ${long.length} 字`);
  assert.ok(long.endsWith('…'));
  assert.ok(long.includes('啊'));
});

test('自带用例（lib 的 --selftest 同一份代码）必须全绿', () => {
  const result = selftest();
  assert.equal(result.ok, true, JSON.stringify(result.cases.filter((row) => !row.passed)));
  assert.ok(result.cases.length >= 9);
});

// ── 读取层（`src/coach/pet-mechanisms.js`）：页面与接口取的是同一份规则 ──────────────

test('读取层能读真产物，622 只都能取到行', () => {
  const index = createMechanismIndex({readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8')});
  assert.equal(index.available, true, index.error ?? '');
  assert.equal(index.size, 622);
  const row = index.get('pet_000001');
  assert.ok(row, 'pet_000001 取不到行');
  const player = playerMechanism(row);
  assert.equal(player.mechanism_status, 'FROZEN_DESC');
  assert.ok(player.mechanism_line.startsWith('特性「'));
  assert.ok(player.mechanism_desc.length > 0);
});

test('读取层 fail closed：产物读不动就是 available:false + 取不到行（不许补默认句）', () => {
  const missing = createMechanismIndex({readFile: () => { throw new Error('ENOENT'); }});
  assert.equal(missing.available, false);
  assert.equal(missing.size, 0);
  assert.equal(missing.get('pet_000001'), null);
  assert.match(missing.error, /ENOENT/);
  const broken = createMechanismIndex({readFile: () => '{"pets":'});
  assert.equal(broken.available, false);
  assert.equal(broken.get('pet_000001'), null);
});

test('读取层不把未确认的机制当结论：状态一改，行就必须回落', () => {
  const index = createMechanismIndex({readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8')});
  const row = copy(index.get('pet_000001'));
  assert.equal(playerMechanism(row).mechanism_line.startsWith('特性「'), true);
  row.mechanism_status = 'MECHANISM_UNCONFIRMED';
  const downgraded = playerMechanism(row);
  assert.equal(downgraded.mechanism_line, MECHANISM_FALLBACK);
  assert.equal(downgraded.mechanism_desc, null);
  assert.equal(downgraded.mechanism_name, null);
  // 空行/null 行同样必须回落 —— 「没有」不是「可以编」。
  assert.equal(playerMechanism({mechanism_status: 'FROZEN_DESC', mechanism_line: '   '}).mechanism_line, MECHANISM_FALLBACK);
  assert.equal(playerMechanism(null).mechanism_line, MECHANISM_FALLBACK);
});
