// RC-204 held-out 检索评测的守卫。
//
// 为什么这一组必须存在
// --------------------
// 「自建一套查询集 + 自建一个检索器 + 自己报指标」这件事，最省事的做法有四种，
// 四种都**不会红**：
//   ① 查询是从语料里抄的，或者期望值是凭模型记忆编的 —— 指标好看，但测的是记忆力；
//   ② 查询集与既有 fixture 重叠 —— 拿旧题当新题；
//   ③ 把 ABSTAIN 也算成命中，或者只报对自己有利的那套检索器 —— 数字立刻变漂亮；
//   ④ 结果的 provenance 抹掉也没人发现 —— grounded precision 成了摆设。
// 所以这里钉十三组真产物判据 + 六条**必红反证**（构造一个违规输入，看判据会不会翻红）。
//
// 判据全部复用 scripts/roco/eval-rag-retrieval.mjs 里的真实实现 —— 与 `--selftest`
// 跑同一份代码（判据写两遍就会各自漂移）。
//
// 用法：`node --test tests/roco-rag-eval.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';

import {CONFIDENCE_ORDER} from '../scripts/roco/evidence-ledger-lib.mjs';
import {EVIDENCE_LEVELS, createRagIndex, loadCorpus} from '../src/coach/rag-index.js';
import {
  CATEGORY_MIN,
  GATE_DEFINITIONS,
  HELDOUT_PATH,
  LEAK_SPAN_LIMIT,
  REPORT_PATH,
  TOTAL_MIN,
  canonical,
  checkFixtureIntersection,
  checkLeakage,
  computeReport,
  evaluateRetrieval,
  idMatches,
  indexTexts,
  loadFixtures,
  loadHeldout,
  queryManifest,
  runGates,
  selftest,
  stripClock,
} from '../scripts/roco/eval-rag-retrieval.mjs';

const log = (...args) => console.log('  ·', ...args);

const corpus = loadCorpus();
const heldout = loadHeldout();
const report = computeReport({corpus, heldout});
const gates = runGates(report);
const index = createRagIndex(corpus);
const onDiskText = readFileSync(REPORT_PATH, 'utf8');
const onDisk = JSON.parse(onDiskText);

// ─────────────────────────────────────────────────────────────────────────
// 0. 真产物：报告在磁盘上、可解析、与重算逐字节一致
// ─────────────────────────────────────────────────────────────────────────

test('真产物：reports/roco/rag/rag-eval.json 存在、可解析、与重算逐字节一致（--check 判据）', () => {
  assert.ok(existsSync(REPORT_PATH), `缺 ${REPORT_PATH}（跑一次 node scripts/roco/eval-rag-retrieval.mjs）`);
  log('[实际] 报告字节 =', Buffer.byteLength(onDiskText), '；schema =', onDisk.metadata?.schema);
  assert.equal(onDisk.metadata.report, 'rag-eval');
  assert.equal(onDisk.metadata.schema, 'roco-rag-eval/v1');
  assert.ok(onDisk.metadata.generated_at, 'generated_at 必须存在且只在 metadata 里');
  assert.ok(!/"generated_at"/.test(JSON.stringify(stripClock(onDisk))), '正文里不许有挂钟时间戳');
  assert.equal(canonical(onDisk), canonical(report), '磁盘报告必须等于「现在重算」的结果（--check 的判据）');
});

test('可复跑：同输入两次计算结果逐字节相同（generated_at 在单独 metadata 里）', () => {
  const second = computeReport({corpus, heldout});
  log('[实际] 两次重算 =', canonical(second) === canonical(report) ? '逐字节相同' : '不同');
  assert.equal(canonical(second), canonical(report));
  const first = JSON.stringify({...report, metadata: {...report.metadata, generated_at: 'A'}});
  const other = JSON.stringify({...second, metadata: {...second.metadata, generated_at: 'B'}});
  assert.notEqual(first, other, '只有 generated_at 不同时，整份 JSON 才应当不同');
});

// ─────────────────────────────────────────────────────────────────────────
// 1. held-out 的含义：五类覆盖、不泄漏、不撞既有 fixture、期望值可追
// ─────────────────────────────────────────────────────────────────────────

test('五类各 ≥8 条、总计 ≥40 条，且分类计数与清单声明一致', () => {
  const counts = Object.fromEntries(Object.entries(report.heldout.categories).map(([key, value]) => [key, value.count]));
  log('[实际] 总计 =', report.heldout.total, '；分类 =', JSON.stringify(counts));
  assert.equal(report.heldout.total, heldout.queries.length);
  assert.ok(report.heldout.total >= TOTAL_MIN, `总数 ${report.heldout.total} < ${TOTAL_MIN}`);
  assert.equal(Object.keys(counts).length, 5);
  for (const [category, count] of Object.entries(counts)) {
    assert.ok(count >= CATEGORY_MIN, `${category} 只有 ${count} 条 < ${CATEGORY_MIN}`);
  }
  const gate = gates.checks.find((check) => check.check === 'coverage');
  assert.equal(gate.ok, true, gate.problems.join(' | '));
});

test('held-out：查询不逐字出现在语料里（完全包含 + 最长逐字重合）', () => {
  const worst = [...report.heldout.leak.rows].sort((a, b) => b.max_lcs - a.max_lcs).slice(0, 3);
  log('[实际] 最长逐字重合 top3 =', worst.map((row) => `${row.id}:${row.max_lcs}(${row.max_lcs_text})`).join(' '));
  assert.equal(report.heldout.leak.problems.length, 0, report.heldout.leak.problems.join(' | '));
  for (const row of report.heldout.leak.rows) {
    assert.equal(row.contained_in.length, 0, `${row.id} 被语料完全包含`);
    assert.ok(row.max_lcs <= LEAK_SPAN_LIMIT, `${row.id} 最长逐字重合 ${row.max_lcs} > ${LEAK_SPAN_LIMIT}`);
  }
});

test('held-out：与 tests/evals/retrieval*.json 的既有条目交集为空（给出判据与最大相似度）', () => {
  const intersection = report.heldout.fixture_intersection;
  log('[实际] 既有 fixture 条数 =', intersection.fixture_query_count,
    '；交集 =', intersection.intersection.length,
    '；最高 token Jaccard =', JSON.stringify(intersection.max_token_jaccard));
  assert.equal(intersection.fixture_query_count, loadFixtures().length);
  assert.ok(intersection.fixture_query_count >= 100, '既有 fixture 应当被真的读进来');
  assert.deepEqual(intersection.intersection, []);
  assert.ok(intersection.max_token_jaccard.value < 0.5, '最高 token 相似度应当明显低于「同一道题」的水平');
});

test('held-out：每条期望值都能在语料里追到出处（ref 存在 + anchors 命中；absence 类反向扫描）', () => {
  assert.equal(report.heldout.derivation.problems.length, 0, report.heldout.derivation.problems.join(' | '));
  const kinds = {};
  for (const row of report.heldout.derivation.rows) kinds[row.kind] = (kinds[row.kind] ?? 0) + 1;
  log('[实际] 出处种类 =', JSON.stringify(kinds));
  const absence = report.heldout.derivation.rows.find((row) => row.kind === 'pack_absence');
  assert.ok(absence && absence.absence_hits.length === 0, '缺席证明必须真的扫过全语料');
  for (const query of heldout.queries) {
    assert.ok(query.why && query.why.includes('出处='), `${query.id} 的 why 必须写明出处`);
  }
});

test('清单：query_manifest 与查询集一致（删改一条查询必须被发现）', () => {
  const computed = queryManifest(heldout.queries);
  log('[实际] 声明 =', JSON.stringify(heldout.query_manifest), '；重算 =', JSON.stringify(computed));
  assert.deepEqual(heldout.query_manifest, computed);
  assert.equal(report.heldout.manifest.match, true);
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 指标：三套检索器都要报，基线不许被藏起来
// ─────────────────────────────────────────────────────────────────────────

test('指标：三套检索器（含现有 searchKnowledge 原样）都有完整指标，基线差如实报出', () => {
  for (const id of ['baseline_searchKnowledge', 'baseline_lexical_pack', 'rag_index']) {
    const metrics = report.metrics[id];
    assert.ok(metrics, `缺 ${id} 的指标`);
    for (const field of ['recall_at_1', 'recall_at_3', 'recall_at_10', 'mrr', 'entity_hit_rate', 'conflict_abstention_rate']) {
      assert.ok(metrics[field] !== undefined && metrics[field] !== null, `${id}.${field} 缺失`);
    }
    log(`[实际] ${id}: R@1=${metrics.recall_at_1} R@3=${metrics.recall_at_3} R@10=${metrics.recall_at_10} `
      + `MRR=${metrics.mrr} 实体命中=${metrics.entity_hit_rate} 版本命中=${metrics.version_hit_rate} `
      + `冲突弃答=${metrics.conflict_abstention_rate}`);
  }
  // 现有实现原样在 pack 的 id 空间里命中为 0 —— 这是如实报出的，不许偷偷删掉这一行。
  assert.equal(report.metrics.baseline_searchKnowledge.recall_at_10, 0);
  assert.equal(report.metrics.baseline_searchKnowledge.id_space, 'tactic_card');
  assert.match(report.metrics.baseline_searchKnowledge.note, /不是同一套 id 空间|id 空间/);
  assert.ok(report.metrics.baseline_lexical_pack.recall_at_1 > 0, '同语料基线的实体类指标必须非零，否则对照没有意义');
  assert.equal(report.metrics.rag_index.conflict_abstention_rate, 1);
  assert.equal(report.metrics.rag_index.version_hit_rate, 1);
  assert.ok(report.metrics.rag_index.recall_at_1 >= report.metrics.baseline_lexical_pack.recall_at_1,
    '新索引在 Recall@1 上不应当弱于同语料基线');
});

test('grounded precision：抽样 top-1 逐条能追到 provenance/证据（1.0 才算过）', () => {
  log('[实际] 抽样 =', report.grounded.sample_size, '；grounded =', report.grounded.grounded, '；precision =', report.grounded.grounded_precision);
  assert.equal(report.grounded.grounded_precision, 1);
  assert.ok(report.grounded.sample_size >= 40, '抽样条数应当覆盖大部分查询');
  const withChecks = report.grounded.rows.filter((row) => row.checks.length > 0);
  assert.equal(withChecks.length, report.grounded.rows.length, '每条抽样结果都要有逐项判定，不许只给一个结论');
});

test('证据等级：六级常量与台账库一致；每条查询声明的等级都在六级内', () => {
  assert.deepEqual([...EVIDENCE_LEVELS], [...CONFIDENCE_ORDER]);
  const bad = report.queries.filter((entry) => !EVIDENCE_LEVELS.includes(entry.evidence_level_expected));
  log('[实际] 等级不一致的查询 =', bad.length, '；等级匹配率 =', report.metrics.rag_index.evidence_level_match_rate);
  assert.deepEqual(bad, []);
  assert.equal(report.metrics.rag_index.evidence_level_match_rate, 1);
});

test('每条查询的逐条明细都在：top-3 + 命中与否 + 为什么 + 弃答原因', () => {
  assert.equal(report.queries.length, heldout.queries.length);
  for (const entry of report.queries) {
    assert.ok(entry.why && entry.why.length > 10, `${entry.id} 缺 why`);
    assert.ok(Array.isArray(entry.rag_index.top3), `${entry.id} 缺 top3`);
    for (const row of entry.rag_index.top3) {
      assert.ok(row.id && typeof row.score === 'number', `${entry.id} 的 top3 明细缺 id/score`);
    }
    if (entry.rag_index.abstained) assert.ok(entry.rag_index.reason, `${entry.id} 弃答必须给原因`);
  }
  const reasons = {};
  for (const entry of report.queries) {
    if (entry.rag_index.abstained) reasons[entry.rag_index.reason_code] = (reasons[entry.rag_index.reason_code] ?? 0) + 1;
  }
  log('[实际] 弃答原因分布 =', JSON.stringify(reasons));
  assert.ok(Object.keys(reasons).length >= 2, '弃答原因应当覆盖多种（等级不足 / 身份冲突 / 查不到）');
});

test('探针集：另外写、只跑一次、失败也登记（不许只报主集）', () => {
  const probe = report.probe;
  log('[实际] 探针 =', probe.count, '条；未按预期 =', probe.failures.map((row) => row.id).join(',') || '（无）');
  assert.ok(probe.count >= 10);
  assert.equal(probe.rows.length, probe.count);
  assert.equal(probe.failures.length, probe.rows.filter((row) => row.verdict !== 'ok').length);
  assert.match(heldout.probe_definition, /保留失败|不根据结果回调措辞/);
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 十三组判据的必红方向
// ─────────────────────────────────────────────────────────────────────────

test('判据集合：十三组全部通过，且每组都写了「什么输入必须让它红」', () => {
  log('[实际] 判据 =', gates.checks.map((check) => `${check.check}:${check.ok ? 'ok' : 'FAIL'}`).join(' '));
  for (const check of gates.checks) {
    assert.ok(GATE_DEFINITIONS[check.check], `${check.check} 没写必红方向`);
    assert.equal(check.ok, true, `${check.check} 应当通过：${check.problems.join(' | ')}`);
  }
  assert.equal(gates.checks.length, Object.keys(GATE_DEFINITIONS).length);
  assert.equal(gates.ok, true);
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 必红反证（注入实测，不是声明）
// ─────────────────────────────────────────────────────────────────────────

test('反证① 把某条查询的 expected 改成错实体 ⇒ 该条判错且指标下降', () => {
  const hit = report.queries.find((entry) => entry.rag_index.hits.hit_at_1);
  const spec = heldout.queries.find((query) => query.id === hit.id);
  const keys = [spec.expected, ...(spec.acceptable_entity_keys ?? [])];
  const wrong = index.documents.map((doc) => doc.id)
    .filter((id) => !hit.rag_index.ids.includes(id) && !keys.some((key) => idMatches(id, key)))
    .sort()[0];
  const mutated = evaluateRetrieval({
    queries: heldout.queries.map((query) => (query.id === hit.id
      ? {...query, expected: wrong, acceptable_entity_keys: [wrong]} : query)),
    index,
  });
  const mutatedEntry = mutated.perQuery.find((entry) => entry.id === hit.id);
  log('[实际] rc =', mutatedEntry.rag_index.hits.hit_at_1 ? 0 : 1,
    `；${hit.id} hit@1 ${hit.rag_index.hits.hit_at_1} → ${mutatedEntry.rag_index.hits.hit_at_1}`,
    `；Recall@1 ${report.metrics.rag_index.recall_at_1} → ${mutated.metrics.rag_index.recall_at_1}`);
  assert.equal(mutatedEntry.rag_index.hits.hit_at_1, false);
  assert.ok(mutated.metrics.rag_index.recall_at_1 < report.metrics.rag_index.recall_at_1);
  assert.ok(mutated.metrics.rag_index.mrr < report.metrics.rag_index.mrr);
});

test('反证② 删掉一条 ④ 类查询 ⇒ 清单判据红、弃答分母变化被记录', () => {
  const victim = heldout.queries.find((query) => query.category === 'conflict_abstain');
  const dropped = computeReport({
    corpus,
    heldout: {...heldout, queries: heldout.queries.filter((query) => query.id !== victim.id)},
  });
  const droppedGates = runGates(dropped);
  const gate = droppedGates.checks.find((check) => check.check === 'query_manifest');
  log('[实际] rc =', gate.ok ? 0 : 1,
    `；清单判据=${gate.ok ? '绿' : '红'}（声明 ${report.heldout.manifest.declared.total} → 实际 ${dropped.heldout.manifest.computed.total}）`,
    `；弃答分母 ${report.metrics.rag_index.abstain_expected_queries} → ${dropped.metrics.rag_index.abstain_expected_queries}`);
  assert.equal(gate.ok, false, '删掉一条查询却没人报——清单判据就是空的');
  assert.equal(dropped.metrics.rag_index.abstain_expected_queries,
    report.metrics.rag_index.abstain_expected_queries - 1);
});

test('反证③ 抹掉某条结果的 provenance ⇒ grounded precision 下降、判据红', () => {
  const victim = (() => {
    for (const entry of report.queries) {
      const doc = index.byId.get(entry.rag_index.ids[0]);
      if (doc && doc.record_kind === 'pet_form') return doc.id;
    }
    return report.grounded.rows[0].id;
  })();
  const mutatedCorpus = JSON.parse(JSON.stringify(corpus));
  let erased = 0;
  for (const section of ['distributable', 'reference_only']) {
    for (const entity of mutatedCorpus.pack.sections?.[section]?.entities ?? []) {
      if (entity.entity_key === victim) {
        entity.provenance = [];
        erased += 1;
      }
    }
  }
  const mutated = computeReport({corpus: mutatedCorpus, heldout});
  const gate = runGates(mutated).checks.find((check) => check.check === 'grounded');
  log('[实际] rc =', gate.ok ? 0 : 1, `；抹掉 ${victim} 的 ${erased} 条 provenance`,
    `；grounded precision ${report.grounded.grounded_precision} → ${mutated.grounded.grounded_precision}`,
    `；问题原文 = ${gate.problems.slice(0, 2).join(' | ')}`);
  assert.ok(erased > 0);
  assert.ok(mutated.grounded.grounded_precision < report.grounded.grounded_precision);
  assert.equal(gate.ok, false);
});

test('反证④ 让 runner 把 ABSTAIN 算成命中 ⇒ 口径判据红', () => {
  const cheat = evaluateRetrieval({queries: heldout.queries, index, treatAbstainAsHit: true});
  const gate = runGates({...report, queries: cheat.perQuery, metrics: cheat.metrics})
    .checks.find((check) => check.check === 'abstain_consistency');
  log('[实际] rc =', gate.ok ? 0 : 1, `；问题条数 = ${gate.problems.length}；原文 = ${gate.problems.slice(0, 2).join(' | ')}`);
  assert.equal(gate.ok, false);
  assert.ok(gate.problems.length >= report.metrics.rag_index.abstain_expected_queries);
});

test('反证⑤ 把一条 query 原文塞进语料 ⇒ 泄漏判据红', () => {
  const injected = checkLeakage(heldout.queries, [...indexTexts(index), {id: 'injected::leak', text: heldout.queries[0].query}]);
  const first = injected.rows.find((row) => row.id === heldout.queries[0].id);
  log('[实际] rc =', injected.problems.length ? 1 : 0, `；原文 = ${injected.problems[0] ?? '（无）'}`);
  assert.ok(injected.problems.length > 0, '把查询原文塞进语料却没人报——泄漏判据就是空的');
  assert.equal(first.leak, true);
  assert.ok(first.contained_in.includes('injected::leak'));
});

test('反证⑥ held-out 与既有 fixture 交集非空 ⇒ 红', () => {
  const injected = checkFixtureIntersection(heldout.queries,
    [...loadFixtures(), {fixture: 'injected', id: 'injected', q: heldout.queries[1].query}]);
  log('[实际] rc =', injected.intersection.length ? 1 : 0, `；原文 = ${injected.problems[0] ?? '（无）'}`);
  assert.equal(injected.intersection.length, 1);
  assert.ok(injected.problems.length > 0);
});

test('反证自检：--selftest 的六条注入反证全部按预期翻红', () => {
  const result = selftest();
  for (const item of result.cases) log(`[实际] ${item.id} ${item.name} → ${item.ok ? '按预期翻红' : '没有转红'}；${item.detail}`);
  assert.equal(result.base_ok, true, '真产物本身应当过闸门');
  assert.equal(result.cases.length, 6);
  for (const item of result.cases) assert.equal(item.ok, true, `${item.id} 没有按预期翻红`);
});

// ─────────────────────────────────────────────────────────────────────────
// 5. 声明边界：本评测不声称什么
// ─────────────────────────────────────────────────────────────────────────

test('边界：报告自己声明了不声称的东西（不是端到端 / 不是真人体验 / 向量未做）', () => {
  log('[实际] scope =', report.metadata.scope);
  log('[实际] vector =', report.metadata.vector_retrieval);
  assert.match(report.metadata.scope, /不是端到端/);
  assert.match(report.metadata.scope, /玩家体验/);
  assert.match(report.metadata.vector_retrieval, /NOT_IMPLEMENTED/);
  assert.match(heldout.heldout_definition.annotator_note, /IAA|独立盲评/);
});
