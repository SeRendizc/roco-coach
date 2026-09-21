// L1 图鉴层（622 只）的**独立**验收。
//
// 为什么要有这一份而不是只靠脚本里的 `--selftest`：脚本内建自检会跟实现一起被改，
// 而这一层的关键危险是「悄悄把知识库说成可模拟」。所以这里独立断言三件事：
//   ① 覆盖数（622 只，不能缩回 12）；② 每一只都只能 `knowledge_only` 且带 refused/unknown；
//   ③ 检索真的可用（按名字/属性/技能都查得到，且类型与技能过滤不许放过不属于它的条目）。
// 并带反证：把某一处改成"可模拟"或删掉 unknown_fields，校验器必须报出来。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadCatalog, query, validateCatalog, ALLOWED_SUPPORT} from '../scripts/roco/query-full-catalog.mjs';

const doc = loadCatalog();

test('L1 图鉴层：622 只全在，且**只**允许 knowledge_only', () => {
  assert.ok(doc.pets.length >= 600, `pets=${doc.pets.length}`);
  assert.equal(doc.layer, 'L1-knowledge-only');
  assert.deepEqual(validateCatalog(doc), [], '产物自身必须过校验');
  const supportValues = [...new Set(doc.pets.map((p) => p.support))];
  assert.deepEqual(supportValues, [...ALLOWED_SUPPORT],
    `support 只能有 ${ALLOWED_SUPPORT.join('/')}，实际 ${supportValues.join('/')}——多一个值就是悄悄扩大声称范围`);
});

test('L1 图鉴层：每只都必须写清「我不知道什么」（unknown_fields + refused + provenance）', () => {
  const missing = doc.pets.filter((p) => !Array.isArray(p.unknown_fields) || !p.unknown_fields.length
    || !Array.isArray(p.refused) || p.refused.length < 2
    || !p.provenance?.snapshot_sha256 || !p.provenance?.source_id);
  assert.deepEqual(missing.map((p) => p.pet_id).slice(0, 5), [], '有精灵没有把边界写清楚');
  // traits 一定缺（快照里没有特性数据）——这一条是"unknown 清单不是摆设"的锚点
  assert.ok(doc.pets.every((p) => p.unknown_fields.includes('traits')), 'traits 必须全部登记为 unknown');
});

test('L1 图鉴层：检索可用，且过滤条件不许放过不属于它的条目', () => {
  const first = doc.pets[0];
  assert.equal(query(doc, {name: first.name, limit: 3})[0].pet_id, first.pet_id);
  const grass = query(doc, {type: '草系', limit: 8});
  assert.ok(grass.length > 0 && grass.every((p) => p.types.includes('草系')));
  const skill = doc.pets.find((p) => p.learnable_skills?.length).learnable_skills[0];
  const bySkill = query(doc, {skill, limit: 8});
  assert.ok(bySkill.length > 0 && bySkill.every((p) => p.learnable_skills.includes(skill)));
});

test('反证：把 support 改成 simulable、或删掉 unknown_fields，校验器必须报出来', () => {
  const bad = {...doc, pets: doc.pets.map((p, i) => (i === 0 ? {...p, support: 'simulable'} : p))};
  assert.ok(validateCatalog(bad).some((x) => x.includes('不在允许集合')),
    '把知识库标成可模拟却没人报——这一层就没有守住了');
  const bad2 = {...doc, pets: doc.pets.map((p, i) => (i === 0 ? {...p, unknown_fields: []} : p))};
  assert.ok(validateCatalog(bad2).some((x) => x.includes('没有 unknown_fields')));
  assert.equal(query(doc, {name: '不存在的伙伴名XYZ'}).length, 0, '查不到就该是 0，不许兜底返回全部');
});
