/**
 * 判据：困难类别留出集 v3 **可信吗**（人类 2026-09-27：「扩，越完善效果越好就按照这个方向做」）。
 *
 * 这一份把 `docs/roadmap/DSH-EXECUTION-STATE.md` §C6.312 给 Phase E 定的重启条件变成**判红**的东西：
 *   ① 每类 ≥30 条；② 问句与训练集**逐字零重叠**；③ 期望可判定（工具在 `TOOL_CONTRACTS` 里、calls 是闭区间）；
 *   ④ 每条说得出"为什么难"（why 非空）。
 * 外加两条**加严**：⑤ 身份自洽（case_id 唯一、message 不重复、category 与文件名一致）；
 * ⑥ 不编造（记录里引用的每个 `pet_/skill_` id 都在归一化语料里、`facts_used` 逐值对得上）。
 *
 * 每个检查函数都带**反证**：注入一条坏样本，**同一份检查函数**必须报出来 ——
 * 只写"检查通过"的判据很容易变成空判据，这一份不给自己留这个口子。
 *
 * 跑法：`node --test tests/roco-difficulty-holdout.test.js`
 * （注册进 `npm run test:unit` 由主线程做，本次改动**不动 `package.json`**。）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';

import {
  CATEGORIES, CASES_PER_CATEGORY, OUT_DIR, fileOf, buildAllRecords, serialize,
} from '../scripts/roco/build-difficulty-holdout.mjs';
import {
  MIN_PER_CATEGORY, REPORT_PATH, loadHoldout, loadTrainingCorpus, loadCatalog,
  auditHoldout, checkMinPerCategory, checkOverlap, checkExpect, checkWhy, checkIdentity,
  checkGrounding, buildReport, countByCategory, selftest,
} from '../scripts/roco/verify-difficulty-holdout.mjs';
import {TOOL_CONTRACTS} from '../src/coach/toolbox.js';

const rows = loadHoldout();
const corpus = loadTrainingCorpus();
const catalog = loadCatalog();
/** 同一次读盘的口径：反证与真产物检查用的是**同一份函数**。 */
const audit = auditHoldout(rows, {corpus, catalog});
const checkOf = (id) => audit.checks.find((row) => row.id === id);

test('① 每类 ≥30 条（§C6.312 的重启条件：不够就是不够，不四舍五入）', () => {
  assert.ok(rows.length >= CATEGORIES.length * MIN_PER_CATEGORY,
    `总条数 ${rows.length} 少于 ${CATEGORIES.length} × ${MIN_PER_CATEGORY}`);
  assert.deepEqual(checkOf('min-per-category').problems, [],
    `条数不够：${checkOf('min-per-category').problems.join('；')}`);
  const counts = countByCategory(rows);
  for (const category of CATEGORIES) {
    assert.ok(counts[category] >= MIN_PER_CATEGORY, `「${category}」只有 ${counts[category]} 条`);
  }
  // 反证：抽掉一整类，同一条检查必须报出来
  const without = rows.filter((row) => row.category !== 'long-context');
  assert.ok(!checkMinPerCategory(without).ok, '抽掉 long-context 之后条数判据仍然全绿 —— 判据是空的');
  assert.equal(checkMinPerCategory(without).counts['long-context'], 0);
});

test('② 与训练集零重叠：逐字比对（SFT 三份的 message + v1 的题面）—— 拿考题当教材不算评测', () => {
  assert.ok(corpus.sft.size > 0 && corpus.v1.size > 0, '训练集语料没读到，这条判据会变成空的');
  assert.deepEqual(checkOf('zero-overlap').problems, [],
    `有问句与训练集逐字相同：${checkOf('zero-overlap').problems.slice(0, 5).join('；')}`);
  assert.equal(checkOf('zero-overlap').overlap.total, 0);
  // 反证：把一条真实的训练问句塞进去，**同一份检查函数**必须报红
  const trainingMessage = [...corpus.sft][0];
  const injected = [...rows, {...rows[0], case_id: 'inject-overlap', message: trainingMessage}];
  const caught = checkOverlap(injected, {corpus});
  assert.ok(!caught.ok, '注入训练集问句之后仍然全绿 —— 重叠判据是空的');
  assert.ok(caught.problems.some((row) => row.includes('inject-overlap')), caught.problems.join('；'));
  // 反向：v1 的题面也一样要抓到
  const v1Injected = checkOverlap([...rows, {...rows[0], case_id: 'inject-v1', message: [...corpus.v1][0]}], {corpus});
  assert.ok(!v1Injected.ok && v1Injected.overlap.v1 >= 1, 'v1 题面重叠没被抓住');
});

test('③ 期望可判定：expect.tools 全在 TOOL_CONTRACTS 里、calls 是闭区间、stop_ok 自洽', () => {
  assert.ok(Object.keys(TOOL_CONTRACTS).length >= 12, '契约表读出来不对');
  assert.deepEqual(checkOf('decidable-expect').problems, [],
    `期望不可判定：${checkOf('decidable-expect').problems.slice(0, 5).join('；')}`);
  for (const row of rows) {
    for (const tool of row.expect.tools) assert.ok(Object.hasOwn(TOOL_CONTRACTS, tool), `${row.case_id}：${tool} 不在契约里`);
    const [lo, hi] = row.expect.calls;
    assert.ok(Number.isInteger(lo) && Number.isInteger(hi) && lo >= 0 && hi >= lo, `${row.case_id} 的 calls 不是闭区间`);
    assert.equal(row.expect.stop_ok, lo === 0, `${row.case_id} 的 stop_ok 与 calls 不自洽`);
  }
  // 反证一：坏工具名
  const badTool = checkExpect([...rows, {...rows[0], case_id: 'inject-tool',
    expect: {tools: ['no_such_tool'], calls: [1, 1], stop_ok: false}}]);
  assert.ok(!badTool.ok && badTool.problems.some((row) => row.includes('no_such_tool')),
    '坏工具名没被抓住 —— 工具名判据是空的');
  // 反证二：坏区间 / 坏 stop_ok
  const badCalls = checkExpect([...rows, {...rows[0], case_id: 'inject-calls',
    expect: {tools: ['read_state'], calls: [3, 1], stop_ok: false}}]);
  assert.ok(!badCalls.ok, '倒置的 calls 区间没被抓住');
  const badStop = checkExpect([...rows, {...rows[0], case_id: 'inject-stop',
    expect: {tools: [], calls: [0, 1], stop_ok: true}}]);
  assert.ok(!badStop.ok, '空工具集却允许调用没被抓住');
});

test('④ 每条都有非空 why：说不清"难在哪"的题不算困难类别用例', () => {
  assert.deepEqual(checkOf('why-present').problems, [], '有记录缺 why');
  // 反证：空 why 必须报红
  const caught = checkWhy([...rows, {...rows[0], case_id: 'inject-why', why: '   '}]);
  assert.ok(!caught.ok && caught.problems.some((row) => row.includes('inject-why')), '空 why 没被抓住');
  // why 里要真的点到"难"，不是一句"这题很难"
  for (const row of rows) {
    assert.ok(row.why.includes('难在'), `${row.case_id} 的 why 没有点明难在哪：${row.why.slice(0, 40)}`);
  }
});

test('⑤ 身份自洽：case_id 唯一、message 本集内不重复、category 与文件名一致', () => {
  assert.deepEqual(checkOf('identity').problems, []);
  const dup = checkIdentity([...rows, {...rows[0], case_id: 'inject-dup'}]);
  assert.ok(!dup.ok && dup.problems.some((row) => row.includes('重复')), '重复问句没被抓住');
  assert.deepEqual([...new Set(rows.map((row) => row.category))].sort(), [...CATEGORIES].sort());
});

test('⑥ 不编造：引用的 pet_/skill_ id 与 facts_used 逐值都来自归一化语料', () => {
  assert.ok(catalog.pets.size >= 40 && catalog.skills.size >= 500, '归一化语料没读到，这条判据会变成空的');
  assert.deepEqual(checkOf('grounding').problems, [],
    `有引用对不上语料：${checkOf('grounding').problems.slice(0, 5).join('；')}`);
  // 反证：引用一只不存在的精灵，同一份检查函数必须报红
  const injected = checkGrounding([...rows, {...rows[0], case_id: 'inject-id', message: 'inject-id 专用问句',
    why: '这是一条故意引用不存在实体的反证记录，用来确认不编造判据不是空的。',
    receipts: [{id: 'tool:1', tool: 'query_rules', args: {kind: 'pet', pet_id: 'pet_999999'}, result: {}}]}], {catalog});
  assert.ok(!injected.ok && injected.problems.some((row) => row.includes('pet_999999')), '不存在的实体 id 没被抓住');
  // q 反证：facts_used 篡改一个值也必须报红
  const tampered = checkGrounding([{...rows[0], facts_used: [{source: 'roster-48.json', id: rows[0].facts_used?.[0]?.id
    ?? [...catalog.pets.keys()][0], field: 'types', value: ['不存在的系']}]}], {catalog});
  assert.ok(!tampered.ok, '被篡改的 facts_used 没被抓住');
});

test('⑦ 确定性：重算一遍必须与磁盘逐字节一致（等同 `build-difficulty-holdout.mjs --check`）', () => {
  const fresh = buildAllRecords();
  for (const category of CATEGORIES) {
    assert.equal(fresh[category].length, CASES_PER_CATEGORY, `${category} 生成条数不对`);
    const path = fileOf(category);
    assert.ok(existsSync(path), `缺少数据文件 ${path}`);
    assert.equal(readFileSync(path, 'utf8'), serialize(fresh[category]),
      `${category}.jsonl 与重算结果不一致（数据被手改过，或者生成器不确定）`);
  }
  // 反证：改动一个字段就必须与磁盘不一致（逐字节比对真的在比，不是在比长度）
  const mutated = structuredClone(fresh['multi-turn']);
  mutated[0].message = `${mutated[0].message}（手改）`;
  assert.notEqual(serialize(mutated), readFileSync(fileOf('multi-turn'), 'utf8'), '逐字节比对没起作用');
});

test('⑧ 报告 `reports/roco/difficulty-holdout.json` 与磁盘数据一致且计数为真', () => {
  assert.ok(existsSync(REPORT_PATH), `缺少报告：先跑 node scripts/roco/verify-difficulty-holdout.mjs（${OUT_DIR}）`);
  const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
  const fresh = buildReport(rows, {audit, corpus});
  assert.deepEqual(report.categories, fresh.categories, '报告里的每类计数与磁盘数据不一致');
  assert.equal(report.total, rows.length);
  assert.equal(report.overlap.training_or_v1, 0, '报告里的重叠数不是 0');
  assert.equal(report.ok, true, '报告自己写着不通过');
  // 报告必须如实说明"这只是数据、还没跑过模型"
  assert.ok(report.boundary.some((row) => row.includes('没有**跑过任何模型')), '报告没有写清"还没测过模型"的边界');
});

test('⑨ 校验器自带的反证全绿（--selftest 与这里的检查是同一份代码）', () => {
  const result = selftest();
  assert.equal(result.base_ok, true, '真产物判据本身是红的');
  for (const row of result.results) assert.ok(row.ok, `反证失败：${row.name} → ${row.detail}`);
  assert.ok(result.results.length >= 5, '反证太少');
});
