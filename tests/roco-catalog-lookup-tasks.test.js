// 全图鉴取证任务的判据（`scripts/roco/catalog-lookup-tasks.mjs`）。
//
// 为什么要有这份任务集：现有 288 条 agent 任务**只用到了 4 只精灵**（任务池写死 12 只），
// 而图鉴有 622 只 —— 此前所有 agent 数字都量在 0.6% 的图鉴上。
//
// 这份判据钉四件事（每件都能必红）：
//   ① 覆盖到全图鉴，且**每一条都有名字**（名字来自图鉴数据，不是手抄）；
//   ② **同名异形**不许出现在 A 契约里（一个名字对应多个物种时问题没有唯一答案），
//      但必须出现在 B 契约里（B 量的是「会不会去查」，不需要唯一解）；
//   ③ 任务文本里的名字 与 `expect` 里的定位参数**必须是同一只**（不许张冠李戴）；
//   ④ 契约 A **真的要求两步**：拿真判定器 `checkTask` 量 ——
//      「只按名字查一次」必须判红，「按名字查 + 带正确 pet_id 再查」才判绿。
// 必红反证：把 A 的期望放宽成 `{kind:'pet'}`（只要求工具对），④ 的那条必须**变绿** ——
// 说明 ④ 量的是真判据，不是空转。

import test from 'node:test';
import assert from 'node:assert/strict';

import {checkTask} from '../scripts/roco/agent-trajectories.mjs';
import {
  CATALOG_PATH, CATALOG_CONTRACTS, catalogPets, ambiguousNames, catalogLookupTasks,
} from '../scripts/roco/catalog-lookup-tasks.mjs';

test('① 覆盖全图鉴，且每条任务的名字来自图鉴数据', () => {
  const pets = catalogPets();
  assert.equal(pets.length, 622, `图鉴应有 622 只有名字的物种，实际 ${pets.length}`);
  assert.equal(pets.every((pet) => pet.pet_id && pet.name), true, '每只都必须有 id 与名字');
  const b = catalogLookupTasks({contract: 'B'});
  assert.equal(b.length, pets.length, 'B 契约必须覆盖每一只有名字的物种');
  const byId = new Map(pets.map((pet) => [pet.pet_id, pet.name]));
  for (const task of b.slice(0, 50)) {
    const id = task.case_id.replace('cat-b-', '');
    assert.equal(task.message, `${byId.get(id)}的种族值是多少？`,
      `${task.case_id} 的问题文本必须用图鉴里那只的名字`);
  }
});

test('② 同名异形：A 契约排除、B 契约保留（29% 的图鉴靠名字无法唯一确定）', () => {
  const ambiguous = ambiguousNames();
  assert.ok(ambiguous.length > 0, '本仓库实测存在同名异形；一条都没有说明读取路径变了');
  const names = new Set(ambiguous.map((row) => row.name));
  const a = catalogLookupTasks({contract: 'A'});
  const hit = a.filter((task) => names.has(task.message.replace('的种族值是多少？', '')));
  assert.equal(hit.length, 0, `A 契约里不许有同名异形的题（实际 ${hit.length} 条）`);
  const b = catalogLookupTasks({contract: 'B'});
  const kept = b.filter((task) => names.has(task.message.replace('的种族值是多少？', '')));
  assert.ok(kept.length > 0, 'B 契约必须保留同名异形（否则「会不会去查」少了一大块）');
  // A 丢掉的是**宠物条数**，不是名字条数：一个重名可能牵涉好几只。
  const covered = new Set(a.map((task) => task.case_id.replace('cat-a-', '')));
  const pets = catalogPets().filter((pet) => names.has(pet.name));
  assert.equal(pets.filter((pet) => covered.has(pet.pet_id)).length, 0,
    '重名涉及的每一只都不许出现在 A 契约里');
});

test('③ 问题里的名字 与 expect 里的定位参数必须是同一只', () => {
  const byId = new Map(catalogPets().map((pet) => [pet.pet_id, pet.name]));
  for (const task of catalogLookupTasks({contract: 'A', limit: 40})) {
    const id = task.case_id.replace('cat-a-', '');
    assert.equal(task.expect.args_must_match.pet_id, id, 'A 契约必须要求那**一只**的 pet_id');
    assert.equal(task.message, `${byId.get(id)}的种族值是多少？`, '问题问的必须是同一只');
  }
  for (const task of catalogLookupTasks({contract: 'B', limit: 40})) {
    const id = task.case_id.replace('cat-b-', '');
    assert.equal(task.expect.args_must_match.name, byId.get(id), 'B 契约要求按问题里的名字查');
    assert.equal(task.expect.args_must_match.pet_id, undefined, 'B 契约不许偷偷要求 pet_id');
  }
});

test('④ 契约 A 真的要求两步（拿真判定器量）', () => {
  const task = catalogLookupTasks({contract: 'A', limit: 1})[0];
  const petId = task.expect.args_must_match.pet_id;
  const name = task.message.replace('的种族值是多少？', '');

  const onlyName = checkTask(task, {toolCalls: [{tool: 'query_rules', args: {kind: 'pet', name}}], reply: '查到了。'});
  assert.equal(onlyName.passed, false,
    '只按名字查一次时，A 契约必须判红（这就是「两步」的含义）');

  const twoSteps = checkTask(task, {
    toolCalls: [{tool: 'query_rules', args: {kind: 'pet', name}},
      {tool: 'query_rules', args: {kind: 'pet', pet_id: petId}}],
    reply: '查到了。',
  });
  assert.equal(twoSteps.passed, true,
    `按名字查 + 带正确 pet_id 再查必须判绿，实际违规：${JSON.stringify(twoSteps.violations)}`);
});

test('必红反证：把 A 的期望放宽成「只要求工具对」，④ 必须变绿', () => {
  const task = catalogLookupTasks({contract: 'A', limit: 1})[0];
  const name = task.message.replace('的种族值是多少？', '');
  const loosened = {...task, expect: {...task.expect, args_must_match: {kind: 'pet'}}};
  const onlyName = checkTask(loosened, {toolCalls: [{tool: 'query_rules', args: {kind: 'pet', name}}], reply: '查到了。'});
  assert.equal(onlyName.passed, true,
    '放宽之后「只按名字查」就会判绿 —— 这正是 ④ 能抓住的东西');
  assert.equal(CATALOG_CONTRACTS.A.maxToolCalls, 3, 'A 契约的调用上限必须是 3（两步 + 一次余量）');
  assert.equal(CATALOG_PATH.endsWith('on-demand-builds.json'), true, '名字必须来自图鉴数据文件');
});
