#!/usr/bin/env node
// 全图鉴（622 只）的 agent 取证任务 —— 2026-09-25，人类口径「600 只规模、agent 优先」。
//
// 为什么需要单独一份
// ------------------
// 现有 288 条任务集（`build-agent-trajectories.mjs`）**只用到了 4 只精灵**，
// 任务池是写死的 12 只（`coach-position-harness.mjs` 的 `PET_IDS`），而图鉴有 622 只。
// 也就是说：此前所有 agent 数字都是量在 **0.6% 的图鉴**上的。
// 这一份把同一个问题族（「<名字>的种族值是多少？」）铺到全图鉴，任务集/世界/判定器**都不新造** ——
// 复用 `rules_lookup` 这一类与 `checkTask` 那一套判据，只换取样面。
//
// 两种契约（都是**可判定的**，都不用改判定器）
// ------------------------------------------
//   A（能力）`args_must_match:{kind:'pet', pet_id:<物种 id>}`、最多 3 次调用 ——
//        问题里只给了**名字**，要拿到 `pet_id` 只能自己先按名字查一次
//        （工具箱 `src/coach/toolbox.js:374` 支持 `kind=pet` 带 `name`，引擎 `_answer_pet` 也支持），
//        再拿回执里的 id 查第二次。量的是「**检索链会不会走**」，id 不许背也不许编。
//   B（诚实）`args_must_match:{kind:'pet', name:<问题里的名字>}`、最多 2 次调用 ——
//        允许按名字直查；量的是「**会不会去查**」，而不是「记不记得 id」。
//
// **同名异形必须排除在 A 之外**：两个物种共用一个名字时（本项目实测有这种情况，
// 曾导致候选池 47/48 的缺陷），问题本身没有唯一答案 —— 那不是 agent 的错。
// 排除的数量由 `catalogLookupTasks().length` 与 `ambiguousNames().length` 一起如实报出。
//
// 不写死任何结果：任务里只有**问题**与**期望的取证方式**，事实一律由引擎回答。

import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CATALOG_PATH = join(ROOT, 'data', 'roco', 'derived', 'on-demand-builds.json');

/** 两种契约的登记表（`maxToolCalls` 与判定器的 `max_tool_calls` 对齐）。 */
export const CATALOG_CONTRACTS = Object.freeze({
  A: {id: 'A', label: '两步检索（最终那次必须带 pet_id）', maxToolCalls: 3},
  B: {id: 'B', label: '按名字直查（不许编 id）', maxToolCalls: 2},
});

/** 图鉴里所有「有名字」的物种（按 pet_id 升序，确定性）。 */
export function catalogPets(path = CATALOG_PATH) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const builds = doc?.builds ?? {};
  return Object.keys(builds).sort()
    .map((petId) => ({pet_id: petId, name: builds[petId]?.name ?? null}))
    .filter((pet) => pet.pet_id && pet.name);
}

/** 一个名字对应多个物种的那些名字（A 契约必须排除，否则问题没有唯一答案）。 */
export function ambiguousNames(path = CATALOG_PATH) {
  const byName = new Map();
  for (const pet of catalogPets(path)) {
    if (!byName.has(pet.name)) byName.set(pet.name, []);
    byName.get(pet.name).push(pet.pet_id);
  }
  return [...byName.entries()].filter(([, ids]) => ids.length > 1)
    .map(([name, ids]) => ({name, pet_ids: ids.sort()}));
}

/**
 * 生成任务。`contract` 是 `'A'` / `'B'`；`limit>0` 时只取前 N 条（确定性顺序）。
 * A 契约会**先剔除同名异形**并在返回值上标注（`excluded_ambiguous`）。
 */
export function catalogLookupTasks({contract = 'A', limit = 0, path = CATALOG_PATH} = {}) {
  const spec = CATALOG_CONTRACTS[contract];
  if (!spec) {
    throw new Error(`未知契约 ${JSON.stringify(contract)}（只有 ${Object.keys(CATALOG_CONTRACTS).join(' / ')}）`);
  }
  const ambiguous = new Set(ambiguousNames(path).map((row) => row.name));
  const pets = catalogPets(path).filter((pet) => (contract === 'A' ? !ambiguous.has(pet.name) : true));
  const tasks = pets.map((pet) => ({
    record_type: 'agent_task',
    case_id: `cat-${contract.toLowerCase()}-${pet.pet_id}`,
    category: 'rules_lookup',
    message: `${pet.name}的种族值是多少？`,
    context: {mode: 'camp'},
    expect: contract === 'A'
      ? {
        tool: 'query_rules',
        args_must_match: {kind: 'pet', pet_id: pet.pet_id},
        must_not_fabricate: true,
        max_tool_calls: spec.maxToolCalls,
      }
      : {
        tool: 'query_rules',
        args_must_match: {kind: 'pet', name: pet.name},
        must_not_fabricate: true,
        max_tool_calls: spec.maxToolCalls,
      },
    why: contract === 'A'
      ? '问题里只有名字；要给出 pet_id 只能自己先按名字查一次、再拿回执里的 id 查第二次。'
      : '按问题里给出的名字直查即可：量的是会不会去查，不是记不记得 id。',
    split: {
      family: '全图鉴',
      mechanism: '图鉴字段',
      template: '直问',
      key: createHash('sha256').update(`${contract}:${pet.pet_id}`).digest('hex').slice(0, 16),
      side: 'test',
      held_out_dimensions: ['family'],
    },
  }));
  const sliced = limit > 0 ? tasks.slice(0, limit) : tasks;
  Object.defineProperty(sliced, 'excluded_ambiguous', {
    value: contract === 'A' ? ambiguous.size : 0, enumerable: false,
  });
  return sliced;
}
